/**
 * seed-local-company-settings.ts — IDEMPOTENT, LOCAL-ONLY
 * ---------------------------------------------------------------------------
 * Fills the CompanySettings singleton (and its one default gstProfile) with
 * OBVIOUSLY-FAKE values so a real invoice issuer can run against local Mongo.
 *
 * WHY THIS EXISTS
 * ---------------
 * getCompanySettings() (models/CompanySettings.ts) auto-creates an EMPTY
 * singleton on first read, so the settings row is never null — it is simply
 * blank. A blank row still generates an invoice: resolveSellerGstProfile falls
 * through to synthesizeFromFlatFields() and issues under gstin "" / companyName
 * "" at the schema-default supplierState "Karnataka". That produces a document
 * that is not a valid tax invoice, which is worse than a hard failure because
 * nothing complains. This seed gives the local issuer a real-shaped identity.
 *
 * TWO PROFILES, AND THE SECOND ONE IS THE POINT
 * ---------------------------------------------
 * PROFILE 1 is the DEFAULT: empty invoiceSeriesPrefix, because
 * validateGstProfiles() requires exactly one active profile with an empty
 * prefix and requires it to be the default. Invoice.ts's pre-save hook then
 * takes the bare legacy path for it: Counter key `invoice:FY<fyStartYear>`,
 * format INV-<fy><seq4>. Note the FY2026 catch-up in that hook ($max seq 40),
 * so the first B2B FY2026 invoice here lands on INV-20260040.
 *
 * PROFILE 2 is the D2C registration: a DIFFERENT (also fake) GSTIN — reusing
 * profile 1's would be neither valid nor meaningful, since the GSTIN IS the
 * counter key — with invoiceSeriesPrefix "HV", active, NOT default.
 * `d2cSellerGstin` points at it. That combination is what gives consumer
 * receipts their own gapless series: counter `invoice:FY<y>:<gstin>`, rendered
 * INV-HV<fy><seq4>, with credit notes following as CN-HV<fy><seq4>. B2B is
 * untouched — it still resolves to profile 1 and still draws the same
 * `invoice:FY<y>` counter it always did.
 *
 * REFUSES TO RUN against anything but 127.0.0.1/localhost.
 *
 * Run:  NODE_ENV=development npx tsx --env-file=.env.development \
 *         src/scripts/seed-local-company-settings.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import CompanySettings, { validateGstProfiles, validateD2CSellerGstin } from "../models/CompanySettings.js";

// Karnataka (state code 29) — matches the schema's own supplierState/
// supplierStateCode defaults, so the seeded row does not silently relocate
// the issuer relative to an unseeded one.
const STATE = "Karnataka";
const STATE_CODE = "29";
// Canonical dummy PAN (AAAAA0000A) wrapped in a structurally-valid GSTIN, so
// it passes GSTIN_RE and the state-code prefix check while being unmistakably
// not a real registration.
const FAKE_GSTIN = "29AAAAA0000A1Z5";
// The D2C registration. Same state (so consumer receipts stay intra-state
// CGST+SGST against the house customer's Karnataka), different GSTIN — the
// GSTIN is what keys the Counter, so a shared one would mean a shared series
// and the whole point of this profile would be lost.
const FAKE_D2C_GSTIN = "29AAAAA0000B1Z4";
const D2C_SERIES_PREFIX = "HV";

async function main() {
  const uri = process.env.MONGO_URI || "";
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) {
    throw new Error(`REFUSING: MONGO_URI is not local (${uri || "unset"})`);
  }
  await mongoose.connect(uri);
  console.log(`[seed-local-company-settings] connected to ${mongoose.connection.name}`);

  // Read-modify-save (not findOneAndUpdate) so the schema's pre('validate')
  // hook actually runs the gstProfiles validator — findOneAndUpdate does not
  // run document middleware, which is why the PUT route validates by hand.
  const settings = (await CompanySettings.findOne()) || new CompanySettings({});

  settings.set({
    companyName: "Plumtrips Local Test Pvt Ltd",
    gstin: FAKE_GSTIN,
    address: "1 Test Street, Local Layout, Bengaluru, Karnataka, India, 560001",
    addressLine1: "1 Test Street",
    addressLine2: "Local Layout",
    city: "Bengaluru",
    country: "India",
    pincode: "560001",
    email: "local-test@example.invalid",
    phone: "+91 90000 00000",
    website: "https://local.example.invalid",
    state: STATE,
    // Flat fields mirror the default profile, exactly as the companySettings
    // PUT route keeps them in sync.
    supplierState: STATE,
    supplierStateCode: STATE_CODE,
    bankAccountHolder: "Plumtrips Local Test Pvt Ltd",
    bankAccountNumber: "000000000000",
    bankIfsc: "TEST0000001",
    bankBranch: "Local Test Branch",
    bankAccountType: "Current Account",
  });

  settings.set("gstProfiles", [
    // 1 — the DEFAULT / B2B registration. Empty prefix = the bare legacy
    // series every existing invoice already uses.
    {
      state: STATE,
      stateCode: STATE_CODE,
      gstin: FAKE_GSTIN,
      legalName: "Plumtrips Local Test Pvt Ltd",
      addressLine1: "1 Test Street",
      addressLine2: "Local Layout",
      city: "Bengaluru",
      pincode: "560001",
      isDefault: true,
      active: true,
      invoiceSeriesPrefix: "",
      invoiceStartNumber: 1,
    },
    // 2 — the D2C registration. Active, NOT default, own prefix.
    {
      state: STATE,
      stateCode: STATE_CODE,
      gstin: FAKE_D2C_GSTIN,
      legalName: "Plumtrips Local Test Pvt Ltd (Helloviza D2C)",
      addressLine1: "1 Test Street",
      addressLine2: "Local Layout",
      city: "Bengaluru",
      pincode: "560001",
      isDefault: false,
      active: true,
      invoiceSeriesPrefix: D2C_SERIES_PREFIX,
      invoiceStartNumber: 1,
    },
  ]);

  // The pointer services/d2cInvoicing.ts reads and passes as opts.sellerGstin.
  settings.set("d2cSellerGstin", FAKE_D2C_GSTIN);

  const err = validateGstProfiles(settings.gstProfiles as any);
  if (err) throw new Error(`gstProfiles invalid: ${err}`);
  const d2cErr = validateD2CSellerGstin(settings.d2cSellerGstin, settings.gstProfiles as any);
  if (d2cErr) throw new Error(`d2cSellerGstin invalid: ${d2cErr}`);

  await settings.save();

  const saved = await CompanySettings.findOne().lean();
  console.log("[seed-local-company-settings] saved:");
  console.log(JSON.stringify(saved, null, 2));
  console.log("[seed-local-company-settings] CompanySettings count =", await CompanySettings.countDocuments());

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
