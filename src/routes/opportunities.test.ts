// GET /opportunities · /opportunities/summary · /opportunities/:id — the
// opportunity board read surface, end to end through supertest on REAL
// collections (mongodb-memory-server). Two callers: an ADMIN (FULL / ALL) and
// a rep whose UserPermission row grants leads WRITE / OWN. Rows are written
// straight to the collections so the fixture controls stage, owner, closedAt
// and createdAt exactly.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/opportunities-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ids = {
  ADMIN: new mongoose.Types.ObjectId().toHexString(),
  REP: new mongoose.Types.ObjectId().toHexString(),
  OTHER: new mongoose.Types.ObjectId().toHexString(),
};

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user =
      req.headers["x-test-user"] === "rep"
        ? { id: ids.REP, sub: ids.REP, roles: ["EMPLOYEE"], email: "rep@plumtrips.com", name: "Rep" }
        : { id: ids.ADMIN, sub: ids.ADMIN, roles: ["ADMIN"], email: "ops@plumtrips.com", name: "Ops Admin" };
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
const { UserPermission } = await import("../models/UserPermission.js");
const { default: router } = await import("./opportunities.js");
const { default: leadsRouter } = await import("./leads.js");
const { CRM_V2_DISPOSITION_ENV, CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/opportunities", router);
  a.use("/api/leads", leadsRouter);
  return a;
}
const asAdmin = (path: string) => request(app()).get(`/api/opportunities${path}`);
const asRep = (path: string) => request(app()).get(`/api/opportunities${path}`).set("x-test-user", "rep");

const DAY = 86_400_000;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 10);

const REP = new mongoose.Types.ObjectId(ids.REP);
const OTHER = new mongoose.Types.ObjectId(ids.OTHER);

let seq = 0;
async function seedLead(o: Record<string, any> = {}) {
  seq += 1;
  const _id = new mongoose.Types.ObjectId();
  await Lead.collection.insertOne({
    _id, leadCode: `LEAD-T-${String(seq).padStart(4, "0")}`, type: "company", companyName: `Co ${seq}`, contactName: `Person ${seq}`, contactPhone: `9${String(seq).padStart(9, "0")}`,
    stage: "proposal_sent", source: "manual", dealValue: 0, currency: "INR", createdAt: now, updatedAt: now, ...o,
  } as any);
  return _id;
}
async function seedOpp(o: Record<string, any> = {}) {
  seq += 1;
  const _id = new mongoose.Types.ObjectId();
  await Opportunity.collection.insertOne({
    _id, opportunityCode: `OPP-T-${String(seq).padStart(4, "0")}`, name: `Deal ${seq}`, pipeline: "corporate", stage: "proposal", probability: 65,
    dealValue: 100_000, currency: "INR", closedAt: null, ownerUserId: REP, ownerName: "Rep", serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now, ...o,
  } as any);
  return _id;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
  await UserPermission.create({
    userId: ids.REP, email: "rep@plumtrips.com", workspaceId: "69679a7628330a58d29f2254", universe: "STAFF", level: { code: "L2", name: "Executive" },
    modules: { leads: { access: "WRITE", scope: "OWN" } }, grantedBy: ids.ADMIN,
  } as any);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  process.env[CRM_V2_DISPOSITION_ENV] = "true";
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({}), CRMContact.deleteMany({}), CRMCompany.deleteMany({})]);
});
afterEach(() => {
  delete process.env[CRM_V2_DISPOSITION_ENV];
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
});

