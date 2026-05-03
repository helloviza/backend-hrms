// apps/backend/src/scripts/backfill-customer-type.ts
// Run once: sets customerType="BUSINESS" on all existing Customer docs that lack it.
// Idempotent — safe to run multiple times.
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import Customer from "../models/Customer.js";

async function run() {
  await connectDb();

  const result = await (Customer as any).collection.updateMany(
    { customerType: { $exists: false } },
    { $set: { customerType: "BUSINESS" } },
  );

  console.log(`Backfill complete: ${result.modifiedCount} documents updated.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
