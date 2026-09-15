// apps/backend/src/services/pendingWork.service.ts
//
// "What is still open on this person?" — the pre-deactivation guard
// (2026-09-16). Read-only. One function, three sections:
//
//   awaitingAction — BUCKET 1: they are the approver / assignee and the item
//                    is open → it STALLS when they are deactivated.
//   owned          — BUCKET 2: they own it and it is open → left with no
//                    owner.
//   standing       — reports-to links and standing role assignments that
//                    point at them. Count + names only; surfaced even when
//                    the buckets are empty, because future work routes here.
//
// Source list and every "open" filter were confirmed against the models'
// real enums (see the 2026-09-16 audit); do not loosen a filter without
// re-reading the model. Historical / audit-style refs (createdBy, *By,
// invoices, payslips, bookings) are deliberately NOT here — those must keep
// resolving the person by id and must never read as "pending".
//
// JOIN RIGOR: leave approvals, OD approvals and the reports-to count depend
// on the User._id ↔ Employee._id join (Employee.ownerId / Employee.managerId,
// Employee id-space). When the join cannot be made — no Employee row, several
// rows, a report row with no ownerId — the affected source is returned with
// `count: null` + `unresolved: true` and a flag, never a silent 0.
import mongoose from "mongoose";
import Employee from "../models/Employee.js";
import User from "../models/User.js";
import Task from "../models/Task.js";
import Ticket from "../models/Ticket.js";
import Report from "../models/Report.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import SBTRequest from "../models/SBTRequest.js";
import CustomerApprovalRequest from "../models/CustomerApprovalRequest.js";
import ManualBooking from "../models/ManualBooking.js";
import VisaApplication from "../models/VisaApplication.js";
import LeaveRequest from "../models/LeaveRequest.js";
import Attendance from "../models/Attendance.js";
import Lead from "../models/Lead.js";
import Opportunity from "../models/Opportunity.js";
import ReimbursementClaim from "../models/ReimbursementClaim.js";
import EmployeeDeclaration from "../models/EmployeeDeclaration.js";
import ManualDateChangeRequest from "../models/ManualDateChangeRequest.js";
import Department from "../models/Department.js";
import CRMCompany from "../models/CRMCompany.js";
import CRMContact from "../models/CRMContact.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import TravellerProfile from "../models/TravellerProfile.js";
import Pipeline from "../models/Pipeline.js";

/** Drill-down rows per source — enough to act on, not a report. */
const ITEM_LIMIT = 10;
/** Names listed per standing assignment. */
const NAME_LIMIT = 25;

export interface PendingWorkItem {
  id: string;
  title: string;
  status: string;
  /** Frontend path where this item can be actioned / reassigned. */
  href: string;
}

export interface PendingWorkSource {
  key: string;
  label: string;
  /** null = could not be resolved (see `unresolved` + report.flags). */
  count: number | null;
  unresolved?: true;
  items: PendingWorkItem[];
  /** Frontend path for the whole list. */
  hrefAll: string;
}

export interface StandingAssignment {
  key: string;
  label: string;
  count: number | null;
  unresolved?: true;
  names: string[];
}

export interface PendingWorkReport {
  userId: string;
  workspaceId: string | null;
  employeeIds: string[];
  awaitingAction: PendingWorkSource[];
  owned: PendingWorkSource[];
  standing: StandingAssignment[];
  flags: string[];
  totals: { awaitingAction: number; owned: number; standing: number };
  generatedAt: string;
}

/** Compact form stored on the deactivation audit row. */
export interface PendingWorkSnapshot {
  awaitingAction: Record<string, number | null>;
  owned: Record<string, number | null>;
  standing: Record<string, number | null>;
  totals: PendingWorkReport["totals"];
  flags: string[];
  generatedAt: string;
}

