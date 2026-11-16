// apps/backend/src/scripts/crm-clear-closed-lead-followups.ts
//
// ONE-TIME cleanup for fix/crm-closed-lead-followups. Before that fix,
// applyDisposition left nextFollowUpDate / followUpNotes on a lead that went
// Won or Lost, so closed leads kept reading as due / overdue. The fix clears
// them on every new Won / Lost disposition; this script clears the rows
// written before it.
//
// Targets leads that are DEFINITELY closed and still carry a follow-up date
// — every one is also closed under the shared rule (crmTaxonomy
// OPEN_LEAD_MATCH):
//   • disposition status Won / Lost; or
//   • never dispositioned (dispositionStatus absent / "") AND legacy stage
//     won / lost, lead status LOST, or won / onboarded (wonDate).
// NEVER touched (counted in the dry run only): never-dispositioned legacy
// leads on proposal_sent / negotiation with status CONVERTED (stored or
// derived — i.e. absent). They are OPEN under the shared rule; the guard
// below keeps them out even if one carries a stray wonDate.
//
// Writes: $unset nextFollowUpDate, followUpNotes ← "". Nothing else — no
// activity row, no stage / status / disposition change, tasks untouched.
//
// DRY RUN by default: prints the target host/db, counts by bucket and a
// sample. --apply (needs --expect-db=<connected db name>) first writes a JSON
// backup of every affected row's _id / leadCode / nextFollowUpDate /
// followUpNotes (--backup=<file>, default ./closed-lead-followups-backup-
// <db>-<timestamp>.json), then updates with the same filter, so a second
// run reports "Nothing to change".
//
//   npx tsx src/scripts/crm-clear-closed-lead-followups.ts
//   npx tsx src/scripts/crm-clear-closed-lead-followups.ts --expect-db=<db> --apply
import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import { OPEN_LEAD_MATCH } from "../models/crmTaxonomy.js";

const HAS_FOLLOW_UP = { nextFollowUpDate: { $ne: null } };
const NO_DISPOSITION = { dispositionStatus: { $in: [null, ""] } };

/** Legacy leads parked on a late stage, status CONVERTED (stored or absent). Never written. */
export const LEGACY_LATE_GUARD = {
  ...NO_DISPOSITION,
  stage: { $in: ["proposal_sent", "negotiation"] },
  status: { $in: [null, "", "CONVERTED"] },
};

/** Definitely-closed leads that still carry a follow-up date. */
export const CLOSED_WITH_FOLLOW_UP = {
  $and: [
    HAS_FOLLOW_UP,
    {
      $or: [
        { dispositionStatus: { $in: ["Won", "Lost"] } },
        { ...NO_DISPOSITION, $or: [{ stage: { $in: ["won", "lost"] } }, { status: "LOST" }, { wonDate: { $ne: null } }] },
      ],
    },
    { $nor: [OPEN_LEAD_MATCH] }, // closed under the shared rule — belt and braces
    { $nor: [LEGACY_LATE_GUARD] },
  ],
};

/** Reported, never written. */
export const LEGACY_LATE_WITH_FOLLOW_UP = { $and: [HAS_FOLLOW_UP, LEGACY_LATE_GUARD] };

export interface CleanupPlan {
  total: number;
  byBucket: Array<{ dispositionStatus: string; stage: string; status: string; count: number }>;
  sample: Array<{ leadCode: string; dispositionStatus: string; subDisposition: string; stage: string; nextFollowUpDate: Date | null }>;
  legacyLateUntouched: number;
}

