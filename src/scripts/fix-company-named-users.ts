// apps/backend/src/scripts/fix-company-named-users.ts
//
// ══════════════════════════════════════════════════════════════════════
// Gives the users whose PERSON name holds their COMPANY name a real person
// name (docs/audits/company-vs-person-name-audit.md §6.5). Three modes:
//
// 1. PROPOSE (default) — READ-ONLY. Lists every non-HOUSE user whose name,
//    firstName or "firstName lastName" equals one of their company names
//    (workspace companyName by workspaceId / customerId, Customer name /
//    legalName / companyName, every WorkspaceMembership workspace), and
//    proposes a person name, first match wins:
//      0. the user's own firstName (+ lastName) when it already is a person,
//         not the company (e.g. name = company, firstName = "Anirudh Binani")
//      1. Customer.keyContacts row whose email = the user's email
//      2. the user's claimed TravellerProfile (first + last)
//      3. the Onboarding's formPayload: signatory.name, then keyContacts
//         (matching email, then the first), then inviteeName
//      4. else blank
//    Candidates equal to a company name, holding an email, or a placeholder
//    are never proposed. Excluded: demo1@plumtrips.com, *@cstep-qa.test.
//    Writes a CSV (--out) to review and edit.
//
// 2. APPLY — reads the edited CSV (--from-csv). Dry run unless --apply.
//    Per row: blank proposal → skipped; a proposal equal to the company →
//    skipped; the user's name / firstName / lastName no longer what PROPOSE
//    read → skipped and reported. With --apply: saves a JSON backup FIRST
//    (--backup, default fix-company-named-users-backup-<time>.json), then
//    writes firstName / lastName / name (name = first + last) only while the
//    stored values still equal what was read, sets CustomerMember.name for
//    that email, and appends one UserNameAudit row (via "script").
//
// 3. UNDO — --undo=<backup>. Dry run unless --apply. Restores every user and
//    roster row in the backup exactly (absent fields are unset again), only
//    where the values are still what APPLY wrote; others are reported.
//    One UserNameAudit row per restore.
//
// REQUIRED (every mode)
//   --expect-db=<name>   must equal the connected database, or nothing is read
//
// USAGE
//   npx tsx src/scripts/fix-company-named-users.ts --expect-db=Plumtrips_hrms --out=company-named-proposal.csv
//   npx tsx src/scripts/fix-company-named-users.ts --expect-db=Plumtrips_hrms --from-csv=company-named-proposal.csv
//   npx tsx src/scripts/fix-company-named-users.ts --expect-db=Plumtrips_hrms --from-csv=company-named-proposal.csv --apply
//   npx tsx src/scripts/fix-company-named-users.ts --expect-db=Plumtrips_hrms --undo=fix-company-named-users-backup-….json [--apply]
//   (MONGO_URI from the environment.)
// ══════════════════════════════════════════════════════════════════════

import "dotenv/config";
import fs from "node:fs";
import mongoose from "mongoose";
import UserNameAudit from "../models/UserNameAudit.js";
import { cleanPersonName, normaliseCompany, sameAsCompany, splitPersonName, validateNameInput } from "../services/personNames.js";

export const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
const EXCLUDED_EMAILS = new Set(["demo1@plumtrips.com"]);
const EXCLUDED_DOMAINS = ["@cstep-qa.test"];
const SCRIPT_ACTOR = "script:fix-company-named-users";

/** A word a person's name practically never contains (whole words). */
export const COMPANY_WORD_RX =
  /\b(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation|plc|gmbh|llc|opc|technologies|technology|tech|solutions|services|enterprises?|industries|international|global|group|consultants?|consulting|consultancy|systems|software|labs|ventures|holdings|associates|logistics|travels?|tours|infra|infrastructure|pharma|pharmaceuticals|healthcare|foundation|trust|exports?|imports?|traders|trading|manufacturing|motors|engineering|works|agency|studios?|media|networks|capital|finance|realty|developers)\b/i;

const str = (v: any) => (v === null || v === undefined ? "" : String(v).trim());
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const col = (n: string) => mongoose.connection.db!.collection(n);

export type Source =
  | "existingFirstName"
  | "customerKeyContact"
  | "travellerProfile"
  | "onboardingSignatory"
  | "onboardingKeyContact"
  | "onboardingInvitee"
  | "none";

export type ProposalRow = {
  email: string;
  userId: string;
  company: string;
  currentName: string;
  currentFirstName: string;
  currentLastName: string;
  proposedFirstName: string;
  proposedLastName: string;
  source: Source;
  note: string;
};

