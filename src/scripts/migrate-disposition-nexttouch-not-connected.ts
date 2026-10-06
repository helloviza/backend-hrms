// apps/backend/src/scripts/migrate-disposition-nexttouch-not-connected.ts
//
// One-time: "Not Connected → Switched off" and "Not Connected → Ringing Only"
// now imply a next touch (a reachable number that didn't answer → schedule the
// callback), so a rep must capture a next follow-up date on them.
//
// The seed in models/crmDisposition.ts carries nextTouch: true for both, but
// the set lives as DATA on the CrmPipeline row and ensureDefaultPipeline() only
// seeds when no pipeline exists — so an existing "corporate_calling" pipeline
// keeps nextTouch: false until this runs. It sets nextTouch = true on exactly
// those two array elements (exact stored strings — "Switched off" has a
// lowercase "o"). Nothing else on the pipeline is changed; re-running is a
// no-op once both are true.
//
// DRY RUN by default (prints the matched elements, before → after). Pass
// --apply to write.
//
//   npx tsx src/scripts/migrate-disposition-nexttouch-not-connected.ts --expect-db=<db> [--apply]
import "dotenv/config";
import mongoose from "mongoose";

const PIPELINE_KEY = "corporate_calling";
const SUBS = ["Switched off", "Ringing Only"];

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const pipelines = mongoose.connection.collection("crmpipelines");
  const p: any = await pipelines.findOne({ key: PIPELINE_KEY }, { projection: { name: 1, dispositionSet: 1 } });

  console.log(`db ${db} · ${apply ? "APPLY" : "DRY RUN"}`);
  if (!p) {
    console.log(`No pipeline with key "${PIPELINE_KEY}" — nothing to do (a fresh seed already carries nextTouch: true).`);
    return;
  }
  console.log(`pipeline ${String(p._id)}  ${p.name}  (${(p.dispositionSet || []).length} sub-dispositions)`);

  const matched = (p.dispositionSet || []).filter((e: any) => SUBS.includes(e.subDisposition));
  const missing = SUBS.filter((s) => !matched.some((e: any) => e.subDisposition === s));
  const todo = matched.filter((e: any) => e.nextTouch !== true);
  for (const e of matched) {
    console.log(`  ${e.disposition} → ${e.subDisposition.padEnd(13)} nextTouch: ${String(e.nextTouch)} → true${e.nextTouch === true ? "  (already set)" : ""}`);
  }
  for (const s of missing) console.log(`  !! "${s}" not found on this pipeline (exact match) — left alone`);
  console.log(`matched: ${matched.length} of ${SUBS.length} · to change: ${todo.length}`);

  if (!todo.length) {
    console.log("\nNothing to change.");
    return;
  }
  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to write.");
    return;
  }

  const r = await pipelines.updateOne(
    { _id: p._id },
    { $set: { "dispositionSet.$[e].nextTouch": true } },
    { arrayFilters: [{ "e.subDisposition": { $in: SUBS }, "e.nextTouch": { $ne: true } }] },
  );
  console.log(`\nWritten: ${r.modifiedCount} pipeline document(s).`);
  const check: any = await pipelines.findOne({ _id: p._id }, { projection: { dispositionSet: 1 } });
  for (const e of (check?.dispositionSet || []).filter((x: any) => SUBS.includes(x.subDisposition))) {
    console.log(`  now: ${e.subDisposition.padEnd(13)} nextTouch: ${String(e.nextTouch)}`);
  }
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
