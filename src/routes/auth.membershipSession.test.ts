// apps/backend/src/routes/auth.membershipSession.test.ts
//
// Company switcher Phase 2 — the session carries the default membership
// (docs/audits/multi-workspace-login-audit.md §2.6, §8.2, §8.4).
//
// The PROOF: for every user type, a login / refresh / requireWorkspace / me
// with MEMBERSHIP_SESSION_DISABLED=true (exactly the pre-Phase-2 code path:
// nothing stamped, wsid ignored) and one with it on give IDENTICAL access
// claims and IDENTICAL req.workspace / me.workspace — except the added
// wsid / mid / mver. Plus the new revocation: a suspended membership or a
// bumped tokenVersion refuses refresh (and requireWorkspace), and a legacy
// refresh is upgraded to the default membership.
//
// Real routers and middleware on in-memory Mongo; only the mailer is replaced.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;

vi.mock("../utils/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  sendMail: vi.fn(async () => ({ messageId: "test" })),
}));

const { default: authRouter, signDemoRefresh } = await import("./auth.js");
const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace, clearMembershipCache } = await import("../middleware/requireWorkspace.js");
const { syncMembershipFromUser } = await import("../services/workspaceMembership.service.js");
const { default: WorkspaceMembership } = await import("../models/WorkspaceMembership.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
// What every workspace-scoped router sees.
app.get("/api/probe", requireAuth, requireWorkspace, (req: any, res) =>
  res.json({ workspaceId: req.workspaceId ?? null, workspace: req.workspace ?? null }),
);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const PW = "Test-pass-123";
const HASH = bcrypt.hashSync(PW, 4);

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const SAAS_WS = oid();
const VENDOR_WS = oid();
const CUST = oid();
const CUST_WS = oid();
const VENDOR = oid();

const U = {
  staff: oid(), sa: oid(), wl: oid(), requester: oid(), saas: oid(), vendor: oid(), demo: oid(),
};
const MATRIX: Array<[keyof typeof U, string]> = [
  ["staff", "ops.person@plumtrips.com"],
  ["sa", "root.person@plumtrips.com"],
  ["wl", "leader@acme.test"],
  ["requester", "traveller@acme.test"],
  ["saas", "owner@saasco.test"],
  ["vendor", "desk@vendorco.test"],
  ["demo", "demo.leader@acme.test"],
];
const EMAIL = Object.fromEntries(MATRIX) as Record<keyof typeof U, string>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("auth-membership-session-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  delete process.env.MEMBERSHIP_SESSION_DISABLED;
  clearMembershipCache();
  await mongoose.connection.db!.dropDatabase();
  await WorkspaceMembership.init();
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: String(HOUSE), companyName: "Plumtrips", status: "ACTIVE", tenantType: "HOUSE" },
    { _id: SAAS_WS, customerId: String(SAAS_WS), companyName: "SaaSCo", status: "ACTIVE", tenantType: "SAAS_HRMS" },
    { _id: VENDOR_WS, customerId: String(VENDOR_WS), companyName: "VendorCo", status: "ACTIVE" },
    { _id: CUST_WS, customerId: String(CUST), companyName: "Acme", status: "ACTIVE", tenantType: "CORPORATE" },
  ] as any[]);
  await col("customers").insertOne({ _id: CUST, name: "Acme", email: "accounts@acme.test" } as any);
  await col("vendors").insertOne({ _id: VENDOR, ownerId: U.vendor, name: "VendorCo", email: EMAIL.vendor } as any);
  await col("customermembers").insertMany([
    { customerId: String(CUST), email: EMAIL.wl, role: "WORKSPACE_LEADER", isActive: true },
    { customerId: String(CUST), email: EMAIL.requester, role: "REQUESTER", isActive: true },
    { customerId: String(CUST), email: EMAIL.demo, role: "WORKSPACE_LEADER", isActive: true },
  ] as any[]);
  // Fixed timestamps: a raw row without them gets a fresh createdAt per read.
  const at = new Date("2026-01-01T00:00:00Z");
  const base = { status: "ACTIVE", passwordHash: HASH, createdAt: at, updatedAt: at };
  await col("users").insertMany([
    { _id: U.staff, email: EMAIL.staff, roles: ["EMPLOYEE"], workspaceId: HOUSE, ...base },
    { _id: U.sa, email: EMAIL.sa, roles: ["SUPERADMIN"], hrmsAccessRole: "SuperAdmin", workspaceId: HOUSE, ...base },
    // Stale User.workspaceId=HOUSE (the promote-customer leftover) — must not win.
    { _id: U.wl, email: EMAIL.wl, roles: ["WORKSPACE_LEADER"], customerId: String(CUST), businessId: String(CUST), workspaceId: HOUSE, ...base },
    { _id: U.requester, email: EMAIL.requester, roles: ["REQUESTER"], customerId: String(CUST), businessId: String(CUST), ...base },
    { _id: U.saas, email: EMAIL.saas, roles: ["TENANT_ADMIN"], workspaceId: SAAS_WS, ...base },
    { _id: U.vendor, email: EMAIL.vendor, roles: ["VENDOR"], vendorId: String(VENDOR), workspaceId: VENDOR_WS, ...base },
    { _id: U.demo, email: EMAIL.demo, roles: ["WORKSPACE_LEADER"], customerId: String(CUST), businessId: String(CUST), isDemoUser: true, ...base },
  ] as any[]);
  // Staff-gate rows (login refuses internal users without one).
  await col("userpermissions").insertMany(
    (["staff", "saas"] as const).map((k) => ({
      userId: String(U[k]), email: EMAIL[k], workspaceId: String(k === "saas" ? SAAS_WS : HOUSE), universe: "STAFF", status: "active",
    })) as any[],
  );
  // The live state: one backfilled default membership per user.
  for (const id of Object.values(U)) expect(await syncMembershipFromUser(id, { source: "test" })).toBe("created");
});
afterEach(() => {
  delete process.env.MEMBERSHIP_SESSION_DISABLED;
});

