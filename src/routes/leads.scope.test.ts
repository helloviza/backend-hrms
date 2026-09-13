// Cross-user data isolation across the CRM — the pre-launch blocker from the
// isolation audit. services/crmScope is the ONE enforcement point; this file
// proves every surface honours it, against REAL collections
// (mongodb-memory-server). Four callers:
//   ADMIN    role ADMIN                  → FULL / ALL by construction
//   REP      leads WRITE / OWN           → the OWN-scoped rep
//   FULLOWN  leads FULL / OWN            → the loophole state five prod reps carry
//   OTHER    the rep whose data REP must never see or touch
// crmContacts / crmCompanies carry the same scope as leads for each caller.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-scope-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ids = {
  ADMIN: new mongoose.Types.ObjectId().toHexString(),
  REP: new mongoose.Types.ObjectId().toHexString(),
  FULLOWN: new mongoose.Types.ObjectId().toHexString(),
  OTHER: new mongoose.Types.ObjectId().toHexString(),
};
const USERS: Record<string, any> = {
  admin: { id: ids.ADMIN, sub: ids.ADMIN, roles: ["ADMIN"], email: "ops@plumtrips.com", name: "Ops Admin" },
  rep: { id: ids.REP, sub: ids.REP, roles: ["EMPLOYEE"], email: "rep@plumtrips.com", name: "Rep" },
  fullown: { id: ids.FULLOWN, sub: ids.FULLOWN, roles: ["EMPLOYEE"], email: "fullown@plumtrips.com", name: "Full Own" },
  other: { id: ids.OTHER, sub: ids.OTHER, roles: ["EMPLOYEE"], email: "other@plumtrips.com", name: "Other" },
};

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = USERS[String(req.headers["x-test-user"] || "admin")];
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
const { default: User } = await import("../models/User.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: leadsRouter } = await import("./leads.js");
const { default: oppsRouter } = await import("./opportunities.js");
const { default: companiesRouter } = await import("./crm.companies.js");
const { default: contactsRouter } = await import("./crm.contacts.js");
const { CRM_V2_DISPOSITION_ENV, CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");
const { normalizeScope, rowsFor } = await import("../services/crmScope.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/leads", leadsRouter);
  a.use("/api/opportunities", oppsRouter);
  a.use("/api/crm/companies", companiesRouter);
  a.use("/api/crm/contacts", contactsRouter);
  return a;
}
type Who = "admin" | "rep" | "fullown" | "other";
const get = (who: Who, path: string) => request(app()).get(`/api${path}`).set("x-test-user", who);
const post = (who: Who, path: string, body: any = {}) => request(app()).post(`/api${path}`).set("x-test-user", who).send(body);
const put = (who: Who, path: string, body: any = {}) => request(app()).put(`/api${path}`).set("x-test-user", who).send(body);
const del = (who: Who, path: string) => request(app()).delete(`/api${path}`).set("x-test-user", who);

const REP = new mongoose.Types.ObjectId(ids.REP);
const OTHER = new mongoose.Types.ObjectId(ids.OTHER);
const FULLOWN = new mongoose.Types.ObjectId(ids.FULLOWN);
const now = new Date();
let seq = 0;
async function lead(o: Record<string, any> = {}) {
  seq += 1;
  const _id = new mongoose.Types.ObjectId();
  await Lead.collection.insertOne({
    _id, leadCode: `LEAD-S-${String(seq).padStart(4, "0")}`, type: "company", companyName: `Co ${seq}`, contactName: `Person ${seq}`, contactPhone: `9${String(seq).padStart(9, "0")}`,
    stage: "new", source: "manual", dealValue: 1000, currency: "INR", nextFollowUpDate: null, createdAt: now, updatedAt: now, ...o,
  } as any);
  return _id;
}
async function opp(leadId: mongoose.Types.ObjectId, owner: mongoose.Types.ObjectId, o: Record<string, any> = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Opportunity.collection.insertOne({ _id, opportunityCode: `OPP-S-${String(++seq).padStart(4, "0")}`, name: "d", pipeline: "corporate", stage: "proposal", probability: 65, dealValue: 5000, currency: "INR", closedAt: null, leadId, ownerUserId: owner, serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now, ...o } as any);
  await Lead.updateOne({ _id: leadId }, { $set: { opportunityId: _id } });
  return _id;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
  const perm = (userId: string, email: string, access: string, scope: string) => ({
    userId, email, workspaceId: "69679a7628330a58d29f2254", universe: "STAFF", level: { code: "L2", name: "Executive" },
    modules: { leads: { access, scope }, crmContacts: { access, scope }, crmCompanies: { access, scope } }, grantedBy: ids.ADMIN,
  });
  await UserPermission.create([perm(ids.REP, "rep@plumtrips.com", "WRITE", "OWN"), perm(ids.FULLOWN, "fullown@plumtrips.com", "FULL", "OWN"), perm(ids.OTHER, "other@plumtrips.com", "WRITE", "OWN")] as any);
  await User.collection.insertMany(Object.values(USERS).map((u) => ({ _id: new mongoose.Types.ObjectId(u.id), name: u.name, email: u.email, roles: u.roles, passwordHash: "x" })) as any[]);
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
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({}), CRMContact.deleteMany({}), CRMCompany.deleteMany({})]);
});

