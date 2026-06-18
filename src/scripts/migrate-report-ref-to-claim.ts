/**
 * migrate-report-ref-to-claim.ts
 *
 * Rewrites existing Report refs from the old REP-XXXXXX prefix to CLM-XXXXXX
 * ("Claim" is the user-facing term). Only the 3-letter prefix changes; the
 * 6-char id suffix is preserved, so REP-1A2B3C → CLM-1A2B3C. EXP- (expense)
 * refs are untouched.
 *
 *   DRY RUN (default):  pnpm -C apps/backend tsx src/scripts/migrate-report-ref-to-claim.ts
 *   COMMIT  (writes):   ... migrate-report-ref-to-claim.ts --commit
 *
 * Idempotent: re-running after a commit is a no-op (no refs match ^REP-).
 */
import "dotenv/config";
import mongoose from "mongoose";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const uri = process.env.MONGO_URI!;
  if (!uri) throw new Error("MONGO_URI is not set");

  await mongoose.connect(uri, { readPreference: COMMIT ? "primary" : "secondary" });
  const reports = mongoose.connection.db!.collection("reports");

  console.log(COMMIT ? "── COMMIT (writing) ──" : "── DRY RUN (no writes) ──");

  const filter = { ref: { $regex: "^REP-" } };
  const matched = await reports.countDocuments(filter);
  console.log(`\nReport.ref  REP-XXXXXX → CLM-XXXXXX:  ${matched} doc(s)`);

  if (matched > 0) {
    // Show a small sample so the dry run is reviewable.
    const sample = await reports.find(filter).limit(5).project({ ref: 1 }).toArray();
    for (const r of sample) {
      console.log(`  ${r.ref} → ${String(r.ref).replace(/^REP-/, "CLM-")}`);
    }
    if (matched > sample.length) console.log(`  …and ${matched - sample.length} more`);
  }

  if (COMMIT && matched > 0) {
    // Single pipeline update: replace the prefix in place for the whole set.
    const res = await reports.updateMany(filter, [
      {
        $set: {
          ref: {
            $concat: ["CLM-", { $substrBytes: ["$ref", 4, { $strLenBytes: "$ref" }] }],
          },
        },
      },
    ]);
    console.log(`\nmatched ${matched}, modified ${res.modifiedCount ?? 0}`);
  } else if (!COMMIT) {
    console.log("\nRe-run with --commit to apply.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
