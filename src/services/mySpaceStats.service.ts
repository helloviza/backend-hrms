// apps/backend/src/services/mySpaceStats.service.ts
//
// Data behind GET /api/stats/dashboard (My Space + ProfilePerformance).
//
// Attendance definition (audit M2, decided 2026-11-08: rolling 30 days):
//   - Window = the last 30 IST calendar days, ending today (IST).
//   - Working day = Mon–Fri, not a workspace holiday, not covered by an
//     APPROVED leave of the user, and — for today only — already punched in
//     (today without a punch yet is "today", not a missed day).
//   - Present = working day with at least one IN punch. Weekend / holiday /
//     leave punches are shown but never counted.
//   - pct = present / workingDays (no clamp needed: present ⊆ working days).
//   - prevPct = same definition over the 30 days before the window; null when
//     that window has no punch at all (no baseline to compare against).
//
// Scoping (decided 2026-11-08): the caller's OWN records (Attendance,
// LeaveRequest, Document) are matched by userId only — records missing
// workspaceId must not vanish and render as Absent/0. Workspace-wide data
// (Holiday) is matched by the resolved workspace only; with no resolved
// workspace, no holidays are read at all (never an unscoped query).
import mongoose from "mongoose";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import DocumentModel from "../models/Document.js";
import Holiday from "../models/Holiday.js";
import { todayIST, addDaysIST, istDateString } from "../utils/dateIST.js";

export type DayState = "present" | "absent" | "leave" | "holiday" | "weekend" | "today";

export type MatrixDay = {
  date: string; // YYYY-MM-DD (IST)
  state: DayState;
  halfDay?: boolean;
  holidayName?: string;
  punched?: boolean; // had an IN punch (shown in tooltip even on weekend/holiday/leave)
};

export type DashboardStats = {
  // legacy fields — names/types unchanged (ProfilePerformance reads them)
  attendancePercent: string;
  leavesTaken: string;
  pendingApprovals: string;
  docsUploaded: string;
  hasAttendanceHistory: boolean;
  attendance: { label: string; value: number }[];
  leaveMix: { type: string; value: number }[];
  // My Space v3
  attendance30: {
    present: number;
    workingDays: number;
    pct: number | null;
    prevPct: number | null;
    from: string;
    to: string;
  };
  days: MatrixDay[];
  nextHoliday: { date: string; name: string } | null;
  holidaysResolved: boolean;
  documents: { total: number; verified: number; pending: number; rejected: number };
};

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

