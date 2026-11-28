// apps/backend/src/services/mySpaceAttendance.service.ts
//
// The caller's OWN attendance/leave figures for My Space (/profile/me):
//   GET /api/my-space/attendance-hours   → computeAttendanceHours
//   GET /api/my-space/month-summary      → computeMonthSummary
//   GET /api/my-space/recent-decisions   → computeRecentDecisions
//
// Scoping: every query is { userId: <caller>, workspaceId: <the caller's
// resolved home workspace> }. The workspace always comes from
// resolveSelfWorkspace (routes/mySpace.ts) — never from query/body/params/
// headers, SUPERADMIN included. Attendance, LeaveRequest and Payslip all
// require workspaceId in their schemas, so the strict match drops nothing a
// normal write produced, and a user who belongs to two workspaces sees only
// the one they are signed in to.
//
// Time: every "today / week / month" boundary is an Asia/Kolkata calendar
// boundary (utils/dateIST.ts). `now` is injectable for tests.
import mongoose from "mongoose";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import Holiday from "../models/Holiday.js";
import Payslip from "../models/Payslip.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { addDaysIST, IST_OFFSET_MS, istDateString, parseISTStart, todayIST } from "../utils/dateIST.js";
import {
  buildWorkingDays,
  countLeaveDaysByUser,
  monthLeaveWindow,
  resolveAttendanceRules,
  summariseUserMonth,
} from "./attendanceMonth.service.js";

type Scope = { userId: string; workspaceObjectId: mongoose.Types.ObjectId | string; now?: number };

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const MIN = 60_000;
const HHMM = /^(\d{1,2}):(\d{2})$/;

/* ───────────────────────── attendance-hours ───────────────────────── */

export type HoursRange = "today" | "week" | "month";
export const HOURS_RANGES: HoursRange[] = ["today", "week", "month"];

export type Segment = { start: string; end: string; kind: "worked" | "away"; open?: true };

export type DayHours = {
  date: string;
  workedMinutes: number;
  awayMinutes: number;
  overtimeMinutes: number | null;
};

export type AttendanceHours = {
  range: HoursRange;
  from: string;
  to: string;
  workedMinutes: number;
  awayMinutes: number;
  firstIn: string | null;
  lastOut: string | null;
  isPunchedIn: boolean;
  /** today's open IN was counted up to `now` (it has no OUT yet) */
  openPunchCountedToNow: boolean;
  /** IN punches with no OUT on a past day, plus OUT punches with no IN before them — never counted */
  unpairedPunches: number;
  shiftMinutes: number | null;
  overtimeMinutes: number | null;
  /** working days from `from` to today (inclusive) — payroll's rule (buildWorkingDays: Mon–Fri minus GENERAL holidays), as month-summary */
  workingDaysSoFar: number;
  segments?: Segment[];
  days?: DayHours[];
};

/**
 * Shift length from CustomerWorkspace.attendanceConfig, or null when the
 * workspace has no usable config. Never a default: overtime against an
 * invented shift would be an invented number.
 */
export function shiftMinutesOf(attendanceConfig: any): number | null {
  const s = HHMM.exec(String(attendanceConfig?.shiftStart ?? ""));
  const e = HHMM.exec(String(attendanceConfig?.shiftEnd ?? ""));
  if (!s || !e) return null;
  const start = Number(s[1]) * 60 + Number(s[2]);
  const end = Number(e[1]) * 60 + Number(e[2]);
  if (start >= 1440 || end >= 1440) return null;
  const len = (end - start + 1440) % 1440; // an overnight shift wraps
  return len > 0 ? len : null;
}

/** Monday (IST) of the ISO week containing `day`. */
function mondayOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // calendar weekday of the date string
  return addDaysIST(day, -((dow + 6) % 7));
}

export function rangeBounds(range: HoursRange, now: number): { from: string; to: string } {
  const to = todayIST(now);
  if (range === "today") return { from: to, to };
  if (range === "week") return { from: mondayOf(to), to };
  return { from: `${to.slice(0, 7)}-01`, to };
}

type Punch = { ts: number; type: "IN" | "OUT" };

