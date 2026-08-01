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
  VISA_CATEGORIES, VISA_ETA_BASES, VISA_RULE_DISPLAY_MODES, VISA_DOC_REQUIREMENT_LEVELS,
  type VisaPurpose, type VisaEntryType, type VisaServiceTier, type VisaProductClass,
  type VisaCategory, type VisaEtaBasis, type VisaRuleDisplayMode,
  type VisaDocumentRequirement, type VisaDocumentRequirementGroup,
} from "./VisaRule.js";
import { VisaApplicantPredicateConditionSchema } from "./visaAttributes.js";
import { VisaApplicantProfileSchema, type VisaApplicantProfile } from "./visaAttributes.js";
import logger from "../utils/logger.js";

const visaApplicationLogger = logger.child({ module: "VisaApplication" });

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
  // Phase 10b — captured going forward (see buildRuleSnapshot,
  // routes/visa.ts) from VisaRule.documentGroups at the same point-in-time
  // as documentRequirements above, so a NEW application preserves full
  // appliesWhen/specification/template fidelity instead of permanently
  // downgrading to the flat legacy shape. Optional/absent on every
  // application created BEFORE this phase — ruleSnapshot is immutable
  // history (file header) and those rows are never rewritten; utils/
  // visaChecklistResolver.ts treats an absent documentGroups exactly like a
  // rule that was never migrated, falling back to documentRequirements.
  documentGroups?: VisaDocumentRequirementGroup[];
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

// One answer to a shared-bank or rule-specific question (VisaRule.ts's
// VisaRuleQuestionRef / VisaRuleInlineQuestion, VisaQuestion.ts). `answer`
// is Mixed since its real type depends on the question's own answerType.
export interface VisaQuestionnaireAnswer {
  questionCode: string;
  answer: unknown;
  answeredAt: Date;
}

