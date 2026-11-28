// apps/backend/src/services/mySpaceAdminOverview.service.ts
//
// GET /api/my-space/admin-overview — the Admin layout's KPI blocks in one
// response. Each block is independent:
//
//   - it runs ONLY when the caller passes that block's own server-side gate,
//     and the gate is the decision function EXTRACTED from the existing
//     endpoint's own middleware (rolesAllow, featureGateRefusal,
//     isBillingStaffRequest, decideModulePermission,
//     approvalsAdminReadDecision, …) — the middleware calls the same function,
//     so the two cannot drift. No gate here answers a response, logs, or
//     writes; the request-state a decision stamps (hydrated user, queue access,
//     permission scope) goes on a per-block shadow request;
//   - a failed gate OMITS the block's key — "not allowed" is never 0;
//   - a block whose query throws returns { error: true } and the rest of the
//     response still returns.
//
// Workspace: always the caller's resolved home workspace (resolveSelfWorkspace
// in routes/mySpace.ts). Nothing is read from query/body/params/headers.
// Blocks whose existing endpoint is deliberately cross-tenant for Plumtrips
// staff (pendingTravel, bookingsMonth, invoicesMonth) keep exactly that
// endpoint's scope and say which scope applied in `scope`.
//
// Time: "today" and "this month" are Asia/Kolkata (utils/dateIST.ts).
import mongoose from "mongoose";
import type { Request } from "express";
import Employee from "../models/Employee.js";
import User from "../models/User.js";
import LeaveRequest from "../models/LeaveRequest.js";
import Attendance from "../models/Attendance.js";
import Holiday from "../models/Holiday.js";
import Department from "../models/Department.js";
import Onboarding from "../models/Onboarding.js";
import Report from "../models/Report.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import TravelBooking from "../models/TravelBooking.js";
import Invoice from "../models/Invoice.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import { rolesAllow } from "../middleware/roles.js";
import { featureGateRefusal } from "../middleware/requireFeature.js";
import { isBillingStaffRequest, isExternalAccount } from "../middleware/requireBillingStaff.js";
import { applyPermissionContext, decideModulePermission } from "../middleware/requirePermission.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { isHrAdmin } from "../routes/masterData.departments.js";
// Static on purpose: these route modules are large, and a lazy import() inside
// the request path cost ~1.4 s (invoices) / ~0.8 s (approvals) on first use.
import { adminQueueFilter } from "../routes/approvals.js";
import { applyLeaderScopeIfNeeded, approvalsAdminReadDecision } from "../routes/approvals.security.js";
import { invoiceReadScope, invoiceTenantClause } from "../routes/invoices.js";
import { loadGrant } from "./expenseGrants.service.js";
import { seesAll } from "./expense.access.js";
import { resolveAccessScope } from "../routes/admin.unified.billing.js";
import { plumboxMounted, PLUMTRIPS_HOUSE_WORKSPACE_ID } from "./mySpaceFeatures.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import { addDaysIST, endOfTodayIST, istDateString, parseISTStart, startOfTodayIST, todayIST } from "../utils/dateIST.js";
import { minuteOfDay, resolveAttendanceRules } from "./attendanceMonth.service.js";
import { pairDay } from "./mySpaceAttendance.service.js";
import LeaveBalance from "../models/LeaveBalance.js";
import Task from "../models/Task.js";
import { teamSummaryForRequest } from "../routes/manualBookings.js";
import { roleOf } from "./manualBookingTeamSummary.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { env } from "../config/env.js";

/* ───────────────────────── shadow request ───────────────────────── */

/** A per-block request: reads fall through to the real request, writes stay local. */
export function shadowRequest(req: Request): any {
  const child: any = Object.create(req);
  child.user = { ...((req as any).user || {}) };
  return child;
}

/* ───────────────────────── shapes ───────────────────────── */

type Scope = "platform" | "tenant" | "workspace" | "own";
type Err = { error: true };

