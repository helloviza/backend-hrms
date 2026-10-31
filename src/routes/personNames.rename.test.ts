// Edit name (docs/audits/company-vs-person-name-audit.md §6.3), over real HTTP
// against mongodb-memory-server, mounting the real users + customerUsers
// routers (never server.ts).
//
//   PATCH /api/users/me/name             every signed-in user, own record
//   PATCH /api/customer/users/:id/name   Plumtrips staff: any company;
//                                        Workspace Leader: own company only
// Each write: User first / last / name (name = first + last), the person's
// CustomerMember.name rows, one UserNameAudit row.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "rename-test-secret",
  JWT_REFRESH_SECRET: "rename-refresh-secret",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
  OPENAI_API_KEY: "test",
})) process.env[k] ||= v;

vi.mock("../utils/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  sendMail: vi.fn(async () => ({ messageId: "test" })),
}));

const { default: User } = await import("../models/User.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: CustomerMember } = await import("../models/CustomerMember.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: UserNameAudit } = await import("../models/UserNameAudit.js");
const { default: usersRouter } = await import("./users.js");
const { default: customerUsersRouter } = await import("./customerUsers.js");

const app = express();
app.use(express.json());
app.use("/api/users", usersRouter);
app.use("/api/customer/users", customerUsersRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const SECRET = process.env.JWT_SECRET!;
const HOUSE_WS = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const CUST_A = oid();
const CUST_B = oid();
let WS_A: any;
let WS_B: any;
const U = { leader: oid(), asha: oid(), approver: oid(), other: oid(), staff: oid() };
const M: Record<string, any> = {};

const token = (claims: Record<string, any>) => jwt.sign(claims, SECRET, { expiresIn: "1h" });
const leaderA = () =>
  token({ sub: String(U.leader), email: "leader@a.test", roles: ["CUSTOMER", "WORKSPACE_LEADER"], customerId: String(CUST_A) });
const approverA = () =>
  token({ sub: String(U.approver), email: "approver@a.test", roles: ["CUSTOMER", "APPROVER"], customerId: String(CUST_A) });
const ashaA = () => token({ sub: String(U.asha), email: "asha@a.test", roles: ["CUSTOMER", "REQUESTER"], customerId: String(CUST_A) });
const staff = () => token({ sub: String(U.staff), email: "ops@plumtrips.com", roles: ["SUPERADMIN"], workspaceId: String(HOUSE_WS) });

const renameSelf = (t: string, body: any) => request(app).patch("/api/users/me/name").set("Authorization", `Bearer ${t}`).send(body);
const renameMember = (t: string, memberId: unknown, body: any, q = "") =>
  request(app).patch(`/api/customer/users/${memberId}/name${q}`).set("Authorization", `Bearer ${t}`).send(body);
const user = async (id: unknown) => (await User.findById(id).lean()) as any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("rename-test"));
  await Promise.all([User.init(), CustomerMember.init()]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([User, CustomerWorkspace, CustomerMember, Customer, UserNameAudit].map((m: any) => m.deleteMany({})));
  await Customer.create([
    { _id: CUST_A, name: "Peachmint", legalName: "Peachmint Foods Private Limited" },
    { _id: CUST_B, name: "Failte", legalName: "Failte Events LLP" },
  ] as any);
  [WS_A, WS_B] = (await (CustomerWorkspace as any).create([
    { customerId: String(CUST_A), companyName: "Peachmint Foods Private Limited" },
    { customerId: String(CUST_B), companyName: "Failte Events LLP" },
  ])) as any[];
  const base = { passwordHash: "x", status: "ACTIVE" };
  await User.create([
    { ...base, _id: U.leader, email: "leader@a.test", name: "Peachmint Foods Private Limited", workspaceId: WS_A._id, customerId: String(CUST_A), roles: ["CUSTOMER", "WORKSPACE_LEADER"] },
    { ...base, _id: U.asha, email: "asha@a.test", name: "Peachmint Foods", firstName: "Peachmint Foods", workspaceId: WS_A._id, customerId: String(CUST_A), roles: ["CUSTOMER", "REQUESTER"] },
    { ...base, _id: U.approver, email: "approver@a.test", name: "Ravi", workspaceId: WS_A._id, customerId: String(CUST_A), roles: ["CUSTOMER", "APPROVER"] },
    { ...base, _id: U.other, email: "kiran@b.test", name: "Failte Events", workspaceId: WS_B._id, customerId: String(CUST_B), roles: ["CUSTOMER", "WORKSPACE_LEADER"] },
    { ...base, _id: U.staff, email: "ops@plumtrips.com", name: "Ops Person", workspaceId: HOUSE_WS, roles: ["SUPERADMIN"] },
  ] as any);
  const rows: any[] = await (CustomerMember as any).create([
    { customerId: String(CUST_A), email: "leader@a.test", role: "WORKSPACE_LEADER", name: "Peachmint" },
    { customerId: String(CUST_A), email: "asha@a.test", role: "REQUESTER", name: "Peachmint Foods" },
    { customerId: String(CUST_A), email: "approver@a.test", role: "APPROVER", name: "Ravi" },
    { customerId: String(CUST_B), email: "kiran@b.test", role: "WORKSPACE_LEADER", name: "Failte" },
    // A Plumtrips staff login sitting on company A's roster.
    { customerId: String(CUST_A), email: "ops@plumtrips.com", role: "APPROVER", name: "Ops" },
  ] as any);
  [M.leader, M.asha, M.approver, M.other, M.staffOnA] = rows;
});

