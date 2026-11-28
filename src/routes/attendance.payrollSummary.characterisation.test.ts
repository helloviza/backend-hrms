// CHARACTERISATION TEST — GET /api/attendance/payroll-summary
//
// Pins the route's CURRENT output on fixed fixture data, written BEFORE the
// per-user calculation was extracted into services/attendanceMonth.service.ts
// (feat/profile-me-by-role, step 1.2). The snapshot below is the behaviour as
// it stood on origin/main 357f42ec — including its known quirks, which are
// deliberately NOT fixed here (ticketed separately):
//   - the late check reads server-local getHours(), so on a UTC server a
//     10:00 IST punch (04:30Z) is never "late";
//   - hours are lastOut − firstIn, so breaks count as work;
//   - leave days are walked on the server-local calendar.
// If this snapshot ever has to change, the refactor changed behaviour.
//
// The process timezone is pinned to UTC (production runs in UTC) so the
// snapshot does not depend on the machine running the test.
process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (req: any, _res: any, next: any) => {
    const ws = String(req.headers["x-test-ws"] || "");
    req.workspaceId = ws;
    req.workspaceObjectId = new mongoose.Types.ObjectId(ws);
    next();
  },
}));

const { default: attendanceRouter } = await import("./attendance.js");
const { default: Attendance } = await import("../models/Attendance.js");
const { default: LeaveRequest } = await import("../models/LeaveRequest.js");
const { default: Holiday } = await import("../models/Holiday.js");
const { default: User } = await import("../models/User.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");

let mongod: MongoMemoryServer;
const app = express();
app.use("/api/attendance", attendanceRouter);

const WS = new mongoose.Types.ObjectId("6a0000000000000000000001");
const OTHER_WS = new mongoose.Types.ObjectId("6a0000000000000000000002");
const A = new mongoose.Types.ObjectId("6b0000000000000000000001");
const B = new mongoose.Types.ObjectId("6b0000000000000000000002");
const C = new mongoose.Types.ObjectId("6b0000000000000000000003");
const D = new mongoose.Types.ObjectId("6b0000000000000000000004"); // inactive
const E = new mongoose.Types.ObjectId("6b0000000000000000000005"); // other workspace
const HR = { sub: "6b00000000000000000000ff", roles: ["HR"] };

