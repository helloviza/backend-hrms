// POST /leads/bulk-assign (ask #8) — against a REAL leads / leadactivities /
// tasks / userpermissions collection (mongodb-memory-server). The caller is
// switchable so the FULL gate is exercised for real: an ADMIN (implicit FULL)
// and a rep whose UserPermission row grants leads WRITE / OWN only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-bulk-assign-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ids = vi.hoisted(() => ({
  ADMIN: "66a000000000000000000001",
  WRITER: "66a000000000000000000002",
  REP_A: "66a000000000000000000003",
  REP_B: "66a000000000000000000004",
}));
const caller = vi.hoisted(() => ({ current: "ADMIN" as "ADMIN" | "WRITER" }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user =
      caller.current === "ADMIN"
        ? { id: ids.ADMIN, sub: ids.ADMIN, roles: ["ADMIN"], email: "ops@plumtrips.com", name: "Ops Admin" }
        : { id: ids.WRITER, sub: ids.WRITER, roles: ["EMPLOYEE"], email: "writer@plumtrips.com", name: "Write Only" };
    next();
  },
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireHouse.js", () => ({
  requireHouse: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: Task } = await import("../models/Task.js");
const { default: User } = await import("../models/User.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: router } = await import("./leads.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/leads", router);
  return a;
}
const bulk = (body: Record<string, unknown>) => request(app()).post("/api/leads/bulk-assign").send(body);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(ids.ADMIN), name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" },
    { _id: new mongoose.Types.ObjectId(ids.WRITER), name: "Write Only", email: "writer@plumtrips.com", roles: ["EMPLOYEE"], passwordHash: "x" },
    { _id: new mongoose.Types.ObjectId(ids.REP_A), name: "Imran", email: "imran@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" },
    { _id: new mongoose.Types.ObjectId(ids.REP_B), name: "Neelanchal Bhargava", email: "neel@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" },
  ] as any[]);
  // The WRITE / OWN rep — passes the leads gate, must be refused by the FULL check.
  await UserPermission.create({
    userId: ids.WRITER, email: "writer@plumtrips.com", workspaceId: "69679a7628330a58d29f2254", universe: "STAFF",
    level: { code: "L2", name: "Executive" }, modules: { leads: { access: "WRITE", scope: "OWN" } }, grantedBy: ids.ADMIN,
  });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  caller.current = "ADMIN";
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Task.deleteMany({})]);
});

async function seed(n: number, owner = ids.REP_A) {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const r = await request(app()).post("/api/leads").send({ contactName: `Person ${i}`, contactPhone: `98110000${String(i).padStart(2, "0")}`, companyName: `Co ${i}`, assignedTo: owner });
    expect(r.status).toBe(201);
    out.push(r.body.lead);
  }
  return out;
}

