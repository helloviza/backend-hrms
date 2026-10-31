// apps/backend/src/routes/auth.companySwitcher.test.ts
//
// Company switcher Phase 4 — second membership, login picker, switch
// (docs/audits/multi-workspace-login-audit.md §8.2, §6, §5, §4).
//
// End to end through the real auth router, requireAuth, requireWorkspace and
// the Phase 3 routers on in-memory Mongo:
//
//   1. Flag off (MULTI_WORKSPACE_LOGIN unset), or one membership: login,
//      refresh and /me mint exactly the claims they mint without the flag;
//      the new endpoints answer 404.
//   2. Two memberships, flag on: login answers needsPick with a pick token
//      that is neither an access nor a refresh token; select-workspace mints
//      the picked company (own company: the very claims plain login mints).
//   3. switch-workspace issues tokens for the target only, and refuses a
//      non-member, a suspended membership, an inactive workspace, SuperAdmin,
//      demo and HOUSE staff.
//   4. After a switch every Phase 3 route answers with the target company's
//      data, and refresh keeps the session there.
//   5. Add-to-company creates exactly one membership + one roster row, sends
//      the "added" email with no reset link and never touches the password;
//      suspend ends that company's sessions.
//   6. POST /password/admin-set is refused for a person of two companies.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
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
  delete process.env.MULTI_WORKSPACE_LOGIN;
});

const sendMail = vi.hoisted(() => vi.fn(async () => ({ messageId: "test" })));
vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail }));

const { default: authRouter } = await import("./auth.js");
const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace, clearMembershipCache } = await import("../middleware/requireWorkspace.js");
const { requireHouse } = await import("../middleware/requireHouse.js");
const { syncMembershipFromUser } = await import("../services/workspaceMembership.service.js");
const { signPickToken } = await import("../services/workspaceSwitch.service.js");
const { default: adminMembershipsRouter } = await import("./admin.workspaceMemberships.js");
const { default: passwordRouter } = await import("./password.js");
const { default: adminBillingRouter } = await import("./admin.billing.js");
const { workspaceRouter: invoicesWorkspaceRouter } = await import("./invoices.js");
const { default: customerUsersRouter } = await import("./customerUsers.js");
const { default: customersRouter } = await import("./customers.js");
const { default: workspaceRouter } = await import("./workspace.js");
const { default: notificationsRouter } = await import("./notifications.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/admin/workspace-memberships", requireAuth, requireWorkspace, requireHouse, adminMembershipsRouter);
app.use("/api/password", passwordRouter);
app.use("/api/admin/billing", adminBillingRouter);
app.use("/api/invoices/workspace", invoicesWorkspaceRouter);
app.use("/api/customer/users", customerUsersRouter);
app.use("/api/customers", customersRouter);
app.use("/api/v1/workspace", workspaceRouter);
app.use("/api/notifications", notificationsRouter);
app.get("/api/probe", requireAuth, requireWorkspace, (req: any, res) => res.json({ workspaceId: String(req.workspaceId ?? "") }));
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const PW = "Test-pass-123";
const HASH = bcrypt.hashSync(PW, 4);

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const CUST_A = oid(); const WS_A = oid();
const CUST_B = oid(); const WS_B = oid();
const CUST_C = oid(); const WS_C = oid(); // SUSPENDED workspace

