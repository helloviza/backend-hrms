// Disposition slice — the seed set is transcribed from the sheet EXACTLY,
// the derivation is data-driven off the pipeline row, every write appends one
// explainable activity, and the shadow opportunity fires/syncs/closes without
// the rep ever touching it. Real collections on mongodb-memory-server.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import { vi } from "vitest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/disposition-test";
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

const { CORPORATE_CALLING_SET, validateDispositionSet, DISPOSITION_STAGES, DISPOSITION_STATUSES } = await import("../models/crmDisposition.js");
const { default: CrmPipeline } = await import("../models/CrmPipeline.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: Opportunity } = await import("../models/Opportunity.js");
const { default: User } = await import("../models/User.js");
const { ensureDefaultPipeline, findEntry, groupedSet, canWorkPipeline } = await import("./crmPipelines.js");
const { applyDisposition, snapshotOf, DispositionError } = await import("./disposition.js");
const { default: router } = await import("../routes/leads.js");
const { CRM_V2_DISPOSITION_ENV, CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
  await CrmPipeline.syncIndexes();
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(ADMIN_ID), name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" } as any);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({}), CrmPipeline.deleteMany({})]);
  process.env[CRM_V2_DISPOSITION_ENV] = "true";
  process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
});
afterEach(() => {
  delete process.env[CRM_V2_DISPOSITION_ENV];
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
});

const ACTOR = { id: ADMIN_ID, roles: ["ADMIN"], name: "Ops Admin" };
async function freshLead(over: Record<string, any> = {}) {
  return Lead.create({ contactName: "Priya", contactPhone: "9880123456", companyName: "Zepto", dealValue: 450000, assignedTo: ADMIN_ID, assignedToName: "Ops Admin", ...over });
}
const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/leads", router);
  return a;
};

/* ───────────────────────── the set ───────────────────────── */

describe("Corporate Calling disposition set (from the sheet)", () => {
  it("is structurally valid and matches the sheet exactly", () => {
    expect(validateDispositionSet(CORPORATE_CALLING_SET)).toEqual([]);
    const by = (d: string) => CORPORATE_CALLING_SET.filter((e) => e.disposition === d);
    expect(by("Call Back").map((e) => e.subDisposition)).toEqual(["Call Back Time Given", "Call Back Time Not Given"]);
    expect(by("Interested").map((e) => e.subDisposition)).toEqual([
      "Follow up Required", "Introduction Email Sent", "Proposal Mail Required", "Proposal Mail Sent",
      "Demo Scheduled", "Negotiation in Progress", "Agreement in Progress", "NDA in Progress",
    ]);
    expect(by("Not Interested").map((e) => e.subDisposition)).toEqual([
      "Stopped Answering Call", "Not Interested for Services", "Other Vendor onboarded", "Working with other vendors",
      "Trust Issue", "Not A right party contact", "Travel Desk Not Required", "Visa Services Not Required", "No Use Case Available",
    ]);
    expect(by("Not Connected").map((e) => [e.subDisposition, e.stage, e.status])).toEqual([
      ["Number Does not Exist", "Lost", "Lost"], ["Switched off", "NC", "Open"], ["Ringing Only", "NC", "Open"], ["Temp out of Service", "Lost", "Lost"],
    ]);
    expect(by("Onboarded")).toHaveLength(1);
    expect(by("Onboarded")[0]).toMatchObject({ stage: "Onboarded", status: "Won", opportunityEffect: "won" });
    // derived pairs
    for (const e of by("Call Back")) expect([e.stage, e.status]).toEqual(["In-progress", "Open"]);
    for (const e of by("Interested")) expect([e.stage, e.status, e.opportunityEffect]).toEqual(["In-progress", "Open", "open"]);
    for (const e of by("Not Interested")) expect([e.stage, e.status]).toEqual(["Lost", "Lost"]);
    expect(CORPORATE_CALLING_SET).toHaveLength(24);
    expect(DISPOSITION_STAGES).toEqual(["Prospect", "In-progress", "Lost", "Onboarded", "NC"]);
    expect(DISPOSITION_STATUSES).toEqual(["Open", "In-progress", "Lost", "Won"]);
  });

  it("rejects a malformed set", () => {
    expect(validateDispositionSet([{ ...CORPORATE_CALLING_SET[0] }, { ...CORPORATE_CALLING_SET[0] }])).toContain('duplicate sub-disposition "Call Back Time Given"');
    expect(validateDispositionSet([{ ...CORPORATE_CALLING_SET[2], opportunityStage: undefined }])[0]).toMatch(/needs opportunityStage/);
  });
});

