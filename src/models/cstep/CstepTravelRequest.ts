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

// Claims addition — LOCAL_TRAVEL_CLAIM and EXPENSE_CLAIM are reimbursement
// claims for money already spent, standalone (no tour behind them). They
// share this collection and the request lifecycle up to APPROVED, then skip
// arrangement and the travel report entirely: approve seeds a VERIFYING
// CstepSettlement from the claim's own lines, a CSTEP Admin verifies it
// (-> TRANSFERRED_TO_FINANCE), and Finance pays (-> REIMBURSED / SETTLED).
export const CSTEP_FORM_TYPES = ["TOUR_PROPOSAL", "EVENT_REQUEST", "LOCAL_TRAVEL_CLAIM", "EXPENSE_CLAIM"] as const;
export type CstepFormType = (typeof CSTEP_FORM_TYPES)[number];
export const CSTEP_CLAIM_FORM_TYPES = ["LOCAL_TRAVEL_CLAIM", "EXPENSE_CLAIM"] as const;
export function isClaimFormType(formType: any): boolean {
  return (CSTEP_CLAIM_FORM_TYPES as readonly string[]).includes(formType);
}

// ── Local Travel Claim (claims addition) — additive, sibling fields ─────────

export const CSTEP_LOCAL_TRAVEL_MODES = ["CAB", "LOCAL_TAXI", "METRO", "BUS", "OWN_VEHICLE"] as const;
export type CstepLocalTravelMode = (typeof CSTEP_LOCAL_TRAVEL_MODES)[number];

export interface ICstepClaimTravelLine {
  _id?: mongoose.Types.ObjectId;
  date?: string; // "YYYY-MM-DD"
  from?: string;
  to?: string;
  mode?: CstepLocalTravelMode;
  fare?: number; // INR, flat per line — no km x rate
  remarks?: string;
  attachmentId?: mongoose.Types.ObjectId; // ref CstepAttachment
  noBill?: boolean; // no supporting document — lists the line in the claim's Declaration
}

export interface ICstepClaimFoodLine {
  _id?: mongoose.Types.ObjectId;
  date?: string; // "YYYY-MM-DD"
  amount?: number; // INR
  remarks?: string;
  attachmentId?: mongoose.Types.ObjectId; // ref CstepAttachment, optional
}

// ── Expense Claim (claims module 2) — additive, sibling fields ──────────────

export interface ICstepClaimExpenseLine {
  _id?: mongoose.Types.ObjectId;
  date?: string; // "YYYY-MM-DD"
  description?: string;
  amount?: number; // INR, before tax
  attachmentId?: mongoose.Types.ObjectId; // ref CstepAttachment — the line's invoice, optional when a claim-level invoice exists
}

/** The claimant's own figures, STORED on every write by the pre-validate
 * hook below (never derived at read time). The verified figures Finance
 * pays live on the CstepSettlement, which can differ once the Admin
 * corrects a line. net = gross - advance; dueByCstep / dueToCstep are its
 * positive / negative halves (CSTEP owes the claimant / the claimant owes
 * CSTEP back) — both kept, never zeroed. */