export interface VisaApplicationDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  // Copied verbatim from the parent VisaRequest.customerId at creation
  // (routes/visa.ts's POST /requests) — same field, same convention
  // (TravelBooking.tenantId: a loose String, not an ObjectId ref), added
  // here too (2026-08-01) so the concierge console queue and reports can
  // filter by customer without joining back through VisaRequest. null
  // under the exact same conditions the parent request's own customerId
  // is null (staff-raised, no customerId to copy) — never independently
  // derived or backfilled from anything else.
  customerId: string | null;
  requestId: mongoose.Types.ObjectId; // ref VisaRequest
  // ref TravellerProfile — applicant identity, not duplicated here. NULL only
  // after scripts/erase-traveller-profile.ts has run (see travellerErasedAt
  // below) — every OTHER code path that creates or reads an application must
  // keep treating this as populated; routes/visa.ts's POST /requests is what
  // actually guarantees it's set at creation (not a schema-level `required`
  // any more — see the schema field's own comment for why).
  travellerProfileId: mongoose.Types.ObjectId | null;
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

  // Phase 10a (task brief §2) — structured applicant facts (employment,
  // sponsorship, marital status, prior-visa history — models/
  // visaAttributes.ts), used to pick a VisaRule variant (VisaRule.ts's
  // `applicability`) and to filter which document-requirement groups within
  // the matched rule actually apply (`appliesWhen`). Every field is
  // optional/undefined until either inferred (see
  // deriveCorporateApplicantProfileDefaults below) or answered — this is
  // NOT a place to fabricate a value nothing actually confirmed.
  applicantProfile: VisaApplicantProfile;

  // Phase 10a (task brief §7) — answers to the matched rule's questionnaire
  // (VisaRule.questions[]/additionalQuestions[], resolved against the
  // shared VisaQuestion bank). Schema only in this phase — nothing writes
  // to this yet; no submission route exists. `answer` is Mixed since the
  // type varies with the question's own answerType (boolean/string/Date).
  questionnaireAnswers: VisaQuestionnaireAnswer[];

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
  // All FOUR of these (including statusBeforeActionRequired below) are set
  // together and cleared together: whatever route eventually clears
  // action_required MUST null out all four at the same time, never just the
  // status — a stale reason left behind would describe a problem that no
  // longer gates anything, and would misrepresent a NEW action_required
  // episode as a continuation of the old one.
  actionRequiredReason: string | null;
  actionRequiredSetAt: Date | null;
  actionRequiredSetByUserId: mongoose.Types.ObjectId | null; // ref User

  // The status this application was actually IN the moment it was flagged
  // action_required — captured by setActionRequired() so clearActionRequired()
  // can restore it later. Without this, action_required overwrites `status`
  // directly with no record of what it interrupted, and clearing it has no
  // way to know where the application really was (the tracking timeline,
  // track/timelineStages.ts, used to compensate by under-claiming progress
  // from lodgedAt alone). Re-affirming action_required while ALREADY
  // action_required (a fresh reason, same interruption) must NEVER
  // re-capture "action_required" itself over whatever real status is
  // already sitting here — see setActionRequired's own guard.
  statusBeforeActionRequired: VisaApplicationStatus | null;

  // Phase 9f — "responded since we last asked", not "ever responded". Set
  // by routes/visa.ts's document upload route on every customer upload
  // while status is action_required (whether or not that upload completes
  // the checklist — a partial response still stamps this). Nulled out by
  // setActionRequired() below the MOMENT a concierge flags action_required
  // again — a stale stamp from a PRIOR episode would misrepresent a fresh
  // ask as already answered. Deliberately NOT cleared by
  // clearActionRequired() (manual or auto): it stays as evidence of what
  // happened in the episode that just ended, until the next one starts.
  customerRespondedAt: Date | null;

  // Erasure follow-up (2026-08-01, scripts/erase-traveller-profile.ts) — set
  // together with travellerProfileId:null, never independently. The case
  // skeleton (status, dates, ruleSnapshot, assignment, costs) survives a
  // traveller erasure deliberately (task brief: "separate from application
  // deletion"), but the applicant reference itself is gone; this timestamp
  // is what tells a reader "travellerProfileId is null because the traveller
  // was erased" instead of "travellerProfileId is null because something is
  // broken" — a dangling/missing reference with no explanation reads as a
  // bug, an explicit null plus this timestamp reads as a deliberate erasure.
  // Null on every application that has never had its traveller erased.
  travellerErasedAt: Date | null;

  // Billing-sync skip marker (services/visaBillingSync.ts) — set together,
  // never independently, when createVisaWorkStartBooking/
  // syncVisaApplicationBilling could NOT unambiguously resolve a billing
  // customer (an ambiguous shared-tenant workspace, e.g. HOUSE — confirmed
  // 2026-08 as the only tenant where more than one Customer shares a
  // CustomerWorkspace — or a broken Customer link) and therefore refused
  // to create a ManualBooking at all: a missing booking someone notices
  // beats a wrong booking someone invoices. This is how that gets surfaced
  // for a concierge to attach the real booking by hand via the existing
  // manual-bookings form — see admin.visa.ts's GET /queue
  // ?billingSyncSkipped filter. Never auto-cleared by this codebase today:
  // once a concierge creates the real ManualBooking manually, these fields
  // are stale history, not re-checked or re-cleared by anything.
  billingSyncSkippedAt: Date | null;
  // Mirrors services/visaBillingSync.ts's own VisaBillingCustomerSkipReason
  // exactly — duplicated here rather than imported, since a model
  // importing from a service is the wrong dependency direction.
  billingSyncSkipReason: "AMBIGUOUS_CUSTOMER" | "BROKEN_CUSTOMER_LINK" | null;
  billingSyncSkipDetail: string | null;

  // Set the moment this application transitions draft -> submitted (POST
  // /requests/:id/submit, routes/visa.ts) — never on creation, and never
  // touched again after. Distinct from the request-level consent timestamp
  // (VisaRequest.consentAcceptedAt): consent is accepted once for the whole
  // request, submittedAt is per application since a future partial-refile
  // path could in principle submit a subset.
  submittedAt?: Date;

  // Set the moment this application's status transitions cost_confirmed ->
  // lodged (PATCH /applications/:id/status, routes/admin.visa.ts) — never
  // on creation, never touched again after, and never overwritten by the
  // action_required side-branch resuming back into "lodged" (that's the
  // SAME lodging, not a new one). The one timestamp the tracking timeline
  // (screen 6) can lean on to compute an estimated decision window and to
  // date the "Submitted to the mission" stage — see utils/visaEta.ts.
  lodgedAt?: Date;

  visaNumber?: string;
  visaIssuedAt?: Date;
  visaExpiresAt?: Date;

  // Which VFS/BLS centre or embassy actually handled this case (task brief,
  // 2026-08-01) — nothing recorded it before, despite the consent text
  // naming both providers and indicativeCostSnapshot carrying a VFS fee
  // line, so a VFS invoice couldn't be reconciled against cases at all.
  // Free text, NOT an enum — centres open and close, and there's no
  // established vocabulary yet to constrain it to; revisit once there's
  // real data to look at. Natural point to set it is at lodging, but never
  // forced — a concierge may know earlier (a fixed-centre destination) or
  // only later. All three set together, never independently. Fed into
  // services/visaBillingSync.ts as the ManualBooking's supplierName on
  // both create and update — the field that made a VFS invoice
  // unreconcilable in the first place.
  servicePartnerName: string | null;
  servicePartnerSetAt: Date | null;
  servicePartnerSetByUserId: mongoose.Types.ObjectId | null; // ref User

  // Case assignment (Phase 9a) — PER APPLICATION, not per request: a
  // five-traveller request can split across officers, and status already
  // lives at this same grain (actionRequiredReason etc., above). Two
  // independent roles, each optional and independently settable/clearable
  // via PATCH /admin/visa/applications/:id/assignment (routes/admin.visa.ts):
  //   - assignedConcierge*        owns the customer relationship
  //   - assignedScreeningOfficer* checks documents against the checklist
  // Formerly VisaRequest.assignedConciergeUserId (one concierge shared by
  // every traveller on a request) — migrated down to here by migrations/
  // 2026-07-30-migrate-visa-concierge-assignment.ts, then removed from
  // VisaRequest entirely. assignedAt/assignedByUserId are set together with
  // their id field on every assignment (never independently), and all three
  // are cleared together when a role is unassigned.
  assignedConciergeUserId?: mongoose.Types.ObjectId | null; // ref User
  assignedConciergeAssignedAt?: Date | null;
  assignedConciergeAssignedByUserId?: mongoose.Types.ObjectId | null; // ref User

  assignedScreeningOfficerId?: mongoose.Types.ObjectId | null; // ref User
  assignedScreeningOfficerAssignedAt?: Date | null;
  assignedScreeningOfficerAssignedByUserId?: mongoose.Types.ObjectId | null; // ref User

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
    // Phase 10b — see the interface field's own doc comment above. Not
    // `required`/no default array forced — absent (undefined) is the
    // meaningful "old-shape snapshot" state, distinct from an empty array
    // (a new-shape snapshot from a rule that genuinely has zero groups).
    documentGroups: {
      type: [
        {
          key: { type: String, required: true },
          label: { type: String, required: true },
          requirement: { type: String, enum: VISA_DOC_REQUIREMENT_LEVELS, required: true },
          appliesWhen: { type: [VisaApplicantPredicateConditionSchema], default: undefined },
          docTypeCodes: { type: [String], required: true, default: [] },
          specification: { type: String, trim: true },
          templateCode: { type: String, trim: true },
          legacyConditionNote: { type: String, trim: true },
        },
      ],
      default: undefined,
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

const VisaQuestionnaireAnswerSchema = new Schema<VisaQuestionnaireAnswer>(
  {
    questionCode: { type: String, required: true, trim: true, uppercase: true },
    answer: { type: Schema.Types.Mixed, required: true },
    answeredAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const VisaApplicationSchema = new Schema<VisaApplicationDocument>(
  {
    requestId: { type: Schema.Types.ObjectId, ref: "VisaRequest", required: true, index: true },
    // Mirrors the parent VisaRequest's own customerId — see the interface
    // field's doc comment above.
    customerId: { type: String, default: null, index: true },
    // NOT `required: true` — deliberately loosened for scripts/
    // erase-traveller-profile.ts, which sets this to null (see
    // travellerErasedAt below). Every application is still created WITH one:
    // routes/visa.ts's POST /requests resolves and validates every
    // travellerProfileId before building applicationInputs, so schema-level
    // `required` was only ever a redundant backstop over that, never the
    // only thing enforcing it.
    travellerProfileId: {
      type: Schema.Types.ObjectId,
      ref: "TravellerProfile",
      default: null,
      index: true,
    },
    nationality: { type: String, uppercase: true, trim: true, default: null },
    nationalityUnresolved: { type: Boolean, required: true, default: false },

    applicantProfile: { type: VisaApplicantProfileSchema, default: () => ({}) },
    questionnaireAnswers: { type: [VisaQuestionnaireAnswerSchema], default: [] },

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
    statusBeforeActionRequired: { type: String, enum: VISA_APPLICATION_STATUSES, default: null },
    customerRespondedAt: { type: Date, default: null },
    travellerErasedAt: { type: Date, default: null },

    billingSyncSkippedAt: { type: Date, default: null },
    billingSyncSkipReason: { type: String, enum: ["AMBIGUOUS_CUSTOMER", "BROKEN_CUSTOMER_LINK"], default: null },
    billingSyncSkipDetail: { type: String, trim: true, default: null },

    submittedAt: { type: Date },
    lodgedAt: { type: Date },

    visaNumber: { type: String, trim: true },
    visaIssuedAt: { type: Date },
    visaExpiresAt: { type: Date },

    servicePartnerName: { type: String, trim: true, default: null },
    servicePartnerSetAt: { type: Date, default: null },
    servicePartnerSetByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    assignedConciergeUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    assignedConciergeAssignedAt: { type: Date, default: null },
    assignedConciergeAssignedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    assignedScreeningOfficerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    assignedScreeningOfficerAssignedAt: { type: Date, default: null },
    assignedScreeningOfficerAssignedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

VisaApplicationSchema.plugin(workspaceScopePlugin);

// One application per traveller PER REQUEST (see file-header note on scope).
// partialFilterExpression excludes travellerProfileId:null from the
// uniqueness constraint — without it, a SECOND traveller erasure on the same
// request (two applications both nulled out) would collide on a duplicate
// {requestId, null} key and throw. Once erased, "one per traveller" no
// longer means anything for that row; the constraint should only ever apply
// while travellerProfileId is a real reference.
VisaApplicationSchema.index(
  { requestId: 1, travellerProfileId: 1 },
  { unique: true, partialFilterExpression: { travellerProfileId: { $type: "objectId" } } },
);
// Console/admin queue filtering (own-workspace angle).
VisaApplicationSchema.index({ workspaceId: 1, status: 1 });
// A traveller's application history across requests.
VisaApplicationSchema.index({ workspaceId: 1, travellerProfileId: 1 });
VisaApplicationSchema.index({ workspaceId: 1, createdAt: -1 });
// Concierge console queue filters (routes/admin.visa.ts's GET /queue) —
// cross-workspace, same posture as the {status:1} note below.
VisaApplicationSchema.index({ assignedConciergeUserId: 1 });
VisaApplicationSchema.index({ assignedScreeningOfficerId: 1 });
// Reconciling a partner invoice against cases (routes/admin.visa.ts's GET
// /queue ?servicePartnerName filter) — same cross-workspace posture as the
// two indexes above.
VisaApplicationSchema.index({ servicePartnerName: 1 });
// Filtering the console queue/reports by customer without joining back
// through VisaRequest (task brief, 2026-08-01).
VisaApplicationSchema.index({ workspaceId: 1, customerId: 1 });
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
 * actionRequiredSetAt/actionRequiredSetByUserId/statusBeforeActionRequired
 * (see the doc comment on those fields above). No route should ever $set
 * any one of the four directly; going through these keeps them moving
 * together by construction rather than by every call site remembering to.
 *
 * setActionRequired ALSO sets status — flagging action_required IS the
 * status transition, there's no separate "set the reason" step. It captures
 * the CURRENT status into statusBeforeActionRequired before overwriting it —
 * except when the application is ALREADY action_required (re-affirming with
 * a fresh reason): in that case `status` reads "action_required" itself,
 * and capturing THAT would permanently corrupt the one record of where the
 * application really was. The already-captured value is kept as-is instead.
 *
 * clearActionRequired now RESTORES status from statusBeforeActionRequired
 * (previously this was the caller's job, as its own separate update — see
 * routes/admin.visa.ts's PATCH /applications/:id/status) — that's the whole
 * point of capturing it. Falls back to "submitted" (logged) if it's
 * somehow absent, rather than guessing a later stage no evidence supports.
 */
export async function setActionRequired(
  applicationId: mongoose.Types.ObjectId | string,
  reason: string,
  userId: mongoose.Types.ObjectId | string,
): Promise<VisaApplicationDocument | null> {
  const trimmed = reason?.trim();
  if (!trimmed) throw new Error("setActionRequired requires a non-empty reason");

  const current = await VisaApplication.findById(applicationId)
    .select("status statusBeforeActionRequired")
    .lean();
  if (!current) return null;

  // Guard against corrupting the capture: re-affirming action_required
  // while already action_required must never overwrite the real interrupted
  // status with the literal string "action_required".
  const statusBeforeActionRequired: VisaApplicationStatus | null =
    (current as any).status === "action_required"
      ? ((current as any).statusBeforeActionRequired ?? null)
      : ((current as any).status as VisaApplicationStatus);

  return VisaApplication.findByIdAndUpdate(
    applicationId,
    {
      $set: {
        status: "action_required",
        actionRequiredReason: trimmed,
        actionRequiredSetAt: new Date(),
        actionRequiredSetByUserId: userId,
        statusBeforeActionRequired,
        // Phase 9f — a fresh ask starts unanswered, even if a PRIOR
        // action_required episode on this same application was responded
        // to (and cleared) before. Nulled here, not in clearActionRequired
        // below — see customerRespondedAt's own doc comment above.
        customerRespondedAt: null,
      },
    },
    { new: true },
  );
}

export async function clearActionRequired(
  applicationId: mongoose.Types.ObjectId | string,
): Promise<VisaApplicationDocument | null> {
  const current = await VisaApplication.findById(applicationId).select("statusBeforeActionRequired").lean();
  if (!current) return null;

  let restoredStatus = (current as any).statusBeforeActionRequired as VisaApplicationStatus | null;
  if (!restoredStatus) {
    // Never silently pick a later stage — "submitted" is the earliest
    // legal resume point, so this can only under-claim progress, never
    // fabricate a stage nothing confirms was actually reached.
    restoredStatus = "submitted";
    visaApplicationLogger.warn("clearActionRequired: statusBeforeActionRequired missing, falling back to 'submitted'", {
      applicationId: String(applicationId),
    });
  }

  return VisaApplication.findByIdAndUpdate(
    applicationId,
    {
      $set: {
        status: restoredStatus,
        actionRequiredReason: null,
        actionRequiredSetAt: null,
        actionRequiredSetByUserId: null,
        statusBeforeActionRequired: null,
      },
    },
    { new: true },
  );
}

/**
 * Erasure follow-up (2026-08-01) — the guard every mutation that advances
 * or adds to a case must call BEFORE writing anything, once
 * travellerErasedAt is set (scripts/erase-traveller-profile.ts). The real
 * rule isn't "don't create an empty ManualBooking" (that was just how the
 * gap first surfaced, in visaBillingSync.ts) — it's that continuing to
 * process a case for someone who exercised their erasure right is the
 * problem, everywhere: status transitions (including the action_required
 * side-branch), document upload/review, cost capture, outcome capture,
 * assignment, and the billing sync all call this first and reject with
 * VISA_APPLICATION_ERASED_MESSAGE if it returns true. Status is NEVER
 * rewritten by this guard or by anything reacting to it — the application
 * stays exactly where erasure found it (task brief: rewriting history to
 * tidy up the UI is the wrong trade). READ paths (GET /queue, GET
 * /applications/:id) never call this — the case skeleton stays visible for
 * audit either way.
 */
export const VISA_APPLICATION_ERASED_MESSAGE =
  "This traveller's data has been erased under a data-erasure request — this application can no longer be progressed.";

export function isTravellerErased(
  application: { travellerErasedAt?: Date | null } | null | undefined,
): boolean {
  return !!application?.travellerErasedAt;
}
