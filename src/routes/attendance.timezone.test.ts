// Attendance timezone P0 — punches keyed to the IST calendar day, not the
// server's UTC day. Real Mongo (memory server), the real router and auth
// middleware; only the CLOCK is controlled (vi.setSystemTime, Date only) so
// each case can stand inside or outside the 00:00–05:30 IST window where the
// UTC and IST dates disagree.
//
//   • a punch at 00:30 IST lands on today's IST date, not yesterday's UTC date
//   • IN then OUT in that window land on the SAME record (toggle stays in sync)
//   • the legacy toggle route reads the same record, so IN→OUT alternates
//   • regularize accepts today's IST date in the window (no false "future")
//   • outside the window nothing changes
//   • the month summary counts up to today's IST date
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "att-tz-test-secret";
process.env.JWT_REFRESH_SECRET = "att-tz-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";

const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: Attendance } = await import("../models/Attendance.js");
const { default: attendanceRouter } = await import("./attendance.js");

let mongod: MongoMemoryServer;
let app: express.Express;

// 2026-09-19T18:30:00Z == 2026-09-20 00:00 IST.
const IST_MIDNIGHT_UTC = Date.UTC(2026, 8, 19, 18, 30);
const MIN = 60_000;
const AT_0030_IST = new Date(IST_MIDNIGHT_UTC + 30 * MIN); // UTC still says Sep 19
const AT_0500_IST = new Date(IST_MIDNIGHT_UTC + 5 * 60 * MIN); // UTC still says Sep 19
const AT_1000_IST = new Date(Date.UTC(2026, 8, 20, 4, 30)); // normal hours — both say Sep 20
const AT_2300_IST = new Date(Date.UTC(2026, 8, 20, 17, 30)); // 23:00 IST — both say Sep 20

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/attendance", attendanceRouter);
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await mongoose.disconnect();
  await mongod.stop();
});
afterEach(() => vi.useRealTimers());

/** Freeze only Date (not timers — the Mongo driver needs real ones). */
function clockAt(d: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(d);
}