export const CSV_COLUMNS: Array<keyof ProposalRow> = [
  "email",
  "userId",
  "company",
  "currentName",
  "currentFirstName",
  "currentLastName",
  "proposedFirstName",
  "proposedLastName",
  "source",
  "note",
];

function refuseWrongDb(expectDb: string | undefined) {
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);
  return db;
}

const excluded = (email: string) => EXCLUDED_EMAILS.has(email) || EXCLUDED_DOMAINS.some((d) => email.endsWith(d));

/**
 * A usable person name that is not one of the company names ("" otherwise).
 * Also refuses the company's leading words ("Peachmint" for "Peachmint Foods
 * Pvt Ltd") — what a session split of a company name leaves in firstName.
 */
function personOrBlank(v: unknown, companyNames: string[]): string {
  const n = cleanPersonName(v);
  if (!n || sameAsCompany(n, companyNames) || COMPANY_WORD_RX.test(n)) return "";
  const nn = normaliseCompany(n);
  if (companyNames.some((c) => normaliseCompany(c).startsWith(`${nn} `))) return "";
  return n;
}

/** Every company name the user belongs to, for one user. */
async function companyNamesFor(u: any, cache: Map<string, any>): Promise<{ names: string[]; display: string; customer: any }> {
  const get = async (key: string, load: () => Promise<any>) => {
    if (!cache.has(key)) cache.set(key, await load());
    return cache.get(key);
  };
  const wsId = str(u.workspaceId);
  const custId = str(u.customerId);
  const wsById = mongoose.isValidObjectId(wsId)
    ? await get(`ws:${wsId}`, () => col("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(wsId) }))
    : null;
  const effectiveCustId = custId || str(wsById?.customerId);
  const wsByCust = effectiveCustId ? await get(`wsc:${effectiveCustId}`, () => col("customerworkspaces").findOne({ customerId: effectiveCustId })) : null;
  const customer = mongoose.isValidObjectId(effectiveCustId)
    ? await get(`c:${effectiveCustId}`, () => col("customers").findOne({ _id: new mongoose.Types.ObjectId(effectiveCustId) }))
    : null;
  const memberWs = (await col("workspacememberships").find({ userId: u._id }).project({ workspaceId: 1 }).toArray()) as any[];
  const memberNames: string[] = [];
  for (const m of memberWs) {
    const w = await get(`ws:${String(m.workspaceId)}`, () => col("customerworkspaces").findOne({ _id: m.workspaceId }));
    if (w?.companyName) memberNames.push(str(w.companyName));
  }
  const names = [
    str(wsById?.companyName),
    str(wsByCust?.companyName),
    str(customer?.name),
    str(customer?.legalName),
    str(customer?.companyName),
    ...memberNames,
  ].filter(Boolean);
  const display = str(wsByCust?.companyName) || str(wsById?.companyName) || str(customer?.legalName) || str(customer?.name);
  return { names, display, customer };
}

function equalsCompany(u: any, companyNames: string[]): boolean {
  const companies = new Set(companyNames.map(normaliseCompany).filter(Boolean));
  return [str(u.name), str(u.firstName), [str(u.firstName), str(u.lastName)].filter(Boolean).join(" ")].some((v) => {
    const n = normaliseCompany(v);
    return !!n && companies.has(n);
  });
}

/** PROPOSE: read-only. */
export async function proposeCompanyNamedUsers(opts: {
  expectDb: string | undefined;
  log?: (line: string) => void;
}): Promise<{ db: string; scanned: number; rows: ProposalRow[] }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = refuseWrongDb(opts.expectDb);
  const cache = new Map<string, any>();

  const users = (await col("users")
    .find({ workspaceId: { $ne: new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID) } })
    .project({ email: 1, name: 1, firstName: 1, lastName: 1, workspaceId: 1, customerId: 1 })
    .toArray()) as any[];

  const rows: ProposalRow[] = [];
  for (const u of users) {
    const email = str(u.email).toLowerCase();
    if (!email || excluded(email)) continue;
    if (str(u.workspaceId) === HOUSE_WORKSPACE_ID) continue;

    const { names, display, customer } = await companyNamesFor(u, cache);
    if (!names.length || !equalsCompany(u, names)) continue;

    const ok = (v: unknown) => personOrBlank(v, names);
    let proposed = "";
    let source: Source = "none";
    const pick = (v: unknown, s: Source) => {
      if (proposed) return;
      const n = ok(v);
      if (n) {
        proposed = n;
        source = s;
      }
    };

    // 0. firstName (+ lastName) already a person.
    pick([str(u.firstName), str(u.lastName)].filter(Boolean).join(" "), "existingFirstName");

    // 1. Customer.keyContacts with this email.
    const keyContacts: any[] = Array.isArray(customer?.keyContacts) ? customer.keyContacts : [];
    pick(keyContacts.find((c) => str(c?.email).toLowerCase() === email)?.name, "customerKeyContact");

    // 2. Claimed traveller profile (newest claim).
    if (!proposed) {
      const tp: any = await col("travellerprofiles").findOne({ claimedBy: u._id }, { sort: { claimedAt: -1 } });
      if (tp) pick([str(tp.firstName), str(tp.middleName), str(tp.lastName)].filter(Boolean).join(" "), "travellerProfile");
    }

    // 3. Onboarding form: signatory → key contacts → invitee.
    if (!proposed) {
      const or: any[] = [{ email }, { inviteeEmail: email }];
      if (customer?._id) or.unshift({ linkedCustomerId: customer._id });
      const ob: any = await col("onboardings").findOne({ $or: or }, { sort: { updatedAt: -1 } });
      if (ob) {
        const form = ob.formPayload || ob.payload || {};
        const obContacts: any[] = Array.isArray(form.keyContacts) ? form.keyContacts : [];
        pick(form?.signatory?.name, "onboardingSignatory");
        pick(obContacts.find((c) => str(c?.email).toLowerCase() === email)?.name, "onboardingKeyContact");
        pick(obContacts[0]?.name, "onboardingKeyContact");
        pick(ob.inviteeName, "onboardingInvitee");
      }
    }

    const split = splitPersonName(proposed);
    rows.push({
      email,
      userId: String(u._id),
      company: display,
      currentName: str(u.name),
      currentFirstName: str(u.firstName),
      currentLastName: str(u.lastName),
      proposedFirstName: split.firstName,
      proposedLastName: split.lastName,
      source,
      note: display && !COMPANY_WORD_RX.test(display) ? "company has no company word - may be an individual customer, check" : "",
    });
  }
  rows.sort((a, b) => a.company.localeCompare(b.company) || a.email.localeCompare(b.email));

  log(`[fix-company-named] db=${db} PROPOSE (read-only) scanned=${users.length} listed=${rows.length} blank=${rows.filter((r) => !r.proposedFirstName).length}`);
  for (const r of rows) {
    const to = [r.proposedFirstName, r.proposedLastName].filter(Boolean).join(" ") || "(blank)";
    log(`  ${r.email}  "${r.currentName}" → "${to}"  [${r.source}]${r.note ? `  (${r.note})` : ""}`);
  }
  return { db, scanned: users.length, rows };
}

