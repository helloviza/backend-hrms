// apps/backend/src/routes/billingAdmin.membershipScope.test.ts
//
// Company switcher Phase 3c — billing, customer admin, workspace config and
// notifications read the company from the session
// (docs/audits/multi-workspace-login-audit.md §7.1 Billing, Customer admin,
// Workspace and Notifications rows).
//
// The PROOF, end to end through real requireAuth (signed JWTs) and real
// requireWorkspace on in-memory Mongo:
//
//   1. One-company users: every changed route gives the same answer with a
//      legacy token (no mid) and a membership token (wsid/mid/mver) — and the
//      same answer as before this change: this file imports nothing new, so it
//      also runs unchanged against origin/main, where block 1 passes as is.
//   2. A user of TWO companies (fixture only: the User document describes
//      company A, a second WorkspaceMembership puts them in B) sees, in each
//      session, only that company's billing, invoices, users, workspace config
//      and notifications, with that company's role and flags. Second-company
//      tokens are tried with both claim shapes: what a switch would mint
//      (customerId = B) and stale User-document claims (customerId = A).
//   3. A Workspace Leader of B manages a member who joined B as a second
//      company — on that membership, never on their User document (company A).
//   4. A visa raised from the second company bills that company; the unlock
//      email reaches a second-company member with billing access there.
//   5. A suspended second-company membership is refused, not answered with
//      the User document's company.
// Blocks 2–5 fail on origin/main, by design.
//
// Tokens carry the User's global roles, as login mints them today. The
// notifications router is mounted on its own (its requireAuth only) — in the
// app it also sits behind requireBillingStaff, which is not what is tested.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  for (const [k, v] of Object.entries({
    MONGO_URI: "mongodb://127.0.0.1:1/unused",
    JWT_SECRET: "jwt-secret-for-tests",
    JWT_REFRESH_SECRET: "refresh-secret-for-tests",
    FRONTEND_ORIGIN: "http://localhost:5173",
    AWS_REGION: "ap-south-1",
    S3_BUCKET: "test-bucket",
    GEMINI_API_KEY: "test",
    OPENAI_API_KEY: "test-key",
  })) process.env[k] ||= v;
  process.env.TBO_ENV = "mock";
  process.env.DISABLE_EMAILS = "true";
  delete process.env.MEMBERSHIP_SESSION_DISABLED;
});

vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: vi.fn(async () => ({ messageId: "test" })) }));

const { clearMembershipCache } = await import("../middleware/requireWorkspace.js");
const { syncMembershipFromUser } = await import("../services/workspaceMembership.service.js");
const { createVisaWorkStartBooking } = await import("../services/visaBillingSync.js");
const { rewardsRecipients } = await import("../services/loyaltyUnlockEmail.js");
const { default: adminBillingRouter } = await import("./admin.billing.js");
const { workspaceRouter: invoicesWorkspaceRouter } = await import("./invoices.js");
const { default: customerUsersRouter } = await import("./customerUsers.js");
const { default: customersRouter } = await import("./customers.js");
const { default: workspaceRouter } = await import("./workspace.js");
const { default: notificationsRouter } = await import("./notifications.js");
const { default: usersRouter } = await import("./users.js");

