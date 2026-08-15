// apps/backend/src/models/VisaRequest.ts
//
// Workspace-scoped. One VisaRequest is the customer-facing "trip" container —
// a destination + purpose + travel window raised by one workspace user,
// holding one VisaApplication per traveller (see VisaApplication.ts). The
// applicant-facing reference number is generated here, not by the caller.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import Counter from "./Counter.js";
import { VISA_PURPOSES, type VisaPurpose } from "./VisaRule.js";
import { VISA_CONSENT_CLAUSE_IDS, type VisaConsentClauseId } from "../config/visaConsent.js";
import {
  applyVisaSourceImmutability,
  visaCaseSourcePath,
  type VisaCaseSource,
} from "./visaCaseSource.js";
// TYPE-ONLY import (erased at compile time — no runtime coupling to the
// expense module, and no import cycle). The visa approval chain reuses the
// expenses claim chain's subdocument shape VERBATIM rather than declaring a
// near-identical twin that can silently drift: routes/visa.ts's approve
// route walks it with the same (currentLevel, chain[]) idiom
// routes/expenseReports.ts does, so the two must stay structurally
// identical. The Mongoose schema itself is declared locally below —
// models/Report.ts does not export its subdocument schema.
import type { IApprovalChainLevel } from "./Report.js";

// Not specified by the source brief — this is a reasonable container-level
// lifecycle: draft (still adding travellers) / active (>=1 application in
// flight) / completed (every application reached a terminal state) /
// cancelled (withdrawn before lodging). Flagged for confirmation in the
// build report — narrower/renamed values are a schema-only change later.
export const VISA_REQUEST_STATUSES = ["draft", "active", "completed", "cancelled"] as const;
export type VisaRequestStatus = (typeof VISA_REQUEST_STATUSES)[number];

/**
 * The customer-side approval gate (2026-08-10) — a SEPARATE, AUTHORED axis
 * from `status` above, which stays derived. See
 * infra/design/visa-approval-flow-2026-08-10.md.
 *
 * null (the default, and the steady state for every workspace that has not
 * set config.visaApprovalRequired) means "no gate applies" — submit goes
 * straight to Plumtrips exactly as it always has.
 */
export const VISA_APPROVAL_STATUSES = [
  "pending_approval",
  "approved",
  "declined",
  "clarification_required",
] as const;
export type VisaApprovalStatus = (typeof VISA_APPROVAL_STATUSES)[number];

// One row per clause accepted — a single consentAcceptedAt could no longer
// prove WHICH clause was given once consent split into three independent
// checkboxes (config/visaConsent.ts's VISA_CONSENT_CLAUSES). Each entry
// carries its own version, so a later clause-text change is provable
// per-clause: a request accepted before a wording bump keeps its OLD
// version stamped on it, permanently, regardless of what
// CURRENT_VISA_CONSENT_VERSION becomes afterwards.
export interface VisaConsentRecord {
  clauseId: VisaConsentClauseId;
  version: string;
  acceptedAt: Date;
  acceptedByUserId: mongoose.Types.ObjectId;
}

