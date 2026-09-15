// Employee deactivation — the canonical active/inactive model (2026-09-16).
//
// Before this, "marking an employee inactive" wrote nothing any gate read:
// the only Team Profiles control was `employmentStatus` (HR display text),
// login never looked at User.status, Team Presence listed every workspace
// user, and Employee.isActive was never set false by anything. This file
// proves the fixed shape end to end, against a real Mongo, through the real
// routers:
//
//   (a) an INACTIVE employee cannot log in — not even via the
//       SUPERADMIN_EMAILS bypass — and cannot refresh a still-valid cookie;
//   (b) they vanish from Team Presence, the CRM reps picker, the /users
//       picker and GET /employees (active view), and appear under
//       ?status=inactive;
//   (c) their history still resolves by id (attendance, lead ownership, the
//       id→name resolver shape every historical surface uses);
//   plus tenant scoping, self-deactivation refusal, the PUT pass-through
//   guard, and reactivation.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/employee-deactivation-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

// HOUSE workspace — the CRM reps picker (leads.ts) is pinned to this id.
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const OTHER_WS = new mongoose.Types.ObjectId();

const ids = vi.hoisted(() => ({
  admin: "66b000000000000000000001",
  priya: "66b000000000000000000002",
  otherAdmin: "66b000000000000000000003",
  saEmail: "66b000000000000000000004",
}));

/** Who is calling the protected routers; swapped per test. */
const caller = vi.hoisted(() => ({ current: "admin" as "admin" | "otherAdmin" | "priya" }));

