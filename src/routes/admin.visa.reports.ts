// apps/backend/src/routes/admin.visa.reports.ts
//
// Phase 9d — CSV/XLSX report exports for the concierge team, built on
// VisaApplication and VisaActivityLog (Phase 9c). Mounted at the same base
// path as admin.visa.ts (server.ts) — a second router at /api/admin/visa,
// same convention as admin.visa.rules.ts (see that file's own header for
// why Express is fine with several routers sharing one mount prefix).
//
// Every route here is READ-only: requirePermission("visaApplication",
// "READ") and nothing higher — reports answer questions, they never
// mutate anything, so WRITE/FULL must never be required (hasAccess()'s own
// ordering already means a WRITE/FULL grant satisfies a READ gate; this
// file just never asks for more than READ in the first place).
//
// FILTERS — date range, workspace, destination, status, assignee — are
// built into the Mongo query/aggregation itself for every report, never
// "fetch everything, filter in JS" (task brief). Destination is resolved
// via VisaRequest.destinationIso2 (VisaApplication itself only carries a
// point-in-time ruleSnapshot.destinationName, no ISO2) into a requestId
// $in — a second server-side query, not an in-memory join over the whole
// collection.
//
// EXPORT ROW CAP — every report caps its OUTPUT at REPORT_ROW_CAP rows,
// reported via response headers (X-Report-*) AND a trailing notice row in
// the file itself (a header alone would never be seen by someone who just
// opens the download in Excel). See REPORT_ROW_CAP below for why 5000.
//
// PII — passport numbers are ALWAYS masked (maskTailId), with NO
// full-value escape hatch for any role — unlike routes/workspace.
// travellers.ts's own export (which lets a superadmin download the full
// number). These files get emailed and sit in inboxes; the console is
// where unmasked data lives, gated and logged — a spreadsheet never is
// (task brief).
import { Router } from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import VisaApplication, {
  VISA_APPLICATION_STATUSES,
  VISA_OPS_HIDDEN_STATUSES,
  VISA_APPLICATION_OUTCOMES,
  type VisaApplicationStatus,
} from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaActivityLog, {
  VISA_ACTIVITY_EVENT_TYPES,
  type VisaActivityEventType,
} from "../models/VisaActivityLog.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import { csvRow } from "../utils/exportHelpers.js";
import { objectIdKeys } from "../utils/objectIdKeys.js";
import { maskTailId } from "../utils/piiMask.js";

const router = Router();
router.use(requireAuth);

// Every export caps at this many DATA rows (the header row and the
// truncation notice row, if any, don't count against it). 5000 is
// generous for this module's real volume today (Phase 9c's own build
// report: "every application in the system today is test data") while
// keeping a downloaded workbook comfortably fast to open. Reported via
// X-Report-* response headers AND a trailing notice row in the file.
export const REPORT_ROW_CAP = 5000;

// The Progress Report alone must rank its ENTIRE filtered set by risk
// before it can slice to REPORT_ROW_CAP — soonest-travel-date-first only
// means something once every candidate row is present to compare against.
// This is the safety ceiling on THAT pre-rank fetch, distinct from the
// reported output cap: exceeding it means "narrow your filters", never a
// silent partial ranking (same posture as routes/invoices.ts's bulk-pdf
// 250-row ceiling).
export const PROGRESS_REPORT_FETCH_CEILING = 20000;

// Below this many days-until-travel (and not yet decided), a case is
// flagged AT RISK. Not a formally specified SLA — chosen as the point
// where "still open, travel is close" is worth a concierge's attention
// rather than a routine status.
const RISK_THRESHOLD_DAYS = 14;

const STATUS_TRANSITION_EVENT_TYPES: VisaActivityEventType[] = [
  "APPLICATION_CREATED",
  "SUBMITTED",
  "STATUS_CHANGED",
  "ACTION_REQUIRED_SET",
  "ACTION_REQUIRED_CLEARED",
  "OUTCOME_RECORDED",
];

function resolveUserName(u: any): string {
  if (!u) return "";
  return u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "";
}

function travellerDisplayName(t: any): string {
  return [t?.firstName, t?.middleName, t?.lastName].filter(Boolean).join(" ").trim();
}

function toDateOnly(v: any): string {
  return v ? new Date(v).toISOString().slice(0, 10) : "";
}

