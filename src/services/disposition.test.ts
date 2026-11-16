// Disposition slice — the seed set is transcribed from the sheet EXACTLY,
// the derivation is data-driven off the pipeline row, every write appends one
// explainable activity, and the shadow opportunity fires/syncs/closes without
// the rep ever touching it. Real collections on mongodb-memory-server.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
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
const { default: CRMContact } = await import("../models/CRMContact.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");
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
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({}), CrmPipeline.deleteMany({}), CRMContact.deleteMany({}), CRMCompany.deleteMany({})]);
  // The pipeline row is seeded at startup in prod (server.ts); requests never seed it.
  await ensureDefaultPipeline();
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

describe("Corporate Calling disposition set (v2, Imran's set of 2026-11-12)", () => {
  it("is structurally valid and matches the set exactly", () => {
    expect(validateDispositionSet(CORPORATE_CALLING_SET, "corporate")).toEqual([]);
    const active = CORPORATE_CALLING_SET.filter((e) => e.active !== false);
    const by = (d: string) => active.filter((e) => e.disposition === d);
    expect(CORPORATE_CALLING_SET).toHaveLength(32);
    expect(active).toHaveLength(21);
    expect([...new Set(active.map((e) => e.disposition))]).toEqual(["Contacted", "Call Back", "Interested", "Nurture", "Not Interested", "Not Connected", "Onboarded"]);
    const row = (e: (typeof active)[number]) =>
      [e.disposition, e.subDisposition, e.stage, e.status, e.leadStatus, e.legacyStage, e.nextTouch, e.opportunityEffect === "open" ? `open @ ${e.opportunityStage}` : e.opportunityEffect].join(" | ");
    expect(active.map(row)).toEqual([
      "Contacted | Introduction Email Sent | In-progress | Open | CONTACTED | contacted | true | none",
      "Contacted | Asked to follow up | In-progress | Open | CONTACTED | contacted | true | none",
      "Call Back | Call Back Time Given | In-progress | Open | CONTACTED | follow_up | true | none",
      "Call Back | Call Back Time Not Given | In-progress | Open | CONTACTED | follow_up | true | none",
      "Interested | Demo Scheduled | In-progress | Open | CONTACTED | contacted | true | none",
      "Interested | Demo Done | In-progress | Open | CONTACTED | contacted | true | none",
      "Interested | Proposal Mail Sent | In-progress | Open | CONVERTED | proposal_sent | true | open @ proposal",
      "Interested | Negotiation in Progress | In-progress | Open | CONVERTED | negotiation | true | open @ negotiation",
      "Interested | Onboarding link sent | In-progress | Open | CONVERTED | negotiation | true | open @ negotiation",
      "Interested | Agreement in Progress | In-progress | Open | CONVERTED | negotiation | true | open @ negotiation",
      "Interested | NDA in Progress | In-progress | Open | CONVERTED | negotiation | true | open @ negotiation",
      "Nurture | Nurture | In-progress | Open | CONTACTED | follow_up | true | none",
      "Not Interested | Repeated RNR | Lost | Lost | LOST | lost | false | lost",
      "Not Interested | Competitor onboarded | Lost | Lost | LOST | lost | false | lost",
      "Not Interested | Global tie up mandate | Lost | Lost | LOST | lost | false | lost",
      "Not Interested | Proposal rejected | Lost | Lost | LOST | lost | false | lost",
      "Not Connected | Number Does not Exist | Lost | Lost | LOST | lost | false | lost",
      "Not Connected | Switched off | NC | Open | CONTACTED | contacted | true | none",
      "Not Connected | Ringing Only | NC | Open | CONTACTED | contacted | true | none",
      "Not Connected | Temp out of Service | Lost | Lost | LOST | lost | false | lost",
      "Onboarded | Onboarded | Onboarded | Won | CONVERTED | won | false | won",
    ]);
    // the rule: every sub that is not Lost / Won needs a next follow-up date
    for (const e of active) expect(e.nextTouch, e.subDisposition).toBe(e.status !== "Lost" && e.status !== "Won");
    expect(by("Nurture")).toHaveLength(1);
    expect(by("Onboarded")).toHaveLength(1);

    // retired v1 subs: kept (leads still sit on them), hidden, v1 settings unchanged
    const retired = CORPORATE_CALLING_SET.filter((e) => e.active === false);
    expect(retired.map((e) => `${e.disposition} | ${e.subDisposition}`)).toEqual([
      "Interested | Follow up Required", "Interested | Proposal Mail Required",
      "Not Interested | Stopped Answering Call", "Not Interested | Not Interested for Services", "Not Interested | Other Vendor onboarded",
      "Not Interested | Working with other vendors", "Not Interested | Trust Issue", "Not Interested | Not A right party contact",
      "Not Interested | Travel Desk Not Required", "Not Interested | Visa Services Not Required", "Not Interested | No Use Case Available",
    ]);
    expect(retired[0]).toMatchObject({ stage: "In-progress", status: "Open", nextTouch: true, opportunityEffect: "open", opportunityStage: "qualified", leadStatus: "CONVERTED", legacyStage: "follow_up" });
    expect(retired[1]).toMatchObject({ stage: "In-progress", status: "Open", nextTouch: false, opportunityEffect: "open", opportunityStage: "discovery", leadStatus: "CONVERTED", legacyStage: "contacted" });
    for (const e of retired.slice(2)) expect(e).toMatchObject({ stage: "Lost", status: "Lost", nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" });
    expect(DISPOSITION_STAGES).toEqual(["Prospect", "In-progress", "Lost", "Onboarded", "NC"]);
    expect(DISPOSITION_STATUSES).toEqual(["Open", "In-progress", "Lost", "Won"]);
  });

  it("the live spec file carries exactly the seed", () => {
    const spec = JSON.parse(readFileSync(new URL("../scripts/disposition-sets/corporate-calling-v2.json", import.meta.url), "utf8"));
    expect(spec).toMatchObject({ pipeline: "corporate_calling", opportunityPipeline: "corporate" });
    expect(spec.dispositionSet).toEqual(CORPORATE_CALLING_SET.map((e) => ({ ...e, active: e.active !== false })));
  });

  it("rejects a malformed set", () => {
    expect(validateDispositionSet([{ ...CORPORATE_CALLING_SET[0] }, { ...CORPORATE_CALLING_SET[0] }])).toContain('duplicate sub-disposition "Introduction Email Sent" (sub-dispositions are matched case-insensitively)');
    const proposal = CORPORATE_CALLING_SET.find((e) => e.subDisposition === "Proposal Mail Sent")!;
    expect(validateDispositionSet([{ ...proposal, opportunityStage: undefined }])[0]).toMatch(/needs opportunityStage/);
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
    expect(a.dispositionSet).toHaveLength(32);
    expect(groupedSet(a).map((g) => g.disposition)).toEqual(["Contacted", "Call Back", "Interested", "Nurture", "Not Interested", "Not Connected", "Onboarded"]);
    expect(groupedSet(a).flatMap((g) => g.subs)).toHaveLength(21);
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
  it("Fresh → Call Back Time Given → Demo Scheduled (no deal) → Proposal Mail Sent (fires) → Negotiation in Progress (syncs) → Onboarded (won)", async () => {
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

    // Interested / Demo Scheduled: needs a date; still CONTACTED; NO deal yet
    await expect(applyDisposition(lead, { subDisposition: "Demo Scheduled", actor: ACTOR })).rejects.toThrow(/"Demo Scheduled" needs a next follow-up date/);
    const rd = await applyDisposition(lead, { subDisposition: "Demo Scheduled", nextFollowUpDate: new Date(Date.now() + 2 * 86400000), actor: ACTOR });
    expect(rd.opportunity).toBeNull();
    expect(await Lead.collection.findOne({ _id: lead._id })).toMatchObject({ disposition: "Interested", stage: "contacted", status: "CONTACTED" });
    expect(await Opportunity.countDocuments({})).toBe(0);

    // Proposal Mail Sent: shadow opportunity fires at "proposal"
    await expect(applyDisposition(lead, { subDisposition: "Proposal Mail Sent", actor: ACTOR })).rejects.toThrow(/needs a next follow-up date/);
    const r2 = await applyDisposition(lead, { subDisposition: "Proposal Mail Sent", nextFollowUpDate: new Date(Date.now() + 2 * 86400000), actor: ACTOR });
    expect(r2.opportunity).toMatchObject({ created: true, stage: "proposal", effect: "open" });
    const opp = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(opp).toMatchObject({ pipeline: "corporate", stage: "proposal", probability: 65, dealValue: 450000, name: "Zepto", automatedByRule: "", legacyLeadStage: "proposal_sent" });
    expect(String(opp!.ownerUserId)).toBe(ADMIN_ID);
    raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw!.status).toBe("CONVERTED");
    expect(String(raw!.opportunityId)).toBe(String(opp!._id));

    // Negotiation in Progress: same opportunity, synced to "negotiation"; dealValue synced
    lead.dealValue = 500000;
    const r3 = await applyDisposition(lead, { subDisposition: "Negotiation in Progress", nextFollowUpDate: new Date(Date.now() + 3 * 86400000), actor: ACTOR });
    expect(r3.opportunity).toMatchObject({ created: false, fromStage: "proposal", stage: "negotiation" });
    expect(await Opportunity.countDocuments({ leadId: lead._id })).toBe(1);
    expect((await Opportunity.findOne({ leadId: lead._id }).lean())!.dealValue).toBe(500000);

    // Onboarded: won
    const r4 = await applyDisposition(lead, { subDisposition: "Onboarded", actor: ACTOR });
    expect(r4.to).toEqual({ disposition: "Onboarded", subDisposition: "Onboarded", stage: "Onboarded", status: "Won" });
    expect(r4.opportunity).toMatchObject({ created: false, fromStage: "negotiation", stage: "closed_won", effect: "won" });
    const won = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(won!.probability).toBe(100);
    expect(won!.closedAt).toBeInstanceOf(Date);
    raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw).toMatchObject({ stage: "won", status: "CONVERTED", dispositionStatus: "Won" });
    expect(raw!.wonDate).toBeInstanceOf(Date);

    // one disposition activity per write (5) + opportunity rows for open/sync/won (3), all explainable
    const acts = await LeadActivity.find({ leadId: lead._id }).sort({ createdAt: 1 }).lean();
    const disp = acts.filter((a: any) => a.type === "disposition");
    expect(disp).toHaveLength(5);
    expect((disp[0] as any).disposition).toEqual({ from: { disposition: "", subDisposition: "", stage: "Prospect", status: "Open" }, to: { disposition: "Call Back", subDisposition: "Call Back Time Given", stage: "In-progress", status: "Open" } });
    expect((disp[4] as any).disposition.to.status).toBe("Won");
    const oppRows = acts.filter((a: any) => a.subject?.type === "OPPORTUNITY");
    expect(oppRows.map((a: any) => a.toStage)).toEqual(["proposal", "negotiation", "closed_won"]);
  });

  it("Fresh → Not Interested → Lost at the lead grain, NO opportunity", async () => {
    const lead = await freshLead();
    const r = await applyDisposition(lead, { subDisposition: "Repeated RNR", actor: ACTOR });
    expect(r.to).toMatchObject({ stage: "Lost", status: "Lost" });
    expect(r.opportunity).toBeNull();
    expect(await Opportunity.countDocuments({})).toBe(0);
    const raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw).toMatchObject({ stage: "lost", status: "LOST", lostReason: "Repeated RNR", dispositionStatus: "Lost" });
  });

  it("Lost AFTER Interested → the opportunity is closed-lost (feeds win/loss)", async () => {
    const lead = await freshLead();
    await applyDisposition(lead, { subDisposition: "Proposal Mail Sent", nextFollowUpDate: new Date(Date.now() + 86400000), actor: ACTOR });
    const r = await applyDisposition(lead, { subDisposition: "Competitor onboarded", actor: ACTOR });
    expect(r.opportunity).toMatchObject({ created: false, stage: "closed_lost", effect: "lost" });
    const opp = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(opp).toMatchObject({ stage: "closed_lost", lostReason: "Competitor onboarded", probability: 0 });
    expect(opp!.closedAt).toBeInstanceOf(Date);
    expect(await Opportunity.countDocuments({})).toBe(1);

    // and Interested again reopens the same deal
    const r2 = await applyDisposition(lead, { subDisposition: "Negotiation in Progress", nextFollowUpDate: new Date(Date.now() + 86400000), actor: ACTOR });
    expect(r2.opportunity).toMatchObject({ created: false, fromStage: "closed_lost", stage: "negotiation" });
    const re = await Opportunity.findOne({ leadId: lead._id }).lean();
    expect(re!.closedAt).toBeNull();
    expect(await Opportunity.countDocuments({})).toBe(1);
  });

  it("Not Connected: Switched off / Ringing Only need a follow-up date → NC/Open; Number Does not Exist → Lost; Onboarded first → won deal created", async () => {
    const a = await freshLead();
    await expect(applyDisposition(a, { subDisposition: "Switched off", actor: ACTOR })).rejects.toThrow(/"Switched off" needs a next follow-up date/);
    const due = new Date(Date.now() + 86400000);
    expect((await applyDisposition(a, { subDisposition: "Switched off", nextFollowUpDate: due, actor: ACTOR })).to).toMatchObject({ stage: "NC", status: "Open" });
    expect(await Lead.collection.findOne({ _id: a._id })).toMatchObject({ stage: "contacted", nextFollowUpDate: due });
    const d = await freshLead({ contactName: "D" });
    await expect(applyDisposition(d, { subDisposition: "Ringing Only", actor: ACTOR })).rejects.toThrow(/"Ringing Only" needs a next follow-up date/);
    expect((await applyDisposition(d, { subDisposition: "Ringing Only", nextFollowUpDate: due, actor: ACTOR })).to).toMatchObject({ stage: "NC", status: "Open" });
    expect((await Lead.collection.findOne({ _id: d._id }))!.nextFollowUpDate).toEqual(due);
    const b = await freshLead({ contactName: "B" });
    expect((await applyDisposition(b, { subDisposition: "Number Does not Exist", actor: ACTOR })).to).toMatchObject({ stage: "Lost", status: "Lost" });
    const c = await freshLead({ contactName: "C" });
    const r = await applyDisposition(c, { subDisposition: "Onboarded", actor: ACTOR });
    expect(r.opportunity).toMatchObject({ created: true, stage: "closed_won" });
  });

  it("idempotent against a pre-existing opportunity (e.g. from the Slice-2 migration)", async () => {
    const lead = await freshLead({ stage: "proposal_sent" });
    const existing = await Opportunity.create({ leadId: lead._id, pipeline: "corporate", stage: "proposal", dealValue: 1 });
    const r = await applyDisposition(lead, { subDisposition: "Negotiation in Progress", nextFollowUpDate: new Date(Date.now() + 86400000), actor: ACTOR });
    expect(r.opportunity!.id).toBe(String(existing._id));
    expect(r.opportunity).toMatchObject({ created: false, fromStage: "proposal", stage: "negotiation" });
    expect(await Opportunity.countDocuments({ leadId: lead._id })).toBe(1);
  });

  it("unknown sub-disposition writes nothing", async () => {
    const lead = await freshLead();
    await expect(applyDisposition(lead, { subDisposition: "Ghosted", actor: ACTOR })).rejects.toBeInstanceOf(DispositionError);
    expect(await LeadActivity.countDocuments({})).toBe(0);
    expect((await Lead.collection.findOne({ _id: lead._id }))!.disposition).toBe("");
  });
});

/* ─────────────────── closed leads drop their follow-up ─────────────────── */

describe("applyDisposition — Won / Lost clear the follow-up", () => {
  const due = new Date(Date.now() - 86400000); // overdue, the case that showed on Today

  it("Lost clears nextFollowUpDate and followUpNotes", async () => {
    const lead = await freshLead({ nextFollowUpDate: due, followUpNotes: "Ring Monday" });
    await applyDisposition(lead, { subDisposition: "Repeated RNR", actor: ACTOR });
    const raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw).toMatchObject({ dispositionStatus: "Lost", followUpNotes: "" });
    expect(raw!.nextFollowUpDate ?? null).toBeNull();
    expect(lead.nextFollowUpDate).toBeUndefined();
  });

  it("Won (Onboarded) clears them too — after an open disposition had set them", async () => {
    const lead = await freshLead();
    await applyDisposition(lead, { subDisposition: "Proposal Mail Sent", note: "Chase the CFO", nextFollowUpDate: due, actor: ACTOR });
    let raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw).toMatchObject({ dispositionStatus: "Open", followUpNotes: "Chase the CFO" });
    expect(raw!.nextFollowUpDate).toEqual(due);

    await applyDisposition(lead, { subDisposition: "Onboarded", actor: ACTOR });
    raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw).toMatchObject({ dispositionStatus: "Won", followUpNotes: "" });
    expect(raw!.nextFollowUpDate ?? null).toBeNull();
  });

  it("an open disposition keeps (and replaces) the follow-up — only closed statuses clear it", async () => {
    const lead = await freshLead({ nextFollowUpDate: due, followUpNotes: "old" });
    const next = new Date(Date.now() + 2 * 86400000);
    const r = await applyDisposition(lead, { subDisposition: "Demo Scheduled", note: "Demo Thu", nextFollowUpDate: next, actor: ACTOR });
    expect(r.to.status).toBe("Open");
    const raw = await Lead.collection.findOne({ _id: lead._id });
    expect(raw).toMatchObject({ followUpNotes: "Demo Thu" });
    expect(raw!.nextFollowUpDate).toEqual(next);
  });
});

