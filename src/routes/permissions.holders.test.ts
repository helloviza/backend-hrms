// GET /api/permissions/holders/:moduleKey — the grant-path visibility half of
// Unit 2B step 2 (2026-08-12).
//
// visaScreening is granted PER-USER, not by level template, so no template
// answers "who are our screening officers?". The ruling accepted that cost on
// condition the holders be made visible. This file proves the list actually
// reflects the grants — including after a revoke, which is the case that
// matters for off-boarding.
//
// Real database on purpose: the whole endpoint is a query over
// modules.<key>.access, so "what does the query actually match" IS the
// behaviour. An in-memory fake would assert nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireSuperAdminOrTenantAdmin.js", () => ({
  requireSuperAdminOrTenantAdmin: (_req: any, _res: any, next: any) => next(),
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

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const TENANT_WS = new mongoose.Types.ObjectId();

/** Caller identity, swapped per test. Defaults to platform SuperAdmin. */
let caller: { isPlatformSuperAdmin: boolean; workspaceObjectId?: mongoose.Types.ObjectId };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(new mongoose.Types.ObjectId()), roles: caller.isPlatformSuperAdmin ? ["SUPERADMIN"] : ["ADMIN"] };
    req.isPlatformSuperAdmin = caller.isPlatformSuperAdmin;
    req.workspaceObjectId = caller.workspaceObjectId ?? TENANT_WS;
    next();
  });
  app.use("/", router);
  return app;
}

async function makeHolder(opts: {
  visaScreening?: string;
  visaApplication?: string;
  status?: string;
  workspaceId?: mongoose.Types.ObjectId;
  universe?: string;
  name?: string;
}) {
  const workspaceId = opts.workspaceId ?? TENANT_WS;
  const u = await User.create({
    name: opts.name ?? "Screening Officer",
    email: `sc-${new mongoose.Types.ObjectId()}@plumtrips.com`,
    passwordHash: "x",
    workspaceId,
    roles: ["ADMIN"],
  });
  await UserPermission.create({
    userId: String(u._id),
    email: u.email,
    workspaceId: String(workspaceId),
    universe: opts.universe ?? "STAFF",
    source: "manual",
    status: opts.status ?? "active",
    grantedBy: new mongoose.Types.ObjectId(),
    level: { code: "L6", name: "Admin", designation: "Admin" },
    modules: {
      visaApplication: { access: opts.visaApplication ?? "NONE", scope: "ALL" },
      visaScreening: { access: opts.visaScreening ?? "NONE", scope: "ALL" },
    },
  } as any);
  return u;
}

beforeEach(async () => {
  caller = { isPlatformSuperAdmin: true };
  await Promise.all([User.deleteMany({}), UserPermission.deleteMany({})]);
});

describe("GET /holders/:moduleKey", () => {
  it("returns an EMPTY list while nobody holds visaScreening — the honest answer today", async () => {
    await makeHolder({ visaApplication: "FULL" }); // a concierge, not a screener
    const res = await request(makeApp()).get("/holders/visaScreening");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.holders).toEqual([]);
  });

  it("lists a granted holder with the details off-boarding needs", async () => {
    const u = await makeHolder({ visaScreening: "WRITE", name: "Devendra" });
    const res = await request(makeApp()).get("/holders/visaScreening");

    expect(res.body.total).toBe(1);
    expect(res.body.holders[0]).toMatchObject({
      userId: String(u._id),
      email: u.email,
      name: "Devendra",
      levelCode: "L6",
      access: "WRITE",
    });
  });

  it("drops the holder once the grant is revoked back to NONE", async () => {
    const u = await makeHolder({ visaScreening: "WRITE" });
    expect((await request(makeApp()).get("/holders/visaScreening")).body.total).toBe(1);

    await UserPermission.updateOne(
      { userId: String(u._id) },
      { $set: { "modules.visaScreening": { access: "NONE", scope: "NONE" } } },
    );

    const res = await request(makeApp()).get("/holders/visaScreening");
    expect(res.body.total).toBe(0);
  });

  it("counts FULL as holding it — minAccess is an ordering, not an exact match", async () => {
    await makeHolder({ visaScreening: "FULL" });
    const res = await request(makeApp()).get("/holders/visaScreening");
    expect(res.body.total).toBe(1);
    expect(res.body.holders[0].access).toBe("FULL");
  });

  it("excludes READ at the default minAccess, and includes it when asked", async () => {
    await makeHolder({ visaScreening: "READ" });
    expect((await request(makeApp()).get("/holders/visaScreening")).body.total).toBe(0);
    expect((await request(makeApp()).get("/holders/visaScreening?minAccess=READ")).body.total).toBe(1);
  });

  it("ignores inactive permission records — a suspended account is not a screener", async () => {
    await makeHolder({ visaScreening: "WRITE", status: "revoked" });
    expect((await request(makeApp()).get("/holders/visaScreening")).body.total).toBe(0);
  });

  it("REJECTS an unknown module key instead of querying an arbitrary path", async () => {
    // The key is interpolated into the query, so this is the injection guard.
    const res = await request(makeApp()).get("/holders/__proto__");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Unknown module key/);
  });

  it("REJECTS an invalid minAccess", async () => {
    const res = await request(makeApp()).get("/holders/visaScreening?minAccess=SUPER");
    expect(res.status).toBe(400);
  });

  it("works for any per-user capability, not just visaScreening", async () => {
    await makeHolder({ visaApplication: "WRITE" });
    const res = await request(makeApp()).get("/holders/visaApplication");
    expect(res.body.total).toBe(1);
  });

  describe("tenant-admin scoping", () => {
    it("a tenant admin sees only holders inside their own workspace", async () => {
      const otherWs = new mongoose.Types.ObjectId();
      await makeHolder({ visaScreening: "WRITE", name: "Ours" });
      await makeHolder({ visaScreening: "WRITE", name: "Theirs", workspaceId: otherWs });

      caller = { isPlatformSuperAdmin: false, workspaceObjectId: TENANT_WS };
      const res = await request(makeApp()).get("/holders/visaScreening");

      expect(res.body.total).toBe(1);
      expect(res.body.holders[0].name).toBe("Ours");
    });

    it("a platform SuperAdmin sees holders across workspaces — screeners are our own staff", async () => {
      await makeHolder({ visaScreening: "WRITE" });
      await makeHolder({ visaScreening: "WRITE", workspaceId: new mongoose.Types.ObjectId() });

      caller = { isPlatformSuperAdmin: true };
      expect((await request(makeApp()).get("/holders/visaScreening")).body.total).toBe(2);
    });
  });
});
