// apps/backend/src/models/VisaApplication.ts
//
// Workspace-scoped, one per traveller PER REQUEST — uniqueness is enforced
// on {requestId, travellerProfileId}, not globally, since the same traveller
// can reasonably raise a separate VisaRequest for a later trip. Applicant
// identity is a reference to TravellerProfile (see docs/audits/
// visa-module-recon.md §1) — passport/name/DOB/nationality all live there;
// this model never duplicates them.
//
// ruleSnapshot / indicativeCostSnapshot are embedded, point-in-time copies
// of the VisaRule that was matched at quote time — NEVER a live reference —
// so a later edit to VisaRule (fee correction, doc-requirement change) does
// not retroactively change an application already in flight. The "actual"
// fee fields are separate: they hold what was really charged once the
// costs are confirmed, which may differ from the snapshot estimate.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import {
  VISA_PURPOSES, VISA_ENTRY_TYPES, VISA_SERVICE_TIERS, VISA_PRODUCT_CLASSES,
  VISA_CATEGORIES, VISA_ETA_BASES, VISA_RULE_DISPLAY_MODES,
  type VisaPurpose, type VisaEntryType, type VisaServiceTier, type VisaProductClass,
  type VisaCategory, type VisaEtaBasis, type VisaRuleDisplayMode,
  type VisaDocumentRequirement,
} from "./VisaRule.js";

export const VISA_APPLICATION_STATUSES = [
  "draft", "submitted", "docs_under_review", "action_required",
  "cost_confirmed", "lodged", "decision_received", "closed",
] as const;
export type VisaApplicationStatus = (typeof VISA_APPLICATION_STATUSES)[number];

export const VISA_APPLICATION_OUTCOMES = ["APPROVED", "REJECTED", "WITHDRAWN"] as const;
export type VisaApplicationOutcome = (typeof VISA_APPLICATION_OUTCOMES)[number];

export const VISA_LINKED_BOOKING_SERVICES = ["FLIGHT", "HOTEL"] as const;
export type VisaLinkedBookingService = (typeof VISA_LINKED_BOOKING_SERVICES)[number];

// A REFERENCE to an existing TravelBooking (routes/visa.ts's PATCH
// .../linked-bookings) — never a copy of the booking's own data, and never a
// VisaDocument. The applicant already booked this through the platform; this
// just records that the visa application should treat DOC-07/DOC-08 (hotel/
// flight, config/visaDocumentCodes.ts) as satisfied without asking them to
// re-upload something Plumtrips already has on file.
export interface VisaLinkedBooking {
  bookingId: mongoose.Types.ObjectId; // ref TravelBooking
  service: VisaLinkedBookingService;
  linkedAt: Date;
  linkedByUserId: mongoose.Types.ObjectId; // ref User
}

// Embedded copy of the VisaRule fields relevant to running an application —
// deliberately excludes VisaRule's own lifecycle fields (status,
// lastReviewedAt, reviewedBy), which describe the RULE's editorial state,
// not this application. ruleId + capturedAt are kept for audit traceability
// only — never populated/live-joined.
export interface VisaRuleSnapshot {
  ruleId: mongoose.Types.ObjectId; // the VisaRule this was captured from — audit trail only
  capturedAt: Date;

  destinationName: string;
  isSchengen: boolean;
  productClass: VisaProductClass;
  visaCategory: VisaCategory;
  purpose: VisaPurpose;
  entryType: VisaEntryType;
  serviceTier: VisaServiceTier;

  validityDays?: number;
  maxStayDays?: number;
  isExtension: boolean;

  etaMinDays?: number;
  etaMaxDays?: number;
  etaBasis?: VisaEtaBasis;

  appointmentRequired: boolean;
  biometricsRequired: boolean;
  documentRequirements: VisaDocumentRequirement[];
}

// What the applicant was quoted at request time — captured separately from
// ruleSnapshot's fee fields so a later fee-master correction is visible as
// a divergence, not silently retro-applied.
export interface VisaIndicativeCostSnapshot {
  embassyFeeInr?: number;
  vfsFeeInr?: number;
  plumtripsServiceFeeInr?: number;
  indicativeVisaCostInr?: number;
  displayMode: VisaRuleDisplayMode;
  totalInr: number;
  priceNote?: string;
}

