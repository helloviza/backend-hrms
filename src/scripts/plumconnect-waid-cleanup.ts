// apps/backend/src/scripts/plumconnect-waid-cleanup.ts
//
// PlumConnect Slice 1 — CONTINGENCY clean-up, run only when
// scripts/plumconnect-waid-unique-preflight.ts said INDEX-SAFE: no.
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §3, §8 P3, §9.
//
// Writes EXACTLY two categories, both by $unset (never null, never "" — a
// sparse index only skips a MISSING field, plan §9):
//   A. waId stored as "" or as explicit null  → $unset waId
//   B. waId held by a user who is NOT ACTIVE  → $unset waId
//      (canonical rule from utils/userActiveStatus.ts: an explicit INACTIVE,
//      case-insensitive; absent status = active. On Slice 2 flag-ON the
//      router will not route these users anyway — plan §9 risks.)
//
// Then it RE-COMPUTES duplicates among what is left (all ACTIVE by then).
// An ACTIVE cluster sharing one waId is NEVER auto-resolved: picking the
// owner is a human decision. The script prints every cluster and HALTS with
// VERDICT: HALTED so nobody mistakes it for done.
//
// Every row it changes is printed BEFORE the write, and the write targets
// exactly those _ids. Idempotent: a second run finds nothing in A or B.
//
// Imports NO model (autoIndex lesson from the preflight); raw driver
// collection; autoIndex/autoCreate pinned off. Always exits 0.
//   VERDICT: CLEAN | CLEANED | HALTED | FAILED
//
// --dry-run   prints what WOULD change and writes nothing.
//
// Usage:  pnpm -C apps/backend exec tsx src/scripts/plumconnect-waid-cleanup.ts [--dry-run]

import mongoose from "mongoose";
import { connectDb } from "../config/db.js";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const USERS_COLLECTION = "users";
const DRY_RUN = process.argv.includes("--dry-run");

const PROJECTION = { waId: 1, name: 1, firstName: 1, middleName: 1, lastName: 1, status: 1, email: 1, workspaceId: 1 };

// "set" = present, not null, not "" (A handles ""/null on its own).
const WAID_SET = {
  $and: [{ waId: { $exists: true } }, { waId: { $not: { $type: "null" } } }, { waId: { $ne: "" } }],
};
// The negation of activeUserFilter() ({ status: { $ne: "INACTIVE" } }),
// tolerant of case/whitespace exactly as normalizeUserStatus is.
const INACTIVE = { status: { $regex: /^\s*inactive\s*$/i } };

type Verdict = "CLEAN" | "CLEANED" | "HALTED" | "FAILED";

function nameOf(u: any): string {
  const full = [u?.firstName, u?.middleName, u?.lastName].filter(Boolean).join(" ").trim();
  return String(u?.name || full || "").trim() || "(no name)";
}

function line(u: any): string {
  return `    waId=${JSON.stringify(u?.waId)}  _id=${String(u?._id)}  name=${JSON.stringify(nameOf(u))}  status=${JSON.stringify(u?.status === undefined ? "(absent)" : u.status)}  email=${u?.email ?? ""}  ws=${u?.workspaceId ?? ""}`;
}

async function unsetWaId(users: any, label: string, filter: Record<string, unknown>): Promise<number> {
  const rows = await users.find(filter, { projection: PROJECTION }).toArray();
  console.log(`${label}: ${rows.length}`);
  for (const r of rows) console.log(line(r));
  if (rows.length === 0) return 0;

  if (DRY_RUN) {
    console.log(`    (dry-run) would $unset waId on ${rows.length} row(s)`);
    return 0;
  }
  // Write exactly the rows printed above — never the filter, which could
  // match something that appeared in between.
  const res = await users.updateMany({ _id: { $in: rows.map((r: any) => r._id) } }, { $unset: { waId: "" } });
  console.log(`    $unset waId on ${res.modifiedCount} row(s)`);
  return res.modifiedCount;
}

async function main(): Promise<Verdict> {
  await connectDb();
  const users = mongoose.connection.db!.collection(USERS_COLLECTION);

  console.log("");
  console.log(`PlumConnect Slice 1 — User.waId clean-up${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
  console.log(`db=${mongoose.connection.name}  collection=${users.collectionName}  at=${new Date().toISOString()}`);
  console.log("");

  // ── A. "" / null → $unset ───────────────────────────────────────────────
  const a = await unsetWaId(users, "A. waId stored as \"\" or explicit null", {
    $or: [{ waId: "" }, { waId: { $type: "null" } }],
  });
  console.log("");

  // ── B. NOT-ACTIVE holders → $unset ──────────────────────────────────────
  const b = await unsetWaId(users, "B. waId held by an INACTIVE user", { $and: [WAID_SET, INACTIVE] });
  console.log("");

  // ── C. ACTIVE duplicates → print + HALT (no write) ──────────────────────
  // Recomputed after A and B (an inactive duplicate holder resolves itself).
  // In dry-run, B's rows are still present, so exclude INACTIVE explicitly to
  // show what the clusters WOULD look like after the real run.
  const dupGroups = (await users
    .aggregate([
      { $match: { $and: [{ waId: { $type: "string", $ne: "" } }, { status: { $not: INACTIVE.status.$regex } }] } },
      { $group: { _id: "$waId", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ])
    .toArray()) as Array<{ _id: string; count: number; ids: mongoose.Types.ObjectId[] }>;

  console.log(`C. ACTIVE users sharing one waId (NOT auto-resolved): ${dupGroups.length} cluster(s)`);
  for (const g of dupGroups) {
    console.log(`  waId=${JSON.stringify(g._id)} held by ${g.count} ACTIVE users — pick ONE owner, $unset the rest by hand:`);
    const rows = await users.find({ _id: { $in: g.ids } }, { projection: PROJECTION }).toArray();
    for (const r of rows) console.log(line(r));
  }
  if (dupGroups.length === 0) console.log("    (none)");
  console.log("");

  if (dupGroups.length > 0) {
    console.log("HALTED: the unique index cannot be built until every cluster above has one owner.");
    console.log("Resolve by hand, e.g. in a shell:");
    console.log('  db.users.updateOne({ _id: ObjectId("<loser>") }, { $unset: { waId: "" } })   // NEVER $set: { waId: null }');
    console.log("then re-run scripts/plumconnect-waid-unique-preflight.ts.");
    return "HALTED";
  }
  return a + b > 0 ? "CLEANED" : "CLEAN";
}

let verdict: Verdict = "FAILED";
main()
  .then((v) => {
    verdict = v;
  })
  .catch((err) => {
    console.error("");
    console.error("Clean-up FAILED to complete:", err instanceof Error ? err.message : String(err));
  })
  .finally(async () => {
    console.log("");
    console.log("────────────────────────────────────────────────────────────");
    console.log(`VERDICT: ${verdict}${DRY_RUN ? "  (dry run)" : ""}`);
    console.log("────────────────────────────────────────────────────────────");
    console.log("");
    try {
      await mongoose.disconnect();
    } catch {
      // exiting anyway
    }
    process.exit(0);
  });