describe("services/crmScope — the switch", () => {
  it("normalises scope deny-by-default: ALL / WORKSPACE widen, everything else narrows to the caller", () => {
    expect(normalizeScope("ALL")).toBe("ALL");
    expect(normalizeScope("WORKSPACE")).toBe("ALL");
    expect(normalizeScope("OWN")).toBe("OWN");
    expect(normalizeScope("NONE")).toBe("OWN");
    expect(normalizeScope(undefined)).toBe("OWN");
    expect(normalizeScope("garbage")).toBe("OWN");
    expect(normalizeScope("TEAM")).toBe("TEAM");
    // TEAM is reserved — until the reports-to set exists it behaves as OWN, never wider.
    expect(rowsFor({ userId: REP, access: "WRITE", scope: "TEAM" }, "assignedTo")).toEqual({ assignedTo: REP });
    expect(rowsFor({ userId: REP, access: "WRITE", scope: "ALL" }, "assignedTo")).toEqual({});
    expect(rowsFor({ userId: null, access: "WRITE", scope: "OWN" }, "assignedTo")).toEqual({ _id: null });
  });
});

describe("leads — :id reads and mutations", () => {
  let mine: mongoose.Types.ObjectId, theirs: mongoose.Types.ObjectId;
  beforeEach(async () => {
    mine = await lead({ assignedTo: REP, assignedToName: "Rep" });
    theirs = await lead({ assignedTo: OTHER, assignedToName: "Other", contactName: "Secret Person" });
  });

  it("GET /:id and /:id/dispositions: 404 (not 403) on another rep's lead; own and admin fine", async () => {
    expect((await get("rep", `/leads/${theirs}`)).status).toBe(404);
    expect((await get("rep", `/leads/${theirs}/dispositions`)).status).toBe(404);
    expect((await get("rep", `/leads/${mine}`)).status).toBe(200);
    expect((await get("rep", `/leads/${mine}/dispositions`)).status).toBe(200);
    expect((await get("admin", `/leads/${theirs}`)).body.lead.contactName).toBe("Secret Person");
    expect((await get("fullown", `/leads/${theirs}`)).status).toBe(404); // FULL alone does not widen reads
  });

  it("every mutation on another rep's lead is 403; the same call on their own lead works", async () => {
    const cases: Array<[string, (who: Who, id: mongoose.Types.ObjectId) => request.Test]> = [
      ["PUT /:id", (w, id) => put(w, `/leads/${id}`, { notes: "x" })],
      ["PUT /:id/stage", (w, id) => put(w, `/leads/${id}/stage`, { stage: "contacted" })],
      ["POST /:id/activity", (w, id) => post(w, `/leads/${id}/activity`, { type: "note", note: "hi" })],
      ["POST /:id/win", (w, id) => post(w, `/leads/${id}/win`, {})],
      ["POST /:id/lose", (w, id) => post(w, `/leads/${id}/lose`, { reason: "no" })],
      ["POST /:id/convert", (w, id) => post(w, `/leads/${id}/convert`, {})],
      ["POST /:id/disposition", (w, id) => post(w, `/leads/${id}/disposition`, { subDisposition: "Ringing" })],
    ];
    for (const [name, call] of cases) {
      const r = await call("rep", theirs);
      expect(r.status, `${name} on another rep's lead`).toBe(403);
      expect(r.body.error).toMatch(/owned by someone else/);
    }
    // Untouched: the other rep's lead is exactly as seeded.
    const after = await Lead.findById(theirs).lean();
    expect(after).toMatchObject({ stage: "new", contactName: "Secret Person" });
    expect(await LeadActivity.countDocuments({ leadId: theirs })).toBe(0);
    // Own lead: the write gate + ownership both pass.
    expect((await put("rep", `/leads/${mine}`, { notes: "mine" })).status).toBe(200);
    expect((await post("rep", `/leads/${mine}/activity`, { type: "note", note: "hi" })).status).toBe(201);
    // Admin acts on anyone's.
    expect((await put("admin", `/leads/${theirs}`, { notes: "admin" })).status).toBe(200);
  });

  it("POST /leads: an OWN rep cannot assign to someone else — the lead lands on them; ALL may", async () => {
    const r = await post("rep", "/leads", { contactName: "New", contactPhone: "9000000001", companyName: "Fresh Co", assignedTo: ids.OTHER });
    expect(r.status).toBe(201);
    expect(String(r.body.lead.assignedTo)).toBe(ids.REP);
    const a = await post("admin", "/leads", { contactName: "New2", contactPhone: "9000000002", companyName: "Fresh Co 2", assignedTo: ids.OTHER });
    expect(String(a.body.lead.assignedTo)).toBe(ids.OTHER);
  });

  it("import/commit: an OWN rep's rows land on the importer even when assignedTo names someone else", async () => {
    const body = { rows: [{ Name: "Imp One", Phone: "9000000010", Company: "Import Co" }], mapping: { Name: "contactName", Phone: "contactPhone", Company: "companyName" }, defaults: { source: "manual" }, assignedTo: ids.OTHER };
    const r = await post("rep", "/leads/import/commit", body);
    expect(r.status).toBe(201);
    expect(r.body.summary.created).toBe(1);
    const created = await Lead.findById(r.body.created[0].leadId).lean();
    expect(String(created!.assignedTo)).toBe(ids.REP);
    const a = await post("admin", "/leads/import/commit", { ...body, rows: [{ Name: "Imp Two", Phone: "9000000011", Company: "Import Co 2" }] });
    expect(String((await Lead.findById(a.body.created[0].leadId).lean())!.assignedTo)).toBe(ids.OTHER);
  });
});