/* ───────────────────────── pipeline (data) ───────────────────────── */

describe("CrmPipeline — the set lives on the pipeline row", () => {
  it("seeds Corporate Calling once, idempotently, and validates stages against the deal pipeline", async () => {
    const a = await ensureDefaultPipeline();
    const b = await ensureDefaultPipeline();
    expect(String(a._id)).toBe(String(b._id));
    expect(await CrmPipeline.countDocuments({})).toBe(1);
    expect(a).toMatchObject({ key: "corporate_calling", name: "Corporate Calling", opportunityPipeline: "corporate", isDefault: true });
    expect(a.dispositionSet).toHaveLength(24);
    expect(groupedSet(a).map((g) => g.disposition)).toEqual(["Call Back", "Interested", "Not Interested", "Not Connected", "Onboarded"]);
    expect(findEntry(a, "  proposal mail sent ")!.opportunityStage).toBe("proposal");
    expect(findEntry(a, "nope")).toBeNull();

    // a second pipeline with its own set is just data
    await CrmPipeline.create({ key: "partner_calling", name: "Partner Calling", opportunityPipeline: "partnerships", dispositionSet: [
      { disposition: "Interested", subDisposition: "Fit call done", stage: "In-progress", status: "Open", nextTouch: false, opportunityEffect: "open", opportunityStage: "fit_confirmed", leadStatus: "CONVERTED", legacyStage: "demo_scheduled" },
    ] });
    expect(await CrmPipeline.countDocuments({})).toBe(2);
    await expect(CrmPipeline.create({ key: "bad", name: "Bad", opportunityPipeline: "corporate", dispositionSet: [
      { disposition: "X", subDisposition: "Y", stage: "In-progress", status: "Open", nextTouch: false, opportunityEffect: "open", opportunityStage: "fit_confirmed", leadStatus: "CONVERTED", legacyStage: "contacted" },
    ] })).rejects.toThrow(/not a stage of corporate/);
  });

  it("access seam: no teams → anyone the route admitted; teams → membership", () => {
    const open = { teamIds: [] as any[], active: true };
    expect(canWorkPipeline({ id: "u", roles: ["EMPLOYEE"] }, open)).toBe(true);
    const t = new mongoose.Types.ObjectId();
    const scoped = { teamIds: [t], active: true };
    expect(canWorkPipeline({ id: "u", roles: ["EMPLOYEE"] }, scoped)).toBe(false);
    expect(canWorkPipeline({ id: "u", roles: ["EMPLOYEE"], teamIds: [String(t)] }, scoped)).toBe(true);
    expect(canWorkPipeline({ id: "u", roles: ["ADMIN"] }, scoped)).toBe(true);
    expect(canWorkPipeline({ id: "u", roles: ["ADMIN"] }, { teamIds: [], active: false })).toBe(false);
  });
});

/* ───────────────────────── the cascade ───────────────────────── */

