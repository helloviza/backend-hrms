// apps/backend/src/models/VisaActivityLog.ts
//
// Append-only per-case activity log — one row per event, across an
// application's (and its parent request's) whole lifecycle. Modelled on
// VisaRuleAudit.ts (its own collection, own performedAt-style timestamp,
// never updated/deleted) rather than on VisaApplication's
// setActionRequired/clearActionRequired: those two mutate CURRENT-value
// fields on the application itself, whereas this collection's entire job
// is to be a history, never a snapshot.
//
// Written EXCLUSIVELY through logVisaActivity() below — no route or
// service ever calls VisaActivityLog.create() directly. A logging failure
// must NEVER fail the operation it describes: logVisaActivity() swallows
// its own errors (logged, not thrown) so every call site can simply
// `await logVisaActivity(...)` with no try/catch of its own.
//
// NO PII IN `detail` — these rows get exported to spreadsheets for
// reporting. Never write passport numbers, extracted field values, or
// document contents into it; reference a document by id/docCode, record
// WHAT changed, never what it said. An action_required (or document
// rejection) reason IS written deliberately — it's the concierge's own
// message, not extracted applicant data, and recording it is the whole
// point of the entry.
//
// No backfill — every application in the system today is test data; this
// collection starts recording from the moment it ships, never synthesises
// history for what came before (task brief).
import mongoose, { Schema, type Document, type Model } from "mongoose";
import logger from "../utils/logger.js";

const visaActivityLogger = logger.child({ module: "VisaActivityLog" });

export const VISA_ACTIVITY_ACTOR_TYPES = ["STAFF", "CUSTOMER", "SYSTEM"] as const;
export type VisaActivityActorType = (typeof VISA_ACTIVITY_ACTOR_TYPES)[number];

export const VISA_ACTIVITY_EVENT_TYPES = [
  // Lifecycle
  "REQUEST_CREATED",
  "APPLICATION_CREATED",
  "SUBMITTED",
  "STATUS_CHANGED",
  "ACTION_REQUIRED_SET",
  "ACTION_REQUIRED_CLEARED",
  "CUSTOMER_RESPONDED",
  "ACTION_REQUIRED_AUTO_CLEARED",
  "OUTCOME_RECORDED",
  "REQUEST_CANCELLED",

  // Customer-side approval gate (2026-08-10). These describe the CUSTOMER'S
  // OWN internal approval of a request, before Plumtrips ever sees it — not
  // anything a concierge did. Only ever written when the workspace opted
  // into config.visaApprovalRequired. See
  // infra/design/visa-approval-flow-2026-08-10.md.
  "APPROVAL_REQUESTED",
  "APPROVED",
  "DECLINED",
  "CLARIFICATION_REQUESTED",

  // Documents
  "DOCUMENT_UPLOADED",
  "DOCUMENT_REPLACED",
  "DOCUMENT_DELETED",
  "DOCUMENT_ACCEPTED",
  "DOCUMENT_REJECTED",

  // Extraction
  "EXTRACTION_STARTED",
  "EXTRACTION_COMPLETED",
  "EXTRACTION_FAILED",
  "FIELDS_CONFIRMED",

  // Assignment
  "CONCIERGE_ASSIGNED",
  "CONCIERGE_CHANGED",
  "CONCIERGE_CLEARED",
  "SCREENING_OFFICER_ASSIGNED",
  "SCREENING_OFFICER_CHANGED",
  "SCREENING_OFFICER_CLEARED",

  // Costs
  "COSTS_RECORDED",

  // Service partner (task brief, 2026-08-01) — which VFS/BLS centre or
  // embassy actually handled the case, set or changed via PATCH
  // /applications/:id/service-partner (routes/admin.visa.ts).
  "SERVICE_PARTNER_SET",

  // Billing
  "MANUAL_BOOKING_CREATED",
  "MANUAL_BOOKING_UPDATED",
  "MANUAL_BOOKING_CANCELLED",
  // Billing sync (services/visaBillingSync.ts) refused to create a
  // ManualBooking because the billing customer couldn't be resolved
  // unambiguously (an ambiguous shared-tenant workspace, or a broken
  // Customer link) — never a wrong booking, but never silent either.
  "MANUAL_BOOKING_SKIPPED",
] as const;
export type VisaActivityEventType = (typeof VISA_ACTIVITY_EVENT_TYPES)[number];

