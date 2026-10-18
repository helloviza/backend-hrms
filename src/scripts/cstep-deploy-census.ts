// apps/backend/src/scripts/cstep-deploy-census.ts
//
// READ-ONLY census for the CSTEP deploy
// (merge/cstep-main-2026-10-13). Answers, from the target database, every
// question the deploy steps depend on — so nothing is decided on a guess:
//   - which workspaces have cstepEnabled (and their Finance/Approver/Official
//     mapping coverage)
//   - TravellerProfile workspaceId_1_travelerId_1: full vs partial, and how
//     many blank travelerIds exist (per workspace — >1 in one workspace means
//     a rollback to the full unique index would fail)
//   - cstepvendors: exists? legacy rows (no vendorCode / vendorTypeId), the
//     categories in use, and whether workspaceId_1_name_1 is still unique
//   - CSTEP counters (numbering) and Tally settings docs per workspace
//   - which CSTEP migrations already have a successful APPLY in migrationruns
//
// Reads only: find / countDocuments / aggregate / indexes / listCollections,
// through the raw driver. No model is imported (so nothing for Mongoose to
// index or create), the connection has autoIndex and autoCreate off, and it
// does NOT use the migration runner (which records a MigrationRun even on a
// dry run). Safe to run against production.
//
// Takes MONGO_URI from the environment only — no .env, no config/env.ts (whose
// required-var checks and secrets loading a read-only probe does not need).
// --expect-db must name the database MONGO_URI points at, or nothing is read.
//
// Usage:
//   MONGO_URI='<uri>' pnpm -C apps/backend tsx src/scripts/cstep-deploy-census.ts --expect-db=<db>
import mongoose from "mongoose";

async function main() {
  const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1] || "";
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db!;
  try {
    if (db.databaseName !== expectDb) throw new Error(`connected database is "${db.databaseName}", --expect-db is "${expectDb}"`);
    const has = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    const out = (k: string, v: any) => console.log(`${k.padEnd(34)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
    const idx = async (coll: string, name: string) =>
      has.has(coll) ? ((await db.collection(coll).indexes()) as any[]).find((i) => i.name === name) || null : "(no collection)";
    console.log(`DB ${db.databaseName} — READ ONLY\n`);

    const wss: any[] = await db.collection("customerworkspaces")
      .find({ "config.features.cstepEnabled": true }).project({ companyName: 1, name: 1 }).toArray();
    out("cstepEnabled workspaces", wss.length);
    for (const w of wss) {
      const tp = db.collection("travellerprofiles");
      const n = await tp.countDocuments({ workspaceId: w._id });
      const mapped = async (f: string) => tp.countDocuments({ workspaceId: w._id, [f]: { $type: "objectId" } });
      out(`  ${String(w._id)} ${w.companyName || w.name || ""}`.slice(0, 34), {
        travellers: n,
        finance: await mapped("financeUserId"),
        approver: await mapped("tourApproverId"),
        official: await mapped("officialUserId"),
        blankIds: await tp.countDocuments({ workspaceId: w._id, $or: [{ travelerId: "" }, { travelerId: null }, { travelerId: { $exists: false } }] }),
        counters: (await db.collection("counters").find({ _id: { $regex: `^cstep:${String(w._id)}:` } as any }).toArray()).map((c: any) => `${String(c._id).split(":").slice(2).join(":")}=${c.seq}`),
        tallySettings: has.has("csteptallysettings") ? await db.collection("csteptallysettings").countDocuments({ workspaceId: w._id }) : 0,
      });
    }

    console.log("");
    const tIx: any = await idx("travellerprofiles", "workspaceId_1_travelerId_1");
    out("travelerId index", tIx && typeof tIx === "object" ? { unique: !!tIx.unique, partial: tIx.partialFilterExpression || null } : tIx);
    const blanksPerWs = has.has("travellerprofiles")
      ? await db.collection("travellerprofiles").aggregate([
          { $match: { $or: [{ travelerId: "" }, { travelerId: null }, { travelerId: { $exists: false } }] } },
          { $group: { _id: "$workspaceId", n: { $sum: 1 } } },
          { $match: { n: { $gt: 1 } } },
        ]).toArray()
      : [];
    out("workspaces with >1 blank travelerId", blanksPerWs.length);

    console.log("");
    if (!has.has("cstepvendors")) out("cstepvendors", "(no collection — the new backend creates it with the new indexes; vendor script is a no-op)");
    else {
      const v = db.collection("cstepvendors");
      const legacy = { $or: [{ vendorCode: { $exists: false } }, { vendorCode: null }, { vendorCode: "" }, { vendorTypeId: { $exists: false } }, { vendorTypeId: null }] };
      out("cstepvendors total / legacy", `${await v.countDocuments({})} / ${await v.countDocuments(legacy)}`);
      out("legacy categories", await v.aggregate([{ $match: legacy }, { $group: { _id: "$category", n: { $sum: 1 } } }]).toArray());
      const nIx: any = await idx("cstepvendors", "workspaceId_1_name_1");
      out("workspaceId_1_name_1", nIx ? { unique: !!nIx.unique } : "absent");
      out("workspaceId_1_vendorCode_1", (await idx("cstepvendors", "workspaceId_1_vendorCode_1")) ? "present" : "absent");
    }

    console.log("");
    if (has.has("migrationruns")) {
      const runs = await db.collection("migrationruns").aggregate([
        { $match: { migrationName: { $regex: "cstep|traveller-id|traveler", $options: "i" }, mode: "APPLY", outcome: "SUCCESS" } },
        { $group: { _id: "$migrationName", last: { $max: "$completedAt" } } },
        { $sort: { _id: 1 } },
      ]).toArray();
      out("successful CSTEP-related APPLY runs", runs.length ? runs.map((r: any) => `${r._id} @ ${r.last?.toISOString?.() || r.last}`) : "none");
    } else out("migrationruns", "(no collection)");
  } finally {
    await mongoose.connection.close();
  }
}

main().catch(async (err) => {
  console.error("Census failed:", err?.message || err);
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});
