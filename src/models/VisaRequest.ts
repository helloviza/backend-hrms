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

// Not specified by the source brief — this is a reasonable container-level
// lifecycle: draft (still adding travellers) / active (>=1 application in
// flight) / completed (every application reached a terminal state) /
// cancelled (withdrawn before lodging). Flagged for confirmation in the
// build report — narrower/renamed values are a schema-only change later.
export const VISA_REQUEST_STATUSES = ["draft", "active", "completed", "cancelled"] as const;
export type VisaRequestStatus = (typeof VISA_REQUEST_STATUSES)[number];

export interface VisaRequestDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  raisedByUserId: mongoose.Types.ObjectId; // ref User — who raised this request
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

  // Optional by design (task brief) — set from the concierge console via
  // PATCH /api/admin/visa/requests/:id/concierge (routes/admin.visa.ts,
  // WRITE-gated), never by the applicant. One concierge per REQUEST, not
  // per application — every traveller on the same trip shares one point of
  // contact. Every consumer (the tracking timeline, GET /requests/:id) must
  // degrade to a generic "your concierge team" when this is unset; nothing
  // should ever assume it's populated.
  assignedConciergeUserId?: mongoose.Types.ObjectId; // ref User

  // Screen 5 (review & submit) consent — set ONCE, atomically, by POST
  // /requests/:id/submit (routes/visa.ts), which also uses
  // consentAcceptedAt's null-ness as the idempotency boundary: a request
  // can only be claimed for submission while this is still null. consentVersion
  // records WHICH text (config/visaConsent.ts's VISA_CONSENT_TEXT) was
  // accepted — the wording will change over time, and "they agreed to
  // something at some point" is not an audit record without knowing what.
  consentAcceptedAt?: Date;
  consentAcceptedByUserId?: mongoose.Types.ObjectId; // ref User
  consentVersion?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaRequestSchema = new Schema<VisaRequestDocument>(
  {
    raisedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    destinationIso2: { type: String, required: true, uppercase: true, trim: true },
    purpose: { type: String, enum: VISA_PURPOSES, required: true },
    travelDateFrom: { type: Date },
    travelDateTo: { type: Date },
    referenceNumber: { type: String, unique: true },
    status: { type: String, enum: VISA_REQUEST_STATUSES, default: "draft", index: true },
    applicationIds: { type: [Schema.Types.ObjectId], ref: "VisaApplication", default: [] },
    cancelledAt: { type: Date },
    cancelledByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    assignedConciergeUserId: { type: Schema.Types.ObjectId, ref: "User" },
    // default: null (not undefined) — POST /requests/:id/submit's atomic
    // claim filters on { consentAcceptedAt: null }, and an explicit null
    // keeps that filter's semantics obvious rather than leaning on Mongo's
    // "missing field also matches null" behaviour.
    consentAcceptedAt: { type: Date, default: null },
    consentAcceptedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    consentVersion: { type: String },
  },
  { timestamps: true },
);

VisaRequestSchema.plugin(workspaceScopePlugin);

VisaRequestSchema.index({ workspaceId: 1, raisedByUserId: 1 });
VisaRequestSchema.index({ workspaceId: 1, status: 1 });
VisaRequestSchema.index({ workspaceId: 1, createdAt: -1 });

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

    if (applications.length === 0 || applications.every((a) => a.status === "draft")) {
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