/* ───────────────────────── Onboarded → CRM contact ───────────────────────── */

describe("Onboarded → CRMContact (what /win materialised, with the guards it lacked)", () => {
  it("creates exactly one contact + company, links the lead, logs a CONTACT row, and the deal picks up primaryContactId", async () => {
    const lead = await freshLead({ contactName: "Priya Nair", contactEmail: "Priya@Zepto.com", contactDesignation: "Travel Desk", notes: "Met at expo" });
    const r = await applyDisposition(lead, { subDisposition: "Onboarded", actor: ACTOR });
    expect(r.contact).toMatchObject({ how: "created" });
    expect(await CRMContact.countDocuments({})).toBe(1);
    expect(await CRMCompany.countDocuments({})).toBe(1);

    // the /win shape: name split, designation → jobTitle, email lower-cased, linked via leadId/companyId/assignedTo
    const contact = (await CRMContact.findOne({}).lean()) as any;
    const company = (await CRMCompany.findOne({}).lean()) as any;
    expect(contact).toMatchObject({ firstName: "Priya", lastName: "Nair", jobTitle: "Travel Desk", phone: "9880123456", email: "priya@zepto.com", companyName: "Zepto", notes: "Met at expo", isPrivate: false, status: "active" });
    expect(String(contact.leadId)).toBe(String(lead._id));
    expect(String(contact.companyId)).toBe(String(company._id));
    expect(String(contact.assignedTo)).toBe(ADMIN_ID);
    expect(String(contact.createdBy)).toBe(ADMIN_ID);
    expect(company.name).toBe("Zepto");

    // lead links — the "View Contact" link resolves; companyId aligned with convertedToCompanyId
    const raw = (await Lead.collection.findOne({ _id: lead._id })) as any;
    expect(String(raw.convertedToContactId)).toBe(String(contact._id));
    expect(String(raw.convertedToCompanyId)).toBe(String(company._id));
    expect(String(raw.companyId)).toBe(String(company._id));
    expect(r.contact!.id).toBe(String(contact._id));

    // timeline: disposition → contact (CONTACT-subject won row) → opportunity closed_won, in that order
    const acts = await LeadActivity.find({ leadId: lead._id }).sort({ createdAt: 1, _id: 1 }).lean();
    expect(acts.map((a: any) => [a.type, a.subject?.type])).toEqual([["disposition", "LEAD"], ["won", "CONTACT"], ["stage_change", "OPPORTUNITY"]]);
    const contactRow = acts[1] as any;
    expect(String(contactRow.subject.id)).toBe(String(contact._id));
    expect(contactRow.note).toBe('Converted: Contact "Priya Nair" and Company "Zepto" created.');
    expect(contactRow.createdByName).toBe("Ops Admin");

    // the shadow deal was created AFTER the contact, so it carries the links
    const opp = (await Opportunity.findOne({ leadId: lead._id }).lean()) as any;
    expect(opp.stage).toBe("closed_won");
    expect(String(opp.primaryContactId)).toBe(String(contact._id));
    expect(String(opp.companyId)).toBe(String(company._id));
  });

  it("re-Onboarding creates ZERO more contacts and no second contact row (the /win duplicate bug)", async () => {
    const lead = await freshLead({ contactEmail: "priya@zepto.com" });
    const r1 = await applyDisposition(lead, { subDisposition: "Onboarded", actor: ACTOR });
    const r2 = await applyDisposition(lead, { subDisposition: "Onboarded", actor: ACTOR });
    expect(r1.contact).toMatchObject({ how: "created" });
    expect(r2.contact).toMatchObject({ how: "already_converted", id: r1.contact!.id });
    expect(await CRMContact.countDocuments({})).toBe(1);
    expect(await CRMCompany.countDocuments({})).toBe(1);
    expect(await LeadActivity.countDocuments({ "subject.type": "CONTACT" })).toBe(1);
    expect(await LeadActivity.countDocuments({ type: "disposition" })).toBe(2);
    expect(String((await Lead.collection.findOne({ _id: lead._id }))!.convertedToContactId)).toBe(r1.contact!.id);

    // an Onboarded lead re-saved through the model (no disposition) stays converted once
    const doc = (await Lead.findById(lead._id))!;
    doc.notes = "touched";
    await doc.save();
    expect(await CRMContact.countDocuments({})).toBe(1);

    // and a lead that arrives already converted (e.g. via legacy /convert) is left alone too
    const pre = await CRMContact.create({ firstName: "Existing", phone: "1", createdBy: new mongoose.Types.ObjectId(ADMIN_ID) });
    const lead2 = await freshLead({ contactName: "Two", contactEmail: "two@zepto.com", convertedToContactId: pre._id });
    const r3 = await applyDisposition(lead2, { subDisposition: "Onboarded", actor: ACTOR });
    expect(r3.contact).toMatchObject({ how: "already_converted", id: String(pre._id) });
    expect(await CRMContact.countDocuments({})).toBe(2);
    expect(await LeadActivity.countDocuments({ leadId: lead2._id, "subject.type": "CONTACT" })).toBe(0);
  });

  it("an existing contact with the same email is reused untouched (the /convert dedup lookup), never duplicated", async () => {
    const company = await CRMCompany.create({ name: "Zepto", nameNormalized: "zepto" });
    const existing = await CRMContact.create({ firstName: "P", lastName: "N", phone: "0000", email: "priya@zepto.com", jobTitle: "Old title", companyId: company._id, companyName: "Zepto", createdBy: new mongoose.Types.ObjectId(ADMIN_ID) });
    const lead = await freshLead({ contactName: "Priya Nair", contactEmail: "PRIYA@zepto.com", contactDesignation: "New title" });
    const r = await applyDisposition(lead, { subDisposition: "Onboarded", actor: ACTOR });
    expect(r.contact).toMatchObject({ how: "existing_email", id: String(existing._id) });
    expect(await CRMContact.countDocuments({})).toBe(1);
    expect(await CRMCompany.countDocuments({})).toBe(1); // resolved by normalised name, not re-created

    // reused contact is not rewritten by the lead's values (useExistingContactId semantics)
    const after = (await CRMContact.findById(existing._id).lean()) as any;
    expect(after).toMatchObject({ firstName: "P", lastName: "N", phone: "0000", jobTitle: "Old title" });
    expect(after.leadId).toBeNull();

    const raw = (await Lead.collection.findOne({ _id: lead._id })) as any;
    expect(String(raw.convertedToContactId)).toBe(String(existing._id));
    expect(String(raw.convertedToCompanyId)).toBe(String(company._id));
    const row = (await LeadActivity.findOne({ leadId: lead._id, "subject.type": "CONTACT" }).lean()) as any;
    expect(String(row.subject.id)).toBe(String(existing._id));
    expect(row.note).toMatch(/existing Contact matched by email \(priya@zepto\.com\) linked and Company "Zepto"/);

    // no email on the lead → nothing to match on; a fresh contact is created (and a second Onboarded still doesn't duplicate)
    const noEmail = await freshLead({ contactName: "No Mail", contactPhone: "5555" });
    expect((await applyDisposition(noEmail, { subDisposition: "Onboarded", actor: ACTOR })).contact).toMatchObject({ how: "created" });
    expect(await CRMContact.countDocuments({})).toBe(2);
  });

  it("no contact on a non-Won disposition; Won reached via the route returns the contact in the cascade", async () => {
    const lead = await freshLead({ contactEmail: "a@b.com" });
    const r = await applyDisposition(lead, { subDisposition: "Introduction Email Sent", nextFollowUpDate: new Date(Date.now() + 86400000), actor: ACTOR });
    expect(r.contact).toBeNull();
    expect(await CRMContact.countDocuments({})).toBe(0);

    const res = await request(app()).post(`/api/leads/${lead._id}/disposition`).send({ subDisposition: "Onboarded" });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ how: "created" });
    expect(res.body.lead.convertedToContactId).toBe(res.body.contact.id);
    expect(await CRMContact.countDocuments({})).toBe(1);
  });
});

