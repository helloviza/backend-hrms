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
//   READ  -> GET /queue, GET /applications/:id, GET /assignable-users
//   WRITE -> PATCH .../status, PATCH /documents/:id/review,
//            PATCH .../assignment, POST .../bulk-assign
//   FULL  -> PATCH .../costs, PATCH .../outcome
// requirePermission() already gives SUPERADMIN a bypass; no separate role
// check is layered on top here.
//
// Mounted at /api/admin/visa (server.ts) with no requireWorkspace and no
// requireFeature — same shape as routes/admin.sessions.ts (requireAuth +
// a permission/role gate, nothing tenancy-related at mount time).
//
// Phase 6b built the console UI (apps/frontend/src/pages/admin/
// VisaConciergeConsole.tsx). Phase 9a moved case assignment off VisaRequest
// onto VisaApplication (see models/VisaApplication.ts), replacing the old
// PATCH /requests/:id/concierge with PATCH /applications/:id/assignment,
// POST /applications/bulk-assign, and GET /assignable-users. Phase 9b wired
// the console UI onto these routes.

import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import VisaApplication, {
  VISA_APPLICATION_STATUSES,
  VISA_APPLICATION_OUTCOMES,
  VISA_OPS_HIDDEN_STATUSES,
  setActionRequired,
  clearActionRequired,
  isTravellerErased,
  VISA_APPLICATION_ERASED_MESSAGE,
  type VisaApplicationStatus,
  type VisaApplicationOutcome,
} from "../models/VisaApplication.js";
import VisaRequest, { recomputeRequestStatus } from "../models/VisaRequest.js";
import VisaDocument from "../models/VisaDocument.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import { UserPermission, hasAccess } from "../models/UserPermission.js";
import { visaDocumentUploadMw, createVisaDocumentUpload } from "./visa.js";
import { presignGetObject } from "../utils/s3Presign.js";
import {
  syncVisaApplicationBilling,
  createVisaWorkStartBooking,
  type VisaBillingSyncResult,
} from "../services/visaBillingSync.js";
// Dossier Tab 3 (2026-08-11) — an APPROVED outcome is the ONE event in this
// codebase that proves a traveller holds a visa, so it is where the wallet's
// AUTO half is written from. See the call site below and the service header.
import {
  syncVisaHoldingFromApplication,
  type VisaHoldingSyncResult,
} from "../services/visaHolding.service.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import VisaActivityLog, { logVisaActivity, type VisaActivityEventType } from "../models/VisaActivityLog.js";
import { assessProcessingRisk } from "../utils/visaEta.js";
import { hydrateVisaChecklist, computeOutstandingRequirements } from "../utils/visaChecklistHydration.js";
import { resolveVisaChecklistWithExclusions } from "../utils/visaChecklistResolver.js";

const router = Router();
const adminVisaLogger = logger.child({ module: "admin.visa" });

router.use(requireAuth);

function actorId(req: any): any {
  return req.user?._id ?? req.user?.id ?? req.user?.sub;
}

function travellerDisplayName(t: any): string {
  return [t?.firstName, t?.middleName, t?.lastName].filter(Boolean).join(" ");
}