/* ─────────────────────────────────────────────────────────────────────
 * Shared filter parsing — date range, workspace, destination, status,
 * assignee. Each report applies the date-range component to its own
 * relevant field (submittedAt for case-level reports, `at` for the
 * activity report) via applyDateRange() below, rather than baking a
 * single field name in here.
 * ───────────────────────────────────────────────────────────────────── */
interface CommonFilters {
  dateFrom?: Date;
  dateTo?: Date;
  workspaceId?: mongoose.Types.ObjectId;
  destinationIso2?: string;
  status?: string;
  assigneeUserId?: mongoose.Types.ObjectId;
}

function parseCommonFilters(query: any): { filters: CommonFilters } | { error: string } {
  const filters: CommonFilters = {};

  if (query.dateFrom != null) {
    const d = new Date(query.dateFrom);
    if (Number.isNaN(d.getTime())) return { error: "dateFrom is not a valid date" };
    filters.dateFrom = d;
  }
  if (query.dateTo != null) {
    const d = new Date(query.dateTo);
    if (Number.isNaN(d.getTime())) return { error: "dateTo is not a valid date" };
    d.setUTCHours(23, 59, 59, 999); // inclusive of the whole end day
    filters.dateTo = d;
  }
  if (query.workspaceId != null) {
    if (!mongoose.isValidObjectId(query.workspaceId)) return { error: "workspaceId is not a valid id" };
    filters.workspaceId = new mongoose.Types.ObjectId(query.workspaceId);
  }
  if (query.destination != null) {
    filters.destinationIso2 = String(query.destination).trim().toUpperCase();
  }
  if (query.status != null) {
    const status = String(query.status).trim();
    if (!VISA_APPLICATION_STATUSES.includes(status as VisaApplicationStatus)) {
      return { error: `status must be one of ${VISA_APPLICATION_STATUSES.join(", ")}` };
    }
    // THE GATE. An export is as much an ops surface as the queue is — more
    // so, since it leaves the building as a file. A case held at the
    // customer's own approval gate must not be nameable here either.
    if (status === "pending_approval") {
      return {
        error: "status must be one of " +
          VISA_APPLICATION_STATUSES.filter((s) => s !== "pending_approval").join(", "),
      };
    }
    filters.status = status;
  }
  if (query.assigneeUserId != null) {
    if (!mongoose.isValidObjectId(query.assigneeUserId)) return { error: "assigneeUserId is not a valid id" };
    filters.assigneeUserId = new mongoose.Types.ObjectId(query.assigneeUserId);
  }

  return { filters };
}

function applyDateRange(filter: any, field: string, filters: CommonFilters): void {
  if (!filters.dateFrom && !filters.dateTo) return;
  filter[field] = {};
  if (filters.dateFrom) filter[field].$gte = filters.dateFrom;
  if (filters.dateTo) filter[field].$lte = filters.dateTo;
}

async function resolveRequestIdsForDestination(destinationIso2: string): Promise<mongoose.Types.ObjectId[]> {
  const requests = await VisaRequest.find({ destinationIso2 }).select("_id").lean();
  return requests.map((r: any) => r._id);
}

// workspace/status/assignee/destination only — deliberately NOT date, so
// the activity report can reuse this to resolve applicationIds without
// double-applying a date filter that belongs on VisaActivityLog.at, not on
// VisaApplication.
async function buildApplicationMatchFilter(filters: CommonFilters): Promise<any> {
  const filter: any = {};
  if (filters.workspaceId) filter.workspaceId = filters.workspaceId;
  // THE GATE. With no explicit ?status this matches EVERY application, so
  // the exclusion has to be added here rather than assumed from a narrower
  // base query.
  //
  // Excludes "pending_approval" ONLY — deliberately NOT the whole
  // VISA_OPS_HIDDEN_STATUSES set. Draft applications have always been
  // included in these reports by default, and quietly dropping them would
  // change every existing export's row count under a change that is
  // supposed to be about the approval gate and nothing else.
  if (filters.status) filter.status = filters.status;
  else filter.status = { $ne: "pending_approval" };
  if (filters.assigneeUserId) {
    filter.$or = [
      { assignedConciergeUserId: filters.assigneeUserId },
      { assignedScreeningOfficerId: filters.assigneeUserId },
    ];
  }
  if (filters.destinationIso2) {
    const requestIds = await resolveRequestIdsForDestination(filters.destinationIso2);
    // No matching destination at all -> force an empty result, same
    // idiom as manualBookings.ts's buildSearchFilter does for a bad
    // workspaceId, rather than silently dropping the destination filter.
    filter.requestId = { $in: requestIds };
  }
  return filter;
}