const app = express();
app.use(express.json());
app.use("/api/admin/billing", adminBillingRouter);
app.use("/api/invoices/workspace", invoicesWorkspaceRouter);
app.use("/api/customer/users", customerUsersRouter);
app.use("/api/customers", customersRouter);
app.use("/api/v1/workspace", workspaceRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/users", usersRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const CUST_A = oid(); const WS_A = oid();
const CUST_B = oid(); const WS_B = oid();
const U = {
  wla: oid(), billA: oid(), reqA: oid(), staffA: oid(), // company A, one company each
  wlb: oid(), reqB: oid(),                              // company B, one company each
  dual: oid(),   // WL of A (User doc) + WL of B (second membership)
  mixed: oid(),  // WL of A (User doc) + plain requester in B (second membership)
  viewer: oid(), // plain customer in A (User doc) + SBT + billing in B (second membership)
  susp: oid(),   // WL of A (User doc) + a SUSPENDED membership of B
};
const MID = { dualB: oid(), mixedB: oid(), viewerB: oid(), suspB: oid() };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("billing-admin-membership-scope-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

const EMAIL: Record<keyof typeof U, string> = {
  wla: "wl@acme.test", billA: "bill@acme.test", reqA: "req@acme.test", staffA: "staff@acme.test",
  wlb: "wl@beta.test", reqB: "req@beta.test",
  dual: "dual@acme.test", mixed: "mixed@acme.test", viewer: "viewer@acme.test", susp: "susp@acme.test",
};

beforeEach(async () => {
  clearMembershipCache();
  await mongoose.connection.db!.dropDatabase();
  await mongoose.model("WorkspaceMembership").init();
  await col("customerworkspaces").insertMany([
    { _id: WS_A, customerId: String(CUST_A), name: "Acme", companyName: "Acme", status: "ACTIVE", tenantType: "CORPORATE",
      travelMode: "SBT", config: { travelFlow: "SBT", features: { sbtEnabled: true } } },
    { _id: WS_B, customerId: String(CUST_B), name: "Beta", companyName: "Beta", status: "ACTIVE", tenantType: "CORPORATE",
      travelMode: "SBT", config: { travelFlow: "SBT", features: { sbtEnabled: true } } },
  ] as any[]);
  await col("customers").insertMany([
    { _id: CUST_A, name: "Acme", workspaceId: WS_A },
    { _id: CUST_B, name: "Beta", workspaceId: WS_B },
  ] as any[]);
  const cm = (cust: mongoose.Types.ObjectId, email: string, role: string) => ({ customerId: String(cust), email, role, isActive: true });
  await col("customermembers").insertMany([
    cm(CUST_A, EMAIL.wla, "WORKSPACE_LEADER"), cm(CUST_A, EMAIL.billA, "REQUESTER"), cm(CUST_A, EMAIL.reqA, "REQUESTER"),
    cm(CUST_A, EMAIL.dual, "WORKSPACE_LEADER"), cm(CUST_A, EMAIL.mixed, "WORKSPACE_LEADER"),
    cm(CUST_A, EMAIL.viewer, "REQUESTER"), cm(CUST_A, EMAIL.susp, "WORKSPACE_LEADER"),
    cm(CUST_B, EMAIL.wlb, "WORKSPACE_LEADER"), cm(CUST_B, EMAIL.reqB, "REQUESTER"),
    cm(CUST_B, EMAIL.dual, "WORKSPACE_LEADER"), cm(CUST_B, EMAIL.mixed, "REQUESTER"),
    cm(CUST_B, EMAIL.viewer, "REQUESTER"), cm(CUST_B, EMAIL.susp, "WORKSPACE_LEADER"),
  ] as any[]);
  const at = new Date("2026-01-01T00:00:00Z");
  // workspaceId as customerUsers.ts writes it on create.
  const a = { customerId: String(CUST_A), businessId: String(CUST_A), workspaceId: WS_A, status: "ACTIVE", createdAt: at, updatedAt: at };
  const b = { customerId: String(CUST_B), businessId: String(CUST_B), workspaceId: WS_B, status: "ACTIVE", createdAt: at, updatedAt: at };
  const WL = ["WORKSPACE_LEADER"];
  await col("users").insertMany([
    { _id: U.wla, email: EMAIL.wla, name: "Asha Leader", roles: WL, ...a },
    { _id: U.billA, email: EMAIL.billA, name: "Bilal Bill", roles: ["CUSTOMER"], sbtEnabled: true, canViewBilling: true, sbtRole: "L2", ...a },
    { _id: U.reqA, email: EMAIL.reqA, name: "Ravi Rao", roles: ["CUSTOMER"], ...a },
    { _id: U.staffA, email: EMAIL.staffA, name: "Sam Staff", roles: ["ADMIN"], workspaceId: WS_A, status: "ACTIVE", createdAt: at, updatedAt: at },
    { _id: U.wlb, email: EMAIL.wlb, name: "Bala Leader", roles: WL, ...b },
    { _id: U.reqB, email: EMAIL.reqB, name: "Rita Beta", roles: ["CUSTOMER"], sbtEnabled: true, sbtRole: "L2", ...b },
    // These User documents describe company A only.
    { _id: U.dual, email: EMAIL.dual, name: "Dia Dual", roles: WL, ...a },
    { _id: U.mixed, email: EMAIL.mixed, name: "Mo Mixed", roles: WL, ...a },
    { _id: U.viewer, email: EMAIL.viewer, name: "Vik Viewer", roles: ["CUSTOMER"], sbtEnabled: false, canViewBilling: false, ...a },
    { _id: U.susp, email: EMAIL.susp, name: "Sue Susp", roles: WL, ...a },
  ] as any[]);
  // The live state: one default membership per user, written by Phase 1/2.
  for (const id of Object.values(U)) await syncMembershipFromUser(id, { source: "test" });
  // Fixture only: the second companies.
  const second = { kind: "CUSTOMER", workspaceId: WS_B, customerId: String(CUST_B), customerMemberId: null, levelCode: null,
    isDefault: false, tokenVersion: 0, createdAt: at, updatedAt: at };
  await col("workspacememberships").insertMany([
    { _id: MID.dualB, userId: U.dual, roles: WL, memberRole: "WORKSPACE_LEADER", status: "ACTIVE",
      flags: { sbtEnabled: false, canViewBilling: false, canRaiseRequest: true, bandNumber: 7 }, ...second },
    { _id: MID.mixedB, userId: U.mixed, roles: ["CUSTOMER"], memberRole: "REQUESTER", status: "ACTIVE",
      flags: { sbtEnabled: false, canViewBilling: false, canRaiseRequest: true }, ...second },
    { _id: MID.viewerB, userId: U.viewer, roles: ["CUSTOMER"], memberRole: "REQUESTER", status: "ACTIVE",
      flags: { sbtEnabled: true, sbtRole: "L2", canViewBilling: true, canRaiseRequest: false }, ...second },
    { _id: MID.suspB, userId: U.susp, roles: WL, memberRole: "WORKSPACE_LEADER", status: "SUSPENDED",
      flags: { sbtEnabled: false, canViewBilling: false }, ...second },
  ] as any[]);

  const bookedAt = new Date("2026-02-01T00:00:00Z");
  await col("sbtbookings").insertMany([
    { customerId: String(CUST_A), userId: U.billA, pnr: "PNR-A", status: "CONFIRMED", totalFare: 1000, bookedAt },
    { customerId: String(CUST_B), userId: U.reqB, pnr: "PNR-B", status: "CONFIRMED", totalFare: 2000, bookedAt },
  ] as any[]);
  await col("invoices").insertMany([
    { workspaceId: WS_A, invoiceNo: "INV-A", status: "ISSUED", generatedAt: bookedAt },
    { workspaceId: WS_B, invoiceNo: "INV-B", status: "ISSUED", generatedAt: bookedAt },
  ] as any[]);
  const note = (userId: mongoose.Types.ObjectId, ws: mongoose.Types.ObjectId, title: string) => ({
    workspaceId: String(ws), userId, type: "TASK_ASSIGNED", title, body: title, linkUrl: "/tasks", read: false, createdAt: bookedAt,
  });
  await col("notifications").insertMany([
    note(U.staffA, WS_A, "staff-A"),
    note(U.wla, WS_A, "wla-A"),
    note(U.dual, WS_A, "dual-A"), note(U.dual, WS_B, "dual-B"),
  ] as any[]);
});

/* ── tokens: what login mints today (global roles, the User's claims) ──
 * opts.ws: a second-company session (wsid/mid of that membership).
 * opts.claims: "switch" — customerId of that company, as a switch would mint
 * it; "user" — the User document's claims (stale for a second company). */
async function tokenFor(
  userId: mongoose.Types.ObjectId,
  opts: { legacy?: boolean; ws?: mongoose.Types.ObjectId; claims?: "switch" | "user" } = {},
) {
  const u: any = await col("users").findOne({ _id: userId });
  const m: any = await col("workspacememberships").findOne(opts.ws ? { userId, workspaceId: opts.ws } : { userId, isDefault: true });
  const customerId = opts.ws && opts.claims !== "user" ? String(m.customerId) : u.customerId;
  const claims: any = { sub: String(u._id), _id: String(u._id), id: String(u._id), email: u.email, name: u.name, roles: u.roles };
  if (customerId) Object.assign(claims, { customerId, businessId: customerId });
  if (u.workspaceId && !customerId) claims.workspaceId = String(u.workspaceId); // staff tokens
  if (!opts.legacy) Object.assign(claims, { wsid: String(m.workspaceId), mid: String(m._id), mver: Number(m.tokenVersion ?? 0) });
  return jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: "10m" });
}
const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
const patch = (path: string, token: string, body: any) => request(app).patch(path).set("Authorization", `Bearer ${token}`).send(body);
const BOTH_TOKENS = [["legacy token", true], ["membership token", false]] as const;
const SECOND_CLAIMS = [["switch-minted claims", "switch"], ["stale User-document claims", "user"]] as const;