const U = {
  dual: oid(),    // WL of A (User doc) + WL of B (second membership)
  mixed: oid(),   // WL of A + plain requester in B
  solo: oid(),    // requester in A only
  susp: oid(),    // WL of A + a SUSPENDED membership of B
  deadws: oid(),  // A + a membership of the suspended workspace C
  staff: oid(),   // HOUSE staff with a (fixture) customer membership of B
  sa: oid(),      // SuperAdmin with a (fixture) customer membership of B
  demo: oid(),    // demo user with a (fixture) membership of B
  admin: oid(),   // HOUSE ADMIN — calls the add-to-company route
  adminA: oid(),  // ADMIN of company A — calls admin-set
  addme: oid(),   // requester in A, to be added to B
  nohome: oid(),  // customer login with no home company
  wlb: oid(),     // WL of B, one company
};
const EMAIL: Record<keyof typeof U, string> = {
  dual: "dual@acme.test", mixed: "mixed@acme.test", solo: "solo@acme.test", susp: "susp@acme.test",
  deadws: "deadws@acme.test", staff: "ops.person@plumtrips.com", sa: "root.person@plumtrips.com",
  demo: "demo@acme.test", admin: "admin.person@plumtrips.com", adminA: "it@acme.test", addme: "addme@acme.test",
  nohome: "nohome@acme.test", wlb: "wl@beta.test",
};
const MID = { dualB: oid(), mixedB: oid(), suspB: oid(), deadC: oid(), staffB: oid(), saB: oid(), demoB: oid() };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("company-switcher-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

const flagOn = () => { process.env.MULTI_WORKSPACE_LOGIN = "true"; };
const flagOff = () => { delete process.env.MULTI_WORKSPACE_LOGIN; };
afterEach(() => { flagOff(); delete process.env.MEMBERSHIP_SESSION_DISABLED; });

beforeEach(async () => {
  flagOff();
  sendMail.mockClear();
  clearMembershipCache();
  await mongoose.connection.db!.dropDatabase();
  await mongoose.model("WorkspaceMembership").init();
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: String(HOUSE), companyName: "Plumtrips", status: "ACTIVE", tenantType: "HOUSE" },
    { _id: WS_A, customerId: String(CUST_A), name: "Acme", companyName: "Acme", status: "ACTIVE", tenantType: "CORPORATE",
      travelMode: "SBT", config: { travelFlow: "SBT", features: { sbtEnabled: true } } },
    { _id: WS_B, customerId: String(CUST_B), name: "Beta", companyName: "Beta", status: "ACTIVE", tenantType: "CORPORATE",
      travelMode: "SBT", config: { travelFlow: "SBT", features: { sbtEnabled: true } } },
    { _id: WS_C, customerId: String(CUST_C), name: "Gamma", companyName: "Gamma", status: "SUSPENDED", tenantType: "CORPORATE" },
  ] as any[]);
  await col("customers").insertMany([
    { _id: CUST_A, name: "Acme", workspaceId: WS_A },
    { _id: CUST_B, name: "Beta", workspaceId: WS_B },
    { _id: CUST_C, name: "Gamma", workspaceId: WS_C },
  ] as any[]);
  const cm = (cust: mongoose.Types.ObjectId, email: string, role: string) => ({ customerId: String(cust), email, role, isActive: true });
  await col("customermembers").insertMany([
    cm(CUST_A, EMAIL.dual, "WORKSPACE_LEADER"), cm(CUST_A, EMAIL.mixed, "WORKSPACE_LEADER"), cm(CUST_A, EMAIL.solo, "REQUESTER"),
    cm(CUST_A, EMAIL.susp, "WORKSPACE_LEADER"), cm(CUST_A, EMAIL.deadws, "REQUESTER"), cm(CUST_A, EMAIL.demo, "WORKSPACE_LEADER"),
    cm(CUST_A, EMAIL.addme, "REQUESTER"),
    cm(CUST_B, EMAIL.wlb, "WORKSPACE_LEADER"), cm(CUST_B, EMAIL.dual, "WORKSPACE_LEADER"), cm(CUST_B, EMAIL.mixed, "REQUESTER"),
    cm(CUST_B, EMAIL.susp, "WORKSPACE_LEADER"),
  ] as any[]);
  const at = new Date("2026-01-01T00:00:00Z");
  const base = { status: "ACTIVE", passwordHash: HASH, createdAt: at, updatedAt: at };
  const a = { customerId: String(CUST_A), businessId: String(CUST_A), workspaceId: WS_A, ...base };
  const b = { customerId: String(CUST_B), businessId: String(CUST_B), workspaceId: WS_B, ...base };
  const WL = ["WORKSPACE_LEADER"];
  await col("users").insertMany([
    { _id: U.dual, email: EMAIL.dual, name: "Dia Dual", roles: WL, ...a },
    { _id: U.mixed, email: EMAIL.mixed, name: "Mo Mixed", roles: WL, ...a },
    { _id: U.solo, email: EMAIL.solo, name: "Sol Solo", roles: ["REQUESTER"], ...a },
    { _id: U.susp, email: EMAIL.susp, name: "Sue Susp", roles: WL, ...a },
    { _id: U.deadws, email: EMAIL.deadws, name: "Dee Dead", roles: ["REQUESTER"], ...a },
    { _id: U.demo, email: EMAIL.demo, name: "Demo Lead", roles: WL, isDemoUser: true, ...a },
    { _id: U.addme, email: EMAIL.addme, name: "Ada Addme", roles: ["REQUESTER"], ...a },
    { _id: U.nohome, email: EMAIL.nohome, name: "No Home", roles: ["CUSTOMER"], ...base },
    { _id: U.wlb, email: EMAIL.wlb, name: "Bala Leader", roles: WL, ...b },
    { _id: U.adminA, email: EMAIL.adminA, name: "Ivy IT", roles: ["ADMIN"], workspaceId: WS_A, ...base },
    { _id: U.staff, email: EMAIL.staff, name: "Ops Person", roles: ["EMPLOYEE"], workspaceId: HOUSE, ...base },
    { _id: U.admin, email: EMAIL.admin, name: "Adm Person", roles: ["ADMIN"], workspaceId: HOUSE, ...base },
    { _id: U.sa, email: EMAIL.sa, name: "Root", roles: ["SUPERADMIN"], hrmsAccessRole: "SuperAdmin", workspaceId: HOUSE, ...base },
  ] as any[]);
  await col("userpermissions").insertMany(
    (["staff", "admin", "adminA"] as const).map((k) => ({
      userId: String(U[k]), email: EMAIL[k], workspaceId: String(k === "adminA" ? WS_A : HOUSE), universe: "STAFF", status: "active",
    })) as any[],
  );
  // The live state: one default membership per user (Phase 1/2).
  for (const id of Object.values(U)) await syncMembershipFromUser(id, { source: "test" });
  // Fixture: the second companies.
  const second = (_id: any, userId: any, ws: any, cust: any, roles: string[], memberRole: string, status = "ACTIVE") => ({
    _id, userId, workspaceId: ws, customerId: String(cust), kind: "CUSTOMER", roles, memberRole, customerMemberId: null,
    levelCode: null, flags: { sbtEnabled: false, canViewBilling: false, canRaiseRequest: true }, status, isDefault: false,
    tokenVersion: 0, createdAt: at, updatedAt: at,
  });
  await col("workspacememberships").insertMany([
    second(MID.dualB, U.dual, WS_B, CUST_B, WL, "WORKSPACE_LEADER"),
    second(MID.mixedB, U.mixed, WS_B, CUST_B, ["CUSTOMER"], "REQUESTER"),
    second(MID.suspB, U.susp, WS_B, CUST_B, WL, "WORKSPACE_LEADER", "SUSPENDED"),
    second(MID.deadC, U.deadws, WS_C, CUST_C, ["CUSTOMER"], "REQUESTER"),
    second(MID.staffB, U.staff, WS_B, CUST_B, WL, "WORKSPACE_LEADER"),
    second(MID.saB, U.sa, WS_B, CUST_B, WL, "WORKSPACE_LEADER"),
    second(MID.demoB, U.demo, WS_B, CUST_B, WL, "WORKSPACE_LEADER"),
  ] as any[]);

  const bookedAt = new Date("2026-02-01T00:00:00Z");
  await col("sbtbookings").insertMany([
    { customerId: String(CUST_A), userId: U.dual, pnr: "PNR-A", status: "CONFIRMED", totalFare: 1000, bookedAt },
    { customerId: String(CUST_B), userId: U.wlb, pnr: "PNR-B", status: "CONFIRMED", totalFare: 2000, bookedAt },
  ] as any[]);
  await col("invoices").insertMany([
    { workspaceId: WS_A, invoiceNo: "INV-A", status: "ISSUED", generatedAt: bookedAt },
    { workspaceId: WS_B, invoiceNo: "INV-B", status: "ISSUED", generatedAt: bookedAt },
  ] as any[]);
  const note = (userId: any, ws: any, title: string) => ({
    workspaceId: String(ws), userId, type: "TASK_ASSIGNED", title, body: title, linkUrl: "/tasks", read: false, createdAt: bookedAt,
  });
  await col("notifications").insertMany([note(U.dual, WS_A, "dual-A"), note(U.dual, WS_B, "dual-B")] as any[]);
});