export type AdminOverview = {
  asOf: string;
  blocks: Partial<{
    headcount: { total: number; active: number } | Err;
    attendanceToday:
      | {
          date: string;
          isWorkingDay: boolean;
          headcount: number;
          present: number;
          late: number | null;
          onLeave: number;
          absent: number | null;
          /** up to MAX_ABSENTEES people counted in `absent` (empty when absent is null) */
          absentees: Person[];
        }
      | Err;
    departments: { name: string; headcount: number }[] | Err;
    pendingLeave: { count: number } | Err;
    pendingExpenses: { reports: number; advances?: number } | Err;
    pendingTravel: { count: number; scope: Scope } | Err;
    bookingsMonth: { count: number; spend: number; scope: Scope } | Err;
    /** raised / paid count invoices generated this IST month; outstanding is ₹ over EVERY open invoice, any month */
    invoicesMonth: { raisedThisMonth: number; paidThisMonth: number; outstandingAllOpen: number; scope: Scope } | Err;
    onboarding:
      | {
          invited: number;
          inProgress: number;
          submitted: number;
          approved: number;
          /** up to MAX_ONBOARDING_ITEMS newest per bucket */
          items: Record<OnboardingBucket, OnboardingItem[]>;
        }
      | Err;
    recentJoiners: (Person & { department: string; designation: string; dateOfJoining: string | null })[] | Err;
    clockInToday:
      | {
          /** everyone with an IN today (the list below is capped) */
          totalPunchedIn: number;
          /** late people first (latest-arrived first among them), then the rest by first IN */
          items: ClockInRow[];
        }
      | Err;
    employeeStatus: { total: number; active: number; onProbation: number; onLeaveToday: number; inactive: number } | Err;
    topBooker: (Person & { role: string; bookings: number }) | null | Err;
    todo: { id: string; title: string; status: string; priority: string; dueDate: string | null }[] | Err;
  }>;
};

type Person = { name: string; avatarUrl: string | null };
type OnboardingBucket = "invited" | "inProgress" | "submitted" | "approved";
type OnboardingItem = { name: string; email: string; status: OnboardingBucket };
type ClockInRow = Person & {
  designation: string;
  firstIn: string;
  lastOut: string | null;
  isLate: boolean | null;
  /** minutes after shift start + grace; null when not late or no shift */
  lateMinutes: number | null;
  /** worked (IN→OUT, open IN counted to now) today */
  workedMinutes: number;
};

/** Blocks whose source exists only for Plumtrips (HOUSE) staff — omitted for every other workspace. */
export const HOUSE_ONLY_BLOCKS = ["pendingTravel", "topBooker", "todo"] as const;

const MAX_JOINERS = 5;
const MAX_CLOCK_IN = 10;
const MAX_ABSENTEES = 4;
const MAX_ONBOARDING_ITEMS = 5;
const MAX_TODO = 5;

/** A short-lived signed URL for a User.avatarKey, or null (the UI then draws initials). */
async function avatarUrlOf(u: any): Promise<string | null> {
  const key = String(u?.avatarKey || "").trim();
  if (!key) return null;
  try {
    return await presignGetObject({ bucket: env.S3_BUCKET, key, expiresInSeconds: 900 });
  } catch {
    return null;
  }
}
const HHMM = /^\d{1,2}:\d{2}$/;
const ACTIVE_EMPLOYEE = { $or: [{ isActive: true }, { status: { $in: ["ACTIVE", "Active", "Working"] } }] };

