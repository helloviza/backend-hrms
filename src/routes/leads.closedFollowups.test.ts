// Closed leads never read as due / overdue, and "open" is ONE rule everywhere.
// Real Mongo (memory server), the real routers, an ALL-scope admin.
//
//   • models/crmTaxonomy isOpenLead (JS) and OPEN_LEAD_MATCH (Mongo) agree on
//     every shape a lead can be in — dispositioned, legacy, partially migrated
//   • GET /leads?dueBefore= (the Leads page Today pill + count) and
//     /export?dueBefore= return OPEN leads only — a Won / Lost lead that still
//     carries a (pre-fix) follow-up date is not today's work
//   • /pipeline-summary followupsDue / overdueFollowups and
//     /reports/follow-up-health count OPEN leads only
//   • /crm/companies openLeadCount counts Proposal / Negotiation leads
//     (disposition Open, lead status CONVERTED) as open
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import ExcelJS from "exceljs";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-closed-followups-test";
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
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { isOpenLead, OPEN_LEAD_MATCH } = await import("../models/crmTaxonomy.js");
const { default: leadsRouter } = await import("./leads.js");
const { default: companiesRouter } = await import("./crm.companies.js");
const { ensureDefaultPipeline } = await import("../services/crmPipelines.js");

let mongod: MongoMemoryServer;
const app = express();
app.use(express.json());
app.use("/api/leads", leadsRouter);
app.use("/api/crm/companies", companiesRouter);
const get = (path: string) => request(app).get(`/api${path}`);

const now = new Date();
const yesterday = new Date(now.getTime() - 86_400_000);
const tomorrowCutoff = new Date(now.getTime() + 86_400_000).toISOString();
let seq = 0;
async function lead(code: string, o: Record<string, any> = {}) {
  seq += 1;
  const _id = new mongoose.Types.ObjectId();
  await Lead.collection.insertOne({
    _id, leadCode: code, type: "company", companyName: `Co ${seq}`, contactName: `Person ${seq}`, contactPhone: `97${String(seq).padStart(8, "0")}`,
    stage: "new", source: "manual", dealValue: 1000, currency: "INR", nextFollowUpDate: yesterday, createdAt: now, updatedAt: now, ...o,
  } as any);
  return _id;
}

/** Every shape, all overdue. `open` is what the Leads page / Inbox rule says. */
const MATRIX: Array<{ code: string; open: boolean; o: Record<string, any> }> = [
  { code: "L-LEGACY-NEW", open: true, o: { stage: "new" } },
  { code: "L-LEGACY-FOLLOWUP", open: true, o: { stage: "follow_up" } },
  { code: "L-LEGACY-WON", open: false, o: { stage: "won" } },
  { code: "L-LEGACY-LOST", open: false, o: { stage: "lost" } },
  // legacy Proposal / Negotiation (status CONVERTED, stored or derived) is OPEN — never won
  { code: "L-LEGACY-PROPOSAL", open: true, o: { stage: "proposal_sent" } },
  { code: "L-LEGACY-NEG-CONVERTED", open: true, o: { stage: "negotiation", status: "CONVERTED" } },
  // …unless it was won / onboarded (wonDate) without the stage saying so
  { code: "L-LEGACY-WONDATE", open: false, o: { stage: "proposal_sent", status: "CONVERTED", wonDate: yesterday } },
  { code: "L-STATUS-CONTACTED", open: true, o: { stage: "contacted", status: "CONTACTED", dispositionStatus: "" } },
  { code: "L-STATUS-NURTURE", open: true, o: { stage: "follow_up", status: "NURTURE" } },
  { code: "L-STATUS-LOST", open: false, o: { stage: "contacted", status: "LOST" } },
  { code: "L-V2-PROPOSAL", open: true, o: { stage: "proposal_sent", status: "CONVERTED", disposition: "Interested", subDisposition: "Proposal Mail Sent", dispositionStage: "In-progress", dispositionStatus: "Open" } },
  { code: "L-V2-NEGOTIATION", open: true, o: { stage: "negotiation", status: "CONVERTED", disposition: "Interested", subDisposition: "Negotiation in Progress", dispositionStage: "In-progress", dispositionStatus: "In-progress" } },
  { code: "L-V2-LOST", open: false, o: { stage: "lost", status: "LOST", disposition: "Not Interested", subDisposition: "Repeated RNR", dispositionStage: "Lost", dispositionStatus: "Lost" } },
  { code: "L-V2-WON", open: false, o: { stage: "won", status: "CONVERTED", disposition: "Onboarded", subDisposition: "Onboarded", dispositionStage: "Onboarded", dispositionStatus: "Won" } },
  // a closed disposition beats an open-looking legacy stage / status
  { code: "L-V2-LOST-ODD", open: false, o: { stage: "contacted", status: "CONTACTED", dispositionStatus: "Lost" } },
];
const OPEN_CODES = MATRIX.filter((m) => m.open).map((m) => m.code).sort();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), CRMCompany.deleteMany({})]);
  await ensureDefaultPipeline();
});

