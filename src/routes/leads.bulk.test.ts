// POST /leads/bulk — bulk actions (reassign / stage / status / disposition)
// against REAL collections (mongodb-memory-server), both CRM_V2 flags on.
// What matters is what lands: a filter target resolves the WHOLE matching set
// server-side (one call for an owner's every lead), each lead goes through
// the single-lead write path (activity per lead, opportunity + contact for a
// Won disposition), scope is honoured, bad input is refused before any write,
// and re-running is idempotent (unchanged, not rewritten).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-bulk-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ids = vi.hoisted(() => ({
  ADMIN: "66b000000000000000000001",
  WRITER: "66b000000000000000000002",
  FULLOWN: "66b000000000000000000005",
  REP_A: "66b000000000000000000003",
  REP_B: "66b000000000000000000004",
}));
const caller = vi.hoisted(() => ({ current: "ADMIN" as "ADMIN" | "WRITER" | "FULLOWN" }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user =
      caller.current === "ADMIN"
        ? { id: ids.ADMIN, sub: ids.ADMIN, roles: ["ADMIN"], email: "ops@plumtrips.com" }
        : caller.current === "FULLOWN"
          ? { id: ids.FULLOWN, sub: ids.FULLOWN, roles: ["EMPLOYEE"], email: "fullown@plumtrips.com" }
          : { id: ids.WRITER, sub: ids.WRITER, roles: ["EMPLOYEE"], email: "writer@plumtrips.com" };
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
const { default: Opportunity } = await import("../models/Opportunity.js");
const { default: CRMContact } = await import("../models/CRMContact.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { default: Task } = await import("../models/Task.js");
const { default: User } = await import("../models/User.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: router } = await import("./leads.js");
const { CRM_V2_DISPOSITION_ENV, CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");
const { BULK_CAP } = await import("../services/leadBulk.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json({ limit: "5mb" }));
  a.use("/api/leads", router);
  return a;
}
const bulk = (body: Record<string, unknown>) => request(app()).post("/api/leads/bulk").send(body);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
  await User.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(ids.ADMIN), name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" },
    { _id: new mongoose.Types.ObjectId(ids.WRITER), name: "Write Only", email: "writer@plumtrips.com", roles: ["EMPLOYEE"], passwordHash: "x" },
    { _id: new mongoose.Types.ObjectId(ids.FULLOWN), name: "Full Own", email: "fullown@plumtrips.com", roles: ["EMPLOYEE"], passwordHash: "x" },
    { _id: new mongoose.Types.ObjectId(ids.REP_A), name: "Deepika Sachdev", email: "deepika@plumtrips.com", roles: ["EMPLOYEE"], passwordHash: "x" },
    { _id: new mongoose.Types.ObjectId(ids.REP_B), name: "Nikita", email: "nikita@plumtrips.com", roles: ["EMPLOYEE"], passwordHash: "x" },
  ] as any[]);
  const perm = (userId: string, email: string, access: string, scope: string) => ({
    userId, email, workspaceId: "69679a7628330a58d29f2254", universe: "STAFF", level: { code: "L2", name: "Executive" },
    modules: { leads: { access, scope } }, grantedBy: ids.ADMIN,
  });
  await UserPermission.create([perm(ids.WRITER, "writer@plumtrips.com", "WRITE", "OWN"), perm(ids.FULLOWN, "fullown@plumtrips.com", "FULL", "OWN")] as any);
  process.env[CRM_V2_DISPOSITION_ENV] = "true";
  process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
}, 120_000);
afterAll(async () => {
  delete process.env[CRM_V2_DISPOSITION_ENV];
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  caller.current = "ADMIN";
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({}), CRMContact.deleteMany({}), CRMCompany.deleteMany({}), Task.deleteMany({})]);
});

async function seed(n: number, owner = ids.REP_A, extra: Record<string, unknown> = {}) {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const r = await request(app()).post("/api/leads").send({ contactName: `Person ${owner.slice(-1)}${i}`, contactPhone: `9811${owner.slice(-2)}00${String(i).padStart(2, "0")}`, contactEmail: `p${owner.slice(-1)}${i}@co.test`, companyName: `Co ${owner.slice(-1)}${i}`, assignedTo: owner, ...extra });
    expect(r.status).toBe(201);
    out.push(r.body.lead);
  }
  return out;
}

