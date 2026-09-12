// Slice 2 — the legacy lead routes under CRM_V2_OPPORTUNITY, end to end
// through supertest on real collections. The unchanged frontend still sends
// the 9 legacy stage values; with the flag ON the routes must create /
// advance / close the Opportunity and fire the new-taxonomy triggers (with
// legacy TaskAutomation rows honoured as aliases). With the flag OFF nothing
// new is written — byte-for-byte legacy.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-opp-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: ADMIN_ID, sub: ADMIN_ID, roles: ["ADMIN"], email: "ops@plumtrips.com", name: "Ops Admin" };
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
const { default: Task } = await import("../models/Task.js");
const { default: TaskAutomation } = await import("../models/TaskAutomation.js");
const { default: User } = await import("../models/User.js");
const { default: router } = await import("./leads.js");
const { CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");
const { SYSTEM_WORKSPACE_ID } = await import("../config/defaultTaskAutomations.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/leads", router);
  return a;
}
function flag(on: boolean) {
  if (on) process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
  else delete process.env[CRM_V2_OPPORTUNITY_ENV];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(ADMIN_ID), name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" } as any);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({}), Task.deleteMany({}), TaskAutomation.deleteMany({})]);
});
afterEach(() => flag(false));

async function createLead(body: Record<string, any> = {}) {
  const r = await request(app()).post("/api/leads").send({ contactName: "Priya", contactPhone: "9999999999", companyName: "Acme", dealValue: 100000, ...body });
  expect(r.status).toBe(201);
  return r.body.lead as any;
}

describe("flag OFF — byte-for-byte legacy", () => {
  it("stage moves write no status, no opportunity, legacy activity shape, legacy trigger", async () => {
    flag(false);
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "lead.stage_proposal", label: "x", entityType: "LEAD", titleTemplate: "Follow up {{leadName}}", dueOffsetMinutes: 10, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: [] });
    const lead = await createLead();
    const r = await request(app()).put(`/api/leads/${lead._id}/stage`).send({ stage: "proposal_sent" });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty("opportunityId");
    expect(await Opportunity.countDocuments({})).toBe(0);
    const raw = await Lead.collection.findOne({ _id: new mongoose.Types.ObjectId(lead._id) });
    expect(raw!.stage).toBe("proposal_sent");
    expect(raw!.status).toBeNull();
    const act = await LeadActivity.findOne({ leadId: lead._id, type: "stage_change" }).lean();
    expect(act).toMatchObject({ fromStage: "new", toStage: "proposal_sent" });
    expect(act).not.toHaveProperty("subject");
    expect(act).not.toHaveProperty("toStatus");
    await sleep(50);
    const task = await Task.findOne({ linkedId: lead._id }).lean();
    expect(task?.autoTriggerKey).toBe("lead.stage_proposal");
    expect(task?.linkedType).toBe("LEAD");
  });
});