async function billingPnrs(token: string) {
  const res = await get("/api/admin/billing/bookings", token);
  return res.status === 200 ? res.body.flights.map((f: any) => f.pnr).sort() : res.status;
}
async function invoiceNos(token: string) {
  const res = await get("/api/invoices/workspace/mine", token);
  return res.status === 200 ? res.body.invoices.map((i: any) => i.invoiceNo).sort() : res.status;
}
async function permissionEmails(token: string) {
  const res = await get("/api/customer/users/workspace/permissions", token);
  return res.status === 200 ? res.body.rows.map((r: any) => r.email).sort() : res.status;
}
async function memberEmails(token: string) {
  const res = await get("/api/customers/workspace-members", token);
  return res.status === 200 ? res.body.members.map((m: any) => m.email).sort() : res.status;
}
async function configCustomerId(token: string) {
  const res = await get("/api/v1/workspace/config", token);
  return res.status === 200 ? res.body.customerId : res.status;
}
async function noteTitles(token: string) {
  const res = await get("/api/notifications", token);
  return res.status === 200 ? res.body.notifications.map((n: any) => n.title).sort() : res.status;
}
const A_USERS = [EMAIL.billA, EMAIL.dual, EMAIL.mixed, EMAIL.reqA, EMAIL.susp, EMAIL.viewer, EMAIL.wla].sort();
const B_USERS = [EMAIL.reqB, EMAIL.wlb].sort();
const B_WITH_SECOND = [...B_USERS, EMAIL.dual, EMAIL.mixed, EMAIL.viewer].sort();

