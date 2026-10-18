// apps/backend/src/scripts/cstep-vendor-master-migrate.ts
//
// Deploy step for f62eedbe "Vendor Master — CSTEPVEN codes, editable types".
// Run it RIGHT AFTER the backend that carries f62eedbe is live, never before
// (see ORDERING).
//
// What changed in the model (models/cstep/CstepVendor.ts):
//   before: name unique per workspace — index workspaceId_1_name_1 {unique}
//   after:  vendorCode "CSTEPVEN0001" required, unique per workspace
//           (workspaceId_1_vendorCode_1 {unique}); name only indexed
//           (workspaceId_1_name_1, NOT unique); vendorTypeId required (a
//           CstepVendorType the workspace edits).
//
// Mongoose autoIndex will NOT fix the index on its own: workspaceId_1_name_1
// already exists with different options (unique), so autoIndex raises a
// conflict and KEEPS the unique one — a second vendor with the same trading
// name keeps failing with E11000. This script swaps it.
//
// INDEX-ONLY. The production census (2026-10-18) found 0 vendors, so there is
// nothing to backfill. A vendor without a vendorCode or vendorTypeId (one the
// old backend created before this deploy) makes the script REFUSE and list
// it: mapping the old fixed category onto an editable type is a decision, not
// something to do silently.
//
// Steps:
//   1. Build CstepVendorType's indexes (unique {workspaceId, name}).
//   2. Seed the starter vendor types in every cstepEnabled workspace exactly
//      as routes/cstep.vendors.ts ensureVendorTypes() does — same Counter
//      marker (cstep:<ws>:VENDOR_TYPES_SEEDED), so a workspace is seeded once
//      ever and the route never seeds it again.
//   3. Drop workspaceId_1_name_1 if it is unique; build CstepVendor's indexes
//      from the schema (non-unique name + unique vendorCode).
//
// --expect-db=<name> is required in EVERY mode, dry run included, and must
// be the connected database. The dry run only reads. The connection has
// autoIndex AND autoCreate off, so importing models (the vendors route pulls
// in several) never builds indexes or creates empty collections on the target
// as a side effect — the only index work is steps 1 and 3.
//
// Idempotent: the seed marker makes step 2 a no-op the second time; a name
// index that is already non-unique is left; createIndexes() is a no-op when
// the indexes match.
//
// ORDERING: after the backend deploy. Run before it and the OLD backend (still
// live, unique-name schema) can create vendors with no vendorCode — this
// script then refuses, and the unique vendorCode index could not build.
//
// ROLLBACK (only if the backend is rolled back too):
//   db.cstepvendors.dropIndex("workspaceId_1_vendorCode_1")
//   db.cstepvendors.dropIndex("workspaceId_1_name_1")
//   db.cstepvendors.createIndex({workspaceId:1,name:1},{unique:true,name:"workspaceId_1_name_1"})
//   — the last step fails if duplicate names were created after this ran.
//   Seeded vendor types are harmless to the old backend (it never reads them).
//
// Usage:
//   pnpm -C apps/backend tsx src/scripts/cstep-vendor-master-migrate.ts --expect-db=<db>
//   pnpm -C apps/backend tsx src/scripts/cstep-vendor-master-migrate.ts --expect-db=<db> --apply
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Counter from "../models/Counter.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CstepVendor from "../models/cstep/CstepVendor.js";
import CstepVendorType from "../models/cstep/CstepVendorType.js";
import { STARTER_VENDOR_TYPES } from "../routes/cstep.vendors.js";

const NAME_INDEX = "workspaceId_1_name_1";
const CODE_INDEX = "workspaceId_1_vendorCode_1";

const legacyFilter = {
  $or: [
    { vendorCode: { $exists: false } },
    { vendorCode: null },
    { vendorCode: "" },
    { vendorTypeId: { $exists: false } },
    { vendorTypeId: null },
  ],
};

const seedMarker = (ws: any) => `cstep:${String(ws)}:VENDOR_TYPES_SEEDED`;

