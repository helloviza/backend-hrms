// Phase 0 follow-ups (docs/audits/multi-workspace-login-audit.md), over real
// HTTP against a real mongodb-memory-server with the real routers mounted.
//
//  - tempPassword is cleared whenever the person sets their own password:
//    reset-password (forgot-password + every set-password link), both
//    change-password routes, and invite accept. /signup/invite/accept trusts
//    tempPassword===true to mean "this login has no password of its own yet",
//    so a stale true would let an invite overwrite a password someone chose.
//  - ADMIN / HR can only be granted by a SuperAdmin's invite: those roles pass
//    role-only gates (requireAdmin etc.) that reach other workspaces.
//  - the invite body the frontend now sends ({ rows }) is the one the route reads.
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
  JWT_SECRET: "invite-followups-test-secret",
  JWT_REFRESH_SECRET: "invite-followups-refresh-secret",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
  OPENAI_API_KEY: "test",
})) process.env[k] ||= v;

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
const { default: invitesRouter } = await import("./workspace.invites.js");
const { default: signupRouter } = await import("./signup.js");
const { default: authRouter } = await import("./auth.js");
const { default: authSignupRouter } = await import("./auth.signup.js");
const { default: passwordRouter } = await import("./password.js");
const { issueSetPasswordLink, RESET_LINK_TTL_MS } = await import("../utils/setPasswordLink.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/workspace/invites", invitesRouter);
app.use("/api/signup", signupRouter);
app.use("/api/auth", authSignupRouter);
app.use("/api/auth", authRouter);
app.use("/api/password", passwordRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const SECRET = process.env.JWT_SECRET!;
const CUST_A = oid();
let WS_A: any;

const tokenFor = (claims: Record<string, any>) => jwt.sign(claims, SECRET, { expiresIn: "1h" });
const leaderA = () =>
  tokenFor({ sub: String(oid()), email: "leader@a.com", roles: ["CUSTOMER", "WORKSPACE_LEADER"], customerId: String(CUST_A) });

const superAdminId = oid();
const superAdmin = () => tokenFor({ sub: String(superAdminId), email: "sa@plumtrips.com", roles: ["SUPERADMIN"] });

/** A login HR just created: a password nobody chose, flagged temporary. */
async function tempUser(email: string, plain = "Handed-over-1") {
  return User.create({
    email,
    passwordHash: await bcrypt.hash(plain, 4),
    tempPassword: true,
    status: "ACTIVE",
    roles: ["EMPLOYEE"],
    workspaceId: WS_A._id,
  } as any);
}
const tempFlag = async (id: any) => ((await User.findById(id).lean()) as any)?.tempPassword;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("invite-followups-test"));
  await Promise.all([User.init(), WorkspaceInvite.init()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  inviteMails.length = 0;
  await Promise.all([User, CustomerWorkspace, WorkspaceInvite].map((m: any) => m.deleteMany({})));
  WS_A = await CustomerWorkspace.create({ customerId: String(CUST_A), companyName: "Company A", status: "ACTIVE" } as any);
});

