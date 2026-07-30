// apps/backend/src/routes/admin.visa.ts
//
// Phase 6a — the concierge console API. STAFF routes, cross-workspace by
// design (docs/audits/visa-module-recon.md §3, §9): an agent works
// applications belonging to MANY different customer workspaces from one
// queue, so — unlike every route in routes/visa.ts — these never call
// requireWorkspace and never filter a query on req.workspaceObjectId.
// Every query here is scoped by _id (or an explicit ?workspaceId= filter
// the caller supplied on purpose, for the queue), never by the caller's
// own workspace.
//
// Gating is purely the visaApplication permission key (wired in phase 2a —
// UserPermission.ts / levelTemplates.ts / featureToModules.ts /
// AccessConsole.tsx — but never enforced by any route until now):
//   READ  -> GET /queue, GET /applications/:id
//   WRITE -> PATCH .../status, PATCH /documents/:id/review
//   FULL  -> PATCH .../costs, PATCH .../outcome
// requirePermission() already gives SUPERADMIN a bypass; no separate role
// check is layered on top here.
//
// Mounted at /api/admin/visa (server.ts) with no requireWorkspace and no
// requireFeature — same shape as routes/admin.sessions.ts (requireAuth +
// a permission/role gate, nothing tenancy-related at mount time).
//
// No frontend, no console UI yet — this is the API the concierge console
// will call in a later phase.

import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import VisaApplication, {
  VISA_APPLICATION_STATUSES,
  VISA_APPLICATION_OUTCOMES,
  setActionRequired,
  clearActionRequired,
  type VisaApplicationStatus,
  type VisaApplicationOutcome,
} from "../models/VisaApplication.js";
import VisaRequest, { recomputeRequestStatus } from "../models/VisaRequest.js";
import VisaDocument from "../models/VisaDocument.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { visaDocumentUploadMw, createVisaDocumentUpload } from "./visa.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";

const router = Router();
const adminVisaLogger = logger.child({ module: "admin.visa" });

router.use(requireAuth);

function actorId(req: any): any {
  return req.user?._id ?? req.user?.id ?? req.user?.sub;
}

function travellerDisplayName(t: any): string {
  return [t?.firstName, t?.middleName, t?.lastName].filter(Boolean).join(" ");
}

/* ─────────────────────────────────────────────────────────────────────
 * Shared shaping helpers.
 * ───────────────────────────────────────────────────────────────────── */

// Never includes s3Key or a presigned URL (same posture as routes/visa.ts's
// customer-facing mapDocumentSummary) — but DOES include reviewedBy/
// reviewedAt/rejectionReason, which the customer view never needed. Also
// carries the FULL extractedFields array — the mismatch_*/identity_mismatch_*
// entries services/visaPassportExtraction.ts already writes into it ARE the
// "cross-check mismatches" this phase's brief asks for; nothing new is
// computed here, they're just not stripped out the way the customer routes
// don't strip them either.
function mapAdminDocumentSummary(d: any) {
  return {
    id: String(d._id),
    applicationId: String(d.applicationId),
    docCode: d.docCode,
    version: d.version,
    originalFilename: d.originalFilename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    uploadedByUserId: d.uploadedByUserId ? String(d.uploadedByUserId) : null,
    uploadedAt: d.createdAt,
    extractionStatus: d.extractionStatus,
    extractedFields: d.extractedFields || [],
    extractionConfidence: d.extractionConfidence ?? null,
    reviewStatus: d.reviewStatus,
    reviewedBy: d.reviewedBy ? String(d.reviewedBy) : null,
    reviewedAt: d.reviewedAt ?? null,
    rejectionReason: d.rejectionReason ?? null,
  };
}