describe("POST /leads/bulk-assign", () => {
  it("sets the owner on every lead, writes ONE assignment activity each, and cascades open auto-tasks", async () => {
    const leads = await seed(3);
    // One open auto-task and one manual task on the first lead: only the auto one follows the owner.
    await Task.create({ title: "auto", linkedType: "LEAD", linkedId: leads[0]._id, status: "OPEN", assignedTo: new mongoose.Types.ObjectId(ids.REP_A), autoTriggerKey: "lead.created", createdBy: new mongoose.Types.ObjectId(ids.ADMIN) } as any);
    await Task.create({ title: "manual", linkedType: "LEAD", linkedId: leads[0]._id, status: "OPEN", assignedTo: new mongoose.Types.ObjectId(ids.REP_A), createdBy: new mongoose.Types.ObjectId(ids.ADMIN) } as any);
    const activitiesBefore = await LeadActivity.countDocuments({ type: "assignment" });

    const r = await bulk({ leadIds: leads.map((l) => l._id), assignedTo: ids.REP_B });
    expect(r.status).toBe(200);
    expect(r.body.assignedToName).toBe("Neelanchal Bhargava");
    expect(r.body.summary).toEqual({ requested: 3, updated: 3, failed: 0 });
    expect(r.body.failed).toEqual([]);
    expect(r.body.updated.map((u: any) => [u.leadCode, u.previousOwnerName, u.unchanged])).toEqual(leads.map((l) => [l.leadCode, "Imran", false]));

    const rows = (await Lead.find({}).lean()) as any[];
    expect(rows.every((l) => String(l.assignedTo) === ids.REP_B && l.assignedToName === "Neelanchal Bhargava")).toBe(true);

    const acts = (await LeadActivity.find({ type: "assignment" }).lean()) as any[];
    expect(acts.length - activitiesBefore).toBe(3);
    for (const l of leads) {
      const mine = acts.filter((a) => String(a.leadId) === l._id && a.note.startsWith("Reassigned"));
      expect(mine).toHaveLength(1);
      expect(mine[0].note).toBe("Reassigned to Neelanchal Bhargava (from Imran)");
      expect(mine[0].createdByName).toBe("Ops Admin");
      expect(String(mine[0].createdBy)).toBe(ids.ADMIN);
    }

    // Cascade is fire-and-forget on the route; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const auto = await Task.findOne({ title: "auto" }).lean();
    const manual = await Task.findOne({ title: "manual" }).lean();
    expect(String(auto!.assignedTo)).toBe(ids.REP_B);
    expect(String(manual!.assignedTo)).toBe(ids.REP_A);
  });

  it("refuses a WRITE-only caller (FULL gate, same as single assign) and changes nothing", async () => {
    const leads = await seed(2, ids.WRITER);
    caller.current = "WRITER";

    const r = await bulk({ leadIds: leads.map((l) => l._id), assignedTo: ids.REP_B });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Full access/);

    // The single route holds the same line.
    const single = await request(app()).post(`/api/leads/${leads[0]._id}/assign`).send({ userId: ids.REP_B });
    expect(single.status).toBe(403);

    const rows = (await Lead.find({}).lean()) as any[];
    expect(rows.every((l) => String(l.assignedTo) === ids.WRITER)).toBe(true);
    expect(await LeadActivity.countDocuments({ type: "assignment", note: /Reassigned/ })).toBe(0);
  });

  it("enforces the 200-lead cap before touching anything", async () => {
    const leads = await seed(1);
    const many = Array.from({ length: 201 }, () => new mongoose.Types.ObjectId().toHexString());
    const r = await bulk({ leadIds: [...many, leads[0]._id], assignedTo: ids.REP_B });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/At most 200/);
    const row = await Lead.findById(leads[0]._id).lean();
    expect(String(row!.assignedTo)).toBe(ids.REP_A);
  });

  it("reports a partial failure per lead instead of swallowing it", async () => {
    const leads = await seed(2);
    const missing = new mongoose.Types.ObjectId().toHexString();
    const r = await bulk({ leadIds: [leads[0]._id, missing, "not-an-id", leads[1]._id], assignedTo: ids.REP_B });
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ requested: 4, updated: 2, failed: 2 });
    expect(r.body.failed).toEqual(
      expect.arrayContaining([
        { _id: missing, reason: "Lead not found." },
        { _id: "not-an-id", reason: "Invalid lead ID." },
      ])
    );
    const rows = (await Lead.find({}).lean()) as any[];
    expect(rows.every((l) => String(l.assignedTo) === ids.REP_B)).toBe(true);
    expect(await LeadActivity.countDocuments({ type: "assignment", note: /Reassigned/ })).toBe(2);
  });

  it("validates the rep and the ids", async () => {
    const leads = await seed(1);
    expect((await bulk({ leadIds: leads.map((l) => l._id), assignedTo: "nope" })).status).toBe(400);
    expect((await bulk({ leadIds: leads.map((l) => l._id), assignedTo: new mongoose.Types.ObjectId().toHexString() })).status).toBe(404);
    expect((await bulk({ leadIds: [], assignedTo: ids.REP_B })).status).toBe(400);
    const row = await Lead.findById(leads[0]._id).lean();
    expect(String(row!.assignedTo)).toBe(ids.REP_A);
  });
});