describe("the open-lead rule", () => {
  it("isOpenLead and OPEN_LEAD_MATCH agree on every lead shape", async () => {
    for (const m of MATRIX) await lead(m.code, m.o);
    const all = await Lead.find({}).lean();
    for (const m of MATRIX) {
      const row = all.find((l: any) => l.leadCode === m.code)!;
      expect(isOpenLead(row as any), m.code).toBe(m.open);
    }
    const viaMongo = (await Lead.find(OPEN_LEAD_MATCH).lean()).map((l: any) => l.leadCode).sort();
    expect(viaMongo).toEqual(OPEN_CODES);
  });
});

describe("Leads page Today — open leads only", () => {
  it("GET /leads?dueBefore= and its count skip Won / Lost leads that still carry a follow-up date", async () => {
    for (const m of MATRIX) await lead(m.code, m.o);
    const r = await get(`/leads?dueBefore=${encodeURIComponent(tomorrowCutoff)}&limit=100`);
    expect(r.status).toBe(200);
    expect((r.body.leads as any[]).map((l) => l.leadCode).sort()).toEqual(OPEN_CODES);
    expect(r.body.total).toBe(OPEN_CODES.length);
    // the pill's light count (limit=1) reads the same total
    expect((await get(`/leads?dueBefore=${encodeURIComponent(tomorrowCutoff)}&limit=1`)).body.total).toBe(OPEN_CODES.length);
    // the All view is untouched — closed leads are still listed there
    expect((await get("/leads?limit=100")).body.total).toBe(MATRIX.length);
  });

  it("Today AND search compose (search keeps its own $or)", async () => {
    await lead("L-SEARCH-OPEN", { contactName: "Needle Open" });
    await lead("L-SEARCH-LOST", { contactName: "Needle Lost", stage: "lost", status: "LOST", dispositionStatus: "Lost" });
    await lead("L-OTHER-OPEN", { contactName: "Haystack" });
    const r = await get(`/leads?dueBefore=${encodeURIComponent(tomorrowCutoff)}&search=Needle&limit=100`);
    expect((r.body.leads as any[]).map((l) => l.leadCode)).toEqual(["L-SEARCH-OPEN"]);
  });

  it("/export?dueBefore= downloads the same open rows", async () => {
    for (const m of MATRIX) await lead(m.code, m.o);
    const res = await get(`/leads/export?dueBefore=${encodeURIComponent(tomorrowCutoff)}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as any);
    const sheet = wb.worksheets[0];
    const header = (sheet.getRow(1).values as any[]).slice(1).map(String);
    const col = header.indexOf("Lead Code");
    const codes: string[] = [];
    sheet.eachRow((row, n) => {
      if (n > 1) codes.push(String((row.values as any[]).slice(1)[col]));
    });
    expect(codes.sort()).toEqual(OPEN_CODES);
  });
});

describe("Leads page follow-up health — /pipeline-summary", () => {
  it("followupsDue per stage and overdueFollowups count OPEN leads only", async () => {
    for (const m of MATRIX) await lead(m.code, m.o);
    const r = await get("/leads/pipeline-summary");
    expect(r.status).toBe(200);
    expect(r.body.kpis.overdueFollowups).toBe(OPEN_CODES.length);
    const due = (s: string) => r.body.perStage[s]?.followupsDue ?? 0;
    expect(due("won")).toBe(0);
    expect(due("lost")).toBe(0);
    expect(due("proposal_sent")).toBe(2); // v2 Proposal + legacy Proposal; the wonDate one is closed
    expect(due("negotiation")).toBe(2); // v2 Negotiation + legacy CONVERTED
    expect(due("contacted")).toBe(1); // L-STATUS-CONTACTED; L-STATUS-LOST and L-V2-LOST-ODD are closed
    expect(due("new")).toBe(1);
    expect(due("follow_up")).toBe(2);
  });

  it("the Command Center follow-up-health card counts the same open leads", async () => {
    for (const m of MATRIX) await lead(m.code, m.o);
    const r = await get("/leads/reports/follow-up-health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ open: OPEN_CODES.length, overdue: OPEN_CODES.length, noNextAction: 0 });
  });
});

describe("Companies — Open leads", () => {
  it("openLeadCount counts Proposal / Negotiation leads as open, with the Leads page rule", async () => {
    const co = await CRMCompany.create({ name: "Acme", nameNormalized: "acme", createdBy: new mongoose.Types.ObjectId(ADMIN_ID), isPrivate: false } as any);
    for (const m of MATRIX) await lead(m.code, { ...m.o, companyId: co._id });
    const r = await get("/crm/companies");
    expect(r.status).toBe(200);
    const row = (r.body.companies as any[]).find((c) => String(c._id) === String(co._id));
    expect(row).toMatchObject({ leadCount: MATRIX.length, openLeadCount: OPEN_CODES.length });
  });
});
