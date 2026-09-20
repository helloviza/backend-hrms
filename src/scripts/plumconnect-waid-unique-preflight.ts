// apps/backend/src/scripts/plumconnect-waid-unique-preflight.ts
//
// PlumConnect Slice 1 preflight (plan §8 P3) — READ-ONLY.
//
// Slice 1 turns the User.waId index from { index, sparse } into
// { unique, sparse } and makes the identity resolver the single writer of
// that field. Before either lands, this script reports everything on the
// live `users` collection that would break the unique index or that the
// resolver's assumptions would silently mishandle:
//
//   1. DUPLICATE   — one waId held by more than one User. A unique index
//                    build fails outright on these.
//   2. EMPTY/NULL  — waId stored as "" or as an explicit null (NOT merely
//                    absent). A SPARSE index only skips documents where the
//                    field is missing; "" and null are present values, so
//                    two such rows collide under a unique index. This is why
//                    the unbind invariant is "$unset, not null" (plan §9).
//   3. NON-CANONICAL — waId set but not /^[0-9]{8,15}$/ (utils/phone.ts
//                    canonical: E.164 digits, no "+"). The resolver matches
//                    inbound `from` against this field verbatim; anything
//                    else will never match and may need re-normalising.
//   4. INACTIVE HOLDERS — non-empty waId on a User whose canonical status is
//                    INACTIVE (utils/userActiveStatus.ts: explicit INACTIVE,
//                    case-insensitive; absent = active). Today the expense
//                    chain still accepts them (worker resolves by waId alone);
//                    on Slice 2 flag-ON the router will not. Gathered now as
//                    Slice 2's rollout preflight too (plan §9 risks).
//   5. TOTAL       — how many Users carry a waId at all (only set-waid.ts
//                    has ever written it, so this should be small).
//
// Reads go straight at the raw driver collection ("users"), not through the
// Mongoose model, for two reasons:
//   • the model's waId / status setters would normalise away the very values
//     this script exists to find;
//   • importing models/User.js at all would let Mongoose autoIndex run
//     createIndex() for every index the schema declares on connect. On a
//     collection that already has them that is a no-op — but once Slice 1
//     changes the waId index in the schema, an autoIndex from THIS script
//     would try to build the unique index it exists to gate. So no model is
//     imported, and autoIndex/autoCreate are pinned off as a second guard.
//
// ZERO writes: aggregate() / find() / countDocuments() only. No updateOne,
// updateMany, insert*, delete*, save, bulkWrite, findOneAndUpdate, or index
// operations anywhere in this file. Safe to run against prod.
//
// Always exits 0. The GO / NO-GO is the printed verdict, not the exit code.
//
// Usage:  pnpm -C apps/backend exec tsx src/scripts/plumconnect-waid-unique-preflight.ts

import mongoose from "mongoose";
import { connectDb } from "../config/db.js";

// Second guard against implicit index/collection creation (see header).
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const USERS_COLLECTION = "users"; // models/User.ts → mongoose.model("User") → "users"

const CANONICAL_WAID = /^[0-9]{8,15}$/;

type Row = {
  waId: unknown;
  _id: string;
  name: string;
  status: unknown;
  email: string;
  workspaceId: string;
};

function nameOf(u: any): string {
  const full = [u?.firstName, u?.middleName, u?.lastName].filter(Boolean).join(" ").trim();
  return String(u?.name || full || "").trim() || "(no name)";
}

function toRow(u: any): Row {
  return {
    waId: u?.waId,
    _id: String(u?._id ?? ""),
    name: nameOf(u),
    status: u?.status === undefined ? "(absent)" : u.status,
    email: String(u?.email ?? ""),
    workspaceId: String(u?.workspaceId ?? ""),
  };
}

function printRows(rows: Row[]): void {
  if (rows.length === 0) {
    console.log("    (none)");
    return;
  }
  for (const r of rows) {
    console.log(
      `    waId=${JSON.stringify(r.waId)}  _id=${r._id}  name=${JSON.stringify(r.name)}  status=${JSON.stringify(r.status)}  email=${r.email}  ws=${r.workspaceId}`,
    );
  }
}

const PROJECTION = { waId: 1, name: 1, firstName: 1, middleName: 1, lastName: 1, status: 1, email: 1, workspaceId: 1 };

// A waId that is "set" for the purposes of this report: present, not null,
// not the empty string. (#2 handles "" and null on their own.)
const WAID_SET = {
  $and: [{ waId: { $exists: true } }, { waId: { $not: { $type: "null" } } }, { waId: { $ne: "" } }],
};