function personName(u: any): string {
  const full = [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim();
  return full || u?.name || u?.email || "Unknown";
}

/* ───────────────────────── today's attendance (shared) ───────────────────────── */

async function loadToday(wsId: mongoose.Types.ObjectId, now: number) {
  const today = todayIST(now);
  const [wsDoc, staffRaw, holidayToday] = await Promise.all([
    CustomerWorkspace.findById(wsId).select("attendanceConfig").lean(),
    User.find({ workspaceId: wsId, ...activeUserFilter() })
      .select("_id firstName lastName name email roles role userType accountType customerMemberRole designation avatarKey")
      .lean(),
    Holiday.exists({ workspaceId: wsId, date: today, type: "GENERAL" }),
  ]);
  // Staff only: a customer / vendor account in this workspace is not on the roll.
  const staff = (staffRaw as any[]).filter((u) => !isExternalAccount(u));
  const ids = staff.map((u) => u._id);

  const [docs, leaves] = await Promise.all([
    Attendance.find({ workspaceId: wsId, userId: { $in: ids }, date: { $in: [addDaysIST(today, -1), today] } })
      .select("userId punches")
      .lean(),
    LeaveRequest.find({
      workspaceId: wsId,
      userId: { $in: ids },
      status: "APPROVED",
      from: { $lte: endOfTodayIST(now) },
      to: { $gte: startOfTodayIST(now) },
    })
      .select("userId")
      .lean(),
  ]);

  const firstIn = new Map<string, number>();
  const lastOut = new Map<string, number>();
  const punchesOf = new Map<string, { ts: number; type: "IN" | "OUT" }[]>();
  for (const d of docs as any[]) {
    const uid = String(d.userId);
    for (const p of d.punches || []) {
      const ts = new Date(p?.ts).getTime();
      if (!Number.isFinite(ts) || ts > now || istDateString(ts) !== today) continue;
      if (p.type === "IN" || p.type === "OUT") {
        if (!punchesOf.has(uid)) punchesOf.set(uid, []);
        punchesOf.get(uid)!.push({ ts, type: p.type });
      }
      if (p.type === "IN" && (!firstIn.has(uid) || ts < firstIn.get(uid)!)) firstIn.set(uid, ts);
      if (p.type === "OUT" && (!lastOut.has(uid) || ts > lastOut.get(uid)!)) lastOut.set(uid, ts);
    }
  }

  const cfg = (wsDoc as any)?.attendanceConfig;
  const hasShift = !!cfg && HHMM.test(String(cfg.shiftStart ?? ""));
  const rules = hasShift ? resolveAttendanceRules(cfg) : null;
  const lateBy = (ts: number): number | null =>
    rules ? minuteOfDay(ts, "IST") - (rules.ssH * 60 + rules.ssM + rules.graceMinutes) : null;
  const isLate = (ts: number): boolean | null => {
    const m = lateBy(ts);
    return m === null ? null : m > 0;
  };
  /** Same pairing as /my-space/attendance-hours (an open IN counts to now). */
  const workedMinutes = (uid: string): number => {
    const ps = punchesOf.get(uid);
    return ps ? Math.round(pairDay(ps, now).worked / 60000) : 0;
  };

  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow];
  const workDays: string[] = Array.isArray(cfg?.workingDays) && cfg.workingDays.length ? cfg.workingDays : ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const isWorkingDay = workDays.includes(dayName) && !holidayToday;

  const leaveIds = new Set((leaves as any[]).map((l) => String(l.userId)));
  return { today, staff, firstIn, lastOut, leaveIds, isLate, lateBy, workedMinutes, hasShift, isWorkingDay };
}

/* ───────────────────────── the blocks ───────────────────────── */

type Ctx = {
  req: Request;
  wsId: mongoose.Types.ObjectId;
  isHouse: boolean;
  isSaas: boolean;
  now: number;
  today: string;
  monthStart: Date;
  todayData: () => ReturnType<typeof loadToday>;
};

type Block = {
  key: keyof AdminOverview["blocks"];
  /** true = run; false = omit the key. Gets its own shadow request. */
  gate: (r: any, c: Ctx) => Promise<boolean>;
  run: (r: any, c: Ctx) => Promise<any>;
};

// Same gate as GET /api/dashboard/hr-admin (routes/dashboard.ts).
const hrAdmin = async (r: any) => rolesAllow(r, "ADMIN", "SUPERADMIN", "HR", "TENANT_ADMIN");
// requireFeature / requireAnyFeature verdict, as a boolean.
const featureOk = (r: any, ...keys: string[]) => featureGateRefusal(r, keys as any) === null;