export interface VisaApplicationDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  requestId: mongoose.Types.ObjectId; // ref VisaRequest
  travellerProfileId: mongoose.Types.ObjectId; // ref TravellerProfile — applicant identity, not duplicated here
  // ISO2, resolved at creation from TravellerProfile.nationality via
  // normaliseToIso2() (routes/visa.ts). TravellerProfile.nationality is a
  // free-text field (OCR/manual entry), so resolution can fail — e.g. a
  // typo, a demonym normaliseToIso2 doesn't recognise, or an empty field.
  // On failure this is null and nationalityUnresolved is true, rather than
  // rejecting the whole application: the traveller and the trip are still
  // real and worth capturing, and a concierge can fix the nationality by
  // hand. Never null with nationalityUnresolved false, or vice versa.
  nationality: string | null;
  nationalityUnresolved: boolean;

  ruleSnapshot: VisaRuleSnapshot;
  indicativeCostSnapshot: VisaIndicativeCostSnapshot;

  // Bookings the applicant made elsewhere on the platform, linked onto this
  // application in place of an uploaded DOC-07/DOC-08. See VisaLinkedBooking
  // above — never populated/live-joined here either; a bookingId reference
  // plus the audit fields is all this stores.
  linkedBookings: VisaLinkedBooking[];

  // Actual/final charged amounts — populated once costs are confirmed
  // (status >= "cost_confirmed"); independent of the snapshot estimate above.
  actualEmbassyFeeInr?: number;
  actualVfsFeeInr?: number;
  actualPlumtripsServiceFeeInr?: number;
  actualTotalInr?: number;

  status: VisaApplicationStatus;
  outcome?: VisaApplicationOutcome;

  // Why THIS application is (or was) action_required, and who/when — free
  // text, since the reasons are things like "bank statement needs a bank
  // stamp" or "attend your appointment on the 12th", not a fixed set of
  // codes. Nothing writes these yet — the concierge console sets them when
  // it moves an application INTO action_required (phase 6, not built here).
  // All three are set together and cleared together: whatever route
  // eventually clears action_required (moving the application to any other
  // status) MUST null out all three at the same time, never just the
  // status — a stale reason left behind would describe a problem that no
  // longer gates anything, and would misrepresent a NEW action_required
  // episode as a continuation of the old one.
  actionRequiredReason: string | null;
  actionRequiredSetAt: Date | null;
  actionRequiredSetByUserId: mongoose.Types.ObjectId | null; // ref User

  // Set the moment this application transitions draft -> submitted (POST
  // /requests/:id/submit, routes/visa.ts) — never on creation, and never
  // touched again after. Distinct from the request-level consent timestamp
  // (VisaRequest.consentAcceptedAt): consent is accepted once for the whole
  // request, submittedAt is per application since a future partial-refile
  // path could in principle submit a subset.
  submittedAt?: Date;

  visaNumber?: string;
  visaIssuedAt?: Date;
  visaExpiresAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaRuleSnapshotSchema = new Schema<VisaRuleSnapshot>(
  {
    ruleId: { type: Schema.Types.ObjectId, required: true },
    capturedAt: { type: Date, required: true },

    destinationName: { type: String, required: true },
    isSchengen: { type: Boolean, required: true },
    productClass: { type: String, enum: VISA_PRODUCT_CLASSES, required: true },
    visaCategory: { type: String, enum: VISA_CATEGORIES, required: true },
    purpose: { type: String, enum: VISA_PURPOSES, required: true },
    entryType: { type: String, enum: VISA_ENTRY_TYPES, required: true },
    serviceTier: { type: String, enum: VISA_SERVICE_TIERS, required: true },

    validityDays: { type: Number },
    maxStayDays: { type: Number },
    isExtension: { type: Boolean, default: false },

    etaMinDays: { type: Number },
    etaMaxDays: { type: Number },
    etaBasis: { type: String, enum: VISA_ETA_BASES },

    appointmentRequired: { type: Boolean, default: false },
    biometricsRequired: { type: Boolean, default: false },
    documentRequirements: {
      type: [
        {
          docCode: { type: String, required: true },
          requirement: { type: String, enum: ["REQUIRED", "CONDITIONAL"], required: true },
          condition: { type: String },
        },
      ],
      default: [],
    },
  },
  { _id: false },
);

const VisaIndicativeCostSnapshotSchema = new Schema<VisaIndicativeCostSnapshot>(
  {
    embassyFeeInr: { type: Number, min: 0 },
    vfsFeeInr: { type: Number, min: 0 },
    plumtripsServiceFeeInr: { type: Number, min: 0 },
    indicativeVisaCostInr: { type: Number, min: 0 },
    displayMode: { type: String, enum: VISA_RULE_DISPLAY_MODES, required: true },
    totalInr: { type: Number, required: true, min: 0 },
    priceNote: { type: String, trim: true },
  },
  { _id: false },
);

const VisaLinkedBookingSchema = new Schema<VisaLinkedBooking>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: "TravelBooking", required: true },
    service: { type: String, enum: VISA_LINKED_BOOKING_SERVICES, required: true },
    linkedAt: { type: Date, required: true },
    linkedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false },
);

