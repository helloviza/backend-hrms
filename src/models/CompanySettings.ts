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
  // Invoice Numbering
  invoiceStartNumber: number;
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
    logoUrl:             { type: String, default: "" },
    bankAccountHolder:   { type: String, default: "" },
    bankAccountNumber:   { type: String, default: "" },
    bankIfsc:            { type: String, default: "" },
    bankBranch:          { type: String, default: "" },
    bankAccountType:     { type: String, default: "Current Account" },
    reportsFromEmail:    { type: String, default: "" },
    reportsFromName:     { type: String, default: "Plumtrips Reports" },
    invoiceStartNumber:  { type: Number, default: 1 },
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