export interface ICstepClaimTotals {
  travel: number; // Local Travel Claim
  food: number; // Local Travel Claim
  other: number; // Local Travel Claim
  subtotal?: number; // Expense Claim — sum of its lines, before tax
  tax?: number; // Expense Claim — the single IGST/tax amount
  gross: number; // the claim's total: travel + food + other, or subtotal + tax
  advance: number;
  net: number;
  dueByCstep: number;
  dueToCstep: number;
}

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
  project?: string; // display text: "CODE — Name" for a picked project; free text on requests made before the Project Master
  // Project Master — the picked project (CstepProject) and a snapshot of it
  // taken at write time, so a rename never rewrites the request and the
  // Tally export's Project CC never breaks. Absent on older free-text requests.
  projectId?: mongoose.Types.ObjectId;
  projectCode?: string;
  projectName?: string;
  projectTallyCC?: string;
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
  /** Per Diem Eligible (Yes/No), set by the creator on every Tour Proposal /
   * Event Request. No → settlement seeds a zero per diem and skips the
   * rate/day lookup. A missing field (requests made before it) reads as Yes. */
  perDiemEligible?: boolean;
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

  // LOCAL_TRAVEL_CLAIM-only. Never set on any other form type.
  travelLines?: ICstepClaimTravelLine[];
  foodLines?: ICstepClaimFoodLine[];
  otherExpenses?: number; // INR
  advanceTaken?: number; // INR — a claim's advance, netted off its total (both claim types)

  // EXPENSE_CLAIM-only. Never set on any other form type.
  expenseLines?: ICstepClaimExpenseLine[];
  taxAmount?: number; // INR — one IGST/tax figure; GSTIN/HSN live on the attached invoice
  invoiceAttachmentIds?: mongoose.Types.ObjectId[]; // claim-level tax invoice(s), ref CstepAttachment
  claimTotals?: ICstepClaimTotals; // computed on write — see the pre-validate hook

  fundsConfirmedBy?: mongoose.Types.ObjectId; // ref User
  fundsConfirmedAt?: string; // ISO string, not Date — see module note

  // Step 3 addition — ARRANGING/ARRANGED extend the lifecycle past APPROVED:
  // the Official user arranges requirements (ARRANGING), then marks the
  // request ARRANGED (awaiting the traveller's post-trip report).
  // Step 4 addition — from ARRANGED, the traveller starts their Travel
  // Report (REPORT_PENDING — legs are editable) and submits it
  // (REPORT_SUBMITTED — now with the Admin for Step 5).
  // Report approval — between the two, REPORT_UNDER_APPROVAL: the submitted
  // report waits on the traveller's Approver (the Manager), who approves it
  // on to the Official (REPORT_SUBMITTED) or returns it (REPORT_PENDING).
  // Processing-queue 6-stage addition — TRANSFERRED_TO_FINANCE is the final
  // Processing-queue stage (Step 6's hand-off, not built yet). Defined here
  // only so the Processing board's 6th tab exists ahead of that work; no
  // route currently sets this status.
  // Step 5 addition — from REPORT_SUBMITTED, the Official/Admin verifies and
  // finalizes a CstepSettlement (routes/cstep.ts's /settlement/* routes):
  // outcome CLOSE -> SETTLED (nothing owed, closed), outcome TO_FINANCE ->
  // TRANSFERRED_TO_FINANCE (money owed, reusing the status already defined
  // above).
  // Step 6 — REIMBURSED is the terminal state for the paid-out case: the
  // Finance user (TravellerProfile.financeUserId) or a CSTEP Admin marks
  // the reimbursement done (POST /requests/:id/finance/settle). Distinct
  // from SETTLED, which stays "closed with nothing owed".
  status:
    | "DRAFT"
    | "SUBMITTED"
    | "RETURNED"
    | "APPROVED"
    | "ARRANGING"
    | "ARRANGED"
    | "REPORT_PENDING"
    | "REPORT_UNDER_APPROVAL"
    | "REPORT_SUBMITTED"
    | "TRANSFERRED_TO_FINANCE"
    | "SETTLED"
    | "REIMBURSED"
    | "REJECTED"
    | "CANCELLED";
  claimReference?: string; // set on approval — a TOUR_PROPOSAL's TIN, a claim's own reference ("LTC0001/1026", "EXP0001/1026"), or an EVENT_REQUEST's "EVR0001/1026". New ones come from utils/cstepSequence.ts; older ones keep the format they were issued in

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

// ── Local Travel Claim (claims addition) sub-schemas — additive ─────────────
// Lines keep their own _id: the settlement seeded at approve points each
// CLAIM_LINE row back at the line it came from (CstepSettlementLine.sourceId).

const CstepClaimTravelLineSchema = new Schema<ICstepClaimTravelLine>({
  date: { type: String },
  from: { type: String, trim: true },
  to: { type: String, trim: true },
  mode: { type: String, enum: CSTEP_LOCAL_TRAVEL_MODES },
  fare: { type: Number },
  remarks: { type: String, trim: true },
  attachmentId: { type: Schema.Types.ObjectId, ref: "CstepAttachment" },
  noBill: { type: Boolean, default: false },
});

const CstepClaimFoodLineSchema = new Schema<ICstepClaimFoodLine>({
  date: { type: String },
  amount: { type: Number },
  remarks: { type: String, trim: true },
  attachmentId: { type: Schema.Types.ObjectId, ref: "CstepAttachment" },
});

const CstepClaimExpenseLineSchema = new Schema<ICstepClaimExpenseLine>({
  date: { type: String },
  description: { type: String, trim: true },
  amount: { type: Number },
  attachmentId: { type: Schema.Types.ObjectId, ref: "CstepAttachment" },
});

const CstepClaimTotalsSchema = new Schema<ICstepClaimTotals>(
  {
    travel: { type: Number, default: 0 },
    food: { type: Number, default: 0 },
    other: { type: Number, default: 0 },
    subtotal: { type: Number },
    tax: { type: Number },
    gross: { type: Number, default: 0 },
    advance: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    dueByCstep: { type: Number, default: 0 },
    dueToCstep: { type: Number, default: 0 },
  },
  { _id: false },
);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The claimant-side totals for a Local Travel Claim, from its own lines. */
export function computeLocalTravelClaimTotals(doc: {
  travelLines?: Array<{ fare?: number }>;
  foodLines?: Array<{ amount?: number }>;
  otherExpenses?: number;
  advanceTaken?: number;
}): ICstepClaimTotals {
  const travel = round2((doc.travelLines || []).reduce((s, l) => s + (Number(l?.fare) || 0), 0));
  const food = round2((doc.foodLines || []).reduce((s, l) => s + (Number(l?.amount) || 0), 0));
  const other = round2(Number(doc.otherExpenses) || 0);
  const gross = round2(travel + food + other);
  const advance = round2(Number(doc.advanceTaken) || 0);
  const net = round2(gross - advance);
  return { travel, food, other, gross, advance, net, dueByCstep: net > 0 ? net : 0, dueToCstep: net < 0 ? round2(-net) : 0 };
}

