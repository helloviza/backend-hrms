/**
 * seed-intake-system-identities.ts — IDEMPOTENT
 * ---------------------------------------------------------------------------
 * Creates the two system identities needed by the travel-intake pipeline
 * (infra/audit/manual-bookings-intake-audit.md, decision 4):
 *
 *  1. A dedicated "PlumTrips House" Customer document — the Customer._id that
 *     intake-created ManualBooking.workspaceId is pinned to. NOT the literal
 *     69679a7628330a58d29f2254 (that id is a CustomerWorkspace._id whose
 *     customerId happens to point at an unrelated Zoho-imported external
 *     client, "Rehan"/Inteletek AI — verified against prod on 2026-07-08,
 *     see manual-bookings-intake-build.md). This script creates a genuine,
 *     dedicated internal Customer record instead.
 *  2. A "System Intake" User document — used as `bookedBy`/`createdBy` on
 *     intake-created bookings. Its `workspaceId` (User schema, ref
 *     CustomerWorkspace) IS the real Plumtrips CustomerWorkspace
 *     (69679a7628330a58d29f2254, companyName "Plumtrips") — that literal is
 *     correct for this field, since User.workspaceId refs CustomerWorkspace,
 *     not Customer.
 *
 * Idempotency: matched by stable identifying fields (Customer.customerCode,
 * User.email) via findOneAndUpdate+upsert — safe to re-run.
 *
 * Run:  pnpm -C apps/backend tsx src/scripts/seed-intake-system-identities.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import Customer from "../models/Customer.js";
import User from "../models/User.js";

const HOUSE_CUSTOMER_WORKSPACE_ID = "69679a7628330a58d29f2254"; // real CustomerWorkspace, companyName "Plumtrips"
const HOUSE_CUSTOMER_CODE = "HOUSE-INTAKE";
const SYSTEM_INTAKE_EMAIL = "system-intake@plumtrips.com";

async function main() {
  const MONGO = process.env.MONGO_URI;
  if (!MONGO) throw new Error("MONGO_URI not set in apps/backend/.env");
  await mongoose.connect(MONGO);
  console.log("[seed-intake-system-identities] connected");

  // ── 1. PlumTrips House Customer (ManualBooking.workspaceId pin target) ──
  const houseCustomer = await Customer.findOneAndUpdate(
    { customerCode: HOUSE_CUSTOMER_CODE },
    {
      $setOnInsert: {
        name: "PlumTrips House",
        legalName: "PlumTrips House",
        companyName: "PlumTrips House",
        customerCode: HOUSE_CUSTOMER_CODE,
        type: "CUSTOMER",
        status: "ACTIVE",
        segment: "internal",
        description:
          "Internal PlumTrips workspace customer record. Used to house ManualBooking rows created by the public travel-intake form pending manual triage/assignment — not a real client.",
        workspaceId: HOUSE_CUSTOMER_WORKSPACE_ID,
        legalNameNormalized: "plumtrips house",
      },
    },
    { upsert: true, new: true },
  );
  console.log("[seed-intake-system-identities] PlumTrips House Customer._id:", String(houseCustomer._id));

  // ── 2. System Intake User (bookedBy / createdBy on intake bookings) ──
  let systemUser = await User.findOne({ email: SYSTEM_INTAKE_EMAIL });
  if (!systemUser) {
    const randomPassword = crypto.randomBytes(32).toString("hex"); // never disclosed; login not a supported path for this identity
    const passwordHash = await bcrypt.hash(randomPassword, 12);
    systemUser = await User.create({
      email: SYSTEM_INTAKE_EMAIL,
      officialEmail: SYSTEM_INTAKE_EMAIL,
      workspaceId: HOUSE_CUSTOMER_WORKSPACE_ID,
      name: "System Intake",
      passwordHash,
      roles: ["SYSTEM_INTAKE"],
      status: "ACTIVE",
    });
    console.log("[seed-intake-system-identities] Created System Intake User._id:", String(systemUser._id));
  } else {
    console.log("[seed-intake-system-identities] System Intake User already exists._id:", String(systemUser._id));
  }

  console.log("\n=== SUMMARY (copy into routes/intake.travel.ts + manualBookings.ts) ===");
  console.log("HOUSE_WORKSPACE_ID (ManualBooking.workspaceId, Customer._id):", String(houseCustomer._id));
  console.log("SYSTEM_INTAKE_USER_ID (bookedBy / createdBy):", String(systemUser._id));
  console.log("SYSTEM_INTAKE_EMAIL (createdByEmail):", SYSTEM_INTAKE_EMAIL);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