/* ── helpers ── */
const VOLATILE = ["iat", "exp"];
const decode = (t: string) => jwt.decode(t) as any;
const strip = (c: any, drop = VOLATILE) => Object.fromEntries(Object.entries(c).filter(([k]) => !drop.includes(k)));
const refreshCookie = (res: any) =>
  ((res.headers["set-cookie"] as string[] | undefined) ?? []).find((c) => /^refreshToken=[^;]/.test(c))?.split(";")[0].slice("refreshToken=".length);
const login = (email: string) => request(app).post("/api/auth/login").send({ email, password: PW });
const select = (pickToken: string, workspaceId: any) => request(app).post("/api/auth/select-workspace").send({ pickToken, workspaceId: String(workspaceId) });
const sw = (access: string, workspaceId: any) =>
  request(app).post("/api/auth/switch-workspace").set("Authorization", `Bearer ${access}`).send({ workspaceId: String(workspaceId) });
const myCompanies = (access: string) => request(app).get("/api/auth/my-companies").set("Authorization", `Bearer ${access}`);
const refreshWith = (token: string) => request(app).post("/api/auth/refresh").set("Cookie", [`refreshToken=${token}`]);
const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
const me = (access: string) => get("/api/auth/me", access);

/** A session for `email` in its own company, flag off (today's login). */
async function plainLogin(email: string) {
  flagOff();
  const l = await login(email);
  expect(l.status, JSON.stringify(l.body)).toBe(200);
  expect(l.body.needsPick).toBeUndefined();
  return l;
}
/** Flag on: pick → session in `ws`. The pick token is what /login hands a
 *  two-company person (see "login picker"); minted directly here so the
 *  per-email login limiter (10 / 15 min) is not the thing under test. */