const p = (iso: string, type: "IN" | "OUT") => ({ ts: new Date(iso), type });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  await CustomerWorkspace.collection.insertOne({
    _id: WS,
    attendanceConfig: { shiftStart: "09:30", shiftEnd: "18:30", graceMinutes: 15, halfDayHours: 4.5, minHoursForPresent: 2 },
  } as any);
  await User.collection.insertMany([
    { _id: A, workspaceId: WS, firstName: "Asha", lastName: "Rao", email: "a@x.test", employeeCode: "E1" },
    { _id: B, workspaceId: WS, name: "Bala", email: "b@x.test" },
    { _id: C, workspaceId: WS, email: "c@x.test" },
    { _id: D, workspaceId: WS, email: "d@x.test", status: "INACTIVE" },
    { _id: E, workspaceId: OTHER_WS, email: "e@x.test" },
  ] as any);
  await Holiday.collection.insertMany([
    { workspaceId: WS, date: "2026-10-02", name: "Gandhi Jayanti", type: "GENERAL" },
    { workspaceId: WS, date: "2026-10-21", name: "Optional", type: "OPTIONAL" },
    { workspaceId: OTHER_WS, date: "2026-10-05", name: "Not ours", type: "GENERAL" },
  ] as any);
  await Attendance.collection.insertMany([
    // A — full day, IN 09:00 IST
    { workspaceId: WS, userId: A, date: "2026-10-01", punches: [p("2026-10-01T03:30:00Z", "IN"), p("2026-10-01T12:30:00Z", "OUT")] },
    // A — IN 10:00 IST (late in IST; NOT late on a UTC clock)
    { workspaceId: WS, userId: A, date: "2026-10-05", punches: [p("2026-10-05T04:30:00Z", "IN"), p("2026-10-05T13:00:00Z", "OUT")] },
    // A — split day: 2h + 1h worked, 1h break; lastOut−firstIn = 4h → halfDay
    { workspaceId: WS, userId: A, date: "2026-10-06", punches: [p("2026-10-06T04:00:00Z", "IN"), p("2026-10-06T06:00:00Z", "OUT"), p("2026-10-06T07:00:00Z", "IN"), p("2026-10-06T08:00:00Z", "OUT")] },
    // A — 11h → overtime
    { workspaceId: WS, userId: A, date: "2026-10-07", punches: [p("2026-10-07T04:00:00Z", "IN"), p("2026-10-07T15:00:00Z", "OUT")] },
    // A — IN only (no OUT) at 15:30 UTC (21:00 IST)
    { workspaceId: WS, userId: A, date: "2026-10-08", punches: [p("2026-10-08T15:30:00Z", "IN")] },
    // A — weekend and holiday punches are ignored
    { workspaceId: WS, userId: A, date: "2026-10-10", punches: [p("2026-10-10T04:00:00Z", "IN"), p("2026-10-10T12:00:00Z", "OUT")] },
    { workspaceId: WS, userId: A, date: "2026-10-02", punches: [p("2026-10-02T04:00:00Z", "IN"), p("2026-10-02T12:00:00Z", "OUT")] },
    // B — one present day
    { workspaceId: WS, userId: B, date: "2026-10-09", punches: [p("2026-10-09T04:00:00Z", "IN"), p("2026-10-09T13:00:00Z", "OUT")] },
    // E — other workspace, never counted
    { workspaceId: OTHER_WS, userId: E, date: "2026-10-01", punches: [p("2026-10-01T04:00:00Z", "IN"), p("2026-10-01T13:00:00Z", "OUT")] },
  ] as any);
  await LeaveRequest.collection.insertMany([
    // B — 3 full days, UTC-midnight storage
    { workspaceId: WS, userId: B, type: "CL", from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-14T00:00:00Z"), status: "APPROVED", dayLength: "FULL" },
    // B — half day, IST-midnight storage (18:30Z the day before)
    { workspaceId: WS, userId: B, type: "SL", from: new Date("2026-10-19T18:30:00Z"), to: new Date("2026-10-19T18:30:00Z"), status: "APPROVED", dayLength: "HALF" },
    // B — spans from September into October
    { workspaceId: WS, userId: B, type: "EL", from: new Date("2026-09-29T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z"), status: "APPROVED", dayLength: "FULL" },
    // B — pending and rejected never count
    { workspaceId: WS, userId: B, type: "CL", from: new Date("2026-10-26T00:00:00Z"), to: new Date("2026-10-26T00:00:00Z"), status: "PENDING" },
    { workspaceId: WS, userId: B, type: "CL", from: new Date("2026-10-27T00:00:00Z"), to: new Date("2026-10-27T00:00:00Z"), status: "REJECTED" },
  ] as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const get = (qs: string) =>
  request(app)
    .get(`/api/attendance/payroll-summary${qs}`)
    .set("x-test-user", JSON.stringify(HR))
    .set("x-test-ws", String(WS));

describe("payroll-summary — characterisation (pinned before the step 1.2 refactor)", () => {
  it("process timezone is UTC for this file", () => {
    expect(new Date("2026-10-05T04:30:00Z").getHours()).toBe(4);
  });

  it("whole workspace, October 2026", async () => {
    const res = await get("?month=2026-10");
    expect(res.status).toBe(200);
    const { generatedAt, ...body } = res.body;
    expect(typeof generatedAt).toBe("string");
    expect(body).toMatchInlineSnapshot(`
      {
        "month": "2026-10",
        "summary": [
          {
            "absent": 17,
            "avgDailyHours": 10.8,
            "employeeId": "E1",
            "halfDay": 1,
            "late": 1,
            "leaveDays": 0,
            "lopDays": 17,
            "overtime": 1,
            "payrollNote": "17 LOP days",
            "present": 3.5,
            "totalHours": 32.5,
            "userId": "6b0000000000000000000001",
            "userName": "Asha Rao",
            "workingDays": 21,
          },
          {
            "absent": 15.5,
            "avgDailyHours": 9,
            "employeeId": "",
            "halfDay": 0,
            "late": 0,
            "leaveDays": 4.5,
            "lopDays": 15.5,
            "overtime": 0,
            "payrollNote": "15.5 LOP days",
            "present": 1,
            "totalHours": 9,
            "userId": "6b0000000000000000000002",
            "userName": "Bala",
            "workingDays": 21,
          },
          {
            "absent": 21,
            "avgDailyHours": 0,
            "employeeId": "",
            "halfDay": 0,
            "late": 0,
            "leaveDays": 0,
            "lopDays": 21,
            "overtime": 0,
            "payrollNote": "21 LOP days",
            "present": 0,
            "totalHours": 0,
            "userId": "6b0000000000000000000003",
            "userName": "c@x.test",
            "workingDays": 21,
          },
        ],
      }
    `);
  });

  it("single user filter", async () => {
    const res = await get(`?month=2026-10&userId=${A}`);
    expect(res.status).toBe(200);
    const { generatedAt, ...body } = res.body;
    expect(body).toMatchInlineSnapshot(`
      {
        "month": "2026-10",
        "summary": [
          {
            "absent": 17,
            "avgDailyHours": 10.8,
            "employeeId": "E1",
            "halfDay": 1,
            "late": 1,
            "leaveDays": 0,
            "lopDays": 17,
            "overtime": 1,
            "payrollNote": "17 LOP days",
            "present": 3.5,
            "totalHours": 32.5,
            "userId": "6b0000000000000000000001",
            "userName": "Asha Rao",
            "workingDays": 21,
          },
        ],
      }
    `);
  });

  it("no attendanceConfig → legacy defaults (other workspace)", async () => {
    const res = await request(app)
      .get("/api/attendance/payroll-summary?month=2026-10")
      .set("x-test-user", JSON.stringify(HR))
      .set("x-test-ws", String(OTHER_WS));
    expect(res.status).toBe(200);
    const { generatedAt, ...body } = res.body;
    expect(body).toMatchInlineSnapshot(`
      {
        "month": "2026-10",
        "summary": [
          {
            "absent": 20,
            "avgDailyHours": 9,
            "employeeId": "",
            "halfDay": 0,
            "late": 0,
            "leaveDays": 0,
            "lopDays": 20,
            "overtime": 0,
            "payrollNote": "20 LOP days",
            "present": 1,
            "totalHours": 9,
            "userId": "6b0000000000000000000005",
            "userName": "e@x.test",
            "workingDays": 21,
          },
        ],
      }
    `);
  });

  it("403 for a non-HR caller, 400 for a bad month", async () => {
    const emp = await request(app)
      .get("/api/attendance/payroll-summary?month=2026-10")
      .set("x-test-user", JSON.stringify({ sub: String(A), roles: ["EMPLOYEE"] }))
      .set("x-test-ws", String(WS));
    expect(emp.status).toBe(403);
    const bad = await get("?month=2026-1");
    expect(bad.status).toBe(400);
  });
});