describe("leads — the FULL + OWN loophole", () => {
  it("assign / bulk-assign: FULL+OWN may hand over their OWN lead, never someone else's; FULL+ALL may do both", async () => {
    const mine = await lead({ assignedTo: FULLOWN, assignedToName: "Full Own" });
    const theirs = await lead({ assignedTo: OTHER, assignedToName: "Other" });
    expect((await post("fullown", `/leads/${theirs}/assign`, { userId: ids.FULLOWN })).status).toBe(403);
    expect(String((await Lead.findById(theirs).lean())!.assignedTo)).toBe(ids.OTHER);
    expect((await post("fullown", `/leads/${mine}/assign`, { userId: ids.OTHER })).status).toBe(200);
    const bulk = await post("fullown", "/leads/bulk-assign", { leadIds: [String(mine), String(theirs)], assignedTo: ids.FULLOWN });
    expect(bulk.status).toBe(200);
    // `mine` was handed to OTHER above, so FULL+OWN no longer owns it either → both refused, nothing moved.
    expect(bulk.body.failed.map((f: any) => f.reason)).toEqual(["This lead is owned by someone else.", "This lead is owned by someone else."]);
    expect(bulk.body.summary.updated).toBe(0);
    expect(String((await Lead.findById(theirs).lean())!.assignedTo)).toBe(ids.OTHER);
    // WRITE/OWN is refused outright (unchanged).
    expect((await post("rep", `/leads/${theirs}/assign`, { userId: ids.REP })).status).toBe(403);
    // FULL/ALL reassigns anyone's.
    expect((await post("admin", `/leads/${theirs}/assign`, { userId: ids.REP })).status).toBe(200);
  });
});

