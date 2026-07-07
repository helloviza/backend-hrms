// apps/backend/src/models/CompanySettings.ts
import mongoose, { Schema, Document } from "mongoose";
import { GST_STATE_CODES } from "../utils/gstDetection.js";

// Mirrors GSTIN_RE in routes/directCustomers.ts / components/admin/DirectCustomerModal.tsx —
// keep in sync rather than inventing a divergent pattern.
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export interface IGstProfile {
  _id?: mongoose.Types.ObjectId;
  state: string;
  stateCode: string;
  gstin: string;
  legalName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  pincode: string;
  isDefault: boolean;
  active: boolean;
  // Per-GSTIN invoice/credit-note numbering series. Empty/absent = the bare
  // legacy series (INV-${period}${seq}) — reserved for the default profile.
  // Every other profile gets its own series: INV-${prefix}${period}${seq}.
  invoiceSeriesPrefix?: string;
  // Per-profile "Invoice Start Number" — mirrors the flat invoiceStartNumber
  // below, but scoped to this profile's own Counter series.
  invoiceStartNumber?: number;
}

export interface ICompanySettings extends Document {
  // Company Info
  companyName: string;
  gstin: string;
  address: string;        // legacy freeform — kept for backward compat
  addressLine1: string;
  addressLine2: string;
  city: string;
  country: string;
  pincode: string;
  email: string;
  phone: string;
  website: string;
  state: string;
  supplierState: string;
  supplierStateCode: string;
  // Additive multi-GSTIN registry. Empty by default — every existing reader
  // keeps using the flat gstin/supplierState/supplierStateCode fields above,
  // which the PUT route mirrors from whichever profile has isDefault:true.
  gstProfiles: IGstProfile[];
  logoUrl: string;
  // Bank Details
  bankAccountHolder: string;
  bankAccountNumber: string;
  bankIfsc: string;
  bankBranch: string;
  bankAccountType: string;
  // Report Email
  reportsFromEmail: string;
  reportsFromName: string;
  // Notification email routing
  supportEmail?: string;
  opsEmail?: string;
  accountManagerEmail?: string;
  // Invoice Numbering
  invoiceStartNumber: number;
  // Cadence for every NON-default GST profile's own invoice/credit-note
  // series (period component of the number). The default profile's series
  // stays annual/bare regardless of this setting.
  invoiceSeriesCadence: "annual" | "monthly";
  // Ticket Numbering
  ticketPrefix: string;
  ticketSeqWidth: number;
  ticketStartNumber: number;
}

const CompanySettingsSchema = new Schema<ICompanySettings>(
  {
    companyName:         { type: String, default: "" },
    gstin:               { type: String, default: "" },
    address:             { type: String, default: "" },   // legacy freeform
    addressLine1:        { type: String, default: "" },
    addressLine2:        { type: String, default: "" },
    city:                { type: String, default: "" },
    country:             { type: String, default: "India" },
    pincode:             { type: String, default: "" },
    email:               { type: String, default: "" },
    phone:               { type: String, default: "" },
    website:             { type: String, default: "" },
    state:               { type: String, default: "" },
    supplierState: {
      type: String,
      default: "Karnataka",
      enum: [
        "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
        "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand",
        "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
        "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab",
        "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
        "Uttar Pradesh", "Uttarakhand", "West Bengal",
        "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu",
        "Delhi", "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
      ],
    },
    supplierStateCode:   { type: String, default: "29" },
    gstProfiles: {
      type: [{
        state:         { type: String, required: true },
        stateCode:     { type: String, required: true },
        gstin:         { type: String, required: true, uppercase: true, trim: true },
        legalName:     { type: String, default: "" },
        addressLine1:  { type: String, default: "" },
        addressLine2:  { type: String, default: "" },
        city:          { type: String, default: "" },
        pincode:       { type: String, default: "" },
        isDefault:     { type: Boolean, default: false },
        active:        { type: Boolean, default: true },
        invoiceSeriesPrefix: { type: String, default: "", trim: true, uppercase: true },
        invoiceStartNumber:  { type: Number, default: 1, min: 1 },
      }],
      default: [],
    },
    logoUrl:             { type: String, default: "" },
    bankAccountHolder:   { type: String, default: "" },
    bankAccountNumber:   { type: String, default: "" },
    bankIfsc:            { type: String, default: "" },
    bankBranch:          { type: String, default: "" },
    bankAccountType:     { type: String, default: "Current Account" },
    reportsFromEmail:    { type: String, default: "" },
    reportsFromName:     { type: String, default: "Plumtrips Reports" },
    supportEmail:        { type: String, default: "hello@plumtrips.com", trim: true },
    opsEmail:            { type: String, default: "neelb@plumtrips.com", trim: true },
    accountManagerEmail: { type: String, default: "", trim: true },
    invoiceStartNumber:  { type: Number, default: 1 },
    invoiceSeriesCadence: { type: String, enum: ["annual", "monthly"], default: "annual" },
    ticketPrefix: {
      type: String,
      default: "PT",
      validate: {
        validator: (v: string) => /^[A-Z]{2,10}$/.test(v),
        message: "Ticket prefix must be 2-10 uppercase letters only",
      },
    },
    ticketSeqWidth:      { type: Number, default: 3, enum: [3, 4, 5] },
    ticketStartNumber:   { type: Number, default: 1, min: 1, max: 99999 },
  },
  { timestamps: true },
);