// requireAuth / requireWorkspace are replaced on the PROTECTED routers only.
// routes/auth.ts (login + refresh) does not import them — it runs for real.
vi.mock("../middleware/auth.js", () => {
  const inject = (req: any, _res: any, next: any) => {
    const HOUSE_ID = "69679a7628330a58d29f2254";
    const map: Record<string, any> = {
      admin: { id: ids.admin, _id: ids.admin, sub: ids.admin, roles: ["ADMIN"], email: "ops@plumtrips.com", workspaceId: HOUSE_ID },
      otherAdmin: { id: ids.otherAdmin, _id: ids.otherAdmin, sub: ids.otherAdmin, roles: ["ADMIN"], email: "admin@other.test" },
      priya: { id: ids.priya, _id: ids.priya, sub: ids.priya, roles: ["EMPLOYEE"], email: "priya@plumtrips.com", workspaceId: HOUSE_ID },
    };
    req.user = map[caller.current];
    next();
  };
  return { requireAuth: inject, default: inject };
});
vi.mock("../middleware/requireWorkspace.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    requireWorkspace: (req: any, _res: any, next: any) => {
      req.workspaceObjectId =
        caller.current === "otherAdmin"
          ? new mongoose.Types.ObjectId("66b0000000000000000000ff")
          : new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
      next();
    },
  };
});
vi.mock("../middleware/requireHouse.js", () => ({
  requireHouse: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const { default: User } = await import("../models/User.js");
const { default: Employee } = await import("../models/Employee.js");
const { default: UserPresence } = await import("../models/UserPresence.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: Attendance } = await import("../models/Attendance.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: SessionLog } = await import("../models/SessionLog.js");
const { default: authRouter } = await import("./auth.js");
const { default: employeesRouter } = await import("./employees.js");
const { default: presenceRouter } = await import("./presence.js");
const { default: leadsRouter } = await import("./leads.js");
const { default: usersRouter } = await import("./users.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { isUserActive, activeUserFilter, setUserActiveStatus } = await import("../utils/userActiveStatus.js");

let mongod: MongoMemoryServer;
const oid = (s: string) => new mongoose.Types.ObjectId(s);
const PRIYA_PASSWORD = "priya-secret-123";
const priyaEmployeeId = new mongoose.Types.ObjectId();
const leadId = new mongoose.Types.ObjectId();

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/auth", authRouter);
  a.use("/api/employees", employeesRouter);
  // server.ts mounts presence behind requireAuth + requireWorkspace.
  a.use("/api/presence", requireWorkspace as any, presenceRouter);
  a.use("/api/leads", leadsRouter);
  a.use("/api/users", usersRouter);
  return a;
}

const login = (email: string, password: string) =>
  request(app()).post("/api/auth/login").send({ email, password });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const hash = await bcrypt.hash(PRIYA_PASSWORD, 4);
  // Raw inserts on purpose: a real prod row predates every field added since,
  // so nothing here may rely on a schema default being stamped.
  await User.collection.insertMany([
    { _id: oid(ids.admin), name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], workspaceId: HOUSE, passwordHash: "x", status: "ACTIVE" },
    { _id: oid(ids.priya), name: "Priya Nair", email: "priya@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: HOUSE, passwordHash: hash, accountType: "EMPLOYEE" },
    { _id: oid(ids.otherAdmin), name: "Other Admin", email: "admin@other.test", roles: ["ADMIN"], workspaceId: OTHER_WS, passwordHash: "x", status: "ACTIVE" },
    // Same shape as a SUPERADMIN_EMAILS entry in auth.ts — the bypass case.
    { _id: oid(ids.saEmail), name: "Admin", email: "admin@plumtrips.com", roles: ["ADMIN"], workspaceId: HOUSE, passwordHash: hash, status: "ACTIVE" },
  ] as any[]);
  await Employee.collection.insertMany([
    { _id: priyaEmployeeId, fullName: "Priya Nair", email: "priya@plumtrips.com", ownerId: oid(ids.priya), workspaceId: HOUSE, status: "ACTIVE", isActive: true },
  ] as any[]);
  // Priya holds a leads grant → she is a CRM rep.
  await UserPermission.collection.insertMany([
    { userId: ids.priya, email: "priya@plumtrips.com", workspaceId: String(HOUSE), universe: "STAFF", status: "active", level: { code: "L2", name: "Employee", designation: "" }, modules: { leads: { access: "WRITE", scope: "OWN" } } },
  ] as any[]);
  await UserPresence.collection.insertMany([
    { userId: oid(ids.priya), lastActivity: new Date(), idleDuration: 0 },
    { userId: oid(ids.admin), lastActivity: new Date(), idleDuration: 0 },
  ] as any[]);
  await Attendance.collection.insertOne({ workspaceId: HOUSE, userId: oid(ids.priya), date: "2026-09-01", status: "PRESENT" } as any);
  await Lead.collection.insertOne({
    _id: leadId, leadCode: "L-0001", contactName: "Acme Buyer", contactPhone: "9999999999", companyName: "Acme",
    assignedTo: oid(ids.priya), assignedToName: "Priya Nair", stage: "NEW", status: "OPEN", createdAt: new Date(),
  } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function presenceEmails(): Promise<string[]> {
  const res = await request(app()).get("/api/presence/team");
  expect(res.status).toBe(200);
  return (res.body as any[]).map((r) => r.email);
}
async function repIds(): Promise<string[]> {
  const res = await request(app()).get("/api/leads/reps");
  expect(res.status).toBe(200);
  return (res.body.reps as any[]).map((r) => String(r._id));
}
async function usersPickerEmails(status?: string): Promise<string[]> {
  const res = await request(app()).get(`/api/users${status ? `?status=${status}` : ""}`);
  expect(res.status).toBe(200);
  return (res.body.users as any[]).map((u) => u.email);
}
async function employeesEmails(status: string): Promise<string[]> {
  const res = await request(app()).get(`/api/employees?status=${status}`);
  expect(res.status).toBe(200);
  const raw = res.body;
  const list = Array.isArray(raw) ? raw : raw.employees;
  return (list as any[]).map((e) => e.email);
}

describe("employee deactivation — canonical User.status", () => {
  it("baseline: an active employee logs in and shows up everywhere", async () => {
    const res = await login("priya@plumtrips.com", PRIYA_PASSWORD);
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");

    caller.current = "admin";
    expect(await presenceEmails()).toContain("priya@plumtrips.com");
    expect(await repIds()).toContain(ids.priya);
    expect(await usersPickerEmails()).toContain("priya@plumtrips.com");
    expect(await employeesEmails("active")).toContain("priya@plumtrips.com");
  });

  it("a tenant admin from ANOTHER workspace cannot deactivate her (404, nothing written)", async () => {
    caller.current = "otherAdmin";
    const res = await request(app()).patch(`/api/employees/${priyaEmployeeId}/status`).send({ status: "INACTIVE" });
    expect(res.status).toBe(404);
    const u: any = await User.findById(ids.priya).lean();
    expect(isUserActive(u)).toBe(true);
  });

  it("rejects an unknown status value", async () => {
    caller.current = "admin";
    const res = await request(app()).patch(`/api/employees/${priyaEmployeeId}/status`).send({ status: "EXITED" });
    expect(res.status).toBe(400);
  });

  it("an admin cannot deactivate their own account", async () => {
    caller.current = "admin";
    const res = await request(app()).patch(`/api/employees/${ids.admin}/status`).send({ status: "INACTIVE" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own account/i);
  });

  it("PATCH /employees/:id/status INACTIVE writes User.status and mirrors both Employee flags", async () => {
    caller.current = "admin";
    const res = await request(app()).patch(`/api/employees/${priyaEmployeeId}/status`).send({ status: "inactive" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, userId: ids.priya, employeeId: String(priyaEmployeeId), status: "INACTIVE", employeeMirrorsUpdated: 1 });

    const u: any = await User.findById(ids.priya).lean();
    expect(u.status).toBe("INACTIVE");
    const e: any = await Employee.findById(priyaEmployeeId).lean();
    expect(e.status).toBe("INACTIVE");
    expect(e.isActive).toBe(false);
  });

  it("(a) login is refused with a clear error and no token; the attempt is logged", async () => {
    const res = await login("priya@plumtrips.com", PRIYA_PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_INACTIVE");
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();

    // SessionLog.create is fire-and-forget; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const log: any = await SessionLog.findOne({ userId: oid(ids.priya), event: "LOGIN_FAILED", failureReason: "account_inactive" }).lean();
    expect(log).not.toBeNull();
  });

  it("(a) the SUPERADMIN_EMAILS bypass cannot re-admit an inactive account", async () => {
    await setUserActiveStatus({ userId: ids.saEmail, workspaceId: HOUSE, status: "INACTIVE" });
    const res = await login("admin@plumtrips.com", PRIYA_PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_INACTIVE");
    expect(res.body.accessToken).toBeUndefined();
  });

  it("(a) a still-valid refresh cookie cannot mint a new access token", async () => {
    const refresh = jwt.sign({ sub: ids.priya }, process.env.JWT_REFRESH_SECRET as string, { expiresIn: "7d" });
    const res = await request(app()).post("/api/auth/refresh").set("Cookie", [`refreshToken=${refresh}`]);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_INACTIVE");
    expect(res.body.accessToken).toBeUndefined();
  });

  it("(b) she is gone from Team Presence, CRM reps, the /users picker and the active employee list", async () => {
    caller.current = "admin";
    expect(await presenceEmails()).not.toContain("priya@plumtrips.com");
    expect(await presenceEmails()).toContain("ops@plumtrips.com"); // the filter is per-person, not per-workspace
    expect(await repIds()).not.toContain(ids.priya);
    expect(await usersPickerEmails()).not.toContain("priya@plumtrips.com");
    expect(await usersPickerEmails("all")).toContain("priya@plumtrips.com");
    expect(await employeesEmails("active")).not.toContain("priya@plumtrips.com");
    expect(await employeesEmails("inactive")).toContain("priya@plumtrips.com");
  });

  it("(b) the active-employee list row reports the canonical status", async () => {
    caller.current = "admin";
    const res = await request(app()).get("/api/employees?status=inactive");
    const row = (Array.isArray(res.body) ? res.body : res.body.employees).find((e: any) => e.email === "priya@plumtrips.com");
    expect(row.status).toBe("INACTIVE");
    expect(row.isActive).toBe(false);
  });

  it("(c) her history still resolves by id — attendance, lead ownership, id→name lookups", async () => {
    caller.current = "admin";
    const att = await Attendance.findOne({ userId: oid(ids.priya), date: "2026-09-01" }).lean();
    expect(att).not.toBeNull();

    const lead = await request(app()).get(`/api/leads/${leadId}`);
    expect(lead.status).toBe(200);
    expect(String(lead.body.lead.assignedTo)).toBe(ids.priya);
    expect(lead.body.lead.assignedToName).toBe("Priya Nair");

    // The exact shape every historical surface uses to put a name on an id
    // (payroll, expenses, invoices, CRM activity feed): no active filter.
    const resolved = await User.find({ _id: { $in: [oid(ids.priya)] } }).select("_id name").lean();
    expect(resolved.map((u: any) => u.name)).toEqual(["Priya Nair"]);
    // …and the active filter is what would have hidden her.
    expect(await User.countDocuments({ _id: oid(ids.priya), ...activeUserFilter() })).toBe(0);
  });

  it("an ordinary profile save (PUT) cannot silently reactivate", async () => {
    caller.current = "admin";
    // The /profile/team form PUTs its whole row back — including the
    // status/isActive it was handed by GET before the flip.
    const res = await request(app()).put(`/api/employees/${priyaEmployeeId}`).send({
      email: "priya@plumtrips.com", officialEmail: "priya@plumtrips.com", name: "Priya Nair", status: "ACTIVE", isActive: true, jobLocation: "Mumbai",
    });
    expect(res.status).toBe(200);
    const u: any = await User.findById(ids.priya).lean();
    expect(u.status).toBe("INACTIVE");
    expect(u.jobLocation).toBe("Mumbai"); // the save itself still landed
  });

  it("the User.status setter normalises case so a mixed-case value cannot slip past the filter", async () => {
    const u: any = await User.findById(ids.priya);
    u.status = "Inactive";
    await u.save();
    expect((await User.findById(ids.priya).lean() as any).status).toBe("INACTIVE");
  });

  it("reactivation restores login and visibility", async () => {
    caller.current = "admin";
    const res = await request(app()).patch(`/api/employees/${priyaEmployeeId}/status`).send({ status: "ACTIVE" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACTIVE");

    const e: any = await Employee.findById(priyaEmployeeId).lean();
    expect(e.status).toBe("ACTIVE");
    expect(e.isActive).toBe(true);

    const back = await login("priya@plumtrips.com", PRIYA_PASSWORD);
    expect(back.status).toBe(200);
    expect(typeof back.body.accessToken).toBe("string");

    expect(await presenceEmails()).toContain("priya@plumtrips.com");
    expect(await repIds()).toContain(ids.priya);
  });
});