const BLOCKS: Block[] = [
  {
    key: "headcount",
    gate: hrAdmin,
    // Same counts as /dashboard/hr-admin counts.totalEmployees / activeEmployees.
    run: async (_r, c) => {
      const [total, active] = await Promise.all([
        Employee.countDocuments({ workspaceId: c.wsId }),
        Employee.countDocuments({ workspaceId: c.wsId, ...ACTIVE_EMPLOYEE }),
      ]);
      return { total, active };
    },
  },
  {
    key: "attendanceToday",
    gate: hrAdmin,
    run: async (_r, c) => {
      const t = await c.todayData();
      let present = 0;
      let late = 0;
      let onLeave = 0;
      const absentPeople: any[] = [];
      for (const u of t.staff) {
        const uid = String(u._id);
        const fi = t.firstIn.get(uid);
        if (fi !== undefined) {
          present++;
          if (t.isLate(fi) === true) late++;
        } else if (t.leaveIds.has(uid)) {
          onLeave++;
        } else {
          absentPeople.push(u);
        }
      }
      const headcount = t.staff.length;
      const absentees = t.isWorkingDay
        ? await Promise.all(absentPeople.slice(0, MAX_ABSENTEES).map(async (u) => ({ name: personName(u), avatarUrl: await avatarUrlOf(u) })))
        : [];
      return {
        date: t.today,
        isWorkingDay: t.isWorkingDay,
        headcount,
        present,
        late: t.hasShift ? late : null,
        onLeave,
        // Not punched in and not on approved leave. Not a figure on a weekend/holiday.
        absent: t.isWorkingDay ? Math.max(0, headcount - present - onLeave) : null,
        absentees,
      };
    },
  },
  {
    key: "clockInToday",
    gate: hrAdmin,
    run: async (_r, c) => {
      const t = await c.todayData();
      const punched = t.staff.filter((u) => t.firstIn.has(String(u._id)));
      const rows = punched
        .map((u) => {
          const uid = String(u._id);
          const fi = t.firstIn.get(uid)!;
          const lo = t.lastOut.get(uid);
          const isLate = t.isLate(fi);
          const by = t.lateBy(fi);
          return {
            u,
            row: {
              name: personName(u),
              designation: String(u.designation || ""),
              firstIn: new Date(fi).toISOString(),
              lastOut: lo !== undefined && lo > fi ? new Date(lo).toISOString() : null,
              isLate,
              lateMinutes: isLate === true && by !== null ? by : null,
              workedMinutes: t.workedMinutes(uid),
            },
          };
        })
        .sort((a, b) => {
          const la = a.row.isLate === true ? 1 : 0;
          const lb = b.row.isLate === true ? 1 : 0;
          if (la !== lb) return lb - la; // late first
          return la ? b.row.firstIn.localeCompare(a.row.firstIn) : a.row.firstIn.localeCompare(b.row.firstIn);
        })
        .slice(0, MAX_CLOCK_IN);
      const items = await Promise.all(rows.map(async ({ u, row }) => ({ ...row, avatarUrl: await avatarUrlOf(u) })));
      return { totalPunchedIn: punched.length, items };
    },
  },
  {
    key: "departments",
    // Same predicate as GET /api/master-data/departments.
    gate: async (r) => isHrAdmin(r.user),
    // Same query as that route: active departments, headcount = active users by department name.
    run: async (_r, c) => {
      const [departments, headcounts] = await Promise.all([
        Department.find({ workspaceId: c.wsId, isActive: true }).sort({ name: 1 }).select("name").lean(),
        User.aggregate([
          { $match: { workspaceId: c.wsId, ...activeUserFilter() } },
          { $group: { _id: "$department", count: { $sum: 1 } } },
        ]),
      ]);
      const hc = new Map((headcounts as any[]).map((h) => [h._id, h.count]));
      return (departments as any[]).map((d) => ({ name: d.name, headcount: hc.get(d.name) || 0 }));
    },
  },
  {
    key: "pendingLeave",
    gate: hrAdmin,
    // Same as /dashboard/hr-admin counts.openLeaveRequests.
    run: async (_r, c) => ({ count: await LeaveRequest.countDocuments({ workspaceId: c.wsId, status: "PENDING" }) }),
  },
  {
    key: "pendingExpenses",
    // Mount gates of /api/reports (requireFeature expensesEnabled), then the
    // routes' own seesAll — a non-admin approver's personal queue already
    // appears in /api/my-approvals and is not an admin figure.
    gate: async (r) => {
      if (!featureOk(r, "expensesEnabled")) return false;
      // What attachExpenseGrant puts on req.user (it swallows lookup errors as
      // "no grant"; here an error fails the gate closed instead).
      const uid = r.user?.id || r.user?._id || r.user?.sub;
      r.user.expenseGrant = r.workspaceObjectId && uid ? await loadGrant(r.workspaceObjectId, uid) : null;
      return seesAll(r.user);
    },
    run: async (r, c) => {
      const out: { reports: number; advances?: number } = {
        reports: await Report.countDocuments({ workspaceId: c.wsId, status: "submitted" }),
      };
      // /api/expense-advances is mounted behind expensesEnabled AND advancesEnabled.
      if (featureOk(r, "expensesEnabled") && featureOk(r, "advancesEnabled")) {
        out.advances = await ExpenseAdvance.countDocuments({ workspaceId: c.wsId, status: "awaiting_approval" });
      }
      return out;
    },
  },
  {
    key: "pendingTravel",
    // GET /api/approvals/admin/pending: plumbox-only mount, the approvals
    // router's feature gate, then requireApprovalsAdminRead. HOUSE-only here.
    gate: async (r, c) => {
      if (!c.isHouse || !plumboxMounted()) return false;
      if (!featureOk(r, "approvalFlowEnabled", "approvalDirectEnabled")) return false;
      // The caller is already authenticated (routes/mySpace.ts requireAuth), so
      // only the decision part of requireApprovalsAdminRead runs.
      return (await approvalsAdminReadDecision(r)).ok;
    },
    run: async (r) => {
      const filter = applyLeaderScopeIfNeeded(r, adminQueueFilter("pending"));
      const count = await (ApprovalRequest as any).countDocuments(filter);
      const q = r.__adminQueue;
      return { count, scope: q?.view ? (q.scope === "all" ? "platform" : "own") : "tenant" };
    },
  },
  {
    key: "bookingsMonth",
    // GET /api/admin/unified/summary: plumbox-only mount, SaaS HRMS blocked
    // (SUPERADMIN exempt), resolveAccessScope. OWN scope (the caller's own
    // bookings) is not an admin figure → omitted.
    gate: async (r, c) => {
      if (!plumboxMounted()) return false;
      if (c.isSaas && !isSuperAdmin(r)) return false;
      return resolveAccessScope(r.user).accessLevel !== "OWN";
    },
    run: async (r, c) => {
      const { matchFilter, accessLevel } = resolveAccessScope(r.user);
      // The flags buildScopedMatch (admin.unified.billing.ts) adds to every
      // query, plus CONFIRMED only: a cancelled booking never counts.
      const match: any = {
        ...matchFilter,
        status: "CONFIRMED",
        bookedAt: { $gte: c.monthStart, $lte: endOfTodayIST(c.now) },
        isDemo: r.user?.isDemoUser === true && accessLevel !== "GLOBAL" ? true : { $ne: true },
        isTest: { $ne: true },
        isActive: { $ne: false },
      };
      const [agg] = await TravelBooking.aggregate([
        { $match: match },
        { $group: { _id: null, count: { $sum: 1 }, spend: { $sum: "$amount" } } },
      ]);
      return { count: agg?.count ?? 0, spend: agg?.spend ?? 0, scope: accessLevel === "GLOBAL" ? "platform" : "tenant" };
    },
  },
  {
    key: "invoicesMonth",
    // GET /api/admin/invoices/insight: plumbox-only mount, requireFeature
    // invoicesEnabled, requireBillingStaff, requirePermission invoices READ.
    gate: async (r) => {
      if (!plumboxMounted()) return false;
      if (!featureOk(r, "invoicesEnabled") || !isBillingStaffRequest(r)) return false;
      const d = await decideModulePermission(r, "invoices", "READ");
      if (!d.ok) return false;
      applyPermissionContext(r, d as any); // invoiceReadScope reads req.permissionScope (OWN gate)
      return true;
    },
    // Same arms as /insight, with the month starting on the IST calendar.
    run: async (r, c) => {
      const scoped = await invoiceReadScope(r);
      const [raised, paid, outstandingAgg] = await Promise.all([
        Invoice.countDocuments(scoped({ generatedAt: { $gte: c.monthStart }, status: { $ne: "CANCELLED" } })),
        Invoice.countDocuments(scoped({ generatedAt: { $gte: c.monthStart }, status: "PAID" })),
        Invoice.aggregate([
          { $match: scoped({ status: { $in: ["DRAFT", "SENT", "PAYMENT_DECLARED"] } }) },
          { $group: { _id: null, total: { $sum: "$grandTotal" } } },
        ]),
      ]);
      return {
        raisedThisMonth: raised,
        paidThisMonth: paid,
        outstandingAllOpen: outstandingAgg[0]?.total ?? 0,
        scope: invoiceTenantClause(r) ? "workspace" : "platform",
      };
    },
  },
  {
    key: "onboarding",
    gate: hrAdmin,
    // Read-only (GET /api/onboarding/pipeline WRITES status=expired; this
    // never does). Employee invites only; an unfinished invite past its
    // expiry counts as expired, i.e. in none of these buckets.
    run: async (_r, c) => {
      const docs = await Onboarding.find({ workspaceId: c.wsId, type: "employee" })
        .select("status expiresAt email inviteeName createdAt updatedAt")
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();
      const out = { invited: 0, inProgress: 0, submitted: 0, approved: 0 };
      const items: Record<OnboardingBucket, OnboardingItem[]> = { invited: [], inProgress: [], submitted: [], approved: [] };
      for (const d of docs as any[]) {
        const expired = d.expiresAt && new Date(d.expiresAt).getTime() < c.now;
        let bucket: OnboardingBucket | null = null;
        if (d.status === "sent" && !expired) bucket = "invited";
        else if (d.status === "started" && !expired) bucket = "inProgress";
        else if (d.status === "submitted" || d.status === "verified") bucket = "submitted";
        else if (d.status === "approved") bucket = "approved";
        if (!bucket) continue;
        out[bucket]++;
        if (items[bucket].length < MAX_ONBOARDING_ITEMS) {
          const email = String(d.email || "");
          items[bucket].push({ name: String(d.inviteeName || "").trim() || email.split("@")[0] || "Invitee", email, status: bucket });
        }
      }
      return { ...out, items };
    },
  },
  {
    key: "recentJoiners",
    gate: hrAdmin,
    run: async (_r, c) => {
      const rows = await Employee.find({
        workspaceId: c.wsId,
        ...ACTIVE_EMPLOYEE,
        joiningDate: { $ne: null, $lte: endOfTodayIST(c.now) },
      })
        .sort({ joiningDate: -1 })
        .limit(MAX_JOINERS)
        .select("fullName name department designation joiningDate ownerId")
        .lean();
      const owners = await User.find({ _id: { $in: (rows as any[]).map((e) => e.ownerId).filter(Boolean) } })
        .select("_id avatarKey")
        .lean();
      const avatarKeyOf = new Map((owners as any[]).map((u) => [String(u._id), u]));
      return Promise.all(
        (rows as any[]).map(async (e) => ({
          name: e.fullName || e.name || "Unknown",
          avatarUrl: await avatarUrlOf(avatarKeyOf.get(String(e.ownerId))),
          department: e.department || "",
          designation: e.designation || "",
          dateOfJoining: e.joiningDate ? istDateString(new Date(e.joiningDate)) : null,
        })),
      );
    },
  },
  {
    key: "employeeStatus",
    gate: hrAdmin,
    // Employee roll (same counts as headcount) + who is on probation / on leave
    // today among the active staff users. Probation = this year's LeaveBalance
    // says not confirmed, or a probationEndDate still in the future.
    run: async (_r, c) => {
      const t = await c.todayData();
      const year = Number(c.today.slice(0, 4));
      const [total, active, onProbation] = await Promise.all([
        Employee.countDocuments({ workspaceId: c.wsId }),
        Employee.countDocuments({ workspaceId: c.wsId, ...ACTIVE_EMPLOYEE }),
        LeaveBalance.countDocuments({
          workspaceId: c.wsId,
          userId: { $in: t.staff.map((u) => u._id) },
          year,
          $or: [{ isConfirmed: false }, { probationEndDate: { $gt: new Date(c.now) } }],
        }),
      ]);
      const onLeaveToday = t.staff.filter((u) => t.leaveIds.has(String(u._id)) && !t.firstIn.has(String(u._id))).length;
      return { total, active, onProbation, onLeaveToday, inactive: Math.max(0, total - active) };
    },
  },
  {
    key: "topBooker",
    // GET /api/admin/manual-bookings/summary: plumbox-only mount, requirePermission
    // manualBookings READ, HOUSE staff only — the same top-5, first row.
    gate: async (r, c) => {
      if (!c.isHouse || !plumboxMounted()) return false;
      const d = await decideModulePermission(r, "manualBookings", "READ");
      if (!d.ok) return false;
      applyPermissionContext(r, d as any);
      return true;
    },
    run: async (r) => {
      const { summary } = await teamSummaryForRequest(r);
      const top = (summary.top5 || []).find((x: any) => x.completed > 0);
      if (!top) return null; // nobody completed a booking this month → no row
      const u: any = mongoose.isValidObjectId(top.key) ? await User.findById(top.key).select("designation hrmsAccessRole roles avatarKey").lean() : null;
      return { name: top.name, avatarUrl: await avatarUrlOf(u), role: roleOf(u), bookings: top.completed };
    },
  },
  {
    key: "todo",
    // GET /api/admin/tasks: requireHouse, then requirePermission tasks READ.
    // The caller's own open tasks (the route's default assignedTo=me).
    gate: async (r, c) => c.isHouse && (await decideModulePermission(r, "tasks", "READ")).ok,
    run: async (r) => {
      const me = String(r.user?._id || r.user?.id || r.user?.sub || "");
      if (!mongoose.isValidObjectId(me)) return [];
      const rows = await Task.find({ isActive: { $ne: false }, assignedTo: new mongoose.Types.ObjectId(me), status: { $in: ["OPEN", "IN_PROGRESS"] } })
        .sort({ dueDate: 1, createdAt: -1 })
        .limit(MAX_TODO)
        .select("title status priority dueDate")
        .lean();
      return (rows as any[]).map((t) => ({
        id: String(t._id),
        title: String(t.title || ""),
        status: String(t.status || "OPEN"),
        priority: String(t.priority || "MEDIUM"),
        dueDate: t.dueDate ? istDateString(new Date(t.dueDate)) : null,
      }));
    },
  },
];