/* ═══════════════ 1. one-company users: unchanged ═══════════════ */
describe.each(BOTH_TOKENS)("one-company users, %s — same answers as before", (_label, legacy) => {
  it("billing: a Workspace Leader and a billing-enabled SBT user see their company; a plain user is refused", async () => {
    expect(await billingPnrs(await tokenFor(U.wla, { legacy }))).toEqual(["PNR-A"]);
    expect(await billingPnrs(await tokenFor(U.billA, { legacy }))).toEqual(["PNR-A"]);
    expect(await billingPnrs(await tokenFor(U.reqA, { legacy }))).toBe(403);
    expect(await billingPnrs(await tokenFor(U.wlb, { legacy }))).toEqual(["PNR-B"]);
  });

  it("invoices: leader and canViewBilling see their workspace's; a plain user is refused", async () => {
    expect(await invoiceNos(await tokenFor(U.wla, { legacy }))).toEqual(["INV-A"]);
    expect(await invoiceNos(await tokenFor(U.billA, { legacy }))).toEqual(["INV-A"]);
    expect(await invoiceNos(await tokenFor(U.reqA, { legacy }))).toBe(403);
  });

  it("customer admin: the permissions list is the leader's company; a non-leader is refused", async () => {
    expect(await permissionEmails(await tokenFor(U.wla, { legacy }))).toEqual(A_USERS);
    expect(await permissionEmails(await tokenFor(U.reqA, { legacy }))).toBe(403);
  });

  it("customer admin: a leader toggles a same-company user's flag on the User document", async () => {
    const res = await patch(`/api/customer/users/workspace/permissions/${U.billA}`, await tokenFor(U.wla, { legacy }),
      { permission: "canViewBilling", value: false });
    expect(res.status).toBe(200);
    expect(res.body.canViewBilling).toBe(false);
    expect((await col("users").findOne({ _id: U.billA }))!.canViewBilling).toBe(false);
  });

  it("customer admin: another company's user is refused", async () => {
    const res = await patch(`/api/customer/users/workspace/permissions/${U.reqB}`, await tokenFor(U.wla, { legacy }),
      { permission: "canViewBilling", value: true });
    expect(res.status).toBe(403);
  });

  it("customer admin: the users list, available bookers and workspace members are the company's", async () => {
    const list = await get("/api/customer/users", await tokenFor(U.wla, { legacy }));
    expect(list.status).toBe(200);
    expect(list.body.customerId).toBe(String(CUST_A));
    const bill = list.body.rows.find((r: any) => r.email === EMAIL.billA);
    expect(bill.sbtEnabled).toBe(true);
    const bookers = await get("/api/customer/users/workspace/available-bookers", await tokenFor(U.wla, { legacy }));
    expect(bookers.body.bookers.map((x: any) => x.email).sort()).toEqual(
      [EMAIL.billA, EMAIL.dual, EMAIL.mixed, EMAIL.susp, EMAIL.wla].sort());
    expect(await memberEmails(await tokenFor(U.reqA, { legacy }))).toEqual(A_USERS);
  });

  it("workspace: /config and /me are the company's", async () => {
    expect(await configCustomerId(await tokenFor(U.reqA, { legacy }))).toBe(String(CUST_A));
    const me = await get("/api/v1/workspace/me", await tokenFor(U.wlb, { legacy }));
    expect(me.body.customerId).toBe(String(CUST_B));
  });

  it("notifications: the token's workspaceId (staff), and none for a customer token without one", async () => {
    expect(await noteTitles(await tokenFor(U.staffA, { legacy }))).toEqual(["staff-A"]);
    expect(await noteTitles(await tokenFor(U.wla, { legacy }))).toEqual([]);
  });

  it("users.ts: a leader sets a same-company user's SBT on the User document; another company's is refused", async () => {
    const t = await tokenFor(U.wla, { legacy });
    const ok = await patch(`/api/users/admin/users/${U.reqA}/sbt`, t, { sbtEnabled: true, sbtBookingType: "flight" });
    expect(ok.status).toBe(200);
    expect((await col("users").findOne({ _id: U.reqA }))!.sbtEnabled).toBe(true);
    const no = await patch(`/api/users/admin/users/${U.reqB}/sbt`, t, { sbtEnabled: false });
    expect(no.status).toBe(403);
  });
});

