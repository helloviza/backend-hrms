// apps/backend/src/scripts/report-sbt-users-without-workspace.test.ts
//
// Lists exactly the users Phase 3b's fail-open fix newly refuses (the pre-3b
// User.findOne({_id, workspaceId}) misses), leaves out users it already
// matched, leaders with only canRaiseRequest=false, and users requireWorkspace
// already refuses; lists second-company memberships; writes nothing; refuses
// without --expect-db or with the wrong one.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { reportSbtUsersWithoutWorkspace } = await import("./report-sbt-users-without-workspace.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const DB = "report-sbt-ws-test";

const CUST_A = oid();
const CUST_B = oid();
const CUST_GONE = oid();
const WS_A = oid();
const WS_B = oid();
const WS_OFF = oid();
const CUST_OFF = oid();
const U = {
  legacy: oid(), matched: oid(), leaderOnlyRaise: oid(), otherWs: oid(), noWs: oid(),
  offWs: oid(), leaderSbt: oid(), second: oid(), plain: oid(),
};

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
    { _id: WS_OFF, customerId: String(CUST_OFF), companyName: "Dormant", status: "SUSPENDED" },
  ]);
  await col("users").insertMany([
    // Legacy row, no workspaceId: the old lookup missed → newly refused everywhere.
    { _id: U.legacy, email: "legacy@acme.test", roles: ["CUSTOMER"], customerId: String(CUST_A), sbtEnabled: true, status: "ACTIVE" },
    // Row carries the session workspace: the flag already applied → not listed.
    { _id: U.matched, email: "matched@acme.test", roles: ["CUSTOMER"], customerId: String(CUST_A), workspaceId: WS_A, sbtEnabled: true },
    // Leader with canRaiseRequest=false: leaders still raise → nothing changes.
    { _id: U.leaderOnlyRaise, email: "lead@acme.test", roles: ["CUSTOMER", "WORKSPACE_LEADER"], customerId: String(CUST_A), canRaiseRequest: false },
    // Leader with sbtEnabled: leaders are exempt → nothing changes, not listed.
    { _id: U.leaderSbt, email: "leadsbt@acme.test", roles: ["CUSTOMER", "WORKSPACE_LEADER"], customerId: String(CUST_A), sbtEnabled: true },
    // workspaceId points elsewhere: miss → newly refused on raise only.
    { _id: U.otherWs, email: "other@acme.test", roles: ["CUSTOMER"], customerId: String(CUST_A), workspaceId: WS_B, canRaiseRequest: false },
    // No workspace resolves at all: requireWorkspace already 403s.
    { _id: U.noWs, email: "nows@gone.test", roles: ["CUSTOMER"], customerId: String(CUST_GONE), sbtEnabled: true },
    // Workspace not ACTIVE: requireWorkspace already 403s.
    { _id: U.offWs, email: "off@dormant.test", roles: ["CUSTOMER"], customerId: String(CUST_OFF), sbtEnabled: true },
    // Second company via membership.
    { _id: U.second, email: "two@acme.test", roles: ["CUSTOMER"], customerId: String(CUST_A), workspaceId: WS_A },
    // No flags at all.
    { _id: U.plain, email: "plain@acme.test", roles: ["CUSTOMER"], customerId: String(CUST_A) },
  ]);
  await col("workspacememberships").insertMany([
    { userId: U.second, workspaceId: WS_A, customerId: String(CUST_A), status: "ACTIVE", isDefault: true, roles: [], flags: {} },
    { userId: U.second, workspaceId: WS_B, customerId: String(CUST_B), status: "ACTIVE", isDefault: false, roles: [], flags: { sbtEnabled: true } },
    // Own-company membership with the flag: the User row decides, not listed here.
    { userId: U.matched, workspaceId: WS_A, customerId: String(CUST_A), status: "ACTIVE", isDefault: true, roles: [], flags: { sbtEnabled: true } },
  ]);
  await col("sessionlogs").insertOne({ userId: U.legacy, event: "LOGIN", success: true, createdAt: new Date("2026-10-20T10:00:00Z") });
});

const quiet = { log: () => {}, table: () => {} };

describe("report-sbt-users-without-workspace", () => {
  it("refuses without --expect-db or with the wrong one", async () => {
    await expect(reportSbtUsersWithoutWorkspace({ ...quiet })).rejects.toThrow(/expect-db/);
    await expect(reportSbtUsersWithoutWorkspace({ expectDb: "prod", ...quiet })).rejects.toThrow(/connected db/);
  });

  it("lists exactly the users the old lookup missed, with the surfaces now refused", async () => {
    const r = await reportSbtUsersWithoutWorkspace({ expectDb: DB, ...quiet });
    const by = Object.fromEntries(r.refused.map((x) => [x.email, x]));
    expect(Object.keys(by).sort()).toEqual(["legacy@acme.test", "other@acme.test"]);

    expect(by["legacy@acme.test"]).toMatchObject({
      refusedOn: "/requests/mine, /requests/inbox, raise",
      workspace: "Acme",
      workspaceId: String(WS_A),
      userWorkspaceId: "-",
      customerId: String(CUST_A),
      status: "ACTIVE",
      lastLogin: "2026-10-20",
    });
    expect(by["other@acme.test"]).toMatchObject({ refusedOn: "raise", userWorkspaceId: String(WS_B), workspaceId: String(WS_A) });
  });

  it("puts users requireWorkspace already refuses apart", async () => {
    const r = await reportSbtUsersWithoutWorkspace({ expectDb: DB, ...quiet });
    const reasons = Object.fromEntries(r.alreadyRefused.map((x) => [x.email, x.reason]));
    expect(reasons).toEqual({
      "nows@gone.test": "no workspace resolves (requireWorkspace 403)",
      "off@dormant.test": "workspace SUSPENDED (requireWorkspace 403)",
    });
  });

  it("lists second-company memberships with the flags, not own-company ones", async () => {
    const r = await reportSbtUsersWithoutWorkspace({ expectDb: DB, ...quiet });
    expect(r.secondCompany.map((x) => [x.email, x.workspace, x.refusedOn])).toEqual([
      ["two@acme.test", "Beta", "/requests/mine, /requests/inbox, raise"],
    ]);
  });

  it("writes nothing", async () => {
    const names = ["users", "customerworkspaces", "workspacememberships", "sessionlogs"];
    const snap = async () => {
      const out: Record<string, unknown> = { collections: (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name).sort() };
      for (const n of names) out[n] = await col(n).find().sort({ _id: 1 }).toArray();
      return JSON.stringify(out);
    };
    const before = await snap();
    await reportSbtUsersWithoutWorkspace({ expectDb: DB, ...quiet });
    expect(await snap()).toBe(before);
  });
});