const ADDED = ["wsid", "mid", "mver"];
const VOLATILE = ["iat", "exp"];
const decode = (t: string) => jwt.decode(t) as any;
const strip = (claims: any, drop: string[]) => Object.fromEntries(Object.entries(claims).filter(([k]) => !drop.includes(k)));
const refreshCookie = (res: any) =>
  ((res.headers["set-cookie"] as string[] | undefined) ?? []).find((c) => /^refreshToken=[^;]/.test(c))!.split(";")[0].slice("refreshToken=".length);

const login = (email: string) => request(app).post("/api/auth/login").send({ email, password: PW });
const refreshWith = (token: string, extraCookies: string[] = []) =>
  request(app).post("/api/auth/refresh").set("Cookie", [`refreshToken=${token}`, ...extraCookies]);
const probe = (access: string) => request(app).get("/api/probe").set("Authorization", `Bearer ${access}`);
const me = (access: string) => request(app).get("/api/auth/me").set("Authorization", `Bearer ${access}`);
const membershipOf = (id: any) => col("workspacememberships").findOne({ userId: id }) as Promise<any>;

/** One full session under the given mode: login → probe → me → refresh → probe. */
async function session(email: string, disabled: boolean) {
  if (disabled) process.env.MEMBERSHIP_SESSION_DISABLED = "true";
  else delete process.env.MEMBERSHIP_SESSION_DISABLED;
  clearMembershipCache();
  const l = await login(email);
  expect(l.status, JSON.stringify(l.body)).toBe(200);
  const p = await probe(l.body.accessToken);
  const m = await me(l.body.accessToken);
  const refresh = refreshCookie(l);
  const r = await refreshWith(refresh);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const p2 = await probe(r.body.accessToken);
  return {
    access: decode(l.body.accessToken),
    refresh: decode(refresh),
    loginUser: l.body.user,
    probe: { status: p.status, body: p.body },
    me: { status: m.status, workspace: m.body.workspace ?? null, user: m.body.user },
    refreshedAccess: decode(r.body.accessToken),
    refreshedRefresh: decode(refreshCookie(r)),
    refreshedUser: r.body.user,
    probe2: { status: p2.status, body: p2.body },
  };
}

