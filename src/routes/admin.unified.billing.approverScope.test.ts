// apps/backend/src/routes/admin.unified.billing.approverScope.test.ts
//
// Travel Spend audit 2026-11, 3b: customer approvers carry roles
// [CUSTOMER, APPROVER]. resolveAccessScope only knew CUSTOMER_APPROVER / L2,
// so APPROVER fell through to OWN (userId = me). On manual-booking mirror
// rows userId is the staff booker, so approvers saw an empty dashboard.
// APPROVER now gets ORG scope like CUSTOMER_APPROVER; REQUESTER is unchanged.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspace = { tenantType: "CORPORATE" }; // what requireWorkspace resolves
    next();
  };
  return { requireAuth, default: requireAuth };
});

const { default: router, resolveAccessScope } = await import("./admin.unified.billing.js");

const oid = () => new mongoose.Types.ObjectId();
const CSTEP = "6a00000000000000000000c1";
const OTHER = "6a00000000000000000000c2";
const STAFF = oid();
const ANITA = oid();

const approver = { _id: String(ANITA), roles: ["CUSTOMER", "APPROVER"], hrmsAccessRole: "EMPLOYEE", customerId: CSTEP, email: "approver@client.test" };

describe("resolveAccessScope", () => {
  it("APPROVER → ORG on the customer's tenant", () => {
    expect(resolveAccessScope(approver)).toEqual({ matchFilter: { tenantId: CSTEP }, accessLevel: "ORG" });
  });
  it("APPROVER with only businessId → ORG on businessId", () => {
    const u = { _id: String(ANITA), roles: ["APPROVER"], businessId: OTHER };
    expect(resolveAccessScope(u)).toEqual({ matchFilter: { tenantId: OTHER }, accessLevel: "ORG" });
  });
  it("role spelling is normalised (approver, Approver)", () => {
    expect(resolveAccessScope({ ...approver, roles: ["customer", "approver"] }).accessLevel).toBe("ORG");
  });
  it("APPROVER without a tenant still falls back to OWN", () => {
    const s = resolveAccessScope({ _id: String(ANITA), roles: ["APPROVER"] });
    expect(s.accessLevel).toBe("OWN");
    expect(String(s.matchFilter.userId)).toBe(String(ANITA));
  });
  it("CUSTOMER_APPROVER is unchanged (ORG)", () => {
    expect(resolveAccessScope({ ...approver, roles: ["CUSTOMER_APPROVER"] }).accessLevel).toBe("ORG");
  });
  it("REQUESTER is unchanged (OWN)", () => {
    const s = resolveAccessScope({ ...approver, roles: ["CUSTOMER", "REQUESTER"] });
    expect(s.accessLevel).toBe("OWN");
    expect(String(s.matchFilter.userId)).toBe(String(ANITA));
  });
  it("SUPERADMIN stays GLOBAL", () => {
    expect(resolveAccessScope({ _id: String(STAFF), roles: ["SUPERADMIN", "APPROVER"] }).accessLevel).toBe("GLOBAL");
  });
});

describe("GET /summary as an APPROVER", () => {
  let mongod: MongoMemoryServer;
  const app = express();
  app.use("/api/admin/unified", router);
  const get = (u: any) => request(app).get("/api/admin/unified/summary?from=2026-11-01&to=2026-11-30").set("x-test-user", JSON.stringify(u));

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri("approver-scope-test"));
  }, 120_000);
  afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
  beforeEach(async () => {
    await mongoose.connection.db!.collection("travelbookings").deleteMany({});
    const row = (tenantId: string, amount: number) => ({
      tenantId, userId: STAFF, service: "FLIGHT", status: "CONFIRMED", amount, paymentMode: "OFFICIAL",
      source: "CONCIERGE", referenceModel: "ManualBooking", reference: oid(), travellerName: "Asha Rao",
      bookedAt: new Date("2026-11-10T00:00:00Z"),
    });
    await mongoose.connection.db!.collection("travelbookings").insertMany([row(CSTEP, 1000), row(CSTEP, 2500), row(OTHER, 99999)]);
  });

  it("sees the whole org (booked by staff), not other tenants", async () => {
    const r = await get(approver);
    expect(r.status).toBe(200);
    expect(r.body.totalSpend).toBe(3500);
    expect(r.body.confirmedTrips).toBe(2);
  });

  it("a REQUESTER still sees only rows with their own userId (none here)", async () => {
    const r = await get({ ...approver, roles: ["CUSTOMER", "REQUESTER"] });
    expect(r.status).toBe(200);
    expect(r.body.totalSpend).toBe(0);
  });
});
