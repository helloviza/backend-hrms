// Phase 0 of docs/audits/multi-workspace-login-audit.md §0 — the invite
// account-takeover chain and its siblings, over real HTTP against a real
// mongodb-memory-server, mounting the real routers (never server.ts).
//
// The chain this guards: any logged-in user could POST /workspace/invites/send
// for any email, read the invite's token back from GET /workspace/invites, and
// redeem it at the public POST /signup/invite/accept — which set the password
// of whichever User owned that email, in any workspace. Each attack below must
// fail; each happy path must still work.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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
  JWT_SECRET: "invite-takeover-test-secret",
  JWT_REFRESH_SECRET: "invite-takeover-refresh-secret",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
  OPENAI_API_KEY: "test",
})) process.env[k] ||= v;

// The invite link only ever travels by email — capture it there.
const inviteMails: Array<{ to: string; inviteUrl: string }> = [];
vi.mock("../services/email.service.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  sendEmployeeInvite: vi.fn(async (to: string, opts: any) => {
    inviteMails.push({ to, inviteUrl: opts.inviteUrl });
  }),
}));
vi.mock("../utils/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  sendMail: vi.fn(async () => ({ messageId: "test" })),
}));

const { default: User } = await import("../models/User.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: WorkspaceInvite } = await import("../models/WorkspaceInvite.js");
const { default: Onboarding } = await import("../models/Onboarding.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerMember } = await import("../models/CustomerMember.js");
const { default: invitesRouter } = await import("./workspace.invites.js");
const { default: signupRouter } = await import("./signup.js");
const { default: authSignupRouter } = await import("./auth.signup.js");
const { default: authRouter } = await import("./auth.js");
const { default: onboardingRouter } = await import("./onboarding.js");
const { default: masterDataRouter } = await import("./masterData.js");
const { default: customerUsersRouter } = await import("./customerUsers.js");
const { ensureCstepTravellerLogin } = await import("./workspace.travellers.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/workspace/invites", invitesRouter);
app.use("/api/signup", signupRouter);
app.use("/api/auth", authSignupRouter);
app.use("/api/auth", authRouter);
app.use("/api/onboarding", onboardingRouter);
app.use("/api/master-data", masterDataRouter);
app.use("/api/customer/users", customerUsersRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const SECRET = process.env.JWT_SECRET!;

// Company A (the inviter) and company B (the victim's), each a real tenant.
const CUST_A = oid();
const CUST_B = oid();
let WS_A: any;
let WS_B: any;
const HOUSE_WS = oid();

function tokenFor(claims: Record<string, any>) {
  return jwt.sign(claims, SECRET, { expiresIn: "1h" });
}
const leaderA = () =>
  tokenFor({ sub: String(oid()), email: "leader@a.com", roles: ["CUSTOMER", "WORKSPACE_LEADER"], customerId: String(CUST_A) });
const requesterA = () =>
  tokenFor({ sub: String(oid()), email: "req@a.com", roles: ["CUSTOMER", "REQUESTER"], customerId: String(CUST_A) });
const superAdmin = () =>
  tokenFor({ sub: String(oid()), email: "admin@plumtrips.com", roles: ["SUPERADMIN"] });

async function makeUser(fields: Record<string, any>) {
  return User.create({
    passwordHash: await bcrypt.hash("victim-own-password", 4),
    status: "ACTIVE",
    ...fields,
  } as any);
}

const tokenFromMail = (to: string) => {
  const m = inviteMails.find((x) => x.to === to);
  return m ? new URL(m.inviteUrl).searchParams.get("token") : null;
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("invite-takeover-test"));
  await Promise.all([User.init(), WorkspaceInvite.init(), CustomerMember.init(), Customer.init()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  inviteMails.length = 0;
  await Promise.all(
    [User, CustomerWorkspace, WorkspaceInvite, Onboarding, Customer, CustomerMember].map((m: any) => m.deleteMany({})),
  );
  WS_A = await CustomerWorkspace.create({ customerId: String(CUST_A), companyName: "Company A", status: "ACTIVE" } as any);
  WS_B = await CustomerWorkspace.create({ customerId: String(CUST_B), companyName: "Company B", status: "ACTIVE" } as any);
});

/* ─────────────────────────────────────────────────────────────────────────── */
describe("workspace invites: only a workspace admin may send or list", () => {
  it("a non-admin member cannot send an invite", async () => {
    const res = await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${requesterA()}`)
      .send({ emails: ["new.person@a.com"] });
    expect(res.status).toBe(403);
    expect(await WorkspaceInvite.countDocuments()).toBe(0);
  });

  it("a non-admin member cannot use bulk-csv either", async () => {
    const res = await request(app)
      .post("/api/workspace/invites/bulk-csv")
      .set("Authorization", `Bearer ${requesterA()}`)
      .send({ rows: [{ email: "new.person@a.com" }] });
    expect(res.status).toBe(403);
    expect(await WorkspaceInvite.countDocuments()).toBe(0);
  });

  it("a non-admin member cannot list invites", async () => {
    const res = await request(app)
      .get("/api/workspace/invites")
      .set("Authorization", `Bearer ${requesterA()}`);
    expect(res.status).toBe(403);
  });

  it("the list an admin sees never carries the invite token", async () => {
    await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ emails: ["new.person@a.com"] })
      .expect(200);
    expect(tokenFromMail("new.person@a.com")).toBeTruthy();

    const res = await request(app)
      .get("/api/workspace/invites")
      .set("Authorization", `Bearer ${leaderA()}`);
    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
    expect(res.body.invites[0]).not.toHaveProperty("token");
    expect(JSON.stringify(res.body)).not.toContain(tokenFromMail("new.person@a.com")!);
  });

  it("refuses to invite an email that already has a login in another workspace", async () => {
    await makeUser({ email: "victim@b.com", workspaceId: WS_B._id, customerId: String(CUST_B), roles: ["CUSTOMER"] });
    const res = await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ emails: ["victim@b.com"] });
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([]);
    expect(res.body.errors[0]).toMatch(/already has a Plumbox login in another company/);
    expect(await WorkspaceInvite.countDocuments()).toBe(0);
    expect(inviteMails).toHaveLength(0);
  });

  it("refuses a role an invite may not confer (no SUPERADMIN by invite)", async () => {
    const res = await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ emails: ["new.person@a.com"], role: "SUPERADMIN" });
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([]);
    expect(res.body.errors[0]).toMatch(/can't be granted by invite/);
    expect(await WorkspaceInvite.countDocuments()).toBe(0);
  });

  it("a SuperAdmin may still send (explicit workspace)", async () => {
    const res = await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${superAdmin()}`)
      .set("x-workspace-id", String(WS_A._id))
      .send({ emails: ["new.person@a.com"] });
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual(["new.person@a.com"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
describe("POST /signup/invite/accept never sets the password of someone else's login", () => {
  async function inviteRow(email: string, workspaceId: any, extra: Record<string, any> = {}) {
    return WorkspaceInvite.create({
      workspaceId,
      email,
      role: "EMPLOYEE",
      invitedBy: String(oid()),
      token: `tok-${Math.random().toString(36).slice(2)}`,
      expiresAt: new Date(Date.now() + 86400_000),
      status: "pending",
      ...extra,
    } as any);
  }

  it("refuses for a user in ANOTHER workspace (the takeover) — password unchanged, invite unused", async () => {
    const victim = await makeUser({ email: "victim@b.com", workspaceId: WS_B._id, customerId: String(CUST_B), roles: ["CUSTOMER"] });
    const before = victim.passwordHash;
    const inv = await inviteRow("victim@b.com", WS_A._id);

    const res = await request(app).post("/api/signup/invite/accept").send({ token: inv.token, password: "attacker-pass-123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid or expired invite link");

    const after: any = await User.findById(victim._id).lean();
    expect(after.passwordHash).toBe(before);
    expect(((await WorkspaceInvite.findById(inv._id).lean()) as any).status).toBe("pending");
  });

  it("refuses for a same-workspace user who already has their own password", async () => {
    const u = await makeUser({ email: "staffer@a.com", workspaceId: WS_A._id, roles: ["EMPLOYEE"], tempPassword: false });
    const inv = await inviteRow("staffer@a.com", WS_A._id);
    const res = await request(app).post("/api/signup/invite/accept").send({ token: inv.token, password: "attacker-pass-123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid or expired invite link");
    expect(((await User.findById(u._id).lean()) as any).passwordHash).toBe(u.passwordHash);
  });

  it("gives the same answer when no account exists (no existence leak)", async () => {
    const inv = await inviteRow("nobody@a.com", WS_A._id);
    const res = await request(app).post("/api/signup/invite/accept").send({ token: inv.token, password: "whatever-123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid or expired invite link");
  });

  it("refuses an expired invite and marks it expired", async () => {
    await makeUser({ email: "new.hire@a.com", workspaceId: WS_A._id, roles: ["EMPLOYEE"], tempPassword: true });
    const inv = await inviteRow("new.hire@a.com", WS_A._id, { expiresAt: new Date(Date.now() - 1000) });
    const res = await request(app).post("/api/signup/invite/accept").send({ token: inv.token, password: "new-pass-123" });
    expect(res.status).toBe(400);
    expect(((await WorkspaceInvite.findById(inv._id).lean()) as any).status).toBe("expired");
  });

  it("happy path: HR-created login (temp password) in the inviting workspace sets its password once", async () => {
    const u = await makeUser({ email: "new.hire@a.com", workspaceId: WS_A._id, roles: ["EMPLOYEE"], tempPassword: true });
    const inv = await inviteRow("new.hire@a.com", WS_A._id);

    const res = await request(app).post("/api/signup/invite/accept").send({ token: inv.token, password: "new-pass-123" });
    expect(res.status).toBe(200);
    const after: any = await User.findById(u._id).lean();
    expect(await bcrypt.compare("new-pass-123", after.passwordHash)).toBe(true);
    expect(after.tempPassword).toBe(false);
    expect(((await WorkspaceInvite.findById(inv._id).lean()) as any).status).toBe("accepted");

    // Used means used.
    const again = await request(app).post("/api/signup/invite/accept").send({ token: inv.token, password: "second-pass-123" });
    expect(again.status).toBe(400);
    expect(await bcrypt.compare("new-pass-123", ((await User.findById(u._id).lean()) as any).passwordHash)).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
describe("POST /auth/accept-invite (/join) only creates, never takes over", () => {
  it("does not touch an existing user and leaves the invite unused", async () => {
    const victim = await makeUser({ email: "victim@b.com", workspaceId: WS_B._id, customerId: String(CUST_B), roles: ["CUSTOMER"] });
    const inv = await WorkspaceInvite.create({
      workspaceId: WS_A._id, email: "victim@b.com", role: "EMPLOYEE", invitedBy: oid(),
      token: "join-tok-1", expiresAt: new Date(Date.now() + 86400_000), status: "pending",
    } as any);
    const res = await request(app).post("/api/auth/accept-invite").send({ token: inv.token, name: "X", password: "attacker-pass-123" });
    expect(res.status).toBe(409);
    expect(((await User.findById(victim._id).lean()) as any).passwordHash).toBe(victim.passwordHash);
    expect(((await WorkspaceInvite.findById(inv._id).lean()) as any).status).toBe("pending");
  });

  it("refuses an invite stored with a role invites may not confer", async () => {
    await WorkspaceInvite.create({
      workspaceId: WS_A._id, email: "climber@a.com", role: "SUPERADMIN", invitedBy: oid(),
      token: "join-tok-2", expiresAt: new Date(Date.now() + 86400_000), status: "pending",
    } as any);
    const res = await request(app).post("/api/auth/accept-invite").send({ token: "join-tok-2", name: "C", password: "climber-pass-123" });
    expect(res.status).toBe(400);
    expect(await User.countDocuments({ email: "climber@a.com" })).toBe(0);
  });

  it("happy path: admin invites a brand-new email → accept → login", async () => {
    const send = await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ emails: ["fresh@a.com"], role: "APPROVER" });
    expect(send.status).toBe(200);
    expect(send.body.sent).toEqual(["fresh@a.com"]);
    const token = tokenFromMail("fresh@a.com");
    expect(token).toBeTruthy();

    const accept = await request(app).post("/api/auth/accept-invite").send({ token, name: "Fresh Person", password: "fresh-pass-123" });
    expect(accept.status, JSON.stringify(accept.body)).toBe(201);
    const created: any = await User.findOne({ email: "fresh@a.com" }).lean();
    expect(String(created.workspaceId)).toBe(String(WS_A._id));
    expect(created.roles).toEqual(["APPROVER"]);
    expect(((await WorkspaceInvite.findOne({ email: "fresh@a.com" }).lean()) as any).status).toBe("accepted");

    const login = await request(app).post("/api/auth/login").send({ email: "fresh@a.com", password: "fresh-pass-123" });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.accessToken).toBeTruthy();

    // A second redemption of the same link creates nothing.
    const again = await request(app).post("/api/auth/accept-invite").send({ token, name: "Fresh Person", password: "other-pass-123" });
    expect(again.status).toBe(400);
    expect(await User.countDocuments({ email: "fresh@a.com" })).toBe(1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
describe("public onboarding submit never touches another workspace's user", () => {
  const empForm = (email: string) => ({
    fullName: "Overwritten Name",
    contact: { personalEmail: email, personalMobile: "9999999999" },
    bank: { bankName: "Attacker Bank", accountNumber: "000111", ifsc: "ATTK0000001" },
    ids: { pan: "ATTKP1234Z", aadhaar: "999988887777" },
  });

  it("skips a user in another workspace — no Object.assign", async () => {
    const victim = await makeUser({
      email: "victim@b.com", workspaceId: WS_B._id, roles: ["EMPLOYEE"],
      name: "Real Victim", bankAccountNumber: "REAL-ACC", pan: "REALP0000R",
    });
    await Onboarding.create({
      workspaceId: WS_A._id, type: "employee", email: "victim@b.com", status: "submitted",
      token: "ob-tok-1", expiresAt: new Date(Date.now() + 86400_000), formPayload: empForm("victim@b.com"),
    } as any);

    const res = await request(app).post("/api/onboarding/submit/ob-tok-1").send({});
    expect(res.status).toBe(200);
    const after: any = await User.findById(victim._id).lean();
    expect(after.name).toBe("Real Victim");
    expect(after.bankAccountNumber).toBe("REAL-ACC");
    expect(after.pan).toBe("REALP0000R");
    expect(String(after.workspaceId)).toBe(String(WS_B._id));
  });

  it("happy path: still updates a user in the onboarding's own workspace", async () => {
    const u = await makeUser({ email: "own@a.com", workspaceId: WS_A._id, roles: ["EMPLOYEE"], name: "Old Name" });
    await Onboarding.create({
      workspaceId: WS_A._id, type: "employee", email: "own@a.com", status: "submitted",
      token: "ob-tok-2", expiresAt: new Date(Date.now() + 86400_000), formPayload: empForm("own@a.com"),
    } as any);
    expect((await request(app).post("/api/onboarding/submit/ob-tok-2").send({})).status).toBe(200);
    const after: any = await User.findById(u._id).lean();
    expect(after.name).toBe("Overwritten Name");
    expect(after.bankAccountNumber).toBe("000111");
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
describe("promote-customer never moves or re-roles another workspace's login", () => {
  let tokSeq = 0;
  async function bizOnboarding(email: string, legalName: string) {
    return Onboarding.create({
      workspaceId: HOUSE_WS, type: "business", email, status: "approved", source: "invite",
      token: `biz-${++tokSeq}`, expiresAt: new Date(Date.now() + 86400_000),
      formPayload: { legalName, officialEmail: email },
    } as any);
  }
  const promote = (id: any) =>
    request(app)
      .post(`/api/master-data/${id}/promote-customer`)
      .set("Authorization", `Bearer ${superAdmin()}`)
      .set("x-workspace-id", String(HOUSE_WS))
      .send({ sendEmail: false });

  it("refuses when the contact email is a login in another workspace — user untouched, nothing created", async () => {
    const staff = await makeUser({ email: "ops@plumtrips.com", workspaceId: HOUSE_WS, roles: ["ADMIN"], role: "ADMIN" });
    const ob = await bizOnboarding("ops@plumtrips.com", "NEW CO PRIVATE LIMITED");

    const res = await promote(ob._id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_IN_OTHER_WORKSPACE");

    const after: any = await User.findById(staff._id).lean();
    expect(String(after.workspaceId)).toBe(String(HOUSE_WS));
    expect(after.roles).toEqual(["ADMIN"]);
    expect(await Customer.countDocuments({ legalName: "NEW CO PRIVATE LIMITED" })).toBe(0);
  });

  it("refuses a customer user of a different company too", async () => {
    const other = await makeUser({ email: "lead@b.com", workspaceId: WS_B._id, customerId: String(CUST_B), roles: ["CUSTOMER"], role: "CUSTOMER" });
    const ob = await bizOnboarding("lead@b.com", "ANOTHER CO LIMITED");
    const res = await promote(ob._id);
    expect(res.status).toBe(409);
    const after: any = await User.findById(other._id).lean();
    expect(String(after.workspaceId)).toBe(String(WS_B._id));
    expect(after.roles).toEqual(["CUSTOMER"]);
  });

  it("happy path: a brand-new contact is promoted and gets a login in the new tenant", async () => {
    const ob = await bizOnboarding("founder@newco.com", "BRAND NEW CO LIMITED");
    const res = await promote(ob._id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const u: any = await User.findOne({ email: "founder@newco.com" }).lean();
    expect(u).toBeTruthy();
    const tenant: any = await CustomerWorkspace.findOne({ customerId: String(res.body.customer._id) }).lean();
    expect(String(u.workspaceId)).toBe(String(tenant._id));
  });

  it("happy path: re-promoting the same customer re-links its own login without moving it", async () => {
    const ob = await bizOnboarding("founder@newco.com", "BRAND NEW CO LIMITED");
    const first = await promote(ob._id);
    expect(first.status).toBe(200);
    const u1: any = await User.findOne({ email: "founder@newco.com" }).lean();
    // Its first login stamps customerId (auth.ts) — model that.
    await User.updateOne({ _id: u1._id }, { $set: { customerId: String(first.body.customer._id) } });

    const second = await promote(ob._id);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const u2: any = await User.findById(u1._id).lean();
    expect(String(u2.workspaceId)).toBe(String(u1.workspaceId));
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
describe("a refused cross-workspace add leaves no orphan CustomerMember", () => {
  it("POST /customer/users: 409 and no member row", async () => {
    await makeUser({ email: "victim@b.com", workspaceId: WS_B._id, customerId: String(CUST_B), roles: ["CUSTOMER"] });
    const res = await request(app)
      .post(`/api/customer/users?customerId=${CUST_A}`)
      .set("Authorization", `Bearer ${superAdmin()}`)
      .send({ email: "victim@b.com", role: "APPROVER" });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("CROSS_WORKSPACE_EMAIL_CONFLICT");
    expect(await CustomerMember.countDocuments({ customerId: String(CUST_A), email: "victim@b.com" })).toBe(0);
  });

  it("POST /customer/users happy path: a new email gets a login AND a member row", async () => {
    const res = await request(app)
      .post(`/api/customer/users?customerId=${CUST_A}`)
      .set("Authorization", `Bearer ${superAdmin()}`)
      .send({ email: "approver@a.com", role: "APPROVER" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await CustomerMember.countDocuments({ customerId: String(CUST_A), email: "approver@a.com" })).toBe(1);
    expect(await User.countDocuments({ email: "approver@a.com" })).toBe(1);
  });

  it("CSTEP traveller login: conflict note and no member row", async () => {
    await makeUser({ email: "victim@b.com", workspaceId: WS_B._id, customerId: String(CUST_B), roles: ["CUSTOMER"] });
    const out = await ensureCstepTravellerLogin({
      email: "victim@b.com", customerId: String(CUST_A), workspaceId: WS_A._id, sendInvite: false,
    });
    expect(out.userId).toBeNull();
    expect(out.note).toMatch(/different workspace/);
    expect(await CustomerMember.countDocuments({ customerId: String(CUST_A), email: "victim@b.com" })).toBe(0);
  });

  it("CSTEP traveller login happy path: new traveller gets a login and a REQUESTER member row", async () => {
    const out = await ensureCstepTravellerLogin({
      email: "traveller@a.com", customerId: String(CUST_A), workspaceId: WS_A._id, sendInvite: false,
    });
    expect(out.userId).toBeTruthy();
    const m: any = await CustomerMember.findOne({ customerId: String(CUST_A), email: "traveller@a.com" }).lean();
    expect(m?.role).toBe("REQUESTER");
  });
});