async function pickedSession(email: string, ws: any) {
  flagOn();
  const user: any = await col("users").findOne({ email });
  const s = await select(signPickToken(user), ws);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return s;
}
/** A signed token like requireAuth expects, for callers that never log in here. */
function signed(claims: any) {
  return jwt.sign({ id: claims.sub, _id: claims.sub, ...claims }, process.env.JWT_SECRET!, { expiresIn: "10m" });
}

async function billingPnrs(t: string) {
  const res = await get("/api/admin/billing/bookings", t);
  return res.status === 200 ? res.body.flights.map((f: any) => f.pnr).sort() : res.status;
}
async function invoiceNos(t: string) {
  const res = await get("/api/invoices/workspace/mine", t);
  return res.status === 200 ? res.body.invoices.map((i: any) => i.invoiceNo).sort() : res.status;
}
async function memberEmails(t: string) {
  const res = await get("/api/customers/workspace-members", t);
  return res.status === 200 ? res.body.members.map((m: any) => m.email).sort() : res.status;
}
async function configCustomerId(t: string) {
  const res = await get("/api/v1/workspace/config", t);
  return res.status === 200 ? res.body.customerId : res.status;
}
async function noteTitles(t: string) {
  const res = await get("/api/notifications", t);
  return res.status === 200 ? res.body.notifications.map((n: any) => n.title).sort() : res.status;
}
async function probeWs(t: string) {
  const res = await get("/api/probe", t);
  return res.status === 200 ? res.body.workspaceId : res.status;
}

/* ═══════════════ 1. flag off / one membership: today's behaviour ═══════════════ */
describe("flag off, or one membership — identical to today", () => {
  it("flag off: a two-company person logs straight into their own company, no picker", async () => {
    const l = await plainLogin(EMAIL.dual);
    const c = decode(l.body.accessToken);
    expect(c.customerId).toBe(String(CUST_A));
    expect(c.wsid).toBe(String(WS_A));
    expect(await probeWs(l.body.accessToken)).toBe(String(WS_A));
  });

  it("flag off: the new endpoints answer 404 and the admin route is closed", async () => {
    const l = await plainLogin(EMAIL.dual);
    expect((await sw(l.body.accessToken, WS_B)).status).toBe(404);
    expect((await select("x", WS_B)).status).toBe(404);
    expect((await myCompanies(l.body.accessToken)).body).toEqual({ enabled: false, companies: [], currentWorkspaceId: null });
    const adm = signed({ sub: String(U.admin), email: EMAIL.admin, roles: ["ADMIN"], workspaceId: String(HOUSE) });
    const add = await request(app).post("/api/admin/workspace-memberships").set("Authorization", `Bearer ${adm}`)
      .send({ email: EMAIL.addme, workspaceId: String(WS_B), memberRole: "REQUESTER" });
    expect(add.status).toBe(404);
  });

  it("flag on, one membership: login, /me and refresh mint the same claims as flag off", async () => {
    const off = await plainLogin(EMAIL.solo);
    flagOn();
    const on = await login(EMAIL.solo);
    expect(on.status).toBe(200);
    expect(on.body.needsPick).toBeUndefined();
    expect(strip(decode(on.body.accessToken))).toEqual(strip(decode(off.body.accessToken)));
    expect(strip(decode(refreshCookie(on)!))).toEqual(strip(decode(refreshCookie(off)!)));
    expect(on.body.user).toEqual(off.body.user);
    const r = await refreshWith(refreshCookie(on)!);
    expect(strip(decode(r.body.accessToken))).toEqual(strip(decode(off.body.accessToken)));
    expect((await me(on.body.accessToken)).body.workspace._id).toBe(String(WS_A));
    // A one-company person has nothing to switch between.
    expect((await myCompanies(on.body.accessToken)).body.companies).toHaveLength(1);
  });

  it("flag on: a second membership on a SUSPENDED workspace, or a suspended membership, does not count", async () => {
    flagOn();
    for (const email of [EMAIL.deadws, EMAIL.susp]) {
      const l = await login(email);
      expect(l.status).toBe(200);
      expect(l.body.needsPick).toBeUndefined();
      expect(decode(l.body.accessToken).customerId).toBe(String(CUST_A));
    }
  });

  it("flag on: SuperAdmin, HOUSE staff and demo users never get a picker", async () => {
    flagOn();
    for (const email of [EMAIL.sa, EMAIL.staff, EMAIL.demo]) {
      const l = await login(email);
      expect(l.status, email).toBe(200);
      expect(l.body.needsPick, email).toBeUndefined();
      expect(l.body.accessToken, email).toBeTruthy();
    }
  });
});