export async function planCleanup(): Promise<CleanupPlan> {
  const [total, buckets, sample, legacyLateUntouched] = await Promise.all([
    Lead.countDocuments(CLOSED_WITH_FOLLOW_UP),
    Lead.aggregate([
      { $match: CLOSED_WITH_FOLLOW_UP },
      { $group: { _id: { d: { $ifNull: ["$dispositionStatus", ""] }, s: "$stage", st: { $ifNull: ["$status", ""] } }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Lead.find(CLOSED_WITH_FOLLOW_UP).select("leadCode dispositionStatus subDisposition stage nextFollowUpDate").sort({ nextFollowUpDate: 1 }).limit(15).lean(),
    Lead.countDocuments(LEGACY_LATE_WITH_FOLLOW_UP),
  ]);
  return {
    total,
    byBucket: (buckets as any[]).map((b) => ({ dispositionStatus: b._id.d, stage: b._id.s, status: b._id.st, count: b.count })),
    sample: (sample as any[]).map((l) => ({
      leadCode: l.leadCode,
      dispositionStatus: l.dispositionStatus || "",
      subDisposition: l.subDisposition || "",
      stage: l.stage,
      nextFollowUpDate: l.nextFollowUpDate ?? null,
    })),
    legacyLateUntouched,
  };
}

export async function applyCleanup(backupPath: string): Promise<{ backedUp: number; modified: number }> {
  const rows = await Lead.find(CLOSED_WITH_FOLLOW_UP).select("_id leadCode nextFollowUpDate followUpNotes").lean();
  writeFileSync(
    backupPath,
    JSON.stringify(rows.map((r: any) => ({ _id: String(r._id), leadCode: r.leadCode, nextFollowUpDate: r.nextFollowUpDate, followUpNotes: r.followUpNotes ?? "" })), null, 2) + "\n",
  );
  // Same filter as the backup — a row reopened in between is left alone.
  const res = await Lead.updateMany(
    { $and: [CLOSED_WITH_FOLLOW_UP, { _id: { $in: rows.map((r: any) => r._id) } }] },
    { $unset: { nextFollowUpDate: "" }, $set: { followUpNotes: "" } },
  );
  return { backedUp: rows.length, modified: res.modifiedCount };
}

function argValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const expectDb = argValue(args, "--expect-db");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  const shown = uri.replace(/\/\/[^@/]*@/, "//***@").replace(/\?.*$/, "");
  console.log(`target ${shown}`);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.name;
  console.log(`db ${db} · ${apply ? "APPLY" : "DRY RUN"}`);
  // Checked before the plan, so a mistyped target never gets that far.
  if (apply && !expectDb) throw new Error(`REFUSING: --expect-db=<name> is required with --apply (connected db: "${db}").`);
  if (apply && expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const plan = await planCleanup();
  console.log(`\nClosed leads still carrying a follow-up date: ${plan.total}`);
  for (const b of plan.byBucket) {
    console.log(`  ${String(b.count).padStart(5)}  dispositionStatus=${b.dispositionStatus || "(none)"} stage=${b.stage} status=${b.status || "(none)"}`);
  }
  if (plan.sample.length) {
    console.log(`\nSample (oldest follow-up first, up to 15):`);
    for (const s of plan.sample) {
      console.log(`  ${s.leadCode}  ${s.dispositionStatus || "(legacy)"}${s.subDisposition ? ` / ${s.subDisposition}` : ""}  stage=${s.stage}  nextFollowUpDate=${s.nextFollowUpDate ? new Date(s.nextFollowUpDate).toISOString() : "-"}`);
    }
  }
  console.log(`\nNever touched — legacy proposal_sent / negotiation leads (status CONVERTED) with a follow-up date: ${plan.legacyLateUntouched}`);

  if (!plan.total) {
    console.log("\nNothing to change.");
    return;
  }
  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --expect-db=<db> --apply to write.");
    return;
  }
  const backup = path.resolve(argValue(args, "--backup") || `closed-lead-followups-backup-${db}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const r = await applyCleanup(backup);
  console.log(`\nBackup: ${r.backedUp} row(s) → ${backup}`);
  console.log(`Cleared nextFollowUpDate / followUpNotes on ${r.modified} lead(s).`);
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