export function summarizePendingWork(report: PendingWorkReport): PendingWorkSnapshot {
  const toMap = (rows: Array<{ key: string; count: number | null }>) =>
    Object.fromEntries(rows.map((r) => [r.key, r.count]));
  return {
    awaitingAction: toMap(report.awaitingAction),
    owned: toMap(report.owned),
    standing: toMap(report.standing),
    totals: report.totals,
    flags: report.flags,
    generatedAt: report.generatedAt,
  };
}

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const personName = (u: any): string =>
  (u?.name && String(u.name).trim()) ||
  [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() ||
  (u?.fullName && String(u.fullName).trim()) ||
  (u?.email ? String(u.email) : "") ||
  "(unnamed)";
const fmtDate = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/** count + first N rows in one place, so every source is shaped the same. */
async function source(
  key: string,
  label: string,
  model: mongoose.Model<any>,
  filter: Record<string, unknown>,
  hrefAll: string,
  toItem: (doc: any) => PendingWorkItem,
  sort: Record<string, 1 | -1> = { updatedAt: -1 },
): Promise<PendingWorkSource> {
  const [count, docs] = await Promise.all([
    model.countDocuments(filter),
    model.find(filter).sort(sort).limit(ITEM_LIMIT).lean(),
  ]);
  return { key, label, count, items: (docs as any[]).map(toItem), hrefAll };
}

function unresolvedSource(key: string, label: string, hrefAll: string): PendingWorkSource {
  return { key, label, count: null, unresolved: true, items: [], hrefAll };
}

export async function collectPendingWork(args: {
  userId: mongoose.Types.ObjectId | string;
  workspaceId?: mongoose.Types.ObjectId | string | null;
}): Promise<PendingWorkReport> {
  const userId = oid(args.userId);
  const wsId = args.workspaceId ? oid(args.workspaceId) : null;
  const wsScope: Record<string, unknown> = wsId ? { workspaceId: wsId } : {};
  const flags: string[] = [];

  /* ── The User ↔ Employee join, resolved explicitly ──────────────────── */
  const employeeRows = (await Employee.find({ ownerId: userId, ...wsScope })
    .select("_id ownerId workspaceId")
    .lean()) as any[];
  const employeeIds = employeeRows.map((e) => e._id as mongoose.Types.ObjectId);

  let joinOk = true;
  if (employeeRows.length === 0) {
    joinOk = false;
    flags.push(
      "No Employee row is linked to this user (Employee.ownerId) — direct reports, pending leave approvals and OD approvals could not be resolved; verify manually.",
    );
  } else if (employeeRows.length > 1) {
    flags.push(
      `${employeeRows.length} Employee rows are linked to this user — direct reports were resolved across all of them; verify the link manually.`,
    );
  }

  // Direct reports in Employee id-space → their User ids. This is exactly the
  // hop /leaves/team and /attendance/regularize/team make to decide who this
  // person approves for.
  let reportUserIds: mongoose.Types.ObjectId[] = [];
  let reportEmployeeRows: any[] = [];
  if (joinOk) {
    reportEmployeeRows = (await Employee.find({ managerId: { $in: employeeIds }, ...wsScope })
      .select("_id ownerId fullName name email")
      .lean()) as any[];
    const missingOwner = reportEmployeeRows.filter((e) => !e.ownerId);
    if (missingOwner.length) {
      flags.push(
        `${missingOwner.length} direct report(s) have an Employee row with no ownerId — their pending leave/OD requests could not be resolved; verify manually.`,
      );
    }
    reportUserIds = reportEmployeeRows.filter((e) => e.ownerId).map((e) => oid(e.ownerId));
  }

  /* ── BUCKET 1 — awaiting this person's action ───────────────────────── */
  const awaitingAction: PendingWorkSource[] = await Promise.all([
    source("tasks", "Tasks assigned", Task,
      { assignedTo: userId, status: { $in: ["OPEN", "IN_PROGRESS"] }, isActive: true },
      "/admin/tasks",
      (d) => ({ id: String(d._id), title: d.title || "(untitled task)", status: d.status, href: "/admin/tasks" })),
    source("tickets", "Support tickets assigned", Ticket,
      { assignedTo: userId, status: { $ne: "CLOSED" } },
      "/admin/tickets",
      (d) => ({ id: String(d._id), title: d.subject || "(ticket)", status: d.status, href: `/admin/tickets/${d._id}` })),
    source("expenseClaimsToApprove", "Expense claims to approve", Report,
      { approverId: userId, status: { $in: ["submitted", "clarification_required"] } },
      "/expenses/approvals",
      (d) => ({ id: String(d._id), title: [d.ref, d.name].filter(Boolean).join(" · ") || "(claim)", status: d.status, href: `/expenses/claims/${d._id}` })),
    source("advancesToApprove", "Expense advances to approve", ExpenseAdvance,
      { approverId: userId, status: { $in: ["awaiting_approval", "clarification_required"] } },
      "/expenses/advances/queues",
      (d) => ({ id: String(d._id), title: [d.ref, d.purpose].filter(Boolean).join(" · ") || "(advance)", status: d.status, href: `/expenses/advances/${d._id}` })),
    source("sbtRequestsToBook", "SBT requests to book", SBTRequest,
      { assignedBookerId: userId, status: "PENDING" },
      "/sbt/inbox",
      (d) => ({ id: String(d._id), title: `${d.type || "travel"} request${d.passengerDetails?.[0] ? ` · ${`${d.passengerDetails[0].firstName || ""} ${d.passengerDetails[0].lastName || ""}`.trim()}` : ""}`, status: d.status, href: "/sbt/inbox" })),
    source("travelApprovalsToDecide", "Travel approvals to decide", CustomerApprovalRequest,
      { approverId: userId, status: { $in: ["pending", "on_hold"] } },
      "/admin/approvals",
      (d) => ({ id: String(d._id), title: d.ticketId ? `Ticket ${d.ticketId}` : "(approval request)", status: d.status, href: "/admin/approvals" })),
    source("manualBookingsAssigned", "Manual bookings assigned (ops)", ManualBooking,
      { assignPerson: userId, status: { $in: ["PENDING", "WIP"] }, isActive: { $ne: false } },
      "/admin/manual-bookings",
      (d) => ({ id: String(d._id), title: [d.bookingRef, d.travellerName].filter(Boolean).join(" · ") || "(booking)", status: d.status, href: `/admin/manual-bookings/${d._id}/edit` })),
    source("visaApplicationsAssigned", "Visa applications assigned", VisaApplication,
      { $or: [{ assignedConciergeUserId: userId }, { assignedScreeningOfficerId: userId }], status: { $nin: ["draft", "pending_approval", "closed"] } },
      "/admin/visa-applications",
      (d) => ({ id: String(d._id), title: d.destinationName || "(visa application)", status: d.status, href: `/admin/visa-applications/${d._id}` })),
    joinOk
      ? source("leaveApprovalsOfReports", "Leave requests from direct reports", LeaveRequest,
          { userId: { $in: reportUserIds }, status: "PENDING", ...wsScope },
          "/leaves/team",
          (d) => ({ id: String(d._id), title: `${d.type || "Leave"} · ${fmtDate(d.from)} → ${fmtDate(d.to)}`, status: d.status, href: "/leaves/team" }),
          { from: 1 })
      : unresolvedSource("leaveApprovalsOfReports", "Leave requests from direct reports", "/leaves/team"),
    joinOk
      ? source("odApprovalsOfReports", "Attendance regularisations from direct reports", Attendance,
          { userId: { $in: reportUserIds }, "odRequests.status": "PENDING", ...wsScope },
          "/attendance/regularize",
          (d) => ({ id: String(d._id), title: `Regularisation · ${d.date || ""}`, status: "PENDING", href: "/attendance/regularize" }),
          { date: -1 })
      : unresolvedSource("odApprovalsOfReports", "Attendance regularisations from direct reports", "/attendance/regularize"),
  ]);

  /* ── BUCKET 2 — owned by this person, still open ─────────────────────── */
  const owned: PendingWorkSource[] = await Promise.all([
    source("leads", "Open leads owned", Lead,
      { assignedTo: userId, stage: { $nin: ["won", "lost"] } },
      "/leads",
      (d) => ({ id: String(d._id), title: [d.leadCode, d.companyName || d.contactName].filter(Boolean).join(" · ") || "(lead)", status: d.stage, href: `/leads/${d._id}` })),
    source("opportunities", "Open opportunities owned", Opportunity,
      { ownerUserId: userId, stage: { $nin: ["closed_won", "closed_lost"] } },
      "/opportunities",
      (d) => ({ id: String(d._id), title: d.name || "(opportunity)", status: d.stage, href: `/opportunities/${d._id}` })),
    source("ownLeaveRequests", "Own pending leave requests", LeaveRequest,
      { userId, status: "PENDING" },
      "/leaves/my",
      (d) => ({ id: String(d._id), title: `${d.type || "Leave"} · ${fmtDate(d.from)} → ${fmtDate(d.to)}`, status: d.status, href: "/leaves/my" }),
      { from: 1 }),
    source("ownExpenseClaims", "Own expense claims in flight", Report,
      { employeeId: userId, status: { $in: ["submitted", "clarification_required"] } },
      "/expenses/claims",
      (d) => ({ id: String(d._id), title: [d.ref, d.name].filter(Boolean).join(" · ") || "(claim)", status: d.status, href: `/expenses/claims/${d._id}` })),
    source("ownAdvances", "Own expense advances open", ExpenseAdvance,
      { requesterId: userId, status: { $nin: ["draft", "declined", "settled", "cancelled"] } },
      "/expenses/advances",
      (d) => ({ id: String(d._id), title: [d.ref, d.purpose].filter(Boolean).join(" · ") || "(advance)", status: d.status, href: `/expenses/advances/${d._id}` })),
    source("ownReimbursementClaims", "Own payroll reimbursement claims submitted", ReimbursementClaim,
      { userId, status: "SUBMITTED" },
      "/payroll/reimbursements",
      (d) => ({ id: String(d._id), title: `Reimbursement · ${d.month || ""}`, status: d.status, href: "/payroll/reimbursements" })),
    source("ownSbtRequests", "Own SBT requests pending", SBTRequest,
      { requesterId: userId, status: "PENDING" },
      "/sbt/my-requests",
      (d) => ({ id: String(d._id), title: `${d.type || "travel"} request`, status: d.status, href: "/sbt/my-requests" })),
    source("ownTravelApprovals", "Own travel approval requests pending", CustomerApprovalRequest,
      { requesterId: userId, status: { $in: ["pending", "on_hold"] } },
      "/customer/approvals/mine",
      (d) => ({ id: String(d._id), title: d.ticketId ? `Ticket ${d.ticketId}` : "(approval request)", status: d.status, href: "/customer/approvals/mine" })),
    source("ownDeclarations", "Tax declarations unsubmitted / in flight", EmployeeDeclaration,
      { userId, $or: [{ declarationStatus: { $in: ["DRAFT", "SUBMITTED", "HR_UNLOCKED"] } }, { proofStatus: { $in: ["PARTIAL", "SUBMITTED"] } }] },
      "/payroll/declarations/manage",
      (d) => ({ id: String(d._id), title: `Declaration · FY ${d.financialYear || ""}`, status: `${d.declarationStatus || ""}${d.proofStatus ? ` / proof ${d.proofStatus}` : ""}`, href: "/payroll/declarations/manage" })),
    source("ownDateChangeRequests", "Own hotel date-change requests open", ManualDateChangeRequest,
      { userId, status: { $in: ["REQUESTED", "IN_DISCUSSION", "APPROVED"] } },
      "/admin/sbt/date-change-requests",
      (d) => ({ id: String(d._id), title: d.hotelName || "(date change)", status: d.status, href: "/admin/sbt/date-change-requests" })),
  ]);

  /* ── STANDING — reports-to links and role assignments ────────────────── */
  const standing: StandingAssignment[] = [];

  // Reports-to: User-space links (managerId/L2/L3/hrOwnerId) ∪ Employee-space
  // (Employee.managerId → owner). One person, counted once.
  {
    const userSpace = (await User.find({
      $or: [{ managerId: userId }, { managerL2Id: userId }, { managerL3Id: userId }, { hrOwnerId: userId }],
      ...wsScope,
    }).select("_id name firstName lastName email").lean()) as any[];
    const byId = new Map<string, string>();
    for (const u of userSpace) byId.set(String(u._id), personName(u));
    const reportOwnerIds = reportEmployeeRows.filter((e) => e.ownerId).map((e) => String(e.ownerId));
    const missing = reportOwnerIds.filter((id) => !byId.has(id));
    if (missing.length) {
      const extra = (await User.find({ _id: { $in: missing.map(oid) } }).select("_id name firstName lastName email").lean()) as any[];
      for (const u of extra) byId.set(String(u._id), personName(u));
    }
    for (const e of reportEmployeeRows) {
      if (e.ownerId && !byId.has(String(e.ownerId))) byId.set(String(e.ownerId), personName(e));
    }
    const names = [...byId.values()].sort((a, b) => a.localeCompare(b));
    standing.push({
      key: "reportsTo",
      label: "People who report to them (reporting line)",
      count: joinOk ? names.length : null,
      ...(joinOk ? {} : { unresolved: true as const }),
      names: names.slice(0, NAME_LIMIT),
    });
  }

  const standingSource = async (
    key: string,
    label: string,
    model: mongoose.Model<any>,
    filter: Record<string, unknown>,
    nameOf: (d: any) => string,
  ) => {
    const [count, docs] = await Promise.all([
      model.countDocuments(filter),
      model.find(filter).limit(NAME_LIMIT).lean(),
    ]);
    standing.push({ key, label, count, names: (docs as any[]).map(nameOf).filter(Boolean) });
  };

  await standingSource("departmentManager", "Departments they manage", Department,
    { managerId: userId, isActive: { $ne: false }, ...wsScope }, (d) => d.name);
  await standingSource("crmAccountManager", "CRM companies they account-manage", CRMCompany,
    { accountManagerId: userId }, (d) => d.name);
  await standingSource("crmContacts", "CRM contacts assigned to them", CRMContact,
    { assignedTo: userId, status: { $ne: "inactive" } }, (d) => [d.firstName, d.lastName].filter(Boolean).join(" ") || d.companyName || "(contact)");
  await standingSource("workspaceRoles", "Client workspaces where they hold a role", CustomerWorkspace,
    { $or: [{ accountManagerId: userId }, { "config.seniorApproverId": userId }, { adminUserId: userId }] },
    (d) => d.companyName || d.slug || String(d._id));
  await standingSource("travellerApprover", "Travellers routed to them (tour approver / manager / finance)", TravellerProfile,
    { $or: [{ tourApproverId: userId }, { reportingManagerId: userId }, { officialUserId: userId }, { financeUserId: userId }], isActive: { $ne: false } },
    (d) => d.name || [d.firstName, d.lastName].filter(Boolean).join(" ") || "(traveller)");
  await standingSource("sbtBookerFor", "Users they are the assigned SBT booker for", User,
    { sbtAssignedBookerId: userId, ...wsScope }, personName);
  await standingSource("pipelinesOwned", "CRM pipelines they own", Pipeline,
    { ownerId: userId }, (d) => d.name);

  const sum = (rows: Array<{ count: number | null }>) => rows.reduce((n, r) => n + (r.count ?? 0), 0);

  return {
    userId: String(userId),
    workspaceId: wsId ? String(wsId) : null,
    employeeIds: employeeIds.map(String),
    awaitingAction,
    owned,
    standing,
    flags,
    totals: { awaitingAction: sum(awaitingAction), owned: sum(owned), standing: sum(standing) },
    generatedAt: new Date().toISOString(),
  };
}
