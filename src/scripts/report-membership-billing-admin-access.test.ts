// apps/backend/src/scripts/report-membership-billing-admin-access.test.ts
//
// Lists exactly the memberships Phase 3c reads differently (not the User
// document's company, any status — including a stale default) and the users
// with 2+ ACTIVE memberships; leaves out own-company memberships; counts each
// user once; writes nothing; refuses without --expect-db or with the wrong one.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { reportMembershipBillingAdminAccess } = await import("./report-membership-billing-admin-access.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const DB = "report-mb-billing-admin-test";

const CUST_A = oid(); const WS_A = oid();
const CUST_B = oid(); const WS_B = oid();
const U = { one: oid(), noCust: oid(), two: oid(), susp: oid(), stale: oid() };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    { _id: WS_A, customerId: String(CUST_A), companyName: "Acme", status: "ACTIVE" },
    { _id: WS_B, customerId: String(CUST_B), companyName: "Beta", status: "ACTIVE" },
  ]);
  const a = { customerId: String(CUST_A), workspaceId: WS_A, status: "ACTIVE" };
  await col("users").insertMany([
    { _id: U.one, email: "one@acme.test", roles: ["CUSTOMER"], ...a },
    { _id: U.noCust, email: "nocust@saas.test", roles: ["WORKSPACE_ADMIN"], workspaceId: WS_A, status: "ACTIVE" },
    { _id: U.two, email: "two@acme.test", roles: ["WORKSPACE_LEADER"], ...a },
    { _id: U.susp, email: "susp@acme.test", roles: ["WORKSPACE_LEADER"], ...a },
    // User.customerId moved to B; the default membership still says A.
    { _id: U.stale, email: "stale@beta.test", roles: ["CUSTOMER"], customerId: String(CUST_B), workspaceId: WS_B, status: "ACTIVE" },
  ]);
  const m = (userId: any, ws: any, cust: any, extra: any = {}) =>
    ({ userId, workspaceId: ws, customerId: String(cust), status: "ACTIVE", isDefault: true, roles: [], flags: {}, ...extra });
  await col("workspacememberships").insertMany([
    m(U.one, WS_A, CUST_A),
    { userId: U.noCust, workspaceId: WS_A, customerId: null, status: "ACTIVE", isDefault: true, roles: [], flags: {} },
    m(U.two, WS_A, CUST_A),
    m(U.two, WS_B, CUST_B, { isDefault: false, roles: ["WORKSPACE_LEADER"], flags: { canViewBilling: true } }),
    m(U.susp, WS_A, CUST_A),
    m(U.susp, WS_B, CUST_B, { isDefault: false, status: "SUSPENDED" }),
    m(U.stale, WS_A, CUST_A),
  ]);
});

const quiet = { log: () => {}, table: () => {} };

describe("report-membership-billing-admin-access", () => {
  it("refuses without --expect-db or with the wrong one", async () => {
    await expect(reportMembershipBillingAdminAccess({ ...quiet })).rejects.toThrow(/expect-db/);
    await expect(reportMembershipBillingAdminAccess({ expectDb: "prod", ...quiet })).rejects.toThrow(/connected db/);
  });

  it("lists every membership that is not the User document's company, and no own-company one", async () => {
    const r = await reportMembershipBillingAdminAccess({ expectDb: DB, ...quiet });
    expect(r.memberships).toBe(7);
    const rows = r.secondCompany.map((x) => [x.email, x.workspace, x.status, x.isDefault]).sort();
    expect(rows).toEqual([
      ["stale@beta.test", "Acme", "ACTIVE", true],
      ["susp@acme.test", "Beta", "SUSPENDED", false],
      ["two@acme.test", "Beta", "ACTIVE", false],
    ]);
    const two = r.secondCompany.find((x) => x.email === "two@acme.test")!;
    expect(two).toMatchObject({ roles: "WORKSPACE_LEADER", canViewBilling: true, freshLoginStamps: false });
    expect(two.changes).toMatch(/unlock email/);
    expect(r.secondCompany.find((x) => x.email === "susp@acme.test")!.changes).toMatch(/refused \(401\)/);
    // The stale default: login now resolves Beta, so a fresh login would not stamp it.
    expect(r.secondCompany.find((x) => x.email === "stale@beta.test")!.freshLoginStamps).toBe(false);
  });

  it("lists users with 2+ ACTIVE memberships and counts each user once", async () => {
    const r = await reportMembershipBillingAdminAccess({ expectDb: DB, ...quiet });
    expect(r.manyCompanies).toEqual([
      { userId: String(U.two), email: "two@acme.test", activeMemberships: 2, workspaces: "Acme | Beta" },
    ]);
    expect(r.usersChanged).toBe(3);
  });

  it("is 0 when every membership is the User document's company", async () => {
    await col("workspacememberships").deleteMany({ isDefault: false });
    await col("workspacememberships").deleteOne({ userId: U.stale });
    const lines: string[] = [];
    const r = await reportMembershipBillingAdminAccess({ expectDb: DB, log: (l) => lines.push(l), table: () => {} });
    expect(r.usersChanged).toBe(0);
    expect(lines.at(-1)).toBe("\nCOUNT users whose access changes: 0");
  });

  it("writes nothing", async () => {
    const names = ["users", "customerworkspaces", "workspacememberships"];
    const snap = async () => {
      const out: Record<string, unknown> = { collections: (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name).sort() };
      for (const n of names) out[n] = await col(n).find().sort({ _id: 1 }).toArray();
      return JSON.stringify(out);
    };
    const before = await snap();
    await reportMembershipBillingAdminAccess({ expectDb: DB, ...quiet });
    expect(await snap()).toBe(before);
  });
});
