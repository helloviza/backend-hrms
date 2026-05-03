// apps/backend/src/models/CompanySettings.ts
import mongoose, { Schema, Document } from "mongoose";

export interface ICompanySettings extends Document {
  // Company Info
  companyName: string;
  gstin: string;
  address: string;
  email: string;
  phone: string;
  website: string;
  state: string;
  supplierState: string;
  supplierStateCode: string;
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
  // Ticket Numbering
  ticketPrefix: string;
  ticketSeqWidth: number;
  ticketStartNumber: number;
}

const CompanySettingsSchema = new Schema<ICompanySettings>(
  {
    companyName:         { type: String, default: "" },
    gstin:               { type: String, default: "" },
    address:             { type: String, default: "" },
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
