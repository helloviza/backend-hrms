// apps/backend/src/scripts/crm-disposition-set-apply.ts
//
// THE tool for changing a calling pipeline's disposition set (audit P1-7,
// docs/audits/crm-disposition-audit.md §B11). The set is DATA on the
// `crmpipelines` row — models/crmDisposition.ts only seeds an empty DB — so
// every change to the live set goes through this script.
//
// Input: a spec file holding the FULL target set (not a patch):
//   • a .json file — an array of entries, or { dispositionSet: [...] }
//     (the shape --dump-current writes);
//   • or `@seed` — CORPORATE_CALLING_SET from models/crmDisposition.ts.
//
// DRY RUN by default: prints the target host/db, a per-entry diff of the
// stored row vs the spec (added / removed / renamed / changed fields / order)
// and how many leads sit on every affected sub. Nothing is written.
//
// --apply (needs --expect-db=<connected db name>):
//   1. validates the spec (validateDispositionSet + the pipeline-stage rule);
//   2. saves the set through the MODEL (findOne → mutate → save), so the
//      CrmPipeline pre-validate hook runs — never a raw updateOne. Creates the
//      row (the seed path) when none exists;
//   3. for every --rename "Old Sub=>New Sub", backfills leads on the old sub:
//      disposition / subDisposition / dispositionStage / dispositionStatus /
//      stage / status from the new entry, plus leads.lostReason and
//      opportunities.lostReason. leadactivities are NEVER touched — history
//      is append-only and keeps the label it was written with.
//   Removing a sub that leads still sit on is refused unless --allow-orphans
//   (prefer `"active": false`, which hides it from pickers and keeps it valid
//   for display).
//   Idempotent: a second identical run reports "Nothing to change".
//
// Leads on a sub whose derived fields change (stage / status / legacyStage /
// leadStatus) are NOT re-derived — they keep what they were stamped with
// until their next disposition. The dry run counts them.
//
//   npx tsx src/scripts/crm-disposition-set-apply.ts --spec=@seed
//   npx tsx src/scripts/crm-disposition-set-apply.ts --dump-current=current-set.json
//   npx tsx src/scripts/crm-disposition-set-apply.ts --spec=new-set.json \
//       --rename "Call Back Time Given=>Callback Scheduled" --expect-db=<db> --apply
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import CrmPipeline, { type CrmPipelineDoc } from "../models/CrmPipeline.js";
import Lead from "../models/Lead.js";
import Opportunity from "../models/Opportunity.js";
import {
  CORPORATE_CALLING_PIPELINE,
  CORPORATE_CALLING_SET,
  validateDispositionSet,
  type DispositionEntry,
} from "../models/crmDisposition.js";

/* ───────────────────────────── spec ───────────────────────────── */

const FIELDS = [
  "disposition", "subDisposition", "stage", "status", "nextTouch",
  "opportunityEffect", "opportunityStage", "leadStatus", "legacyStage", "active",
] as const;
type Field = (typeof FIELDS)[number];

/** One canonical shape for comparing a stored entry with a spec entry. */
export function normaliseEntry(e: any): DispositionEntry {
  const out: any = {
    disposition: String(e?.disposition ?? "").trim(),
    subDisposition: String(e?.subDisposition ?? "").trim(),
    stage: String(e?.stage ?? "").trim(),
    status: String(e?.status ?? "").trim(),
    nextTouch: e?.nextTouch === true,
    opportunityEffect: String(e?.opportunityEffect || "none").trim(),
    leadStatus: String(e?.leadStatus ?? "").trim(),
    legacyStage: String(e?.legacyStage ?? "").trim(),
    active: e?.active !== false,
  };
  const os = String(e?.opportunityStage ?? "").trim();
  if (os) out.opportunityStage = os;
  return out as DispositionEntry;
}

export function loadSpec(spec: string): DispositionEntry[] {
  if (spec === "@seed") return CORPORATE_CALLING_SET.map(normaliseEntry);
  const raw = JSON.parse(readFileSync(spec, "utf8"));
  const list = Array.isArray(raw) ? raw : raw?.dispositionSet;
  if (!Array.isArray(list)) throw new Error(`Spec ${spec}: expected an array of entries or { dispositionSet: [...] }.`);
  return list.map(normaliseEntry);
}

/** "Old Sub=>New Sub" → { from, to }. */
export function parseRename(arg: string): { from: string; to: string } {
  const i = arg.indexOf("=>");
  if (i < 0) throw new Error(`--rename "${arg}": use "Old Sub=>New Sub".`);
  const from = arg.slice(0, i).trim();
  const to = arg.slice(i + 2).trim();
  if (!from || !to) throw new Error(`--rename "${arg}": both sides are required.`);
  return { from, to };
}