// Shared validation for the gstProfiles registry — used by the pre('validate')
// hook below (fires for .save()/.create() document writes, e.g. the seed
// script) AND by the companySettings PUT route (which writes via
// findOneAndUpdate, so it validates explicitly rather than relying on the
// hook, since findOneAndUpdate does not run document middleware).
// Empty/undefined stays valid — this is what keeps every existing caller
// (which only reads the flat fields) working unchanged until a profile exists.
export function validateGstProfiles(
  profiles: Array<Partial<IGstProfile>> | undefined | null,
): string | null {
  if (!profiles || profiles.length === 0) return null;

  const defaults = profiles.filter((p) => p.isDefault);
  if (defaults.length !== 1) {
    return `gstProfiles must have exactly one isDefault:true profile (found ${defaults.length})`;
  }
  if (!defaults[0].active) {
    return `The default GST profile ("${defaults[0].state}") must be active:true`;
  }

  for (const p of profiles) {
    const gstin = (p.gstin || "").toUpperCase().trim();
    if (!GSTIN_RE.test(gstin)) {
      return `GST profile "${p.state || "(no state)"}" has an invalid GSTIN: "${p.gstin || ""}"`;
    }
    const expectedCode = GST_STATE_CODES[p.state || ""];
    if (!expectedCode) {
      return `GST profile has an unknown state: "${p.state}"`;
    }
    if (p.stateCode !== expectedCode) {
      return `GST profile "${p.state}" stateCode must be "${expectedCode}" (got "${p.stateCode}")`;
    }
    if (gstin.slice(0, 2) !== expectedCode) {
      return `GST profile "${p.state}" GSTIN "${gstin}" prefix does not match its state code ("${expectedCode}")`;
    }
  }

  // Invoice-numbering series: exactly one ACTIVE profile may have an empty
  // invoiceSeriesPrefix (the bare/legacy series), and it must be the default
  // profile — this is what guarantees the default's series never moves.
  // Every other active profile needs its own non-empty, unique prefix.
  const activeProfiles = profiles.filter((p) => p.active);
  const emptyPrefixProfiles = activeProfiles.filter((p) => !(p.invoiceSeriesPrefix || "").trim());
  if (emptyPrefixProfiles.length !== 1) {
    return `Exactly one active GST profile may have an empty Invoice Series Prefix, reserved for the default series (found ${emptyPrefixProfiles.length})`;
  }
  if (!emptyPrefixProfiles[0].isDefault) {
    return `The GST profile with an empty Invoice Series Prefix must be the Default profile ("${emptyPrefixProfiles[0].state}" is not marked default)`;
  }
  const seenPrefixes = new Set<string>();
  for (const p of activeProfiles) {
    const prefix = (p.invoiceSeriesPrefix || "").trim().toUpperCase();
    if (!prefix) continue;
    if (!/^[A-Z0-9]{1,10}$/.test(prefix)) {
      return `GST profile "${p.state}" has an invalid Invoice Series Prefix "${prefix}" — must be 1-10 uppercase letters/digits`;
    }
    if (seenPrefixes.has(prefix)) {
      return `Invoice Series Prefix "${prefix}" is used by more than one active GST profile — prefixes must be unique`;
    }
    seenPrefixes.add(prefix);
  }

  return null;
}

CompanySettingsSchema.pre("validate", function (next) {
  const err = validateGstProfiles(this.gstProfiles as unknown as Array<Partial<IGstProfile>>);
  if (err) return next(new Error(err));
  next();
});

const CompanySettings = mongoose.model<ICompanySettings>(
  "CompanySettings",
  CompanySettingsSchema,
);

export default CompanySettings;

export async function getCompanySettings(): Promise<ICompanySettings> {
  let settings = await CompanySettings.findOne();
  if (!settings) {
    settings = await CompanySettings.create({});
  }
  return settings;
}