const VisaApplicationSchema = new Schema<VisaApplicationDocument>(
  {
    requestId: { type: Schema.Types.ObjectId, ref: "VisaRequest", required: true, index: true },
    travellerProfileId: {
      type: Schema.Types.ObjectId,
      ref: "TravellerProfile",
      required: true,
      index: true,
    },
    nationality: { type: String, uppercase: true, trim: true, default: null },
    nationalityUnresolved: { type: Boolean, required: true, default: false },

    ruleSnapshot: { type: VisaRuleSnapshotSchema, required: true },
    indicativeCostSnapshot: { type: VisaIndicativeCostSnapshotSchema, required: true },

    linkedBookings: { type: [VisaLinkedBookingSchema], default: [] },

    actualEmbassyFeeInr: { type: Number, min: 0 },
    actualVfsFeeInr: { type: Number, min: 0 },
    actualPlumtripsServiceFeeInr: { type: Number, min: 0 },
    actualTotalInr: { type: Number, min: 0 },

    status: { type: String, enum: VISA_APPLICATION_STATUSES, default: "draft", index: true },
    outcome: { type: String, enum: VISA_APPLICATION_OUTCOMES },

    actionRequiredReason: { type: String, trim: true, default: null },
    actionRequiredSetAt: { type: Date, default: null },
    actionRequiredSetByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    submittedAt: { type: Date },

    visaNumber: { type: String, trim: true },
    visaIssuedAt: { type: Date },
    visaExpiresAt: { type: Date },
  },
  { timestamps: true },
);

VisaApplicationSchema.plugin(workspaceScopePlugin);

// One application per traveller PER REQUEST (see file-header note on scope).
VisaApplicationSchema.index({ requestId: 1, travellerProfileId: 1 }, { unique: true });
// Console/admin queue filtering (own-workspace angle).
VisaApplicationSchema.index({ workspaceId: 1, status: 1 });
// A traveller's application history across requests.
VisaApplicationSchema.index({ workspaceId: 1, travellerProfileId: 1 });
VisaApplicationSchema.index({ workspaceId: 1, createdAt: -1 });
// NOTE: the concierge console queue (routes/admin.visa.ts) queries by
// status ACROSS every workspace — {workspaceId,status} above doesn't serve
// a workspace-less status filter, since workspaceId is its leading field.
// No extra index added for it though: `status`'s own field-level
// `index: true` (above) already produces a single-field {status:1} index,
// which is exactly what that query needs — a second explicit
// VisaApplicationSchema.index({status:1}) here would just be a duplicate.

const VisaApplication: Model<VisaApplicationDocument> =
  mongoose.models.VisaApplication ||
  mongoose.model<VisaApplicationDocument>("VisaApplication", VisaApplicationSchema);

export default VisaApplication;

/**
 * Paired helpers — the ONLY sanctioned way to touch actionRequiredReason/
 * actionRequiredSetAt/actionRequiredSetByUserId (see the doc comment on
 * those fields above). No route should ever $set any one of the three
 * directly; going through these keeps them moving together by
 * construction rather than by every call site remembering to.
 *
 * setActionRequired ALSO sets status — flagging action_required IS the
 * status transition, there's no separate "set the reason" step.
 * clearActionRequired deliberately does NOT touch status — it only nulls
 * the three fields. Clearing back to a resuming status is the caller's
 * (routes/admin.visa.ts's PATCH /applications/:id/status) job, as its own
 * separate update — that route decides which status is legal to resume
 * into, which isn't this model's concern.
 */
export async function setActionRequired(
  applicationId: mongoose.Types.ObjectId | string,
  reason: string,
  userId: mongoose.Types.ObjectId | string,
): Promise<VisaApplicationDocument | null> {
  const trimmed = reason?.trim();
  if (!trimmed) throw new Error("setActionRequired requires a non-empty reason");
  return VisaApplication.findByIdAndUpdate(
    applicationId,
    {
      $set: {
        status: "action_required",
        actionRequiredReason: trimmed,
        actionRequiredSetAt: new Date(),
        actionRequiredSetByUserId: userId,
      },
    },
    { new: true },
  );
}

export async function clearActionRequired(
  applicationId: mongoose.Types.ObjectId | string,
): Promise<VisaApplicationDocument | null> {
  return VisaApplication.findByIdAndUpdate(
    applicationId,
    {
      $set: {
        actionRequiredReason: null,
        actionRequiredSetAt: null,
        actionRequiredSetByUserId: null,
      },
    },
    { new: true },
  );
}