describe("applyDisposition — derivation, activity, shadow opportunity", () => {
  it("Fresh → Call Back Time Given → Interested (fires) → Proposal Mail Sent (syncs) → Onboarded (won)", async () => {
    const lead = await freshLead();
    expect(snapshotOf(lead)).toEqual({ disposition: "", subDisposition: "", stage: "Prospect", status: "Open" });

    // Call Back Time Given: needs a date; derives In-progress/Open; no opportunity
    await expect(applyDisposition(lead, { subDisposition: "Call Back Time Given", actor: ACTOR })).rejects.toThrow(/needs a next follow-up date/);
    const r1 = await applyDisposition(lead, { subDisposition: "Call Back Time Given", note: "Call after lunch", nextFollowUpDate: new Date(Date.now() + 86400000), actor: ACTOR });
    expect(r1.to).toEqual({ disposition: "Call Back", subDisposition: "Call Back Time Given", stage: "In-progress", status: "Open" });
    expect(r1.from.stage).toBe("Prospect");
    expect(r1.opportunity).toBeNull();
    let raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw).toMatchObject({ disposition: "Call Back", subDisposition: "Call Back Time Given", dispositionStage: "In-progress", dispositionStatus: "Open", stage: "follow_up", status: "CONTACTED", followUpNotes: "Call after lunch" });
    expect(raw!.pipelineId).toBeTruthy();
    expect(await Opportunity.countDocuments({})).toBe(0);

    // Interested / Follow up Required: shadow opportunity fires at "qualified"
    const r2 = await applyDisposition(lead, { subDisposition: "Follow up Required", nextFollowUpDate: new Date(Date.now() + 2 * 86400000), actor: ACTOR });
    expect(r2.opportunity).toMatchObject({ created: true, stage: "qualified", effect: "open" });
    const opp = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(opp).toMatchObject({ pipeline: "corporate", stage: "qualified", probability: 25, dealValue: 450000, name: "Zepto", automatedByRule: "", legacyLeadStage: "follow_up" });
    expect(String(opp!.ownerUserId)).toBe(ADMIN_ID);
    raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw!.status).toBe("CONVERTED");
    expect(String(raw!.opportunityId)).toBe(String(opp!._id));

    // Proposal Mail Sent: same opportunity, synced to "proposal"; dealValue synced
    lead.dealValue = 500000;
    const r3 = await applyDisposition(lead, { subDisposition: "Proposal Mail Sent", actor: ACTOR });
    expect(r3.opportunity).toMatchObject({ created: false, fromStage: "qualified", stage: "proposal" });
    expect(await Opportunity.countDocuments({ leadId: lead._id })).toBe(1);
    expect((await Opportunity.findOne({ leadId: lead._id }).lean())!.dealValue).toBe(500000);

    // Onboarded: won
    const r4 = await applyDisposition(lead, { subDisposition: "Onboarded", actor: ACTOR });
    expect(r4.to).toEqual({ disposition: "Onboarded", subDisposition: "Onboarded", stage: "Onboarded", status: "Won" });
    expect(r4.opportunity).toMatchObject({ created: false, fromStage: "proposal", stage: "closed_won", effect: "won" });
    const won = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(won!.probability).toBe(100);
    expect(won!.closedAt).toBeInstanceOf(Date);
    raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw).toMatchObject({ stage: "won", status: "CONVERTED", dispositionStatus: "Won" });
    expect(raw!.wonDate).toBeInstanceOf(Date);

    // one disposition activity per write (4) + opportunity rows for open/sync/won (3), all explainable
    const acts = await LeadActivity.find({ leadId: lead._id }).sort({ createdAt: 1 }).lean();
    const disp = acts.filter((a: any) => a.type === "disposition");
    expect(disp).toHaveLength(4);
    expect((disp[0] as any).disposition).toEqual({ from: { disposition: "", subDisposition: "", stage: "Prospect", status: "Open" }, to: { disposition: "Call Back", subDisposition: "Call Back Time Given", stage: "In-progress", status: "Open" } });
    expect((disp[3] as any).disposition.to.status).toBe("Won");
    const oppRows = acts.filter((a: any) => a.subject?.type === "OPPORTUNITY");
    expect(oppRows.map((a: any) => a.toStage)).toEqual(["qualified", "proposal", "closed_won"]);
  });

  it("Fresh → Not Interested → Lost at the lead grain, NO opportunity", async () => {
    const lead = await freshLead();
    const r = await applyDisposition(lead, { subDisposition: "Not Interested for Services", actor: ACTOR });
    expect(r.to).toMatchObject({ stage: "Lost", status: "Lost" });
    expect(r.opportunity).toBeNull();
    expect(await Opportunity.countDocuments({})).toBe(0);
    const raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw).toMatchObject({ stage: "lost", status: "LOST", lostReason: "Not Interested for Services", dispositionStatus: "Lost" });
  });

  it("Lost AFTER Interested → the opportunity is closed-lost (feeds win/loss)", async () => {
    const lead = await freshLead();
    await applyDisposition(lead, { subDisposition: "Introduction Email Sent", actor: ACTOR });
    const r = await applyDisposition(lead, { subDisposition: "Working with other vendors", actor: ACTOR });
    expect(r.opportunity).toMatchObject({ created: false, stage: "closed_lost", effect: "lost" });
    const opp = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(opp).toMatchObject({ stage: "closed_lost", lostReason: "Working with other vendors", probability: 0 });
    expect(opp!.closedAt).toBeInstanceOf(Date);
    expect(await Opportunity.countDocuments({})).toBe(1);

    // and Interested again reopens the same deal
    const r2 = await applyDisposition(lead, { subDisposition: "Negotiation in Progress", actor: ACTOR });
    expect(r2.opportunity).toMatchObject({ created: false, fromStage: "closed_lost", stage: "negotiation" });
    const re = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(re!.closedAt).toBeNull();
    expect(await Opportunity.countDocuments({})).toBe(1);
  });

  it("Not Connected: Switched off → NC/Open; Number Does not Exist → Lost; Onboarded first → won deal created", async () => {
    const a = await freshLead();
    expect((await applyDisposition(a, { subDisposition: "Switched off", actor: ACTOR })).to).toMatchObject({ stage: "NC", status: "Open" });
    expect((await Lead.collection.findOne({ _id: a._id }))!.stage).toBe("contacted");
    const b = await freshLead({ contactName: "B" });
    expect((await applyDisposition(b, { subDisposition: "Number Does not Exist", actor: ACTOR })).to).toMatchObject({ stage: "Lost", status: "Lost" });
    const c = await freshLead({ contactName: "C" });
    const r = await applyDisposition(c, { subDisposition: "Onboarded", actor: ACTOR });
    expect(r.opportunity).toMatchObject({ created: true, stage: "closed_won" });
  });

  it("idempotent against a pre-existing opportunity (e.g. from the Slice-2 migration)", async () => {
    const lead = await freshLead({ stage: "proposal_sent" });
    const existing = await Opportunity.create({ leadId: lead._id, pipeline: "corporate", stage: "proposal", dealValue: 1 });
    const r = await applyDisposition(lead, { subDisposition: "Demo Scheduled", actor: ACTOR });
    expect(r.opportunity!.id).toBe(String(existing._id));
    expect(r.opportunity).toMatchObject({ created: false, fromStage: "proposal", stage: "discovery" });
    expect(await Opportunity.countDocuments({ leadId: lead._id })).toBe(1);
  });

  it("unknown sub-disposition writes nothing", async () => {
    const lead = await freshLead();
    await expect(applyDisposition(lead, { subDisposition: "Ghosted", actor: ACTOR })).rejects.toBeInstanceOf(DispositionError);
    expect(await LeadActivity.countDocuments({})).toBe(0);
    expect((await Lead.collection.findOne({ _id: lead._id }))!.disposition).toBe("");
  });
});