async function main() {
  await connectDb();
  // Raw driver collection — no schema, no setters, no autoIndex.
  const users = mongoose.connection.db!.collection(USERS_COLLECTION);

  console.log("");
  console.log("PlumConnect Slice 1 preflight — User.waId (READ-ONLY)");
  console.log(`db=${mongoose.connection.name}  collection=${users.collectionName}  at=${new Date().toISOString()}`);
  console.log("");

  // ── 5. TOTAL (printed first as the denominator) ───────────────────────────
  const totalSet = await users.countDocuments(WAID_SET);
  const totalUsers = await users.countDocuments({});

  // ── 1. DUPLICATE waId ────────────────────────────────────────────────────
  const dupGroups = (await users
    .aggregate([
      { $match: { waId: { $type: "string", $ne: "" } } },
      { $group: { _id: "$waId", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ])
    .toArray()) as Array<{ _id: string; count: number; ids: mongoose.Types.ObjectId[] }>;

  const dupRowsByWaId = new Map<string, Row[]>();
  for (const g of dupGroups) {
    const docs = await users.find({ _id: { $in: g.ids } }, { projection: PROJECTION }).toArray();
    dupRowsByWaId.set(g._id, docs.map(toRow));
  }

  // ── 2. STORED EMPTY / NULL waId ──────────────────────────────────────────
  // `{ waId: null }` would ALSO match documents where the field is missing —
  // those are fine under a sparse index. $type:"null" is the explicit null.
  const emptyDocs = await users.find({ waId: "" }, { projection: PROJECTION }).toArray();
  const nullDocs = await users.find({ waId: { $type: "null" } }, { projection: PROJECTION }).toArray();

  // ── 3. NON-CANONICAL waId ────────────────────────────────────────────────
  // Set (per WAID_SET) but not the canonical shape. Non-string types (a number,
  // an array) fail the regex too and are reported here.
  const nonCanonicalDocs = await users
    .find({ $and: [WAID_SET, { waId: { $not: CANONICAL_WAID } }] }, { projection: PROJECTION })
    .toArray();

  // ── 4. INACTIVE HOLDERS ──────────────────────────────────────────────────
  // Canonical inactive = explicit INACTIVE, case-insensitive, whitespace-
  // tolerant (mirrors normalizeUserStatus). Absent status = active.
  const inactiveHolders = await users
    .find({ $and: [WAID_SET, { status: { $regex: /^\s*inactive\s*$/i } }] }, { projection: PROJECTION })
    .toArray();
  // Informational: a holder whose status is something OTHER than ACTIVE /
  // INACTIVE / absent. Canonically these count as active, but a stray value
  // is worth seeing before an index+resolver change.
  const oddStatusHolders = await users
    .find(
      {
        $and: [
          WAID_SET,
          { status: { $exists: true } },
          { status: { $not: { $regex: /^\s*(active|inactive)\s*$/i } } },
        ],
      },
      { projection: PROJECTION },
    )
    .toArray();

  // ── Report ───────────────────────────────────────────────────────────────
  console.log(`5. TOTAL users with a waId set: ${totalSet}  (of ${totalUsers} users)`);
  console.log("");

  console.log(`1. DUPLICATE waId values: ${dupGroups.length}  (rows involved: ${dupGroups.reduce((n, g) => n + g.count, 0)})`);
  if (dupGroups.length === 0) console.log("    (none)");
  for (const g of dupGroups) {
    console.log(`  waId=${JSON.stringify(g._id)} held by ${g.count} users:`);
    printRows(dupRowsByWaId.get(g._id) ?? []);
  }
  console.log("");

  console.log(`2. STORED EMPTY/NULL waId: ${emptyDocs.length + nullDocs.length}  (empty-string: ${emptyDocs.length}, explicit null: ${nullDocs.length})`);
  printRows([...emptyDocs, ...nullDocs].map(toRow));
  console.log("");

  console.log(`3. NON-CANONICAL waId (set, but not /^[0-9]{8,15}$/): ${nonCanonicalDocs.length}`);
  printRows(nonCanonicalDocs.map(toRow));
  console.log("");

  console.log(`4. INACTIVE HOLDERS (waId set, status INACTIVE): ${inactiveHolders.length}`);
  printRows(inactiveHolders.map(toRow));
  if (oddStatusHolders.length > 0) {
    console.log(`   info — holders with a status that is neither ACTIVE nor INACTIVE (treated as active by the app): ${oddStatusHolders.length}`);
    printRows(oddStatusHolders.map(toRow));
  }
  console.log("");

  // ── Verdict ──────────────────────────────────────────────────────────────
  const indexSafe = dupGroups.length === 0 && emptyDocs.length === 0 && nullDocs.length === 0;

  console.log("────────────────────────────────────────────────────────────");
  console.log(`INDEX-SAFE: ${indexSafe ? "yes" : "no"}   (yes iff #1 == 0 AND #2 == 0)`);
  if (!indexSafe) {
    console.log("Must be cleaned BEFORE the unique+sparse index ships (this script cleans nothing):");
    for (const g of dupGroups) {
      console.log(
        `  - duplicate waId ${JSON.stringify(g._id)}: keep ONE of [${g.ids.map(String).join(", ")}], $unset waId on the rest`,
      );
    }
    for (const d of emptyDocs) {
      console.log(`  - empty-string waId on _id=${String(d._id)} (${nameOf(d)}): $unset waId (never set to null)`);
    }
    for (const d of nullDocs) {
      console.log(`  - explicit-null waId on _id=${String(d._id)} (${nameOf(d)}): $unset waId`);
    }
  }
  if (nonCanonicalDocs.length > 0) {
    console.log(`Advisory: ${nonCanonicalDocs.length} non-canonical waId(s) will not match inbound senders until re-normalised (not an index blocker).`);
  }
  if (inactiveHolders.length > 0) {
    console.log(`Advisory (Slice 2 rollout): ${inactiveHolders.length} INACTIVE user(s) hold a waId — decide unbind-or-accept before PLUMCONNECT_ENABLED=true.`);
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log("");
}

main()
  .catch((err) => {
    // A failed run must not read as GO: say so in the same verdict shape.
    console.error("");
    console.error("Preflight FAILED to complete:", err instanceof Error ? err.message : String(err));
    console.error("INDEX-SAFE: unknown   (script error — re-run before deciding)");
    console.error("");
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      // nothing to do — we are exiting anyway
    }
    process.exit(0);
  });