const key = (s: string) => s.trim().toLowerCase();

/* ───────────────────────────── plan ───────────────────────────── */

export interface EntryChange {
  kind: "added" | "removed" | "changed" | "renamed";
  sub: string;
  /** renamed: the stored label it replaces. */
  from?: string;
  fields: Array<{ field: Field; before: unknown; after: unknown }>;
  /** Leads on the stored label (this pipeline, or not yet stamped). */
  leads: number;
  openLeads: number;
}

export interface Plan {
  pipelineKey: string;
  exists: boolean;
  problems: string[];
  changes: EntryChange[];
  orderChanged: boolean;
  setChanged: boolean;
  renames: Array<{ from: string; to: string; leads: number; lostReasonLeads: number; lostReasonOpps: number; alreadyApplied: boolean }>;
}

/** Leads in this pipeline: stamped with it, or not stamped yet (the default). */
function pipelineLeadFilter(p: CrmPipelineDoc | null) {
  return p ? { $or: [{ pipelineId: p._id }, { pipelineId: null }] } : { pipelineId: null };
}
/** Exact match, or case-insensitive when the caller asks for it. */
const CI = { locale: "en", strength: 2 } as const;

async function countOn(p: CrmPipelineDoc | null, sub: string) {
  const f = { ...pipelineLeadFilter(p), subDisposition: sub };
  const [leads, openLeads] = await Promise.all([
    Lead.countDocuments(f).collation(CI),
    Lead.countDocuments({ ...f, dispositionStatus: { $nin: ["Won", "Lost"] } }).collation(CI),
  ]);
  return { leads, openLeads };
}

export async function planSetChange(input: {
  pipelineKey: string;
  spec: DispositionEntry[];
  renames: Array<{ from: string; to: string }>;
}): Promise<Plan> {
  const p = await CrmPipeline.findOne({ key: input.pipelineKey });
  const opportunityPipeline = p?.opportunityPipeline ?? CORPORATE_CALLING_PIPELINE.opportunityPipeline;
  const current = (p?.dispositionSet ?? []).map((e: any) => normaliseEntry(typeof e?.toObject === "function" ? e.toObject() : e));
  const spec = input.spec;
  const problems = validateDispositionSet(spec, opportunityPipeline);
  if (!p && input.pipelineKey !== CORPORATE_CALLING_PIPELINE.key) {
    problems.push(`No pipeline "${input.pipelineKey}" exists, and only "${CORPORATE_CALLING_PIPELINE.key}" can be created by this script.`);
  }

  const curByKey = new Map(current.map((e) => [key(e.subDisposition), e]));
  const specByKey = new Map(spec.map((e) => [key(e.subDisposition), e]));

  // Renames: new label must be in the spec; the old one must be stored (or
  // already gone — then this rename was applied by an earlier run).
  const renameTo = new Map<string, string>(); // spec key → stored key
  const renameReport: Plan["renames"] = [];
  for (const r of input.renames) {
    const fromK = key(r.from);
    const toK = key(r.to);
    if (r.from === r.to) problems.push(`--rename "${r.from}=>${r.to}": renames a sub to itself.`);
    if (!specByKey.has(toK)) problems.push(`--rename "${r.from}=>${r.to}": "${r.to}" is not in the spec.`);
    if (fromK !== toK && specByKey.has(fromK)) problems.push(`--rename "${r.from}=>${r.to}": "${r.from}" is still in the spec — a rename replaces it.`);
    const stored = curByKey.get(fromK);
    if (stored && fromK !== toK) renameTo.set(toK, fromK);
    // The stored set still carries the old label (a case-only rename shares the key).
    const storedStillOld = fromK === toK ? stored?.subDisposition === r.from : !!stored;
    const leadF = { ...pipelineLeadFilter(p), subDisposition: r.from };
    const leads = fromK === toK ? await Lead.countDocuments(leadF) : await Lead.countDocuments(leadF).collation(CI);
    const lostReasonLeads = await Lead.countDocuments({ ...pipelineLeadFilter(p), lostReason: r.from });
    const lostReasonOpps = await Opportunity.countDocuments({ pipeline: opportunityPipeline, lostReason: r.from });
    renameReport.push({ from: r.from, to: r.to, leads, lostReasonLeads, lostReasonOpps, alreadyApplied: !storedStillOld && leads === 0 && lostReasonLeads === 0 && lostReasonOpps === 0 });
  }

  const changes: EntryChange[] = [];
  const matchedStored = new Set<string>();
  for (const s of spec) {
    const sk = key(s.subDisposition);
    const storedKey = renameTo.get(sk) ?? sk;
    const c = curByKey.get(storedKey);
    if (!c) {
      changes.push({ kind: "added", sub: s.subDisposition, fields: [], leads: 0, openLeads: 0 });
      continue;
    }
    matchedStored.add(storedKey);
    const fields = FIELDS.filter((f) => (c as any)[f] !== (s as any)[f]).map((f) => ({ field: f, before: (c as any)[f], after: (s as any)[f] }));
    if (!fields.length) continue;
    const counts = await countOn(p, c.subDisposition);
    changes.push({ kind: storedKey !== sk ? "renamed" : "changed", sub: s.subDisposition, from: storedKey !== sk ? c.subDisposition : undefined, fields, ...counts });
  }
  for (const c of current) {
    if (matchedStored.has(key(c.subDisposition))) continue;
    changes.push({ kind: "removed", sub: c.subDisposition, fields: [], ...(await countOn(p, c.subDisposition)) });
  }

  const storedOrder = current.map((e) => key(e.subDisposition));
  const specOrder = spec.map((e) => renameTo.get(key(e.subDisposition)) ?? key(e.subDisposition));
  const orderChanged = storedOrder.length === specOrder.length && storedOrder.some((k, i) => k !== specOrder[i]);
  const setChanged = !p || changes.length > 0 || orderChanged;

  return { pipelineKey: input.pipelineKey, exists: !!p, problems, changes, orderChanged, setChanged, renames: renameReport };
}

