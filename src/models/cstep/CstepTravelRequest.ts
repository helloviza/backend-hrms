// apps/backend/src/models/cstep/CstepTravelRequest.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepTravelRequest
 * -------------------
 * CSTEP Travel & Claim Portal — the pre-trip proposer form. A traveller (or
 * someone filing on their behalf) fills this out before travel/an event;
 * once approved, a TOUR_PROPOSAL additionally gets a claimReference and a
 * CstepClaim is opened (EVENT_REQUEST does not — see routes/cstep.ts's
 * approve handler).
 *
 * formType (Event Request addition) discriminates which proposer form this
 * document is — "TOUR_PROPOSAL" (default, existing rows) or
 * "EVENT_REQUEST". Both share ONE flat schema/collection, the same way
 * DOMESTIC/INTERNATIONAL already coexist as sibling optional fields
 * discriminated by `type` — this is that same pattern one level up. All
 * lifecycle routes (submit/withdraw/cancel/approve/return/start-review/
 * activity/approvals) stay formType-agnostic; only validation, the field
 * allowlist, and PDF rendering branch on it. `type` (DOMESTIC/INTERNATIONAL)
 * is TOUR_PROPOSAL-only and is no longer schema-required — EVENT_REQUEST
 * documents never set it; validatePayload (routes/cstep.ts) still enforces
 * it for TOUR_PROPOSAL exactly as before.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin (auto-injects a
 * workspaceId filter on reads), same as Expense.ts.
 *
 * travelerProfileId is a SOFT reference to TravellerProfile — no schema-level
 * FK, TravellerProfile itself is untouched by this module.
 */

export interface ICstepStationEntry {
  from?: string;
  to?: string;
  durationOfStay?: string;
}

export interface ICstepCountryEntry {
  country?: string;
  fromDate?: string; // "YYYY-MM-DD"
  toDate?: string; // "YYYY-MM-DD"
}

export interface ICstepAdvanceForex {
  amount?: number;
  currency?: string;
}

export interface ICstepPersonalDays {
  count?: number;
  dates?: string[]; // ["YYYY-MM-DD", ...]
}

export type CstepTimeBand = "BEFORE_6AM" | "6AM_12PM" | "12PM_6PM" | "AFTER_6PM";

export type CstepFormType = "TOUR_PROPOSAL" | "EVENT_REQUEST";

// ── Event Request (Event Request addition) — additive, sibling fields ────────

export interface ICstepEventParticipantEntry {
  organisation?: string;
  count?: number;
}

export interface ICstepFundsAvailability {
  amount?: number;
  note?: string;
}

export interface ICstepParticipantMeals {
  lunchCount?: number;
  dinnerCount?: number;
}

export const CSTEP_EVENT_NATURES = ["WORKSHOP", "CONFERENCE", "SEMINAR", "OTHER"] as const;
export type CstepEventNature = (typeof CSTEP_EVENT_NATURES)[number];

export interface ICstepTravelRequest extends Document {
  workspaceId: mongoose.Types.ObjectId;
  travelerProfileId: mongoose.Types.ObjectId; // soft ref -> TravellerProfile._id — the proposer, for either form type

  formType: CstepFormType;

  // TOUR_PROPOSAL-only. Never set on an EVENT_REQUEST document.
  type?: "DOMESTIC" | "INTERNATIONAL";

  purpose: string; // "Purpose of tour" (Tour Proposal) / "Title of the event" (Event Request) — shared field, different on-screen label
  project?: string;
  projectDebitable?: string;

  stations: ICstepStationEntry[]; // domestic
  countries: ICstepCountryEntry[]; // international

  departureDate?: string; // "YYYY-MM-DD" — Tour Proposal: departure date. Event Request: event start date.
  departureTimeBand?: CstepTimeBand;
  returnDate?: string; // "YYYY-MM-DD" — Tour Proposal: return date. Event Request: event end date.
  returnTimeBand?: CstepTimeBand;

  eventDates?: string; // Tour Proposal (domestic) "Date(s) of Events" free-text field — unrelated to Event Request, which uses departureDate/returnDate for its own duration.
  modesRequested: Array<"AIR" | "RAIL" | "ROAD" | "OTHER">;
  modeOther?: string;

  transportRequired: boolean;
  transportRequiredNote?: string;
  accommodationRequired: boolean; // Tour Proposal: "Accommodation requirement". Event Request: "Travel & accommodation support required" — shared field, different on-screen label.
  accommodationRequiredNote?: string;

  mealPreference?: "VEG" | "NON_VEG";
  sponsored: boolean;
  sponsoredDetails?: string;