describe("one-company users — services unchanged", () => {
  it("a visa raised by a one-company customer bills their company", async () => {
    expect(await billedCustomerFor(U.reqA, WS_A)).toBe(String(CUST_A));
  });
  it("unlock-email recipients of company A are its leaders and billing users", async () => {
    const got = await rewardsRecipients({ _id: WS_A, customerId: String(CUST_A) });
    expect(got.sort()).toEqual([EMAIL.billA, EMAIL.dual, EMAIL.mixed, EMAIL.susp, EMAIL.wla].sort());
  });
});

/* ═══════════════ 2. a two-company user sees only the session's company ═══════════════ */
describe("two-company user, company A session (User document's own company)", () => {
  it("billing, invoices, users, members, config and notifications are company A's", async () => {
    const t = await tokenFor(U.dual);
    expect(await billingPnrs(t)).toEqual(["PNR-A"]);
    expect(await invoiceNos(t)).toEqual(["INV-A"]);
    expect(await permissionEmails(t)).toEqual(A_USERS);
    expect(await memberEmails(t)).toEqual(A_USERS);
    expect(await configCustomerId(t)).toBe(String(CUST_A));
    expect(await noteTitles(t)).toEqual(["dual-A"]);
  });
});

describe.each(SECOND_CLAIMS)("two-company user, company B session, %s", (_label, claims) => {
  it("Workspace Leader of B: B's billing, invoices, users, members, config and notifications only", async () => {
    const t = await tokenFor(U.dual, { ws: WS_B, claims });
    expect(await billingPnrs(t)).toEqual(["PNR-B"]);
    expect(await invoiceNos(t)).toEqual(["INV-B"]);
    expect(await permissionEmails(t)).toEqual(B_WITH_SECOND);
    expect(await memberEmails(t)).toEqual(B_WITH_SECOND);
    expect(await configCustomerId(t)).toBe(String(CUST_B));
    const me = await get("/api/v1/workspace/me", t);
    expect(me.body.customerId).toBe(String(CUST_B));
    expect(me.body.memberRole).toBe("WORKSPACE_LEADER");
    expect(await noteTitles(t)).toEqual(["dual-B"]);
    const list = await get("/api/customer/users", t);
    expect(list.body.customerId).toBe(String(CUST_B));
  });

  it("leader in A but a plain requester in B: B's billing, invoices and admin screens are refused", async () => {
    const t = await tokenFor(U.mixed, { ws: WS_B, claims });
    expect(await billingPnrs(t)).toBe(403);
    expect(await invoiceNos(t)).toBe(403);
    expect(await permissionEmails(t)).toBe(403);
    const bookers = await get("/api/customer/users/workspace/available-bookers", t);
    expect(bookers.status).toBe(403);
    const sbt = await patch(`/api/users/admin/users/${U.reqB}/sbt`, t, { sbtEnabled: false });
    expect(sbt.status).toBe(403);
  });

  it("no billing in A but SBT + canViewBilling in B: B's billing and invoices (by the membership flags)", async () => {
    const t = await tokenFor(U.viewer, { ws: WS_B, claims });
    expect(await billingPnrs(t)).toEqual(["PNR-B"]);
    expect(await invoiceNos(t)).toEqual(["INV-B"]);
    // ...and still nothing in A.
    const own = await tokenFor(U.viewer);
    expect(await billingPnrs(own)).toBe(403);
    expect(await invoiceNos(own)).toBe(403);
  });
});