/**
 * Pair one IST day's punches. IN→OUT is worked; OUT→next IN is away. A second
 * IN while one is open is ignored (the first IN stands); an OUT with no open
 * IN is ignored and counted as unpaired. A trailing open IN is counted up to
 * `openUntil` when given (today), otherwise left uncounted and unpaired.
 */
export function pairDay(punches: Punch[], openUntil: number | null) {
  const sorted = [...punches].sort((a, b) => a.ts - b.ts);
  let worked = 0;
  let away = 0;
  let unpaired = 0;
  let openIn: number | null = null;
  let lastOut: number | null = null;
  let firstIn: number | null = null;
  let openCounted = false;
  const segments: Segment[] = [];
  for (const p of sorted) {
    if (p.type === "IN") {
      if (openIn !== null) continue;
      if (firstIn === null) firstIn = p.ts;
      if (lastOut !== null && p.ts > lastOut) {
        away += p.ts - lastOut;
        segments.push({ start: new Date(lastOut).toISOString(), end: new Date(p.ts).toISOString(), kind: "away" });
      }
      openIn = p.ts;
    } else {
      if (openIn === null) {
        unpaired++;
        continue;
      }
      worked += p.ts - openIn;
      segments.push({ start: new Date(openIn).toISOString(), end: new Date(p.ts).toISOString(), kind: "worked" });
      openIn = null;
      lastOut = p.ts;
    }
  }
  const isOpen = openIn !== null;
  if (openIn !== null) {
    if (openUntil !== null && openUntil > openIn) {
      worked += openUntil - openIn;
      segments.push({ start: new Date(openIn).toISOString(), end: new Date(openUntil).toISOString(), kind: "worked", open: true });
      openCounted = true;
    } else if (openUntil === null) {
      unpaired++;
    }
  }
  return { worked, away, unpaired, firstIn, lastOut, isOpen, openCounted, segments };
}

export async function computeAttendanceHours(
  scope: Scope & { range: HoursRange },
): Promise<AttendanceHours> {
  const now = scope.now ?? Date.now();
  const { range } = scope;
  const { from, to } = rangeBounds(range, now);
  const today = todayIST(now);

  // Punches are bucketed by the IST day of their own timestamp, not by the
  // document's `date` label, so a row dated on another calendar can't move a
  // punch across midnight. The document window is widened a day each side to
  // catch any such row.
  const [docs, ws, holidays] = await Promise.all([
    Attendance.find({
      userId: oid(scope.userId),
      workspaceId: oid(scope.workspaceObjectId),
      date: { $gte: addDaysIST(from, -1), $lte: addDaysIST(to, 1) },
    })
      .select("punches")
      .lean(),
    CustomerWorkspace.findById(oid(scope.workspaceObjectId)).select("attendanceConfig").lean(),
    Holiday.find({ workspaceId: oid(scope.workspaceObjectId), date: { $gte: from, $lte: to }, type: "GENERAL" }).select("date").lean(),
  ]);
  const shiftMinutes = shiftMinutesOf((ws as any)?.attendanceConfig);
  const holidaySet = new Set((holidays as any[]).map((h) => h.date));
  const months = [...new Set([from.slice(0, 7), to.slice(0, 7)])];
  const workingDaysSoFar = months
    .flatMap((m) => buildWorkingDays(m, holidaySet))
    .filter((d) => d >= from && d <= to && d <= today).length;

  const byDay = new Map<string, Punch[]>();
  for (const d of docs as any[]) {
    for (const p of d.punches || []) {
      const ts = new Date(p?.ts).getTime();
      if (!Number.isFinite(ts) || (p.type !== "IN" && p.type !== "OUT")) continue;
      if (ts > now) continue; // a future-stamped punch is not work done
      const day = istDateString(ts);
      if (day < from || day > to) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push({ ts, type: p.type });
    }
  }

  let workedMs = 0;
  let awayMs = 0;
  let unpaired = 0;
  let firstIn: number | null = null;
  let lastOut: number | null = null;
  let overtime: number | null = shiftMinutes === null ? null : 0;
  let isPunchedIn = false;
  let openCounted = false;
  let todaySegments: Segment[] = [];
  const days: DayHours[] = [];

  for (const day of [...byDay.keys()].sort()) {
    const r = pairDay(byDay.get(day)!, day === today ? now : null);
    workedMs += r.worked;
    awayMs += r.away;
    unpaired += r.unpaired;
    if (r.firstIn !== null && (firstIn === null || r.firstIn < firstIn)) firstIn = r.firstIn;
    if (r.lastOut !== null && (lastOut === null || r.lastOut > lastOut)) lastOut = r.lastOut;
    const dayWorked = Math.round(r.worked / MIN);
    const dayOver = shiftMinutes === null ? null : Math.max(0, dayWorked - shiftMinutes);
    if (overtime !== null && dayOver !== null) overtime += dayOver;
    days.push({ date: day, workedMinutes: dayWorked, awayMinutes: Math.round(r.away / MIN), overtimeMinutes: dayOver });
    if (day === today) {
      isPunchedIn = r.isOpen;
      openCounted = r.openCounted;
      todaySegments = r.segments;
    }
  }

  const out: AttendanceHours = {
    range,
    from,
    to,
    workedMinutes: Math.round(workedMs / MIN),
    awayMinutes: Math.round(awayMs / MIN),
    firstIn: firstIn === null ? null : new Date(firstIn).toISOString(),
    lastOut: lastOut === null ? null : new Date(lastOut).toISOString(),
    isPunchedIn,
    openPunchCountedToNow: openCounted,
    unpairedPunches: unpaired,
    shiftMinutes,
    overtimeMinutes: overtime,
    workingDaysSoFar,
  };
  if (range === "today") out.segments = todaySegments;
  else out.days = days;
  return out;
}