export async function computeAdminOverview(req: Request, opts: { now?: number } = {}): Promise<AdminOverview> {
  const now = opts.now ?? Date.now();
  const today = todayIST(now);
  const ws: any = (req as any).workspace;
  const wsId = new mongoose.Types.ObjectId(String((req as any).workspaceObjectId));
  let todayPromise: ReturnType<typeof loadToday> | null = null;
  const ctx: Ctx = {
    req,
    wsId,
    isHouse: String(wsId) === PLUMTRIPS_HOUSE_WORKSPACE_ID,
    isSaas: ws?.tenantType === "SAAS_HRMS",
    now,
    today,
    monthStart: parseISTStart(`${today.slice(0, 7)}-01`),
    todayData: () => (todayPromise ??= loadToday(wsId, now)),
  };

  const entries = await Promise.all(
    BLOCKS.map(async (b) => {
      if ((HOUSE_ONLY_BLOCKS as readonly string[]).includes(b.key) && !ctx.isHouse) return null;
      const r = shadowRequest(req);
      let allowed = false;
      try {
        allowed = await b.gate(r, ctx);
      } catch (err: any) {
        // Fail closed: a gate that cannot be evaluated does not admit.
        console.error(`[my-space/admin-overview] gate ${b.key} failed:`, err?.message || err);
        return null;
      }
      if (!allowed) return null;
      try {
        return [b.key, await b.run(r, ctx)] as const;
      } catch (err: any) {
        console.error(`[my-space/admin-overview] block ${b.key} failed:`, err?.message || err);
        return [b.key, { error: true }] as const;
      }
    }),
  );

  const blocks: AdminOverview["blocks"] = {};
  for (const e of entries) if (e) (blocks as any)[e[0]] = e[1];
  return { asOf: today, blocks };
}

/** Test hook: the block list, so a test can make one block's query throw. */
export const __blocks = BLOCKS;
