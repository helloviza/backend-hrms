/**
 * Bootstrap gstProfiles[0] on the CompanySettings singleton from the current
 * flat fields (gstin, supplierState, supplierStateCode, address, companyName).
 * Idempotent — if gstProfiles already has entries, this is a no-op.
 *
 * Usage:
 *   tsx src/scripts/seed-gst-profiles.ts --dry-run   (prints the planned write, no DB change)
 *   tsx src/scripts/seed-gst-profiles.ts             (writes gstProfiles[0])
 */

import { connectDb } from "../config/db.js";
import CompanySettings, { validateGstProfiles, type IGstProfile } from "../models/CompanySettings.js";
import { GST_STATE_CODES } from "../utils/gstDetection.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function run() {
  await connectDb();

  const settings = await CompanySettings.findOne();
  if (!settings) {
    console.log("No CompanySettings document exists yet — nothing to seed. Save Company Settings from the UI once first.");
    process.exit(0);
  }

  if (settings.gstProfiles && settings.gstProfiles.length > 0) {
    console.log(`gstProfiles already has ${settings.gstProfiles.length} entrie(s) — no-op (idempotent).`);
    process.exit(0);
  }

  const state = settings.supplierState || "Karnataka";
  const stateCode = settings.supplierStateCode || GST_STATE_CODES[state] || "";

  const profile: IGstProfile = {
    state,
    stateCode,
    gstin: settings.gstin || "",
    legalName: settings.companyName || "",
    addressLine1: settings.addressLine1 || "",
    addressLine2: settings.addressLine2 || "",
    city: settings.city || "",
    pincode: settings.pincode || "",
    isDefault: true,
    active: true,
  };

  console.log("=== Planned gstProfiles[0] (derived from current flat fields) ===");
  console.log(JSON.stringify(profile, null, 2));

  const validationError = validateGstProfiles([profile]);
  if (validationError) {
    console.error("\nRefusing to seed — derived profile would be invalid:", validationError);
    console.error("Fix the flat gstin/supplierState/supplierStateCode fields via the Company Settings page first, then re-run.");
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: no changes written.");
    process.exit(0);
  }

  await CompanySettings.updateOne({ _id: settings._id }, { $set: { gstProfiles: [profile] } });
  console.log("\n✓ gstProfiles[0] written.");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