describe("company-check — dedupe without the id-discovery path", () => {
  it("OWN callers get match + counts + owner names only; ALL callers get the full rows", async () => {
    const co = await CRMCompany.create({ name: "Acme Corp", nameNormalized: "acme corp" } as any);
    await lead({ assignedTo: OTHER, assignedToName: "Other", companyId: co._id, companyName: "Acme Corp", contactName: "Their Contact", subDisposition: "Proposal sent", dispositionStage: "In-progress", dispositionStatus: "In-progress", nextFollowUpDate: now });
    const r = await get("rep", "/leads/company-check?name=Acme%20Corp");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ match: true, openCount: 1, total: 1, redacted: true });
    expect(r.body.leads).toHaveLength(1);
    expect(r.body.leads[0]).toEqual(expect.objectContaining({ _id: null, leadCode: "", contactName: "", subDisposition: "", dispositionStage: "", nextFollowUpDate: null, assignedTo: null, assignedToName: "Other", open: true }));
    const a = await get("admin", "/leads/company-check?name=Acme%20Corp");
    expect(a.body.redacted).toBeUndefined();
    expect(a.body.leads[0]).toMatchObject({ leadCode: expect.stringMatching(/^LEAD-S-/), contactName: "Their Contact", subDisposition: "Proposal sent" });
    expect(a.body.leads[0]._id).toBeTruthy();
  });
});

describe("exports", () => {
  it("export/activities with NO filter is scoped for OWN, whole collection for ALL", async () => {
    const mine = await lead({ assignedTo: REP, assignedToName: "Rep" });
    const theirs = await lead({ assignedTo: OTHER, assignedToName: "Other" });
    await LeadActivity.create({ leadId: mine, type: "note", note: "mine" } as any);
    await LeadActivity.create({ leadId: theirs, type: "note", note: "theirs" } as any);
    // Count rows via the xlsx's row count is heavy; assert through the same query path instead.
    const { activityMatch } = await import("../services/crmScope.js");
    const own = await LeadActivity.find(await activityMatch({ userId: REP, access: "WRITE", scope: "OWN" })).lean();
    expect(own.map((a) => a.note)).toEqual(["mine"]);
    const all = await LeadActivity.find(await activityMatch({ userId: REP, access: "FULL", scope: "ALL" })).lean();
    expect(all).toHaveLength(2);
    // And the route answers (200, an xlsx) for both — never 500 on the scoped branch.
    expect((await get("rep", "/leads/export/activities")).status).toBe(200);
    expect((await get("admin", "/leads/export/activities")).status).toBe(200);
  });
});