/* ═══════════════ 2. login picker ═══════════════ */
describe("login picker (flag on, two memberships)", () => {
  it("answers needsPick with both companies, no session and no cookies", async () => {
    flagOn();
    const l = await login(EMAIL.dual);
    expect(l.status).toBe(200);
    expect(l.body.needsPick).toBe(true);
    expect(l.body.accessToken).toBeUndefined();
    expect(refreshCookie(l)).toBeUndefined();
    expect(l.body.memberships.map((m: any) => [m.companyName, m.role, m.isHome])).toEqual([
      ["Acme", "WORKSPACE_LEADER", true],
      ["Beta", "WORKSPACE_LEADER", false],
    ]);
  });

  it("the pick token is neither an access token nor a refresh token", async () => {
    flagOn();
    const { pickToken } = (await login(EMAIL.dual)).body;
    expect((await me(pickToken)).status).toBe(401);
    expect((await get("/api/probe", pickToken)).status).toBe(401);
    expect((await refreshWith(pickToken)).status).toBe(401);
    expect((await select("garbage", WS_B)).body.code).toBe("PICK_EXPIRED");
  });

  it("picking the own company mints exactly what plain login mints", async () => {
    const off = await plainLogin(EMAIL.dual);
    const s = await pickedSession(EMAIL.dual, WS_A);
    expect(strip(decode(s.body.accessToken))).toEqual(strip(decode(off.body.accessToken)));
    expect(strip(decode(refreshCookie(s)!))).toEqual(strip(decode(refreshCookie(off)!)));
  });

  it("picking the second company mints that company from its membership", async () => {
    const s = await pickedSession(EMAIL.mixed, WS_B);
    const c = decode(s.body.accessToken);
    expect(c).toMatchObject({
      sub: String(U.mixed), customerId: String(CUST_B), businessId: String(CUST_B),
      wsid: String(WS_B), mid: String(MID.mixedB), mver: 0, customerMemberRole: "REQUESTER",
    });
    expect(c.roles).toEqual(["CUSTOMER"]); // the WL role of company A does not travel
    expect(c.workspaceId).toBeUndefined();
    expect(s.body.user).toMatchObject({ customerId: String(CUST_B), customerMemberRole: "REQUESTER", roles: ["CUSTOMER"] });
    expect(await probeWs(s.body.accessToken)).toBe(String(WS_B));
    const log: any = await col("sessionlogs").findOne({ userId: U.mixed, event: "LOGIN" });
    expect(String(log.workspaceId)).toBe(String(WS_B));
    const m: any = await col("workspacememberships").findOne({ _id: MID.mixedB });
    expect(m.lastSelectedAt).toBeInstanceOf(Date);
    expect(m.isDefault).toBe(false); // the last choice is a hint, never the home company
  });

  it("refuses a company the person is not an active member of", async () => {
    flagOn();
    const { pickToken } = (await login(EMAIL.dual)).body;
    expect((await select(pickToken, WS_C)).status).toBe(403);
    expect((await select(pickToken, HOUSE)).status).toBe(403);
  });

  it("a password change kills an outstanding pick token", async () => {
    flagOn();
    const { pickToken } = (await login(EMAIL.dual)).body;
    await col("users").updateOne({ _id: U.dual }, { $set: { passwordHash: bcrypt.hashSync("Another-pass-1", 4) } });
    expect((await select(pickToken, WS_B)).body.code).toBe("PICK_EXPIRED");
  });
});

