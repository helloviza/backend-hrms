// apps/backend/src/routes/customers.accountTeam.test.ts
//
// Plumtrips staff (signed in to HOUSE) manage every customer, wherever the
// Customer row is stored: the Account Team editor (PATCH /:id/account-team)
// and the two staff lists (GET /admin/all, GET /). Customer users can't set an
// Account Team; tenant admins (requireAdmin admits TENANT_ADMIN/ADMIN on a
// customer workspace) stay inside their own workspace.
//
// Real: customers router, role guards, models, in-memory Mongo.
// Stubbed: requireAuth (user from a header), requireWorkspace (workspace from a header).
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
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: async (req: any, res: any, next: any) => {
    const { default: mg } = await import("mongoose");
    const id = String(req.headers["x-test-ws"] || "");
    const ws = await mg.connection.db!.collection("customerworkspaces").findOne({ _id: new mg.Types.ObjectId(id) });
    if (!ws) return res.status(403).json({ error: "no workspace" });
    req.workspace = ws;
    req.workspaceObjectId = ws._id;
    req.workspaceId = String(ws._id);
    next();
  },
}));

const { default: customersRouter } = await import("./customers.js");
const app = express();
app.use(express.json());
app.use("/api/customers", customersRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const ACME_WS = oid();
const OTHER_WS = oid();
const ACME = oid(); // Customer stored on its own workspace (not HOUSE)
const OTHER = oid();
const PRIYA = oid(); // HOUSE ops — the Account Manager

type Who = { roles: string[]; ws: any; customerId?: string };
const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: String(oid()), email: "x@test", roles: who.roles, ...(who.customerId ? { customerId: who.customerId } : {}) }))
    .set("x-test-ws", String(who.ws));
const HOUSE_ADMIN: Who = { roles: ["ADMIN"], ws: HOUSE };
const HOUSE_HR: Who = { roles: ["HR"], ws: HOUSE };
const CUSTOMER_USER: Who = { roles: ["CUSTOMER"], ws: ACME_WS, customerId: String(ACME) };
const TENANT_ADMIN: Who = { roles: ["ADMIN"], ws: OTHER_WS };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("customers-account-team-test"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE" },
    { _id: ACME_WS, customerId: String(ACME), name: "Acme", status: "ACTIVE" },
    { _id: OTHER_WS, customerId: String(OTHER), name: "Other", status: "ACTIVE" },
  ] as any[]);
  await col("customers").insertMany([
    { _id: ACME, name: "Acme Industries", workspaceId: ACME_WS, status: "ACTIVE" },
    { _id: OTHER, name: "Other Co", workspaceId: OTHER_WS, status: "ACTIVE" },
  ] as any[]);
  await col("users").insertOne({ _id: PRIYA, workspaceId: HOUSE, email: "priya@plumtrips.test", name: "Priya Sharma", roles: ["OPS"], status: "ACTIVE", passwordHash: "x" } as any);
});

describe("Account Team editor", () => {
  it("a HOUSE ADMIN sets the Account Manager on a customer stored on its own workspace", async () => {
    const r = await as(request(app).patch(`/api/customers/${ACME}/account-team`), HOUSE_ADMIN).send({ accountManager: { userId: String(PRIYA) } });
    expect(r.status).toBe(200);
    const c: any = await col("customers").findOne({ _id: ACME });
    expect(String(c.accountTeam.accountManager.userId)).toBe(String(PRIYA));
    expect(c.accountTeam.accountManager.email).toBe("priya@plumtrips.test");
  });

  it("a customer user can't; a tenant admin can't reach another customer", async () => {
    expect((await as(request(app).patch(`/api/customers/${ACME}/account-team`), CUSTOMER_USER).send({ accountManager: { userId: String(PRIYA) } })).status).toBe(403);
    expect((await as(request(app).patch(`/api/customers/${ACME}/account-team`), TENANT_ADMIN).send({ accountManager: { userId: String(PRIYA) } })).status).toBe(404);
    const c: any = await col("customers").findOne({ _id: ACME });
    expect(c.accountTeam).toBeUndefined();
  });
});

describe("staff customer lists", () => {
  it("HOUSE staff see every customer; a tenant admin sees only their own workspace's", async () => {
    const all = await as(request(app).get("/api/customers/admin/all"), HOUSE_ADMIN);
    expect(all.status).toBe(200);
    expect(all.body.items.map((i: any) => i.name).sort()).toEqual(["Acme Industries", "Other Co"]);

    const list = await as(request(app).get("/api/customers"), HOUSE_HR);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.name).sort()).toEqual(["Acme Industries", "Other Co"]);

    const tenant = await as(request(app).get("/api/customers/admin/all"), TENANT_ADMIN);
    expect(tenant.body.items.map((i: any) => i.name)).toEqual(["Other Co"]);
    const tenantList = await as(request(app).get("/api/customers"), TENANT_ADMIN);
    expect(tenantList.body.items.map((i: any) => i.name)).toEqual(["Other Co"]);

    expect((await as(request(app).get("/api/customers/admin/all"), CUSTOMER_USER)).status).toBe(403);
  });
});