describe("aggregates — an OWN rep sees only their own numbers; ALL sees the team", () => {
  beforeEach(async () => {
    const mine = await lead({ assignedTo: REP, assignedToName: "Rep", dealValue: 100, dispositionStatus: "In-progress", disposition: "Interested", dispositionAt: now, nextFollowUpDate: new Date(now.getTime() - 86_400_000) });
    const mine2 = await lead({ assignedTo: REP, assignedToName: "Rep", dealValue: 200, stage: "won", dispositionStatus: "Won", wonDate: now });
    const theirs = await lead({ assignedTo: OTHER, assignedToName: "Other", dealValue: 4000, stage: "proposal_sent", nextFollowUpDate: new Date(now.getTime() - 86_400_000) });
    await lead({ dealValue: 8000, nextFollowUpDate: null }); // unassigned
    await opp(mine, REP, { dealValue: 1000 });
    await opp(theirs, OTHER, { dealValue: 9000 });
    await LeadActivity.create({ leadId: mine2, type: "won", note: "w" } as any);
    await LeadActivity.create({ leadId: theirs, type: "call", note: "c" } as any);
    await LeadActivity.create({ leadId: theirs, type: "won", note: "w2" } as any);
  });

  it("kpis / funnel / by-source / by-status / follow-up-health / activity / daily / monthly / summary", async () => {
    const k = await get("rep", "/leads/reports/kpis");
    expect(k.body).toMatchObject({ newLeads: { current: 2 }, open: 1, pipelineValue: 100, openOpportunities: { count: 1, value: 1000 } });
    // an owner param cannot widen an OWN rep
    expect((await get("rep", `/leads/reports/kpis?owner=${ids.OTHER}`)).body.newLeads.current).toBe(2);
    expect((await get("admin", "/leads/reports/kpis")).body).toMatchObject({ newLeads: { current: 4 }, open: 3, pipelineValue: 12_100, openOpportunities: { count: 2, value: 10_000 } });

    expect((await get("rep", "/leads/reports/funnel")).body.steps[0].count).toBe(2);
    expect((await get("admin", "/leads/reports/funnel")).body.steps[0].count).toBe(4);

    expect((await get("rep", "/leads/reports/by-source")).body.total).toBe(2);
    expect((await get("rep", "/leads/reports/by-status")).body.total).toBe(2);
    expect((await get("admin", "/leads/reports/by-status")).body.total).toBe(4);

    expect((await get("rep", "/leads/reports/follow-up-health")).body).toMatchObject({ open: 1, overdue: 1 });
    expect((await get("admin", "/leads/reports/follow-up-health")).body).toMatchObject({ open: 3, overdue: 2 });

    const act = await get("rep", "/leads/reports/activity");
    expect(act.body.total).toBe(1);
    expect((await get("admin", "/leads/reports/activity")).body.total).toBe(3);

    expect((await get("rep", "/leads/reports/daily?days=7")).body.daily.reduce((s: number, d: any) => s + d.created, 0)).toBe(2);
    expect((await get("rep", "/leads/reports/monthly?months=1")).body.monthly.reduce((s: number, d: any) => s + d.new, 0)).toBe(2);
    expect((await get("rep", "/leads/reports/summary")).body.wonCount).toBe(1);
    expect((await get("admin", "/leads/reports/summary")).body.wonCount).toBe(1);
  });

  it("pipeline-summary and counts-by-stage: the Leads page header numbers match the scoped cards", async () => {
    const ps = await get("rep", "/leads/pipeline-summary");
    expect(ps.status).toBe(200);
    expect(ps.body.kpis).toMatchObject({ openPipelineValue: 100, activeCount: 1, wonThisMonthValue: 200, overdueFollowups: 1 });
    expect(ps.body.trends.wonThisMonthCount).toBe(1);
    const adminPs = await get("admin", "/leads/pipeline-summary");
    expect(adminPs.body.kpis).toMatchObject({ openPipelineValue: 12_100, activeCount: 3, overdueFollowups: 2 });
    expect(adminPs.body.trends.wonThisMonthCount).toBe(2);

    expect((await get("rep", "/leads/counts-by-stage")).body).toEqual({ new: 1, won: 1 });
    expect((await get("admin", "/leads/counts-by-stage")).body).toEqual({ new: 2, won: 1, proposal_sent: 1 });
  });

  it("by-rep is ALL-only; hygiene is the caller's own row for OWN, whatever owner says", async () => {
    expect((await get("rep", "/leads/reports/by-rep")).status).toBe(403);
    expect((await get("fullown", "/leads/reports/by-rep")).status).toBe(403);
    const admin = await get("admin", "/leads/reports/by-rep");
    expect(admin.body.reps.map((r: any) => r.repName).sort()).toEqual(["Other", "Rep", "Unassigned"]);

    const h = await get("rep", `/leads/reports/hygiene?owner=${ids.OTHER}`);
    expect(h.status).toBe(200);
    expect(h.body.byOwner.map((o: any) => o.ownerName)).toEqual(["Rep"]);
    expect(h.body.openTotal).toBe(1);
    expect((await get("admin", "/leads/reports/hygiene")).body.byOwner.map((o: any) => o.ownerName).sort()).toEqual(["Other", "Rep", "Unassigned"]);
  });

  it("opportunities: OWN list / summary / :id via the shared helper; :id outside scope is 404", async () => {
    expect((await get("rep", "/opportunities")).body.total).toBe(1);
    expect((await get("rep", `/opportunities?owner=${ids.OTHER}`)).body.total).toBe(1);
    expect((await get("rep", "/opportunities/summary")).body.open).toMatchObject({ count: 1, value: 1000 });
    expect((await get("admin", "/opportunities")).body.total).toBe(2);
    const theirs = await Opportunity.findOne({ ownerUserId: OTHER }).lean();
    expect((await get("rep", `/opportunities/${theirs!._id}`)).status).toBe(404);
    expect((await get("admin", `/opportunities/${theirs!._id}`)).status).toBe(200);
  });
});

