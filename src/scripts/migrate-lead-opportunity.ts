// apps/backend/src/scripts/migrate-lead-opportunity.ts
//
// Phase 1 / Slice 2 — the Lead → (Lead + Opportunity) migration
// (docs/crm/PLUMBOX_MIGRATION_PLAN.md). DRY RUN BY DEFAULT; writes only with
// --apply. Never run against production from an automated context: the
// production path requires --i-know-this-is-production AND typing the
// database name at an interactive terminal (lifted from the visa backfills).
//
// What it does (all through services/leadSplit.ts, the same code the flagged
// live routes use, so migrated and live rows have one shape):
//   1. Pre-flight counts (gap analysis §4.1) — printed, read-only.
//   2. Plans EVERY lead: legacy stage + history → new status, Opportunity
//      (or not), demo activity (or not). Prints counts per transition, how
//      many leads become opportunities vs stay leads, every warning kind
//      with counts, and EVERY row that does not map cleanly. Dry run stops here.
//   3. --apply: applies each plan (upsert Opportunity on leadId, append
//      activities stamped automatedByRule=<rule id>, $set the lead's new
//      fields; Lead.stage is NEVER written), then re-validates:
//        count(leads) unchanged, count(opportunities by rule) == planned,
//        no lead with two opportunities, no opportunity without a lead.
//   4. Data half of M8: backfills nameNormalized on crmcompanies rows still
//      carrying "" — skipping (and listing) any row whose key would collide
//      with an existing keyed row, because that is a merge decision (M10).
//
// Idempotent: a re-run plans already-converted leads as `skipped` and the
// Opportunity's unique partial index on leadId makes a duplicate impossible.
// --rollback reverses step 3 by rule id (see rollbackMigration below and the
// plan doc §7); the nameNormalized backfill is data hygiene and is NOT reverted.
//
// ⚠ TARGET GUARD (risk M13). Host-based, default-deny:
//   • mongodb+srv:// is refused outright unless --i-know-this-is-production.
//   • Any non-local host is refused unless --i-know-this-is-production.
//   • The database NAME must be plumbox_dev, or EXACTLY the value passed as
//     --db <name>. A restored prod copy on a local mongod therefore has to be
//     named on the command line — a local host is not proof the data is test data.
//
// Usage (local dev db):
//   node --env-file=.env.development --import tsx src/scripts/migrate-lead-opportunity.ts                 # dry run
//   node --env-file=.env.development --import tsx src/scripts/migrate-lead-opportunity.ts --apply         # write
// Restored prod copy on local mongod (MONGO_URI=mongodb://127.0.0.1:27017/plumbox_prodcopy):
//   ... --db plumbox_prodcopy            # dry run
//   ... --db plumbox_prodcopy --apply    # write
//   ... --db plumbox_prodcopy --rollback [--apply]
// Options: --rule-id <id> (default migration-2026-09-12-lead-opportunity)
//          --limit <n>    plan only the first n leads (sampling a dry run)
//          --verbose      print every row's plan, not just the unmapped ones
//          --force        re-apply even though the ledger records a success
import "dotenv/config";
import path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import LeadActivity from "../models/LeadActivity.js";
import Opportunity from "../models/Opportunity.js";
import CRMCompany from "../models/CRMCompany.js";
import { normalizeCompanyName } from "../utils/companyName.js";
import {
  planLeadSplit,
  applyLeadSplit,
  type SplitPlan,
  type ActivityLike,
  type ApplyResult,
} from "../services/leadSplit.js";
import { runMigration } from "../migrations/lib/migrationRunner.js";

export const DEFAULT_RULE_ID = "migration-2026-09-12-lead-opportunity";
export const MIGRATION_NAME = "2026-09-12-migrate-lead-opportunity";

/* ───────────────────────────── target guard ───────────────────────────── */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"]);
const DEFAULT_DB_NAME = "plumbox_dev";

export function describeTarget(uri: string): { hosts: string[]; db: string; srv: boolean } {
  const srv = uri.startsWith("mongodb+srv://");
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, "");
  const afterCreds = afterScheme.includes("@") ? afterScheme.slice(afterScheme.indexOf("@") + 1) : afterScheme;
  const [hostPart, ...rest] = afterCreds.split("/");
  return {
    hosts: hostPart.split(",").map((h) => h.split(":")[0].trim().toLowerCase()),
    db: (rest.join("/") || "").split("?")[0].trim(),
    srv,
  };
}