/* ═══════════════ 3. switch-workspace ═══════════════ */
describe("switch-workspace", () => {
  it("issues access + refresh tokens for the target membership only", async () => {
    const s = await pickedSession(EMAIL.dual, WS_A);
    const r = await sw(s.body.accessToken, WS_B);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = decode(r.body.accessToken);
    expect(c).toMatchObject({ customerId: String(CUST_B), wsid: String(WS_B), mid: String(MID.dualB), customerMemberRole: "WORKSPACE_LEADER" });
    expect(decode(refreshCookie(r)!)).toMatchObject({ sub: String(U.dual), wsid: String(WS_B), mid: String(MID.dualB), mver: 0 });
    const log: any = await col("sessionlogs").findOne({ userId: U.dual, event: "WORKSPACE_SWITCH" });
    expect(String(log.workspaceId)).toBe(String(WS_B));
    // ...and back: the own company is today's login session again.
    const back = await sw(r.body.accessToken, WS_A);
    const off = await plainLogin(EMAIL.dual);
    expect(strip(decode(back.body.accessToken))).toEqual(strip(decode(off.body.accessToken)));
  });

  it("refuses a non-member, a suspended membership and an inactive workspace", async () => {
    flagOn();
    const solo = (await login(EMAIL.solo)).body.accessToken;
    expect((await sw(solo, WS_B)).body.code).toBe("NOT_A_MEMBER");
    const susp = (await login(EMAIL.susp)).body.accessToken;
    expect((await sw(susp, WS_B)).status).toBe(403);
    const dead = (await login(EMAIL.deadws)).body.accessToken;
    expect((await sw(dead, WS_C)).status).toBe(403);
    expect((await sw(solo, "not-an-id")).status).toBe(403);
  });

  it("refuses SuperAdmin, demo users, demo impersonation and HOUSE staff", async () => {
    flagOn();
    for (const email of [EMAIL.sa, EMAIL.staff, EMAIL.demo]) {
      const t = (await login(email)).body.accessToken;
      const r = await sw(t, WS_B);
      expect(r.status, email).toBe(403);
      expect(r.body.code, email).toBe("SWITCH_NOT_ALLOWED");
    }
    // An impersonation token for a two-company person.
    const imp = signed({ sub: String(U.dual), email: EMAIL.dual, roles: ["WORKSPACE_LEADER"], customerId: String(CUST_A), _demoImpersonation: true, isDemoUser: true });
    expect((await sw(imp, WS_B)).body.code).toBe("SWITCH_NOT_ALLOWED");
  });

  it("refuses a session whose own membership was revoked", async () => {
    const s = await pickedSession(EMAIL.dual, WS_B);
    await col("workspacememberships").updateOne({ _id: MID.dualB }, { $set: { status: "SUSPENDED" }, $inc: { tokenVersion: 1 } });
    clearMembershipCache();
    expect((await sw(s.body.accessToken, WS_A)).status).toBe(401);
  });

  it("my-companies lists both, marking the current one", async () => {
    const s = await pickedSession(EMAIL.dual, WS_B);
    const r = await myCompanies(s.body.accessToken);
    expect(r.body.currentWorkspaceId).toBe(String(WS_B));
    expect(r.body.companies.map((c: any) => [c.companyName, c.current])).toEqual([["Acme", false], ["Beta", true]]);
  });
});

/* ═══════════════ 4. after a switch, the Phase 3 routes follow ═══════════════ */
describe("after a switch every Phase 3 route answers with the target company", () => {
  it("company A session, then switch to B: billing, invoices, members, config, notifications, /me", async () => {
    const s = await pickedSession(EMAIL.dual, WS_A);
    const a = s.body.accessToken;
    expect(await billingPnrs(a)).toEqual(["PNR-A"]);
    expect(await invoiceNos(a)).toEqual(["INV-A"]);
    expect(await configCustomerId(a)).toBe(String(CUST_A));
    expect(await noteTitles(a)).toEqual(["dual-A"]);

    const b = (await sw(a, WS_B)).body.accessToken;
    expect(await probeWs(b)).toBe(String(WS_B));
    expect(await billingPnrs(b)).toEqual(["PNR-B"]);
    expect(await invoiceNos(b)).toEqual(["INV-B"]);
    // B's own leader + everyone holding an ACTIVE B membership (the staff / SA /
    // demo rows are fixture-only: the add route refuses those people).
    expect(await memberEmails(b)).toEqual([EMAIL.wlb, EMAIL.dual, EMAIL.mixed, EMAIL.staff, EMAIL.sa, EMAIL.demo].sort());
    expect(await configCustomerId(b)).toBe(String(CUST_B));
    expect(await noteTitles(b)).toEqual(["dual-B"]);
    const m = await me(b);
    expect(m.body.workspace.companyName).toBe("Beta");
    expect(m.body.user).toMatchObject({ customerId: String(CUST_B), customerMemberRole: "WORKSPACE_LEADER" });
  });

  it("a requester in B gets B's refusals, not A's leader rights", async () => {
    const b = (await pickedSession(EMAIL.mixed, WS_B)).body.accessToken;
    expect(await billingPnrs(b)).toBe(403);
    expect(await configCustomerId(b)).toBe(String(CUST_B));
  });

  it("refresh keeps the session in B (no revert to the User document's company)", async () => {
    const s = await pickedSession(EMAIL.dual, WS_B);
    const r = await refreshWith(refreshCookie(s)!);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(decode(r.body.accessToken)).toMatchObject({ customerId: String(CUST_B), wsid: String(WS_B), mid: String(MID.dualB) });
    expect(decode(refreshCookie(r)!)).toMatchObject({ wsid: String(WS_B), mid: String(MID.dualB) });
    expect(r.body.user.customerId).toBe(String(CUST_B));
    expect(await billingPnrs(r.body.accessToken)).toEqual(["PNR-B"]);
  });

  it("refresh of a B session after the flag is turned off falls back to the own company", async () => {
    const s = await pickedSession(EMAIL.dual, WS_B);
    flagOff();
    const r = await refreshWith(refreshCookie(s)!);
    expect(r.status).toBe(200);
    expect(decode(r.body.accessToken).customerId).toBe(String(CUST_A));
    expect(decode(r.body.accessToken).mid).toBeUndefined();
  });

  it("refresh of a B session whose workspace was suspended is refused", async () => {
    const s = await pickedSession(EMAIL.dual, WS_B);
    await col("customerworkspaces").updateOne({ _id: WS_B }, { $set: { status: "SUSPENDED" } });
    expect((await refreshWith(refreshCookie(s)!)).status).toBe(401);
  });
});

