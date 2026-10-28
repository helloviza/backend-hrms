// apps/backend/src/scripts/backfill-workspace-memberships.test.ts
//
// Dry run writes nothing (no rows, no collection, User/CustomerMember
// untouched) and reports sections A–F; --apply writes one default membership
// per resolvable user and is idempotent; refuses without --expect-db or with
// the wrong one.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { backfillWorkspaceMemberships } = await import("./backfill-workspace-memberships.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const DB = "backfill-memberships-test";

const HOUSE = oid();
const CUST_A = oid();
const CUST_B = oid();
const WS_A = oid();
const WS_B = oid();
const U = {
  staff: oid(),     // HOUSE employee
  leaderA: oid(),   // User.customerId = A, but User.workspaceId still HOUSE (promote staleness)
  memberB: oid(),   // no customerId on User; resolves through the CustomerMember row in B
  multi: oid(),     // active member rows in A and B
  orphan: oid(),    // REQUESTER with no link anywhere
  dupe: oid(),      // officialEmail collides with leaderA's email
  inactive: oid(),  // INACTIVE customer in A
  saas: oid(),      // SaaS signup WORKSPACE_ADMIN: no customer link, session from User.workspaceId
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // Same connect options as the script's main().
  await mongoose.connect(mongod.getUri(DB), { autoIndex: false, autoCreate: false });
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: "house-cust", companyName: "Plumtrips" },
    { _id: WS_A, customerId: String(CUST_A), companyName: "Alpha Pvt Ltd" },
    { _id: WS_B, customerId: String(CUST_B), companyName: "Beta Pvt Ltd" },
  ] as any[]);
  await col("customers").insertMany([
    { _id: CUST_A, legalName: "Alpha Private Limited" },
    { _id: CUST_B, legalName: "Beta Private Limited" },
  ] as any[]);
  await col("users").insertMany([
    { _id: U.staff, email: "ops@plumtrips.com", workspaceId: HOUSE, roles: ["EMPLOYEE"], passwordHash: "x" },
    { _id: U.leaderA, email: "lead@alpha.test", workspaceId: HOUSE, customerId: String(CUST_A), roles: ["CUSTOMER", "WORKSPACE_LEADER"], sbtEnabled: true, canViewBilling: true, passwordHash: "x" },
    { _id: U.memberB, email: "trav@beta.test", workspaceId: WS_B, roles: ["CUSTOMER", "REQUESTER"], passwordHash: "x" },
    { _id: U.multi, email: "group.cfo@holding.test", workspaceId: WS_A, customerId: String(CUST_A), roles: ["CUSTOMER", "WORKSPACE_LEADER"], passwordHash: "x" },
    { _id: U.orphan, email: "nobody@nowhere.test", workspaceId: oid(), roles: ["REQUESTER"], passwordHash: "x" },
    { _id: U.dupe, email: "other@alpha.test", officialEmail: "LEAD@alpha.test", workspaceId: WS_A, customerId: String(CUST_A), roles: ["CUSTOMER", "REQUESTER"], passwordHash: "x" },
    { _id: U.inactive, email: "gone@alpha.test", workspaceId: WS_A, customerId: String(CUST_A), roles: ["CUSTOMER", "REQUESTER"], status: "INACTIVE", passwordHash: "x" },
    { _id: U.saas, email: "founder@beta.test", workspaceId: WS_B, roles: ["WORKSPACE_ADMIN"], passwordHash: "x" },
  ] as any[]);
  await col("customermembers").insertMany([
    { customerId: String(CUST_A), email: "lead@alpha.test", role: "WORKSPACE_LEADER", isActive: true },
    { customerId: String(CUST_B), email: "trav@beta.test", role: "APPROVER", isActive: true },
    { customerId: String(CUST_A), email: "group.cfo@holding.test", role: "WORKSPACE_LEADER", isActive: true },
    { customerId: String(CUST_B), email: "group.cfo@holding.test", role: "REQUESTER", isActive: true },
    // inactive rows never count towards C
    { customerId: String(CUST_B), email: "lead@alpha.test", role: "REQUESTER", isActive: false },
  ] as any[]);
  await col("users").createIndex({ email: 1 }, { unique: true });
});

const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
};
const collectionNames = async () => (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name);
const snapshot = async () => ({
  users: await col("users").find().sort({ _id: 1 }).toArray(),
  members: await col("customermembers").find().sort({ _id: 1 }).toArray(),
  workspaces: await col("customerworkspaces").find().sort({ _id: 1 }).toArray(),
});