/* ── CSV ─────────────────────────────────────────────────────────────── */

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: ProposalRow[]): string {
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((k) => csvCell(r[k])).join(","))].join("\n") + "\n";
}

/** RFC-4180-ish parser: quoted fields, "" escapes, CRLF/LF, a leading BOM (Excel). */
export function parseCsv(text: string): ProposalRow[] {
  const src = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const [head, ...body] = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (!head) return [];
  const idx = (k: string) => head.findIndex((h) => h.trim() === k);
  for (const k of ["email", "userId", "currentName", "currentFirstName", "currentLastName", "proposedFirstName", "proposedLastName"]) {
    if (idx(k) < 0) throw new Error(`CSV is missing the "${k}" column`);
  }
  return body.map((r) => {
    const out: any = {};
    for (const k of CSV_COLUMNS) out[k] = idx(k) >= 0 ? str(r[idx(k)]) : "";
    return out as ProposalRow;
  });
}

/* ── APPLY ───────────────────────────────────────────────────────────── */

type Slot = { present: boolean; value?: any };
const slot = (doc: any, k: string): Slot => (doc && Object.prototype.hasOwnProperty.call(doc, k) ? { present: true, value: doc[k] } : { present: false });
/** A filter value that matches exactly what a slot recorded. */
const guardOf = (s: Slot) => (s.present ? s.value : { $exists: false });

export type BackupEntry = {
  userId: string;
  email: string;
  before: { name: Slot; firstName: Slot; lastName: Slot };
  after: { firstName: string; lastName: string; name: string };
  members: Array<{ _id: string; name: Slot }>;
};
export type Backup = { db: string; createdAt: string; script: string; entries: BackupEntry[] };

export type Outcome = { email: string; userId: string; reason: string };

