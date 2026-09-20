// apps/backend/src/scripts/plumconnect-waid-unique-index.ts
//
// PlumConnect Slice 1 — build the User.waId UNIQUE index, explicitly and
// gated. docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §3, §8 P3, §9.
//
// WHY A SCRIPT AND NOT THE SCHEMA
//   The User schema keeps waId as { index: true, sparse: true } — deliberately
//   NOT unique — so no autoIndex path can build a unique index on boot behind
//   the preflight's back (prod autoIndex is ON, unconditionally; see the prep
//   report). This script is the only thing that builds it, and it refuses to
//   unless the collection is clean.
//
// WHY A SEPARATE INDEX NAME
//   The schema's index already exists in prod as `waId_1` (sparse, not
//   unique). Rebuilding `waId_1` itself as unique would make every subsequent
//   boot's autoIndex reject with IndexKeySpecsConflict (code 86) — a permanent
//   boot error. MongoDB permits a second index on the same key pattern under
//   a different name with different options, and Mongoose never drops an
//   index it did not declare. So the unique index is built as `waId_1_unique`
//   ALONGSIDE `waId_1`: additive, boot-clean (verified on mongodb-memory-server
//   8.x), and reversible with a single dropIndex("waId_1_unique").
//
// WHAT IT DOES
//   1. GUARD (read-only): the preflight's two blocking checks — any waId held
//      by >1 user, any waId stored as "" or explicit null. Either present →
//      print exactly what blocks and EXIT WITHOUT BUILDING.
//   2. If an index named waId_1_unique already exists with the right spec →
//      ALREADY-EXISTS, print it, exit.
//   3. Otherwise createIndex({ waId: 1 }, { unique: true, sparse: true,
//      name: "waId_1_unique" }) and print the resulting spec → BUILT.
//      If the server rejects the same-key/different-name combination (code
//      85/86 on an older server) → REFUSED-CONFLICT with the reason; nothing
//      is dropped, nothing is retried.
//
// Imports NO model (the preflight's lesson: a model import lets autoIndex
// createIndex on connect). Raw driver collection only; autoIndex/autoCreate
// pinned off. Always exits 0 — the verdict is the printed line:
//   VERDICT: BUILT | ALREADY-EXISTS | REFUSED (dirty) | REFUSED-CONFLICT | FAILED
//
// Run AFTER scripts/plumconnect-waid-unique-preflight.ts says INDEX-SAFE: yes
// (this script re-checks anyway) and, if it said no, AFTER
// scripts/plumconnect-waid-cleanup.ts and a human resolution of any active
// duplicate cluster.
//
// Usage:  pnpm -C apps/backend exec tsx src/scripts/plumconnect-waid-unique-index.ts

import mongoose from "mongoose";
import { connectDb } from "../config/db.js";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const USERS_COLLECTION = "users";
const INDEX_NAME = "waId_1_unique";
const INDEX_KEY = { waId: 1 } as const;
const INDEX_OPTIONS = { unique: true, sparse: true, name: INDEX_NAME } as const;

type Verdict = "BUILT" | "ALREADY-EXISTS" | "REFUSED" | "REFUSED-CONFLICT" | "FAILED";

function fmtIndex(i: any): string {
  return `${i.name}  key=${JSON.stringify(i.key)}  unique=${Boolean(i.unique)}  sparse=${Boolean(i.sparse)}`;
}

