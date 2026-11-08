// B2 — attendance definition behind /stats/dashboard (audit M2), against a
// real Mongo (mongodb-memory-server). No mocks: the point is the queries.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const { default: Attendance } = await import("../models/Attendance.js");
const { default: LeaveRequest } = await import("../models/LeaveRequest.js");
const { default: Holiday } = await import("../models/Holiday.js");
const { default: DocumentModel } = await import("../models/Document.js");
const { computeDashboardStats } = await import("./mySpaceStats.service.js");

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
const USER = new mongoose.Types.ObjectId();

// 2026-11-10 (Tue) 20:00 UTC == 2026-11-11 (Wed) 01:30 IST.
// A UTC clock would say "today = 10th"; the IST answer is the 11th.
const NOW = Date.parse("2026-11-10T20:00:00Z");

const punchIn = (date: string, userId = USER, ws: any = WS) =>
  Attendance.collection.insertOne({
    ...(ws ? { workspaceId: ws } : {}),
    userId,
    date,
    punches: [{ ts: new Date(`${date}T04:00:00Z`), type: "IN" }],
  } as any);

beforeEach(async () => {
  await Promise.all([
    Attendance.deleteMany({}),
    LeaveRequest.deleteMany({}),
    Holiday.deleteMany({}),
    DocumentModel.deleteMany({}),
  ]);
});

describe("computeDashboardStats — attendance (rolling 30 IST days)", () => {
  it("uses the IST calendar day for 'today' (01:30 IST is already the 11th)", async () => {
    await punchIn("2026-11-11");
    const s = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    expect(s.attendance30.to).toBe("2026-11-11");
    expect(s.attendance30.from).toBe("2026-10-13");
    expect(s.days).toHaveLength(30);
    expect(s.days[29]).toMatchObject({ date: "2026-11-11", state: "present" });
  });

  it("today without a punch is 'today', not a missed working day", async () => {
    const s = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    expect(s.days[29].state).toBe("today");
    // 30-day window 13 Oct – 11 Nov: 21 weekdays, minus today (no punch) = 21
    // (13 Oct Tue .. 10 Nov Tue has 21 weekdays)
    expect(s.attendance30.workingDays).toBe(21);
    expect(s.attendance30.present).toBe(0);
    expect(s.attendance30.pct).toBe(0);
  });

  it("weekend punches are shown but never counted", async () => {
    await punchIn("2026-11-08"); // Sunday
    const s = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    const sun = s.days.find((d) => d.date === "2026-11-08")!;
    expect(sun.state).toBe("weekend");
    expect(sun.punched).toBe(true);
    expect(s.attendance30.present).toBe(0);
  });

  it("workspace holidays and approved leave are excluded from working days", async () => {
    await Holiday.collection.insertOne({ workspaceId: WS, date: "2026-11-03", name: "Test Holiday" } as any);
    await LeaveRequest.collection.insertOne({
      workspaceId: WS,
      userId: USER,
      type: "CL",
      from: new Date("2026-11-04T00:00:00Z"),
      to: new Date("2026-11-05T00:00:00Z"),
      status: "APPROVED",
    } as any);
    await punchIn("2026-11-06");
    const s = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    expect(s.days.find((d) => d.date === "2026-11-03")).toMatchObject({ state: "holiday", holidayName: "Test Holiday" });
    expect(s.days.find((d) => d.date === "2026-11-04")!.state).toBe("leave");
    expect(s.days.find((d) => d.date === "2026-11-05")!.state).toBe("leave");
    expect(s.attendance30.workingDays).toBe(21 - 3);
    expect(s.attendance30.present).toBe(1);
    expect(s.attendance30.pct).toBeCloseTo((1 / 18) * 100, 1);
  });

  it("another workspace's holiday never applies; no resolved workspace reads no holidays", async () => {
    await Holiday.collection.insertOne({ workspaceId: OTHER_WS, date: "2026-11-03", name: "Not ours" } as any);
    const scoped = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    expect(scoped.days.find((d) => d.date === "2026-11-03")!.state).toBe("absent");
    const unresolved = await computeDashboardStats({ userId: String(USER), workspaceObjectId: null, now: NOW });
    expect(unresolved.holidaysResolved).toBe(false);
    expect(unresolved.nextHoliday).toBeNull();
  });

  it("nextHoliday is today-or-later in IST (never 'In -1 days')", async () => {
    await Holiday.collection.insertMany([
      { workspaceId: WS, date: "2026-11-10", name: "Yesterday IST" },
      { workspaceId: WS, date: "2026-11-11", name: "Today IST" },
    ] as any);
    const s = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    expect(s.nextHoliday).toEqual({ date: "2026-11-11", name: "Today IST" });
  });

  it("own records missing workspaceId still count (userId-only scoping)", async () => {
    await punchIn("2026-11-06", USER, null);
    await DocumentModel.collection.insertOne({ userId: USER, name: "x", key: "k", verificationStatus: "VERIFIED" } as any);
    const s = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    expect(s.days.find((d) => d.date === "2026-11-06")!.state).toBe("present");
    expect(s.documents).toEqual({ total: 1, verified: 1, pending: 0, rejected: 0 });
  });

  it("previous-window pct is computed for the delta", async () => {
    await punchIn("2026-10-06"); // Tue, inside previous window (13 Sep – 12 Oct)
    const s = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    expect(s.attendance30.prevPct).not.toBeNull();
    expect(s.attendance30.prevPct!).toBeGreaterThan(0);
  });

  it("no punch at all in the previous window → no baseline, prevPct null", async () => {
    await punchIn("2026-11-06");
    const s = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    expect(s.attendance30.prevPct).toBeNull();
  });

  it("keeps the legacy fields ProfilePerformance reads", async () => {
    await punchIn("2026-11-06");
    const s = await computeDashboardStats({ userId: String(USER), workspaceObjectId: WS, now: NOW });
    expect(s.attendance).toHaveLength(30);
    expect(s.attendance.find((p) => p.label === "2026-11-06")!.value).toBe(1);
    expect(typeof s.attendancePercent).toBe("string");
    expect(typeof s.docsUploaded).toBe("string");
  });
});