describe("GET /opportunities", () => {
  it("is 404 with both CRM v2 flags off, and answers under either", async () => {
    delete process.env[CRM_V2_DISPOSITION_ENV];
    expect((await asAdmin("")).status).toBe(404);
    process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
    expect((await asAdmin("")).status).toBe(200);
  });

  it("defaults to OPEN deals only — won and lost are excluded until asked for", async () => {
    await seedOpp({ stage: "proposal" });
    await seedOpp({ stage: "negotiation" });
    await seedOpp({ stage: "closed_won", closedAt: now });
    await seedOpp({ stage: "closed_lost", closedAt: now });
    await seedOpp({ pipeline: "partnerships", stage: "active_partner", closedAt: now }); // partnerships' won stage

    const open = await asAdmin("");
    expect(open.status).toBe(200);
    expect(open.body.total).toBe(2);
    expect(open.body.opportunities.map((o: any) => o.stage).sort()).toEqual(["negotiation", "proposal"]);
    expect(open.body.byStage).toEqual(expect.arrayContaining([
      { pipeline: "corporate", stage: "proposal", count: 1, value: 100_000 },
      { pipeline: "corporate", stage: "negotiation", count: 1, value: 100_000 },
    ]));

    expect((await asAdmin("?status=won")).body.opportunities.map((o: any) => o.stage).sort()).toEqual(["active_partner", "closed_won"]);
    expect((await asAdmin("?status=lost")).body.total).toBe(1);
    expect((await asAdmin("?status=all")).body.total).toBe(5);
  });

  it("filters by pipeline, stage, owner, date range and search; paginates", async () => {
    const leadA = await seedLead({ contactName: "Ritika Menon", companyName: "Onboarded Demo Co" });
    await seedOpp({ name: "Onboarded Demo Co", leadId: leadA, ownerUserId: REP, createdAt: daysAgo(1) });
    await seedOpp({ name: "Groww", stage: "negotiation", ownerUserId: OTHER, ownerName: "Other", createdAt: daysAgo(10) });
    await seedOpp({ name: "Trip", pipeline: "travel_enquiry", stage: "options_sent", ownerUserId: REP, createdAt: daysAgo(40) });

    expect((await asAdmin("?pipeline=travel_enquiry")).body.opportunities.map((o: any) => o.name)).toEqual(["Trip"]);
    expect((await asAdmin("?stage=negotiation")).body.opportunities.map((o: any) => o.name)).toEqual(["Groww"]);
    expect((await asAdmin(`?owner=${ids.OTHER}`)).body.opportunities.map((o: any) => o.name)).toEqual(["Groww"]);
    expect((await asAdmin(`?dateFrom=${encodeURIComponent(daysAgo(20).toISOString())}`)).body.total).toBe(2);
    expect((await asAdmin(`?dateTo=${encodeURIComponent(daysAgo(20).toISOString())}`)).body.opportunities.map((o: any) => o.name)).toEqual(["Trip"]);
    // search reaches the joined lead's contact name, not only the deal name
    expect((await asAdmin("?search=ritika")).body.opportunities.map((o: any) => o.name)).toEqual(["Onboarded Demo Co"]);
    expect((await asAdmin("?search=groww")).body.total).toBe(1);

    const p1 = await asAdmin("?limit=2&page=1");
    const p2 = await asAdmin("?limit=2&page=2");
    expect(p1.body.opportunities).toHaveLength(2);
    expect(p1.body.pages).toBe(2);
    expect(p2.body.opportunities).toHaveLength(1);
    // newest first
    expect(p1.body.opportunities[0].name).toBe("Onboarded Demo Co");
  });

  it("joins the lead, company, primary contact (falling back to the lead's contact), last activity and age per row", async () => {
    const company = await CRMCompany.create({ name: "Acme Corp" } as any);
    const contact = await CRMContact.create({ firstName: "Priya", lastName: "Shah", email: "priya@acme.test", phone: "1", companyId: company._id, companyName: "Acme Corp" } as any);
    const leadA = await seedLead({ contactName: "Priya Shah", companyName: "Acme Corp", nextFollowUpDate: daysAgo(-2), assignedTo: REP, assignedToName: "Rep" });
    const leadB = await seedLead({ contactName: "Nikhil Rao", companyName: "Groww" });
    const won = await seedOpp({ name: "Acme Corp", stage: "closed_won", closedAt: now, leadId: leadA, companyId: company._id, primaryContactId: contact._id, createdAt: daysAgo(12) });
    const open = await seedOpp({ name: "Groww", stage: "proposal", leadId: leadB, createdAt: daysAgo(3) });
    await LeadActivity.create({ leadId: leadA, type: "note", note: "older", createdAt: daysAgo(5) } as any);
    await LeadActivity.create({ leadId: leadA, type: "stage_change", subject: { type: "OPPORTUNITY", id: won }, note: "Opportunity moved proposal → closed_won", fromStage: "proposal", toStage: "closed_won", createdAt: daysAgo(1) } as any);

    const r = await asAdmin("?status=all");
    const byId = Object.fromEntries(r.body.opportunities.map((o: any) => [o._id, o]));
    expect(byId[String(won)]).toMatchObject({
      opportunityCode: expect.stringMatching(/^OPP-T-/), stage: "closed_won", dealValue: 100_000, currency: "INR", ownerName: "Rep", ageDays: 12,
      lead: { leadCode: expect.stringMatching(/^LEAD-T-/), contactName: "Priya Shah", assignedToName: "Rep" },
      company: { name: "Acme Corp" },
      primaryContact: { _id: String(contact._id), name: "Priya Shah", email: "priya@acme.test", fromLead: false },
      lastActivityType: "stage_change",
    });
    expect(new Date(byId[String(won)].lastActivityAt).getTime()).toBe(daysAgo(1).getTime());
    expect(byId[String(open)]).toMatchObject({
      ageDays: 3,
      primaryContact: { _id: null, name: "Nikhil Rao", fromLead: true },
    });
    expect(byId[String(open)].lastActivityAt).toBeUndefined();
    expect(byId[String(open)].company).toBeUndefined();
  });

  it("OWN scope: a rep sees only the deals they own, and an owner filter cannot widen it", async () => {
    await seedOpp({ name: "mine", ownerUserId: REP });
    await seedOpp({ name: "mine too", ownerUserId: REP, stage: "negotiation" });
    await seedOpp({ name: "theirs", ownerUserId: OTHER, ownerName: "Other" });
    await seedOpp({ name: "nobody's", ownerUserId: null, ownerName: "" });

    const r = await asRep("");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.opportunities.map((o: any) => o.name).sort()).toEqual(["mine", "mine too"]);
    expect((await asRep(`?owner=${ids.OTHER}`)).body.total).toBe(2);
    expect((await asRep("?owner=unassigned")).body.total).toBe(2);
    // FULL sees everything
    expect((await asAdmin("")).body.total).toBe(4);
    expect((await asAdmin("?owner=unassigned")).body.opportunities.map((o: any) => o.name)).toEqual(["nobody's"]);
  });
});