/* ───────────────────────── routes ───────────────────────── */

describe("routes", () => {
  it("flag OFF: both routes are 404", async () => {
    delete process.env[CRM_V2_DISPOSITION_ENV];
    const lead = await freshLead();
    expect((await request(app()).get(`/api/leads/${lead._id}/dispositions`)).status).toBe(404);
    expect((await request(app()).post(`/api/leads/${lead._id}/disposition`).send({ subDisposition: "Onboarded" })).status).toBe(404);
    expect(await CrmPipeline.countDocuments({})).toBe(0);
  });

  it("flag ON: options are grouped from the lead's pipeline; POST returns the cascade", async () => {
    const lead = await freshLead();
    const g = await request(app()).get(`/api/leads/${lead._id}/dispositions`);
    expect(g.status).toBe(200);
    expect(g.body.pipeline.name).toBe("Corporate Calling");
    expect(g.body.groups.map((x: any) => x.disposition)).toEqual(["Call Back", "Interested", "Not Interested", "Not Connected", "Onboarded"]);
    expect(g.body.current).toEqual({ disposition: "", subDisposition: "", stage: "Prospect", status: "Open" });
    expect(g.body.canWork).toBe(true);

    const bad = await request(app()).post(`/api/leads/${lead._id}/disposition`).send({ subDisposition: "Call Back Time Given" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/follow-up date/);

    const p = await request(app()).post(`/api/leads/${lead._id}/disposition`).send({ subDisposition: "Demo Scheduled", note: "Demo Thursday" });
    expect(p.status).toBe(200);
    expect(p.body.to).toEqual({ disposition: "Interested", subDisposition: "Demo Scheduled", stage: "In-progress", status: "Open" });
    expect(p.body.opportunity).toMatchObject({ created: true, stage: "discovery" });
    expect(p.body.lead.dispositionStatus).toBe("Open");
    expect(p.body.lead.stage).toBe("demo_scheduled");

    // derived fields cannot be set by hand through the edit route
    const e = await request(app()).put(`/api/leads/${lead._id}`).send({ dispositionStatus: "Won", disposition: "Onboarded", notes: "x" });
    expect(e.status).toBe(200);
    expect(e.body.lead.dispositionStatus).toBe("Open");
  });
});