describe("PROOF — claims and req.workspace identical before vs after, except wsid/mid/mver", () => {
  it.each(MATRIX)("%s", async (key, email) => {
    const before = await session(email, true);
    const after = await session(email, false);
    const m = await membershipOf(U[key]);

    // Before: the pre-Phase-2 tokens — no membership claims at all.
    for (const t of [before.access, before.refresh, before.refreshedAccess, before.refreshedRefresh]) {
      for (const k of ADDED) expect(t).not.toHaveProperty(k);
    }
    // After: exactly the default membership is stamped, on all four tokens.
    const stamp = { wsid: String(m.workspaceId), mid: String(m._id), mver: 0 };
    for (const t of [after.access, after.refresh, after.refreshedAccess, after.refreshedRefresh]) expect(t).toMatchObject(stamp);
    expect(after.refresh).toEqual({ sub: String(U[key]), ...stamp, iat: expect.any(Number), exp: expect.any(Number) });

    // Every other claim is identical — login and refresh.
    expect(strip(after.access, [...ADDED, ...VOLATILE])).toEqual(strip(before.access, VOLATILE));
    expect(strip(after.refreshedAccess, [...ADDED, ...VOLATILE])).toEqual(strip(before.refreshedAccess, VOLATILE));
    expect(strip(after.refresh, [...ADDED, ...VOLATILE])).toEqual(strip(before.refresh, VOLATILE));
    // …and the user object login / refresh return.
    expect(after.loginUser).toEqual(before.loginUser);
    expect(after.refreshedUser).toEqual(before.refreshedUser);

    // req.workspace (and req.workspaceId) identical — fresh and refreshed token.
    expect(after.probe).toEqual(before.probe);
    expect(after.probe2).toEqual(before.probe2);
    // /auth/me identical.
    expect(after.me).toEqual(before.me);
  });

  it("the matrix lands where today's code puts each user", async () => {
    const ws: Record<string, string | null> = {};
    for (const [key, email] of MATRIX) ws[key] = (await session(email, false)).probe.body.workspaceId;
    expect(ws).toEqual({
      staff: String(HOUSE),
      sa: String(HOUSE), // SUPERADMIN bypass: from the JWT workspaceId, unchanged
      wl: String(CUST_WS), // customer: by customerId, NOT the stale User.workspaceId=HOUSE
      requester: String(CUST_WS),
      saas: String(SAAS_WS),
      vendor: String(VENDOR_WS),
      demo: String(CUST_WS),
    });
  });
});