// Same shape as admin.visa.rules.ts's own resolveUserName — `name` wins,
// falls back to a firstName+lastName join, then email, never a blank string.
function resolveUserName(u: any): string {
  if (!u) return "Unknown";
  return u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "Unknown";
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

// Phase 10c (console checklist gap) — the SAME resolver the customer
// routes use (utils/visaChecklistResolver.ts / visaChecklistHydration.ts),
// against this application's OWN applicantProfile — never the raw,
// unfiltered rule. Without this an agent would see the full ~22-item
// checklist while the customer sees the ~10 that actually apply to them,
// and would chase documents the applicant was never asked for.
//
// Unlike the customer view, the console ALSO gets the excluded
// requirements (task brief §2) — a group whose appliesWhen didn't match
// this traveller, with the attribute (and this traveller's actual value)
// that excluded it, e.g. "traveller's employment status is EMPLOYED, not
// one of SELF_EMPLOYED" — so an agent can tell "deliberately skipped" from
// "missing" at a glance instead of having to open the live VisaRule to
// compare.
function hydrateAdminRuleSnapshot(a: any) {
  const linkedServices = new Set<string>((a.linkedBookings || []).map((lb: any) => lb.service));
  const applicantProfile = a.applicantProfile || {};
  const checklist = hydrateVisaChecklist(a.ruleSnapshot || {}, { applicantProfile, linkedServices });
  const { excluded } = resolveVisaChecklistWithExclusions(a.ruleSnapshot || {}, applicantProfile);
  return {
    ...a.ruleSnapshot,
    documentRequirements: checklist.documents,
    documentGroups: checklist.documentGroups,
    excludedRequirements: excluded,
  };
}

// Task brief §3 — "confirm the completeness counts in the console match
// what the customer sees." Same two functions the customer routes/frontend
// use (utils/visaChecklistHydration.ts's computeOutstandingRequirements,
// and documentGroups' own countsTowardCompleteness) — never a second,
// console-specific counting rule that could quietly drift from the
// customer's.
function computeAdminCompletenessCounts(
  a: any,
  documents: Array<{ docCode: string }>,
): { requiredCount: number; uploadedRequiredCount: number } {
  const linkedServices = new Set<string>((a.linkedBookings || []).map((lb: any) => lb.service));
  const applicantProfile = a.applicantProfile || {};
  const ruleSnapshot = a.ruleSnapshot || {};

  const requiredCount = hydrateVisaChecklist(ruleSnapshot, { applicantProfile, linkedServices }).documentGroups.filter(
    (g) => g.countsTowardCompleteness,
  ).length;

  const outstanding = computeOutstandingRequirements(ruleSnapshot, applicantProfile, {
    uploadedDocCodes: new Set(documents.map((d) => d.docCode)),
    linkedServices,
  });

  return { requiredCount, uploadedRequiredCount: requiredCount - outstanding.length };
}

function mapAdminApplicationSummary(a: any) {
  return {
    id: String(a._id),
    requestId: String(a.requestId),
    workspaceId: String(a.workspaceId),
    // null after scripts/erase-traveller-profile.ts has run (models/
    // VisaApplication.ts) — String(null) would otherwise render the literal
    // string "null", which reads as a real (broken) id rather than "erased".
    travellerProfileId: a.travellerProfileId ? String(a.travellerProfileId) : null,
    // Present only once a traveller erasure has run — the console's marker
    // for "this case is terminal, the controls are gone on purpose" (task
    // brief), never rewritten or cleared by anything else.
    travellerErasedAt: a.travellerErasedAt ?? null,
    // Present only once services/visaBillingSync.ts has refused to create a
    // ManualBooking because the billing customer couldn't be resolved
    // unambiguously — the console's marker for "this case has no invoice
    // register entry, attach one by hand" rather than a silently-missing
    // booking. Never auto-cleared — see VisaApplication.ts's own comment.
    billingSyncSkippedAt: a.billingSyncSkippedAt ?? null,
    billingSyncSkipReason: a.billingSyncSkipReason ?? null,
    billingSyncSkipDetail: a.billingSyncSkipDetail ?? null,
    // Which VFS/BLS centre or embassy actually handled this case (task
    // brief, 2026-08-01) — settable any time via PATCH
    // /applications/:id/service-partner, not tied to a status transition.
    servicePartnerName: a.servicePartnerName ?? null,
    servicePartnerSetAt: a.servicePartnerSetAt ?? null,
    servicePartnerSetByUserId: a.servicePartnerSetByUserId ? String(a.servicePartnerSetByUserId) : null,
    status: a.status,
    outcome: a.outcome ?? null,
    actionRequiredReason: a.actionRequiredReason ?? null,
    actionRequiredSetAt: a.actionRequiredSetAt ?? null,
    actionRequiredSetByUserId: a.actionRequiredSetByUserId ? String(a.actionRequiredSetByUserId) : null,
    // Read-only — the console's "Clear action required" control names its
    // real resume target from this (clearActionRequired always restores
    // THIS value, ignoring whatever status the caller sends); never
    // written to directly by any route (models/VisaApplication.ts's own
    // doc comment).
    statusBeforeActionRequired: a.statusBeforeActionRequired ?? null,
    customerRespondedAt: a.customerRespondedAt ?? null,
    nationality: a.nationality ?? null,
    nationalityUnresolved: a.nationalityUnresolved,
    ruleSnapshot: hydrateAdminRuleSnapshot(a),
    indicativeCostSnapshot: a.indicativeCostSnapshot,
    actualEmbassyFeeInr: a.actualEmbassyFeeInr ?? null,
    actualVfsFeeInr: a.actualVfsFeeInr ?? null,
    actualPlumtripsServiceFeeInr: a.actualPlumtripsServiceFeeInr ?? null,
    actualTotalInr: a.actualTotalInr ?? null,
    submittedAt: a.submittedAt ?? null,
    lodgedAt: a.lodgedAt ?? null,
    visaNumber: a.visaNumber ?? null,
    visaIssuedAt: a.visaIssuedAt ?? null,
    visaExpiresAt: a.visaExpiresAt ?? null,
    linkedBookings: a.linkedBookings || [],
    assignedConciergeUserId: a.assignedConciergeUserId ? String(a.assignedConciergeUserId) : null,
    assignedConciergeAssignedAt: a.assignedConciergeAssignedAt ?? null,
    assignedConciergeAssignedByUserId: a.assignedConciergeAssignedByUserId
      ? String(a.assignedConciergeAssignedByUserId)
      : null,
    assignedScreeningOfficerId: a.assignedScreeningOfficerId ? String(a.assignedScreeningOfficerId) : null,
    assignedScreeningOfficerAssignedAt: a.assignedScreeningOfficerAssignedAt ?? null,
    assignedScreeningOfficerAssignedByUserId: a.assignedScreeningOfficerAssignedByUserId
      ? String(a.assignedScreeningOfficerAssignedByUserId)
      : null,
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
      // THE GATE, second half. ?status=draft stays reachable — that is a
      // deliberate existing affordance and a draft is merely uninteresting.
      // "pending_approval" is different in KIND: it is held at the
      // customer's own approval gate, Plumtrips has not been given it, and
      // it must not be retrievable by naming it. Without this, the default
      // filter below would be exactly one query parameter deep.
      if (status === "pending_approval") {
        return res.status(400).json({
          error: "status must be one of " +
            VISA_APPLICATION_STATUSES.filter((s) => s !== "pending_approval").join(", "),
        });
      }
      filter.status = status;
    } else {
      // THE GATE, first half. Nothing for ops to do with a draft (the
      // customer hasn't submitted it) or with a pending_approval
      // application (submitted, but their own approver hasn't released it
      // to us). VISA_OPS_HIDDEN_STATUSES is the single shared constant
      // behind every Plumtrips-facing status filter.
      filter.status = { $nin: VISA_OPS_HIDDEN_STATUSES };
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

    // Phase 9f — "has the customer responded since we last asked", an
    // independent filter alongside actionRequired above (a case can be
    // ?customerResponded=true&actionRequired=true for exactly the
    // "responded but still blocked" rows this phase is about, or used on
    // its own). Same "fold into whatever shape filter.status/$and already
    // took" idiom as the actionRequired=false branch, generalised one
    // level so this never clobbers either.
    if (req.query.customerResponded === "true" || req.query.customerResponded === "false") {
      const condition =
        req.query.customerResponded === "true"
          ? { customerRespondedAt: { $ne: null } }
          : { customerRespondedAt: null };
      if (filter.$and) {
        filter.$and.push(condition);
      } else if (filter.status !== undefined) {
        filter.$and = [{ status: filter.status }, condition];
        delete filter.status;
      } else {
        Object.assign(filter, condition);
      }
    }

    // "Findable rather than silently absent" (task brief) — an OPTIONAL
    // filter, never applied by default: unlike an erased-traveller
    // application (terminal, excluded from the default queue below), a
    // billing-sync-skipped application is still a live, working case that
    // just has no ManualBooking yet. It stays in the default queue either
    // way; this just lets a triage view isolate the ones needing one
    // attached by hand. Same "fold into whatever shape filter.status/$and
    // already took" idiom as customerResponded above.
    if (req.query.billingSyncSkipped === "true" || req.query.billingSyncSkipped === "false") {
      const condition =
        req.query.billingSyncSkipped === "true"
          ? { billingSyncSkippedAt: { $ne: null } }
          : { billingSyncSkippedAt: null };
      if (filter.$and) {
        filter.$and.push(condition);
      } else if (filter.status !== undefined) {
        filter.$and = [{ status: filter.status }, condition];
        delete filter.status;
      } else {
        Object.assign(filter, condition);
      }
    }

    if (req.query.workspaceId != null) {
      if (!mongoose.isValidObjectId(req.query.workspaceId)) {
        return res.status(400).json({ error: "workspaceId is not a valid id" });
      }
      filter.workspaceId = new mongoose.Types.ObjectId(req.query.workspaceId);
    }

    // Reconciling a partner invoice against cases starts with being able to
    // find every case a given centre worked (task brief) — exact match on
    // the free-text value a concierge typed in, same posture as
    // workspaceId above: an independent field, never sharing a key with
    // status/$and, so no fold-into-whatever-shape idiom is needed here.
    if (req.query.servicePartnerName != null) {
      const v = String(req.query.servicePartnerName).trim();
      if (v) filter.servicePartnerName = v;
    }

    // Assignment filters (Phase 9a). ?unassigned=true means neither role is
    // set on the application at all — the true "unclaimed" queue a batch-
    // assign action would work from — and takes priority over the two
    // specific-assignee filters below (asking for both at once is a
    // contradiction; unassigned wins rather than silently ANDing to zero
    // results).
    if (req.query.unassigned === "true") {
      filter.assignedConciergeUserId = null;
      filter.assignedScreeningOfficerId = null;
    } else {
      if (req.query.assignedConciergeUserId != null) {
        const v = String(req.query.assignedConciergeUserId).trim();
        if (!mongoose.isValidObjectId(v)) {
          return res.status(400).json({ error: "assignedConciergeUserId is not a valid id" });
        }
        filter.assignedConciergeUserId = new mongoose.Types.ObjectId(v);
      }
      if (req.query.assignedScreeningOfficerId != null) {
        const v = String(req.query.assignedScreeningOfficerId).trim();
        if (!mongoose.isValidObjectId(v)) {
          return res.status(400).json({ error: "assignedScreeningOfficerId is not a valid id" });
        }
        filter.assignedScreeningOfficerId = new mongoose.Types.ObjectId(v);
      }
    }

    // Excluded from the default queue by default — an erased-traveller
    // application is terminal, nothing for an agent to work (task brief).
    // Still reachable with an explicit ?includeErased=true, and GET
    // /applications/:id never applies this filter at all — the case
    // skeleton stays visible for audit either way. Same "fold into whatever
    // shape filter.status/$and already took" idiom as customerResponded
    // above.
    if (req.query.includeErased !== "true") {
      const condition = { travellerErasedAt: null };
      if (filter.$and) {
        filter.$and.push(condition);
      } else if (filter.status !== undefined) {
        filter.$and = [{ status: filter.status }, condition];
        delete filter.status;
      } else {
        Object.assign(filter, condition);
      }
    }

    const applications = await VisaApplication.find(filter).lean();

    const requestIds = [...new Set(applications.map((a: any) => String(a.requestId)))];
    const requests = await VisaRequest.find({ _id: { $in: requestIds } })
      .select("referenceNumber destinationIso2 purpose travelDateFrom travelDateTo status")
      .lean();
    const requestById = new Map(requests.map((r: any) => [String(r._id), r]));

    const destinationFilter = req.query.destination ? String(req.query.destination).trim().toUpperCase() : null;
    // Phase 9f — same in-memory-after-join posture as destinationFilter
    // above: travelDateFrom only exists on the joined VisaRequest, not on
    // VisaApplication itself, so this can't be a DB-level $match either.
    // Applied over the already-DB-filtered row set (every OTHER filter
    // above already ran in the query), never over the whole collection.
    const atRiskOnly = req.query.atRisk === "true";

    // Computed ONCE per row here, reused by both the ?atRisk=true filter
    // below AND the row payload's own `risk` field (task brief, 2026-08-01:
    // "confirm it agrees with the ?atRisk=true filter") — a single call to
    // assessProcessingRisk per row, never recomputed differently for the
    // filter vs. the marker, so the two can never disagree with each other.
    // null (not just atRisk:false) once a decision exists or the case is
    // closed/draft — "nothing left to risk" — mirrors the filter's own
    // exclusion exactly, and doubles as the row's own signal that no
    // at-risk marker applies here at all (as opposed to a real, computed
    // "not at risk").
    function computeRowRisk(a: any, r: any): ReturnType<typeof assessProcessingRisk> {
      if (a.outcome || a.status === "closed" || a.status === "draft") return null;
      return assessProcessingRisk(r?.travelDateFrom, a.ruleSnapshot?.etaMaxDays, a.ruleSnapshot?.etaBasis);
    }

    let rows = applications
      .map((a: any) => {
        const request = requestById.get(String(a.requestId)) || null;
        return { application: a, request, risk: computeRowRisk(a, request) };
      })
      .filter(({ request }) => !destinationFilter || request?.destinationIso2 === destinationFilter)
      .filter(({ risk }) => !atRiskOnly || risk?.atRisk === true);

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

    // Urgency first, then soonest travel date. Three urgency tiers, not
    // two (Phase 9f): a responded-but-still-blocked action_required row
    // needs an agent MORE urgently than one nobody has touched yet — the
    // customer already did their part, the agent is now the only thing
    // outstanding — so it outranks even an untouched action_required row,
    // not just the non-action_required rest of the queue. Array#sort is
    // stable in Node, so rows with an identical rank+date keep their
    // original (createdAt-independent, but deterministic-per-query)
    // relative order rather than reshuffling across requests.
    function urgencyRank(a: any): number {
      if (a.status !== "action_required") return 2;
      return a.customerRespondedAt ? 0 : 1;
    }
    rows.sort((x, y) => {
      const rankX = urgencyRank(x.application);
      const rankY = urgencyRank(y.application);
      if (rankX !== rankY) return rankX - rankY;
      const dateX = x.request?.travelDateFrom ? new Date(x.request.travelDateFrom).getTime() : FAR_FUTURE_SENTINEL.getTime();
      const dateY = y.request?.travelDateFrom ? new Date(y.request.travelDateFrom).getTime() : FAR_FUTURE_SENTINEL.getTime();
      return dateX - dateY;
    });

    const total = rows.length;
    const start = (page - 1) * limit;
    const pageRows = rows.slice(start, start + limit);

    // Assignee names, resolved only for the PAGE being returned (unlike
    // workspace/traveller above, which resolve against the full pre-
    // pagination `rows` — there's no reason to look up every assignee
    // across every page just to shape the one page actually being sent).
    const assigneeIds = new Set<string>();
    for (const { application: a } of pageRows) {
      if (a.assignedConciergeUserId) assigneeIds.add(String(a.assignedConciergeUserId));
      if (a.assignedScreeningOfficerId) assigneeIds.add(String(a.assignedScreeningOfficerId));
    }
    const assignees = assigneeIds.size
      ? await User.find({ _id: { $in: [...assigneeIds] } }).select("name email").lean()
      : [];
    const assigneeById = new Map(assignees.map((u: any) => [String(u._id), u]));
    function assigneeSummary(userId: any): { id: string; name: string | null } | null {
      if (!userId) return null;
      const u = assigneeById.get(String(userId));
      return { id: String(userId), name: (u?.name || u?.email) ?? null };
    }

    // Task brief §1/§3 — resolved (not raw) checklist completeness, only
    // for the PAGE being returned (same "page only" posture as assignees
    // above). Without this an agent scanning the queue would see the
    // "22 pending" count the raw rule implies rather than what the
    // customer's own applicantProfile actually narrows it to.
    const pageApplicationIds = pageRows.map(({ application: a }) => a._id);
    const pageDocuments = pageApplicationIds.length
      ? await VisaDocument.find({ applicationId: { $in: pageApplicationIds }, deletedAt: null })
          .select("applicationId docCode")
          .lean()
      : [];
    const documentsByApplicationId = new Map<string, Array<{ docCode: string }>>();
    for (const d of pageDocuments as any[]) {
      const key = String(d.applicationId);
      const list = documentsByApplicationId.get(key) || [];
      list.push({ docCode: d.docCode });
      documentsByApplicationId.set(key, list);
    }

    const shaped = pageRows.map(({ application: a, request: r, risk }) => {
      const workspace = workspaceById.get(String(a.workspaceId)) || null;
      const traveller = travellerById.get(String(a.travellerProfileId)) || null;
      return {
        id: String(a._id),
        status: a.status,
        actionRequiredReason: a.actionRequiredReason ?? null,
        // The at-risk marker (task brief, 2026-08-01) — "is there still
        // enough runway before travel to plausibly finish processing,"
        // computed by utils/visaEta.ts's assessProcessingRisk and reused
        // verbatim from the SAME call the ?atRisk=true filter above made
        // for this row (see computeRowRisk) — never recomputed
        // differently here. null once a decision exists or the case is
        // closed/draft (nothing left to risk), or whenever the helper
        // itself has nothing to assess (no travel date, or the rule
        // snapshot carries no etaMaxDays) — never a guessed verdict.
        // Carries the full assessment, not just the boolean, so the
        // console's marker can distinguish a narrowly-tight case from one
        // that will not make it (marginDays) rather than a flat yes/no.
        risk,
        // Present only once a traveller erasure has run — so an agent who
        // reaches this row via ?includeErased=true sees why the controls
        // are gone rather than assuming a bug (task brief).
        travellerErasedAt: a.travellerErasedAt ?? null,
        // Present only once billing sync refused to create a ManualBooking
        // (task brief: "findable rather than silently absent") — the row
        // stays in the default queue either way; this is what a triage
        // view filters on via ?billingSyncSkipped=true.
        billingSyncSkippedAt: a.billingSyncSkippedAt ?? null,
        billingSyncSkipReason: a.billingSyncSkipReason ?? null,
        // Task brief (2026-08-01): "that starts with being able to filter
        // by it" — this is what ?servicePartnerName= narrows on above.
        servicePartnerName: a.servicePartnerName ?? null,
        customerRespondedAt: a.customerRespondedAt ?? null,
        submittedAt: a.submittedAt ?? null,
        destinationName: a.ruleSnapshot?.destinationName ?? null,
        purpose: a.ruleSnapshot?.purpose ?? null,
        serviceTier: a.ruleSnapshot?.serviceTier ?? null,
        // Resolved against THIS application's own applicantProfile — see
        // computeAdminCompletenessCounts. Matches what the customer sees
        // for the same application (task brief §3).
        completeness: computeAdminCompletenessCounts(a, documentsByApplicationId.get(String(a._id)) || []),
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
        assignedConcierge: assigneeSummary(a.assignedConciergeUserId),
        assignedScreeningOfficer: assigneeSummary(a.assignedScreeningOfficerId),
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

    // THE GATE, by-id half. A pending_approval application is held at the
    // customer's own approval gate and Plumtrips has not been given it — so
    // it 404s here exactly as if it did not exist, rather than exposing the
    // unmasked passport detail this route is otherwise allowed to return.
    //
    // No list can hand an agent this id (every ops-side read excludes the
    // status), so this is defence in depth — but the alternative is a gate
    // that holds only for as long as nobody guesses or retains an id.
    //
    // Checked against "pending_approval" ALONE, not the whole
    // VISA_OPS_HIDDEN_STATUSES set: a DRAFT application has always been
    // fetchable by id here (only the LIST excludes it), that is existing
    // behaviour this change has no business altering, and a draft is merely
    // uninteresting to ops rather than withheld from them.
    if ((application as any).status === "pending_approval") {
      return res.status(404).json({ error: "Visa application not found" });
    }

    const [visaRequest, traveller, workspace, documents] = await Promise.all([
      VisaRequest.findById((application as any).requestId).lean(),
      TravellerProfile.findById((application as any).travellerProfileId).lean(),
      CustomerWorkspace.findById((application as any).workspaceId).select("companyName customerId").lean(),
      VisaDocument.find({ applicationId: (application as any)._id, deletedAt: null })
        .sort({ docCode: 1, version: -1 })
        .lean(),
    ]);

    // Case assignment lives on the APPLICATION itself now (Phase 9a — see
    // models/VisaApplication.ts), not the parent request.
    const assigneeIds = [
      (application as any).assignedConciergeUserId,
      (application as any).assignedScreeningOfficerId,
    ].filter(Boolean);
    const assigneeUsers = assigneeIds.length
      ? await User.find({ _id: { $in: assigneeIds } }).select("name email").lean()
      : [];
    const assigneeById = new Map(assigneeUsers.map((u: any) => [String(u._id), u]));

    function assigneeSummary(userId: any): { id: string; name: string | null; email: string | null } | null {
      if (!userId) return null;
      const u = assigneeById.get(String(userId));
      return { id: String(userId), name: u?.name ?? null, email: u?.email ?? null };
    }

    const assignedConcierge = assigneeSummary((application as any).assignedConciergeUserId);
    const assignedScreeningOfficer = assigneeSummary((application as any).assignedScreeningOfficerId);

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
      // Task brief §3 — computed from the SAME resolved checklist +
      // completeness rule the customer side uses, over this route's own
      // already-fetched `documents` — never a second implementation that
      // could show a different number than what the customer sees for the
      // same application.
      completeness: computeAdminCompletenessCounts(application, documents as any[]),
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
      assignedConcierge,
      assignedScreeningOfficer,
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
  // THE GATE, mutation half. Empty like draft: ops may not move a case out
  // of the customer's own approval gate — only the customer's approver can,
  // via POST /api/visa/requests/:id/approve. Listed EXPLICITLY rather than
  // left to fall off the end of this table, so the lookup below yields a
  // clean "cannot transition" 400 instead of reading undefined.
  pending_approval: [],
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

    if (isTravellerErased(application)) {
      return res.status(409).json({ error: VISA_APPLICATION_ERASED_MESSAGE });
    }

    const current = application.status;

    // Phase 9e — the work-start billing side effect, populated only on the
    // submitted -> docs_under_review transition below. Surfaced in the
    // response (same transparency posture as the outcome route's own
    // `billing` field) but never allowed to fail the status change itself.
    let workStartBilling: VisaBillingSyncResult | { error: string } | undefined;

    if (target === "action_required") {
      if (!ACTION_REQUIRED_ELIGIBLE.has(current)) {
        return res.status(400).json({ error: `Cannot set action_required from '${current}'`, current, target });
      }
      const reason = String(req.body?.reason || "").trim();
      if (!reason) {
        return res.status(400).json({ error: "reason is required to set action_required" });
      }
      await setActionRequired(id, reason, actorId(req));
      // reason IS logged — it's the concierge's own message, not extracted
      // applicant data (VisaActivityLog.ts's no-PII rule explicitly allows it).
      await logVisaActivity({
        applicationId: id,
        requestId: application.requestId,
        workspaceId: application.workspaceId,
        eventType: "ACTION_REQUIRED_SET",
        actorUserId: actorId(req),
        actorType: "STAFF",
        detail: { reason, interruptedStatus: current },
      });
    } else if (current === "action_required") {
      // target is validated (must be a legal pre-decision status — i.e. the
      // caller is confirming "yes, clear it") but is no longer what gets
      // WRITTEN: clearActionRequired() restores the real interrupted status
      // from statusBeforeActionRequired, captured when this application was
      // originally flagged (models/VisaApplication.ts) — that's the whole
      // point of capturing it. A stale/wrong guess from the caller can
      // never overwrite it; there is no separate write here anymore.
      if (!PRE_DECISION_STATUSES.includes(target as VisaApplicationStatus)) {
        return res.status(400).json({ error: `Cannot clear action_required into '${target}'`, current, target });
      }
      const resumed = await clearActionRequired(id);
      await logVisaActivity({
        applicationId: id,
        requestId: application.requestId,
        workspaceId: application.workspaceId,
        eventType: "ACTION_REQUIRED_CLEARED",
        actorUserId: actorId(req),
        actorType: "STAFF",
        detail: { resumedStatus: resumed?.status ?? null },
      });
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
      //
      // lodgedAt is stamped ONLY on this specific cost_confirmed -> lodged
      // transition — the state machine above guarantees that's the only way
      // to reach "lodged" from here (the action_required side-branch above
      // resumes back into an EXISTING lodging, never through this table, so
      // it can never re-stamp it).
      const update: Record<string, unknown> = { status: target };
      if (target === "lodged") update.lodgedAt = new Date();
      const updated = await VisaApplication.findOneAndUpdate(
        { _id: id, status: current },
        { $set: update },
        { new: true },
      );
      if (!updated) {
        return res.status(409).json({ error: "This application's status changed concurrently — please retry." });
      }
      await logVisaActivity({
        applicationId: id,
        requestId: application.requestId,
        workspaceId: application.workspaceId,
        eventType: "STATUS_CHANGED",
        actorUserId: actorId(req),
        actorType: "STAFF",
        detail: { from: current, to: target },
      });

      // Work-start billing (Phase 9e) — a concierge picking up the case is
      // the trigger; the ManualBooking must exist from THIS moment, not
      // wait for the outcome. Best-effort, same posture as the outcome
      // route's own billing call below: a failure here must never fail
      // the status transition that already succeeded.
      if (target === "docs_under_review") {
        try {
          workStartBilling = await createVisaWorkStartBooking(updated, actorId(req));
          if (workStartBilling.action === "skipped_billing_customer_unresolved") {
            await VisaApplication.updateOne(
              { _id: id },
              {
                $set: {
                  billingSyncSkippedAt: new Date(),
                  billingSyncSkipReason: workStartBilling.skipReason,
                  billingSyncSkipDetail: workStartBilling.skipDetail,
                },
              },
            );
          }
        } catch (billingErr: any) {
          adminVisaLogger.error("visa work-start billing sync failed", {
            applicationId: id,
            error: billingErr?.message,
          });
          workStartBilling = { error: billingErr?.message || "Work-start billing sync failed" };
        }
      }
    }

    // status is DERIVED on VisaRequest — never assigned directly. Same rule
    // every route in routes/visa.ts already follows.
    await recomputeRequestStatus(application.requestId);

    const fresh = await VisaApplication.findById(id).lean();
    res.json({
      ok: true,
      application: mapAdminApplicationSummary(fresh),
      ...(workStartBilling ? { billing: workStartBilling } : {}),
    });
  } catch (err: any) {
    console.error("[admin visa application status PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update application status" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /applications/:id/service-partner — which VFS/BLS centre or
 * embassy actually handled the case (task brief, 2026-08-01). Free text,
 * on the same detail panel as status but NOT part of its state machine —
 * settable any time, in either direction, independent of status. Body:
 * { servicePartnerName: string | null }; an empty/whitespace-only string
 * clears it, same as explicit null.
 * ───────────────────────────────────────────────────────────────────── */
router.patch(
  "/applications/:id/service-partner",
  requirePermission("visaApplication", "WRITE"),
  async (req: any, res: any) => {
    try {
      const id = req.params.id;
      if (!mongoose.isValidObjectId(id)) {
        return res.status(404).json({ error: "Visa application not found" });
      }

      const application = await VisaApplication.findById(id);
      if (!application) return res.status(404).json({ error: "Visa application not found" });

      if (isTravellerErased(application)) {
        return res.status(409).json({ error: VISA_APPLICATION_ERASED_MESSAGE });
      }

      const raw = req.body?.servicePartnerName;
      const trimmed = typeof raw === "string" ? raw.trim() : "";
      const next = trimmed || null;
      const previous = (application as any).servicePartnerName ?? null;

      if (previous === next) {
        // No-op — nothing changed, so nothing to timestamp or log.
        return res.json({ ok: true, application: mapAdminApplicationSummary(application.toObject()) });
      }

      (application as any).servicePartnerName = next;
      (application as any).servicePartnerSetAt = new Date();
      (application as any).servicePartnerSetByUserId = actorId(req);
      await application.save();

      // Not PII — a centre/embassy name, not applicant data (same posture
      // as an action_required reason: the file header's "no PII" rule is
      // about the traveller, not the operational fact of who handled the
      // case), so it's fine in `detail` unlike MANUAL_BOOKING_SKIPPED's
      // reason-code-only convention.
      await logVisaActivity({
        applicationId: id,
        requestId: application.requestId,
        workspaceId: application.workspaceId,
        eventType: "SERVICE_PARTNER_SET",
        actorUserId: actorId(req),
        actorType: "STAFF",
        detail: { from: previous, to: next },
      });

      res.json({ ok: true, application: mapAdminApplicationSummary(application.toObject()) });
    } catch (err: any) {
      console.error("[admin visa application service-partner PATCH]", err?.message);
      res.status(500).json({ error: err?.message || "Failed to update service partner" });
    }
  },
);

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

    // Resolved BEFORE the write below (moved out of the post-write,
    // best-effort lookup this used to only need for the activity log) so
    // the erasure guard can run before anything is written, not after.
    const existingDoc = await VisaDocument.findOne({ _id: id, deletedAt: null }).lean();
    if (!existingDoc) return res.status(404).json({ error: "Document not found" });

    const owningApplication = await VisaApplication.findById((existingDoc as any).applicationId).lean();
    if (isTravellerErased(owningApplication)) {
      return res.status(409).json({ error: VISA_APPLICATION_ERASED_MESSAGE });
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

    // Activity logging wrapped so a failure here can never fail the review
    // that already succeeded above.
    try {
      if (owningApplication) {
        await logVisaActivity({
          applicationId: doc.applicationId,
          requestId: (owningApplication as any).requestId,
          workspaceId: doc.workspaceId,
          eventType: reviewStatus === "VERIFIED" ? "DOCUMENT_ACCEPTED" : "DOCUMENT_REJECTED",
          actorUserId: actorId(req),
          actorType: "STAFF",
          detail:
            reviewStatus === "REJECTED"
              ? { documentId: String(doc._id), docCode: doc.docCode, reason: rejectionReason }
              : { documentId: String(doc._id), docCode: doc.docCode },
        });
      }
    } catch (logErr: any) {
      adminVisaLogger.error("failed to resolve requestId for visa activity log", {
        documentId: String(doc._id),
        error: logErr?.message,
      });
    }

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
 * sign it now).
 *
 * THE PARENT CHECK (2026-08-11). The customer-side route scopes its lookup
 * by {_id, workspaceId} — identity picks the workspace, so the document is
 * authorised against its owner. This router is cross-workspace by design
 * (file header), so there is no caller workspace to re-verify against and
 * that half genuinely does not apply. What DOES apply is the same
 * ops-visibility check the rest of this file makes: a document is only
 * signable if the application it hangs off is one ops may hold at all.
 *
 * Until now this route never loaded the parent, so a bare document id —
 * with nothing but a READ grant — minted a presigned URL to the underlying
 * S3 object, passport scans included, no matter what state the application
 * was in. That made it the weakest read on the surface: GET
 * /applications/:id refuses a pending_approval case outright, and PATCH
 * /documents/:id/review already resolves the owning application before
 * acting, but the one route that hands out the IMAGE checked neither.
 *
 * So the parent is resolved first (same VisaApplication.findById on
 * doc.applicationId that /documents/:id/review uses — not a new, looser
 * check) and refused on the same terms as GET /applications/:id: a
 * pending_approval application is held at the customer's own approval gate
 * and 404s exactly as if it did not exist. An orphaned document — one whose
 * application is gone — refuses too: nothing can authorise it, and
 * "unauthorisable" must never fall through to "sign it".
 *
 * The refusal is 404 "Document not found", not 403: a 403 would confirm the
 * document exists and that its parent is being withheld, which is the fact
 * the gate is keeping. Same posture as the detail route's own 404.
 *
 * Deliberately NOT extended to an erasure refusal. Reads stay open on an
 * erased traveller by design across this file — GET /applications/:id has
 * no erasure guard and the queue takes ?includeErased — because the
 * skeleton has to stay visible for audit; it is the WRITES that 409. Adding
 * one here would change legitimate ops behaviour, which this fix does not.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/documents/:id/url", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Document not found" });
    }

    const doc = await VisaDocument.findOne({ _id: id, deletedAt: null }).lean();
    if (!doc) return res.status(404).json({ error: "Document not found" });

    // THE PARENT CHECK. Resolved BEFORE presignGetObject is called, so a
    // refusal never reaches the point of minting a URL.
    const owningApplication = await VisaApplication.findById((doc as any).applicationId).lean();
    if (!owningApplication || (owningApplication as any).status === "pending_approval") {
      return res.status(404).json({ error: "Document not found" });
    }

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

    if (isTravellerErased(application)) {
      return res.status(409).json({ error: VISA_APPLICATION_ERASED_MESSAGE });
    }

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

    // Logged unconditionally — the old logger.info above only ever fired
    // above-threshold, leaving every in-threshold cost update with no
    // persisted trail at all. This is the gap the activity log closes.
    await logVisaActivity({
      applicationId: application._id,
      requestId: application.requestId,
      workspaceId: application.workspaceId,
      eventType: "COSTS_RECORDED",
      actorUserId: actorId(req),
      actorType: "STAFF",
      detail: {
        actualEmbassyFeeInr,
        actualVfsFeeInr,
        actualPlumtripsServiceFeeInr,
        actualTotalInr,
        varianceInr,
        reasonRequired,
        reason: reasonRequired ? String(reason).trim() : null,
      },
    });

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

      if (isTravellerErased(application)) {
        return res.status(409).json({ error: VISA_APPLICATION_ERASED_MESSAGE });
      }

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

      await logVisaActivity({
        applicationId: application._id,
        requestId: application.requestId,
        workspaceId: application.workspaceId,
        eventType: "OUTCOME_RECORDED",
        actorUserId: actorId(req),
        actorType: "STAFF",
        detail: { outcome },
      });

      let attachedDocument: any = null;
      if (req.file?.buffer) {
        try {
          const doc = await createVisaDocumentUpload({
            workspaceId: application.workspaceId,
            applicationId: application._id,
            requestId: application.requestId,
            docCode: VISA_SCAN_DOC_CODE,
            file: req.file,
            uploaderId: actorId(req),
            actorType: "STAFF",
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

      /* ── VISA WALLET HANDOFF (2026-08-11, dossier Tab 3) ──────────────
       *
       * THE trigger for the wallet's AUTO half, and it fires HERE because
       * this is the only place in the codebase where `outcome` is written.
       * "Issued" means outcome === "APPROVED" — the single approving value
       * in VISA_APPLICATION_OUTCOMES (the other two are REJECTED and
       * WITHDRAWN); there is no separate ISSUED/GRANTED state to watch for.
       *
       * Everything the holding needs is already guaranteed by the branch
       * above: an APPROVED outcome 400s without visaNumber, visaIssuedAt
       * and visaExpiresAt, and entryType comes off the immutable
       * ruleSnapshot. So the sync never has to invent a field.
       *
       * The service ignores any non-APPROVED outcome, so a later REJECTED
       * or WITHDRAWN can never mint a visa, and it upserts on
       * sourceApplicationId, so re-recording a corrected visa number
       * updates the same holding instead of adding a second one.
       *
       * BEST-EFFORT, exactly like the billing sync below it: the decision
       * is already saved, and a wallet write failing must not fail the
       * response or leave the outcome half-recorded. Reported in the
       * response so the console can see it without grepping logs.
       */
      let wallet: VisaHoldingSyncResult | { action: "error"; error: string } = {
        action: "not_issued",
        holdingId: null,
      };
      try {
        wallet = await syncVisaHoldingFromApplication(application, actorId(req));
      } catch (walletErr: any) {
        adminVisaLogger.error("visa holding sync failed", {
          applicationId: String(application._id),
          error: walletErr?.message,
        });
        wallet = { action: "error", error: walletErr?.message || "Visa wallet sync failed" };
      }

      // Phase 8 billing handoff — best-effort side effect. The outcome
      // itself is already recorded and saved above; a billing-sync failure
      // (a transient DB error, an unresolvable workspace) must not fail
      // this response or leave the outcome half-recorded. Logged either
      // way (services/visaBillingSync.ts logs its own outcome); surfaced
      // here too so the immediate caller/UI can see it without grepping logs.
      let billing: VisaBillingSyncResult | { error: string } | { action: "not_attempted"; manualBookingId: null } = {
        action: "not_attempted",
        manualBookingId: null,
      };
      try {
        billing = await syncVisaApplicationBilling(application, actorId(req));
        if (billing.action === "skipped_billing_customer_unresolved") {
          const skippedAt = new Date();
          await VisaApplication.updateOne(
            { _id: application._id },
            {
              $set: {
                billingSyncSkippedAt: skippedAt,
                billingSyncSkipReason: billing.skipReason,
                billingSyncSkipDetail: billing.skipDetail,
              },
            },
          );
          // Reflected in THIS response too, not just on the next GET — same
          // posture as every other field this route already mutates on
          // `application` before building the response below.
          (application as any).billingSyncSkippedAt = skippedAt;
          (application as any).billingSyncSkipReason = billing.skipReason;
          (application as any).billingSyncSkipDetail = billing.skipDetail;
        }
      } catch (billingErr: any) {
        adminVisaLogger.error("visa billing sync failed", {
          applicationId: String(application._id),
          error: billingErr?.message,
        });
        billing = { error: billingErr?.message || "Billing sync failed" };
      }

      res.json({
        ok: true,
        application: mapAdminApplicationSummary(application.toObject()),
        document: attachedDocument,
        billing,
        wallet,
      });
    } catch (err: any) {
      console.error("[admin visa application outcome PATCH]", err?.message);
      res.status(500).json({ error: err?.message || "Failed to record outcome" });
    }
  },
);

/* ─────────────────────────────────────────────────────────────────────
 * Case assignment (Phase 9a) — PATCH /applications/:id/assignment, POST
 * /applications/bulk-assign, GET /assignable-users.
 *
 * Replaces the old PATCH /requests/:id/concierge (removed) — assignment now
 * lives per APPLICATION, not per request (models/VisaApplication.ts), with
 * two independent roles: assignedConciergeUserId (owns the customer
 * relationship) and assignedScreeningOfficerId (checks documents against
 * the checklist). See migrations/2026-07-30-migrate-visa-concierge-
 * assignment.ts for the one-time move of pre-existing VisaRequest-level
 * assignments down onto their applications.
 * ───────────────────────────────────────────────────────────────────── */

const ASSIGNMENT_ROLES = {
  assignedConciergeUserId: {
    idField: "assignedConciergeUserId",
    atField: "assignedConciergeAssignedAt",
    byField: "assignedConciergeAssignedByUserId",
  },
  assignedScreeningOfficerId: {
    idField: "assignedScreeningOfficerId",
    atField: "assignedScreeningOfficerAssignedAt",
    byField: "assignedScreeningOfficerAssignedByUserId",
  },
} as const;

type AssignmentRoleKey = keyof typeof ASSIGNMENT_ROLES;
const ASSIGNMENT_ROLE_KEYS = Object.keys(ASSIGNMENT_ROLES) as AssignmentRoleKey[];

// True for a SUPERADMIN (who bypasses the visaApplication gate entirely —
// same posture as requirePermission/isSuperAdmin) or an active, non-
// suspended/revoked UserPermission grant of visaApplication at WRITE or
// FULL. Mirrors requirePermission's own gate exactly — never allow
// assigning a case to someone who could not open it themselves.
async function userCanBeAssignedVisaCases(userId: any): Promise<boolean> {
  const user = await User.findById(userId).select("roles status").lean();
  if (!user || (user as any).status === "INACTIVE") return false;
  if (Array.isArray((user as any).roles) && (user as any).roles.includes("SUPERADMIN")) return true;

  const perm = await UserPermission.findOne({ userId: String(userId), status: "active" })
    .select("modules.visaApplication")
    .lean();
  const access = (perm as any)?.modules?.visaApplication?.access || "NONE";
  return hasAccess(access, "WRITE");
}

// Validates every assignment-role key PRESENT in the body (a role absent
// from the body is simply left untouched — clearing one role must never
// touch the other) and builds the combined $set for a single atomic write.
// Returns {error,status} on the FIRST invalid role so nothing is applied
// when only one of two roles in the same request is bad — never a partial
// write for a single application either.
async function buildAssignmentUpdate(
  body: any,
  actorUserId: any,
): Promise<{ set: Record<string, unknown> } | { error: string; status: number }> {
  const set: Record<string, unknown> = {};
  let touched = false;

  for (const key of ASSIGNMENT_ROLE_KEYS) {
    if (!(key in body)) continue;
    touched = true;
    const fields = ASSIGNMENT_ROLES[key];
    const raw = body[key];

    if (raw == null || raw === "") {
      set[fields.idField] = null;
      set[fields.atField] = null;
      set[fields.byField] = null;
      continue;
    }

    const userId = String(raw);
    if (!mongoose.isValidObjectId(userId)) {
      return { error: `${key} is not a valid user id`, status: 400 };
    }
    const user = await User.findById(userId).select("_id status").lean();
    if (!user || (user as any).status === "INACTIVE") {
      return { error: `${key}: no such staff user`, status: 404 };
    }
    if (!(await userCanBeAssignedVisaCases(userId))) {
      return {
        error: `${key}: this user does not have visaApplication WRITE access and cannot be assigned a case`,
        status: 400,
      };
    }
    set[fields.idField] = (user as any)._id;
    set[fields.atField] = new Date();
    set[fields.byField] = actorUserId;
  }

  if (!touched) {
    return { error: "Provide assignedConciergeUserId and/or assignedScreeningOfficerId", status: 400 };
  }
  return { set };
}

// Diffs the assignment role fields a $set actually touches against the
// application's PRE-write values, so the assignment routes can log exactly
// what changed — never a no-op "re-affirmed the same assignee" event (that
// would just be timestamp/assignedBy churn on an unchanged relationship).
// Shared by PATCH /applications/:id/assignment and POST
// /applications/bulk-assign, which otherwise duplicate this exact diff.
function diffAssignmentRoles(
  before: Record<string, unknown>,
  set: Record<string, unknown>,
): Array<{ role: "CONCIERGE" | "SCREENING_OFFICER"; fromUserId: string | null; toUserId: string | null }> {
  const changes: Array<{ role: "CONCIERGE" | "SCREENING_OFFICER"; fromUserId: string | null; toUserId: string | null }> = [];
  for (const key of ASSIGNMENT_ROLE_KEYS) {
    const fields = ASSIGNMENT_ROLES[key];
    if (!(fields.idField in set)) continue;
    const fromUserId = before[fields.idField] ? String(before[fields.idField]) : null;
    const toUserId = set[fields.idField] ? String(set[fields.idField]) : null;
    if (fromUserId === toUserId) continue;
    changes.push({ role: key === "assignedConciergeUserId" ? "CONCIERGE" : "SCREENING_OFFICER", fromUserId, toUserId });
  }
  return changes;
}

function assignmentEventType(
  role: "CONCIERGE" | "SCREENING_OFFICER",
  fromUserId: string | null,
  toUserId: string | null,
): VisaActivityEventType {
  if (fromUserId == null) return `${role}_ASSIGNED` as VisaActivityEventType;
  if (toUserId == null) return `${role}_CLEARED` as VisaActivityEventType;
  return `${role}_CHANGED` as VisaActivityEventType;
}

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /applications/:id/assignment — set or clear either role on ONE
 * application. Body: { assignedConciergeUserId?: string|null,
 * assignedScreeningOfficerId?: string|null } — a key omitted entirely is
 * left untouched; present with null (or "") clears that role; present with
 * a userId assigns it (validated via userCanBeAssignedVisaCases above).
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/applications/:id/assignment", requirePermission("visaApplication", "WRITE"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Visa application not found" });
    }
    const exists = await VisaApplication.findById(id).lean();
    if (!exists) return res.status(404).json({ error: "Visa application not found" });

    if (isTravellerErased(exists)) {
      return res.status(409).json({ error: VISA_APPLICATION_ERASED_MESSAGE });
    }

    const result = await buildAssignmentUpdate(req.body || {}, actorId(req));
    if ("error" in result) {
      return res.status(result.status).json({ error: result.error });
    }

    const changes = diffAssignmentRoles(exists as any, result.set);

    const updated = await VisaApplication.findByIdAndUpdate(id, { $set: result.set }, { new: true }).lean();

    for (const change of changes) {
      await logVisaActivity({
        applicationId: id,
        requestId: (updated as any).requestId,
        workspaceId: (updated as any).workspaceId,
        eventType: assignmentEventType(change.role, change.fromUserId, change.toUserId),
        actorUserId: actorId(req),
        actorType: "STAFF",
        detail: change,
      });
    }

    res.json({ ok: true, application: mapAdminApplicationSummary(updated) });
  } catch (err: any) {
    console.error("[admin visa application assignment PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update assignment" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /applications/bulk-assign — the same assignment, applied to several
 * applications at once (task brief: "working a queue means claiming a
 * batch, not clicking twenty times"). Body: { applicationIds: string[],
 * assignedConciergeUserId?: string|null, assignedScreeningOfficerId?:
 * string|null }.
 *
 * Atomic: every applicationId must resolve to a real application, and every
 * assignee must be valid, BEFORE anything is written — a batch that's
 * half-bad applies to NONE of it, never some. The write itself is then one
 * single updateMany, not a loop of per-document writes.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/applications/bulk-assign", requirePermission("visaApplication", "WRITE"), async (req: any, res: any) => {
  try {
    const rawIds: any[] = Array.isArray(req.body?.applicationIds) ? req.body.applicationIds : [];
    const idSet = new Set<string>(rawIds.map((v: any) => String(v)));
    const ids: string[] = Array.from(idSet);
    if (ids.length === 0) {
      return res.status(400).json({ error: "applicationIds must be a non-empty array" });
    }
    if (ids.some((id) => !mongoose.isValidObjectId(id))) {
      return res.status(400).json({ error: "applicationIds must all be valid ids" });
    }

    const result = await buildAssignmentUpdate(req.body || {}, actorId(req));
    if ("error" in result) {
      return res.status(result.status).json({ error: result.error });
    }

    const existing = await VisaApplication.find({ _id: { $in: ids } })
      .select("_id requestId workspaceId assignedConciergeUserId assignedScreeningOfficerId travellerErasedAt")
      .lean();
    if (existing.length !== ids.length) {
      const foundIds = new Set(existing.map((a: any) => String(a._id)));
      const missing = ids.filter((id) => !foundIds.has(id));
      return res.status(404).json({ error: "Some applications were not found — nothing was assigned", missing });
    }

    // Same atomicity posture as the missing-ids check above — one erased
    // application in the batch means NONE of it is assigned, not "assign
    // the rest and skip that one silently."
    const erasedIds = (existing as any[]).filter((a) => isTravellerErased(a)).map((a) => String(a._id));
    if (erasedIds.length > 0) {
      return res.status(409).json({ error: VISA_APPLICATION_ERASED_MESSAGE, erasedApplicationIds: erasedIds });
    }

    await VisaApplication.updateMany({ _id: { $in: ids } }, { $set: result.set });

    for (const app of existing as any[]) {
      const changes = diffAssignmentRoles(app, result.set);
      for (const change of changes) {
        await logVisaActivity({
          applicationId: app._id,
          requestId: app.requestId,
          workspaceId: app.workspaceId,
          eventType: assignmentEventType(change.role, change.fromUserId, change.toUserId),
          actorUserId: actorId(req),
          actorType: "STAFF",
          detail: change,
        });
      }
    }

    res.json({ ok: true, updated: ids.length, applicationIds: ids });
  } catch (err: any) {
    console.error("[admin visa applications bulk-assign POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to bulk-assign" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /assignable-users — every staff user who could actually be assigned a
 * case: an active, non-suspended/revoked visaApplication WRITE or FULL
 * grant, unioned with SUPERADMINs (who bypass the gate by role — see
 * userCanBeAssignedVisaCases above, same posture as requirePermission
 * itself). Feeds the assign control in the console.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/assignable-users", requirePermission("visaApplication", "READ"), async (_req: any, res: any) => {
  try {
    const grants = await UserPermission.find({
      "modules.visaApplication.access": { $in: ["WRITE", "FULL"] },
      status: "active",
    })
      .select("userId modules.visaApplication level")
      .lean();

    const accessByUserId = new Map<string, { access: "WRITE" | "FULL"; level: string }>();
    for (const g of grants as any[]) {
      const uid = String(g.userId || "");
      if (!mongoose.isValidObjectId(uid)) continue;
      accessByUserId.set(uid, {
        access: g.modules?.visaApplication?.access,
        level: g.level?.code || "",
      });
    }

    const superAdmins = await User.find({ roles: "SUPERADMIN", status: { $ne: "INACTIVE" } })
      .select("_id")
      .lean();
    for (const u of superAdmins as any[]) {
      const uid = String(u._id);
      if (!accessByUserId.has(uid)) accessByUserId.set(uid, { access: "FULL", level: "SUPERADMIN" });
    }

    const ids = [...accessByUserId.keys()];
    const users = ids.length
      ? await User.find({ _id: { $in: ids }, status: { $ne: "INACTIVE" } }).select("_id name email").lean()
      : [];

    const shaped = users
      .map((u: any) => {
        const grant = accessByUserId.get(String(u._id))!;
        return {
          id: String(u._id),
          name: u.name || u.email || "Unnamed",
          email: u.email || null,
          access: grant.access,
          level: grant.level,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ ok: true, users: shaped });
  } catch (err: any) {
    console.error("[admin visa assignable-users GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load assignable users" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /applications/:id/activity — Phase 9c. Paginated, newest first, one
 * row per event across this application's whole lifecycle (see
 * models/VisaActivityLog.ts). Actor names resolved for the page being
 * returned, same posture as admin.visa.rules.ts's GET /rules/:id/audit.
 * ───────────────────────────────────────────────────────────────────── */
router.get(
  "/applications/:id/activity",
  requirePermission("visaApplication", "READ"),
  async (req: any, res: any) => {
    try {
      const id = req.params.id;
      if (!mongoose.isValidObjectId(id)) {
        return res.status(404).json({ error: "Visa application not found" });
      }
      const exists = await VisaApplication.findById(id).select("_id").lean();
      if (!exists) return res.status(404).json({ error: "Visa application not found" });

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

      const total = await VisaActivityLog.countDocuments({ applicationId: id });
      const entries = await VisaActivityLog.find({ applicationId: id })
        .sort({ at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      const userIds = [...new Set(entries.map((e: any) => (e.actorUserId ? String(e.actorUserId) : null)).filter(Boolean))];
      const users = userIds.length
        ? await User.find({ _id: { $in: userIds } }).select("firstName lastName name email").lean()
        : [];
      const userById = new Map(users.map((u: any) => [String(u._id), u]));

      const shaped = entries.map((e: any) => ({
        id: String(e._id),
        eventType: e.eventType,
        actorType: e.actorType,
        actor: e.actorUserId ? { id: String(e.actorUserId), name: resolveUserName(userById.get(String(e.actorUserId))) } : null,
        at: e.at,
        detail: e.detail || {},
      }));

      res.json({
        ok: true,
        activity: shaped,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      });
    } catch (err: any) {
      console.error("[admin visa application activity GET]", err?.message);
      res.status(500).json({ error: err?.message || "Failed to load activity" });
    }
  },
);

export default router;