describe("backfill-workspace-memberships", () => {
  it("dry run: reports A–F and writes nothing", async () => {
    const before = await snapshot();
    const q = quiet();
    const r = await backfillWorkspaceMemberships({ expectDb: DB, log: q.log });

    expect(r.applied).toBe(false);
    expect(r.users).toBe(8);
    // A
    expect(r.byKind).toEqual({ STAFF: 1, CUSTOMER: 6 });
    expect([r.toCreate, r.toUpdate, r.toMove]).toEqual([7, 0, 0]);
    // B — leaderA's User.workspaceId still points at HOUSE
    expect(r.workspaceMismatch.map((m) => [m.email, m.resolvedWorkspaceId])).toEqual([["lead@alpha.test", String(WS_A)]]);
    // C — only the person with two ACTIVE rows
    expect(r.multiCompany).toEqual([
      {
        email: "group.cfo@holding.test",
        companies: expect.arrayContaining([
          { customerId: String(CUST_A), company: "Alpha Private Limited", role: "WORKSPACE_LEADER" },
          { customerId: String(CUST_B), company: "Beta Private Limited", role: "REQUESTER" },
        ]),
      },
    ]);
    // D
    expect(r.unresolved.map((u) => u.email)).toEqual(["nobody@nowhere.test"]);
    // E — cross-field collision, case-insensitive
    expect(r.duplicates).toEqual([
      { address: "lead@alpha.test", type: "cross-field", users: [{ userId: String(U.leaderA), field: "email" }, { userId: String(U.dupe), field: "officialEmail" }] },
    ]);
    // F
    expect(r.emailUnique).toBe(true);

    expect(await collectionNames()).not.toContain("workspacememberships");
    expect(await snapshot()).toEqual(before);
    const out = q.lines.join("\n");
    for (const s of ["A. COUNTS", "B. CUSTOMER", "C. EMAILS", "D. NO RESOLVABLE", "E. DUPLICATE", "F. users INDEXES", "dry run"]) expect(out).toContain(s);
  });

  it("--apply writes one default membership per resolvable user, never touching User/CustomerMember; a rerun is idempotent", async () => {
    const before = await snapshot();
    const r = await backfillWorkspaceMemberships({ expectDb: DB, apply: true, log: () => {} });
    expect(r.written).toEqual({ created: 7, updated: 0, moved: 0, failed: 0 });

    const rows = await col("workspacememberships").find().toArray();
    expect(rows).toHaveLength(7);
    expect(rows.every((m: any) => m.isDefault === true && m.tokenVersion === 0)).toBe(true);

    const byUser = new Map(rows.map((m: any) => [String(m.userId), m]));
    expect(byUser.get(String(U.staff))).toMatchObject({ kind: "STAFF", workspaceId: HOUSE, memberRole: null, status: "ACTIVE" });
    expect(byUser.get(String(U.leaderA))).toMatchObject({
      kind: "CUSTOMER", workspaceId: WS_A, customerId: String(CUST_A), memberRole: "WORKSPACE_LEADER",
      roles: ["CUSTOMER", "WORKSPACE_LEADER"], flags: expect.objectContaining({ sbtEnabled: true, canViewBilling: true }),
    });
    expect(byUser.get(String(U.memberB))).toMatchObject({ kind: "CUSTOMER", workspaceId: WS_B, memberRole: "APPROVER" });
    expect(byUser.get(String(U.memberB))!.customerMemberId).toBeTruthy();
    expect(byUser.get(String(U.inactive))).toMatchObject({ status: "SUSPENDED" });
    expect(byUser.get(String(U.saas))).toMatchObject({ kind: "CUSTOMER", workspaceId: WS_B, customerId: String(CUST_B), memberRole: null, roles: ["WORKSPACE_ADMIN"] });
    expect(byUser.has(String(U.orphan))).toBe(false);

    const idx = await col("workspacememberships").indexes();
    expect(idx.find((i: any) => i.key.userId === 1 && i.key.workspaceId === 1)?.unique).toBe(true);
    expect(idx.some((i: any) => i.key.workspaceId === 1 && i.key.status === 1)).toBe(true);
    expect(idx.some((i: any) => i.key.userId === 1 && i.key.isDefault === 1)).toBe(true);

    const again = await backfillWorkspaceMemberships({ expectDb: DB, apply: true, log: () => {} });
    expect(again.written).toEqual({ created: 0, updated: 7, moved: 0, failed: 0 });
    expect(await col("workspacememberships").countDocuments()).toBe(7);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses without --expect-db, or with the wrong one, before reading", async () => {
    await expect(backfillWorkspaceMemberships({ expectDb: undefined, log: () => {} })).rejects.toThrow(/expect-db/);
    await expect(backfillWorkspaceMemberships({ expectDb: "Plumtrips_hrms", apply: true, log: () => {} })).rejects.toThrow(/REFUSING/);
    expect(await collectionNames()).not.toContain("workspacememberships");
  });
});
