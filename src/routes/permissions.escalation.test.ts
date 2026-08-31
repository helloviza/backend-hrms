// apps/backend/src/routes/permissions.escalation.test.ts
//
// The level ceiling: a workspace-scoped caller must not be able to mint a
// platform SuperAdmin.
//
// /grant, /update and /apply-template all sync the granted level onto the
// target User -- levelToRole('L8') is 'SUPERADMIN' and roleToRolesArray
// writes roles: ['SUPERADMIN']. Nothing restricted WHICH level a non-super
// caller could hand out, so anyone admitted to this router with workspace
// scope could grant L8 to a user in their own workspace (themselves
// included) and come back a platform SuperAdmin.
//
// That predated the accessConsole door -- any TENANT_ADMIN could already do
// it -- but opening the router to permission holders would have widened it,
// so refuseSuperAdminLevel closes it for every non-super caller. These tests
// are the reason it stays closed.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireAccessConsole.js", () => ({
  requireAccessConsole: (_req: any, _res: any, next: any) => next(),
  requireAccessConsoleWrite: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireSuperAdmin.js", () => ({
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
}));

import router from "./permissions.js";
import User from "../models/User.js";
import { UserPermission } from "../models/UserPermission.js";

let mongod: MongoMemoryServer;
const WS = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let caller: { isPlatformSuperAdmin: boolean };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      _id: String(new mongoose.Types.ObjectId()),
      email: "caller@plumtrips.com",
      roles: caller.isPlatformSuperAdmin ? ["SUPERADMIN"] : ["ADMIN"],
    };
    req.isPlatformSuperAdmin = caller.isPlatformSuperAdmin;
    req.accessConsoleAccess = "FULL";
    req.workspaceObjectId = WS;
    next();
  });
  app.use("/", router);
  return app;
}

async function makeTarget(email: string) {
  return User.create({
    email,
    fullName: "Target User",
    passwordHash: "x".repeat(20),
    roles: ["EMPLOYEE"],
    workspaceId: WS,
  } as any);
}

beforeEach(async () => {
  caller = { isPlatformSuperAdmin: false };
  await User.deleteMany({});
  await UserPermission.deleteMany({});
});

describe("level ceiling on /grant", () => {
  it("REFUSES a non-superadmin caller granting L8 (SUPERADMIN)", async () => {
    await makeTarget("victim@plumtrips.com");
    const res = await request(makeApp())
      .post("/grant")
      .send({ email: "victim@plumtrips.com", universe: "STAFF", levelCode: "L8" });

    expect(res.status).toBe(403);
    expect(String(res.body?.message)).toMatch(/only a platform superadmin/i);

    // The decisive assertion: the target's roles were NOT rewritten.
    const after = await User.findOne({ email: "victim@plumtrips.com" }).lean();
    expect((after as any)?.roles).toEqual(["EMPLOYEE"]);
    expect(await UserPermission.countDocuments({})).toBe(0);
  });

  it("REFUSES self-escalation — the caller granting themselves L8", async () => {
    await makeTarget("caller@plumtrips.com");
    const res = await request(makeApp())
      .post("/grant")
      .send({ email: "caller@plumtrips.com", universe: "STAFF", levelCode: "L8" });

    expect(res.status).toBe(403);
    const after = await User.findOne({ email: "caller@plumtrips.com" }).lean();
    expect((after as any)?.roles).toEqual(["EMPLOYEE"]);
  });

  it("ALLOWS a non-superadmin caller granting an ordinary level (L6 Admin)", async () => {
    await makeTarget("newadmin@plumtrips.com");
    const res = await request(makeApp())
      .post("/grant")
      .send({ email: "newadmin@plumtrips.com", universe: "STAFF", levelCode: "L6" });

    expect(res.status).toBe(200);
    const after = await User.findOne({ email: "newadmin@plumtrips.com" }).lean();
    expect((after as any)?.roles).toEqual(["ADMIN"]);
  });

  it("ALLOWS a platform SuperAdmin to grant L8 — the ceiling is for scoped callers only", async () => {
    caller = { isPlatformSuperAdmin: true };
    await makeTarget("promoted@plumtrips.com");
    const res = await request(makeApp())
      .post("/grant")
      .send({ email: "promoted@plumtrips.com", universe: "STAFF", levelCode: "L8" });

    expect(res.status).toBe(200);
    const after = await User.findOne({ email: "promoted@plumtrips.com" }).lean();
    expect((after as any)?.roles).toEqual(["SUPERADMIN"]);
  });
});

describe("level ceiling on the other two role-writing paths", () => {
  async function seedGrant(email: string, levelCode = "L2") {
    const u = await makeTarget(email);
    await UserPermission.create({
      userId: String(u._id),
      email,
      workspaceId: String(WS),
      universe: "STAFF",
      source: "manual",
      level: { code: levelCode, name: "Employee", designation: "" },
      status: "active",
      tier: 1,
      roleType: "EMPLOYEE",
      grantedBy: "test@plumtrips.com",
    } as any);
    return u;
  }

  it("REFUSES /apply-template with L8 from a non-superadmin", async () => {
    const u = await seedGrant("t1@plumtrips.com");
    const res = await request(makeApp()).post("/apply-template").send({ userId: String(u._id), levelCode: "L8" });
    expect(res.status).toBe(403);
    const after = await User.findOne({ _id: u._id }).lean();
    expect((after as any)?.roles).toEqual(["EMPLOYEE"]);
  });

  it("REFUSES /update with levelCode L8 from a non-superadmin", async () => {
    const u = await seedGrant("t2@plumtrips.com");
    const res = await request(makeApp()).patch("/update").send({ userId: String(u._id), levelCode: "L8" });
    expect(res.status).toBe(403);
    const after = await User.findOne({ _id: u._id }).lean();
    expect((after as any)?.roles).toEqual(["EMPLOYEE"]);
  });
});