  // International-only
  daysAbsent?: number;
  advanceForex?: ICstepAdvanceForex;
  sponsorshipInvitationAttached?: boolean;
  justification?: string;
  expectedOutcome?: string;
  extendedBeyondDates?: boolean;
  personalDays?: ICstepPersonalDays;
  contactWhileTravelling?: string;
  otherInstructions?: string;
  estimatedCost?: number;
  roamingApproved?: boolean;

  // EVENT_REQUEST-only. Never set on a TOUR_PROPOSAL document.
  eventParticipants?: ICstepEventParticipantEntry[];
  hostInstitution?: string;
  eventNature?: CstepEventNature;
  eventNatureOther?: string;
  eventLocation?: string;
  eventVenue?: string;
  registrationFee?: number;
  presentingPaper?: boolean;
  presentingPaperDetails?: string;
  eventFundsAvailability?: ICstepFundsAvailability;
  participantMeals?: ICstepParticipantMeals;

  fundsConfirmedBy?: mongoose.Types.ObjectId; // ref User
  fundsConfirmedAt?: string; // ISO string, not Date — see module note

  // Step 3 addition — ARRANGING/ARRANGED extend the lifecycle past APPROVED:
  // the Official user arranges requirements (ARRANGING), then marks the
  // request ARRANGED (awaiting the traveller's post-trip report).
  // Step 4 addition — from ARRANGED, the traveller starts their Travel
  // Report (REPORT_PENDING — legs are editable) and submits it
  // (REPORT_SUBMITTED — now with the Admin for Step 5).
  // Processing-queue 6-stage addition — TRANSFERRED_TO_FINANCE is the final
  // Processing-queue stage (Step 6's hand-off, not built yet). Defined here
  // only so the Processing board's 6th tab exists ahead of that work; no
  // route currently sets this status.
  // Step 5 addition — from REPORT_SUBMITTED, the Official/Admin verifies and
  // finalizes a CstepSettlement (routes/cstep.ts's /settlement/* routes):
  // outcome CLOSE -> SETTLED (nothing owed, closed), outcome TO_FINANCE ->
  // TRANSFERRED_TO_FINANCE (money owed, reusing the status already defined
  // above).
  status:
    | "DRAFT"
    | "SUBMITTED"
    | "RETURNED"
    | "APPROVED"
    | "ARRANGING"
    | "ARRANGED"
    | "REPORT_PENDING"
    | "REPORT_SUBMITTED"
    | "TRANSFERRED_TO_FINANCE"
    | "SETTLED"
    | "REJECTED"
    | "CANCELLED";
  claimReference?: string; // set on approval — TOUR_PROPOSAL only, see routes/cstep.ts's approve handler

  // Tour Proposal PDF cache (Step 1 Polish) — regenerated whenever stale
  // (pdfGeneratedAt older than updatedAt) by GET /requests/:id/pdf.
  pdfS3Key?: string;
  pdfGeneratedAt?: Date;

  // Combined packet PDF cache (itinerary + supporting documents + approval
  // form) — regenerated whenever stale by GET /requests/:id/packet. See
  // utils/cstepPacketPdf.ts.
  packetS3Key?: string;
  packetGeneratedAt?: Date;

  createdBy: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepStationSchema = new Schema<ICstepStationEntry>(
  {
    from: { type: String, trim: true },
    to: { type: String, trim: true },
    durationOfStay: { type: String, trim: true },
  },
  { _id: false },
);

const CstepCountrySchema = new Schema<ICstepCountryEntry>(
  {
    country: { type: String, trim: true },
    fromDate: { type: String },
    toDate: { type: String },
  },
  { _id: false },
);

const CstepAdvanceForexSchema = new Schema<ICstepAdvanceForex>(
  {
    amount: { type: Number },
    currency: { type: String, trim: true, uppercase: true },
  },
  { _id: false },
);

const CstepPersonalDaysSchema = new Schema<ICstepPersonalDays>(
  {
    count: { type: Number },
    dates: { type: [String], default: [] },
  },
  { _id: false },
);

// ── Event Request (Event Request addition) sub-schemas — additive ────────────

const CstepEventParticipantSchema = new Schema<ICstepEventParticipantEntry>(
  {
    organisation: { type: String, trim: true },
    count: { type: Number },
  },
  { _id: false },
);

const CstepFundsAvailabilitySchema = new Schema<ICstepFundsAvailability>(
  {
    amount: { type: Number },
    note: { type: String, trim: true },
  },
  { _id: false },
);

const CstepParticipantMealsSchema = new Schema<ICstepParticipantMeals>(
  {
    lunchCount: { type: Number },
    dinnerCount: { type: Number },
  },
  { _id: false },
);

const CstepTravelRequestSchema = new Schema<ICstepTravelRequest>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    travelerProfileId: { type: Schema.Types.ObjectId, ref: "TravellerProfile", required: true, index: true },