/* ───────────────────────────── apply ───────────────────────────── */

export interface ApplyResult {
  setWritten: "created" | "updated" | "unchanged";
  backfill: Array<{ from: string; to: string; leads: number; lostReasonLeads: number; lostReasonOpps: number }>;
}

export async function applySetChange(input: {
  pipelineKey: string;
  spec: DispositionEntry[];
  renames: Array<{ from: string; to: string }>;
  allowOrphans?: boolean;
}): Promise<ApplyResult> {
  const plan = await planSetChange(input);
  if (plan.problems.length) throw new Error(`Spec invalid — nothing written:\n  - ${plan.problems.join("\n  - ")}`);
  const orphaned = plan.changes.filter((c) => c.kind === "removed" && c.leads > 0);
  if (orphaned.length && !input.allowOrphans) {
    throw new Error(
      `Refusing to remove sub-dispositions that leads still sit on: ${orphaned.map((c) => `"${c.sub}" (${c.leads})`).join(", ")}. ` +
        `Mark them "active": false instead, add a --rename, or pass --allow-orphans.`,
    );
  }

  let setWritten: ApplyResult["setWritten"] = "unchanged";
  let p = await CrmPipeline.findOne({ key: input.pipelineKey });
  if (!p) {
    p = await CrmPipeline.create({ ...CORPORATE_CALLING_PIPELINE, dispositionSet: input.spec, teamIds: [] });
    setWritten = "created";
  } else if (plan.setChanged) {
    p.dispositionSet = input.spec as any;
    await p.save(); // the model's pre-validate hook re-checks the whole set
    setWritten = "updated";
  }

  const backfill: ApplyResult["backfill"] = [];
  const specByKey = new Map(input.spec.map((e) => [key(e.subDisposition), e]));
  for (const r of input.renames) {
    const e = specByKey.get(key(r.to))!;
    const caseOnly = key(r.from) === key(r.to);
    const leadF = { ...pipelineLeadFilter(p), subDisposition: r.from };
    const derived = {
      disposition: e.disposition,
      subDisposition: e.subDisposition,
      dispositionStage: e.stage,
      dispositionStatus: e.status,
      stage: e.legacyStage,
      status: e.leadStatus,
    };
    const leads = await Lead.updateMany(leadF, { $set: derived }, { runValidators: true, ...(caseOnly ? {} : { collation: CI }) });
    const lostLeads = r.from === e.subDisposition
      ? { modifiedCount: 0 }
      : await Lead.updateMany({ ...pipelineLeadFilter(p), lostReason: r.from }, { $set: { lostReason: e.subDisposition } });
    const lostOpps = r.from === e.subDisposition
      ? { modifiedCount: 0 }
      : await Opportunity.updateMany({ pipeline: p.opportunityPipeline, lostReason: r.from }, { $set: { lostReason: e.subDisposition } });
    backfill.push({ from: r.from, to: e.subDisposition, leads: leads.modifiedCount, lostReasonLeads: lostLeads.modifiedCount, lostReasonOpps: lostOpps.modifiedCount });
  }
  return { setWritten, backfill };
}

