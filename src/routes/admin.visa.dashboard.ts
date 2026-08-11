// apps/backend/src/routes/admin.visa.dashboard.ts
//
// Phase 9f — the ops dashboard: aggregation and presentation over data that
// already exists (VisaApplication, VisaActivityLog, ManualBooking). Every
// tile is computed server-side (never "fetch rows, count in the browser")
// and carries a `filter` object the frontend turns into a query string onto
// either the queue (/admin/visa-applications) or a report download
// (/api/admin/visa/reports/activity) — a number with nowhere to click is
// decoration (task brief).
//
// Mounted at /api/admin/visa (server.ts), a fourth router at that prefix
// alongside admin.visa.ts/admin.visa.rules.ts/admin.visa.reports.ts. READ
// only — this never mutates, so it never asks for more than
// requirePermission("visaApplication", "READ").
//
// WORKSPACE-AGNOSTIC BY DESIGN — same posture as admin.visa.ts's queue:
// this is the concierge team's cross-tenant view. Unlike the queue/reports
// (which accept an optional ?workspaceId=), there is deliberately no way to
// narrow this dashboard to a single tenant — it's always every workspace.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import VisaApplication, { VISA_OPS_HIDDEN_STATUSES } from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaActivityLog from "../models/VisaActivityLog.js";
import ManualBooking from "../models/ManualBooking.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import TravellerProfile from "../models/TravellerProfile.js";
import User from "../models/User.js";
import { assessProcessingRisk } from "../utils/visaEta.js";

const router = Router();
router.use(requireAuth);

const DEFAULT_WINDOW_DAYS = 30;
const AT_RISK_TOP_N = 15;

// "Open" — still somewhere in the pipeline: not a draft the customer
// hasn't even submitted, not closed out, and no outcome recorded yet
// (decision_received always carries an outcome, so this excludes it too
// without needing to name it explicitly). Shared by AT RISK (what could
// still miss its travel date) and WORKLOAD (what's actually on someone's
// plate) — both mean the same thing by "still active".
// THE GATE. "pending_approval" joins "draft" here: a case held at the
// customer's OWN approval gate has not reached Plumtrips, so it is not at
// risk, not on anybody's plate, and must not be counted as either.
// VISA_OPS_HIDDEN_STATUSES is the shared constant; "closed" is this
// dashboard's own additional exclusion (terminal, nothing left to work).
const OPEN_APPLICATION_FILTER = {
  status: { $nin: [...VISA_OPS_HIDDEN_STATUSES, "closed"] },
  outcome: null,
};

function travellerDisplayName(t: any): string {
  return [t?.firstName, t?.middleName, t?.lastName].filter(Boolean).join(" ").trim();
}

function resolveUserName(u: any): string {
  if (!u) return "Unknown";
  return u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "Unknown";
}

function resolveWindow(query: any): { from: Date; to: Date } | { error: string } {
  let from: Date;
  if (query.dateFrom != null) {
    from = new Date(query.dateFrom);
    if (Number.isNaN(from.getTime())) return { error: "dateFrom is not a valid date" };
  } else {
    from = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000);
  }

  let to: Date;
  if (query.dateTo != null) {
    to = new Date(query.dateTo);
    if (Number.isNaN(to.getTime())) return { error: "dateTo is not a valid date" };
    to.setUTCHours(23, 59, 59, 999); // inclusive of the whole end day
  } else {
    to = new Date();
  }

  return { from, to };
}

/* ─────────────────────────────────────────────────────────────────────
 * QUEUE HEALTH — counts by status, action_required split in two.
 * ───────────────────────────────────────────────────────────────────── */
const QUEUE_HEALTH_STATUS_ORDER = [
  "draft", "submitted", "docs_under_review", "discrepancy_flagged", "action_required",
  "cost_confirmed", "lodged", "decision_received", "closed",
] as const;