    formType: { type: String, enum: ["TOUR_PROPOSAL", "EVENT_REQUEST"], default: "TOUR_PROPOSAL", required: true, index: true },

    // Not required at the schema level any more — TOUR_PROPOSAL-only, an
    // EVENT_REQUEST document never sets it. validatePayload (routes/cstep.ts)
    // still requires it whenever formType is TOUR_PROPOSAL, exactly as
    // before this relaxation — existing Tour Proposal documents all already
    // have a value here, so this loosening is a no-op for them.
    type: { type: String, enum: ["DOMESTIC", "INTERNATIONAL"] },

    purpose: { type: String, required: true, trim: true },
    project: { type: String, trim: true },
    projectDebitable: { type: String, trim: true },

    stations: { type: [CstepStationSchema], default: [] },
    countries: { type: [CstepCountrySchema], default: [] },

    departureDate: { type: String },
    departureTimeBand: { type: String, enum: ["BEFORE_6AM", "6AM_12PM", "12PM_6PM", "AFTER_6PM"] },
    returnDate: { type: String },
    returnTimeBand: { type: String, enum: ["BEFORE_6AM", "6AM_12PM", "12PM_6PM", "AFTER_6PM"] },

    eventDates: { type: String, trim: true },
    modesRequested: { type: [String], enum: ["AIR", "RAIL", "ROAD", "OTHER"], default: [] },
    modeOther: { type: String, trim: true },

    transportRequired: { type: Boolean, default: false },
    transportRequiredNote: { type: String, trim: true },
    accommodationRequired: { type: Boolean, default: false },
    accommodationRequiredNote: { type: String, trim: true },

    mealPreference: { type: String, enum: ["VEG", "NON_VEG"] },
    sponsored: { type: Boolean, default: false },
    sponsoredDetails: { type: String, trim: true },

    // International-only
    daysAbsent: { type: Number },
    advanceForex: { type: CstepAdvanceForexSchema },
    sponsorshipInvitationAttached: { type: Boolean },
    justification: { type: String, trim: true },
    expectedOutcome: { type: String, trim: true },
    extendedBeyondDates: { type: Boolean },
    personalDays: { type: CstepPersonalDaysSchema },
    contactWhileTravelling: { type: String, trim: true },
    otherInstructions: { type: String, trim: true },
    estimatedCost: { type: Number },
    roamingApproved: { type: Boolean },

    // EVENT_REQUEST-only — untouched/undefined on TOUR_PROPOSAL documents.
    eventParticipants: { type: [CstepEventParticipantSchema], default: [] },
    hostInstitution: { type: String, trim: true },
    eventNature: { type: String, enum: ["WORKSHOP", "CONFERENCE", "SEMINAR", "OTHER"] },
    eventNatureOther: { type: String, trim: true },
    eventLocation: { type: String, trim: true },
    eventVenue: { type: String, trim: true },
    registrationFee: { type: Number },
    presentingPaper: { type: Boolean },
    presentingPaperDetails: { type: String, trim: true },
    eventFundsAvailability: { type: CstepFundsAvailabilitySchema },
    participantMeals: { type: CstepParticipantMealsSchema },

    fundsConfirmedBy: { type: Schema.Types.ObjectId, ref: "User" },
    fundsConfirmedAt: { type: String },

    status: {
      type: String,
      enum: [
        "DRAFT",
        "SUBMITTED",
        "RETURNED",
        "APPROVED",
        "ARRANGING",
        "ARRANGED",
        "REPORT_PENDING",
        "REPORT_SUBMITTED",
        "TRANSFERRED_TO_FINANCE",
        "SETTLED",
        "REJECTED",
        "CANCELLED",
      ],
      default: "DRAFT",
      index: true,
    },
    claimReference: { type: String, trim: true, index: true, sparse: true },

    pdfS3Key: { type: String, trim: true },
    pdfGeneratedAt: { type: Date },

    packetS3Key: { type: String, trim: true },
    packetGeneratedAt: { type: Date },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

CstepTravelRequestSchema.plugin(workspaceScopePlugin);

const CstepTravelRequest =
  (mongoose.models.CstepTravelRequest as mongoose.Model<ICstepTravelRequest>) ||
  mongoose.model<ICstepTravelRequest>("CstepTravelRequest", CstepTravelRequestSchema);

export default CstepTravelRequest;