// The trimmed, customer-safe slice surfaced on GET /api/visa/requests/:id
// (routes/visa.ts) — lifecycle and document events only. Extraction,
// assignment, cost, and billing activity are internal concierge-console
// detail and never reach the customer-facing view (task brief).
export const VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES = new Set<VisaActivityEventType>([
  "REQUEST_CREATED",
  "APPLICATION_CREATED",
  "SUBMITTED",
  "STATUS_CHANGED",
  "ACTION_REQUIRED_SET",
  "ACTION_REQUIRED_CLEARED",
  "CUSTOMER_RESPONDED",
  "ACTION_REQUIRED_AUTO_CLEARED",
  "OUTCOME_RECORDED",
  "REQUEST_CANCELLED",
  // The approval gate is the CUSTOMER'S own process — the requestor must be
  // able to see their own request's approval history (who was asked, who
  // decided, and the note they left). Withholding it would hide the reason
  // their own request is sitting still.
  "APPROVAL_REQUESTED",
  "APPROVED",
  "DECLINED",
  "CLARIFICATION_REQUESTED",
  "DOCUMENT_UPLOADED",
  "DOCUMENT_REPLACED",
  "DOCUMENT_DELETED",
  "DOCUMENT_ACCEPTED",
  "DOCUMENT_REJECTED",
]);

export interface VisaActivityLogDocument extends Document {
  // Null only for the two request-level-only events (REQUEST_CREATED,
  // REQUEST_CANCELLED) — a request can hold several applications, so
  // neither event names one in particular. Every other event type always
  // sets this.
  applicationId: mongoose.Types.ObjectId | null; // ref VisaApplication
  requestId: mongoose.Types.ObjectId; // ref VisaRequest
  workspaceId: mongoose.Types.ObjectId; // ref CustomerWorkspace — carried directly (not derived via a join) so a report can slice by tenant without touching VisaApplication at all
  eventType: VisaActivityEventType;
  // Null only for SYSTEM events (extraction, billing sync) — nothing else
  // ever omits it.
  actorUserId: mongoose.Types.ObjectId | null; // ref User
  actorType: VisaActivityActorType;
  at: Date;
  detail: Record<string, unknown>; // event-specific — NEVER PII, see file header

  // Erasure follow-up (2026-07-31) — set ONLY by
  // redactVisaActivityForApplications/redactVisaActivityForRequest below,
  // as part of scripts/erase-visa-request.ts or
  // scripts/erase-traveller-profile.ts. The row itself (eventType, at,
  // requestId/applicationId, actorType) survives an erasure — "a case
  // existed and was worked" is an audit record — but `detail` is wiped
  // wholesale rather than picked over field-by-field: a concierge's free-text
  // reason (actionRequiredReason, a rejection reason) can name the applicant,
  // and that text isn't enumerable as a fixed set of "safe" keys. Never unset
  // once set — redaction is one-way.
  redactedAt?: Date | null;
}

const VisaActivityLogSchema = new Schema<VisaActivityLogDocument>({
  applicationId: { type: Schema.Types.ObjectId, ref: "VisaApplication", default: null },
  requestId: { type: Schema.Types.ObjectId, ref: "VisaRequest", required: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true },
  eventType: { type: String, enum: VISA_ACTIVITY_EVENT_TYPES, required: true },
  actorUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  actorType: { type: String, enum: VISA_ACTIVITY_ACTOR_TYPES, required: true },
  at: { type: Date, required: true, default: Date.now },
  detail: { type: Schema.Types.Mixed, default: {} },
  redactedAt: { type: Date, default: null },
});