async function buildQueueHealth() {
  const grouped = await VisaApplication.aggregate([
    // THE GATE. This aggregate previously grouped over EVERY application and
    // relied on QUEUE_HEALTH_STATUS_ORDER below to decide which buckets got
    // rendered — which silently means an unrendered status is still read and
    // counted. A $match makes the exclusion explicit and survives someone
    // later adding "pending_approval" to that render order.
    { $match: { status: { $nin: VISA_OPS_HIDDEN_STATUSES } } },
    {
      $group: {
        _id: { status: "$status", responded: { $cond: [{ $ne: ["$customerRespondedAt", null] }, true, false] } },
        count: { $sum: 1 },
      },
    },
  ]);

  const countByKey = new Map<string, number>();
  for (const g of grouped as any[]) {
    // Only action_required rows actually split by responded — every other
    // status's two "responded"/"not responded" buckets are folded back
    // into one count (customerRespondedAt is nulled outside an
    // action_required episode anyway, so this is just tidiness).
    const key =
      g._id.status === "action_required"
        ? g._id.responded
          ? "action_required_responded"
          : "action_required_waiting"
        : g._id.status;
    countByKey.set(key, (countByKey.get(key) ?? 0) + g.count);
  }

  const rows: Array<{ key: string; status: string; count: number; filter: Record<string, string> }> = [];
  for (const status of QUEUE_HEALTH_STATUS_ORDER) {
    if (status === "action_required") {
      rows.push({
        key: "action_required_waiting",
        status: "action_required",
        count: countByKey.get("action_required_waiting") ?? 0,
        filter: { actionRequired: "true", customerResponded: "false" },
      });
      rows.push({
        key: "action_required_responded",
        status: "action_required",
        count: countByKey.get("action_required_responded") ?? 0,
        // The most actionable number on the page (task brief) — an agent
        // needs to look at these NOW, the customer already did their part.
        filter: { actionRequired: "true", customerResponded: "true" },
      });
    } else {
      rows.push({ key: status, status, count: countByKey.get(status) ?? 0, filter: { status } });
    }
  }

  return { rows };
}

/* ─────────────────────────────────────────────────────────────────────
 * AT RISK — remaining processing runway (etaMaxDays, against travel date)
 * no longer fits. Ranked worst (most overrun) first.
 * ───────────────────────────────────────────────────────────────────── */