/* ═══════════════ 3. managing a second-company member ═══════════════ */
describe("a Workspace Leader of B manages a member who joined B as a second company", () => {
  it("permissions list shows the member with B's role and flags", async () => {
    const res = await get("/api/customer/users/workspace/permissions", await tokenFor(U.wlb));
    expect(res.status).toBe(200);
    const viewer = res.body.rows.find((r: any) => r.email === EMAIL.viewer);
    expect(viewer).toMatchObject({ sbtEnabled: true, sbtRole: "L2", canViewBilling: true, canRaiseRequest: false });
    const dual = res.body.rows.find((r: any) => r.email === EMAIL.dual);
    expect(dual.isWorkspaceLeader).toBe(true);
  });

  it("a flag change lands on the B membership; the User document (company A) is untouched", async () => {
    const res = await patch(`/api/customer/users/workspace/permissions/${U.viewer}`, await tokenFor(U.wlb),
      { permission: "canViewBilling", value: false });
    expect(res.status).toBe(200);
    expect(res.body.canViewBilling).toBe(false);
    expect((await col("workspacememberships").findOne({ _id: MID.viewerB }))!.flags.canViewBilling).toBe(false);
    const u: any = await col("users").findOne({ _id: U.viewer });
    expect(u.canViewBilling).toBe(false);
    expect(u.sbtEnabled).toBe(false);
    // The member's next B session reads the new flag.
    expect(await invoiceNos(await tokenFor(U.viewer, { ws: WS_B }))).toBe(403);
  });

  it("sbtEnabled on clears canRaiseRequest on the membership; booker must be of B", async () => {
    let res = await patch(`/api/customer/users/workspace/permissions/${U.mixed}`, await tokenFor(U.wlb),
      { permission: "sbtEnabled", value: true });
    expect(res.status).toBe(200);
    const m: any = await col("workspacememberships").findOne({ _id: MID.mixedB });
    expect(m.flags).toMatchObject({ sbtEnabled: true, canRaiseRequest: false });
    expect((await col("users").findOne({ _id: U.mixed }))!.sbtEnabled).toBeUndefined();
    // A booker of B (User doc) and a booker who joined B as a second company both qualify; A's does not.
    res = await patch(`/api/customer/users/workspace/permissions/${U.mixed}`, await tokenFor(U.wlb),
      { permission: "sbtAssignedBookerId", value: String(U.reqB) });
    expect(res.status).toBe(200);
    res = await patch(`/api/customer/users/workspace/permissions/${U.mixed}`, await tokenFor(U.wlb),
      { permission: "sbtAssignedBookerId", value: String(U.viewer) });
    expect(res.status).toBe(200);
    res = await patch(`/api/customer/users/workspace/permissions/${U.mixed}`, await tokenFor(U.wlb),
      { permission: "sbtAssignedBookerId", value: String(U.billA) });
    expect(res.status).toBe(400);
  });

  it("users.ts /admin/users/:id/sbt writes the B membership, not the User document", async () => {
    const res = await patch(`/api/users/admin/users/${U.mixed}/sbt`, await tokenFor(U.wlb), { sbtEnabled: true, sbtBookingType: "hotel" });
    expect(res.status).toBe(200);
    expect((await col("workspacememberships").findOne({ _id: MID.mixedB }))!.flags).toMatchObject({ sbtEnabled: true, sbtBookingType: "hotel" });
    expect((await col("users").findOne({ _id: U.mixed }))!.sbtEnabled).toBeUndefined();
  });

  it("the second-company member is a booker of B; available bookers lists them", async () => {
    const res = await get("/api/customer/users/workspace/available-bookers", await tokenFor(U.wlb));
    expect(res.body.bookers.map((x: any) => x.email).sort()).toEqual([EMAIL.dual, EMAIL.reqB, EMAIL.viewer, EMAIL.wlb].sort());
  });

  it("company A's leader manages the same person on the User document; the B membership is untouched", async () => {
    const res = await patch(`/api/customer/users/workspace/permissions/${U.viewer}`, await tokenFor(U.wla),
      { permission: "canViewBilling", value: true });
    expect(res.status).toBe(200);
    expect((await col("users").findOne({ _id: U.viewer }))!.canViewBilling).toBe(true);
    expect((await col("workspacememberships").findOne({ _id: MID.viewerB }))!.flags.canViewBilling).toBe(true);
  });
});