describe("refresh re-checks the membership", () => {
  async function loggedIn(key: keyof typeof U) {
    const l = await login(EMAIL[key]);
    expect(l.status).toBe(200);
    return { access: l.body.accessToken as string, refresh: refreshCookie(l) };
  }

  it("a suspended membership refuses refresh and clears the cookie", async () => {
    const s = await loggedIn("wl");
    await col("workspacememberships").updateOne({ userId: U.wl }, { $set: { status: "SUSPENDED" } });
    const r = await refreshWith(s.refresh);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("MEMBERSHIP_REVOKED");
    expect(r.body.accessToken).toBeUndefined();
    expect(r.headers["set-cookie"]).toEqual(expect.arrayContaining([expect.stringMatching(/^refreshToken=;/)]));
    // …and the open access token loses its workspace once the cache entry goes.
    clearMembershipCache();
    const p = await probe(s.access);
    expect(p.status).toBe(401);
    expect(p.body.code).toBe("MEMBERSHIP_REVOKED");
    expect((await me(s.access)).status).toBe(401);
  });

  it("a bumped tokenVersion refuses refresh", async () => {
    const s = await loggedIn("staff");
    await col("workspacememberships").updateOne({ userId: U.staff }, { $inc: { tokenVersion: 1 } });
    const r = await refreshWith(s.refresh);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("MEMBERSHIP_REVOKED");
    clearMembershipCache();
    expect((await probe(s.access)).status).toBe(401);
    // A new login picks up the new version.
    const again = await loggedIn("staff");
    expect(decode(again.access).mver).toBe(1);
    expect((await refreshWith(again.refresh)).status).toBe(200);
  });

  it("requireWorkspace serves the cached membership for ≤60s, then sees the revocation", async () => {
    const s = await loggedIn("requester");
    expect((await probe(s.access)).status).toBe(200); // primes the cache
    await col("workspacememberships").updateOne({ userId: U.requester }, { $set: { status: "SUSPENDED" } });
    expect((await probe(s.access)).status).toBe(200); // still cached
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      expect((await probe(s.access)).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it("a membership moved to another workspace refuses the old refresh (wsid mismatch)", async () => {
    const s = await loggedIn("saas");
    await col("workspacememberships").updateOne({ userId: U.saas }, { $set: { workspaceId: VENDOR_WS } });
    const r = await refreshWith(s.refresh);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("MEMBERSHIP_REVOKED");
  });

  it("a forged mid of someone else's membership is refused", async () => {
    const other = await membershipOf(U.staff);
    const forged = jwt.sign(
      { sub: String(U.wl), wsid: String(other.workspaceId), mid: String(other._id), mver: 0 },
      process.env.JWT_REFRESH_SECRET!,
      { expiresIn: "1h" },
    );
    expect((await refreshWith(forged)).status).toBe(401);
  });

  it("a legacy refresh (no mid) is upgraded to the default membership", async () => {
    const m = await membershipOf(U.requester);
    const legacy = jwt.sign({ sub: String(U.requester) }, process.env.JWT_REFRESH_SECRET!, { expiresIn: "1h" });
    const r = await refreshWith(legacy);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const stamp = { wsid: String(m.workspaceId), mid: String(m._id), mver: 0 };
    expect(decode(r.body.accessToken)).toMatchObject(stamp);
    expect(decode(refreshCookie(r))).toMatchObject(stamp);
    expect((await probe(r.body.accessToken)).body.workspaceId).toBe(String(CUST_WS));
  });

  it("a legacy access token keeps the legacy requireWorkspace path", async () => {
    process.env.MEMBERSHIP_SESSION_DISABLED = "true";
    const legacy = (await loggedIn("wl")).access;
    delete process.env.MEMBERSHIP_SESSION_DISABLED;
    // Even with the membership suspended: no wsid → not membership-bound.
    await col("workspacememberships").updateOne({ userId: U.wl }, { $set: { status: "SUSPENDED" } });
    const p = await probe(legacy);
    expect(p.status).toBe(200);
    expect(p.body.workspaceId).toBe(String(CUST_WS));
  });
});

describe("login never blocks on the membership", () => {
  it("no membership yet → created via syncMembershipFromUser, then stamped", async () => {
    await col("workspacememberships").deleteMany({ userId: U.vendor });
    const l = await login(EMAIL.vendor);
    expect(l.status).toBe(200);
    const m = await membershipOf(U.vendor);
    expect(m).toMatchObject({ workspaceId: VENDOR_WS, status: "ACTIVE", isDefault: true });
    expect(decode(l.body.accessToken)).toMatchObject({ wsid: String(VENDOR_WS), mid: String(m._id), mver: 0 });
  });

  it("a SUSPENDED default membership still logs in, as a legacy token", async () => {
    await col("workspacememberships").updateOne({ userId: U.staff }, { $set: { status: "SUSPENDED" } });
    const l = await login(EMAIL.staff);
    expect(l.status).toBe(200);
    for (const k of ADDED) expect(decode(l.body.accessToken)).not.toHaveProperty(k);
    expect(decode(refreshCookie(l))).toEqual({ sub: String(U.staff), iat: expect.any(Number), exp: expect.any(Number) });
  });

  it("a membership naming a different workspace than today's resolution → legacy token, not a changed workspace", async () => {
    await col("workspacememberships").updateOne({ userId: U.wl }, { $set: { workspaceId: HOUSE } });
    const l = await login(EMAIL.wl);
    expect(l.status).toBe(200);
    expect(decode(l.body.accessToken)).not.toHaveProperty("wsid");
    expect((await probe(l.body.accessToken)).body.workspaceId).toBe(String(CUST_WS));
  });

  it("a membership lookup failure → legacy token", async () => {
    const spy = vi.spyOn(WorkspaceMembership, "findOne").mockImplementation((() => {
      throw new Error("db down");
    }) as any);
    try {
      const l = await login(EMAIL.staff);
      expect(l.status).toBe(200);
      expect(decode(l.body.accessToken)).not.toHaveProperty("wsid");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("unchanged paths", () => {
  it("demo impersonation refresh is still checked first — even over a revoked membership cookie", async () => {
    const real = await login(EMAIL.sa);
    await col("workspacememberships").updateOne({ userId: U.sa }, { $set: { status: "SUSPENDED" } });
    const demoRefresh = signDemoRefresh({
      userId: String(U.demo), email: EMAIL.demo, roles: ["WORKSPACE_LEADER"],
      customerId: String(CUST), businessId: String(CUST), customerMemberRole: "WORKSPACE_LEADER",
    });
    const r = await refreshWith(refreshCookie(real), [`demoRefreshToken=${demoRefresh}`]);
    expect(r.status).toBe(200);
    const t = decode(r.body.accessToken);
    expect(t).toMatchObject({ sub: String(U.demo), isDemoUser: true, _demoImpersonation: true });
    for (const k of ADDED) expect(t).not.toHaveProperty(k);
  });

  it("SUPERADMIN explicit workspace selection is unchanged with a membership token", async () => {
    const l = await login(EMAIL.sa);
    expect(decode(l.body.accessToken).wsid).toBe(String(HOUSE));
    const p = await request(app).get("/api/probe").set("Authorization", `Bearer ${l.body.accessToken}`).set("x-workspace-id", String(SAAS_WS));
    expect(p.body.workspaceId).toBe(String(SAAS_WS));
    // The bypass never consults the membership.
    await col("workspacememberships").updateOne({ userId: U.sa }, { $set: { status: "SUSPENDED" } });
    clearMembershipCache();
    expect((await probe(l.body.accessToken)).status).toBe(200);
  });

  it("an INACTIVE user is still refused at refresh before any membership check", async () => {
    const l = await login(EMAIL.requester);
    await col("users").updateOne({ _id: U.requester }, { $set: { status: "INACTIVE" } });
    const r = await refreshWith(refreshCookie(l));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ACCOUNT_INACTIVE");
  });

  it("a disabled login is still refused at refresh like a missing user", async () => {
    const l = await login(EMAIL.vendor);
    await col("users").updateOne({ _id: U.vendor }, { $set: { loginDisabled: true } });
    const r = await refreshWith(refreshCookie(l));
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("User not found");
  });

  it("MEMBERSHIP_SESSION_DISABLED ignores wsid on an issued token (rollback)", async () => {
    const l = await login(EMAIL.wl);
    await col("workspacememberships").updateOne({ userId: U.wl }, { $set: { status: "SUSPENDED" } });
    clearMembershipCache();
    process.env.MEMBERSHIP_SESSION_DISABLED = "true";
    expect((await probe(l.body.accessToken)).status).toBe(200);
    const r = await refreshWith(refreshCookie(l));
    expect(r.status).toBe(200);
    expect(decode(r.body.accessToken)).not.toHaveProperty("wsid");
  });
});