/* ───────────────────────── routes ───────────────────────── */

describe("routes", () => {
  it("flag OFF: both routes are 404", async () => {
    delete process.env[CRM_V2_DISPOSITION_ENV];
    await CrmPipeline.deleteMany({}); // prove the flag-off routes never create the row
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
    expect(g.body.groups.map((x: any) => x.disposition)).toEqual(["Contacted", "Call Back", "Interested", "Nurture", "Not Interested", "Not Connected", "Onboarded"]);
    expect(g.body.groups.flatMap((x: any) => x.subs)).toHaveLength(21);
    expect(g.body.current).toEqual({ disposition: "", subDisposition: "", stage: "Prospect", status: "Open" });
    expect(g.body.canWork).toBe(true);

    const bad = await request(app()).post(`/api/leads/${lead._id}/disposition`).send({ subDisposition: "Call Back Time Given" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/follow-up date/);

    const p = await request(app()).post(`/api/leads/${lead._id}/disposition`).send({ subDisposition: "Proposal Mail Sent", note: "Sent Thursday", nextFollowUpDate: new Date(Date.now() + 86400000).toISOString() });
    expect(p.status).toBe(200);
    expect(p.body.to).toEqual({ disposition: "Interested", subDisposition: "Proposal Mail Sent", stage: "In-progress", status: "Open" });
    expect(p.body.opportunity).toMatchObject({ created: true, stage: "proposal" });
    expect(p.body.lead.dispositionStatus).toBe("Open");
    expect(p.body.lead.stage).toBe("proposal_sent");

    // derived fields cannot be set by hand through the edit route
    const e = await request(app()).put(`/api/leads/${lead._id}`).send({ dispositionStatus: "Won", disposition: "Onboarded", notes: "x" });
    expect(e.status).toBe(200);
    expect(e.body.lead.dispositionStatus).toBe("Open");
  });
});

/* ───────── follow-up task: a switched-off automation is not silent ───────── */

describe("follow-up task outcome (lead.next_followup)", () => {
  let TaskAutomation: any, Task: any;
  beforeAll(async () => {
    ({ default: TaskAutomation } = await import("../models/TaskAutomation.js"));
    ({ default: Task } = await import("../models/Task.js"));
  });
  beforeEach(async () => {
    await Promise.all([TaskAutomation.deleteMany({}), Task.deleteMany({})]);
  });
  const row = (enabled: boolean) => TaskAutomation.create({
    workspaceId: "SYSTEM", triggerKey: "lead.next_followup", label: "Lead has next follow-up date", entityType: "LEAD",
    enabled, titleTemplate: "Follow up: {{leadName}}", dueOffsetMinutes: 0, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: ["auto"],
  });
  const tomorrow = () => new Date(Date.now() + 86400000);

  it("no row → taskCreated:false, automation_missing; the disposition still saves", async () => {
    const lead = await freshLead();
    const r = await applyDisposition(lead, { subDisposition: "Call Back Time Given", nextFollowUpDate: tomorrow(), actor: ACTOR });
    expect(r.followUpTask).toEqual({ taskCreated: false, reason: "automation_missing" });
    expect(r.to.subDisposition).toBe("Call Back Time Given");
    expect(await Task.countDocuments({})).toBe(0);
  });

  it("row switched off → taskCreated:false, automation_disabled", async () => {
    await row(false);
    const r = await applyDisposition(await freshLead(), { subDisposition: "Call Back Time Given", nextFollowUpDate: tomorrow(), actor: ACTOR });
    expect(r.followUpTask).toEqual({ taskCreated: false, reason: "automation_disabled" });
    expect(await Task.countDocuments({})).toBe(0);
  });

  it("row enabled → task created as before (taskCreated:true); dedup unchanged on the second date", async () => {
    await row(true);
    const lead = await freshLead();
    const due = tomorrow();
    const r = await applyDisposition(lead, { subDisposition: "Call Back Time Given", nextFollowUpDate: due, actor: ACTOR });
    expect(r.followUpTask).toEqual({ taskCreated: true, reason: "created" });
    const t = await Task.findOne({ linkedId: lead._id }).lean();
    expect(t).toMatchObject({ autoTriggerKey: "lead.next_followup", status: "OPEN", title: "Follow up: Priya", workspaceId: "SYSTEM" });
    expect(String(t.assignedTo)).toBe(ADMIN_ID);
    expect(new Date(t.dueDate).getTime()).toBe(due.getTime());

    const r2 = await applyDisposition(lead, { subDisposition: "Call Back Time Given", nextFollowUpDate: new Date(Date.now() + 3 * 86400000), actor: ACTOR });
    expect(r2.followUpTask).toEqual({ taskCreated: false, reason: "open_task_exists" });
    expect(await Task.countDocuments({ linkedId: lead._id })).toBe(1);
  });

  it("no follow-up date → nothing attempted, followUpTask null", async () => {
    const r = await applyDisposition(await freshLead(), { subDisposition: "Repeated RNR", actor: ACTOR });
    expect(r.followUpTask).toBeNull();
  });

  it("POST /:id/disposition carries followUpTask to the client", async () => {
    await row(false);
    const lead = await freshLead();
    const res = await request(app()).post(`/api/leads/${lead._id}/disposition`).send({ subDisposition: "Call Back Time Given", nextFollowUpDate: tomorrow().toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.followUpTask).toEqual({ taskCreated: false, reason: "automation_disabled" });
  });
});
