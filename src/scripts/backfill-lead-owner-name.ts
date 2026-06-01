/**
 * backfill-lead-owner-name.ts
 *
 * Backfills Lead.assignedToName for leads that have an owner id (assignedTo) but
 * a blank/missing owner LABEL (assignedToName) — the gap that left the Leads
 * "Lead Owner" column showing "—" even though every lead already has an owner.
 *
 *   DRY RUN (default):  pnpm -C apps/backend tsx src/scripts/backfill-lead-owner-name.ts
 *   COMMIT (writes):    ... backfill-lead-owner-name.ts --commit
 *
 * DRY RUN performs ZERO writes — only find / countDocuments. It computes the
 * name each lead WOULD get and prints a report. Writing requires the explicit
 * --commit flag; without it the script refuses to mutate data.
 *
 * Keyed off assignedTo (NOT createdBy): assignedTo is the current owner and is
 * already present on every row; createdBy is only incidentally equal today and
 * could diverge after a reassignment.
 *
 * Name fallback chain (mirrors POST /leads → resolveUserName and the assign
 * route): name.trim() || "firstName lastName".trim() || email.
 *
 * Skip-and-flag, NEVER guess: a lead whose assignedTo does not resolve to a user
 * — or whose user yields a blank name — is SKIPPED and listed; the script never
 * writes an empty string. Idempotent: the filter only matches blank-name leads,
 * so re-running touches nothing already populated.
 *
 * Read path uses readPreference=secondary on dry-run; --commit reads/writes the
 * primary so the post-write verification is not served stale by replication lag.
 * Uses the raw driver collection (db.collection(...)) — bypassing the mongoose
 * workspaceScope plugin; leads have no workspaceId and CRM is HOUSE-only, so the
 * backfill is intentionally collection-wide.
 */
import "dotenv/config";
import mongoose from "mongoose";

const COMMIT = process.argv.includes("--commit");

// Leads with an owner id but a blank/missing owner label.
const NEEDS_NAME = {
  assignedTo: { $exists: true, $ne: null },
  $or: [{ assignedToName: { $exists: false } }, { assignedToName: "" }, { assignedToName: null }],
};

function resolveName(u: any): string {
  if (!u) return "";
  return (
    (u.name && String(u.name).trim()) ||
    `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
    (u.email ? String(u.email).trim() : "")
  );
}

async function main() {
  const uri = process.env.MONGO_URI!;
  await mongoose.connect(uri, { readPreference: COMMIT ? "primary" : "secondary" });
  const db = mongoose.connection.db!;
  const leads = db.collection("leads");
  const users = db.collection("users");

  const hostMatch = uri.match(/@([^/?]+)/);
  console.log("============================================================");
  console.log(`  BACKFILL Lead.assignedToName   [${COMMIT ? "COMMIT (WRITES)" : "DRY RUN — NO WRITES"}]`);
  console.log("============================================================");
  console.log(`  DB     : ${db.databaseName}`);
  console.log(`  Host   : ${hostMatch ? hostMatch[1] : "(unknown)"} (credentials redacted)`);
  console.log(`  Read   : readPreference=${COMMIT ? "primary" : "secondary"}`);

  const totalLeads = await leads.countDocuments({});
  const candidates = (await leads
    .find(NEEDS_NAME as any, { projection: { _id: 1, assignedTo: 1, leadCode: 1 } })
    .toArray()) as any[];

  console.log(`\n  total leads:                 ${totalLeads}`);
  console.log(`  blank-name leads (with owner): ${candidates.length}`);

  // Resolve the distinct owner ids in one query.
  const ownerIds = [...new Set(candidates.map((l) => String(l.assignedTo)))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const ownerDocs = (await users
    .find({ _id: { $in: ownerIds } }, { projection: { _id: 1, name: 1, firstName: 1, lastName: 1, email: 1, roles: 1 } })
    .toArray()) as any[];
  const nameById = new Map<string, string>();
  const docById = new Map<string, any>();
  for (const u of ownerDocs) {
    docById.set(String(u._id), u);
    nameById.set(String(u._id), resolveName(u));
  }

  // Partition into updatable vs skipped (owner missing, or resolves to blank).
  const updates: Array<{ _id: any; name: string }> = [];
  const skipped: Array<{ leadCode: string; assignedTo: string; reason: string }> = [];
  const perOwnerCount = new Map<string, number>();

  for (const l of candidates) {
    const oid = String(l.assignedTo);
    const doc = docById.get(oid);
    const name = nameById.get(oid) || "";
    if (!doc) {
      skipped.push({ leadCode: l.leadCode || String(l._id), assignedTo: oid, reason: "owner user not found" });
      continue;
    }
    if (!name) {
      skipped.push({ leadCode: l.leadCode || String(l._id), assignedTo: oid, reason: "owner user has blank name" });
      continue;
    }
    updates.push({ _id: l._id, name });
    perOwnerCount.set(oid, (perOwnerCount.get(oid) || 0) + 1);
  }

  // ── REPORT ──
  console.log(`\n── Would update ──`);
  console.log(`  leads to set assignedToName: ${updates.length}`);
  console.log(`  distinct owners:             ${perOwnerCount.size}`);
  for (const [oid, n] of perOwnerCount) {
    const u = docById.get(oid);
    console.log(`     ${resolveName(u).padEnd(24)} roles=${JSON.stringify(u?.roles)} leads=${n}`);
  }

  console.log(`\n── Skipped (NOT written — flagged) ── ${skipped.length}`);
  for (const s of skipped.slice(0, 50)) {
    console.log(`  [!] ${String(s.leadCode).padEnd(20)} assignedTo=${s.assignedTo} — ${s.reason}`);
  }
  if (skipped.length > 50) console.log(`  ... (${skipped.length - 50} more skipped)`);

  if (!COMMIT) {
    console.log("\n[DRY RUN — no writes performed. Re-run with --commit to apply.]");
    await mongoose.disconnect();
    return;
  }

  // ── COMMIT PATH (only with --commit) ── idempotent $set of assignedToName.
  if (updates.length === 0) {
    console.log("\n[COMMIT] nothing to update.");
    await mongoose.disconnect();
    return;
  }
  const ops = updates.map((u) => ({
    updateOne: { filter: { _id: u._id }, update: { $set: { assignedToName: u.name } } },
  }));
  const res: any = await leads.bulkWrite(ops, { ordered: false });
  console.log(`\n[COMMIT] ops attempted=${ops.length}  matched=${res.matchedCount}  modified=${res.modifiedCount}`);

  // ── POST-COMMIT VERIFICATION (read-only, primary) ──
  const stillBlank = await leads.countDocuments(NEEDS_NAME as any);
  console.log("\n── POST-COMMIT VERIFICATION ──");
  console.log(`  blank-name leads remaining (excl. skipped): ${stillBlank}  (expected = ${skipped.length})`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
