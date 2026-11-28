// /profile/me Phase 1 — self endpoints behind /api/my-space:
// attendance-hours, month-summary, recent-decisions. Against a real Mongo
// (mongodb-memory-server), no mocks: the point is the queries and scoping.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const { default: Attendance } = await import("../models/Attendance.js");
const { default: LeaveRequest } = await import("../models/LeaveRequest.js");
const { default: Holiday } = await import("../models/Holiday.js");
const { default: Payslip } = await import("../models/Payslip.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { computeAttendanceHours, computeMonthSummary, computeRecentDecisions, MonthSummaryInputError, shiftMinutesOf } =
  await import("./mySpaceAttendance.service.js");

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
const WS_NO_CFG = new mongoose.Types.ObjectId();
const OTHER_WS = new mongoose.Types.ObjectId();
const ME = new mongoose.Types.ObjectId();
const SOMEONE_ELSE = new mongoose.Types.ObjectId();

// Fri 2026-11-27 14:30 IST.
const NOW = Date.parse("2026-11-27T09:00:00Z");
const me = { userId: String(ME), workspaceObjectId: WS, now: NOW };

const CFG = { shiftStart: "09:30", shiftEnd: "18:30", graceMinutes: 15, halfDayHours: 4.5, minHoursForPresent: 2, workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"] };

type P = [string, "IN" | "OUT"];
const day = (date: string, punches: P[], userId = ME, ws: any = WS) =>
  Attendance.collection.insertOne({ workspaceId: ws, userId, date, punches: punches.map(([iso, type]) => ({ ts: new Date(iso), type })) } as any);

beforeEach(async () => {
  await Promise.all([
    Attendance.deleteMany({}),
    LeaveRequest.deleteMany({}),
    Holiday.deleteMany({}),
    Payslip.collection.deleteMany({}),
    CustomerWorkspace.collection.deleteMany({}),
  ]);
  await CustomerWorkspace.collection.insertMany([
    { _id: WS, customerId: new mongoose.Types.ObjectId(), attendanceConfig: CFG },
    { _id: WS_NO_CFG, customerId: new mongoose.Types.ObjectId() },
    { _id: OTHER_WS, customerId: new mongoose.Types.ObjectId(), attendanceConfig: CFG },
  ] as any);
});

describe("attendance-hours", () => {
  it("breaks are NOT counted as work; away = OUT→IN gaps; segments for today", async () => {
    // 09:00–13:00 IST, break 13:00–13:30, 13:30–14:00 IST
    await day("2026-11-27", [
      ["2026-11-27T03:30:00Z", "IN"],
      ["2026-11-27T07:30:00Z", "OUT"],
      ["2026-11-27T08:00:00Z", "IN"],
      ["2026-11-27T08:30:00Z", "OUT"],
    ]);
    const h = await computeAttendanceHours({ ...me, range: "today" });
    expect(h.workedMinutes).toBe(270); // lastOut − firstIn would say 300
    expect(h.awayMinutes).toBe(30);
    expect(h.isPunchedIn).toBe(false);
    expect(h.openPunchCountedToNow).toBe(false);
    expect(h.firstIn).toBe("2026-11-27T03:30:00.000Z");
    expect(h.lastOut).toBe("2026-11-27T08:30:00.000Z");
    expect(h.segments!.map((s) => s.kind)).toEqual(["worked", "away", "worked"]);
    expect(h.days).toBeUndefined();
  });

  it("an open IN today counts up to now, and is flagged", async () => {
    await day("2026-11-27", [["2026-11-27T03:30:00Z", "IN"]]);
    const h = await computeAttendanceHours({ ...me, range: "today" });
    expect(h.workedMinutes).toBe(330); // 03:30Z → 09:00Z (now)
    expect(h.isPunchedIn).toBe(true);
    expect(h.openPunchCountedToNow).toBe(true);
    expect(h.segments!.at(-1)).toMatchObject({ kind: "worked", open: true, end: "2026-11-27T09:00:00.000Z" });
    expect(h.unpairedPunches).toBe(0);
  });

  it("an unpaired IN on a PAST day is not counted (only flagged)", async () => {
    await day("2026-11-25", [["2026-11-25T03:30:00Z", "IN"]]);
    await day("2026-11-26", [["2026-11-26T03:30:00Z", "IN"], ["2026-11-26T05:30:00Z", "OUT"]]);
    const h = await computeAttendanceHours({ ...me, range: "week" });
    expect(h.workedMinutes).toBe(120);
    expect(h.unpairedPunches).toBe(1);
    expect(h.isPunchedIn).toBe(false);
    expect(h.days!.find((d) => d.date === "2026-11-25")!.workedMinutes).toBe(0);
  });

  it("IST boundary: 23:50 IST and 00:10 IST land on different days", async () => {
    // 26th 23:30–23:50 IST (18:00Z–18:20Z) and 27th 00:10–00:40 IST (18:40Z–19:10Z on the 26th, UTC).
    // Both rows are labelled with the UTC date to prove bucketing uses the IST day of the punch.
    await day("2026-11-26", [
      ["2026-11-26T18:00:00Z", "IN"],
      ["2026-11-26T18:20:00Z", "OUT"],
      ["2026-11-26T18:40:00Z", "IN"],
      ["2026-11-26T19:10:00Z", "OUT"],
    ]);
    const today = await computeAttendanceHours({ ...me, range: "today" });
    expect(today.workedMinutes).toBe(30);
    expect(today.awayMinutes).toBe(0); // the 20-min gap straddles midnight: no day owns it
    const week = await computeAttendanceHours({ ...me, range: "week" });
    expect(week.days).toEqual([
      { date: "2026-11-26", workedMinutes: 20, awayMinutes: 0, overtimeMinutes: 0 },
      { date: "2026-11-27", workedMinutes: 30, awayMinutes: 0, overtimeMinutes: 0 },
    ]);
  });

  it("overtime = max(0, day worked − shift) per day; no attendanceConfig → nulls, not 0", async () => {
    // 10h on Monday, 8h on Tuesday, against a 9h shift → 60 min overtime.
    await day("2026-11-23", [["2026-11-23T03:30:00Z", "IN"], ["2026-11-23T13:30:00Z", "OUT"]]);
    await day("2026-11-24", [["2026-11-24T03:30:00Z", "IN"], ["2026-11-24T11:30:00Z", "OUT"]]);
    const h = await computeAttendanceHours({ ...me, range: "week" });
    expect(h.shiftMinutes).toBe(540);
    expect(h.overtimeMinutes).toBe(60);
    expect(h.from).toBe("2026-11-23");
    expect(h.to).toBe("2026-11-27");

    // Attendance is unique on {userId, date} (no workspaceId), so clear before re-using the date.
    await Attendance.deleteMany({});
    await day("2026-11-23", [["2026-11-23T03:30:00Z", "IN"], ["2026-11-23T13:30:00Z", "OUT"]], ME, WS_NO_CFG);
    const none = await computeAttendanceHours({ ...me, workspaceObjectId: WS_NO_CFG, range: "week" });
    expect(none.workedMinutes).toBe(600);
    expect(none.shiftMinutes).toBeNull();
    expect(none.overtimeMinutes).toBeNull();
    expect(none.days![0].overtimeMinutes).toBeNull();
  });

  it("only the caller's own punches in the caller's own workspace", async () => {
    await day("2026-11-27", [["2026-11-27T03:30:00Z", "IN"], ["2026-11-27T04:30:00Z", "OUT"]]);
    // (Attendance is unique on {userId, date}, so the other-workspace row is on another day.)
    await day("2026-11-26", [["2026-11-26T03:30:00Z", "IN"], ["2026-11-26T08:30:00Z", "OUT"]], ME, OTHER_WS);
    await day("2026-11-27", [["2026-11-27T03:30:00Z", "IN"], ["2026-11-27T08:30:00Z", "OUT"]], SOMEONE_ELSE, WS);
    const h = await computeAttendanceHours({ ...me, range: "month" });
    expect(h.workedMinutes).toBe(60);
    expect(h.from).toBe("2026-11-01");
  });

  it("shiftMinutesOf handles overnight shifts and junk", () => {
    expect(shiftMinutesOf({ shiftStart: "22:00", shiftEnd: "06:00" })).toBe(480);
    expect(shiftMinutesOf({ shiftStart: "9", shiftEnd: "18:00" })).toBeNull();
    expect(shiftMinutesOf(undefined)).toBeNull();
  });
});

describe("month-summary", () => {
  it("lopDays is null when there is no published payslip (DRAFT does not count)", async () => {
    await Payslip.collection.insertOne({ payrollRunId: new mongoose.Types.ObjectId(), workspaceId: WS, userId: ME, month: "2026-10", status: "DRAFT", attendance: { lopDays: 3 } } as any);
    const s = await computeMonthSummary({ ...me, month: "2026-10" });
    expect(s.lopDays).toBeNull();
    await Payslip.collection.insertOne({ payrollRunId: new mongoose.Types.ObjectId(), workspaceId: WS, userId: ME, month: "2026-10", status: "PUBLISHED", attendance: { lopDays: 2 } } as any);
    expect((await computeMonthSummary({ ...me, month: "2026-10" })).lopDays).toBe(2);
    // another workspace's payslip never answers
    await Payslip.collection.insertOne({ payrollRunId: new mongoose.Types.ObjectId(), workspaceId: OTHER_WS, userId: ME, month: "2026-09", status: "PUBLISHED", attendance: { lopDays: 9 } } as any);
    expect((await computeMonthSummary({ ...me, month: "2026-09" })).lopDays).toBeNull();
  });

  it("current month stops at today: future days are not absences; today counts only once punched", async () => {
    const before = await computeMonthSummary(me);
    expect(before.month).toBe("2026-11");
    expect(before.asOf).toBe("2026-11-27");
    expect(before.workingDays).toBe(19); // weekdays 2–26 Nov
    expect(before.absent).toBe(19);
    await day("2026-11-27", [["2026-11-27T03:30:00Z", "IN"], ["2026-11-27T08:30:00Z", "OUT"]]);
    const after = await computeMonthSummary(me);
    expect(after.workingDays).toBe(20);
    expect(after.present).toBe(1);
    expect(after.absent).toBe(19);
  });

  it("payroll rules (present/halfDay/leave) with the late check on IST", async () => {
    // Mon 5 Oct: IN 10:00 IST (late vs 09:30+15) — a UTC server-local check would miss it.
    await day("2026-10-05", [["2026-10-05T04:30:00Z", "IN"], ["2026-10-05T13:00:00Z", "OUT"]]);
    // Tue 6 Oct: 3h → half day
    await day("2026-10-06", [["2026-10-06T04:00:00Z", "IN"], ["2026-10-06T07:00:00Z", "OUT"]]);
    await Holiday.collection.insertOne({ workspaceId: WS, date: "2026-10-02", name: "Gandhi Jayanti", type: "GENERAL" } as any);
    // 12–13 Oct leave stored at IST midnight (18:30Z the day before) — counted on the IST calendar
    await LeaveRequest.collection.insertOne({ workspaceId: WS, userId: ME, type: "CL", from: new Date("2026-10-11T18:30:00Z"), to: new Date("2026-10-12T18:30:00Z"), status: "APPROVED", dayLength: "FULL" } as any);
    // other workspace leave/attendance never count
    await LeaveRequest.collection.insertOne({ workspaceId: OTHER_WS, userId: ME, type: "CL", from: new Date("2026-10-19T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z"), status: "APPROVED", dayLength: "FULL" } as any);
    await day("2026-10-07", [["2026-10-07T04:00:00Z", "IN"], ["2026-10-07T13:00:00Z", "OUT"]], ME, OTHER_WS);

    const s = await computeMonthSummary({ ...me, month: "2026-10" });
    expect(s).toMatchObject({
      month: "2026-10",
      asOf: "2026-10-31",
      workingDays: 21, // 22 weekdays − 2 Oct holiday
      present: 1.5,
      halfDay: 1,
      late: 1,
      leaveDays: 2,
      absent: 17, // 21 − 1 present − 1 half − 2 leave
      lopDays: null,
      rulesSource: "workspace",
    });
  });

  it("no attendanceConfig → payroll's defaults, and says so", async () => {
    const s = await computeMonthSummary({ ...me, workspaceObjectId: WS_NO_CFG, month: "2026-10" });
    expect(s.rulesSource).toBe("defaults");
  });

  it("rejects a malformed or future month", async () => {
    await expect(computeMonthSummary({ ...me, month: "2026-13" })).rejects.toBeInstanceOf(MonthSummaryInputError);
    await expect(computeMonthSummary({ ...me, month: "2026-12" })).rejects.toBeInstanceOf(MonthSummaryInputError);
  });
});

describe("recent-decisions", () => {
  const leave = (o: any) =>
    LeaveRequest.collection.insertOne({
      workspaceId: WS,
      userId: ME,
      type: "CL",
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2026-12-02T00:00:00Z"),
      ...o,
    } as any);

  it("own APPROVED/REJECTED in the window, newest first, max 5; others and other workspaces excluded", async () => {
    for (let i = 0; i < 6; i++) {
      await leave({ status: "APPROVED", history: [{ action: "APPROVED", at: new Date(NOW - (i + 1) * 3600_000) }], updatedAt: new Date(NOW) });
    }
    await leave({ status: "PENDING", updatedAt: new Date(NOW) });
    await leave({ status: "REJECTED", history: [{ action: "REJECTED", at: new Date(NOW - 10 * 86400_000) }], updatedAt: new Date(NOW - 10 * 86400_000) });
    await leave({ workspaceId: OTHER_WS, status: "APPROVED", history: [{ action: "APPROVED", at: new Date(NOW - 60_000) }], updatedAt: new Date(NOW) });
    await leave({ userId: SOMEONE_ELSE, status: "APPROVED", history: [{ action: "APPROVED", at: new Date(NOW - 60_000) }], updatedAt: new Date(NOW) });
    // OD regularisation rejected 30 min ago — the newest of all
    await Attendance.collection.insertOne({
      workspaceId: WS,
      userId: ME,
      date: "2026-11-26",
      punches: [],
      odRequests: [{ reason: "client visit", from: "10:00", to: "12:00", status: "REJECTED", reviewedAt: new Date(NOW - 30 * 60_000) }],
    } as any);

    const r = await computeRecentDecisions({ ...me, days: 7 });
    expect(r.since).toBe("2026-11-21");
    expect(r.items).toHaveLength(5);
    expect(r.items[0]).toEqual({
      kind: "regularisation",
      status: "REJECTED",
      decidedAt: new Date(NOW - 30 * 60_000).toISOString(),
      fromDate: "2026-11-26",
      toDate: "2026-11-26",
    });
    expect(r.items[1]).toMatchObject({ kind: "leave", status: "APPROVED", leaveType: "CL", fromDate: "2026-12-01", toDate: "2026-12-02" });
    const times = r.items.map((i) => i.decidedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("decidedAt is the decision's history entry, not a later edit; window widens with days", async () => {
    await leave({ status: "REJECTED", history: [{ action: "REJECTED", at: new Date(NOW - 10 * 86400_000) }], updatedAt: new Date(NOW) });
    expect((await computeRecentDecisions({ ...me, days: 7 })).items).toHaveLength(0);
    expect((await computeRecentDecisions({ ...me, days: 14 })).items).toHaveLength(1);
  });
});