/* ═══════════════ 4. services bill / notify the active company ═══════════════ */
async function billedCustomerFor(raiser: mongoose.Types.ObjectId, ws: mongoose.Types.ObjectId): Promise<string | null> {
  const VisaRequest = mongoose.model("VisaRequest");
  const TravellerProfile = mongoose.model("TravellerProfile");
  const reqId = oid(); const travId = oid();
  await VisaRequest.collection.insertOne({
    _id: reqId, referenceNumber: `HV26-${String(reqId).slice(-6)}`, destinationIso2: "DE", purpose: "TOURIST",
    raisedByUserId: raiser, workspaceId: ws, travelDateFrom: new Date("2026-09-01"), travelDateTo: new Date("2026-09-10"),
  } as any);
  await TravellerProfile.collection.insertOne({ _id: travId, firstName: "Asha", lastName: "Rao", email: "asha@example.com" } as any);
  const application = {
    _id: oid(), requestId: reqId, travellerProfileId: travId, workspaceId: ws, status: "decision_received", outcome: "APPROVED",
    ruleSnapshot: { destinationName: "Germany", purpose: "TOURIST" }, submittedAt: new Date("2026-08-01"),
    indicativeCostSnapshot: { embassyFeeInr: 5000, vfsFeeInr: 1500, plumtripsServiceFeeInr: 1000, totalInr: 7680, displayMode: "ITEMISED" },
  };
  const result: any = await createVisaWorkStartBooking(application, oid());
  if (!result.manualBookingId) return null;
  const mb: any = await mongoose.model("ManualBooking").collection.findOne({ _id: new mongoose.Types.ObjectId(result.manualBookingId) });
  return String(mb.workspaceId);
}

describe("services follow the company a thing happened in", () => {
  it("a visa raised from the second company bills that company, not the User document's", async () => {
    expect(await billedCustomerFor(U.dual, WS_B)).toBe(String(CUST_B));
    expect(await billedCustomerFor(U.dual, WS_A)).toBe(String(CUST_A));
  });

  it("the unlock email reaches a second-company member with billing there, and not in their own company", async () => {
    const b = await rewardsRecipients({ _id: WS_B, customerId: String(CUST_B) });
    expect(b).toContain(EMAIL.viewer);
    expect(b).not.toContain(EMAIL.mixed); // a requester in B
    const a = await rewardsRecipients({ _id: WS_A, customerId: String(CUST_A) });
    expect(a).not.toContain(EMAIL.viewer);
  });
});

/* ═══════════════ 5. a suspended second-company membership ═══════════════ */
describe.each(SECOND_CLAIMS)("suspended second-company membership, %s", (_label, claims) => {
  it("is refused everywhere — never answered with the User document's company", async () => {
    const t = await tokenFor(U.susp, { ws: WS_B, claims });
    expect((await get("/api/admin/billing/bookings", t)).status).toBe(401);
    expect((await get("/api/invoices/workspace/mine", t)).status).toBe(401);
    expect((await get("/api/customer/users/workspace/permissions", t)).status).toBe(401);
    expect((await get("/api/customer/users", t)).status).toBe(400);
    expect((await get("/api/customers/workspace-members", t)).status).toBe(401);
    expect(await configCustomerId(t)).toBe(400);
    const me = await get("/api/v1/workspace/me", t);
    expect(me.body.customerId).toBeUndefined();
  });

  it("their own company still works", async () => {
    const t = await tokenFor(U.susp);
    expect(await billingPnrs(t)).toEqual(["PNR-A"]);
    expect(await permissionEmails(t)).toEqual(A_USERS);
  });
});
