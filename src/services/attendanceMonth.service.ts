// apps/backend/src/services/attendanceMonth.service.ts
//
// The per-user monthly attendance calculation behind
//   GET /api/attendance/payroll-summary   (HR/ADMIN, whole workspace)
//   GET /api/my-space/month-summary       (self)
//
// Extracted verbatim from routes/attendance.ts (feat/profile-me-by-role, step
// 1.2) so both routes apply ONE set of rules. Pure: no DB, no clock — the
// routes fetch the documents and pass them in.
//
// Timezone is a parameter, not a fix. payroll-summary passes "server-local",
// which reproduces its existing behaviour byte-for-byte (pinned by
// routes/attendance.payrollSummary.characterisation.test.ts), including two
// known quirks that are ticketed separately and must NOT change here:
//   - the late check reads the punch's server-local hour (on a UTC server a
//     10:00 IST punch is not "late");
//   - leave days are walked on the server-local calendar.
// The My Space path passes "IST", which reads every instant on the
// Asia/Kolkata calendar/clock instead.
//
// Hours are lastOut − firstIn (breaks count as work) in BOTH modes: that is
// payroll's definition of a present/half day, and month-summary must agree
// with payroll. The break-aware worked-hours figure lives in
// services/mySpaceAttendance.service.ts (attendance-hours), not here.
import dayjs from "dayjs";
import { IST_OFFSET_MS, istDateString, parseISTEnd, parseISTStart } from "../utils/dateIST.js";

export type TzMode = "server-local" | "IST";

export type AttendanceRules = {
  ssH: number;
  ssM: number;
  graceMinutes: number;
  shiftHours: number;
  halfDayHours: number;
  minHoursForPresent: number;
};

/** payroll-summary's reading of CustomerWorkspace.attendanceConfig, defaults included. */
export function resolveAttendanceRules(attendanceConfig: any): AttendanceRules {
  const attCfg = attendanceConfig || {};
  const shiftStartStr: string = attCfg.shiftStart || "09:30";
  const shiftEndStr: string = attCfg.shiftEnd || "18:30";
  const [ssH, ssM] = shiftStartStr.split(":").map(Number);
  const [seH, seM] = shiftEndStr.split(":").map(Number);
  const shiftStart = ssH + ssM / 60;
  const graceMinutes = attCfg.graceMinutes ?? 15;
  const shiftHours = seH + seM / 60 - shiftStart;
  const halfDayHours = attCfg.halfDayHours ?? 4.5;
  const minHoursForPresent = attCfg.minHoursForPresent ?? 2;
  return { ssH, ssM, graceMinutes, shiftHours, halfDayHours, minHoursForPresent };
}

/** Mon–Fri of `month` ("YYYY-MM") minus the given holiday dates, as "YYYY-MM-DD". */
export function buildWorkingDays(month: string, holidayDates: Set<string>): string[] {
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr, 10);
  const mon = parseInt(monthStr, 10);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const workingDays: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, mon - 1, d);
    const dow = dt.getDay();
    const dateStr = dayjs(dt).format("YYYY-MM-DD");
    if (dow !== 0 && dow !== 6 && !holidayDates.has(dateStr)) {
      workingDays.push(dateStr);
    }
  }
  return workingDays;
}

/** The instant window a month's leave query and leave walk use. */
export function monthLeaveWindow(month: string, tz: TzMode): { fromDate: Date; toDate: Date } {
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr, 10);
  const mon = parseInt(monthStr, 10);
  if (tz === "IST") {
    const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    return {
      fromDate: parseISTStart(`${month}-01`),
      toDate: parseISTEnd(`${month}-${String(last).padStart(2, "0")}`),
    };
  }
  return { fromDate: new Date(`${month}-01`), toDate: new Date(year, mon, 0) };
}