// Per-case history (concierge console's activity tab), newest first.
VisaActivityLogSchema.index({ applicationId: 1, at: -1 });
// Per-tenant reports.
VisaActivityLogSchema.index({ workspaceId: 1, at: -1 });
// Per-officer activity.
VisaActivityLogSchema.index({ actorUserId: 1, at: -1 });

const VisaActivityLog: Model<VisaActivityLogDocument> =
  mongoose.models.VisaActivityLog ||
  mongoose.model<VisaActivityLogDocument>("VisaActivityLog", VisaActivityLogSchema);

export default VisaActivityLog;

export interface LogVisaActivityInput {
  applicationId?: mongoose.Types.ObjectId | string | null;
  requestId: mongoose.Types.ObjectId | string;
  workspaceId: mongoose.Types.ObjectId | string;
  eventType: VisaActivityEventType;
  actorUserId?: mongoose.Types.ObjectId | string | null;
  actorType: VisaActivityActorType;
  detail?: Record<string, unknown>;
}

/**
 * The ONE sanctioned writer for this collection — every route/service that
 * needs an activity row calls this, never VisaActivityLog.create()
 * directly (see file header).
 *
 * Deliberately never throws: a logging failure must never fail the
 * operation it describes. Any error creating the row is caught, logged,
 * and swallowed — callers can always `await` this with no try/catch.
 */
export async function logVisaActivity(entry: LogVisaActivityInput): Promise<void> {
  try {
    await VisaActivityLog.create([
      {
        applicationId: entry.applicationId ?? null,
        requestId: entry.requestId,
        workspaceId: entry.workspaceId,
        eventType: entry.eventType,
        actorUserId: entry.actorUserId ?? null,
        actorType: entry.actorType,
        at: new Date(),
        detail: entry.detail ?? {},
      },
    ]);
  } catch (err: any) {
    visaActivityLogger.error("failed to write visa activity log row — underlying operation was NOT rolled back", {
      eventType: entry.eventType,
      applicationId: entry.applicationId ? String(entry.applicationId) : null,
      requestId: entry.requestId ? String(entry.requestId) : null,
      error: err?.message,
    });
  }
}

/**
 * Erasure follow-up — redacts every NOT-YET-redacted row for a set of
 * applicationIds: `detail` is replaced wholesale with {}, `redactedAt` is
 * stamped. The row itself (eventType, at, requestId, applicationId,
 * actorType) is left alone — see the redactedAt field's own doc comment for
 * why the row survives while detail doesn't.
 *
 * Scoped by applicationId (not requestId) — used by
 * scripts/erase-traveller-profile.ts, where a request can hold OTHER
 * travellers' applications whose activity history must not be touched by
 * one traveller's erasure.
 *
 * Unlike logVisaActivity, this DOES throw on failure — a script driving an
 * erasure needs to know if the redaction step didn't complete, not have it
 * silently swallowed.
 */
export async function redactVisaActivityForApplications(
  applicationIds: Array<mongoose.Types.ObjectId | string>,
): Promise<number> {
  if (applicationIds.length === 0) return 0;
  const result = await VisaActivityLog.updateMany(
    { applicationId: { $in: applicationIds }, redactedAt: null },
    { $set: { detail: {}, redactedAt: new Date() } },
  );
  return result.modifiedCount ?? 0;
}

/**
 * Same redaction, scoped by requestId instead — used by
 * scripts/erase-visa-request.ts, where the WHOLE request (every
 * application's rows, plus the two request-level-only event types that
 * carry no applicationId at all — REQUEST_CREATED/REQUEST_CANCELLED) is
 * being erased, so there is no "other traveller's history" to protect.
 */
export async function redactVisaActivityForRequest(
  requestId: mongoose.Types.ObjectId | string,
): Promise<number> {
  const result = await VisaActivityLog.updateMany(
    { requestId, redactedAt: null },
    { $set: { detail: {}, redactedAt: new Date() } },
  );
  return result.modifiedCount ?? 0;
}