describe("GET /opportunities/summary", () => {
  it("open pipeline + weighted forecast, won / lost this period, all-time win rate", async () => {
    await seedOpp({ stage: "proposal", probability: 65, dealValue: 200_000 });
    await seedOpp({ stage: "negotiation", probability: 80, dealValue: 100_000 });
    await seedOpp({ stage: "closed_won", closedAt: new Date(monthStart.getTime() + DAY), dealValue: 500_000 });
    await seedOpp({ stage: "closed_won", closedAt: lastMonth, dealValue: 300_000 });
    await seedOpp({ stage: "closed_lost", closedAt: new Date(monthStart.getTime() + DAY), dealValue: 50_000 });

    const r = await asAdmin(`/summary?periodStart=${encodeURIComponent(monthStart.toISOString())}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      open: { count: 2, value: 300_000, weighted: 210_000 },
      wonPeriod: { count: 1, value: 500_000 },
      lostPeriod: { count: 1, value: 50_000 },
      closedAll: { won: 2, lost: 1 },
      winRate: 66.7,
      winRatePeriod: 50,
    });
  });

  it("respects OWN scope and the pipeline filter; win rate is null with nothing closed", async () => {
    await seedOpp({ stage: "proposal", dealValue: 10, ownerUserId: REP });
    await seedOpp({ stage: "proposal", dealValue: 20, ownerUserId: OTHER });
    await seedOpp({ pipeline: "travel_enquiry", stage: "options_sent", dealValue: 40, ownerUserId: REP });
    expect((await asRep("/summary")).body).toMatchObject({ open: { count: 2, value: 50 }, winRate: null, winRatePeriod: null });
    expect((await asAdmin("/summary?pipeline=corporate")).body.open).toMatchObject({ count: 2, value: 30 });
  });
});

describe("GET /opportunities/:id", () => {
  it("returns the opportunity, its linked lead, company, primary contact, stage table and the lead's activity stream", async () => {
    const company = await CRMCompany.create({ name: "Onboarded Demo Co" } as any);
    const contact = await CRMContact.create({ firstName: "Ritika", lastName: "Menon", email: "ritika@demo.test", phone: "1", companyId: company._id, companyName: "Onboarded Demo Co" } as any);
    const leadId = await seedLead({ contactName: "Ritika Menon", companyName: "Onboarded Demo Co", companyId: company._id, convertedToContactId: contact._id, subDisposition: "Onboarded", dispositionStage: "Onboarded", dispositionStatus: "Won" });
    const oppId = await seedOpp({ name: "Onboarded Demo Co", stage: "closed_won", closedAt: now, leadId, companyId: company._id, primaryContactId: contact._id, dealValue: 250_000 });
    await LeadActivity.create({ leadId, type: "disposition", note: "Interested — Proposal sent", createdAt: daysAgo(3) } as any);
    await LeadActivity.create({ leadId, type: "stage_change", subject: { type: "OPPORTUNITY", id: oppId }, note: "Opportunity opened from disposition at proposal", fromStage: "", toStage: "proposal", createdAt: daysAgo(2) } as any);
    await LeadActivity.create({ leadId, type: "stage_change", subject: { type: "OPPORTUNITY", id: oppId }, note: "Opportunity moved proposal → closed_won", fromStage: "proposal", toStage: "closed_won", createdAt: daysAgo(1) } as any);

    const r = await asAdmin(`/${oppId}`);
    expect(r.status).toBe(200);
    expect(r.body.opportunity).toMatchObject({ _id: String(oppId), name: "Onboarded Demo Co", stage: "closed_won", dealValue: 250_000, ageDays: 0, lastActivityType: "stage_change" });
    expect(r.body.opportunity.lead).toBeUndefined();
    expect(r.body.lead).toMatchObject({ _id: String(leadId), contactName: "Ritika Menon", subDisposition: "Onboarded", dispositionStatus: "Won" });
    expect(r.body.company).toMatchObject({ _id: String(company._id), name: "Onboarded Demo Co" });
    expect(r.body.primaryContact).toMatchObject({ _id: String(contact._id), name: "Ritika Menon", fromLead: false });
    expect(r.body.stages.map((s: any) => s.key)).toEqual(["new_enquiry", "qualified", "discovery", "proposal", "negotiation", "closed_won", "closed_lost"]);
    // the lead's whole stream, newest first — the two OPPORTUNITY-subject rows ride along
    expect(r.body.activities).toHaveLength(3);
    expect(r.body.activities.map((a: any) => a.type)).toEqual(["stage_change", "stage_change", "disposition"]);
    expect(r.body.activities.filter((a: any) => a.subject?.type === "OPPORTUNITY")).toHaveLength(2);
  });

  it("is 400 on a bad id, 404 when missing, and 404 (not 403) for an OWN-scoped rep on someone else's deal", async () => {
    expect((await asAdmin("/nope")).status).toBe(400);
    expect((await asAdmin(`/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    const theirs = await seedOpp({ ownerUserId: OTHER, ownerName: "Other" });
    const mine = await seedOpp({ ownerUserId: REP });
    expect((await asRep(`/${theirs}`)).status).toBe(404);
    expect((await asRep(`/${mine}`)).status).toBe(200);
    expect((await asAdmin(`/${theirs}`)).status).toBe(200);
  });
});

describe("lead reassignment cascades to the shadow opportunity's owner", () => {
  it("POST /leads/:id/assign moves the deal into the new owner's OWN-scoped board", async () => {
    const { default: User } = await import("../models/User.js");
    await User.collection.insertOne({ _id: REP, name: "Rep", email: "rep@plumtrips.com", roles: ["EMPLOYEE"], passwordHash: "x" } as any);
    const leadId = await seedLead({ assignedTo: OTHER, assignedToName: "Other" });
    const oppId = await seedOpp({ leadId, ownerUserId: OTHER, ownerName: "Other" });
    expect((await asRep("")).body.total).toBe(0);

    const r = await request(app()).post(`/api/leads/${leadId}/assign`).send({ userId: ids.REP });
    expect(r.status).toBe(200);
    // the cascade is fire-and-forget — give it a tick
    await new Promise((res) => setTimeout(res, 50));
    const opp = await Opportunity.findById(oppId).lean();
    expect(String(opp!.ownerUserId)).toBe(ids.REP);
    expect(opp!.ownerName).toBe("Rep");
    expect((await asRep("")).body.total).toBe(1);
  });
});