/* ───────────────────────── month-summary ───────────────────────── */

export type MonthSummary = {
  month: string;
  /** last IST day counted: today for the current month, else the month's last day */
  asOf: string;
  workingDays: number;
  present: number;
  absent: number;
  halfDay: number;
  late: number;
  leaveDays: number;
  /** from the PUBLISHED payslip for this month; null when there is none — never estimated */
  lopDays: number | null;
  /** "workspace" = the workspace's attendanceConfig; "defaults" = payroll's built-in 09:30–18:30, 15 min grace */
  rulesSource: "workspace" | "defaults";
};

export class MonthSummaryInputError extends Error {}

export async function computeMonthSummary(scope: Scope & { month?: string }): Promise<MonthSummary> {
  const now = scope.now ?? Date.now();
  const today = todayIST(now);
  const thisMonth = today.slice(0, 7);
  const month = scope.month ?? thisMonth;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new MonthSummaryInputError("month must be YYYY-MM");
  if (month > thisMonth) throw new MonthSummaryInputError("month is in the future");

  const userId = oid(scope.userId);
  const workspaceId = oid(scope.workspaceObjectId);
  const [y, m] = month.split("-").map(Number);
  const lastDay = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;

  const [ws, holidays, docs] = await Promise.all([
    CustomerWorkspace.findById(workspaceId).select("attendanceConfig").lean(),
    // Same holiday rule as payroll-summary: GENERAL holidays of the workspace.
    Holiday.find({ workspaceId, date: { $gte: `${month}-01`, $lte: lastDay }, type: "GENERAL" }).select("date").lean(),
    Attendance.find({ workspaceId, userId, date: { $gte: `${month}-01`, $lte: lastDay } }).lean(),
  ]);

  const attMap = new Map<string, any>((docs as any[]).map((d) => [d.date, d]));
  let workingDays = buildWorkingDays(month, new Set((holidays as any[]).map((h) => h.date)));
  let asOf = lastDay;
  if (month === thisMonth) {
    // A day that hasn't happened yet is not an absence; today counts only once
    // the user has punched in (same convention as /stats/dashboard).
    const punchedToday = (attMap.get(today)?.punches || []).some((p: any) => p?.type === "IN");
    workingDays = workingDays.filter((d) => d < today || (d === today && punchedToday));
    asOf = today;
  }

  const { fromDate, toDate } = monthLeaveWindow(month, "IST");
  const leaves = await LeaveRequest.find({
    workspaceId,
    userId,
    status: "APPROVED",
    from: { $lte: toDate },
    to: { $gte: fromDate },
  }).lean();
  const leaveDays = countLeaveDaysByUser(leaves as any[], month, workingDays, "IST")[String(userId)] || 0;

  const cfg = (ws as any)?.attendanceConfig;
  const s = summariseUserMonth({
    workingDays,
    attendanceByDate: (d) => attMap.get(d),
    leaveDays,
    rules: resolveAttendanceRules(cfg),
    tz: "IST",
  });

  const payslip: any = await Payslip.findOne({ workspaceId, userId, month, status: "PUBLISHED" })
    .select("attendance.lopDays")
    .lean();
  const lop = payslip?.attendance?.lopDays;

  return {
    month,
    asOf,
    workingDays: s.workingDays,
    present: s.present,
    absent: s.absent,
    halfDay: s.halfDay,
    late: s.late,
    leaveDays: s.leaveDays,
    lopDays: typeof lop === "number" && Number.isFinite(lop) ? lop : null,
    rulesSource: cfg && (cfg.shiftStart || cfg.shiftEnd) ? "workspace" : "defaults",
  };
}