/* ─────────────────────────────────────────────────────────────────────
 * THE GATE, activity half (2026-08-11).
 *
 * VisaActivityLog is the one report source that is NOT a VisaApplication
 * query, so buildApplicationMatchFilter above cannot gate it — its status
 * exclusion lives on a collection this report never matches against.
 *
 * It used to be gated only as a SIDE EFFECT of the optional
 * destination/status/assignee narrowing: that branch resolved
 * buildApplicationMatchFilter into an applicationId $in, which happened to
 * exclude held cases. A DEFAULT download — the common case, and the one the
 * dashboard's throughput tiles link to — took no such branch and therefore
 * carried no exclusion at all, exporting the traveller name, reference,
 * destination and purpose of applications still held at the customer's own
 * approval gate. ?eventType=APPROVAL_REQUESTED targeted them directly.
 *
 * So the exclusion is now STRUCTURAL: these clauses are resolved
 * unconditionally, before any optional filter is read, and $and-ed onto the
 * base match. Every optional filter below narrows WITHIN them and none can
 * replace them — there is no longer a path through this route that omits
 * the gate.
 *
 * A DENY-list, not the allow-list the old branch produced, for two reasons:
 *   - request-level rows (REQUEST_CREATED, APPROVAL_REQUESTED,
 *     REQUEST_CANCELLED) carry applicationId: null, so an unconditional
 *     applicationId $in would silently drop every one of them from the
 *     default export — a real regression on rows that belong there;
 *   - the held set is transient and small (cases awaiting one approver's
 *     click), whereas the visible set is the whole collection.
 * Both ids are excluded because the request-level rows can only be reached
 * by requestId, and the application-level ones only by applicationId.
 *
 * Keyed on LIVE status, like every other gate in this module: once an
 * approver releases a request it is a real ops case, and its own approval
 * history becomes legitimately ops-visible along with it.
 *
 * "pending_approval" ONLY, deliberately not the whole
 * VISA_OPS_HIDDEN_STATUSES set — drafts have always been in these reports
 * and buildApplicationMatchFilter above says so in as many words. This
 * closes the approval hole and changes nothing else.
 * ───────────────────────────────────────────────────────────────────── */
async function buildActivityGateClauses(): Promise<any[]> {
  const held = await VisaApplication.find({ status: "pending_approval" })
    .select("_id requestId")
    .lean();
  if (held.length === 0) return [];

  const applicationIds = (held as any[]).map((a) => a._id);
  // Deduped by string id, keeping the ObjectId itself — several held
  // applications routinely share one request (one per traveller).
  const requestIds = [
    ...new Map((held as any[]).map((a) => [String(a.requestId), a.requestId])).values(),
  ];

  return [{ applicationId: { $nin: applicationIds } }, { requestId: { $nin: requestIds } }];
}

/* ─────────────────────────────────────────────────────────────────────
 * Activity detail -> human-readable summary. Exported for direct unit
 * coverage. Deliberately never echoes raw ids beyond what's already
 * elsewhere in the row (application reference, traveller) — see
 * VisaActivityLog.ts's own no-PII rule for `detail`, which this respects
 * by construction (there's no PII in `detail` to begin with).
 * ───────────────────────────────────────────────────────────────────── */