/** Leave days per userId that fall on `workingDays`, from APPROVED leave requests. */
export function countLeaveDaysByUser(
  leaveRequests: any[],
  month: string,
  workingDays: string[],
  tz: TzMode,
): Record<string, number> {
  const { fromDate, toDate } = monthLeaveWindow(month, tz);
  const dayKey = (d: Date) => (tz === "IST" ? istDateString(d) : dayjs(d).format("YYYY-MM-DD"));
  const leaveDaysMap: Record<string, number> = {};
  for (const lr of leaveRequests) {
    const uid = String(lr.userId);
    const lFrom = new Date(Math.max(new Date(lr.from).getTime(), fromDate.getTime()));
    const lTo = new Date(Math.min(new Date(lr.to).getTime(), toDate.getTime()));
    let count = 0;
    let cur = new Date(lFrom);
    while (cur <= lTo) {
      const ds = dayKey(cur);
      if (workingDays.includes(ds)) {
        count += lr.dayLength === "HALF" ? 0.5 : 1;
      }
      if (tz === "IST") cur = new Date(cur.getTime() + 86400000);
      else cur.setDate(cur.getDate() + 1);
    }
    leaveDaysMap[uid] = (leaveDaysMap[uid] || 0) + count;
  }
  return leaveDaysMap;
}

/** Minute of the day of an instant, on the clock `tz` names. */
export function minuteOfDay(ts: Date | string | number, tz: TzMode): number {
  const d = new Date(ts);
  if (tz === "IST") {
    const shifted = new Date(d.getTime() + IST_OFFSET_MS);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  }
  return d.getHours() * 60 + d.getMinutes();
}

export type UserMonthSummary = {
  workingDays: number;
  present: number; // full days + 0.5 × half days (payroll's figure)
  absent: number;
  halfDay: number;
  late: number;
  overtime: number;
  leaveDays: number;
  lopDays: number;
  totalHours: number;
  avgDailyHours: number;
};

/**
 * One user's month. `attendanceByDate` maps "YYYY-MM-DD" → that day's
 * Attendance document (or anything with `punches`).
 */
export function summariseUserMonth(input: {
  workingDays: string[];
  attendanceByDate: (dateStr: string) => any;
  leaveDays: number;
  rules: AttendanceRules;
  tz: TzMode;
}): UserMonthSummary {
  const { workingDays, attendanceByDate, rules, tz } = input;
  const { ssH, ssM, graceMinutes, shiftHours, halfDayHours, minHoursForPresent } = rules;

  let present = 0;
  let halfDay = 0;
  let late = 0;
  let overtime = 0;
  let totalHours = 0;

  for (const dateStr of workingDays) {
    const att = attendanceByDate(dateStr);
    if (!att || !att.punches || !att.punches.length) continue;

    const punches = att.punches.sort(
      (a: any, b: any) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
    );

    // Compute hours: pair IN/OUT
    let dayHrs = 0;
    const ins = punches.filter((p: any) => p.type === "IN");
    const outs = punches.filter((p: any) => p.type === "OUT");
    if (ins.length && outs.length) {
      const firstIn = new Date(ins[0].ts).getTime();
      const lastOut = new Date(outs[outs.length - 1].ts).getTime();
      if (lastOut > firstIn) {
        dayHrs = (lastOut - firstIn) / (1000 * 60 * 60);
      }
    }

    totalHours += dayHrs;

    if (dayHrs >= minHoursForPresent && dayHrs < halfDayHours) {
      halfDay++;
    } else if (dayHrs >= halfDayHours) {
      present++;
    }

    // Late check
    if (ins.length) {
      const inMinutes = minuteOfDay(ins[0].ts, tz);
      const graceEnd = ssH * 60 + ssM + graceMinutes;
      if (inMinutes > graceEnd) late++;
    }

    // Overtime
    if (dayHrs > shiftHours + 1) overtime++;
  }

  const leaveDays = input.leaveDays || 0;
  const absent = Math.max(0, workingDays.length - present - halfDay - leaveDays);
  const lopDays = Math.max(0, absent);
  const avgDailyHours = present > 0 ? +(totalHours / present).toFixed(1) : 0;

  return {
    workingDays: workingDays.length,
    present: present + halfDay * 0.5,
    absent,
    halfDay,
    late,
    overtime,
    leaveDays,
    lopDays,
    totalHours: +totalHours.toFixed(1),
    avgDailyHours,
  };
}