export interface VisaRequestDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  raisedByUserId: mongoose.Types.ObjectId; // ref User — who raised this request
  // Which Customer this request belongs to (2026-08-01) — a stored, indexed
  // fact, not a derived one. Follows TravelBooking.tenantId's own
  // convention exactly: a loose String (matching User.customerId/
  // businessId's own type — Customer._id is technically an ObjectId, but
  // nothing in this codebase's customer-id fields stores it as one), set
  // ONCE at creation from the raising user's customerId/businessId
  // (routes/visa.ts's POST /requests) and never re-derived afterward — a
  // request's tenancy must not depend on whatever that user's account
  // looks like later (the exact silent-breakage routes/visa.ts's GET
  // /requests used to be exposed to: a raiser's customerId cleared after
  // the fact used to drop their own request out of their own company's
  // scope). null when the raiser has no customerId at all (staff-raised
  // test data, e.g. HOUSE's existing rows) — never guessed from
  // workspaceId, which is exactly the many-Customers-one-workspace
  // ambiguity this field exists to stop depending on.
  customerId: string | null;
  // The CHANNEL this request came in through (Phase 1b, 2026-08-16). The
  // request is the container a channel actually creates — a D2C purchase
  // creates a request — so the channel fact is born here and is copied down
  // onto each child VisaApplication at creation, exactly like customerId.
  //
  // IMMUTABLE after creation (models/visaCaseSource.ts). Defaults to "B2B":
  // every request predating the D2C channel is B2B, as is every request the
  // existing routes/visa.ts POST /requests path creates.
  source: VisaCaseSource;
  destinationIso2: string;
  purpose: VisaPurpose;
  travelDateFrom?: Date;
  travelDateTo?: Date;
  referenceNumber: string; // "HV<YY>-<6-digit sequence>", collision-safe per year (Counter-backed)
  // DERIVED — a rollup of this request's child VisaApplication statuses (and
  // of cancelledAt below). Never assign this directly from a route/handler;
  // it only ever changes via recomputeRequestStatus() below, which is the
  // one sanctioned writer. Routes write FACTS — cancelledAt here, or a
  // VisaApplication status/outcome change — and recomputeRequestStatus()
  // derives status from those facts. Setting status directly lets it drift
  // out of sync with the state it's supposed to summarise.
  status: VisaRequestStatus;
  applicationIds: mongoose.Types.ObjectId[]; // ref VisaApplication, one per traveller

  // AUTHORED — unlike status, routes are permitted to set these directly.
  // Covers the request-abandoned-at-draft case: no VisaApplication was ever
  // submitted, so the status derivation (which only looks at child
  // application states) has no path to "cancelled" without this.
  cancelledAt?: Date;
  cancelledByUserId?: mongoose.Types.ObjectId; // ref User

  // Screen 5 (review & submit) consent — all three clause entries pushed in
  // ONE atomic write by POST /requests/:id/submit (routes/visa.ts), which
  // also uses the array being empty ("consents.0" not existing) as the
  // idempotency boundary: a request can only be claimed for submission
  // while it's still empty. Never partially populated — submit rejects
  // before writing anything unless all three clauses were accepted (see
  // that route's own validation).
  consents: VisaConsentRecord[];

  // ── Customer-side approval gate (2026-08-10) ──────────────────────────
  // AUTHORED, like cancelledAt above — routes write these directly. They are
  // deliberately NOT folded into `status`: that field is a rollup of child
  // application states with recomputeRequestStatus() as its sole writer, and
  // approval is a fact somebody asserted, not a rollup of anything. Keeping
  // the two axes separate is what lets that invariant survive this feature.
  //
  // EVERY field here stays null/empty/false for a workspace that has not set
  // config.visaApprovalRequired — that is the regression line: with the flag
  // off, submit never touches any of them.

  // null = no gate applies (flag off, or the request predates this feature).
  approvalStatus?: VisaApprovalStatus | null;
  // Denorm pointer to the CURRENT pending approver — chain[currentLevel-1].
  // Snapshotted at submit and never re-derived: an approver who loses their
  // admin role mid-flight still owns the decision they were handed.
  approverId?: mongoose.Types.ObjectId | null;
  // Resolved at submit. v1 is always length 1 (no L2, no escalation
  // threshold) — the array and currentLevel exist so adding a second level
  // later is a resolver change, not a route change.
  approvalChain?: IApprovalChainLevel[];
  currentLevel?: number; // 1-based; which chain step is currently pending
  decisionNote?: string | null; // REQUIRED on decline and on request-clarification
  selfApproved?: boolean; // audit marker: approver === requestor
  submittedAt?: Date | null;
  approvedAt?: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaConsentRecordSchema = new Schema<VisaConsentRecord>(
  {
    clauseId: { type: String, enum: VISA_CONSENT_CLAUSE_IDS, required: true },
    version: { type: String, required: true },
    acceptedAt: { type: Date, required: true },
    acceptedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false },
);