/* ─────────────────────────────────────────────────────────────────────────── */
describe("tempPassword is cleared when the person sets their own password", () => {
  it("reset-password (forgot-password / set-password link)", async () => {
    const u = await tempUser("reset@a.com");
    const link = await issueSetPasswordLink(u._id, RESET_LINK_TTL_MS);
    const token = new URL(link).searchParams.get("token");

    const res = await request(app).post("/api/auth/reset-password").send({ token, newPassword: "Chosen-by-me-1" });
    expect(res.status).toBe(200);
    expect(await tempFlag(u._id)).toBe(false);
  });

  it("POST /api/auth/change-password", async () => {
    const u = await tempUser("change1@a.com");
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${tokenFor({ sub: String(u._id), email: u.email, roles: ["EMPLOYEE"] })}`)
      .send({ currentPassword: "Handed-over-1", newPassword: "Chosen-by-me-1" });
    expect(res.status).toBe(200);
    expect(await tempFlag(u._id)).toBe(false);
  });

  it("POST /api/password/change", async () => {
    const u = await tempUser("change2@a.com");
    const res = await request(app)
      .post("/api/password/change")
      .set("Authorization", `Bearer ${tokenFor({ sub: String(u._id), email: u.email, roles: ["EMPLOYEE"] })}`)
      .send({ currentPassword: "Handed-over-1", newPassword: "Chosen-by-me-1" });
    expect(res.status).toBe(200);
    expect(await tempFlag(u._id)).toBe(false);
  });

  it("invite accept, and a second invite can then no longer overwrite that password", async () => {
    const u = await tempUser("hire@a.com");
    const mk = (token: string) =>
      WorkspaceInvite.create({
        workspaceId: WS_A._id, email: "hire@a.com", role: "EMPLOYEE", invitedBy: oid(), token,
        status: "pending", expiresAt: new Date(Date.now() + 86_400_000),
      } as any);
    await mk("first-invite");
    await mk("second-invite");

    const first = await request(app).post("/api/signup/invite/accept").send({ token: "first-invite", password: "Chosen-by-me-1" });
    expect(first.status).toBe(200);
    expect(await tempFlag(u._id)).toBe(false);

    const second = await request(app).post("/api/signup/invite/accept").send({ token: "second-invite", password: "Attacker-pw-1" });
    expect(second.status).toBe(400);
    const after: any = await User.findById(u._id).lean();
    expect(await bcrypt.compare("Chosen-by-me-1", after.passwordHash)).toBe(true);
  });

  it("a wrong current password changes nothing (flag stays)", async () => {
    const u = await tempUser("wrong@a.com");
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${tokenFor({ sub: String(u._id), email: u.email, roles: ["EMPLOYEE"] })}`)
      .send({ currentPassword: "not-it", newPassword: "Chosen-by-me-1" });
    expect(res.status).toBe(400);
    expect(await tempFlag(u._id)).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
describe("invite request body (frontend lib/workspaceInvites.ts contract)", () => {
  it("the old { invites: [...] } body was a 400 on /send", async () => {
    const res = await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ invites: [{ email: "new@a.com", role: "EMPLOYEE" }] });
    expect(res.status).toBe(400);
  });

  it("{ rows: [{ email, role }] } on /bulk-csv sends, one role per person", async () => {
    const res = await request(app)
      .post("/api/workspace/invites/bulk-csv")
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ rows: [{ email: "new1@a.com", role: "EMPLOYEE" }, { email: "new2@a.com", role: "MANAGER" }] });
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual(["new1@a.com", "new2@a.com"]);
    const roles = (await WorkspaceInvite.find({}).sort({ email: 1 }).lean()).map((i: any) => i.role);
    expect(roles).toEqual(["EMPLOYEE", "MANAGER"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
describe("ADMIN / HR only by a SuperAdmin's invite", () => {
  for (const role of ["ADMIN", "HR"]) {
    it(`a workspace leader cannot invite someone as ${role}`, async () => {
      const res = await request(app)
        .post("/api/workspace/invites/bulk-csv")
        .set("Authorization", `Bearer ${leaderA()}`)
        .send({ rows: [{ email: "boss@a.com", role }] });
      expect(res.status).toBe(200);
      expect(res.body.sent).toEqual([]);
      expect(res.body.errors.join(" ")).toMatch(/only Plumtrips can invite/);
      expect(await WorkspaceInvite.countDocuments({})).toBe(0);
      expect(inviteMails).toHaveLength(0);
    });
  }

  it("the same refusal on /send", async () => {
    const res = await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ emails: ["boss@a.com"], role: "ADMIN" });
    expect(res.body.sent).toEqual([]);
    expect(await WorkspaceInvite.countDocuments({})).toBe(0);
  });

  it("a leader can still invite EMPLOYEE / MANAGER", async () => {
    const res = await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ emails: ["staff@a.com"], role: "MANAGER" });
    expect(res.body.sent).toEqual(["staff@a.com"]);
  });

  it("a SuperAdmin can invite as ADMIN, and /join creates the ADMIN login", async () => {
    await User.create({ _id: superAdminId, email: "sa@plumtrips.com", roles: ["SUPERADMIN"], status: "ACTIVE", passwordHash: "x", workspaceId: oid() } as any);
    const sent = await request(app)
      .post("/api/workspace/invites/send")
      .set("Authorization", `Bearer ${superAdmin()}`)
      .set("x-workspace-id", String(WS_A._id))
      .send({ emails: ["newadmin@a.com"], role: "ADMIN" });
    expect(sent.body.sent).toEqual(["newadmin@a.com"]);

    const token = new URL(inviteMails[0].inviteUrl).searchParams.get("token");
    const res = await request(app).post("/api/auth/accept-invite").send({ token, name: "New Admin", password: "New-admin-pw-1" });
    expect(res.status).toBe(201);
    expect(((await User.findOne({ email: "newadmin@a.com" }).lean()) as any).roles).toEqual(["ADMIN"]);
  });

  it("/join refuses a stored ADMIN or HR invite a non-SuperAdmin sent (sent before this fix)", async () => {
    const leader = await User.create({ email: "leader@a.com", roles: ["CUSTOMER", "WORKSPACE_LEADER"], status: "ACTIVE", passwordHash: "x", workspaceId: WS_A._id } as any);
    for (const role of ["ADMIN", "HR"]) {
      await WorkspaceInvite.create({
        workspaceId: WS_A._id, email: `old-${role}@a.com`, role, invitedBy: leader._id,
        token: `old-${role}`, status: "pending", expiresAt: new Date(Date.now() + 86_400_000),
      } as any);
      const res = await request(app).post("/api/auth/accept-invite").send({ token: `old-${role}`, name: "X", password: "Some-pw-123" });
      expect(res.status).toBe(400);
      expect(await User.countDocuments({ email: `old-${role.toLowerCase()}@a.com` })).toBe(0);
      expect(((await WorkspaceInvite.findOne({ token: `old-${role}` }).lean()) as any).status).toBe("pending");
    }
  });
});
