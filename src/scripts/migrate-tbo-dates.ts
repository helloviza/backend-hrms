import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import { parseTBODate } from "../lib/tbo-date.js";

// Run: npx tsx -r dotenv/config src/scripts/migrate-tbo-dates.ts [--dry-run]
// Backfills legacy lastCancellationDate / lastVoucherDate string values to Date objects.
// Idempotent: re-running produces zero changes once all records are migrated.

const dryRun = process.argv.includes("--dry-run");

async function main() {
  console.log(`\n=== TBO Date Migration [${dryRun ? "DRY-RUN" : "WRITE"}] ===\n`);

  await connectDb();
  console.log("[1/3] MongoDB connected");

  // Lean scan — we need the raw stored value, not Mongoose-cast values.
  // Mongoose setters run on hydration, so we use the native driver to see raw strings.
  const collection = mongoose.connection.collection("sbthotelbookings");
  const cursor = collection.find({
    $or: [
      { lastCancellationDate: { $type: "string" } },
      { lastVoucherDate: { $type: "string" } },
    ],
  });

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  console.log("[2/3] Scanning for string-typed date fields...");

  for await (const raw of cursor) {
    const updates: Record<string, Date | null> = {};
    const changes: string[] = [];

    if (typeof raw.lastCancellationDate === "string") {
      const parsed = parseTBODate(raw.lastCancellationDate);
      if (parsed) {
        updates.lastCancellationDate = parsed;
        changes.push(`lastCancellationDate: "${raw.lastCancellationDate}" → ${parsed.toISOString()}`);
      } else {
        updates.lastCancellationDate = null;
        changes.push(`lastCancellationDate: "${raw.lastCancellationDate}" → null (unparseable)`);
      }
    }

    if (typeof raw.lastVoucherDate === "string") {
      const parsed = parseTBODate(raw.lastVoucherDate);
      if (parsed) {
        updates.lastVoucherDate = parsed;
        changes.push(`lastVoucherDate: "${raw.lastVoucherDate}" → ${parsed.toISOString()}`);
      } else {
        updates.lastVoucherDate = null;
        changes.push(`lastVoucherDate: "${raw.lastVoucherDate}" → null (unparseable)`);
      }
    }

    if (Object.keys(updates).length === 0) {
      skipped++;
      continue;
    }

    console.log(`  [${raw._id}] ${changes.join("; ")}`);

    if (!dryRun) {
      try {
        await collection.updateOne({ _id: raw._id }, { $set: updates });
        migrated++;
      } catch (e: any) {
        console.error(`  [ERROR] Failed to update ${raw._id}: ${e?.message}`);
        failed++;
      }
    } else {
      migrated++;
    }
  }

  console.log(`\n[3/3] Done.`);
  console.log(`  Records ${dryRun ? "would be migrated" : "migrated"}: ${migrated}`);
  console.log(`  Records skipped (already Date):                    ${skipped}`);
  if (failed > 0) console.error(`  Records failed:                                    ${failed}`);
  if (dryRun) console.log("\n  (No writes — pass without --dry-run to apply changes.)");

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[ERROR]", e instanceof Error ? e.message : String(e));
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