describe("PATCH /api/users/me/name", () => {
  it("a customer renames themselves: first / last / name, roster row, audit row", async () => {
    const res = await renameSelf(ashaA(), { firstName: "  Asha ", lastName: "Rao  Iyer" });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ firstName: "Asha", lastName: "Rao Iyer", name: "Asha Rao Iyer" });

    const u = await user(U.asha);
    expect([u.firstName, u.lastName, u.name]).toEqual(["Asha", "Rao Iyer", "Asha Rao Iyer"]);
    expect(((await CustomerMember.findById(M.asha._id).lean()) as any).name).toBe("Asha Rao Iyer");

    const audit: any[] = await UserNameAudit.find({ userId: U.asha }).lean();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ via: "self", actorEmail: "asha@a.test", from: { name: "Peachmint Foods" }, to: { name: "Asha Rao Iyer" } });
  });

  it("refuses an empty first name, an email, a placeholder, an over-long part; writes nothing", async () => {
    for (const body of [
      { firstName: "", lastName: "Rao" },
      { firstName: "asha@a.test", lastName: "" },
      { firstName: "Workspace", lastName: "User" },
      { firstName: "A".repeat(61), lastName: "" },
    ]) {
      expect((await renameSelf(ashaA(), body)).status).toBe(400);
    }
    expect((await user(U.asha)).name).toBe("Peachmint Foods");
    expect(await UserNameAudit.countDocuments()).toBe(0);
  });

  it("needs a session", async () => {
    expect((await request(app).patch("/api/users/me/name").send({ firstName: "X" })).status).toBe(401);
  });
});

describe("PATCH /api/customer/users/:id/name", () => {
  it("the Workspace Leader renames someone in their own company", async () => {
    const res = await renameMember(leaderA(), M.asha._id, { firstName: "Asha", lastName: "Rao" });
    expect(res.status).toBe(200);
    expect((await user(U.asha)).name).toBe("Asha Rao");
    const audit: any = await UserNameAudit.findOne({ userId: U.asha }).lean();
    expect(audit).toMatchObject({ via: "workspace_leader", actorEmail: "leader@a.test", customerId: String(CUST_A) });
  });

  it("an approver or requester can't rename others", async () => {
    expect((await renameMember(approverA(), M.asha._id, { firstName: "X" })).status).toBe(403);
    expect((await renameMember(ashaA(), M.approver._id, { firstName: "X" })).status).toBe(403);
    expect((await user(U.asha)).name).toBe("Peachmint Foods");
  });

  it("a leader can't reach another company's member, nor a Plumtrips staff login on their roster", async () => {
    expect((await renameMember(leaderA(), M.other._id, { firstName: "X" })).status).toBe(404);
    expect((await renameMember(leaderA(), M.staffOnA._id, { firstName: "X" })).status).toBe(403);
    expect((await user(U.other)).name).toBe("Failte Events");
    expect((await user(U.staff)).name).toBe("Ops Person");
  });

  it("Plumtrips staff rename anyone in any company (customerId picks the company)", async () => {
    const res = await renameMember(staff(), M.other._id, { firstName: "Kiran", lastName: "Mehta" }, `?customerId=${CUST_B}`);
    expect(res.status).toBe(200);
    expect((await user(U.other)).name).toBe("Kiran Mehta");
    expect(((await UserNameAudit.findOne({ userId: U.other }).lean()) as any).via).toBe("staff");
  });

  it("by login id (client-portal Team tab): the leader renames their own person; another company's login is not found", async () => {
    const ok = await request(app)
      .patch(`/api/customer/users/user/${U.asha}/name`)
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ firstName: "Asha", lastName: "Rao" });
    expect(ok.status).toBe(200);
    expect((await user(U.asha)).name).toBe("Asha Rao");

    const other = await request(app)
      .patch(`/api/customer/users/user/${U.other}/name`)
      .set("Authorization", `Bearer ${leaderA()}`)
      .send({ firstName: "X" });
    expect(other.status).toBe(404);
    expect((await user(U.other)).name).toBe("Failte Events");
  });

  it("a roster row with no login → 409 NO_LOGIN", async () => {
    const ghost = await CustomerMember.create({ customerId: String(CUST_A), email: "invited@a.test", role: "REQUESTER" } as any);
    const res = await renameMember(leaderA(), ghost._id, { firstName: "New" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_LOGIN");
  });
});
