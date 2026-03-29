/**
 * Migration: Enable SBT Official Booking for Plumtrips workspace.
 *
 * Run after code deployment:
 *   node apps/backend/scripts/migrate-official-booking.mjs
 *
 * Requires MONGO_URI env var (reads from apps/backend/.env).
 */

import { config } from "dotenv";
import mongoose from "mongoose";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const PLUMTRIPS_WORKSPACE_ID = "69679a7628330a58d29f2254";

async function migrate() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const result = await mongoose.connection.db
    .collection("customerworkspaces")
    .updateOne(
      { _id: new mongoose.Types.ObjectId(PLUMTRIPS_WORKSPACE_ID) },
      {
        $set: {
          "sbtOfficialBooking.enabled": true,
          "sbtOfficialBooking.monthlyLimit": 500000,
          "sbtOfficialBooking.currentMonthSpend": 0,
          "sbtOfficialBooking.lastResetMonth": new Date()
            .toISOString()
            .slice(0, 7),
        },
      },
    );

  console.log("Migration result:", result);
  console.log(
    result.matchedCount
      ? "Plumtrips workspace updated — official booking enabled, ₹5L monthly limit"
      : "WARNING: Plumtrips workspace not found!",
  );

  await mongoose.disconnect();
  console.log("Done");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
