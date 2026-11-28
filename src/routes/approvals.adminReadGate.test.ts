// apps/backend/src/routes/approvals.adminReadGate.test.ts
//
// Behaviour of the approvals admin READ gate (requireApprovalsAdminRead →
// approvalsAdminReadDecision). Admission comes from adminQueueAccess only —
// the Access Console "Admin Queue" grant (live, status "active"), HOUSE
// sessions only, HOUSE ADMIN / SUPERADMIN oversight — or from the
// pre-existing Workspace Leader path (CustomerMember WORKSPACE_LEADER row).
// A role alone (MANAGER, HR, a customer's own ADMIN) never admits.
// The source-shape side is in staffCrossTenant.guard.test.ts.
//
// Real: requireApprovalsAdminRead, approvalsAdminReadDecision,
// adminQueueAccess, readCapability, in-memory Mongo.
// Stubbed: requireAuth (user from a header); the workspace comes from a header.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});

const { requireApprovalsAdminRead, approvalsAdminReadDecision, PLUMTRIPS_HOUSE_WORKSPACE_ID } = await import(
  "./approvals.security.js"
);

const HOUSE = PLUMTRIPS_HOUSE_WORKSPACE_ID;
const CUSTOMER_WS = String(new mongoose.Types.ObjectId());
const oid = () => String(new mongoose.Types.ObjectId());

const app = express();
app.use((req: any, _res, next) => {
  req.workspaceId = String(req.headers["x-test-ws"] || "");
  next();
});
app.get("/gate", requireApprovalsAdminRead as any, (req: any, res) =>
  res.json({ via: req.__adminQueue?.via ?? null, leader: req.__leaderCustomerIds ?? null }),
);

type Who = { sub: string; email: string; roles: string[] };
const who = (email: string, roles: string[]): Who => ({ sub: oid(), email, roles });
const hit = (u: Who, ws: string) =>
  request(app).get("/gate").set("x-test-user", JSON.stringify(u)).set("x-test-ws", ws);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const grant = (u: Who, access: string, status = "active") =>
  col("userpermissions").insertOne({
    userId: u.sub,
    status,
    modules: { adminQueue: { access, scope: "ALL" } },
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await col("userpermissions").deleteMany({});
  await col("customermembers").deleteMany({});
});

describe("approvals admin read gate — admission is the Admin Queue grant, not a role", () => {
  it("role-only HOUSE users without the grant are refused (MANAGER, HR, EMPLOYEE)", async () => {
    for (const roles of [["MANAGER"], ["HR"], ["EMPLOYEE"], ["OPS"]]) {
      const r = await hit(who(`${roles[0].toLowerCase()}@plumtrips.test`, roles), HOUSE);
      expect(r.status, roles[0]).toBe(403);
      expect(r.body.reason).toBe("NOT_ADMIN_OR_WORKSPACE_LEADER");
    }
  });

  it("a HOUSE user holding the Admin Queue grant (READ) is admitted via the permission", async () => {
    const u = who("agent@plumtrips.test", ["EMPLOYEE"]);
    await grant(u, "READ");
    const r = await hit(u, HOUSE);
    expect(r.status).toBe(200);
    expect(r.body.via).toBe("permission");
  });

  it("a suspended or NONE grant does not admit", async () => {
    const a = who("susp@plumtrips.test", ["EMPLOYEE"]);
    await grant(a, "FULL", "suspended");
    expect((await hit(a, HOUSE)).status).toBe(403);
    const b = who("none@plumtrips.test", ["EMPLOYEE"]);
    await grant(b, "NONE");
    expect((await hit(b, HOUSE)).status).toBe(403);
  });

  it("the grant only counts on a HOUSE session — the same holder on a customer workspace is refused", async () => {
    const u = who("agent2@plumtrips.test", ["EMPLOYEE"]);
    await grant(u, "FULL");
    expect((await hit(u, CUSTOMER_WS)).status).toBe(403);
  });

  it("a customer company's own ADMIN is refused (role on a non-HOUSE workspace)", async () => {
    expect((await hit(who("admin@cust.test", ["ADMIN"]), CUSTOMER_WS)).status).toBe(403);
  });

  it("oversight: HOUSE ADMIN and SUPERADMIN are admitted", async () => {
    const a = await hit(who("ops@plumtrips.test", ["ADMIN"]), HOUSE);
    expect(a.status).toBe(200);
    expect(a.body.via).toBe("admin-role");
    const s = await hit(who("root@plumtrips.test", ["SUPERADMIN"]), CUSTOMER_WS);
    expect(s.status).toBe(200);
    expect(s.body.via).toBe("superadmin");
  });

  it("a Workspace Leader is admitted for their own companies only (pre-existing path, unchanged)", async () => {
    const u = who("leader@cust.test", ["EMPLOYEE"]);
    await col("customermembers").insertOne({ email: u.email, role: "WORKSPACE_LEADER", customerId: "CUST-1", isActive: true });
    const r = await hit(u, CUSTOMER_WS);
    expect(r.status).toBe(200);
    expect(r.body.via).toBe("none");
    expect(r.body.leader).toEqual(["CUST-1"]);
  });

  it("the middleware answers exactly what approvalsAdminReadDecision decides", async () => {
    const cases: Array<[Who, string]> = [
      [who("m@plumtrips.test", ["MANAGER"]), HOUSE],
      [who("a@plumtrips.test", ["ADMIN"]), HOUSE],
      [who("c@cust.test", ["ADMIN"]), CUSTOMER_WS],
    ];
    const g = who("g@plumtrips.test", ["EMPLOYEE"]);
    await grant(g, "WRITE");
    cases.push([g, HOUSE]);
    for (const [u, ws] of cases) {
      const { ok } = await approvalsAdminReadDecision({ user: { ...u }, workspaceId: ws });
      expect((await hit(u, ws)).status, u.email).toBe(ok ? 200 : 403);
    }
  });
});
