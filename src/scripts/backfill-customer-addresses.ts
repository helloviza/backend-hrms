// apps/backend/src/scripts/backfill-customer-addresses.ts
// Parse freeform addresses on Customer and Onboarding docs into structured fields.
// Run: pnpm -C apps/backend exec tsx src/scripts/backfill-customer-addresses.ts

import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import Customer from "../models/Customer.js";
import Onboarding from "../models/Onboarding.js";

// Heuristic: split by comma, last numeric chunk = pincode, walk backwards
// Format assumed: "Line1[, Line2], City, State[, Country], Pincode"
function parseIndianAddress(raw: string): {
  addressLine1: string;
  addressLine2: string;
  city: string;
  pincode: string;
  parsed: boolean;
} {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { addressLine1: raw, addressLine2: "", city: "", pincode: "", parsed: false };

  let pincode = "";
  let lastIdx = parts.length - 1;

  // Last part numeric = pincode
  if (/^\d{4,6}$/.test(parts[lastIdx])) {
    pincode = parts[lastIdx];
    lastIdx--;
  }

  // Second-to-last = state (skip — already stored in gstRegisteredState)
  if (lastIdx > 0) lastIdx--;

  // Now last remaining = city
  const city = lastIdx >= 0 ? parts[lastIdx] : "";
  lastIdx--;

  // Remainder = address lines
  const lineparts = parts.slice(0, lastIdx + 1);
  const addressLine1 = lineparts.slice(0, Math.ceil(lineparts.length / 2)).join(", ");
  const addressLine2 = lineparts.slice(Math.ceil(lineparts.length / 2)).join(", ");

  const parsed = !!(city || pincode || addressLine1);
  return { addressLine1, addressLine2, city, pincode, parsed };
}

async function main() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected.\n");

  console.log("[Backfill] Starting customer address migration...\n");

  // ── Customers ────────────────────────────────────────────────
  let totalCustomers = 0;
  let parsedCustomers = 0;
  const failedCustomers: string[] = [];

  const customers = await Customer.find({}).lean();
  totalCustomers = customers.length;
  console.log(`[Backfill] Found ${totalCustomers} customer records`);

  for (const c of customers as any[]) {
    const alreadyStructured = !!(c.address?.street || c.address?.city);
    if (alreadyStructured) {
      parsedCustomers++;
      continue;
    }

    const raw = c.registeredAddress || c.billingAddress || "";
    if (!raw) {
      failedCustomers.push(`${c._id} (${c.legalName || c.name}) — no address to parse`);
      continue;
    }

    const { addressLine1, addressLine2, city, pincode, parsed } = parseIndianAddress(raw);
    if (!parsed) {
      failedCustomers.push(`${c._id} (${c.legalName || c.name}) — unparseable: "${raw}"`);
      continue;
    }

    await Customer.updateOne(
      { _id: c._id },
      {
        $set: {
          "address.street":  addressLine1,
          "address.street2": addressLine2,
          "address.city":    city,
          "address.state":   c.gstRegisteredState || c.address?.state || "",
          "address.country": c.address?.country || "India",
          "address.pincode": pincode,
        },
      },
    );
    parsedCustomers++;
  }

  console.log(`\n[Backfill] Customers:`);
  console.log(`  Total processed:             ${totalCustomers}`);
  console.log(`  Migrated / already structured: ${parsedCustomers}`);
  console.log(`  Needs manual update:          ${failedCustomers.length}`);
  if (failedCustomers.length > 0) {
    console.log("\n  --- Customers needing manual address update ---");
    failedCustomers.forEach((s) => console.log("  •", s));
  }

  // ── Onboarding (type=business) ───────────────────────────────
  console.log("\n[Backfill] Processing Onboarding (business) records...");
  const onboardings = await Onboarding.find({ type: "business" }).lean();
  let parsedOnboarding = 0;
  const failedOnboarding: string[] = [];

  for (const ob of onboardings as any[]) {
    const fp = (ob as any).formPayload || {};
    const alreadyStructured = !!(fp.addressLine1 || fp.city);
    if (alreadyStructured) { parsedOnboarding++; continue; }

    const raw = fp.registeredAddress || (ob as any).registeredAddress || "";
    if (!raw) {
      failedOnboarding.push(`${ob._id} (${fp.legalName || (ob as any).inviteeName}) — no address`);
      continue;
    }

    const { addressLine1, addressLine2, city, pincode, parsed } = parseIndianAddress(raw);
    if (!parsed) {
      failedOnboarding.push(`${ob._id} (${fp.legalName || (ob as any).inviteeName}) — unparseable: "${raw}"`);
      continue;
    }

    await Onboarding.updateOne(
      { _id: ob._id },
      {
        $set: {
          "formPayload.addressLine1": addressLine1,
          "formPayload.addressLine2": addressLine2,
          "formPayload.city":         city,
          "formPayload.pincode":      pincode,
          "formPayload.country":      fp.country || "India",
        },
      },
    );
    parsedOnboarding++;
  }

  console.log(`  Total processed:             ${onboardings.length}`);
  console.log(`  Migrated / already structured: ${parsedOnboarding}`);
  console.log(`  Needs manual update:          ${failedOnboarding.length}`);
  if (failedOnboarding.length > 0) {
    console.log("\n  --- Onboarding records needing manual address update ---");
    failedOnboarding.forEach((s) => console.log("  •", s));
  }

  console.log("\n[Backfill] Done.");
  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[Backfill] Fatal error:", err);
  process.exit(1);
});