describe("flag ON — Lead + Opportunity", () => {
  beforeEach(() => flag(true));

  it("POST / derives status NEW and sourceChannel from source", async () => {
    const lead = await createLead({ source: "referral" });
    expect(lead.status).toBe("NEW");
    expect(lead.sourceChannel).toBe("referral");
    expect(lead.stage).toBe("new");
  });

  it("PUT /:id refuses client-set status / opportunityId (server-derived)", async () => {
    const lead = await createLead();
    const r = await request(app()).put(`/api/leads/${lead._id}`).send({ status: "CONVERTED", opportunityId: new mongoose.Types.ObjectId().toHexString(), notes: "ok" });
    expect(r.status).toBe(200);
    expect(r.body.lead.status).toBe("NEW");
    expect(r.body.lead.opportunityId).toBeNull();
    expect(r.body.lead.notes).toBe("ok");
  });

  it("stage → proposal_sent creates the Opportunity, records both vocabularies, fires opportunity.stage_proposal via the LEGACY alias row", async () => {
    // Only the legacy row exists (as in prod today) — the alias lookup must find it.
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "lead.stage_proposal", label: "x", entityType: "LEAD", titleTemplate: "Follow up {{leadName}}", dueOffsetMinutes: 10, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: [] });
    const lead = await createLead();
    const r = await request(app()).put(`/api/leads/${lead._id}/stage`).send({ stage: "proposal_sent" });
    expect(r.status).toBe(200);
    expect(r.body.lead.status).toBe("CONVERTED");
    expect(r.body.lead.stage).toBe("proposal_sent");
    expect(r.body.opportunityId).toBeTruthy();

    const opp = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(opp).toMatchObject({ pipeline: "corporate", stage: "proposal", dealValue: 100000, automatedByRule: "", legacyLeadStage: "proposal_sent" });
    expect(String(opp!.ownerUserId)).toBe(ADMIN_ID);

    const acts = await LeadActivity.find({ leadId: lead._id, type: "stage_change" }).sort({ createdAt: 1 }).lean();
    const leadRow = acts.find((a: any) => a.subject?.type === "LEAD") as any;
    const oppRow = acts.find((a: any) => a.subject?.type === "OPPORTUNITY") as any;
    expect(leadRow).toMatchObject({ fromStage: "new", toStage: "proposal_sent", fromStatus: "NEW", toStatus: "CONVERTED" });
    expect(oppRow).toMatchObject({ fromStage: "", toStage: "proposal" });

    await sleep(50);
    const task = await Task.findOne({ linkedId: opp!._id }).lean();
    expect(task).not.toBeNull();
    expect(task!.autoTriggerKey).toBe("opportunity.stage_proposal");
    expect(task!.linkedType).toBe("OPPORTUNITY");
    expect(await Task.countDocuments({})).toBe(1); // no second task from the legacy key

    // GET /:id carries the opportunity
    const g = await request(app()).get(`/api/leads/${lead._id}`);
    expect(g.body.opportunity?._id).toBe(String(opp!._id));
  });

  it("a new-key TaskAutomation row wins over the legacy alias when both exist", async () => {
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "lead.stage_proposal", label: "legacy", entityType: "LEAD", titleTemplate: "LEGACY {{leadName}}", dueOffsetMinutes: 10, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: [] });
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "opportunity.stage_proposal", label: "new", entityType: "OPPORTUNITY", titleTemplate: "NEW {{leadName}}", dueOffsetMinutes: 10, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: [] });
    const lead = await createLead();
    await request(app()).put(`/api/leads/${lead._id}/stage`).send({ stage: "proposal_sent" });
    await sleep(50);
    const tasks = await Task.find({}).lean();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("NEW Priya");
  });

  it("proposal_sent → negotiation advances the same Opportunity; demo_scheduled logs a demo; lose closes it", async () => {
    const lead = await createLead({ type: "individual", companyName: "" });
    await request(app()).put(`/api/leads/${lead._id}/stage`).send({ stage: "demo_scheduled" });
    expect(await LeadActivity.countDocuments({ leadId: lead._id, type: "demo" })).toBe(1);
    expect(await Opportunity.countDocuments({})).toBe(0);

    await request(app()).put(`/api/leads/${lead._id}/stage`).send({ stage: "proposal_sent" });
    await request(app()).put(`/api/leads/${lead._id}/stage`).send({ stage: "negotiation" });
    expect(await Opportunity.countDocuments({ leadId: lead._id })).toBe(1);
    let opp = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(opp).toMatchObject({ pipeline: "travel_enquiry", stage: "decision", probability: 75 });

    const lose = await request(app()).post(`/api/leads/${lead._id}/lose`).send({ lostReason: "Went elsewhere" });
    expect(lose.status).toBe(200);
    opp = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(opp).toMatchObject({ stage: "closed_lost", lostReason: "Went elsewhere" });
    expect(opp!.closedAt).toBeInstanceOf(Date);
    const raw = await Lead.collection.findOne({ _id: new mongoose.Types.ObjectId(lead._id) });
    expect(raw!.stage).toBe("lost");
    expect(raw!.status).toBe("CONVERTED"); // the loss is the deal's, the lead was converted
  });

  it("lose on a lead that never reached a deal is LOST at lead grain — no Opportunity", async () => {
    const lead = await createLead();
    await request(app()).put(`/api/leads/${lead._id}/stage`).send({ stage: "contacted" });
    await request(app()).post(`/api/leads/${lead._id}/lose`).send({ lostReason: "No need" });
    expect(await Opportunity.countDocuments({})).toBe(0);
    const raw = await Lead.collection.findOne({ _id: new mongoose.Types.ObjectId(lead._id) });
    expect(raw!.status).toBe("LOST");
    expect(raw!.lostReason).toBe("No need");
  });

  it("/win creates a Closed Won Opportunity linked to the auto-created contact and fires opportunity.won (alias lead.won)", async () => {
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "lead.won", label: "x", entityType: "LEAD", titleTemplate: "Onboard {{leadName}}", dueOffsetMinutes: 10, priority: "HIGH", assigneeRule: { type: "OWNER" }, tags: [] });
    const lead = await createLead();
    const r = await request(app()).post(`/api/leads/${lead._id}/win`);
    expect(r.status).toBe(200);
    const opp = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(opp).toMatchObject({ stage: "closed_won", probability: 100, dealValue: 100000 });
    const raw = await Lead.collection.findOne({ _id: new mongoose.Types.ObjectId(lead._id) });
    expect(raw!.stage).toBe("won");
    expect(raw!.status).toBe("CONVERTED");
    expect(String(opp!.primaryContactId)).toBe(String(raw!.convertedToContactId));
    expect(String(raw!.opportunityId)).toBe(String(opp!._id));
    await sleep(50);
    const tasks = await Task.find({}).lean();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].autoTriggerKey).toBe("opportunity.won");
    expect(String(tasks[0].linkedId)).toBe(String(opp!._id));
  });

  it("POST /:id/activity accepts the new `demo` type", async () => {
    const lead = await createLead();
    const r = await request(app()).post(`/api/leads/${lead._id}/activity`).send({ type: "demo", note: "Product walkthrough" });
    expect(r.status).toBe(201);
    expect(r.body.activity.type).toBe("demo");
  });
});