/* ═══════════════ 5. add-to-company / suspend / remove ═══════════════ */
describe("add an existing user to another company", () => {
  const adminToken = () => signed({ sub: String(U.admin), email: EMAIL.admin, roles: ["ADMIN"], workspaceId: String(HOUSE) });
  const add = (body: any, t = adminToken()) => request(app).post("/api/admin/workspace-memberships").set("Authorization", `Bearer ${t}`).send(body);
  const patchStatus = (id: string, status: string) =>
    request(app).patch(`/api/admin/workspace-memberships/${id}`).set("Authorization", `Bearer ${adminToken()}`).send({ status });

  it("creates exactly one membership and one roster row, emails without a reset link, never touches the password", async () => {
    flagOn();
    const before: any = await col("users").findOne({ _id: U.addme });
    const r = await add({ email: EMAIL.addme, workspaceId: String(WS_B), memberRole: "APPROVER" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const ms = await col("workspacememberships").find({ userId: U.addme }).toArray();
    expect(ms).toHaveLength(2);
    const m: any = ms.find((x: any) => String(x.workspaceId) === String(WS_B));
    expect(m).toMatchObject({ kind: "CUSTOMER", status: "ACTIVE", isDefault: false, memberRole: "APPROVER", roles: ["APPROVER"], customerId: String(CUST_B) });
    const rows = await col("customermembers").find({ customerId: String(CUST_B), email: EMAIL.addme }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "APPROVER", isActive: true });
    expect(String(m.customerMemberId)).toBe(String(rows[0]._id));

    const after: any = await col("users").findOne({ _id: U.addme });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.resetTokenHash).toBeUndefined();
    expect(after.customerId).toBe(String(CUST_A)); // the home company is untouched

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail: any = (sendMail.mock.calls[0] as any[])[0];
    expect(mail.to).toBe(EMAIL.addme);
    expect(mail.subject).toBe("You've been added to Beta on Plumbox");
    expect(mail.html).toContain("existing email and password");
    expect(mail.html).not.toMatch(/reset|set-password|token=/i);

    // Again → 409, still one membership.
    expect((await add({ email: EMAIL.addme, workspaceId: String(WS_B), memberRole: "APPROVER" })).body.code).toBe("ALREADY_MEMBER");
    expect(await col("workspacememberships").countDocuments({ userId: U.addme })).toBe(2);

    // The person now gets the picker and lands in B with that role.
    const s = await pickedSession(EMAIL.addme, WS_B);
    expect(decode(s.body.accessToken)).toMatchObject({ customerId: String(CUST_B), customerMemberRole: "APPROVER" });
    // ...and their own company keeps its own role (not B's newer roster row).
    const own = await plainLogin(EMAIL.addme);
    expect(decode(own.body.accessToken).customerMemberRole).toBe("REQUESTER");
  });

  it("reuses an existing roster row for that company", async () => {
    flagOn();
    await col("customermembers").insertOne({ customerId: String(CUST_B), email: EMAIL.addme, role: "REQUESTER", isActive: false, travelerId: "BET-0001" } as any);
    const r = await add({ email: EMAIL.addme, customerId: String(CUST_B), memberRole: "WORKSPACE_LEADER" });
    expect(r.status).toBe(201);
    const rows = await col("customermembers").find({ customerId: String(CUST_B), email: EMAIL.addme }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "WORKSPACE_LEADER", isActive: true, travelerId: "BET-0001" });
  });

  it("refuses the own company, unknown emails, staff, a login with no home company, HOUSE and non-admins", async () => {
    flagOn();
    expect((await add({ email: EMAIL.addme, workspaceId: String(WS_A), memberRole: "REQUESTER" })).body.code).toBe("OWN_COMPANY");
    expect((await add({ email: "nobody@acme.test", workspaceId: String(WS_B), memberRole: "REQUESTER" })).status).toBe(404);
    expect((await add({ email: EMAIL.staff, workspaceId: String(WS_A), memberRole: "REQUESTER" })).body.code).toBe("USER_NOT_ELIGIBLE");
    expect((await add({ email: EMAIL.nohome, workspaceId: String(WS_B), memberRole: "REQUESTER" })).body.code).toBe("NO_HOME_COMPANY");
    expect((await add({ email: EMAIL.addme, workspaceId: String(HOUSE), memberRole: "REQUESTER" })).status).toBe(400);
    expect((await add({ email: EMAIL.addme, workspaceId: String(WS_C), memberRole: "REQUESTER" })).body.code).toBe("WORKSPACE_INACTIVE");
    expect((await add({ email: EMAIL.addme, workspaceId: String(WS_B), memberRole: "REQUESTER", roles: ["ADMIN"] })).body.code).toBe("BAD_ROLES");
    // A customer leader (not HOUSE) and a HOUSE non-admin are refused.
    const wlb = signed({ sub: String(U.wlb), email: EMAIL.wlb, roles: ["WORKSPACE_LEADER"], customerId: String(CUST_B) });
    expect((await add({ email: EMAIL.addme, workspaceId: String(WS_B), memberRole: "REQUESTER" }, wlb)).status).toBe(403);
    const ops = signed({ sub: String(U.staff), email: EMAIL.staff, roles: ["EMPLOYEE"], workspaceId: String(HOUSE) });
    expect((await add({ email: EMAIL.addme, workspaceId: String(WS_B), memberRole: "REQUESTER" }, ops)).status).toBe(403);
    expect(await col("workspacememberships").countDocuments({ userId: U.addme })).toBe(1);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("suspend bumps tokenVersion and ends that company's sessions; reactivate restores access", async () => {
    const s = await pickedSession(EMAIL.dual, WS_B);
    const list = await request(app).get(`/api/admin/workspace-memberships?workspaceId=${WS_B}`).set("Authorization", `Bearer ${adminToken()}`);
    expect(list.body.members.map((m: any) => m.email).sort()).toEqual(
      [EMAIL.dual, EMAIL.mixed, EMAIL.susp, EMAIL.staff, EMAIL.sa, EMAIL.demo].sort(),
    );

    const p = await patchStatus(String(MID.dualB), "SUSPENDED");
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const m: any = await col("workspacememberships").findOne({ _id: MID.dualB });
    expect(m).toMatchObject({ status: "SUSPENDED", tokenVersion: 1 });
    expect((await get("/api/probe", s.body.accessToken)).status).toBe(401);
    expect((await refreshWith(refreshCookie(s)!)).status).toBe(401);
    const row: any = await col("customermembers").findOne({ customerId: String(CUST_B), email: EMAIL.dual });
    expect(row.isActive).toBe(false);
    // Login no longer offers B.
    expect((await login(EMAIL.dual)).body.needsPick).toBeUndefined();

    expect((await patchStatus(String(MID.dualB), "ACTIVE")).status).toBe(200);
    const again = await pickedSession(EMAIL.dual, WS_B);
    expect(decode(again.body.accessToken).mver).toBe(1);
  });

  it("remove sets removedAt; the home membership cannot be changed here", async () => {
    flagOn();
    expect((await patchStatus(String(MID.mixedB), "REMOVED")).body.membership.status).toBe("REMOVED");
    const m: any = await col("workspacememberships").findOne({ _id: MID.mixedB });
    expect(m.removedAt).toBeInstanceOf(Date);
    expect(String(m.removedBy)).toBe(String(U.admin));
    const home: any = await col("workspacememberships").findOne({ userId: U.mixed, isDefault: true });
    expect((await patchStatus(String(home._id), "SUSPENDED")).body.code).toBe("HOME_MEMBERSHIP");
  });

  it("a later change to the User document never moves the second-company membership", async () => {
    flagOn();
    await col("users").updateOne({ _id: U.dual }, { $set: { roles: ["APPROVER"] } });
    await syncMembershipFromUser(U.dual, { source: "test" });
    const b: any = await col("workspacememberships").findOne({ _id: MID.dualB });
    expect(b).toMatchObject({ workspaceId: WS_B, roles: ["WORKSPACE_LEADER"], isDefault: false });
    expect(await col("workspacememberships").countDocuments({ userId: U.dual, isDefault: true })).toBe(1);
  });
});

/* ═══════════════ 6. admin-set password ═══════════════ */
describe("POST /password/admin-set", () => {
  const adminA = () => signed({ sub: String(U.adminA), email: EMAIL.adminA, roles: ["ADMIN"], workspaceId: String(WS_A) });
  const set = (userId: any) =>
    request(app).post("/api/password/admin-set").set("Authorization", `Bearer ${adminA()}`).send({ userId: String(userId), newPassword: "Brand-new-pass-9!" });

  it("is refused for a person of two companies, allowed for a one-company person", async () => {
    const before: any = await col("users").findOne({ _id: U.dual });
    const r = await set(U.dual);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe("MULTI_COMPANY_SELF_SERVICE_ONLY");
    expect(((await col("users").findOne({ _id: U.dual })) as any).passwordHash).toBe(before.passwordHash);
    expect((await set(U.solo)).status).toBe(200);
  });
});
