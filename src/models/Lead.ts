import mongoose, { Document, Schema } from "mongoose";
import { isCrmV2OpportunityEnabled } from "../config/crmV2.js";
import {
  LEAD_STATUSES,
  SOURCE_CHANNELS,
  ENQUIRY_TYPES,
  STATUS_TO_LEGACY_STAGE,
  legacyStageToStatus,
  type LeadStatus,
  type SourceChannel,
  type EnquiryType,
} from "./crmTaxonomy.js";
import { TravelRequirementSchema, type TravelRequirement } from "./travelRequirement.js";

// ── Phase 1 / Slice 2 (CRM_V2_OPPORTUNITY) ───────────────────────────
// `stage` below is the LEGACY 9-value sales pipeline. It is kept — readable,
// still written, still indexed — because (a) the unchanged frontend reads it,
// (b) the migration reads it, and (c) gap analysis §4.4 keeps it populated
// until Phase 2 sign-off. The new intake taxonomy lives in `status`
// (models/crmTaxonomy.ts), and the commercial lifecycle moved to
// models/Opportunity.ts. Under the flag the pre-validate hook keeps the two
// columns coherent; with the flag off nothing touches the new paths.
export const LEAD_STAGES = [
  "new", "email_sent", "contacted", "demo_scheduled", "proposal_sent",
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

  // Shared-company anchor. Points at the CRMCompany this lead belongs to so
  // multiple contacts/leads at one company link to ONE record. Resolved on
  // create/edit (and reused at win/convert). companyName stays denormalized
  // for display/search/export. null for individuals / blank-company leads.
  companyId?: mongoose.Types.ObjectId | null;

  // ── Slice 2 (CRM_V2_OPPORTUNITY) — additive, all optional ──
  /** New intake taxonomy (PRD E). null on rows written before Slice 2 —
   *  read it through effectiveLeadStatus(), never raw. */
  status?: LeadStatus | null;
  /** source_channel / enquiry_type split (PRD E): `source` stays as the
   *  legacy overloaded field; sourceChannel is a lossless copy of it plus
   *  the PRD channels, enquiryType is what the prospect asked for. */
  sourceChannel: SourceChannel | "";
  enquiryType: EnquiryType | "";
  /** Intake snapshot (gap §5 — embedded, captured once, promotable). */
  travelRequirement: TravelRequirement;
  /** Back-ref to the Opportunity this lead converted into (one per lead). */
  opportunityId?: mongoose.Types.ObjectId | null;
  /** Reserved (decision A). Never read, never written. */
  workspaceId?: mongoose.Types.ObjectId | null;

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
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "CRMCompany",
      default: null,
    },

    // ── Slice 2 (CRM_V2_OPPORTUNITY) — additive, all optional / defaulted ──
    // No default on `status`: a defaulted "NEW" would lie about every legacy
    // row on hydration (a won lead would read NEW). Absent means "derive from
    // stage" — see effectiveLeadStatus().
    status: { type: String, enum: [...LEAD_STATUSES, null], default: null },
    sourceChannel: { type: String, enum: [...SOURCE_CHANNELS, ""], default: "" },
    enquiryType: { type: String, enum: [...ENQUIRY_TYPES, ""], default: "" },
    travelRequirement: { type: TravelRequirementSchema, default: () => ({}) },
    opportunityId: { type: Schema.Types.ObjectId, ref: "Opportunity", default: null },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", default: null },
  },
  { timestamps: true }
);

LeadSchema.index({ stage: 1 });
LeadSchema.index({ assignedTo: 1 });
LeadSchema.index({ source: 1 });
LeadSchema.index({ createdAt: -1 });
LeadSchema.index({ companyId: 1 });
LeadSchema.index({ leadCode: 1 }, { unique: true, sparse: true });
LeadSchema.index({ status: 1 }, { sparse: true });
LeadSchema.index({ opportunityId: 1 }, { sparse: true });

/** The lead's status in the new taxonomy, whether or not the row has been
 *  migrated: the stored `status` when present, else derived from the legacy
 *  `stage` through the one transition table. Works on lean rows. */
export function effectiveLeadStatus(lead: { status?: string | null; stage?: string | null }): LeadStatus {
  const s = lead?.status;
  if (s && (LEAD_STATUSES as readonly string[]).includes(s)) return s as LeadStatus;
  return legacyStageToStatus(lead?.stage);
}

// Flag ON only: keep `status` and the legacy `stage` coherent on every save.
//   • a legacy write (routes set `stage`)  → derive `status`
//   • a new-taxonomy write (sets `status`) → derive the mildest legacy `stage`
//     so the unchanged frontend still places the card somewhere sensible
//   • `sourceChannel` is a lossless copy of `source` until a caller sets it
// Flag OFF: byte-for-byte legacy — none of the new paths are touched.
LeadSchema.pre("validate", function (next) {
  if (!isCrmV2OpportunityEnabled()) return next();
  const stageChanged = this.isNew || this.isModified("stage");
  const statusChanged = this.isModified("status");
  if (statusChanged && !stageChanged && this.status) {
    this.stage = STATUS_TO_LEGACY_STAGE[this.status];
  } else if (stageChanged || !this.status) {
    this.status = legacyStageToStatus(this.stage);
  }
  if (!this.sourceChannel && this.source) {
    this.sourceChannel = this.source as SourceChannel;
  }
  next();
});

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