describe("POST /leads/bulk — target resolution", () => {
  it("filter target: reassigns EVERY lead matching an owner filter in one call — not just a page", async () => {
    const mine = await seed(25, ids.REP_A); // > one table page
    const theirs = await seed(3, ids.REP_B);
    const r = await bulk({ action: "reassign", target: { filter: { assignedTo: ids.REP_A } }, params: { assignedTo: ids.REP_B } });
    expect(r.status).toBe(200);
    expect(r.body.target).toEqual({ mode: "filter", matched: 25 });
    expect(r.body.summary).toEqual({ requested: 25, updated: 25, unchanged: 0, failed: 0 });
    expect(r.body.batchId).toMatch(/^BLK-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    expect(r.body.updated.every((u: any) => u.from === "Deepika Sachdev" && u.to === "Nikita" && !u.unchanged)).toBe(true);

    expect(await Lead.countDocuments({ assignedTo: new mongoose.Types.ObjectId(ids.REP_B), assignedToName: "Nikita" })).toBe(28);
    expect(await Lead.countDocuments({ assignedTo: new mongoose.Types.ObjectId(ids.REP_A) })).toBe(0);
    // One assignment activity per moved lead, tagged with the batch; the untouched 3 got none.
    const acts = (await LeadActivity.find({ type: "assignment", note: new RegExp(`bulk ${r.body.batchId}`) }).lean()) as any[];
    expect(acts).toHaveLength(25);
    expect(new Set(acts.map((a) => String(a.leadId)))).toEqual(new Set(mine.map((l) => l._id)));
    expect(acts[0].note).toBe(`Reassigned to Nikita (from Deepika Sachdev) (bulk ${r.body.batchId})`);
    expect(acts[0].createdByName).toBe("Ops Admin");
    expect(await LeadActivity.countDocuments({ leadId: { $in: theirs.map((l) => new mongoose.Types.ObjectId(l._id)) }, type: "assignment" })).toBe(0);

    // Re-running the same bulk is idempotent: nothing left matches the filter.
    const again = await bulk({ action: "reassign", target: { filter: { assignedTo: ids.REP_A } }, params: { assignedTo: ids.REP_B } });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ error: "No leads match this filter.", matched: 0 });
  });

  it("filter target honours search / stage / source exactly like GET /leads", async () => {
    await seed(2, ids.REP_A, { source: "linkedin" });
    await seed(2, ids.REP_A, { source: "referral" });
    const r = await bulk({ action: "reassign", target: { filter: { source: "referral" } }, params: { assignedTo: ids.REP_B } });
    expect(r.status).toBe(200);
    expect(r.body.summary.updated).toBe(2);
    expect(await Lead.countDocuments({ source: "referral", assignedToName: "Nikita" })).toBe(2);
    expect(await Lead.countDocuments({ source: "linkedin", assignedToName: "Deepika Sachdev" })).toBe(2);
  });

  it("ids target: applies to exactly those ids; a bad / missing id fails per lead and the rest land", async () => {
    const leads = await seed(3);
    const ghost = new mongoose.Types.ObjectId().toHexString();
    const r = await bulk({ action: "reassign", target: { leadIds: [leads[0]._id, leads[1]._id, ghost, "nope"] }, params: { assignedTo: ids.REP_B } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ requested: 4, updated: 2, unchanged: 0, failed: 2 });
    expect(r.body.failed).toEqual([{ _id: ghost, leadCode: "", reason: "Lead not found." }, { _id: "nope", leadCode: "", reason: "Invalid lead ID." }]);
    expect((await Lead.findById(leads[2]._id).lean())!.assignedToName).toBe("Deepika Sachdev");
  });

  it("caps a bulk at BULK_CAP and refuses before any write; refuses an empty / malformed target", async () => {
    const many = Array.from({ length: BULK_CAP + 1 }, () => new mongoose.Types.ObjectId().toHexString());
    const r = await bulk({ action: "reassign", target: { leadIds: many }, params: { assignedTo: ids.REP_B } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ cap: BULK_CAP, matched: BULK_CAP + 1 });
    expect((await bulk({ action: "reassign", target: { leadIds: [] }, params: { assignedTo: ids.REP_B } })).status).toBe(400);
    expect((await bulk({ action: "reassign", target: {}, params: { assignedTo: ids.REP_B } })).body.error).toBe("target must carry leadIds[] or a filter.");
    expect((await bulk({ action: "delete", target: { leadIds: [new mongoose.Types.ObjectId().toHexString()] }, params: {} })).body.error).toMatch(/action must be one of/);
  });
});

