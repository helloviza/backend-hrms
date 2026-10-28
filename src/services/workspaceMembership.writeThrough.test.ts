// Company switcher Phase 1 — WorkspaceMembership write-through.
//
// Against a real Mongo, through the real router / helpers:
//   - creating a user writes exactly one default membership (staff route and
//     the customer-user helper every customer path goes through);
//   - deactivation mirrors User.status onto the membership (SUSPENDED) and
//     reactivation back (ACTIVE) — still one row;
//   - a membership write failure never fails the original request.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/membership-write-through-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const HOUSE_ID = "69679a7628330a58d29f2254";
const ADMIN_ID = "66b000000000000000000001";

vi.mock("../middleware/auth.js", () => {
  const inject = (req: any, _res: any, next: any) => {
    req.user = { id: ADMIN_ID, _id: ADMIN_ID, sub: ADMIN_ID, roles: ["ADMIN"], email: "ops@plumtrips.com", workspaceId: HOUSE_ID };
    next();
  };
  return { requireAuth: inject, default: inject };
});
vi.mock("../middleware/requireWorkspace.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    requireWorkspace: (req: any, _res: any, next: any) => {
      req.workspaceObjectId = new mongoose.Types.ObjectId(HOUSE_ID);
      req.workspaceId = HOUSE_ID;
      next();
    },
  };
});
vi.mock("../utils/mailer.js", () => ({ sendMail: () => Promise.resolve() }));

const { default: User } = await import("../models/User.js");
const { default: WorkspaceMembership } = await import("../models/WorkspaceMembership.js");
const { default: usersRouter } = await import("../routes/users.js");
const { ensureAuthUserForCustomer } = await import("../routes/customerUsers.js");
const { setUserActiveStatus } = await import("../utils/userActiveStatus.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const CUST = new mongoose.Types.ObjectId();
const WS = new mongoose.Types.ObjectId();

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/users", usersRouter);
  a.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err?.message }));
  return a;
}

const createStaff = (email: string) =>
  request(app()).post("/api/users/create-staff").send({ name: "New Hire", email, password: "secret-123", role: "EMPLOYEE" });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("membership-write-through"));
  await WorkspaceMembership.init();
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(["users", "workspacememberships", "customerworkspaces", "customermembers", "customers"].map((c) => col(c).deleteMany({})));
  await col("customerworkspaces").insertMany([
    { _id: new mongoose.Types.ObjectId(HOUSE_ID), customerId: "house", companyName: "Plumtrips", status: "ACTIVE" },
    { _id: WS, customerId: String(CUST), companyName: "Alpha Pvt Ltd", status: "ACTIVE" },
  ] as any[]);
});

describe("WorkspaceMembership write-through", () => {
  it("creating a staff user writes one default STAFF membership in their workspace", async () => {
    const res = await createStaff("new.hire@plumtrips.com");
    expect(res.status).toBe(201);

    const rows = await WorkspaceMembership.find({ userId: res.body.user._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "STAFF", customerId: "house", roles: ["EMPLOYEE"], status: "ACTIVE", isDefault: true, tokenVersion: 0 });
    expect(String(rows[0].workspaceId)).toBe(HOUSE_ID);
    expect(String(rows[0].invitedBy)).toBe(ADMIN_ID);
  });

  it("creating a customer user writes one CUSTOMER membership on the company's workspace", async () => {
    await col("customermembers").insertOne({ customerId: String(CUST), email: "lead@alpha.test", role: "WORKSPACE_LEADER", isActive: true });
    const r = await ensureAuthUserForCustomer({ email: "lead@alpha.test", customerId: String(CUST), workspaceId: WS, memberRole: "WORKSPACE_LEADER" });
    expect(r.created).toBe(true);

    const rows = await WorkspaceMembership.find({ userId: r.user._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "CUSTOMER", customerId: String(CUST), memberRole: "WORKSPACE_LEADER", isDefault: true });
    expect(String(rows[0].workspaceId)).toBe(String(WS));
    expect(rows[0].customerMemberId).toBeTruthy();

    // Adopting the same login again keeps exactly one row.
    await ensureAuthUserForCustomer({ email: "lead@alpha.test", customerId: String(CUST), workspaceId: WS, memberRole: "WORKSPACE_LEADER" });
    expect(await WorkspaceMembership.countDocuments({ userId: r.user._id })).toBe(1);
  });

  it("deactivation mirrors User.status onto the membership, and back", async () => {
    const res = await createStaff("leaver@plumtrips.com");
    const userId = res.body.user._id;

    await setUserActiveStatus({ userId, workspaceId: HOUSE_ID, status: "INACTIVE" });
    expect((await WorkspaceMembership.findOne({ userId }).lean())!.status).toBe("SUSPENDED");

    await setUserActiveStatus({ userId, workspaceId: HOUSE_ID, status: "ACTIVE" });
    expect((await WorkspaceMembership.findOne({ userId }).lean())!.status).toBe("ACTIVE");
    expect(await WorkspaceMembership.countDocuments({ userId })).toBe(1);
  });

  it("a membership write failure never fails the request or the deactivation", async () => {
    const boom = vi.spyOn(WorkspaceMembership, "updateOne").mockRejectedValue(new Error("membership store down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await createStaff("unlucky@plumtrips.com");
    expect(res.status).toBe(201);
    expect(await User.countDocuments({ email: "unlucky@plumtrips.com" })).toBe(1);

    const r = await setUserActiveStatus({ userId: res.body.user._id, workspaceId: HOUSE_ID, status: "INACTIVE" });
    expect(r).toMatchObject({ userMatched: true, changed: true, status: "INACTIVE" });

    expect(boom).toHaveBeenCalled();
    expect(quiet.mock.calls.some((c) => String(c[0]).includes("[membership] sync failed"))).toBe(true);
    expect(await col("workspacememberships").countDocuments()).toBe(0);
  });
});