function mapAdminApplicationSummary(a: any) {
  return {
    id: String(a._id),
    requestId: String(a.requestId),
    workspaceId: String(a.workspaceId),
    travellerProfileId: String(a.travellerProfileId),
    status: a.status,
    outcome: a.outcome ?? null,
    actionRequiredReason: a.actionRequiredReason ?? null,
    actionRequiredSetAt: a.actionRequiredSetAt ?? null,
    actionRequiredSetByUserId: a.actionRequiredSetByUserId ? String(a.actionRequiredSetByUserId) : null,
    nationality: a.nationality ?? null,
    nationalityUnresolved: a.nationalityUnresolved,
    ruleSnapshot: a.ruleSnapshot,
    indicativeCostSnapshot: a.indicativeCostSnapshot,
    actualEmbassyFeeInr: a.actualEmbassyFeeInr ?? null,
    actualVfsFeeInr: a.actualVfsFeeInr ?? null,
    actualPlumtripsServiceFeeInr: a.actualPlumtripsServiceFeeInr ?? null,
    actualTotalInr: a.actualTotalInr ?? null,
    submittedAt: a.submittedAt ?? null,
    visaNumber: a.visaNumber ?? null,
    visaIssuedAt: a.visaIssuedAt ?? null,
    visaExpiresAt: a.visaExpiresAt ?? null,
    linkedBookings: a.linkedBookings || [],
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /queue — cross-workspace list of applications.
 *
 * Deliberately NOT an aggregation pipeline with $lookup — separate finds
 * plus in-memory Map joins, same style routes/visa.ts's own
 * hydrateApplicationsWithTravellers already uses for its (single-
 * workspace) join. At this module's real scale that's simpler to read,
 * test, and reason about than a multi-stage pipeline, and avoids hard-
 * coding collection name strings a schema change could silently break.
 *
 * Sort is urgency, not arrival (task brief): action_required rows always
 * sort above everything else, then soonest travelDateFrom first (a
 * request with no travel dates set sorts to the very end, never the
 * front, via the sentinel below).
 * ───────────────────────────────────────────────────────────────────── */
const FAR_FUTURE_SENTINEL = new Date(8640000000000000);

router.get("/queue", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter: any = {};

    if (req.query.status != null) {
      const status = String(req.query.status).trim();
      if (!VISA_APPLICATION_STATUSES.includes(status as VisaApplicationStatus)) {
        return res.status(400).json({ error: `status must be one of ${VISA_APPLICATION_STATUSES.join(", ")}` });
      }
      filter.status = status;
    } else {
      // Nothing for ops to do with a draft application — the customer
      // hasn't even submitted it yet. Excluded by default; still
      // reachable with an explicit ?status=draft if ever needed.
      filter.status = { $ne: "draft" };
    }

    if (req.query.actionRequired === "true") {
      filter.status = "action_required";
    } else if (req.query.actionRequired === "false") {
      // Combine with whatever the status filter above already set, rather
      // than clobbering it — e.g. ?status=lodged&actionRequired=false
      // should still mean "lodged", not "anything but action_required".
      filter.$and = [{ status: filter.status }, { status: { $ne: "action_required" } }];
      delete filter.status;
    }

    if (req.query.workspaceId != null) {
      if (!mongoose.isValidObjectId(req.query.workspaceId)) {
        return res.status(400).json({ error: "workspaceId is not a valid id" });
      }
      filter.workspaceId = new mongoose.Types.ObjectId(req.query.workspaceId);
    }

    const applications = await VisaApplication.find(filter).lean();

    const requestIds = [...new Set(applications.map((a: any) => String(a.requestId)))];
    const requests = await VisaRequest.find({ _id: { $in: requestIds } })
      .select("referenceNumber destinationIso2 purpose travelDateFrom travelDateTo status")
      .lean();
    const requestById = new Map(requests.map((r: any) => [String(r._id), r]));

    const destinationFilter = req.query.destination ? String(req.query.destination).trim().toUpperCase() : null;

    let rows = applications
      .map((a: any) => ({ application: a, request: requestById.get(String(a.requestId)) || null }))
      .filter(({ request }) => !destinationFilter || request?.destinationIso2 === destinationFilter);

    const workspaceIds = [...new Set(rows.map((r) => String(r.application.workspaceId)))];
    const workspaces = await CustomerWorkspace.find({ _id: { $in: workspaceIds } })
      .select("companyName")
      .lean();
    const workspaceById = new Map(workspaces.map((w: any) => [String(w._id), w]));

    const travellerIds = [...new Set(rows.map((r) => String(r.application.travellerProfileId)))];
    const travellers = await TravellerProfile.find({ _id: { $in: travellerIds } })
      .select("firstName middleName lastName")
      .lean();
    const travellerById = new Map(travellers.map((t: any) => [String(t._id), t]));

    // Urgency first (action_required surfaces above everything), then
    // soonest travel date. Array#sort is stable in Node, so rows with an
    // identical rank+date keep their original (createdAt-independent, but
    // deterministic-per-query) relative order rather than reshuffling
    // across requests.
    rows.sort((x, y) => {
      const rankX = x.application.status === "action_required" ? 0 : 1;
      const rankY = y.application.status === "action_required" ? 0 : 1;
      if (rankX !== rankY) return rankX - rankY;
      const dateX = x.request?.travelDateFrom ? new Date(x.request.travelDateFrom).getTime() : FAR_FUTURE_SENTINEL.getTime();
      const dateY = y.request?.travelDateFrom ? new Date(y.request.travelDateFrom).getTime() : FAR_FUTURE_SENTINEL.getTime();
      return dateX - dateY;
    });

    const total = rows.length;
    const start = (page - 1) * limit;
    const pageRows = rows.slice(start, start + limit);

    const shaped = pageRows.map(({ application: a, request: r }) => {
      const workspace = workspaceById.get(String(a.workspaceId)) || null;
      const traveller = travellerById.get(String(a.travellerProfileId)) || null;
      return {
        id: String(a._id),
        status: a.status,
        actionRequiredReason: a.actionRequiredReason ?? null,
        submittedAt: a.submittedAt ?? null,
        destinationName: a.ruleSnapshot?.destinationName ?? null,
        purpose: a.ruleSnapshot?.purpose ?? null,
        serviceTier: a.ruleSnapshot?.serviceTier ?? null,
        workspace: { id: String(a.workspaceId), name: workspace?.companyName ?? null },
        request: r
          ? {
              id: String(r._id),
              referenceNumber: r.referenceNumber,
              destinationIso2: r.destinationIso2,
              purpose: r.purpose,
              travelDateFrom: r.travelDateFrom ?? null,
              travelDateTo: r.travelDateTo ?? null,
            }
          : null,
        traveller: traveller ? { id: String(traveller._id), name: travellerDisplayName(traveller) } : null,
      };
    });

    res.json({
      ok: true,
      applications: shaped,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err: any) {
    console.error("[admin visa queue GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the visa queue" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /applications/:id — full cross-workspace detail. MAY return the
 * unmasked passport number (task brief: the deliberately reserved case
 * from the customer routes' maskTailId masking) — logged every access,
 * below, precisely because of that.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/applications/:id", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Visa application not found" });
    }

    const application = await VisaApplication.findById(id).lean();
    if (!application) return res.status(404).json({ error: "Visa application not found" });

    const [visaRequest, traveller, workspace, documents] = await Promise.all([
      VisaRequest.findById((application as any).requestId).lean(),
      TravellerProfile.findById((application as any).travellerProfileId).lean(),
      CustomerWorkspace.findById((application as any).workspaceId).select("companyName customerId").lean(),
      VisaDocument.find({ applicationId: (application as any)._id, deletedAt: null })
        .sort({ docCode: 1, version: -1 })
        .lean(),
    ]);

    const requestedBy = actorId(req);
    adminVisaLogger.info("visa application detail accessed (unmasked passport)", {
      userId: requestedBy ? String(requestedBy) : null,
      applicationId: String((application as any)._id),
      workspaceId: String((application as any).workspaceId),
      accessedAt: new Date().toISOString(),
    });

    res.json({
      ok: true,
      application: mapAdminApplicationSummary(application),
      traveller: traveller
        ? {
            id: String((traveller as any)._id),
            name: travellerDisplayName(traveller),
            dob: (traveller as any).dob ?? null,
            email: (traveller as any).email ?? null,
            nationality: (traveller as any).nationality ?? null,
            // Unmasked — see file header. Every customer-facing route
            // masks this with maskTailId(); this route is the reserved
            // exception.
            passportNo: (traveller as any).passportNo ?? null,
            passportExpiry: (traveller as any).passportExpiry ?? null,
            passportIssueCountry: (traveller as any).passportIssueCountry ?? null,
            passportIssueDate: (traveller as any).passportIssueDate ?? null,
          }
        : null,
      request: visaRequest || null,
      workspace: workspace
        ? { id: String((workspace as any)._id), name: (workspace as any).companyName, customerId: (workspace as any).customerId }
        : null,
      documents: documents.map(mapAdminDocumentSummary),
    });
  } catch (err: any) {
    console.error("[admin visa application detail GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load visa application" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /applications/:id/status — the state machine.
 *
 *   submitted -> docs_under_review -> cost_confirmed -> lodged
 *              -> decision_received -> closed
 *
 * lodged -> decision_received is deliberately NOT a legal move here — that
 * transition only ever happens through PATCH /applications/:id/outcome,
 * together with recording the actual outcome. draft -> submitted is also
 * not reachable here — that's the customer's own POST
 * /requests/:id/submit (routes/visa.ts).
 *
 * action_required is a side-branch, not a step in the chain above: settable
 * from any pre-decision state (submitted/docs_under_review/cost_confirmed/
 * lodged), or re-affirmable (with a fresh reason) while already
 * action_required. Clearing it back accepts any of those same four
 * resuming states — the caller (the concierge) decides which one it
 * actually resumes into; nothing here tries to remember "the" one state it
 * was raised from.
 * ───────────────────────────────────────────────────────────────────── */
const PRE_DECISION_STATUSES: VisaApplicationStatus[] = ["submitted", "docs_under_review", "cost_confirmed", "lodged"];
const ACTION_REQUIRED_ELIGIBLE = new Set<string>([...PRE_DECISION_STATUSES, "action_required"]);

const STATUS_FORWARD_TRANSITIONS: Record<string, VisaApplicationStatus[]> = {
  draft: [],
  submitted: ["docs_under_review"],
  docs_under_review: ["cost_confirmed"],
  cost_confirmed: ["lodged"],
  lodged: [],
  decision_received: ["closed"],
  closed: [],
  action_required: [], // handled as its own branch below, never via this table
};

router.patch("/applications/:id/status", requirePermission("visaApplication", "WRITE"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Visa application not found" });
    }

    const target = String(req.body?.status || "").trim();
    if (!VISA_APPLICATION_STATUSES.includes(target as VisaApplicationStatus)) {
      return res.status(400).json({ error: `status must be one of ${VISA_APPLICATION_STATUSES.join(", ")}` });
    }

    const application = await VisaApplication.findById(id);
    if (!application) return res.status(404).json({ error: "Visa application not found" });
    const current = application.status;

    if (target === "action_required") {
      if (!ACTION_REQUIRED_ELIGIBLE.has(current)) {
        return res.status(400).json({ error: `Cannot set action_required from '${current}'`, current, target });
      }
      const reason = String(req.body?.reason || "").trim();
      if (!reason) {
        return res.status(400).json({ error: "reason is required to set action_required" });
      }
      await setActionRequired(id, reason, actorId(req));
    } else if (current === "action_required") {
      // Clearing back — legal into any of the normal resumption points.
      if (!PRE_DECISION_STATUSES.includes(target as VisaApplicationStatus)) {
        return res.status(400).json({ error: `Cannot clear action_required into '${target}'`, current, target });
      }
      await clearActionRequired(id);
      await VisaApplication.updateOne({ _id: id }, { $set: { status: target } });
    } else {
      const allowed = STATUS_FORWARD_TRANSITIONS[current] || [];
      if (!allowed.includes(target as VisaApplicationStatus)) {
        return res.status(400).json({
          error: `Illegal transition from '${current}' to '${target}'`,
          current,
          target,
          allowed,
        });
      }
      // Filter on the status we READ, not just _id — a concurrent change
      // between the read above and this write loses the race cleanly
      // (409), rather than silently clobbering whatever the other caller
      // just set.
      const updated = await VisaApplication.findOneAndUpdate(
        { _id: id, status: current },
        { $set: { status: target } },
        { new: true },
      );
      if (!updated) {
        return res.status(409).json({ error: "This application's status changed concurrently — please retry." });
      }
    }

    // status is DERIVED on VisaRequest — never assigned directly. Same rule
    // every route in routes/visa.ts already follows.
    await recomputeRequestStatus(application.requestId);

    const fresh = await VisaApplication.findById(id).lean();
    res.json({ ok: true, application: mapAdminApplicationSummary(fresh) });
  } catch (err: any) {
    console.error("[admin visa application status PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update application status" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /documents/:id/review — accept or reject one document.
 * Never deletes on rejection — the applicant needs to see what was
 * rejected and why (task brief).
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/documents/:id/review", requirePermission("visaApplication", "WRITE"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Document not found" });
    }

    const reviewStatus = String(req.body?.reviewStatus || "").trim().toUpperCase();
    if (reviewStatus !== "VERIFIED" && reviewStatus !== "REJECTED") {
      return res.status(400).json({ error: "reviewStatus must be VERIFIED or REJECTED" });
    }

    let rejectionReason = "";
    if (reviewStatus === "REJECTED") {
      rejectionReason = String(req.body?.rejectionReason || "").trim();
      if (!rejectionReason) {
        return res.status(400).json({ error: "rejectionReason is required to reject a document" });
      }
    }

    const update: any = {
      $set: { reviewStatus, reviewedBy: actorId(req), reviewedAt: new Date() },
    };
    if (reviewStatus === "REJECTED") {
      update.$set.rejectionReason = rejectionReason;
    } else {
      // Re-verifying (possibly after a prior rejection) — the old reason
      // no longer describes anything current.
      update.$unset = { rejectionReason: "" };
    }

    const doc = await VisaDocument.findOneAndUpdate({ _id: id, deletedAt: null }, update, { new: true });
    if (!doc) return res.status(404).json({ error: "Document not found" });

    res.json({ ok: true, document: mapAdminDocumentSummary(doc) });
  } catch (err: any) {
    console.error("[admin visa document review PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to review document" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /documents/:id/url — short-TTL presigned GET for the concierge
 * console's document viewer. Mirrors routes/visa.ts's own
 * GET /documents/:documentId/url (same presignGetObject call, same
 * ownership-verified-at-signing-time posture — never trust the queue/detail
 * response having already "shown" this document as proof of the right to
 * sign it now), scoped by _id only rather than workspaceId: this router is
 * cross-workspace by design (file header), so there is no caller workspace
 * to re-verify against here — READ on the visaApplication permission key is
 * the only gate.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/documents/:id/url", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Document not found" });
    }

    const doc = await VisaDocument.findOne({ _id: id, deletedAt: null }).lean();
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const url = await presignGetObject({
      bucket: env.S3_BUCKET,
      key: (doc as any).s3Key,
      filename: (doc as any).originalFilename,
      expiresInSeconds: env.PRESIGN_TTL,
      view: true,
      contentType: (doc as any).mimeType,
    });

    adminVisaLogger.info("admin visa document presigned URL issued", {
      documentId: String((doc as any)._id),
      applicationId: String((doc as any).applicationId),
      userId: actorId(req) ? String(actorId(req)) : null,
      requestedAt: new Date().toISOString(),
    });

    res.json({ ok: true, url, expiresIn: env.PRESIGN_TTL });
  } catch (err: any) {
    console.error("[admin visa document url GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to generate document URL" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /applications/:id/costs — record actual fees against the
 * indicative snapshot. indicativeCostSnapshot is NEVER touched — it's
 * what the customer saw (task brief).
 *
 * Hybrid gate — a reason is required once EITHER threshold is breached:
 *   - VISA_COST_VARIANCE_REASON_THRESHOLD_INR: a flat floor (₹2,000).
 *   - VISA_COST_VARIANCE_REASON_THRESHOLD_PERCENT: 15% of the indicative
 *     total.
 * A flat floor alone lets a ₹354 corridor swing 565% unremarked; a
 * percentage alone demands a reason on a ₹26,689 corridor for a mere 7.5%
 * FX-rounding-sized move. Combining them (OR, not AND) catches both a small
 * application moving disproportionately and a large one moving by an
 * absolute amount that matters, without over-triggering on the other end
 * of the catalogue.
 * ───────────────────────────────────────────────────────────────────── */
export const VISA_COST_VARIANCE_REASON_THRESHOLD_INR = 2000;
export const VISA_COST_VARIANCE_REASON_THRESHOLD_PERCENT = 0.15;

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

router.patch("/applications/:id/costs", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Visa application not found" });
    }

    const { actualEmbassyFeeInr, actualVfsFeeInr, actualPlumtripsServiceFeeInr, reason } = req.body || {};
    const fees: Record<string, unknown> = { actualEmbassyFeeInr, actualVfsFeeInr, actualPlumtripsServiceFeeInr };
    for (const [key, value] of Object.entries(fees)) {
      if (!isNonNegativeNumber(value)) {
        return res.status(400).json({ error: `${key} must be a non-negative number` });
      }
    }

    const application = await VisaApplication.findById(id);
    if (!application) return res.status(404).json({ error: "Visa application not found" });

    const actualTotalInr =
      (actualEmbassyFeeInr as number) + (actualVfsFeeInr as number) + (actualPlumtripsServiceFeeInr as number);
    const indicativeTotalInr = application.indicativeCostSnapshot?.totalInr ?? 0;
    const varianceInr = actualTotalInr - indicativeTotalInr;
    const absVarianceInr = Math.abs(varianceInr);
    const percentThresholdInr = indicativeTotalInr * VISA_COST_VARIANCE_REASON_THRESHOLD_PERCENT;
    const floorBreached = absVarianceInr > VISA_COST_VARIANCE_REASON_THRESHOLD_INR;
    const percentBreached = absVarianceInr > percentThresholdInr;
    const reasonRequired = floorBreached || percentBreached;

    const varianceInfo = {
      amountInr: varianceInr,
      thresholdInr: VISA_COST_VARIANCE_REASON_THRESHOLD_INR,
      thresholdPercent: VISA_COST_VARIANCE_REASON_THRESHOLD_PERCENT,
      percentThresholdInr,
      floorBreached,
      percentBreached,
      reasonRequired,
    };

    if (reasonRequired && !String(reason || "").trim()) {
      const breachedBy = floorBreached && percentBreached ? "both the flat and percentage" : floorBreached ? "the flat" : "the percentage";
      return res.status(400).json({
        error: `A reason is required — variance of ₹${varianceInr} exceeds ${breachedBy} threshold (₹${VISA_COST_VARIANCE_REASON_THRESHOLD_INR} floor / ${VISA_COST_VARIANCE_REASON_THRESHOLD_PERCENT * 100}% of ₹${indicativeTotalInr})`,
        variance: varianceInfo,
      });
    }

    // Only the actual-fee fields move. indicativeCostSnapshot is untouched.
    application.actualEmbassyFeeInr = actualEmbassyFeeInr as number;
    application.actualVfsFeeInr = actualVfsFeeInr as number;
    application.actualPlumtripsServiceFeeInr = actualPlumtripsServiceFeeInr as number;
    application.actualTotalInr = actualTotalInr;
    await application.save();

    if (reasonRequired) {
      adminVisaLogger.info("visa cost variance recorded above threshold", {
        applicationId: String(application._id),
        userId: actorId(req) ? String(actorId(req)) : null,
        varianceInr,
        thresholdInr: VISA_COST_VARIANCE_REASON_THRESHOLD_INR,
        thresholdPercent: VISA_COST_VARIANCE_REASON_THRESHOLD_PERCENT,
        floorBreached,
        percentBreached,
        reason: String(reason).trim(),
        recordedAt: new Date().toISOString(),
      });
    }

    res.json({
      ok: true,
      application: mapAdminApplicationSummary(application.toObject()),
      variance: varianceInfo,
    });
  } catch (err: any) {
    console.error("[admin visa application costs PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to record costs" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /applications/:id/outcome — record the decision. Moves status to
 * decision_received (never all the way to "closed" — that's a separate,
 * later PATCH /status call once the case is fully wrapped up).
 *
 * APPROVED/REJECTED are real decisions from the mission — only legal once
 * the application has actually been lodged. WITHDRAWN can happen any time
 * before a decision exists (the applicant can pull out mid-process).
 *
 * A scanned visa copy can be attached in the same call, multipart, reusing
 * routes/visa.ts's exact upload path (visaDocumentUploadMw +
 * createVisaDocumentUpload) — same S3 mechanics and VisaDocument
 * versioning as every applicant upload, just invoked directly here since
 * this route has no req.workspaceObjectId to lean on. docCode is fixed to
 * DOC-10 ("Issued Visa", config/visaDocumentCodes.ts) — this is the one
 * thing this route ever uploads, never a caller-supplied docCode.
 * ───────────────────────────────────────────────────────────────────── */
const WITHDRAWABLE_STATUSES: VisaApplicationStatus[] = [
  "submitted", "docs_under_review", "action_required", "cost_confirmed", "lodged",
];
const VISA_SCAN_DOC_CODE = "DOC-10";

router.patch(
  "/applications/:id/outcome",
  requirePermission("visaApplication", "FULL"),
  visaDocumentUploadMw,
  async (req: any, res: any) => {
    try {
      const id = req.params.id;
      if (!mongoose.isValidObjectId(id)) {
        return res.status(404).json({ error: "Visa application not found" });
      }

      const outcome = String(req.body?.outcome || "").trim().toUpperCase();
      if (!VISA_APPLICATION_OUTCOMES.includes(outcome as VisaApplicationOutcome)) {
        return res.status(400).json({ error: `outcome must be one of ${VISA_APPLICATION_OUTCOMES.join(", ")}` });
      }

      const application = await VisaApplication.findById(id);
      if (!application) return res.status(404).json({ error: "Visa application not found" });
      const current = application.status;

      if (outcome === "WITHDRAWN") {
        if (!WITHDRAWABLE_STATUSES.includes(current)) {
          return res.status(400).json({ error: `Cannot withdraw an application in '${current}'`, current });
        }
      } else if (current !== "lodged") {
        return res.status(400).json({
          error: `${outcome} can only be recorded once the application is 'lodged' (currently '${current}')`,
          current,
        });
      }

      application.status = "decision_received";
      application.outcome = outcome as VisaApplicationOutcome;

      if (outcome === "APPROVED") {
        const { visaNumber, visaIssuedAt, visaExpiresAt } = req.body || {};
        if (!visaNumber || !String(visaNumber).trim()) {
          return res.status(400).json({ error: "visaNumber is required for an APPROVED outcome" });
        }
        const issuedAt = new Date(visaIssuedAt);
        const expiresAt = new Date(visaExpiresAt);
        if (Number.isNaN(issuedAt.getTime())) {
          return res.status(400).json({ error: "visaIssuedAt is not a valid date" });
        }
        if (Number.isNaN(expiresAt.getTime())) {
          return res.status(400).json({ error: "visaExpiresAt is not a valid date" });
        }
        if (expiresAt.getTime() <= issuedAt.getTime()) {
          return res.status(400).json({ error: "visaExpiresAt must be after visaIssuedAt" });
        }
        application.visaNumber = String(visaNumber).trim();
        application.visaIssuedAt = issuedAt;
        application.visaExpiresAt = expiresAt;
      }

      await application.save();

      let attachedDocument: any = null;
      if (req.file?.buffer) {
        try {
          const doc = await createVisaDocumentUpload({
            workspaceId: application.workspaceId,
            applicationId: application._id,
            docCode: VISA_SCAN_DOC_CODE,
            file: req.file,
            uploaderId: actorId(req),
          });
          attachedDocument = mapAdminDocumentSummary(doc);
        } catch (uploadErr: any) {
          if (uploadErr?.code === 11000) {
            return res.status(409).json({ error: "This visa scan was uploaded concurrently — please retry." });
          }
          throw uploadErr;
        }
      }

      await recomputeRequestStatus(application.requestId);

      res.json({
        ok: true,
        application: mapAdminApplicationSummary(application.toObject()),
        document: attachedDocument,
      });
    } catch (err: any) {
      console.error("[admin visa application outcome PATCH]", err?.message);
      res.status(500).json({ error: err?.message || "Failed to record outcome" });
    }
  },
);

export default router;