/** The claimant-side totals for an Expense Claim: subtotal = Σ lines, total
 * = subtotal + tax, net = total − advance. */
export function computeExpenseClaimTotals(doc: {
  expenseLines?: Array<{ amount?: number }>;
  taxAmount?: number;
  advanceTaken?: number;
}): ICstepClaimTotals {
  const subtotal = round2((doc.expenseLines || []).reduce((s, l) => s + (Number(l?.amount) || 0), 0));
  const tax = round2(Number(doc.taxAmount) || 0);
  const gross = round2(subtotal + tax);
  const advance = round2(Number(doc.advanceTaken) || 0);
  const net = round2(gross - advance);
  return {
    travel: 0,
    food: 0,
    other: 0,
    subtotal,
    tax,
    gross,
    advance,
    net,
    dueByCstep: net > 0 ? net : 0,
    dueToCstep: net < 0 ? round2(-net) : 0,
  };
}

const CstepTravelRequestSchema = new Schema<ICstepTravelRequest>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    travelerProfileId: { type: Schema.Types.ObjectId, ref: "TravellerProfile", required: true, index: true },

    formType: { type: String, enum: CSTEP_FORM_TYPES, default: "TOUR_PROPOSAL", required: true, index: true },

    // Not required at the schema level any more — TOUR_PROPOSAL-only, an
    // EVENT_REQUEST document never sets it. validatePayload (routes/cstep.ts)
    // still requires it whenever formType is TOUR_PROPOSAL, exactly as
    // before this relaxation — existing Tour Proposal documents all already
    // have a value here, so this loosening is a no-op for them.
    type: { type: String, enum: ["DOMESTIC", "INTERNATIONAL"] },

    purpose: { type: String, required: true, trim: true },
    project: { type: String, trim: true },
    projectId: { type: Schema.Types.ObjectId, ref: "CstepProject" },
    projectCode: { type: String, trim: true },
    projectName: { type: String, trim: true },
    projectTallyCC: { type: String, trim: true },
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
    perDiemEligible: { type: Boolean, default: true },
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

    // LOCAL_TRAVEL_CLAIM-only — never set on any other form type. No array
    // defaults on purpose: a Tour/Event document must not grow empty
    // travelLines/foodLines arrays just by being saved.
    travelLines: { type: [CstepClaimTravelLineSchema], default: undefined },
    foodLines: { type: [CstepClaimFoodLineSchema], default: undefined },
    otherExpenses: { type: Number },
    advanceTaken: { type: Number },
    claimTotals: { type: CstepClaimTotalsSchema },

    // EXPENSE_CLAIM-only — never set on any other form type (no defaults,
    // same reason as the Local Travel Claim arrays above).
    expenseLines: { type: [CstepClaimExpenseLineSchema], default: undefined },
    taxAmount: { type: Number },
    invoiceAttachmentIds: { type: [{ type: Schema.Types.ObjectId, ref: "CstepAttachment" }], default: undefined },

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
        "REPORT_UNDER_APPROVAL",
        "REPORT_SUBMITTED",
        "TRANSFERRED_TO_FINANCE",
        "SETTLED",
        "REIMBURSED",
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

// Claim totals are stored on EVERY write path (create, PATCH, amend) from one
// place, so no route can save a Local Travel Claim with stale totals.
CstepTravelRequestSchema.pre("validate", function (next) {
  const self: any = this;
  if (self.formType === "LOCAL_TRAVEL_CLAIM") self.claimTotals = computeLocalTravelClaimTotals(self);
  else if (self.formType === "EXPENSE_CLAIM") self.claimTotals = computeExpenseClaimTotals(self);
  next();
});

// A claim's reference is unique per tenant. Partial on claimTotals (present
// only on claim documents) so existing Tour Proposal TINs — already unique
// through CstepClaim's own index — are not indexed here at all.
CstepTravelRequestSchema.index(
  { workspaceId: 1, claimReference: 1 },
  { unique: true, partialFilterExpression: { claimTotals: { $exists: true }, claimReference: { $exists: true } } },
);

CstepTravelRequestSchema.plugin(workspaceScopePlugin);

const CstepTravelRequest =
  (mongoose.models.CstepTravelRequest as mongoose.Model<ICstepTravelRequest>) ||
  mongoose.model<ICstepTravelRequest>("CstepTravelRequest", CstepTravelRequestSchema);

export default CstepTravelRequest;
