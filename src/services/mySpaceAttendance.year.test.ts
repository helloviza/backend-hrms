// /profile/me Phase 2b — year-summary, attendance-trend and the previous-period
// comparison (mySpaceAttendance.service.ts). Real Mongo (mongodb-memory-server).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const { default: Attendance } = await import("../models/Attendance.js");
const { default: LeaveRequest } = await import("../models/LeaveRequest.js");
const { default: Payslip } = await import("../models/Payslip.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: Holiday } = await import("../models/Holiday.js");
const {
  computeYearSummary,
  computeAttendanceTrend,
  computeMonthSummary,
  computePreviousHours,
  previousPeriodNow,
  YearSummaryInputError,
} = await import("./mySpaceAttendance.service.js");

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const WS = new mongoose.Types.ObjectId();
const OTHER_WS = new mongoose.Types.ObjectId();
const ME = new mongoose.Types.ObjectId();
// Fri 2026-11-27 14:30 IST.
const NOW = Date.parse("2026-11-27T09:00:00Z");
const me = { userId: String(ME), workspaceObjectId: WS, now: NOW };
const CFG = { shiftStart: "09:30", shiftEnd: "18:30", graceMinutes: 15, halfDayHours: 4.5, minHoursForPresent: 2, workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"] };

/** One IN→OUT on an IST day, times as HH:MM IST. */
const work = (date: string, inAt: string, outAt: string, ws: any = WS) =>
  Attendance.collection.insertOne({
    workspaceId: ws,
    userId: ME,
    date,
    punches: [
      { ts: new Date(`${date}T${inAt}:00+05:30`), type: "IN" },
      { ts: new Date(`${date}T${outAt}:00+05:30`), type: "OUT" },
    ],
  } as any);

beforeEach(async () => {
  await Promise.all([
    Attendance.deleteMany({}),
    LeaveRequest.deleteMany({}),
    Payslip.collection.deleteMany({}),
    Holiday.deleteMany({}),
    CustomerWorkspace.collection.deleteMany({}),
  ]);
  await CustomerWorkspace.collection.insertMany([
    { _id: WS, customerId: new mongoose.Types.ObjectId(), attendanceConfig: CFG },
    { _id: OTHER_WS, customerId: new mongoose.Types.ObjectId(), attendanceConfig: CFG },
  ] as any);
});

describe("previous period", () => {
  it("is the same elapsed part of the previous day / week / month (IST)", () => {
    expect(previousPeriodNow("today", NOW)).toBe(NOW - 86400000);
    expect(previousPeriodNow("week", NOW)).toBe(NOW - 7 * 86400000);
    expect(new Date(previousPeriodNow("month", NOW)).toISOString()).toBe("2026-10-27T09:00:00.000Z");
    // 31 Mar 10:00 IST → 28 Feb 10:00 IST (clamped to the shorter month)
    expect(new Date(previousPeriodNow("month", Date.parse("2026-03-31T04:30:00Z"))).toISOString()).toBe("2026-02-28T04:30:00.000Z");
  });

  it("week: last week's minutes only up to this weekday and time", async () => {
    await work("2026-11-23", "09:00", "13:00"); // this week (Mon) — not "previous"
    await work("2026-11-16", "09:00", "11:00"); // last Mon: 120
    // last Fri: 09:00–12:00 counts (180); 15:00–16:00 is after 14:30, i.e. later than "now" a week ago
    await Attendance.collection.insertOne({
      workspaceId: WS, userId: ME, date: "2026-11-20",
      punches: [["09:00", "IN"], ["12:00", "OUT"], ["15:00", "IN"], ["16:00", "OUT"]].map(([t, type]) => ({ ts: new Date(`2026-11-20T${t}:00+05:30`), type })),
    } as any);
    await work("2026-11-17", "09:00", "10:00", OTHER_WS); // another workspace
    const prev = await computePreviousHours({ ...me, range: "week" });
    expect(prev).toMatchObject({ from: "2026-11-16", to: "2026-11-20", workedMinutes: 300 });
  });
});

describe("attendance-hours workingDaysSoFar", () => {
  it("counts Mon–Fri up to today minus GENERAL holidays, own workspace (payroll's rule)", async () => {
    const { computeAttendanceHours } = await import("./mySpaceAttendance.service.js");
    expect((await computeAttendanceHours({ ...me, range: "today" })).workingDaysSoFar).toBe(1);
    expect((await computeAttendanceHours({ ...me, range: "week" })).workingDaysSoFar).toBe(5); // Mon 23 … Fri 27
    await Holiday.collection.insertMany([
      { workspaceId: WS, date: "2026-11-25", name: "Holiday", type: "GENERAL" },
      { workspaceId: OTHER_WS, date: "2026-11-24", name: "Elsewhere", type: "GENERAL" },
    ] as any);
    expect((await computeAttendanceHours({ ...me, range: "week" })).workingDaysSoFar).toBe(4);
    // Nov 2–27: 20 weekdays, minus the 25th
    expect((await computeAttendanceHours({ ...me, range: "month" })).workingDaysSoFar).toBe(19);
  });
});

describe("year-summary", () => {
  it("adds up the month-summaries Jan → this month; leave by type; LOP from published payslips only", async () => {
    await work("2026-10-05", "09:20", "18:30"); // on time
    await work("2026-10-06", "10:10", "18:30"); // late (> 09:45)
    await work("2026-11-02", "09:10", "18:00"); // on time
    await LeaveRequest.collection.insertMany([
      { workspaceId: WS, userId: ME, type: "CASUAL", status: "APPROVED", from: new Date("2026-10-08T00:00:00+05:30"), to: new Date("2026-10-09T00:00:00+05:30"), days: 2 },
      { workspaceId: WS, userId: ME, type: "SL", status: "APPROVED", from: new Date("2026-11-04T00:00:00+05:30"), to: new Date("2026-11-04T00:00:00+05:30"), days: 1 },
      { workspaceId: WS, userId: ME, type: "SL", status: "PENDING", from: new Date("2026-11-05T00:00:00+05:30"), to: new Date("2026-11-05T00:00:00+05:30"), days: 1 },
      { workspaceId: OTHER_WS, userId: ME, type: "EL", status: "APPROVED", from: new Date("2026-11-06T00:00:00+05:30"), to: new Date("2026-11-06T00:00:00+05:30"), days: 1 },
    ] as any);
    await Payslip.collection.insertMany([
      { payrollRunId: new mongoose.Types.ObjectId(), workspaceId: WS, userId: ME, month: "2026-09", status: "PUBLISHED", attendance: { lopDays: 1.5 } },
      { payrollRunId: new mongoose.Types.ObjectId(), workspaceId: WS, userId: ME, month: "2026-10", status: "DRAFT", attendance: { lopDays: 4 } },
    ] as any);

    const y = await computeYearSummary(me);
    expect(y.year).toBe(2026);
    expect(y.months).toHaveLength(11);
    expect(y.months[10]).toBe("2026-11");
    expect({ onTime: y.onTime, late: y.late, workedDays: y.workedDays }).toEqual({ onTime: 2, late: 1, workedDays: 3 });
    expect(y.leaveTakenByType).toEqual({ CL: 2, SL: 1 });
    expect(y.lopDays).toBe(1.5);

    // absent is exactly the months' absents added up (no second implementation)
    let absent = 0;
    for (const m of y.months) absent += (await computeMonthSummary({ ...me, month: m })).absent;
    expect(y.absent).toBe(absent);
  });

  it("no published payslip → lopDays null; past year → 12 months; future year refused", async () => {
    expect((await computeYearSummary(me)).lopDays).toBeNull();
    expect((await computeYearSummary({ ...me, year: 2025 })).months).toHaveLength(12);
    await expect(computeYearSummary({ ...me, year: 2027 })).rejects.toBeInstanceOf(YearSummaryInputError);
  });
});

describe("attendance-trend", () => {
  it("present % per month, oldest first, current month to date", async () => {
    await work("2026-10-05", "09:20", "18:30");
    await work("2026-11-02", "09:10", "18:00");
    const t = await computeAttendanceTrend({ ...me, months: 6 });
    expect(t.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    const oct = t.months.find((m) => m.month === "2026-10")!;
    expect(oct.present).toBe(1);
    expect(oct.pct).toBe(Math.round((1 / oct.workingDays) * 1000) / 10);
    expect(t.months[0].pct).toBe(0); // June: working days, no attendance → 0 %, a real figure
  });
});
