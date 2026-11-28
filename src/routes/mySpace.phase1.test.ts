// /api/my-space Phase 1 routes — wiring, input validation, and the rule that
// the workspace is NEVER taken from the request (query/body/params/headers).
// Auth and requireWorkspace are stubbed to what they hand a normal user (the
// token's own workspace); resolveSelfWorkspace and everything after it is real.
//
// The clock is pinned (only Date is faked — timers and the Mongo driver run
// normally) to Fri 27 Nov 2026 14:30 IST, so "today / this week / this month"
// never straddle an IST midnight or a Monday while the test runs.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.JWT_SECRET ||= "my-space-phase1-test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", () => ({
  // What requireWorkspace resolves for a normal user: their own workspace.
  requireWorkspace: (req: any, _res: any, next: any) => {
    req.workspaceId = String(req.user.workspaceId);
    req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.user.workspaceId));
    next();
  },
  resolveWorkspaceForUser: async () => null,
}));

const { default: router } = await import("./mySpace.js");
const { default: Attendance } = await import("../models/Attendance.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");

let mongod: MongoMemoryServer;
const app = express();
app.use(express.json());
app.use("/api/my-space", router);

const WS = new mongoose.Types.ObjectId();
const OTHER_WS = new mongoose.Types.ObjectId();
const ME = new mongoose.Types.ObjectId();
const NOW = Date.parse("2026-11-27T09:00:00Z"); // Fri 14:30 IST
const user = { sub: String(ME), _id: String(ME), roles: ["EMPLOYEE"], email: "me@x.test", workspaceId: String(WS) };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await CustomerWorkspace.collection.insertMany([
    { _id: WS, customerId: new mongoose.Types.ObjectId(), status: "ACTIVE", config: { features: {} } },
    { _id: OTHER_WS, customerId: new mongoose.Types.ObjectId(), status: "ACTIVE", config: { features: {} } },
  ] as any);
  // Today's punches in MY workspace; yesterday's (a different date — Attendance is unique on
  // {userId, date}) in the other one.
  await Attendance.collection.insertMany([
    { workspaceId: WS, userId: ME, date: "2026-11-27", punches: [{ ts: new Date("2026-11-27T08:30:00Z"), type: "IN" }, { ts: new Date("2026-11-27T08:50:00Z"), type: "OUT" }] },
    { workspaceId: OTHER_WS, userId: ME, date: "2026-11-26", punches: [{ ts: new Date("2026-11-26T04:00:00Z"), type: "IN" }, { ts: new Date("2026-11-26T09:00:00Z"), type: "OUT" }] },
  ] as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  vi.useRealTimers();
});

const get = (path: string, u: any = user) => request(app).get(`/api/my-space${path}`).set("x-test-user", JSON.stringify(u));

describe("/api/my-space Phase 1", () => {
  it("attendance-hours: ?workspaceId= is ignored — only the caller's own workspace counts", async () => {
    const res = await get(`/attendance-hours?range=week&workspaceId=${OTHER_WS}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.ok).toBe(true);
    // 20 minutes today in WS; the 5h in OTHER_WS never appears (whatever the weekday)
    expect(res.body.workedMinutes).toBe(20);
    expect(res.body.from).toBe("2026-11-23");
  });

  it("attendance-hours: bad range → 400", async () => {
    expect((await get("/attendance-hours?range=year")).status).toBe(400);
  });

  it("month-summary: malformed month → 400; default month is the current IST month", async () => {
    expect((await get("/month-summary?month=2026-13")).status).toBe(400);
    const res = await get("/month-summary");
    expect(res.status).toBe(200);
    expect(res.body.month).toBe("2026-11");
    expect(res.body.asOf).toBe("2026-11-27");
    expect(res.body.lopDays).toBeNull();
  });

  it("recent-decisions: non-numeric days falls back to 7", async () => {
    const res = await get("/recent-decisions?days=abc");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.items).toEqual([]);
  });

  it("admin-overview: an EMPLOYEE gets an empty blocks object", async () => {
    const res = await get(`/admin-overview?workspaceId=${OTHER_WS}`);
    expect(res.status).toBe(200);
    expect(res.body.blocks).toEqual({});
  });

  it("attendance-hours ?compare=previous adds `previous`; any other compare value → 400", async () => {
    const plain = await get("/attendance-hours?range=week");
    expect(plain.body.previous).toBeUndefined();
    const res = await get("/attendance-hours?range=week&compare=previous");
    expect(res.status).toBe(200);
    expect(res.body.workedMinutes).toBe(20);
    expect(res.body.previous).toMatchObject({ from: "2026-11-16", workedMinutes: 0 });
    expect((await get("/attendance-hours?range=week&compare=last")).status).toBe(400);
  });

  it("year-summary: default = this IST year; malformed or future year → 400; ?workspaceId ignored", async () => {
    const res = await get(`/year-summary?workspaceId=${OTHER_WS}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.year).toBe(2026);
    expect(res.body.lopDays).toBeNull();
    const past = await get("/year-summary?year=2025");
    expect(past.status).toBe(200);
    expect(past.body.year).toBe(2025);
    expect(past.body.months).toHaveLength(12);
    expect((await get("/year-summary?year=2026")).status).toBe(200);
    expect((await get("/year-summary?year=26")).status).toBe(400);
    expect((await get("/year-summary?year=dddd")).status).toBe(400);
    expect((await get("/year-summary?year=2027")).status).toBe(400);
  });

  it("attendance-trend: 6 months by default; months outside 1–12 → 400", async () => {
    const res = await get("/attendance-trend");
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(6);
    expect(res.body.months[5].month).toBe("2026-11");
    expect((await get("/attendance-trend?months=0")).status).toBe(400);
    expect((await get("/attendance-trend?months=13")).status).toBe(400);
  });

  it("a caller without a valid user id is refused on the self endpoints", async () => {
    expect((await get("/year-summary", { ...user, sub: "nope", _id: "nope" })).status).toBe(401);
    expect((await get("/attendance-trend", { ...user, sub: "nope", _id: "nope" })).status).toBe(401);
    expect((await get("/attendance-hours", { ...user, sub: "nope", _id: "nope" })).status).toBe(401);
  });
});