/** Default-deny: local host AND a database name that was either the dev
 *  default or named explicitly on the command line. */
export function assertTargetAllowed(uri: string, allowDb: string | null): void {
  if (!uri) throw new Error("REFUSING TO RUN: MONGO_URI is empty. Pass --env-file=.env.development.");
  const t = describeTarget(uri);
  if (t.srv) {
    throw new Error(
      "REFUSING TO RUN: MONGO_URI is a mongodb+srv:// (Atlas) string. This script runs against a LOCAL\n" +
        "database only — a restored prod copy on a local mongod, named with --db. Production needs\n" +
        "--i-know-this-is-production and an interactive terminal.",
    );
  }
  const remote = t.hosts.filter((h) => !LOCAL_HOSTS.has(h));
  if (remote.length) {
    throw new Error(`REFUSING TO RUN: MONGO_URI points at non-local host(s): ${remote.join(", ")}.`);
  }
  const expected = allowDb || DEFAULT_DB_NAME;
  if (t.db !== expected) {
    throw new Error(
      `REFUSING TO RUN: MONGO_URI database is '${t.db || "(none)"}', expected '${expected}'.\n` +
        "A local host is not proof the data is test data — name a restored copy explicitly with --db <name>.",
    );
  }
}

async function assertProductionAcknowledged(uri: string, willWrite: boolean): Promise<void> {
  const t = describeTarget(uri);
  console.log("──────────────────────────────────────────────────────");
  console.log("  PRODUCTION TARGET");
  console.log(`  host:     ${t.hosts.join(",")}`);
  console.log(`  database: ${t.db || "(default)"}`);
  console.log(`  action:   ${willWrite ? "WRITE (--apply)" : "read-only dry run"}`);
  console.log("──────────────────────────────────────────────────────");
  if (!willWrite) return;
  if (!rlInput.isTTY) {
    throw new Error("REFUSING TO RUN: --apply against production requires an interactive terminal (stdin is not a TTY).");
  }
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const answer = await rl.question(`Type the database name ("${t.db}") to WRITE: `);
    if (answer.trim() !== t.db) throw new Error("Aborted: input did not match the database name. Nothing was written.");
  } finally {
    rl.close();
  }
}

/* ───────────────────────────── pre-flight ───────────────────────────── */

export interface PreflightCounts {
  leads: number;
  byStage: Record<string, number>;
  byType: Record<string, number>;
  withDealValueByCurrency: Record<string, number>;
  companyNameWithoutCompanyId: number;
  convertedToContact: number;
  alreadyHaveStatus: number;
  alreadyHaveOpportunityId: number;
  activitiesByType: Record<string, number>;
  opportunities: number;
  opportunitiesByRule: Record<string, number>;
  crmCompanies: number;
  crmCompaniesBlankKey: number;
  nameNormalizedIndexes: string[];
}