export function summarizeActivityDetail(eventType: string, detail: Record<string, any>): string {
  const d = detail || {};
  switch (eventType) {
    case "REQUEST_CREATED":
      return [d.travellerCount != null ? `${d.travellerCount} traveller(s)` : "", d.destinationIso2, d.purpose]
        .filter(Boolean)
        .join(" — ");
    case "APPLICATION_CREATED":
      return [d.destinationName, d.purpose, d.serviceTier ? `(${d.serviceTier})` : ""].filter(Boolean).join(" — ");
    case "STATUS_CHANGED":
      return d.from != null && d.to != null ? `${d.from} -> ${d.to}` : "";
    case "ACTION_REQUIRED_SET":
      return d.reason ? `Reason: ${d.reason}` : "";
    case "ACTION_REQUIRED_CLEARED":
      return d.resumedStatus ? `Resumed: ${d.resumedStatus}` : "";
    case "CUSTOMER_RESPONDED":
      return [d.docCode, d.version != null ? `v${d.version}` : ""].filter(Boolean).join(" ") || "Customer uploaded a document";
    case "ACTION_REQUIRED_AUTO_CLEARED":
      return d.resumedStatus ? `Resumed: ${d.resumedStatus} (auto-cleared — checklist complete)` : "Auto-cleared — checklist complete";
    case "OUTCOME_RECORDED":
      return d.outcome ? `Outcome: ${d.outcome}` : "";
    case "REQUEST_CANCELLED":
      return "";
    case "DOCUMENT_UPLOADED":
    case "DOCUMENT_REPLACED":
    case "DOCUMENT_DELETED":
      return [d.docCode, d.version != null ? `v${d.version}` : ""].filter(Boolean).join(" ");
    case "DOCUMENT_ACCEPTED":
      return d.docCode || "";
    case "DOCUMENT_REJECTED":
      return [d.docCode, d.reason ? `: ${d.reason}` : ""].filter(Boolean).join("");
    case "EXTRACTION_STARTED":
      return "Extraction started";
    case "EXTRACTION_COMPLETED":
      return `${d.extractionStatus || ""}${d.confidence ? ` (confidence: ${d.confidence})` : ""}`.trim();
    case "EXTRACTION_FAILED":
      return d.failureCategory ? `Failed: ${d.failureCategory}` : "Failed";
    case "FIELDS_CONFIRMED":
      return Array.isArray(d.fields) && d.fields.length ? `Fields: ${d.fields.join(", ")}` : "";
    case "CONCIERGE_ASSIGNED":
      return "Concierge assigned";
    case "CONCIERGE_CHANGED":
      return "Concierge changed";
    case "CONCIERGE_CLEARED":
      return "Concierge cleared";
    case "SCREENING_OFFICER_ASSIGNED":
      return "Screening officer assigned";
    case "SCREENING_OFFICER_CHANGED":
      return "Screening officer changed";
    case "SCREENING_OFFICER_CLEARED":
      return "Screening officer cleared";
    case "SCREENING_OFFICER_AUTO_CLAIMED":
      // Says HOW they became the officer. The export is one of the places
      // this distinction actually gets read.
      return `Screening officer auto-claimed by acting on an unassigned case${d.act ? ` (${d.act})` : ""}`;
    case "COSTS_RECORDED":
      return `Total INR ${d.actualTotalInr ?? ""}${d.varianceInr != null ? ` (variance ${d.varianceInr})` : ""}`.trim();
    case "MANUAL_BOOKING_CREATED":
    case "MANUAL_BOOKING_UPDATED":
      return d.manualBookingId ? `Booking ${d.manualBookingId}` : "";
    case "MANUAL_BOOKING_CANCELLED":
      return d.manualBookingId ? `Booking ${d.manualBookingId} cancelled${d.reason ? ` (${d.reason})` : ""}` : "Booking cancelled";
    default:
      return "";
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * CSV/XLSX response writer — shared by all four reports. Streams CSV
 * (res.write per row, same idiom as routes/manualBookings.ts's export);
 * XLSX is built in-memory then piped via workbook.xlsx.write(res) — same
 * pattern, ExcelJS supports a writable-stream target directly.
 * ───────────────────────────────────────────────────────────────────── */
async function sendReport(
  res: any,
  opts: {
    format: "csv" | "xlsx";
    filenameBase: string;
    sheetName: string;
    columns: string[];
    rows: (string | number | null)[][];
    totalMatched: number;
  },
): Promise<void> {
  const truncated = opts.totalMatched > opts.rows.length;
  res.setHeader("X-Report-Row-Count", String(opts.rows.length));
  res.setHeader("X-Report-Total-Matched", String(opts.totalMatched));
  res.setHeader("X-Report-Truncated", String(truncated));

  const noticeText = truncated
    ? `Showing ${opts.rows.length} of ${opts.totalMatched} matching rows — narrow your filters (date range, workspace, status) to see the rest.`
    : null;
  const noticeRow: (string | number)[] | null = noticeText
    ? [noticeText, ...Array(Math.max(0, opts.columns.length - 1)).fill("")]
    : null;

  if (opts.format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${opts.filenameBase}.csv"`);
    res.write(csvRow(opts.columns));
    for (const row of opts.rows) res.write(csvRow(row));
    if (noticeRow) res.write(csvRow(noticeRow));
    res.end();
    return;
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(opts.sheetName);
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const headerRow = sheet.addRow(opts.columns);
  headerRow.font = { bold: true };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };

  for (const row of opts.rows) sheet.addRow(row);

  if (noticeRow) {
    const nRow = sheet.addRow(noticeRow);
    nRow.font = { italic: true, color: { argb: "FFB00000" } };
  }

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${opts.filenameBase}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

function resolveFormat(req: any): "csv" | "xlsx" {
  return req.query.format === "xlsx" ? "xlsx" : "csv";
}

/* ─────────────────────────────────────────────────────────────────────
 * a. CASE LOG — one row per application. The workhorse report.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/reports/case-log", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const parsed = parseCommonFilters(req.query);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { filters } = parsed;

    const filter = await buildApplicationMatchFilter(filters);
    applyDateRange(filter, "submittedAt", filters);

    const totalMatched = await VisaApplication.countDocuments(filter);
    const applications = await VisaApplication.find(filter)
      .sort({ submittedAt: -1, createdAt: -1 })
      .limit(REPORT_ROW_CAP)
      .lean();

    // See utils/objectIdKeys.ts — null ids must be dropped, not stringified.
    const requestIds = objectIdKeys(applications.map((a: any) => a.requestId));
    const requests = await VisaRequest.find({ _id: { $in: requestIds } })
      .select("referenceNumber travelDateFrom travelDateTo")
      .lean();
    const requestById = new Map(requests.map((r: any) => [String(r._id), r]));

    const workspaceIds = [...new Set(applications.map((a: any) => String(a.workspaceId)))];
    const workspaces = workspaceIds.length
      ? await CustomerWorkspace.find({ _id: { $in: workspaceIds } }).select("companyName").lean()
      : [];
    const workspaceById = new Map(workspaces.map((w: any) => [String(w._id), w]));

    const travellerIds = objectIdKeys(applications.map((a: any) => a.travellerProfileId));
    const travellers = travellerIds.length
      ? await TravellerProfile.find({ _id: { $in: travellerIds } }).select("firstName middleName lastName passportNo").lean()
      : [];
    const travellerById = new Map(travellers.map((t: any) => [String(t._id), t]));

    const assigneeIds = [
      ...new Set(
        applications
          .flatMap((a: any) => [a.assignedConciergeUserId, a.assignedScreeningOfficerId])
          .filter(Boolean)
          .map(String),
      ),
    ];
    const assignees = assigneeIds.length
      ? await User.find({ _id: { $in: assigneeIds } }).select("name firstName lastName email").lean()
      : [];
    const assigneeById = new Map(assignees.map((u: any) => [String(u._id), u]));

    const now = new Date();
    const columns = [
      "Reference", "Workspace", "Traveller", "Passport (masked)", "Destination", "Purpose", "Service Tier",
      "Status", "Submitted Date", "Lodged Date", "Outcome", "Visa Number",
      "Assigned Concierge", "Assigned Screening Officer",
      "Travel Date From", "Travel Date To", "Days Until Travel",
      "Indicative Cost (INR)", "Actual Cost (INR)", "Variance (INR)",
      // Appended, not interleaved — keeps every existing column index
      // stable for anyone already parsing this report by position.
      "Service Partner",
    ];

    const rows = applications.map((a: any) => {
      const request = requestById.get(String(a.requestId));
      const workspace = workspaceById.get(String(a.workspaceId));
      const traveller = travellerById.get(String(a.travellerProfileId));
      const travelDateFrom = request?.travelDateFrom ?? null;
      const daysUntilTravel = travelDateFrom
        ? Math.round((new Date(travelDateFrom).getTime() - now.getTime()) / 86400000)
        : null;
      const indicative = a.indicativeCostSnapshot?.totalInr ?? null;
      const actual = a.actualTotalInr ?? null;
      const variance = indicative != null && actual != null ? actual - indicative : null;

      return [
        request?.referenceNumber ?? "",
        workspace?.companyName ?? "",
        travellerDisplayName(traveller),
        maskTailId(traveller?.passportNo) ?? "",
        a.ruleSnapshot?.destinationName ?? "",
        a.ruleSnapshot?.purpose ?? "",
        a.ruleSnapshot?.serviceTier ?? "",
        a.status,
        toDateOnly(a.submittedAt),
        toDateOnly(a.lodgedAt),
        a.outcome ?? "",
        a.visaNumber ?? "",
        resolveUserName(assigneeById.get(String(a.assignedConciergeUserId))),
        resolveUserName(assigneeById.get(String(a.assignedScreeningOfficerId))),
        toDateOnly(travelDateFrom),
        toDateOnly(request?.travelDateTo),
        daysUntilTravel ?? "",
        indicative ?? "",
        actual ?? "",
        variance ?? "",
        a.servicePartnerName ?? "",
      ];
    });

    await sendReport(res, {
      format: resolveFormat(req),
      filenameBase: "visa-case-log",
      sheetName: "Case Log",
      columns,
      rows,
      totalMatched,
    });
  } catch (err: any) {
    console.error("[admin visa reports case-log GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to generate case log report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * b. ACTIVITY REPORT — one row per VisaActivityLog entry.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/reports/activity", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const parsed = parseCommonFilters(req.query);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { filters } = parsed;

    // THE GATE. Resolved FIRST and unconditionally — before a single
    // optional filter below is read — so no path through this route,
    // including the no-filter default download, can skip it. See
    // buildActivityGateClauses.
    const gateClauses = await buildActivityGateClauses();

    const activityFilter: any = {};
    if (filters.workspaceId) activityFilter.workspaceId = filters.workspaceId;
    applyDateRange(activityFilter, "at", filters);

    if (req.query.actorUserId != null) {
      if (!mongoose.isValidObjectId(req.query.actorUserId)) {
        return res.status(400).json({ error: "actorUserId is not a valid id" });
      }
      activityFilter.actorUserId = new mongoose.Types.ObjectId(req.query.actorUserId);
    }
    if (req.query.eventType != null) {
      const eventType = String(req.query.eventType).trim();
      if (!VISA_ACTIVITY_EVENT_TYPES.includes(eventType as VisaActivityEventType)) {
        return res.status(400).json({ error: `eventType must be one of ${VISA_ACTIVITY_EVENT_TYPES.join(", ")}` });
      }
      activityFilter.eventType = eventType;
    }
    // Phase 9f dashboard drilldowns — narrows a STATUS_CHANGED filter to a
    // specific target status (e.g. ?eventType=STATUS_CHANGED&statusTo=lodged
    // for "how many cases were lodged this window") and an OUTCOME_RECORDED
    // filter to a specific outcome (?eventType=OUTCOME_RECORDED&outcome=
    // APPROVED). Both just narrow whatever eventType filter is already in
    // place; neither requires eventType to be set, but only means something
    // paired with the matching one.
    if (req.query.statusTo != null) {
      activityFilter["detail.to"] = String(req.query.statusTo).trim();
    }
    if (req.query.outcome != null) {
      const outcome = String(req.query.outcome).trim().toUpperCase();
      if (!VISA_APPLICATION_OUTCOMES.includes(outcome as any)) {
        return res.status(400).json({ error: `outcome must be one of ${VISA_APPLICATION_OUTCOMES.join(", ")}` });
      }
      activityFilter["detail.outcome"] = outcome;
    }

    // destination/status/assignee aren't fields on VisaActivityLog itself
    // — resolved via a second, server-side query against VisaApplication
    // into an applicationId $in, never an in-memory filter over every row.
    if (filters.destinationIso2 || filters.status || filters.assigneeUserId) {
      const appFilter = await buildApplicationMatchFilter(filters);
      const matchingApps = await VisaApplication.find(appFilter).select("_id").lean();
      activityFilter.applicationId = { $in: matchingApps.map((a: any) => a._id) };
    }

    // The gate clauses are $and-ed ON TOP of everything above rather than
    // merged into it: an optional filter can only ever narrow the result
    // further, never widen it back past the exclusion.
    if (gateClauses.length > 0) activityFilter.$and = gateClauses;

    const totalMatched = await VisaActivityLog.countDocuments(activityFilter);
    const entries = await VisaActivityLog.find(activityFilter).sort({ at: -1 }).limit(REPORT_ROW_CAP).lean();

    const userIds = [...new Set(entries.map((e: any) => e.actorUserId).filter(Boolean).map(String))];
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select("name firstName lastName email").lean()
      : [];
    const userById = new Map(users.map((u: any) => [String(u._id), u]));

    const requestIds = [...new Set(entries.map((e: any) => String(e.requestId)))];
    const visaRequests = requestIds.length
      ? await VisaRequest.find({ _id: { $in: requestIds } }).select("referenceNumber").lean()
      : [];
    const requestById = new Map(visaRequests.map((r: any) => [String(r._id), r]));

    const applicationIds = [...new Set(entries.map((e: any) => e.applicationId).filter(Boolean).map(String))];
    const applications = applicationIds.length
      ? await VisaApplication.find({ _id: { $in: applicationIds } }).select("travellerProfileId").lean()
      : [];
    const applicationById = new Map(applications.map((a: any) => [String(a._id), a]));

    const travellerIds = [...new Set(applications.map((a: any) => String((a as any).travellerProfileId)))];
    const travellers = travellerIds.length
      ? await TravellerProfile.find({ _id: { $in: travellerIds } }).select("firstName middleName lastName").lean()
      : [];
    const travellerById = new Map(travellers.map((t: any) => [String(t._id), t]));

    const columns = ["Timestamp", "Actor Name", "Actor Type", "Event Type", "Application Reference", "Traveller", "Summary"];

    const rows = entries.map((e: any) => {
      const application = e.applicationId ? applicationById.get(String(e.applicationId)) : null;
      const traveller = application ? travellerById.get(String((application as any).travellerProfileId)) : null;
      return [
        e.at ? new Date(e.at).toISOString() : "",
        e.actorUserId ? resolveUserName(userById.get(String(e.actorUserId))) : "System",
        e.actorType,
        e.eventType,
        requestById.get(String(e.requestId))?.referenceNumber ?? "",
        traveller ? travellerDisplayName(traveller) : "",
        summarizeActivityDetail(e.eventType, e.detail || {}),
      ];
    });

    await sendReport(res, {
      format: resolveFormat(req),
      filenameBase: "visa-activity-report",
      sheetName: "Activity",
      columns,
      rows,
      totalMatched,
    });
  } catch (err: any) {
    console.error("[admin visa reports activity GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to generate activity report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * c. STATUS REPORT — counts by status x destination x workspace. A
 * snapshot, not a history: every row is a count, computed server-side via
 * aggregation, never a per-application fetch.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/reports/status", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const parsed = parseCommonFilters(req.query);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { filters } = parsed;

    const filter = await buildApplicationMatchFilter(filters);
    applyDateRange(filter, "submittedAt", filters);

    const grouped = await VisaApplication.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { status: "$status", destination: "$ruleSnapshot.destinationName", workspaceId: "$workspaceId" },
          count: { $sum: 1 },
        },
      },
    ]);

    const totalMatched = grouped.length;
    const capped = grouped.slice(0, REPORT_ROW_CAP);

    const workspaceIds = [...new Set(capped.map((g: any) => String(g._id.workspaceId)))];
    const workspaces = workspaceIds.length
      ? await CustomerWorkspace.find({ _id: { $in: workspaceIds } }).select("companyName").lean()
      : [];
    const workspaceById = new Map(workspaces.map((w: any) => [String(w._id), w]));

    const columns = ["Status", "Destination", "Workspace", "Count"];
    const rows = capped
      .map((g: any) => [
        g._id.status,
        g._id.destination ?? "",
        workspaceById.get(String(g._id.workspaceId))?.companyName ?? "",
        g.count as number,
      ])
      .sort((a, b) => (b[3] as number) - (a[3] as number));

    await sendReport(res, {
      format: resolveFormat(req),
      filenameBase: "visa-status-report",
      sheetName: "Status",
      columns,
      rows,
      totalMatched,
    });
  } catch (err: any) {
    console.error("[admin visa reports status GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to generate status report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * d. PROGRESS REPORT — per application: time in current status, age
 * since submission, at-risk-against-travel-date. Sorted by risk (soonest
 * travel date first among undecided cases; decided/closed cases sort
 * last).
 * ───────────────────────────────────────────────────────────────────── */
router.get("/reports/progress", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const parsed = parseCommonFilters(req.query);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { filters } = parsed;

    const filter = await buildApplicationMatchFilter(filters);
    applyDateRange(filter, "submittedAt", filters);
    // "Time in status"/"age since submission" don't apply pre-submission —
    // excluded by default. An explicit ?status=draft still wins (respects
    // a deliberate ask over this default).
    //
    // Keyed on filters.status (was the CALLER's explicit ask?) rather than
    // on filter.status (did anything get set?) — buildApplicationMatchFilter
    // now always sets a status clause for the approval gate, so the old
    // "nothing set it yet" test would never fire again and this report would
    // silently start including drafts.
    if (!filters.status) filter.status = { $nin: VISA_OPS_HIDDEN_STATUSES };

    const totalBeforeCeiling = await VisaApplication.countDocuments(filter);
    if (totalBeforeCeiling > PROGRESS_REPORT_FETCH_CEILING) {
      return res.status(413).json({
        error:
          `${totalBeforeCeiling} applications match these filters — narrow the filter ` +
          `(date range, workspace, status) to ${PROGRESS_REPORT_FETCH_CEILING} or fewer; this report ` +
          `must rank the full filtered set by risk before it can cap the export.`,
      });
    }

    const applications = await VisaApplication.find(filter)
      .select("workspaceId requestId travellerProfileId status outcome submittedAt createdAt")
      .lean();

    const requestIds = objectIdKeys(applications.map((a: any) => a.requestId));
    const requests = requestIds.length
      ? await VisaRequest.find({ _id: { $in: requestIds } }).select("referenceNumber travelDateFrom").lean()
      : [];
    const requestById = new Map(requests.map((r: any) => [String(r._id), r]));

    const workspaceIds = [...new Set(applications.map((a: any) => String(a.workspaceId)))];
    const workspaces = workspaceIds.length
      ? await CustomerWorkspace.find({ _id: { $in: workspaceIds } }).select("companyName").lean()
      : [];
    const workspaceById = new Map(workspaces.map((w: any) => [String(w._id), w]));

    const travellerIds = objectIdKeys(applications.map((a: any) => a.travellerProfileId));
    const travellers = travellerIds.length
      ? await TravellerProfile.find({ _id: { $in: travellerIds } }).select("firstName middleName lastName").lean()
      : [];
    const travellerById = new Map(travellers.map((t: any) => [String(t._id), t]));

    const applicationIds = applications.map((a: any) => a._id);
    const transitions = applicationIds.length
      ? await VisaActivityLog.aggregate([
          { $match: { applicationId: { $in: applicationIds }, eventType: { $in: STATUS_TRANSITION_EVENT_TYPES } } },
          { $sort: { at: -1 } },
          { $group: { _id: "$applicationId", lastTransitionAt: { $first: "$at" } } },
        ])
      : [];
    const lastTransitionByApplication = new Map(transitions.map((t: any) => [String(t._id), t.lastTransitionAt]));

    const now = new Date();
    const shaped = applications.map((a: any) => {
      const request = requestById.get(String(a.requestId));
      const workspace = workspaceById.get(String(a.workspaceId));
      const traveller = travellerById.get(String(a.travellerProfileId));

      // Falls back to createdAt when this application has no logged
      // transition at all — Phase 9c logs from its ship date forward
      // only (no backfill), so a pre-existing application can genuinely
      // have none.
      const statusSince = lastTransitionByApplication.get(String(a._id)) ?? a.createdAt;
      const daysInCurrentStatus = statusSince
        ? Math.floor((now.getTime() - new Date(statusSince).getTime()) / 86400000)
        : null;
      const ageSinceSubmissionDays = a.submittedAt
        ? Math.floor((now.getTime() - new Date(a.submittedAt).getTime()) / 86400000)
        : null;

      const travelDateFrom = request?.travelDateFrom ?? null;
      const daysUntilTravel = travelDateFrom
        ? Math.round((new Date(travelDateFrom).getTime() - now.getTime()) / 86400000)
        : null;

      const decided = Boolean(a.outcome) || a.status === "closed";
      const atRisk = !decided && daysUntilTravel != null && daysUntilTravel <= RISK_THRESHOLD_DAYS;

      // Decided/closed cases sort last (nothing left to risk); undated
      // cases sort just above those (can't be ranked, but aren't actively
      // at risk either); everything else sorts by soonest travel date
      // first, including a negative daysUntilTravel — already past, the
      // most urgent of all.
      const riskRank = decided
        ? Number.POSITIVE_INFINITY
        : daysUntilTravel == null
          ? Number.POSITIVE_INFINITY - 1
          : daysUntilTravel;

      return {
        riskRank,
        row: [
          request?.referenceNumber ?? "",
          workspace?.companyName ?? "",
          travellerDisplayName(traveller),
          a.status,
          daysInCurrentStatus ?? "",
          ageSinceSubmissionDays ?? "",
          toDateOnly(travelDateFrom),
          daysUntilTravel ?? "",
          atRisk ? "AT RISK" : "",
        ] as (string | number)[],
      };
    });

    shaped.sort((a, b) => a.riskRank - b.riskRank);

    const totalMatched = shaped.length;
    const rows = shaped.slice(0, REPORT_ROW_CAP).map((s) => s.row);

    const columns = [
      "Reference", "Workspace", "Traveller", "Current Status",
      "Days In Current Status", "Days Since Submission",
      "Travel Date", "Days Until Travel", "Risk",
    ];

    await sendReport(res, {
      format: resolveFormat(req),
      filenameBase: "visa-progress-report",
      sheetName: "Progress",
      columns,
      rows,
      totalMatched,
    });
  } catch (err: any) {
    console.error("[admin visa reports progress GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to generate progress report" });
  }
});

export default router;