describe("companies / contacts — detail and rollups follow the viewer's scope", () => {
  it("company :id: contacts by the crmContacts scope, deals by the leads scope; list rollups count the viewer's rows", async () => {
    const co = await CRMCompany.create({ name: "Shared Co", nameNormalized: "shared co", createdBy: OTHER, isPrivate: false } as any);
    const mineLead = await lead({ assignedTo: REP, assignedToName: "Rep", companyId: co._id });
    const theirLead = await lead({ assignedTo: OTHER, assignedToName: "Other", companyId: co._id });
    await lead({ assignedTo: OTHER, assignedToName: "Other", companyId: co._id, stage: "won", status: "CONVERTED" });
    await opp(mineLead, REP, { companyId: co._id, name: "mine" });
    await opp(theirLead, OTHER, { companyId: co._id, name: "theirs" });
    await CRMContact.create([
      { firstName: "Mine", lastName: "C", email: "m@x.test", phone: "1", companyId: co._id, companyName: "Shared Co", assignedTo: REP, createdBy: OTHER },
      { firstName: "Theirs", lastName: "C", email: "t@x.test", phone: "1", companyId: co._id, companyName: "Shared Co", assignedTo: OTHER, createdBy: OTHER },
    ] as any);

    const r = await get("rep", `/crm/companies/${co._id}`);
    expect(r.status).toBe(200); // the company itself is a shared entity
    expect(r.body.contacts.map((c: any) => c.firstName)).toEqual(["Mine"]);
    expect(r.body.company.contactCount).toBe(1);
    expect(r.body.opportunities.map((o: any) => o.name)).toEqual(["mine"]);
    const a = await get("admin", `/crm/companies/${co._id}`);
    expect(a.body.contacts).toHaveLength(2);
    expect(a.body.company.contactCount).toBe(2);
    expect(a.body.opportunities).toHaveLength(2);

    // list rollups — the company is visible to admin (OWN reps only list companies they created)
    const list = await get("admin", "/crm/companies");
    const row = list.body.companies.find((c: any) => String(c._id) === String(co._id));
    expect(row).toMatchObject({ leadCount: 3, openLeadCount: 2, opportunityCount: 2, openOpportunityCount: 2 });
    // give REP a company of their own to see the scoped rollup on the list
    const own = await CRMCompany.create({ name: "Rep Co", nameNormalized: "rep co", createdBy: REP, isPrivate: false } as any);
    await lead({ assignedTo: REP, assignedToName: "Rep", companyId: own._id });
    await lead({ assignedTo: OTHER, assignedToName: "Other", companyId: own._id });
    const repList = await get("rep", "/crm/companies");
    const repRow = repList.body.companies.find((c: any) => String(c._id) === String(own._id));
    expect(repRow).toMatchObject({ leadCount: 1, openLeadCount: 1 });
  });

  it("contact :id: another rep's contact is 404; own contact's linked lead / deal follow the leads scope", async () => {
    const theirLead = await lead({ assignedTo: OTHER, assignedToName: "Other" });
    const myLead = await lead({ assignedTo: REP, assignedToName: "Rep" });
    await opp(theirLead, OTHER, { name: "theirs" });
    await opp(myLead, REP, { name: "mine" });
    const [theirs, mine, reassigned] = (await CRMContact.create([
      { firstName: "Theirs", lastName: "C", email: "t2@x.test", phone: "1", assignedTo: OTHER, createdBy: OTHER, leadId: theirLead },
      { firstName: "Mine", lastName: "C", email: "m2@x.test", phone: "1", assignedTo: REP, createdBy: REP, leadId: myLead },
      // assigned to me but its lead moved to someone else — contact visible, lead/deal not
      { firstName: "Moved", lastName: "C", email: "mv@x.test", phone: "1", assignedTo: REP, createdBy: OTHER, leadId: theirLead },
    ] as any[])) as unknown as any[];
    expect((await get("rep", `/crm/contacts/${theirs._id}`)).status).toBe(404);
    const m = await get("rep", `/crm/contacts/${mine._id}`);
    expect(m.status).toBe(200);
    expect(m.body.linkedLead.leadCode).toBeTruthy();
    expect(m.body.opportunity.name).toBe("mine");
    const mv = await get("rep", `/crm/contacts/${reassigned._id}`);
    expect(mv.status).toBe(200);
    expect(mv.body.linkedLead).toBeNull();
    expect(mv.body.opportunity).toBeNull();
    expect((await get("admin", `/crm/contacts/${theirs._id}`)).body.opportunity.name).toBe("theirs");
  });
});