async function groupCount(model: mongoose.Model<any>, field: string, match: any = {}): Promise<Record<string, number>> {
  const rows = await model.aggregate([{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r._id ?? "(null)")] = r.n;
  return out;
}

export async function preflightCounts(): Promise<PreflightCounts> {
  const indexes = await CRMCompany.collection.indexes().catch(() => [] as any[]);
  return {
    leads: await Lead.countDocuments({}),
    byStage: await groupCount(Lead, "stage"),
    byType: await groupCount(Lead, "type"),
    withDealValueByCurrency: await groupCount(Lead, "currency", { dealValue: { $gt: 0 } }),
    companyNameWithoutCompanyId: await Lead.countDocuments({ companyId: null, companyName: { $ne: "" } }),
    convertedToContact: await Lead.countDocuments({ convertedToContactId: { $ne: null } }),
    alreadyHaveStatus: await Lead.countDocuments({ status: { $type: "string" } }),
    alreadyHaveOpportunityId: await Lead.countDocuments({ opportunityId: { $type: "objectId" } }),
    activitiesByType: await groupCount(LeadActivity, "type"),
    opportunities: await Opportunity.countDocuments({}),
    opportunitiesByRule: await groupCount(Opportunity, "automatedByRule"),
    crmCompanies: await CRMCompany.countDocuments({}),
    crmCompaniesBlankKey: await CRMCompany.countDocuments({ $or: [{ nameNormalized: "" }, { nameNormalized: { $exists: false } }] }),
    nameNormalizedIndexes: (indexes as any[]).filter((i) => i.key && "nameNormalized" in i.key).map((i) => `${i.name}${i.unique ? " (unique)" : ""}${i.partialFilterExpression ? " (partial)" : ""}`),
  };
}

/* ───────────────────────────── plan ───────────────────────────── */

export interface PlanSummary {
  planned: number;
  byTransition: Record<string, number>;
  becomeOpportunities: number;
  stayLeads: number;
  opportunitiesByPipelineStage: Record<string, number>;
  demoActivities: number;
  followUpDatesPreserved: number;
  lostAtLead: number;
  lostAtOpportunity: number;
  skipped: Record<string, number>;
  unmapped: Array<{ leadId: string; leadCode: string; stage: string; reason: string }>;
  warningsByKind: Record<string, number>;
  closedAtSources: Record<string, number>;
}

export interface MigrationPlan {
  plans: SplitPlan[];
  leadsById: Map<string, any>;
  summary: PlanSummary;
}

function bump(rec: Record<string, number>, key: string, n = 1) {
  rec[key] = (rec[key] || 0) + n;
}

export async function planMigration(opts: { limit?: number } = {}): Promise<MigrationPlan> {
  const q = Lead.find({}).sort({ createdAt: 1 });
  if (opts.limit) q.limit(opts.limit);
  const leads = (await q.lean()) as any[];
  const ids = leads.map((l) => l._id);
  const acts = ids.length
    ? ((await LeadActivity.find({ leadId: { $in: ids } })
        .select("leadId type toStage fromStage createdAt subject")
        .lean()) as any[])
    : [];
  const actsByLead = new Map<string, ActivityLike[]>();
  for (const a of acts) {
    const k = String(a.leadId);
    if (!actsByLead.has(k)) actsByLead.set(k, []);
    actsByLead.get(k)!.push(a);
  }

  const summary: PlanSummary = {
    planned: 0,
    byTransition: {},
    becomeOpportunities: 0,
    stayLeads: 0,
    opportunitiesByPipelineStage: {},
    demoActivities: 0,
    followUpDatesPreserved: 0,
    lostAtLead: 0,
    lostAtOpportunity: 0,
    skipped: {},
    unmapped: [],
    warningsByKind: {},
    closedAtSources: {},
  };
  const plans: SplitPlan[] = [];
  const leadsById = new Map<string, any>();
  for (const lead of leads) {
    leadsById.set(String(lead._id), lead);
    const plan = planLeadSplit(lead, actsByLead.get(String(lead._id)) ?? []);
    plans.push(plan);
    if (plan.unmapped) {
      summary.unmapped.push({ leadId: plan.leadId, leadCode: plan.leadCode, stage: plan.legacyStage, reason: plan.unmapped });
      continue;
    }
    if (plan.skipped) {
      bump(summary.skipped, plan.skipped);
      continue;
    }
    summary.planned++;
    bump(summary.byTransition, plan.transition);
    if (plan.opportunity) {
      summary.becomeOpportunities++;
      bump(summary.opportunitiesByPipelineStage, `${plan.opportunity.pipeline}/${plan.opportunity.stage}`);
      bump(summary.closedAtSources, plan.opportunity.closedAtSource);
    } else {
      summary.stayLeads++;
    }
    if (plan.logDemo) summary.demoActivities++;
    if (plan.preserveFollowUp && leadsById.get(plan.leadId)?.nextFollowUpDate) summary.followUpDatesPreserved++;
    if (plan.lostAt === "lead") summary.lostAtLead++;
    if (plan.lostAt === "opportunity") summary.lostAtOpportunity++;
    for (const w of plan.warnings) bump(summary.warningsByKind, w);
  }
  return { plans, leadsById, summary };
}

/* ───────────────────────────── apply ───────────────────────────── */

export interface ApplySummary {
  applied: number;
  opportunitiesCreated: number;
  opportunitiesAdvanced: number;
  activitiesWritten: number;
  leadsUpdated: number;
  skipped: number;
  refusedUnmapped: number;
  failures: Array<{ leadId: string; error: string }>;
}

export async function applyMigration(plan: MigrationPlan, ruleId: string): Promise<ApplySummary> {
  const out: ApplySummary = {
    applied: 0, opportunitiesCreated: 0, opportunitiesAdvanced: 0, activitiesWritten: 0,
    leadsUpdated: 0, skipped: 0, refusedUnmapped: 0, failures: [],
  };
  for (const p of plan.plans) {
    if (p.unmapped) { out.refusedUnmapped++; continue; }
    if (p.skipped) { out.skipped++; continue; }
    const lead = plan.leadsById.get(p.leadId);
    try {
      const r: ApplyResult = await applyLeadSplit(lead, p, { ruleId, actorName: "System Migration" });
      out.applied++;
      if (r.opportunityCreated) out.opportunitiesCreated++;
      if (r.opportunityAdvanced) out.opportunitiesAdvanced++;
      out.activitiesWritten += r.activitiesWritten;
      if (r.leadUpdated) out.leadsUpdated++;
    } catch (e: any) {
      out.failures.push({ leadId: p.leadId, error: e?.message || String(e) });
    }
  }
  return out;
}

/* ─────────────────── nameNormalized blank backfill (M8 data half) ─────────────────── */

export interface BlankKeySummary {
  blanks: number;
  backfilled: number;
  /** Rows left alone because their key already belongs to another row — merge decisions. */
  clashes: Array<{ id: string; name: string; key: string; existingId: string; existingName: string }>;
  /** Rows whose name normalises to "" (cannot be keyed). */
  unkeyable: number;
}

export async function backfillBlankNameNormalized(dryRun: boolean): Promise<BlankKeySummary> {
  const blanks = (await CRMCompany.find({ $or: [{ nameNormalized: "" }, { nameNormalized: { $exists: false } }] })
    .select("_id name")
    .sort({ createdAt: 1 })
    .lean()) as any[];
  const out: BlankKeySummary = { blanks: blanks.length, backfilled: 0, clashes: [], unkeyable: 0 };
  const claimed = new Map<string, { id: string; name: string }>();
  for (const row of blanks) {
    const key = normalizeCompanyName(row.name);
    if (!key) { out.unkeyable++; continue; }
    const existing =
      claimed.get(key) ??
      ((await CRMCompany.findOne({ nameNormalized: key, _id: { $ne: row._id } }).select("_id name").lean()) as any);
    if (existing) {
      out.clashes.push({ id: String(row._id), name: row.name, key, existingId: String(existing._id ?? existing.id), existingName: existing.name });
      continue;
    }
    claimed.set(key, { id: String(row._id), name: row.name });
    if (!dryRun) {
      // Raw write: no hooks, no timestamp bump, and the filter re-checks the
      // blank so a row keyed by a concurrent save is not clobbered.
      const r = await CRMCompany.collection.updateOne(
        { _id: row._id, $or: [{ nameNormalized: "" }, { nameNormalized: { $exists: false } }] },
        { $set: { nameNormalized: key } },
      );
      if (r.modifiedCount) out.backfilled++;
    } else {
      out.backfilled++; // would be
    }
  }
  return out;
}

/* ───────────────────────────── validate ───────────────────────────── */

export interface ValidationReport {
  leadsBefore: number;
  leadsAfter: number;
  opportunitiesByRule: number;
  plannedOpportunities: number;
  leadsWithTwoOpportunities: number;
  opportunitiesWithoutLead: number;
  leadsPointingAtMissingOpportunity: number;
  leadsStageTouched: number;
  ok: boolean;
  problems: string[];
}

export async function validateAfterApply(
  leadsBefore: number,
  stageCountsBefore: Record<string, number>,
  plannedOpportunities: number,
  ruleId: string,
): Promise<ValidationReport> {
  const leadsAfter = await Lead.countDocuments({});
  const opportunitiesByRule = await Opportunity.countDocuments({ automatedByRule: ruleId });
  const dup = await Opportunity.aggregate([
    { $match: { leadId: { $type: "objectId" } } },
    { $group: { _id: "$leadId", n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: "n" },
  ]);
  const opps = (await Opportunity.find({ leadId: { $type: "objectId" } }).select("_id leadId").lean()) as any[];
  const leadIdSet = new Set((await Lead.find({ _id: { $in: opps.map((o) => o.leadId) } }).select("_id").lean()).map((l: any) => String(l._id)));
  const opportunitiesWithoutLead = opps.filter((o) => !leadIdSet.has(String(o.leadId))).length;
  const pointing = (await Lead.find({ opportunityId: { $type: "objectId" } }).select("opportunityId").lean()) as any[];
  const oppIdSet = new Set((await Opportunity.find({ _id: { $in: pointing.map((l) => l.opportunityId) } }).select("_id").lean()).map((o: any) => String(o._id)));
  const leadsPointingAtMissingOpportunity = pointing.filter((l) => !oppIdSet.has(String(l.opportunityId))).length;
  const stageCountsAfter = await groupCount(Lead, "stage");
  let leadsStageTouched = 0;
  for (const s of new Set([...Object.keys(stageCountsBefore), ...Object.keys(stageCountsAfter)])) {
    leadsStageTouched += Math.abs((stageCountsBefore[s] || 0) - (stageCountsAfter[s] || 0));
  }
  const problems: string[] = [];
  if (leadsAfter !== leadsBefore) problems.push(`count(leads) changed: ${leadsBefore} → ${leadsAfter}`);
  if (opportunitiesByRule !== plannedOpportunities) problems.push(`opportunities by rule ${opportunitiesByRule} ≠ planned ${plannedOpportunities}`);
  if ((dup[0]?.n ?? 0) > 0) problems.push(`${dup[0].n} lead(s) have more than one opportunity`);
  if (opportunitiesWithoutLead) problems.push(`${opportunitiesWithoutLead} opportunity rows point at a missing lead`);
  if (leadsPointingAtMissingOpportunity) problems.push(`${leadsPointingAtMissingOpportunity} leads point at a missing opportunity`);
  if (leadsStageTouched) problems.push(`Lead.stage distribution changed (${leadsStageTouched} deltas) — the migration must never write stage`);
  return {
    leadsBefore, leadsAfter, opportunitiesByRule, plannedOpportunities,
    leadsWithTwoOpportunities: dup[0]?.n ?? 0, opportunitiesWithoutLead, leadsPointingAtMissingOpportunity,
    leadsStageTouched, ok: problems.length === 0, problems,
  };
}

/* ───────────────────────────── rollback ─────────────────────────────
 * Reverses --apply for one rule id. Lead.stage was never written, so every
 * lead field the migration set is re-derivable: `status`, `sourceChannel`,
 * `enquiryType` and `opportunityId` are $unset on leads whose opportunityId
 * points at a migration-written Opportunity or is null (a lead whose
 * Opportunity was created LIVE after the migration keeps its state). Then the
 * migration's Opportunities and activities are deleted by rule id. The
 * nameNormalized backfill is not reverted (data hygiene, no behaviour). */

export interface RollbackSummary {
  opportunitiesToDelete: number;
  activitiesToDelete: number;
  leadsToReset: number;
  opportunitiesDeleted: number;
  activitiesDeleted: number;
  leadsReset: number;
}

export async function rollbackMigration(ruleId: string, dryRun: boolean): Promise<RollbackSummary> {
  const oppIds = (await Opportunity.find({ automatedByRule: ruleId }).select("_id").lean()).map((o: any) => o._id);
  // (points at a migration opportunity OR has none) AND (carries something to reset)
  const leadFilter = {
    $and: [
      { $or: [{ opportunityId: { $in: oppIds } }, { opportunityId: null }] },
      {
        $or: [
          { status: { $ne: null } },
          { sourceChannel: { $nin: [null, ""] } },
          { enquiryType: { $nin: [null, ""] } },
          { opportunityId: { $in: oppIds } },
        ],
      },
    ],
  };
  const out: RollbackSummary = {
    opportunitiesToDelete: oppIds.length,
    activitiesToDelete: await LeadActivity.countDocuments({ automatedByRule: ruleId }),
    leadsToReset: await Lead.countDocuments(leadFilter),
    opportunitiesDeleted: 0,
    activitiesDeleted: 0,
    leadsReset: 0,
  };
  if (dryRun) return out;
  const l = await Lead.collection.updateMany(leadFilter, { $unset: { status: "", sourceChannel: "", enquiryType: "", opportunityId: "" } });
  out.leadsReset = l.modifiedCount ?? 0;
  const a = await LeadActivity.deleteMany({ automatedByRule: ruleId });
  out.activitiesDeleted = a.deletedCount ?? 0;
  const o = await Opportunity.deleteMany({ _id: { $in: oppIds } });
  out.opportunitiesDeleted = o.deletedCount ?? 0;
  return out;
}

/* ───────────────────────────── report printers ───────────────────────────── */

function printKV(title: string, rec: Record<string, number>) {
  console.log(`  ${title}`);
  const keys = Object.keys(rec).sort();
  if (!keys.length) console.log("    (none)");
  for (const k of keys) console.log(`    ${k.padEnd(52)} ${rec[k]}`);
}

export function printPreflight(c: PreflightCounts) {
  console.log("=== PRE-FLIGHT (read-only) ===");
  console.log(`  leads: ${c.leads}   opportunities: ${c.opportunities}   crmcompanies: ${c.crmCompanies}`);
  printKV("leads by stage", c.byStage);
  printKV("leads by type", c.byType);
  printKV("leads with dealValue > 0, by currency", c.withDealValueByCurrency);
  console.log(`  leads with companyName but no companyId: ${c.companyNameWithoutCompanyId}`);
  console.log(`  leads with convertedToContactId:        ${c.convertedToContact}`);
  console.log(`  leads already carrying status:          ${c.alreadyHaveStatus}`);
  console.log(`  leads already carrying opportunityId:   ${c.alreadyHaveOpportunityId}`);
  printKV("leadactivities by type", c.activitiesByType);
  printKV("opportunities by automatedByRule", c.opportunitiesByRule);
  console.log(`  crmcompanies with nameNormalized "":     ${c.crmCompaniesBlankKey}`);
  console.log(`  crmcompanies nameNormalized indexes:     ${c.nameNormalizedIndexes.join(", ") || "(none)"}`);
  console.log("");
}

export function printPlan(s: PlanSummary, verbose: boolean, plans?: SplitPlan[]) {
  console.log("=== PLAN ===");
  console.log(`  leads planned: ${s.planned}   → become Opportunities: ${s.becomeOpportunities}   stay Leads: ${s.stayLeads}`);
  printKV("per transition", s.byTransition);
  printKV("opportunities by pipeline/stage", s.opportunitiesByPipelineStage);
  printKV("closedAt source (closed opportunities)", s.closedAtSources);
  console.log(`  demo activities to write:           ${s.demoActivities}`);
  console.log(`  follow_up dates preserved:          ${s.followUpDatesPreserved}`);
  console.log(`  lost at lead / at opportunity:      ${s.lostAtLead} / ${s.lostAtOpportunity}`);
  printKV("skipped (idempotent re-run)", s.skipped);
  printKV("warnings by kind", s.warningsByKind);
  console.log(`  UNMAPPED rows (not applied): ${s.unmapped.length}`);
  for (const u of s.unmapped) console.log(`    ${u.leadCode || u.leadId}  stage="${u.stage}"  ${u.reason}`);
  if (verbose && plans) {
    console.log("  every row:");
    for (const p of plans) {
      console.log(`    ${(p.leadCode || p.leadId).padEnd(16)} ${p.transition.padEnd(48)} ${p.skipped ? `skipped:${p.skipped}` : ""}${p.warnings.length ? " ⚠ " + p.warnings.join("; ") : ""}`);
    }
  }
  console.log("");
}

/* ───────────────────────────── main ───────────────────────────── */

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const rollback = process.argv.includes("--rollback");
  const verbose = process.argv.includes("--verbose");
  const productionAcknowledged = process.argv.includes("--i-know-this-is-production");
  const allowDb = argValue("--db");
  const ruleId = argValue("--rule-id") || DEFAULT_RULE_ID;
  const limit = Number(argValue("--limit") || 0) || undefined;

  const uri = process.env.MONGO_URI || "";
  console.log(`=== Lead → Lead + Opportunity migration (${MIGRATION_NAME}) ===`);
  console.log(`Mode: ${rollback ? "ROLLBACK " : ""}${dryRun ? "DRY RUN" : "APPLY"}${productionAcknowledged ? " (PRODUCTION path)" : ""}   rule id: ${ruleId}`);

  if (productionAcknowledged) await assertProductionAcknowledged(uri, !dryRun);
  else assertTargetAllowed(uri, allowDb);

  await mongoose.connect(uri);
  const t = describeTarget(uri);
  console.log(`Connected to: ${t.hosts.join(",")}/${t.db}`);
  console.log("");

  try {
    if (rollback) {
      const r = await rollbackMigration(ruleId, dryRun);
      console.log("=== ROLLBACK ===");
      console.log(`  opportunities: ${dryRun ? `${r.opportunitiesToDelete} would be deleted` : `${r.opportunitiesDeleted} deleted`}`);
      console.log(`  activities:    ${dryRun ? `${r.activitiesToDelete} would be deleted` : `${r.activitiesDeleted} deleted`}`);
      console.log(`  leads:         ${dryRun ? `${r.leadsToReset} would be reset` : `${r.leadsReset} reset`}`);
      if (dryRun) console.log("\nRe-run with --apply to perform the rollback.");
      return;
    }

    const pre = await preflightCounts();
    printPreflight(pre);

    await runMigration({
      migrationName: MIGRATION_NAME,
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const plan = await planMigration({ limit });
        printPlan(plan.summary, verbose, plan.plans);

        const blanks = await backfillBlankNameNormalized(true);
        console.log("=== crmcompanies nameNormalized blanks (M8 data half) ===");
        console.log(`  blank rows: ${blanks.blanks}   would backfill: ${blanks.backfilled}   unkeyable: ${blanks.unkeyable}   clashes (left alone): ${blanks.clashes.length}`);
        for (const c of blanks.clashes) console.log(`    "${c.name}" (${c.id}) → key "${c.key}" already on "${c.existingName}" (${c.existingId}) — merge decision`);
        console.log("");

        if (dryRun) {
          console.log("DRY RUN — nothing written. Re-run with --apply to write.");
          return { outcome: "SUCCESS", summary: `dry-run planned=${plan.summary.planned} opportunities=${plan.summary.becomeOpportunities} stayLeads=${plan.summary.stayLeads} unmapped=${plan.summary.unmapped.length} blanks=${blanks.blanks}` };
        }
        if (plan.summary.unmapped.length) {
          console.log(`⚠ ${plan.summary.unmapped.length} unmapped row(s) will be left untouched.`);
        }

        const applied = await applyMigration(plan, ruleId);
        console.log("=== APPLY ===");
        console.log(`  applied: ${applied.applied}   opportunities created: ${applied.opportunitiesCreated}   advanced: ${applied.opportunitiesAdvanced}`);
        console.log(`  activities written: ${applied.activitiesWritten}   leads updated: ${applied.leadsUpdated}   skipped: ${applied.skipped}   refused (unmapped): ${applied.refusedUnmapped}`);
        for (const f of applied.failures) console.log(`  ✗ ${f.leadId}: ${f.error}`);

        const keyed = await backfillBlankNameNormalized(false);
        console.log(`  nameNormalized backfilled: ${keyed.backfilled} (clashes left alone: ${keyed.clashes.length})`);

        const v = await validateAfterApply(pre.leads, pre.byStage, plan.summary.becomeOpportunities + (pre.opportunitiesByRule[ruleId] || 0), ruleId);
        console.log("=== VALIDATE ===");
        console.log(`  leads ${v.leadsBefore} → ${v.leadsAfter}   opportunities by rule ${v.opportunitiesByRule} (planned ${v.plannedOpportunities})   dup-lead opps ${v.leadsWithTwoOpportunities}   orphans ${v.opportunitiesWithoutLead}/${v.leadsPointingAtMissingOpportunity}   stage deltas ${v.leadsStageTouched}`);
        for (const p of v.problems) console.log(`  ✗ ${p}`);
        console.log(v.ok ? "  ✓ validation passed" : "  ✗ VALIDATION FAILED — see docs/crm/PLUMBOX_MIGRATION_PLAN.md §7 (rollback)");
        const summary = `applied=${applied.applied} created=${applied.opportunitiesCreated} advanced=${applied.opportunitiesAdvanced} activities=${applied.activitiesWritten} leadsUpdated=${applied.leadsUpdated} failures=${applied.failures.length} blanksKeyed=${keyed.backfilled} valid=${v.ok}`;
        return { outcome: v.ok && !applied.failures.length ? "SUCCESS" : "PARTIAL", summary };
      },
    });
  } finally {
    await mongoose.connection.close();
  }
}

// Auto-run ONLY when this file is the process entry point — importing it for
// its exports (the test does) must never start a run.
const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Migration failed:", err?.message || err);
    try { await mongoose.connection.close(); } catch { /* ignore */ }
    process.exit(1);
  });
}