async function main(): Promise<Verdict> {
  await connectDb();
  const users = mongoose.connection.db!.collection(USERS_COLLECTION);

  console.log("");
  console.log("PlumConnect Slice 1 — User.waId unique index");
  console.log(`db=${mongoose.connection.name}  collection=${users.collectionName}  at=${new Date().toISOString()}`);
  console.log("");

  // ── 1. GUARD — read-only, mirrors the preflight's #1 and #2 ──────────────
  const dupGroups = (await users
    .aggregate([
      { $match: { waId: { $type: "string", $ne: "" } } },
      { $group: { _id: "$waId", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ])
    .toArray()) as Array<{ _id: string; count: number; ids: mongoose.Types.ObjectId[] }>;
  const emptyIds = (await users.find({ waId: "" }, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id));
  const nullIds = (await users.find({ waId: { $type: "null" } }, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id));

  console.log(`guard #1 duplicate waId values: ${dupGroups.length}`);
  console.log(`guard #2 stored ""/null waId:    ${emptyIds.length + nullIds.length}  (empty: ${emptyIds.length}, null: ${nullIds.length})`);
  console.log("");

  if (dupGroups.length > 0 || emptyIds.length > 0 || nullIds.length > 0) {
    console.log("Collection is NOT index-safe. Nothing was built. Blocking rows:");
    for (const g of dupGroups) {
      console.log(`  - duplicate waId ${JSON.stringify(g._id)} on ${g.count} users: [${g.ids.map(String).join(", ")}]`);
    }
    for (const id of emptyIds) console.log(`  - empty-string waId on _id=${id}`);
    for (const id of nullIds) console.log(`  - explicit-null waId on _id=${id}`);
    console.log('Run scripts/plumconnect-waid-cleanup.ts (""/null and INACTIVE holders), resolve any ACTIVE duplicate cluster by hand, then re-run.');
    return "REFUSED";
  }

  // ── 2. Already built? ────────────────────────────────────────────────────
  const existing = await users.indexes();
  const waIdIndexes = existing.filter((i: any) => i.key && Object.keys(i.key).length === 1 && i.key.waId === 1);
  console.log("existing waId indexes:");
  for (const i of waIdIndexes) console.log(`  ${fmtIndex(i)}`);
  if (waIdIndexes.length === 0) console.log("  (none)");
  console.log("");

  const ours = waIdIndexes.find((i: any) => i.name === INDEX_NAME);
  if (ours) {
    if (ours.unique && ours.sparse) {
      console.log(`Index ${INDEX_NAME} already exists with the required spec. Nothing to do.`);
      console.log(`  ${fmtIndex(ours)}`);
      return "ALREADY-EXISTS";
    }
    console.log(`Index ${INDEX_NAME} exists but with the WRONG spec (unique=${Boolean(ours.unique)}, sparse=${Boolean(ours.sparse)}).`);
    console.log("Not touching it — drop it by hand if it was created outside this script, then re-run.");
    return "REFUSED-CONFLICT";
  }

  // ── 3. Build ─────────────────────────────────────────────────────────────
  // The ONLY write in this file.
  try {
    const name = await users.createIndex(INDEX_KEY, INDEX_OPTIONS);
    const built = (await users.indexes()).find((i: any) => i.name === name);
    console.log(`Built ${name}.`);
    console.log(`  ${fmtIndex(built)}`);
    return "BUILT";
  } catch (err: any) {
    const code = err?.code;
    if (code === 85 || code === 86) {
      // IndexOptionsConflict / IndexKeySpecsConflict — this server does not
      // accept a same-key index under a different name. That path needs a
      // drop of the schema index plus a schema change, which is a human
      // decision, not something this script does.
      console.log(`Server refused the additional index (code ${code} ${err?.codeName || ""}): ${err?.message}`);
      console.log("Nothing was dropped. Decide the drop+schema path explicitly before re-running.");
      return "REFUSED-CONFLICT";
    }
    if (code === 11000) {
      // Should be impossible after the guard, but a concurrent write could
      // create a duplicate between the check and the build.
      console.log(`Build failed on a duplicate that appeared after the guard: ${err?.message}`);
      console.log("Re-run the preflight, then this script.");
      return "REFUSED";
    }
    throw err;
  }
}

let verdict: Verdict = "FAILED";
main()
  .then((v) => {
    verdict = v;
  })
  .catch((err) => {
    console.error("");
    console.error("Index script FAILED to complete:", err instanceof Error ? err.message : String(err));
  })
  .finally(async () => {
    console.log("");
    console.log("────────────────────────────────────────────────────────────");
    console.log(`VERDICT: ${verdict}`);
    console.log("────────────────────────────────────────────────────────────");
    console.log("");
    try {
      await mongoose.disconnect();
    } catch {
      // exiting anyway
    }
    process.exit(0);
  });