/* ───────────────────────── recent-decisions ───────────────────────── */

export type Decision = {
  kind: "leave" | "regularisation";
  status: "APPROVED" | "REJECTED";
  decidedAt: string;
  fromDate: string;
  toDate: string;
  leaveType?: string;
};

const DECIDED = ["APPROVED", "REJECTED"];
export const MAX_DECISIONS = 5;

export async function computeRecentDecisions(scope: Scope & { days?: number }): Promise<{ days: number; since: string; items: Decision[] }> {
  const now = scope.now ?? Date.now();
  const days = Math.min(90, Math.max(1, Math.floor(Number(scope.days) || 7)));
  // "Last N days" = the last N IST calendar days, today included.
  const sinceDay = addDaysIST(todayIST(now), -(days - 1));
  const since = parseISTStart(sinceDay);
  const userId = oid(scope.userId);
  const workspaceId = oid(scope.workspaceObjectId);

  const [leaves, atts] = await Promise.all([
    LeaveRequest.find({
      workspaceId,
      userId,
      status: { $in: DECIDED },
      $or: [{ updatedAt: { $gte: since } }, { "history.at": { $gte: since } }],
    })
      .select("status type from to history updatedAt")
      .lean(),
    Attendance.find({ workspaceId, userId, "odRequests.reviewedAt": { $gte: since } })
      .select("date odRequests")
      .lean(),
  ]);

  const items: Decision[] = [];
  for (const l of leaves as any[]) {
    // The decision's own timestamp: the last APPROVED/REJECTED history entry
    // matching the current status; updatedAt only when history is missing.
    const h = (l.history || []).filter((e: any) => e?.action === l.status && e?.at).pop();
    const at = h ? new Date(h.at) : l.updatedAt ? new Date(l.updatedAt) : null;
    if (!at || at < since || at.getTime() > now) continue;
    items.push({
      kind: "leave",
      status: l.status,
      decidedAt: at.toISOString(),
      fromDate: istDateString(new Date(l.from)),
      toDate: istDateString(new Date(l.to)),
      leaveType: l.type,
    });
  }
  for (const a of atts as any[]) {
    for (const od of a.odRequests || []) {
      if (!DECIDED.includes(od?.status) || !od.reviewedAt) continue;
      const at = new Date(od.reviewedAt);
      if (at < since || at.getTime() > now) continue;
      items.push({ kind: "regularisation", status: od.status, decidedAt: at.toISOString(), fromDate: a.date, toDate: a.date });
    }
  }
  items.sort((x, y) => y.decidedAt.localeCompare(x.decidedAt));
  return { days, since: sinceDay, items: items.slice(0, MAX_DECISIONS) };
}


/* ───────────────────────── year-summary ───────────────────────── */

export type YearSummary = {
  year: number;
  /** months counted: January … the current month (this year) or December (past years) */
  months: string[];
  onTime: number;
  late: number;
  absent: number;
  /** present days, half days counted as present (same as month-summary's `present`) */
  workedDays: number;
  leaveDays: number;
  /** APPROVED leave days by LeaveRequest.type, the request's own `days` (legacy CASUAL/SICK folded into CL/SL) */
  leaveTakenByType: Record<string, number>;
  /** Σ lopDays over PUBLISHED payslips of the year; null when there is none */
  lopDays: number | null;
};

export class YearSummaryInputError extends Error {}