describe("POST /leads/bulk — actions", () => {
  it("stage: every lead moves, one stage_change each (both vocabularies), proposal_sent builds the opportunity; unchanged leads are not rewritten", async () => {
    const leads = await seed(3);
    await Lead.updateOne({ _id: leads[2]._id }, { $set: { stage: "proposal_sent", status: "CONVERTED" } });
    const r = await bulk({ action: "stage", target: { leadIds: leads.map((l) => l._id) }, params: { stage: "proposal_sent", note: "Proposal batch sent" } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ requested: 3, updated: 2, unchanged: 1, failed: 0 });
    const rows = (await Lead.find({}).sort({ leadCode: 1 }).lean()) as any[];
    expect(rows.map((l) => [l.stage, l.status])).toEqual([["proposal_sent", "CONVERTED"], ["proposal_sent", "CONVERTED"], ["proposal_sent", "CONVERTED"]]);
    // The two moved leads each got an opportunity (the split), the pre-existing one was left alone.
    expect(await Opportunity.countDocuments({})).toBe(2);
    const moved = r.body.updated.filter((u: any) => !u.unchanged);
    expect(moved.every((u: any) => u.opportunityId)).toBe(true);
    // LEAD-subject rows only: the split also logs an OPPORTUNITY-subject stage_change per deal it opened.
    const acts = (await LeadActivity.find({ type: "stage_change", "subject.type": "LEAD" }).lean()) as any[];
    expect(acts).toHaveLength(2);
    expect(await LeadActivity.countDocuments({ type: "stage_change", "subject.type": "OPPORTUNITY" })).toBe(2);
    expect(acts[0]).toMatchObject({ fromStage: "new", toStage: "proposal_sent", fromStatus: "NEW", toStatus: "CONVERTED", note: `Proposal batch sent (bulk ${r.body.batchId})`, createdByName: "Ops Admin" });
  });

  it("stage: follow_up requires a date and a note — refused before any write", async () => {
    const leads = await seed(2);
    const r = await bulk({ action: "stage", target: { leadIds: leads.map((l) => l._id) }, params: { stage: "follow_up" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("nextFollowUpDate is required for follow_up stage.");
    const r2 = await bulk({ action: "stage", target: { leadIds: leads.map((l) => l._id) }, params: { stage: "follow_up", nextFollowUpDate: "2026-09-20" } });
    expect(r2.body.error).toBe("A note is required when moving leads to follow_up.");
    expect(await Lead.countDocuments({ stage: "follow_up" })).toBe(0);
    const ok = await bulk({ action: "stage", target: { leadIds: leads.map((l) => l._id) }, params: { stage: "follow_up", nextFollowUpDate: "2026-09-20", note: "Call after the demo" } });
    expect(ok.body.summary.updated).toBe(2);
    expect(await Lead.countDocuments({ stage: "follow_up", nextFollowUpDate: new Date("2026-09-20") })).toBe(2);
  });

  it("status: sets the Slice-2 status, the model derives the legacy stage, one stage_change each", async () => {
    const leads = await seed(2);
    const r = await bulk({ action: "status", target: { leadIds: leads.map((l) => l._id) }, params: { status: "contacted" } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ requested: 2, updated: 2, unchanged: 0, failed: 0 });
    const rows = (await Lead.find({}).lean()) as any[];
    expect(rows.every((l) => l.status === "CONTACTED" && l.stage === "contacted")).toBe(true);
    const acts = (await LeadActivity.find({ type: "stage_change" }).lean()) as any[];
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({ fromStatus: "NEW", toStatus: "CONTACTED", fromStage: "new", toStage: "contacted" });
    expect((await bulk({ action: "status", target: { leadIds: [leads[0]._id] }, params: { status: "banana" } })).body.error).toMatch(/Invalid status/);
  });

  it("disposition: Onboarded on a set builds each lead's closed-won opportunity + CRM contact, exactly like single dispositions; a repeat is unchanged", async () => {
    const leads = await seed(3);
    const r = await bulk({ action: "disposition", target: { leadIds: leads.map((l) => l._id) }, params: { disposition: "Onboarded" } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ requested: 3, updated: 3, unchanged: 0, failed: 0 });
    expect(r.body.updated.every((u: any) => u.to === "Onboarded / Onboarded" && u.opportunityId && u.contactId)).toBe(true);

    const rows = (await Lead.find({}).lean()) as any[];
    expect(rows.every((l) => l.disposition === "Onboarded" && l.dispositionStatus === "Won" && l.stage === "won" && l.status === "CONVERTED" && l.opportunityId && l.convertedToContactId)).toBe(true);
    expect(await Opportunity.countDocuments({ stage: "closed_won" })).toBe(3);
    expect(await CRMContact.countDocuments({})).toBe(3);
    expect(await LeadActivity.countDocuments({ type: "disposition" })).toBe(3);
    const d = (await LeadActivity.findOne({ type: "disposition" }).lean()) as any;
    expect(d.note).toBe(`Onboarded — Onboarded (bulk ${r.body.batchId})`);
    expect(d.createdByName).toBe("Ops Admin");

    // Idempotent: the same bulk again touches nothing and duplicates nothing.
    const again = await bulk({ action: "disposition", target: { leadIds: leads.map((l) => l._id) }, params: { subDisposition: "Onboarded" } });
    expect(again.body.summary).toEqual({ requested: 3, updated: 0, unchanged: 3, failed: 0 });
    expect(await Opportunity.countDocuments({})).toBe(3);
    expect(await CRMContact.countDocuments({})).toBe(3);
    expect(await LeadActivity.countDocuments({ type: "disposition" })).toBe(3);
  });

  it("disposition: the pair is validated up front — wrong parent, unknown sub, missing follow-up date — nothing written", async () => {
    const leads = await seed(2);
    const idsOnly = leads.map((l) => l._id);
    expect((await bulk({ action: "disposition", target: { leadIds: idsOnly }, params: { disposition: "Interested", subDisposition: "Trust Issue" } })).body.error).toBe('Sub-disposition "Trust Issue" belongs to "Not Interested", not "Interested"');
    expect((await bulk({ action: "disposition", target: { leadIds: idsOnly }, params: { subDisposition: "Nope" } })).body.error).toMatch(/is not a sub-disposition/);
    expect((await bulk({ action: "disposition", target: { leadIds: idsOnly }, params: { disposition: "Interested" } })).body.error).toMatch(/needs a subDisposition/);
    expect((await bulk({ action: "disposition", target: { leadIds: idsOnly }, params: { subDisposition: "Follow up Required" } })).body.error).toBe('"Follow up Required" needs a next follow-up date.');
    expect(await LeadActivity.countDocuments({ type: "disposition" })).toBe(0);
    expect(await Opportunity.countDocuments({})).toBe(0);

    const ok = await bulk({ action: "disposition", target: { leadIds: idsOnly }, params: { subDisposition: "Follow up Required", nextFollowUpDate: "2026-09-22", note: "Send the deck" } });
    expect(ok.body.summary.updated).toBe(2);
    expect(await Opportunity.countDocuments({ stage: "qualified" })).toBe(2);
    expect(await Lead.countDocuments({ subDisposition: "Follow up Required", followUpNotes: "Send the deck", nextFollowUpDate: new Date("2026-09-22") })).toBe(2);
  });
});

describe("POST /leads/bulk — access + scope", () => {
  it("WRITE access is refused outright (FULL needed), nothing written", async () => {
    const leads = await seed(2);
    caller.current = "WRITER";
    const r = await bulk({ action: "stage", target: { leadIds: leads.map((l) => l._id) }, params: { stage: "contacted" } });
    expect(r.status).toBe(403);
    expect(await Lead.countDocuments({ stage: "contacted" })).toBe(0);
  });

  it("FULL + OWN: a filter target is narrowed to the caller's own leads; a foreign id fails per lead", async () => {
    const mine = await seed(2, ids.FULLOWN);
    const theirs = await seed(2, ids.REP_A);
    caller.current = "FULLOWN";
    // Filter asks for another rep's leads — OWN scope pins assignedTo to the caller; those two are the only rows touched.
    const r = await bulk({ action: "stage", target: { filter: { assignedTo: ids.REP_A } }, params: { stage: "contacted" } });
    expect(r.status).toBe(200);
    expect(r.body.target.matched).toBe(2);
    expect(new Set(r.body.updated.map((u: any) => u._id))).toEqual(new Set(mine.map((l) => l._id)));
    expect(await Lead.countDocuments({ assignedTo: new mongoose.Types.ObjectId(ids.REP_A), stage: "contacted" })).toBe(0);

    const r2 = await bulk({ action: "reassign", target: { leadIds: [mine[0]._id, theirs[0]._id] }, params: { assignedTo: ids.REP_B } });
    expect(r2.status).toBe(200);
    expect(r2.body.summary).toEqual({ requested: 2, updated: 1, unchanged: 0, failed: 1 });
    expect(r2.body.failed[0]).toMatchObject({ _id: theirs[0]._id, reason: "This lead is owned by someone else." });
    expect((await Lead.findById(theirs[0]._id).lean())!.assignedToName).toBe("Deepika Sachdev");
  });
});

describe("GET /leads/dispositions", () => {
  it("returns the default pipeline's grouped set for the bulk picker", async () => {
    const r = await request(app()).get("/api/leads/dispositions");
    expect(r.status).toBe(200);
    expect(r.body.pipeline.key).toBe("corporate_calling");
    expect(r.body.canWork).toBe(true);
    expect(r.body.groups.map((g: any) => g.disposition)).toEqual(["Call Back", "Interested", "Not Interested", "Not Connected", "Onboarded"]);
    expect(r.body.groups[1].subs[0]).toMatchObject({ subDisposition: "Follow up Required", nextTouch: true, opportunityEffect: "open", opportunityStage: "qualified" });
  });
});