let seq = 0;
async function makeEmployee() {
  seq++;
  const ws = await CustomerWorkspace.create({ customerId: `cust-att-${seq}-${Date.now()}`, name: `Att WS ${seq}`, status: "ACTIVE", config: { features: {} } });
  const email = `att-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: "Arjun", lastName: "T", roles: ["EMPLOYEE"], workspaceId: ws._id, status: "ACTIVE" });
  const token = signToken({ sub: String(u._id), roles: ["EMPLOYEE"], email, workspaceId: String(ws._id) } as any);
  const h = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  return {
    wsId: String(ws._id),
    userId: String(u._id),
    post: (p: string, body: any = {}) => h(request(app).post(p)).send(body),
    get: (p: string) => h(request(app).get(p)),
  };
}

describe("punch day = the IST calendar day", () => {
  it("a punch at 00:30 IST is keyed to today's IST date, not yesterday's UTC date", async () => {
    const e = await makeEmployee();
    clockAt(AT_0030_IST);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-09-19"); // what the old code used
    const r = await e.post("/api/attendance/punch-in", { geo: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.date).toBe("2026-09-20"); // the IST day
    const rows = await Attendance.find({ userId: e.userId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-09-20");
    expect(rows[0].punches).toHaveLength(1);
    // The punch INSTANT is still the true instant — only the day key changed.
    expect(new Date(rows[0].punches[0].ts).toISOString()).toBe(AT_0030_IST.toISOString());
  });

  it("IN at 00:30 IST then OUT at 05:00 IST land on the SAME day's record — the toggle stays in sync", async () => {
    const e = await makeEmployee();
    clockAt(AT_0030_IST);
    const a = await e.post("/api/attendance/punch-in", {});
    clockAt(AT_0500_IST);
    const b = await e.post("/api/attendance/punch-out", {});
    expect(a.body.date).toBe("2026-09-20");
    expect(b.body.date).toBe("2026-09-20");
    expect(String(a.body._id)).toBe(String(b.body._id)); // one record
    const rows = await Attendance.find({ userId: e.userId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].punches.map((p: any) => p.type)).toEqual(["IN", "OUT"]);
  });

  it("the legacy toggle route alternates IN → OUT → IN on that same IST-day record across the window", async () => {
    const e = await makeEmployee();
    clockAt(AT_0030_IST);
    expect((await e.post("/api/attendance/punch", {})).body.punches.map((p: any) => p.type)).toEqual(["IN"]);
    clockAt(AT_0500_IST);
    expect((await e.post("/api/attendance/punch", {})).body.punches.map((p: any) => p.type)).toEqual(["IN", "OUT"]);
    clockAt(AT_1000_IST); // same IST day, now UTC agrees too
    const c = await e.post("/api/attendance/punch", {});
    expect(c.body.date).toBe("2026-09-20");
    expect(c.body.punches.map((p: any) => p.type)).toEqual(["IN", "OUT", "IN"]);
    expect(await Attendance.countDocuments({ userId: e.userId })).toBe(1);
  });

  it("outside the window (10:00 and 23:00 IST) behaviour is unchanged — same date as before, one record per day", async () => {
    const e = await makeEmployee();
    clockAt(AT_1000_IST);
    const a = await e.post("/api/attendance/punch-in", {});
    expect(a.body.date).toBe("2026-09-20");
    expect(a.body.date).toBe(new Date().toISOString().slice(0, 10)); // agrees with the old derivation here
    clockAt(AT_2300_IST);
    const b = await e.post("/api/attendance/punch-out", {});
    expect(b.body.date).toBe("2026-09-20");
    expect(await Attendance.countDocuments({ userId: e.userId })).toBe(1);
    // The next IST day at 00:10 IST starts a NEW record — the boundary is IST midnight.
    clockAt(new Date(Date.UTC(2026, 8, 20, 18, 40))); // 00:10 IST Sep 21
    const c = await e.post("/api/attendance/punch-in", {});
    expect(c.body.date).toBe("2026-09-21");
    expect(await Attendance.countDocuments({ userId: e.userId })).toBe(2);
  });
});

describe("regularize validates against the IST day", () => {
  it("accepts today's IST date at 00:30 IST (was refused as 'future'), and still refuses tomorrow and >30 days back", async () => {
    const e = await makeEmployee();
    clockAt(AT_0030_IST);
    const body = (date: string) => ({ date, reason: "forgot to punch", from: "09:00", to: "18:00" });
    const today = await e.post("/api/attendance/regularize", body("2026-09-20"));
    expect(today.status, JSON.stringify(today.body)).toBe(200);
    const tomorrow = await e.post("/api/attendance/regularize", body("2026-09-21"));
    expect(tomorrow.status).toBe(400);
    expect(tomorrow.body.error).toMatch(/future/);
    const yesterday = await e.post("/api/attendance/regularize", body("2026-09-19"));
    expect(yesterday.status).toBe(200);
    const edge = await e.post("/api/attendance/regularize", body("2026-08-21")); // exactly 30 days back — allowed
    expect(edge.status).toBe(200);
    const tooOld = await e.post("/api/attendance/regularize", body("2026-08-20"));
    expect(tooOld.status).toBe(400);
    expect(tooOld.body.error).toMatch(/last 30 days/);
  });
});

describe("month summary counts up to today's IST date", () => {
  it("at 00:30 IST on the 1st the summary is for the NEW month (UTC still says last month)", async () => {
    clockAt(new Date(Date.UTC(2026, 8, 30, 19, 0))); // 00:30 IST Oct 1 — set BEFORE minting the token (30-min JWT)
    const e = await makeEmployee();
    await e.post("/api/attendance/punch-in", {});
    const r = await e.get("/api/attendance/reports?range=month");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.chart.points).toHaveLength(1); // Oct 1 only
    expect(r.body.chart.points[0]).toEqual({ label: "01", value: 100 });
    expect(r.body.thisMonthPercent).toBe(100);
  });
});