function isWeekend(dateStr: string): boolean {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

function calcLeaveDays(l: any): number {
  if (typeof l.days === "number" && isFinite(l.days) && l.days > 0) return l.days;
  const from = l.from ? new Date(l.from) : null;
  const to = l.to ? new Date(l.to) : from;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  const diff = to.getTime() - from.getTime();
  if (diff < 0) return 0;
  const base = Math.floor(diff / 86400000) + 1;
  const half = String(l.dayLength || "").toUpperCase() === "HALF" || Boolean(l.halfDay);
  if (half) return base === 1 ? 0.5 : base - 0.5;
  return base;
}

/** IST calendar days covered by a leave (inclusive). */
function leaveDates(l: any, lo: string, hi: string): string[] {
  if (!l.from) return [];
  const start = istDateString(new Date(l.from));
  const end = istDateString(new Date(l.to || l.from));
  const out: string[] = [];
  let d = start < lo ? lo : start;
  const stop = end > hi ? hi : end;
  let guard = 0;
  while (d <= stop && guard++ < 400) {
    out.push(d);
    d = addDaysIST(d, 1);
  }
  return out;
}

type WindowResult = { present: number; workingDays: number; days: MatrixDay[] };

export function computeWindow(args: {
  from: string;
  to: string;
  today: string;
  punchedDates: Set<string>;
  holidays: Map<string, string>;
  leaveDays: Map<string, { halfDay: boolean }>;
}): WindowResult {
  const { from, to, today, punchedDates, holidays, leaveDays } = args;
  let present = 0;
  let workingDays = 0;
  const days: MatrixDay[] = [];
  for (let d = from; d <= to; d = addDaysIST(d, 1)) {
    const punched = punchedDates.has(d);
    const holidayName = holidays.get(d);
    const leave = leaveDays.get(d);
    let state: DayState;
    if (holidayName !== undefined) state = "holiday";
    else if (isWeekend(d)) state = "weekend";
    else if (leave) state = "leave";
    else if (punched) state = "present";
    else if (d === today) state = "today";
    else state = "absent";

    if (state === "present") {
      present++;
      workingDays++;
    } else if (state === "absent") {
      workingDays++;
    }
    const day: MatrixDay = { date: d, state };
    if (punched) day.punched = true;
    if (holidayName !== undefined) day.holidayName = holidayName;
    if (state === "leave" && leave?.halfDay) day.halfDay = true;
    days.push(day);
  }
  return { present, workingDays, days };
}

function pctOf(present: number, working: number): number | null {
  if (working <= 0) return null;
  return Math.round((present / working) * 1000) / 10; // one decimal
}

export async function computeDashboardStats(args: {
  userId: string;
  workspaceObjectId: mongoose.Types.ObjectId | null;
  now?: Date | number;
}): Promise<DashboardStats> {
  const { userId, workspaceObjectId } = args;
  const uid = new mongoose.Types.ObjectId(userId);
  const today = todayIST(args.now ?? Date.now());
  const from = addDaysIST(today, -29);
  const prevFrom = addDaysIST(today, -59);
  const prevTo = addDaysIST(today, -30);

  const [attDocs, leaveDocs, holidayDocs, nextHolidayDoc, docAgg, anyAttendance] = await Promise.all([
    Attendance.find({ userId: uid, date: { $gte: prevFrom, $lte: today } })
      .select("date punches")
      .lean(),
    LeaveRequest.find({ userId: uid }).lean(),
    workspaceObjectId
      ? Holiday.find({ workspaceId: workspaceObjectId, date: { $gte: prevFrom, $lte: today } })
          .select("date name")
          .lean()
      : Promise.resolve([] as any[]),
    workspaceObjectId
      ? Holiday.find({ workspaceId: workspaceObjectId, date: { $gte: today } })
          .sort({ date: 1 })
          .limit(5)
          .select("date name")
          .lean()
      : Promise.resolve([] as any[]),
    DocumentModel.aggregate([
      { $match: { userId: uid } },
      { $group: { _id: "$verificationStatus", n: { $sum: 1 } } },
    ]),
    Attendance.exists({ userId: uid }),
  ]);

  // Punches
  const punchedDates = new Set<string>();
  for (const doc of attDocs as any[]) {
    const punches: any[] = Array.isArray(doc.punches) ? doc.punches : [];
    if (punches.some((p) => p && String(p.type || "").toUpperCase() === "IN")) {
      punchedDates.add(String(doc.date));
    }
  }

  // Holidays (workspace-scoped only)
  const holidays = new Map<string, string>();
  for (const h of holidayDocs as any[]) {
    const d = String(h.date || "").slice(0, 10);
    if (DATE_RX.test(d)) holidays.set(d, String(h.name || "Holiday"));
  }
  const nextHoliday =
    (nextHolidayDoc as any[])
      .map((h) => ({ date: String(h.date || "").slice(0, 10), name: String(h.name || "Holiday") }))
      .find((h) => DATE_RX.test(h.date) && h.date >= today) || null;

  // Leaves: approved leave days in the 60-day span + legacy lifetime figures
  const leaveDays = new Map<string, { halfDay: boolean }>();
  let leavesTakenDays = 0;
  let pendingApprovals = 0;
  const leaveMixMap = new Map<string, number>();
  for (const l of leaveDocs as any[]) {
    const status = String(l.status || "").toUpperCase();
    if (status === "PENDING") pendingApprovals++;
    if (status !== "APPROVED") continue;
    const half = String(l.dayLength || "").toUpperCase() === "HALF" || Boolean(l.halfDay);
    for (const d of leaveDates(l, prevFrom, today)) leaveDays.set(d, { halfDay: half });
    const days = calcLeaveDays(l);
    if (!days) continue;
    leavesTakenDays += days;
    const type = String(l.type || l.leaveType || "OTHER").toUpperCase();
    leaveMixMap.set(type, (leaveMixMap.get(type) ?? 0) + days);
  }

  const cur = computeWindow({ from, to: today, today, punchedDates, holidays, leaveDays });
  const prev = computeWindow({ from: prevFrom, to: prevTo, today, punchedDates, holidays, leaveDays });
  const pct = pctOf(cur.present, cur.workingDays);
  // No punch at all in the previous window = no baseline (e.g. attendance
  // tracking started recently) → no delta, rather than a misleading "+94 pts".
  const prevHasRecords = prev.days.some((d) => d.punched);
  const prevPct = prevHasRecords ? pctOf(prev.present, prev.workingDays) : null;

  const documents = { total: 0, verified: 0, pending: 0, rejected: 0 };
  for (const row of docAgg as any[]) {
    const n = Number(row.n) || 0;
    documents.total += n;
    const s = String(row._id || "PENDING").toUpperCase();
    if (s === "VERIFIED") documents.verified += n;
    else if (s === "REJECTED") documents.rejected += n;
    else documents.pending += n;
  }

  return {
    attendancePercent: pct === null ? "—" : `${pct}%`,
    leavesTaken: String(leavesTakenDays),
    pendingApprovals: String(pendingApprovals),
    docsUploaded: String(documents.total),
    hasAttendanceHistory: !!anyAttendance,
    attendance: cur.days.map((d) => ({ label: d.date, value: d.state === "present" ? 1 : 0 })),
    leaveMix: Array.from(leaveMixMap.entries()).map(([type, value]) => ({ type, value })),
    attendance30: { present: cur.present, workingDays: cur.workingDays, pct, prevPct, from, to: today },
    days: cur.days,
    nextHoliday,
    holidaysResolved: !!workspaceObjectId,
    documents,
  };
}