export async function applyNameFixes(opts: {
  expectDb: string | undefined;
  rows: ProposalRow[];
  apply?: boolean;
  backupPath?: string;
  log?: (line: string) => void;
}): Promise<{ db: string; applied: boolean; planned: number; written: number; skipped: Outcome[]; backupPath?: string }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = refuseWrongDb(opts.expectDb);
  const cache = new Map<string, any>();
  const skipped: Outcome[] = [];
  const plan: Array<{ row: ProposalRow; user: any; to: { firstName: string; lastName: string; name: string } }> = [];

  for (const row of opts.rows) {
    const email = str(row.email).toLowerCase();
    const skip = (reason: string) => skipped.push({ email, userId: row.userId, reason });

    if (!str(row.proposedFirstName)) {
      skip("blank proposal");
      continue;
    }
    const v = validateNameInput({ firstName: row.proposedFirstName, lastName: row.proposedLastName });
    if ("error" in v) {
      skip(`invalid proposal: ${v.error}`);
      continue;
    }
    if (!mongoose.isValidObjectId(row.userId)) {
      skip("bad userId");
      continue;
    }
    const user: any = await col("users").findOne({ _id: new mongoose.Types.ObjectId(row.userId) });
    if (!user) {
      skip("user not found");
      continue;
    }
    if (str(user.email).toLowerCase() !== email) {
      skip("email does not match the userId");
      continue;
    }
    if (str(user.workspaceId) === HOUSE_WORKSPACE_ID || excluded(email)) {
      skip("HOUSE or excluded login");
      continue;
    }
    const { names } = await companyNamesFor(user, cache);
    if (sameAsCompany(v.name, names) || sameAsCompany(v.firstName, names)) {
      skip("proposal equals the company name");
      continue;
    }
    if (str(user.name) !== row.currentName || str(user.firstName) !== row.currentFirstName || str(user.lastName) !== row.currentLastName) {
      skip("changed since PROPOSE (name / firstName / lastName differ)");
      continue;
    }
    if (str(user.name) === v.name && str(user.firstName) === v.firstName && str(user.lastName) === v.lastName) {
      skip("already this name");
      continue;
    }
    plan.push({ row, user, to: { firstName: v.firstName, lastName: v.lastName, name: v.name } });
  }

  log(`[fix-company-named] db=${db} APPLY ${opts.apply ? "WRITE" : "DRY RUN"} rows=${opts.rows.length} planned=${plan.length} skipped=${skipped.length}`);
  for (const p of plan) log(`  ${p.row.email}  "${str(p.user.name)}" → "${p.to.name}"`);
  for (const s of skipped) log(`  SKIP ${s.email}  ${s.reason}`);

  if (!opts.apply) {
    log("[fix-company-named] dry run — nothing written (add --apply)");
    return { db, applied: false, planned: plan.length, written: 0, skipped };
  }

  // Backup FIRST: every user and roster row the plan touches, as it is now.
  const entries: BackupEntry[] = [];
  for (const p of plan) {
    const members = (await col("customermembers")
      .find({ email: new RegExp(`^${escapeRx(str(p.user.email))}$`, "i") })
      .project({ name: 1 })
      .toArray()) as any[];
    entries.push({
      userId: String(p.user._id),
      email: str(p.user.email).toLowerCase(),
      before: { name: slot(p.user, "name"), firstName: slot(p.user, "firstName"), lastName: slot(p.user, "lastName") },
      after: p.to,
      members: members.map((m) => ({ _id: String(m._id), name: slot(m, "name") })),
    });
  }
  const backupPath = opts.backupPath || `fix-company-named-users-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const backup: Backup = { db, createdAt: new Date().toISOString(), script: "fix-company-named-users", entries };
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  log(`[fix-company-named] backup written: ${backupPath} (${entries.length} users)`);

  let written = 0;
  for (const e of entries) {
    const guard = {
      _id: new mongoose.Types.ObjectId(e.userId),
      name: guardOf(e.before.name),
      firstName: guardOf(e.before.firstName),
      lastName: guardOf(e.before.lastName),
    };
    const res = await col("users").updateOne(guard, { $set: { ...e.after, updatedAt: new Date() } });
    if (res.modifiedCount !== 1) {
      skipped.push({ email: e.email, userId: e.userId, reason: "changed during APPLY — not written" });
      continue;
    }
    written++;
    for (const m of e.members) {
      await col("customermembers").updateOne(
        { _id: new mongoose.Types.ObjectId(m._id), name: guardOf(m.name) },
        { $set: { name: e.after.name, updatedAt: new Date() } },
      );
    }
    await UserNameAudit.create({
      userId: e.userId,
      email: e.email,
      from: { firstName: str(e.before.firstName.value), lastName: str(e.before.lastName.value), name: str(e.before.name.value) },
      to: e.after,
      via: "script",
      actorEmail: SCRIPT_ACTOR,
    });
  }
  log(`[fix-company-named] written=${written} of ${entries.length}`);
  return { db, applied: true, planned: plan.length, written, skipped, backupPath };
}

/* ── UNDO ────────────────────────────────────────────────────────────── */

const restoreOp = (s: Slot) => (s.present ? { set: s.value } : { unset: true });

export async function undoNameFixes(opts: {
  expectDb: string | undefined;
  backup: Backup;
  apply?: boolean;
  log?: (line: string) => void;
}): Promise<{ db: string; applied: boolean; planned: number; restored: number; skipped: Outcome[] }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = refuseWrongDb(opts.expectDb);
  if (opts.backup.db !== db) throw new Error(`REFUSING: backup is from db "${opts.backup.db}", connected db is "${db}".`);

  const skipped: Outcome[] = [];
  const plan: BackupEntry[] = [];
  for (const e of opts.backup.entries) {
    const u: any = await col("users").findOne({ _id: new mongoose.Types.ObjectId(e.userId) });
    if (!u) skipped.push({ email: e.email, userId: e.userId, reason: "user not found" });
    else if (u.name !== e.after.name || u.firstName !== e.after.firstName || u.lastName !== e.after.lastName) {
      skipped.push({ email: e.email, userId: e.userId, reason: "changed since APPLY — not restored" });
    } else plan.push(e);
  }

  log(`[fix-company-named] db=${db} UNDO ${opts.apply ? "WRITE" : "DRY RUN"} entries=${opts.backup.entries.length} planned=${plan.length} skipped=${skipped.length}`);
  for (const e of plan) log(`  ${e.email}  "${e.after.name}" → "${str(e.before.name.value)}"`);
  for (const s of skipped) log(`  SKIP ${s.email}  ${s.reason}`);
  if (!opts.apply) {
    log("[fix-company-named] dry run — nothing written (add --apply)");
    return { db, applied: false, planned: plan.length, restored: 0, skipped };
  }

  let restored = 0;
  for (const e of plan) {
    const $set: Record<string, any> = {};
    const $unset: Record<string, ""> = {};
    for (const k of ["name", "firstName", "lastName"] as const) {
      const op = restoreOp(e.before[k]);
      if ("set" in op) $set[k] = op.set;
      else $unset[k] = "";
    }
    const update: any = { $set: { ...$set, updatedAt: new Date() } };
    if (Object.keys($unset).length) update.$unset = $unset;
    const res = await col("users").updateOne(
      { _id: new mongoose.Types.ObjectId(e.userId), name: e.after.name, firstName: e.after.firstName, lastName: e.after.lastName },
      update,
    );
    if (res.modifiedCount !== 1) {
      skipped.push({ email: e.email, userId: e.userId, reason: "changed during UNDO — not restored" });
      continue;
    }
    restored++;
    for (const m of e.members) {
      const op = restoreOp(m.name);
      await col("customermembers").updateOne(
        { _id: new mongoose.Types.ObjectId(m._id), name: e.after.name },
        "set" in op ? { $set: { name: op.set } } : { $unset: { name: "" } },
      );
    }
    await UserNameAudit.create({
      userId: e.userId,
      email: e.email,
      from: e.after,
      to: { firstName: str(e.before.firstName.value), lastName: str(e.before.lastName.value), name: str(e.before.name.value) },
      via: "script",
      actorEmail: `${SCRIPT_ACTOR}:undo`,
    });
  }
  log(`[fix-company-named] restored=${restored} of ${plan.length}`);
  return { db, applied: true, planned: plan.length, restored, skipped };
}

/* ── CLI ─────────────────────────────────────────────────────────────── */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  try {
    const expectDb = arg("expect-db");
    const apply = process.argv.includes("--apply");
    const undo = arg("undo");
    const fromCsv = arg("from-csv");
    if (undo) {
      const backup = JSON.parse(fs.readFileSync(undo, "utf8")) as Backup;
      await undoNameFixes({ expectDb, backup, apply });
    } else if (fromCsv) {
      await applyNameFixes({ expectDb, rows: parseCsv(fs.readFileSync(fromCsv, "utf8")), apply, backupPath: arg("backup") });
    } else {
      if (apply) throw new Error("--apply needs --from-csv=<edited proposal> (or --undo=<backup>)");
      const { rows } = await proposeCompanyNamedUsers({ expectDb });
      const out = arg("out") || "company-named-users-proposal.csv";
      fs.writeFileSync(out, toCsv(rows));
      console.log(`[fix-company-named] wrote ${rows.length} rows to ${out} — review/edit, then run with --from-csv=${out}`);
    }
  } finally {
    await mongoose.connection.close();
  }
}

// Run only when executed directly — importing it (the test) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/fix-company-named-users.ts");

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