/* ───────────────────────────── CLI ───────────────────────────── */

function argValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name && i + 1 < args.length) out.push(args[++i]);
    else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  }
  return out;
}

function printPlan(plan: Plan) {
  if (!plan.exists) console.log(`Pipeline "${plan.pipelineKey}" does not exist — --apply would CREATE it from the spec.`);
  for (const pr of plan.problems) console.log(`  !! ${pr}`);
  if (!plan.changes.length && !plan.orderChanged) console.log("Set: no differences.");
  for (const c of plan.changes) {
    const counts = c.kind === "added" ? "" : `   [${c.leads} lead(s) on it, ${c.openLeads} open]`;
    if (c.kind === "added") console.log(`  + ADDED    ${c.sub}`);
    else if (c.kind === "removed") console.log(`  - REMOVED  ${c.sub}${counts}`);
    else if (c.kind === "renamed") console.log(`  ~ RENAMED  ${c.from} → ${c.sub}${counts}`);
    else console.log(`  ~ CHANGED  ${c.sub}${counts}`);
    for (const f of c.fields) console.log(`        ${f.field}: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`);
    const rederive = c.fields.some((f) => ["stage", "status", "leadStatus", "legacyStage", "disposition"].includes(f.field));
    if (rederive && c.leads && c.kind === "changed") console.log(`        note: the ${c.leads} lead(s) on it keep their stored stage/status — not re-derived`);
  }
  if (plan.orderChanged) console.log("  ~ ORDER    the picker order changes");
  for (const r of plan.renames) {
    console.log(`  rename "${r.from}" → "${r.to}": backfill ${r.leads} lead(s), lostReason on ${r.lostReasonLeads} lead(s) / ${r.lostReasonOpps} opportunit(ies)${r.alreadyApplied ? "  (already applied)" : ""}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowOrphans = args.includes("--allow-orphans");
  const expectDb = argValues(args, "--expect-db")[0];
  const pipelineKey = argValues(args, "--pipeline")[0] || CORPORATE_CALLING_PIPELINE.key;
  const specArg = argValues(args, "--spec")[0];
  const dumpTo = argValues(args, "--dump-current")[0];
  const renames = argValues(args, "--rename").map(parseRename);

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  const shown = uri.replace(/\/\/[^@/]*@/, "//***@").replace(/\?.*$/, "");
  console.log(`target ${shown}`);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.name;
  console.log(`db ${db} · pipeline ${pipelineKey} · ${apply ? "APPLY" : dumpTo ? "DUMP" : "DRY RUN"}`);
  // Same guard as migrate-disposition-nexttouch-not-connected.ts, checked
  // before anything else so a mistyped target never gets as far as a plan.
  if (apply && !expectDb) throw new Error(`REFUSING: --expect-db=<name> is required with --apply (connected db: "${db}").`);
  if (apply && expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  if (dumpTo) {
    const p = await CrmPipeline.findOne({ key: pipelineKey }).lean();
    if (!p) throw new Error(`No pipeline "${pipelineKey}".`);
    const out = { pipeline: p.key, name: p.name, opportunityPipeline: p.opportunityPipeline, dispositionSet: (p.dispositionSet || []).map(normaliseEntry) };
    writeFileSync(dumpTo, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${out.dispositionSet.length} entries to ${dumpTo}. Edit it, then pass it back as --spec.`);
    return;
  }
  if (!specArg) throw new Error("--spec=<file.json | @seed> is required (or --dump-current=<file> to export the stored set).");
  const spec = loadSpec(specArg);
  console.log(`spec ${specArg} (${spec.length} entries)${renames.length ? ` · ${renames.length} rename(s)` : ""}\n`);

  const plan = await planSetChange({ pipelineKey, spec, renames });
  printPlan(plan);
  const backfillPending = plan.renames.some((r) => !r.alreadyApplied);
  if (plan.problems.length) {
    process.exitCode = 1;
    console.log("\nSpec invalid — fix the problems above. Nothing written.");
    return;
  }
  if (!plan.setChanged && !backfillPending) {
    console.log("\nNothing to change.");
    return;
  }
  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --expect-db=<db> --apply to write.");
    return;
  }
  const r = await applySetChange({ pipelineKey, spec, renames, allowOrphans });
  console.log(`\nSet: ${r.setWritten}.`);
  for (const b of r.backfill) console.log(`Backfill "${b.from}" → "${b.to}": ${b.leads} lead(s), lostReason ${b.lostReasonLeads} lead(s) / ${b.lostReasonOpps} opportunit(ies). leadactivities untouched.`);
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main()
    .catch((err) => {
      console.error(err?.message || err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