/**
 * Approval-chain level subdocument. Mirrors models/Report.ts's
 * ApprovalChainLevelSchema field-for-field, including `_id: false` — these
 * are positional steps addressed by `level`, not standalone documents.
 */
const VisaApprovalChainLevelSchema = new Schema<IApprovalChainLevel>(
  {
    level: { type: Number, required: true },
    approverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: ["pending", "approved", "declined", "clarification_required"],
      default: "pending",
    },
    decidedAt: { type: Date, default: null },
    note: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const VisaRequestSchema = new Schema<VisaRequestDocument>(
  {
    raisedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // TravelBooking.tenantId's convention — String, indexed, alongside
    // workspaceId. null (not "default") when unresolvable — see the
    // interface field's own doc comment above for why.
    customerId: { type: String, default: null, index: true },
    // Channel tag — see the interface field above.
    source: visaCaseSourcePath,
    destinationIso2: { type: String, required: true, uppercase: true, trim: true },
    purpose: { type: String, enum: VISA_PURPOSES, required: true },
    travelDateFrom: { type: Date },
    travelDateTo: { type: Date },
    referenceNumber: { type: String, unique: true },
    status: { type: String, enum: VISA_REQUEST_STATUSES, default: "draft", index: true },
    applicationIds: { type: [Schema.Types.ObjectId], ref: "VisaApplication", default: [] },
    cancelledAt: { type: Date },
    cancelledByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    // default: [] — POST /requests/:id/submit's atomic claim filters on
    // { "consents.0": { $exists: false } }, so an explicit empty array (not
    // just "field absent") keeps that filter's semantics obvious.
    consents: { type: [VisaConsentRecordSchema], default: [] },

    // ── Customer-side approval gate. default null/[]/false throughout, so a
    // workspace with the flag off carries exactly the document it always
    // did. ──
    approvalStatus: { type: String, enum: VISA_APPROVAL_STATUSES, default: null, index: true },
    approverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvalChain: { type: [VisaApprovalChainLevelSchema], default: [] },
    currentLevel: { type: Number, default: 1 },
    decisionNote: { type: String, trim: true, default: null },
    selfApproved: { type: Boolean, default: false },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

VisaRequestSchema.plugin(workspaceScopePlugin);

// The update-path half of `source` immutability — see models/visaCaseSource.ts.
applyVisaSourceImmutability(VisaRequestSchema);

VisaRequestSchema.index({ workspaceId: 1, raisedByUserId: 1 });
VisaRequestSchema.index({ workspaceId: 1, status: 1 });
VisaRequestSchema.index({ workspaceId: 1, createdAt: -1 });
// GET /requests's own org-scope filter (routes/visa.ts) — the primary
// consumer of this field.
VisaRequestSchema.index({ workspaceId: 1, customerId: 1 });
// The approvals queue + its sidebar badge (GET /requests?queue=approvals and
// GET /requests/pending-count, routes/visa.ts): "what is pending, routed to
// me". approverId trails approvalStatus because a seesAll caller queries on
// approvalStatus ALONE — an index led by approverId could not serve that.
VisaRequestSchema.index({ workspaceId: 1, approvalStatus: 1, approverId: 1 });

// Sequential-per-year, collision-safe reference number (Counter is an atomic
// $inc, unlike a countDocuments-based scheme) — matches the design brief's
// explicit requirement that reference numbers be collision-safe and
// sequential per year, not randomly suffixed.
//
// Prefix is HV (Helloviza) — this surface's nav/footer/copy are all
// Helloviza-branded, never Plumtrips. The counter key is its own
// "visaRequestHV:<YY>" namespace, not a reuse of an earlier "visaRequest:<YY>"
// key, so the HV sequence starts clean at 1 rather than silently continuing
// whatever count sat under a differently-prefixed key. No references were
// ever generated under the old scheme, so there's no migration either way —
// this is just defensive: the counter key and the prefix it backs stay in
// lockstep by construction, not by coincidence.
//
// Exported (not inlined in the hook) so it's independently unit-testable
// against a mocked Counter, without needing a live Mongoose connection just
// to exercise a pre-save hook.
export async function mintVisaRequestReferenceNumber(now: Date): Promise<string> {
  const yy = String(now.getFullYear()).slice(2);
  const counterKey = `visaRequestHV:${yy}`;
  const counter = await Counter.findByIdAndUpdate(
    counterKey,
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return `HV${yy}-${String(counter!.seq).padStart(6, "0")}`;
}

VisaRequestSchema.pre("save", async function (next) {
  if (this.isNew && !this.referenceNumber) {
    this.referenceNumber = await mintVisaRequestReferenceNumber(new Date());
  }
  next();
});

const VisaRequest: Model<VisaRequestDocument> =
  mongoose.models.VisaRequest ||
  mongoose.model<VisaRequestDocument>("VisaRequest", VisaRequestSchema);

export default VisaRequest;

/**
 * The ONLY sanctioned way to set VisaRequest.status — no route/handler
 * should assign it directly (see the doc comment on the field above). Call
 * this after any write that changes a child VisaApplication's status
 * (create, status transition, outcome set) or sets cancelledAt, passing the
 * parent requestId.
 *
 * Rollup rule:
 *   - cancelledAt is set                                       -> "cancelled",
 *     regardless of child application states (covers a request abandoned at
 *     draft, before any application was ever submitted — the most common
 *     cancellation case, and otherwise unreachable since every other branch
 *     here only looks at child application states)
 *   - no applications yet, or every application still "draft"  -> "draft"
 *   - every application "closed" AND every outcome "WITHDRAWN" -> "cancelled"
 *   - every application "closed" (any other/mixed outcome)     -> "completed"
 *   - anything else (at least one application has progressed
 *     past draft, but not all are closed yet)                 -> "active"
 *
 * Returns the recomputed status, or null if requestId doesn't resolve to a
 * VisaRequest (nothing to update).
 */
export async function recomputeRequestStatus(
  requestId: mongoose.Types.ObjectId | string,
): Promise<VisaRequestStatus | null> {
  const request = await VisaRequest.findById(requestId).select("cancelledAt").lean();
  if (!request) return null;

  let status: VisaRequestStatus;
  if (request.cancelledAt) {
    status = "cancelled";
  } else {
    // Imported here (not at module top) to avoid a load-order tangle with
    // VisaApplication.ts, which itself only imports VisaRule.ts — no cycle,
    // but keeping the edge local makes that explicit.
    const { default: VisaApplication } = await import("./VisaApplication.js");

    const applications = await VisaApplication.find({ requestId })
      .select("status outcome")
      .lean();

    // "pending_approval" counts as not-yet-a-real-case, exactly like "draft".
    // A request held at the customer's OWN approval gate has not reached
    // Plumtrips, so rolling it up to "active" would tell the roster and the
    // customer dashboard that work is in flight on something we have not
    // even received. Folding it in here (rather than skipping the recompute
    // call at the approval branch) is what keeps this function safe to call
    // after ANY child status change — the contract stated above.
    if (
      applications.length === 0 ||
      applications.every((a) => a.status === "draft" || a.status === "pending_approval")
    ) {
      status = "draft";
    } else if (applications.every((a) => a.status === "closed")) {
      status = applications.every((a) => a.outcome === "WITHDRAWN") ? "cancelled" : "completed";
    } else {
      status = "active";
    }
  }

  const updated = await VisaRequest.findByIdAndUpdate(
    requestId,
    { $set: { status } },
    { new: true },
  ).select("status");

  return updated ? status : null;
}
