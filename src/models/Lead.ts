import mongoose, { Document, Schema } from "mongoose";

export const LEAD_STAGES = [
  "new", "contacted", "demo_scheduled", "proposal_sent",
  "negotiation", "follow_up", "won", "lost",
] as const;
export type LeadStage = typeof LEAD_STAGES[number];

export const LEAD_SOURCES = [
  "manual", "website", "linkedin", "facebook",
  "instagram", "referral", "cold_call", "email", "other",
] as const;
export type LeadSource = typeof LEAD_SOURCES[number];

export const LEAD_INDUSTRIES = [
  "IT/Technology", "Pharma/Healthcare", "FMCG",
  "Manufacturing", "Banking/Finance", "Consulting",
  "Education", "Government/PSU", "Real Estate",
  "Logistics", "Media/Entertainment", "Other",
] as const;

export const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-500", "500+"] as const;

export interface LeadDoc extends Document {
  leadCode: string;
  type: "company" | "individual";

  companyName: string;
  industry: string;
  companySize: string;
  location: string;
  address: string;
  website: string;
  gstin: string;

  contactName: string;
  contactPhone: string;
  contactEmail: string;
  contactDesignation: string;

  source: LeadSource;
  stage: LeadStage;
  budget: string;
  dealValue: number;
  currency: "INR" | "USD" | "AED";
  notes: string;

  assignedTo: mongoose.Types.ObjectId;
  assignedToName: string;
  createdBy: mongoose.Types.ObjectId;

  nextFollowUpDate?: Date;
  followUpNotes: string;

  lostReason: string;
  wonDate?: Date;
  onboardingInviteSent: boolean;
  onboardingInviteDate?: Date;
  onboardingToken: string;

  convertedToContactId?: mongoose.Types.ObjectId | null;
  convertedToCompanyId?: mongoose.Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

const LeadSchema = new Schema<LeadDoc>(
  {
    leadCode: { type: String, trim: true },
    type: { type: String, enum: ["company", "individual"], default: "company" },

    companyName: { type: String, trim: true, default: "" },
    industry: { type: String, trim: true, default: "" },
    companySize: { type: String, trim: true, default: "" },
    location: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    website: { type: String, trim: true, default: "" },
    gstin: { type: String, trim: true, default: "" },

    contactName: { type: String, required: true, trim: true },
    contactPhone: { type: String, required: true, trim: true },
    contactEmail: { type: String, trim: true, default: "" },
    contactDesignation: { type: String, trim: true, default: "" },

    source: { type: String, enum: LEAD_SOURCES, default: "manual" },
    stage: { type: String, enum: LEAD_STAGES, default: "new" },
    budget: { type: String, trim: true, default: "" },
    dealValue: { type: Number, default: 0 },
    currency: { type: String, enum: ["INR", "USD", "AED"], default: "INR" },
    notes: { type: String, default: "" },

    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    assignedToName: { type: String, trim: true, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },

    nextFollowUpDate: { type: Date },
    followUpNotes: { type: String, default: "" },

    lostReason: { type: String, default: "" },
    wonDate: { type: Date },
    onboardingInviteSent: { type: Boolean, default: false },
    onboardingInviteDate: { type: Date },
    onboardingToken: { type: String, default: "" },

    convertedToContactId: {
      type: Schema.Types.ObjectId,
      ref: "CRMContact",
      default: null,
    },
    convertedToCompanyId: {
      type: Schema.Types.ObjectId,
      ref: "CRMCompany",
      default: null,
    },
  },
  { timestamps: true }
);

LeadSchema.index({ stage: 1 });
LeadSchema.index({ assignedTo: 1 });
LeadSchema.index({ source: 1 });
LeadSchema.index({ createdAt: -1 });
LeadSchema.index({ leadCode: 1 }, { unique: true, sparse: true });

LeadSchema.pre("save", async function (next) {
  if (this.leadCode) return next();
  try {
    const year = new Date().getFullYear();
    const count = await (this.constructor as any).countDocuments({});
    this.leadCode = `LEAD-${year}-${String(count + 1).padStart(4, "0")}`;
  } catch {
    // non-blocking — leadCode can be set manually if hook fails
  }
  next();
});

const Lead = mongoose.model<LeadDoc>("Lead", LeadSchema);
export default Lead;