async function buildAtRisk() {
  const candidates = await VisaApplication.find(OPEN_APPLICATION_FILTER)
    .select("workspaceId requestId travellerProfileId ruleSnapshot")
    .lean();

  if (candidates.length === 0) {
    return { count: 0, filter: { atRisk: "true" }, topApplications: [] as any[] };
  }

  const requestIds = [...new Set(candidates.map((a: any) => String(a.requestId)))];
  const requests = await VisaRequest.find({ _id: { $in: requestIds } })
    .select("referenceNumber travelDateFrom")
    .lean();
  const requestById = new Map(requests.map((r: any) => [String(r._id), r]));

  const assessed = candidates
    .map((a: any) => {
      const request = requestById.get(String(a.requestId));
      const risk = assessProcessingRisk(request?.travelDateFrom, a.ruleSnapshot?.etaMaxDays, a.ruleSnapshot?.etaBasis);
      return risk?.atRisk ? { application: a, request, risk } : null;
    })
    .filter((x): x is { application: any; request: any; risk: NonNullable<ReturnType<typeof assessProcessingRisk>> } => x !== null);

  // Worst first — the more negative the margin, the further short of
  // etaMaxDays the remaining runway is.
  assessed.sort((x, y) => x.risk.marginDays - y.risk.marginDays);

  const top = assessed.slice(0, AT_RISK_TOP_N);

  const workspaceIds = [...new Set(top.map((t) => String(t.application.workspaceId)))];
  const workspaces = workspaceIds.length
    ? await CustomerWorkspace.find({ _id: { $in: workspaceIds } }).select("companyName").lean()
    : [];
  const workspaceById = new Map(workspaces.map((w: any) => [String(w._id), w]));

  const travellerIds = [...new Set(top.map((t) => String(t.application.travellerProfileId)))];
  const travellers = travellerIds.length
    ? await TravellerProfile.find({ _id: { $in: travellerIds } }).select("firstName middleName lastName").lean()
    : [];
  const travellerById = new Map(travellers.map((t: any) => [String(t._id), t]));

  return {
    count: assessed.length,
    filter: { atRisk: "true" },
    topApplications: top.map(({ application: a, request: r, risk }) => ({
      id: String(a._id),
      referenceNumber: r?.referenceNumber ?? null,
      workspaceName: workspaceById.get(String(a.workspaceId))?.companyName ?? null,
      travellerName: travellerDisplayName(travellerById.get(String(a.travellerProfileId))) || null,
      destinationName: a.ruleSnapshot?.destinationName ?? null,
      travelDateFrom: r?.travelDateFrom ?? null,
      availableDays: risk.availableDays,
      etaMaxDays: risk.etaMaxDays,
      marginDays: risk.marginDays,
    })),
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * WORKLOAD — open cases per concierge and per screening officer, plus an
 * unassigned (neither role set) count.
 * ───────────────────────────────────────────────────────────────────── */
async function buildWorkload() {
  const [byConcierge, byOfficer, unassignedBothCount] = await Promise.all([
    VisaApplication.aggregate([
      { $match: OPEN_APPLICATION_FILTER },
      { $group: { _id: "$assignedConciergeUserId", count: { $sum: 1 } } },
    ]),
    VisaApplication.aggregate([
      { $match: OPEN_APPLICATION_FILTER },
      { $group: { _id: "$assignedScreeningOfficerId", count: { $sum: 1 } } },
    ]),
    // Unassigned across BOTH roles — matches the queue's own
    // ?unassigned=true semantics (neither role set), not just "no
    // concierge": a case with a screening officer but no concierge isn't
    // in this bucket.
    VisaApplication.countDocuments({
      ...OPEN_APPLICATION_FILTER,
      assignedConciergeUserId: null,
      assignedScreeningOfficerId: null,
    }),
  ]);

  const conciergeRows = (byConcierge as any[]).filter((g) => g._id != null);
  const officerRows = (byOfficer as any[]).filter((g) => g._id != null);

  const userIds = [...new Set([...conciergeRows, ...officerRows].map((g) => String(g._id)))];
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } }).select("name firstName lastName email").lean()
    : [];
  const userById = new Map(users.map((u: any) => [String(u._id), u]));

  return {
    concierges: conciergeRows
      .map((g) => ({
        userId: String(g._id),
        name: resolveUserName(userById.get(String(g._id))),
        openCount: g.count as number,
        filter: { assignedConciergeUserId: String(g._id) },
      }))
      .sort((a, b) => b.openCount - a.openCount),
    screeningOfficers: officerRows
      .map((g) => ({
        userId: String(g._id),
        name: resolveUserName(userById.get(String(g._id))),
        openCount: g.count as number,
        filter: { assignedScreeningOfficerId: String(g._id) },
      }))
      .sort((a, b) => b.openCount - a.openCount),
    unassigned: { count: unassignedBothCount as number, filter: { unassigned: "true" } },
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * THROUGHPUT — submitted / lodged / decided over the selected window,
 * from the activity log (never a live-state snapshot).
 * ───────────────────────────────────────────────────────────────────── */
async function buildThroughput(from: Date, to: Date) {
  const at = { $gte: from, $lte: to };
  const [submitted, lodged, decided] = await Promise.all([
    VisaActivityLog.countDocuments({ eventType: "SUBMITTED", at }),
    VisaActivityLog.countDocuments({ eventType: "STATUS_CHANGED", "detail.to": "lodged", at }),
    VisaActivityLog.countDocuments({ eventType: "OUTCOME_RECORDED", at }),
  ]);

  return {
    submitted: { count: submitted, filter: { eventType: "SUBMITTED" } },
    lodged: { count: lodged, filter: { eventType: "STATUS_CHANGED", statusTo: "lodged" } },
    decided: { count: decided, filter: { eventType: "OUTCOME_RECORDED" } },
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * OUTCOMES — approved / rejected / withdrawn split over the same window.
 * ───────────────────────────────────────────────────────────────────── */
async function buildOutcomes(from: Date, to: Date) {
  const grouped = await VisaActivityLog.aggregate([
    { $match: { eventType: "OUTCOME_RECORDED", at: { $gte: from, $lte: to } } },
    { $group: { _id: "$detail.outcome", count: { $sum: 1 } } },
  ]);
  const countByOutcome = new Map<string, number>((grouped as any[]).map((g) => [g._id, g.count]));

  const outcomeRow = (outcome: string) => ({
    count: countByOutcome.get(outcome) ?? 0,
    filter: { eventType: "OUTCOME_RECORDED", outcome },
  });

  return {
    approved: outcomeRow("APPROVED"),
    rejected: outcomeRow("REJECTED"),
    withdrawn: outcomeRow("WITHDRAWN"),
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * VALUE — total on WIP bookings vs. CONFIRMED, kept as two separate
 * figures (task brief: committed work in flight is visible separately
 * from completed — never merged into one number).
 * ───────────────────────────────────────────────────────────────────── */
async function buildValue() {
  const grouped = await ManualBooking.aggregate([
    { $match: { type: "VISA", status: { $in: ["WIP", "CONFIRMED"] } } },
    { $group: { _id: "$status", total: { $sum: "$pricing.grandTotal" } } },
  ]);
  const totalByStatus = new Map<string, number>((grouped as any[]).map((g) => [g._id, g.total]));

  return {
    wipTotalInr: totalByStatus.get("WIP") ?? 0,
    confirmedTotalInr: totalByStatus.get("CONFIRMED") ?? 0,
    wipFilter: { mb_type: "VISA", mb_status: "WIP" },
    confirmedFilter: { mb_type: "VISA", mb_status: "CONFIRMED" },
  };
}

router.get("/dashboard", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const window = resolveWindow(req.query);
    if ("error" in window) return res.status(400).json({ error: window.error });
    const { from, to } = window;

    const [queueHealth, atRisk, workload, throughput, outcomes, value] = await Promise.all([
      buildQueueHealth(),
      buildAtRisk(),
      buildWorkload(),
      buildThroughput(from, to),
      buildOutcomes(from, to),
      buildValue(),
    ]);

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      window: { from: from.toISOString(), to: to.toISOString() },
      queueHealth,
      atRisk,
      workload,
      throughput,
      outcomes,
      value,
    });
  } catch (err: any) {
    console.error("[admin visa dashboard GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the visa dashboard" });
  }
});

export default router;