export async function migrateVendorMaster(apply: boolean, log: (l: string) => void = console.log) {
  const db = mongoose.connection.db!;
  const has = async (name: string) => (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  const vendorColl = CstepVendor.collection.collectionName;
  const vendorsExist = await has(vendorColl);

  // Refuse on legacy vendors — never map them silently.
  if (vendorsExist) {
    const legacy: any[] = await CstepVendor.collection.find(legacyFilter).project({ workspaceId: 1, name: 1, category: 1 }).limit(20).toArray();
    if (legacy.length) {
      for (const v of legacy) log(`  legacy vendor ${String(v._id)} ws=${String(v.workspaceId)} "${v.name}" category=${v.category ?? "-"}`);
      throw new Error(`${legacy.length}${legacy.length === 20 ? "+" : ""} vendor(s) have no vendorCode/vendorTypeId — this script is index-only; decide their mapping first`);
    }
  }
  log(`${vendorColl}: ${vendorsExist ? `${await CstepVendor.collection.countDocuments({})} vendor(s), 0 legacy` : "(no collection yet)"}`);

  // 1. CstepVendorType indexes, before anything is seeded into it.
  if (apply) await CstepVendorType.createIndexes();

  // 2. Starter types for every cstepEnabled workspace, once ever per workspace.
  const workspaces: any[] = await CustomerWorkspace.find({ "config.features.cstepEnabled": true }).select("_id companyName name").lean();
  log(`cstepEnabled workspaces: ${workspaces.length}`);
  for (const w of workspaces) {
    const label = `${String(w._id)} ${w.companyName || w.name || ""}`.trim();
    const marked = await Counter.collection.countDocuments({ _id: seedMarker(w._id) } as any);
    const types = await CstepVendorType.collection.countDocuments({ workspaceId: w._id });
    if (marked) {
      log(`  ${label}: already seeded (${types} type(s)) — no change`);
      continue;
    }
    if (!apply) {
      log(`  ${label}: would seed ${STARTER_VENDOR_TYPES.length} starter types (${types} existing)`);
      continue;
    }
    const r = await Counter.updateOne({ _id: seedMarker(w._id) } as any, { $setOnInsert: { seq: 1 } }, { upsert: true });
    if (!r.upsertedCount) {
      log(`  ${label}: seeded concurrently by the app — no change`);
      continue;
    }
    await CstepVendorType.insertMany(
      STARTER_VENDOR_TYPES.map((name) => ({ workspaceId: w._id, name, isActive: true })),
      { ordered: false },
    ).catch((err: any) => {
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
    });
    log(`  ${label}: seeded — now ${await CstepVendorType.collection.countDocuments({ workspaceId: w._id })} type(s)`);
  }

  // 3. The vendor index swap.
  const indexes: any[] = vendorsExist ? await CstepVendor.collection.indexes() : [];
  const nameIx = indexes.find((i) => i.name === NAME_INDEX);
  log(`${NAME_INDEX}: ${nameIx ? (nameIx.unique ? "UNIQUE (to drop)" : "non-unique (ok)") : "absent"}`);
  log(`${CODE_INDEX}: ${indexes.some((i) => i.name === CODE_INDEX) ? "present" : "absent (to build)"}`);
  if (!apply) {
    log("\nDRY RUN — nothing written. Re-run with --apply.");
    return;
  }
  if (nameIx?.unique) {
    await CstepVendor.collection.dropIndex(NAME_INDEX);
    log(`dropped unique ${NAME_INDEX}`);
  }
  await CstepVendor.createIndexes();
  const after = (await CstepVendor.collection.indexes()).filter((i: any) => i.name !== "_id_").map((i: any) => `${i.name}${i.unique ? " (unique)" : ""}`);
  log(`indexes now: ${after.join(", ")}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const expectDb = argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1] || "";
  const { env } = await import("../config/env.js");
  // autoIndex + autoCreate off: importing models must never build indexes or
  // create collections on the target as a side effect (this script creates
  // exactly the indexes it names).
  await mongoose.connect(env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try {
    const db = mongoose.connection.db?.databaseName;
    if (!expectDb || db !== expectDb) throw new Error(`connected database is "${db}", --expect-db is "${expectDb}" — refusing to run`);
    console.log(`Connected to ${db} — ${apply ? "APPLY" : "DRY RUN"}`);
    await migrateVendorMaster(apply);
  } finally {
    await mongoose.connection.close();
  }
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Vendor master migration failed:", err?.message || err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