const LEGACY_LEAVE: Record<string, string> = { CASUAL: "CL", SICK: "SL" };

/** Twelve (or fewer) month-summaries added up — the same rules, no second implementation. */
export async function computeYearSummary(scope: Scope & { year?: number }): Promise<YearSummary> {
  const now = scope.now ?? Date.now();
  const today = todayIST(now);
  const thisYear = Number(today.slice(0, 4));
  const year = scope.year ?? thisYear;
  if (!Number.isInteger(year) || year < 2000 || year > thisYear) throw new YearSummaryInputError("year must be YYYY, not in the future");
  const lastMonth = year === thisYear ? Number(today.slice(5, 7)) : 12;
  const months = Array.from({ length: lastMonth }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

  const sums = await Promise.all(months.map((month) => computeMonthSummary({ ...scope, now, month })));
  const out: YearSummary = {
    year,
    months,
    onTime: 0,
    late: 0,
    absent: 0,
    workedDays: 0,
    leaveDays: 0,
    leaveTakenByType: {},
    lopDays: null,
  };
  for (const s of sums) {
    out.late += s.late;
    out.onTime += Math.max(0, s.present - s.late);
    out.absent += s.absent;
    out.workedDays += s.present;
    out.leaveDays += s.leaveDays;
    if (s.lopDays !== null) out.lopDays = (out.lopDays ?? 0) + s.lopDays;
  }

  const leaves = await LeaveRequest.find({
    workspaceId: oid(scope.workspaceObjectId),
    userId: oid(scope.userId),
    status: "APPROVED",
    from: { $gte: parseISTStart(`${year}-01-01`), $lte: parseISTStart(`${year + 1}-01-01`) },
  })
    .select("type days")
    .lean();
  for (const l of leaves as any[]) {
    const t = LEGACY_LEAVE[String(l.type)] || String(l.type || "OTHER");
    const d = Number(l.days);
    if (Number.isFinite(d) && d > 0) out.leaveTakenByType[t] = (out.leaveTakenByType[t] ?? 0) + d;
  }
  return out;
}

/* ───────────────────────── attendance-trend ───────────────────────── */

export type TrendMonth = { month: string; workingDays: number; present: number; pct: number | null };

/** Present % per month for the last `months` months (current month to date), oldest first. */
export async function computeAttendanceTrend(scope: Scope & { months?: number }): Promise<{ months: TrendMonth[] }> {
  const now = scope.now ?? Date.now();
  const n = Math.min(12, Math.max(1, Math.floor(scope.months ?? 6)));
  const today = todayIST(now);
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    keys.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const sums = await Promise.all(keys.map((month) => computeMonthSummary({ ...scope, now, month })));
  return {
    months: sums.map((s) => ({
      month: s.month,
      workingDays: s.workingDays,
      present: s.present,
      // No working day yet (e.g. the 1st before punching in) → no figure, not 0 %.
      pct: s.workingDays > 0 ? Math.round((s.present / s.workingDays) * 1000) / 10 : null,
    })),
  };
}

/* ───────────────────────── previous-period comparison ───────────────────────── */

/**
 * The same range one period earlier, over the SAME elapsed part of it:
 * today → yesterday up to this time; week → last week up to this weekday and
 * time; month → last month up to this day-of-month and time (clamped to the
 * month's end). Computed by re-running computeAttendanceHours at that instant.
 */
export function previousPeriodNow(range: HoursRange, now: number): number {
  if (range === "today") return now - 86400000;
  if (range === "week") return now - 7 * 86400000;
  const ist = new Date(now + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const mo = ist.getUTCMonth(); // 0-based, this month
  const prevLastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const day = Math.min(ist.getUTCDate(), prevLastDay);
  const shifted = Date.UTC(y, mo - 1, day, ist.getUTCHours(), ist.getUTCMinutes(), ist.getUTCSeconds());
  return shifted - IST_OFFSET_MS;
}

export async function computePreviousHours(scope: Scope & { range: HoursRange }) {
  const now = scope.now ?? Date.now();
  const prev = await computeAttendanceHours({ ...scope, now: previousPeriodNow(scope.range, now) });
  return { from: prev.from, to: prev.to, workedMinutes: prev.workedMinutes, overtimeMinutes: prev.overtimeMinutes };
}
