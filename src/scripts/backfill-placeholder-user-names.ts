// apps/backend/src/scripts/backfill-placeholder-user-names.ts
//
// ══════════════════════════════════════════════════════════════════════
// Replace placeholder account names ("Workspace User" and the other known
// placeholders in services/actorNames.ts) with the person's real name.
//
// DRY RUN BY DEFAULT — reads and reports, writes nothing. --apply writes.
//
// WHERE THE NAME COMES FROM (services/actorNames.ts resolveRealName, the same
// rule the login session uses — minus the email fallback):
//   1. the account's own profile: a real firstName/lastName, else `name`
//   2. the traveller profile the user claimed (My Profile)
// A user with neither is SKIPPED and listed; their email is never used as a
// stored name.
//
// WHAT IS WRITTEN — only fields that hold a placeholder (or are empty when a
// sibling field is the placeholder): firstName, lastName (only if empty),
// name. A real value is never overwritten. Each update is conditional on the
// field still holding the value read, so a name changed meanwhile is left alone.
//
// REQUIRED
//   --expect-db=<name>   must equal the connected database, or nothing is read
// OPTIONAL
//   --apply              write (default: dry run)
//
// USAGE
//   npx tsx src/scripts/backfill-placeholder-user-names.ts --expect-db=Plumtrips_hrms
//   npx tsx src/scripts/backfill-placeholder-user-names.ts --expect-db=Plumtrips_hrms --apply
//   (MONGO_URI from the environment.)
//
// Emails are printed masked (***@domain). No passwords, ids of other records
// or traveller details are printed.
// ══════════════════════════════════════════════════════════════════════

import "dotenv/config";
import mongoose from "mongoose";
import { isPlaceholderName, resolveRealName } from "../services/actorNames.js";

export type Options = {
  expectDb: string | undefined;
  apply?: boolean;
  log?: (line: string) => void;
};

export type Change = { userId: string; email: string; from: string; to: string; source: string };
export type Report = {
  db: string;
  applied: boolean;
  candidates: number;
  changes: Change[];
  skipped: Array<{ userId: string; email: string; current: string }>;
  written: number;
};

const str = (v: any) => (v === null || v === undefined ? "" : String(v).trim());

export function maskEmail(email: string): string {
  const e = str(email).toLowerCase();
  const at = e.lastIndexOf("@");
  return at >= 0 ? `***@${e.slice(at + 1)}` : e ? "***" : "—";
}

/** Case-insensitive exact match on any placeholder (the set lives in actorNames.ts). */
const PLACEHOLDER_RX = /^\s*(workspace user|user|customer|traveller|traveler)\s*$/i;

export async function backfillPlaceholderUserNames(opts: Options): Promise<Report> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);

  const users = mongoose.connection.db!.collection("users");
  const rows: any[] = await users
    .find({ $or: [{ firstName: PLACEHOLDER_RX }, { name: PLACEHOLDER_RX }] })
    .project({ email: 1, firstName: 1, lastName: 1, name: 1 })
    .toArray();

  const report: Report = { db, applied: !!opts.apply, candidates: rows.length, changes: [], skipped: [], written: 0 };
  log(`[backfill-names] db=${db} mode=${opts.apply ? "APPLY" : "DRY RUN"} candidates=${rows.length}`);

  for (const u of rows) {
    const current = [str(u.firstName), str(u.lastName)].filter(Boolean).join(" ") || str(u.name);
    const r = await resolveRealName(u, { allowEmail: false });
    if (r.source === "none") {
      report.skipped.push({ userId: String(u._id), email: maskEmail(u.email), current });
      continue;
    }

    const set: Record<string, string> = {};
    const firstIsPlaceholder = isPlaceholderName(u.firstName);
    if (firstIsPlaceholder || (!str(u.firstName) && isPlaceholderName(u.name))) set.firstName = r.firstName;
    if ((firstIsPlaceholder || isPlaceholderName(u.name)) && !str(u.lastName) && r.lastName) set.lastName = r.lastName;
    if (isPlaceholderName(u.name) || (!str(u.name) && firstIsPlaceholder)) set.name = r.name;
    if (!Object.keys(set).length) continue;

    const to = [set.firstName ?? str(u.firstName), set.lastName ?? str(u.lastName)].filter(Boolean).join(" ") || set.name || "";
    report.changes.push({ userId: String(u._id), email: maskEmail(u.email), from: current, to, source: r.source });
    log(`  ${maskEmail(u.email)}  "${current}" → "${to}"  (${r.source})`);

    if (opts.apply) {
      // Only if every field still holds what was read (no overwrite of a name set meanwhile).
      const guard: Record<string, any> = { _id: u._id };
      for (const k of Object.keys(set)) guard[k] = u[k] === undefined ? { $exists: false } : u[k];
      const res = await users.updateOne(guard, { $set: { ...set, updatedAt: new Date() } });
      report.written += res.modifiedCount;
    }
  }

  if (report.skipped.length) {
    log(`[backfill-names] skipped (no real name on the profile or a claimed traveller profile): ${report.skipped.length}`);
    for (const s of report.skipped) log(`  ${s.email}  "${s.current}"`);
  }
  log(
    `[backfill-names] ${opts.apply ? `written=${report.written}` : "would change"} ${report.changes.length} of ${rows.length}; skipped ${report.skipped.length}` +
      (opts.apply ? "" : " — dry run, nothing written (add --apply)"),
  );
  return report;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  try {
    await backfillPlaceholderUserNames({ expectDb: arg("expect-db"), apply: process.argv.includes("--apply") });
  } finally {
    await mongoose.connection.close();
  }
}

// Run only when executed directly — importing it (the test) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/backfill-placeholder-user-names.ts");

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
