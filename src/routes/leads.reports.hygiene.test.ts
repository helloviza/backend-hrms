// GET /leads/reports/hygiene + the owner / source scope on the command-center
// aggregates (kpis · funnel · by-source · by-rep · by-status) + the extended
// agent-wise row (avg open age, activity mix) — against REAL collections
// (mongodb-memory-server). The Owner Wise report page and its
// /reports/owner-status route are retired; this is what replaced them.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-reports-hygiene-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: ADMIN_ID, sub: ADMIN_ID, roles: ["ADMIN"], email: "ops@plumtrips.com" };
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
const { default: router } = await import("./leads.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/leads", router);
  return a;
}
const get = (path: string) => request(app()).get(`/api/leads/reports/${path}`);

const DAY = 86_400_000;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY - 60_000); // n days + 1 min ago so floor() lands on n
const IMRAN = new mongoose.Types.ObjectId();
const NEEL = new mongoose.Types.ObjectId();

let seq = 0;
async function lead(o: Partial<Record<string, any>>) {
  seq += 1;
  const _id = new mongoose.Types.ObjectId();
  await Lead.collection.insertOne({
    _id, leadCode: `LEAD-T-${String(seq).padStart(4, "0")}`, type: "company", companyName: `Co ${seq}`, contactName: `P${seq}`, contactPhone: "1",
    stage: "new", status: null, source: "manual", sourceChannel: "", dealValue: 0, currency: "INR", disposition: "", subDisposition: "", dispositionStage: "", dispositionStatus: "", dispositionAt: null,
    opportunityId: null, nextFollowUpDate: null, createdAt: now, updatedAt: now, ...o,
  } as any);
  return _id;
}
async function act(leadId: mongoose.Types.ObjectId, type: string, createdAt: Date) {
  await LeadActivity.collection.insertOne({ leadId, type, note: type, createdAt, updatedAt: createdAt } as any);
}
async function opp(leadId: mongoose.Types.ObjectId, o: Partial<Record<string, any>>) {
  const _id = new mongoose.Types.ObjectId();
  await Opportunity.collection.insertOne({ _id, opportunityCode: `OPP-T-${String(++seq).padStart(4, "0")}`, name: "d", pipeline: "corporate", stage: "proposal", probability: 65, dealValue: 0, currency: "INR", closedAt: null, leadId, ownerUserId: IMRAN, serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now, ...o } as any);
  await Lead.updateOne({ _id: leadId }, { $set: { opportunityId: _id } });
  return _id;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({})]);
});

describe("GET /reports/hygiene — ageing + stale + ₹ at risk per owner, v2 vocabulary", () => {
  it("buckets OPEN leads by days since last activity and sums the open Opportunity value on stale ones", async () => {
    // Imran: fresh (2d) · stale 20d with an open deal ₹3L · critical 45d with ₹0 lead value but ₹5L deal · CONVERTED lead whose deal is closed-won (not open)
    const a = await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(10) });
    await act(a, "call", daysAgo(2));
    const b = await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(40), dealValue: 999_999 }); // Lead.dealValue must NOT be what is summed
    await act(b, "note", daysAgo(20));
    await opp(b, { stage: "negotiation", dealValue: 300_000 });
    const c = await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(45), status: "CONVERTED", stage: "proposal_sent" });
    await opp(c, { stage: "proposal", dealValue: 500_000 }); // no activity → last activity = created 45d ago
    const d = await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(90), status: "CONVERTED", stage: "won", dispositionStatus: "Won" });
    await opp(d, { stage: "closed_won", closedAt: daysAgo(30), dealValue: 900_000 });
    // Neel: one lost-at-lead-grain (not open) · one 9d old open
    await lead({ assignedTo: NEEL, assignedToName: "Neel", createdAt: daysAgo(30), status: "LOST", stage: "lost", dispositionStatus: "Lost" });
    const n2 = await lead({ assignedTo: NEEL, assignedToName: "Neel", createdAt: daysAgo(9) });
    // Unassigned open, 70d untouched
    await lead({ createdAt: daysAgo(70) });
    void n2;

    const r = await get("hygiene");
    expect(r.status).toBe(200);
    expect(r.body.openTotal).toBe(5);
    expect(r.body.buckets).toEqual([
      { key: "0-7", label: "0–7 days", count: 1 },
      { key: "8-14", label: "8–14 days", count: 1 },
      { key: "15-30", label: "15–30 days", count: 1 },
      { key: "31-60", label: "31–60 days", count: 1 },
      { key: "60+", label: "60+ days", count: 1 },
    ]);
    expect(r.body.stale).toEqual({ thresholdDays: 14, criticalDays: 30, total: 3, critical: 2, atRisk: 800_000 });
    const byName = Object.fromEntries(r.body.byOwner.map((o: any) => [o.ownerName, o]));
    expect(byName.Imran).toMatchObject({ ownerId: String(IMRAN), open: 3, stale: 2, critical: 1, atRisk: 800_000, buckets: { "0-7": 1, "8-14": 0, "15-30": 1, "31-60": 1, "60+": 0 } });
    expect(byName.Neel).toMatchObject({ open: 1, stale: 0, critical: 0, atRisk: 0, buckets: { "8-14": 1 } });
    expect(byName.Unassigned).toMatchObject({ ownerId: null, open: 1, stale: 1, critical: 1, atRisk: 0 });
    // sorted stale desc
    expect(r.body.byOwner[0].ownerName).toBe("Imran");
  });

  it("scopes by owner (id | unassigned) and by source (sourceChannel, else legacy source)", async () => {
    const a = await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(20), source: "website" });
    await opp(a, { dealValue: 100_000 });
    await lead({ assignedTo: NEEL, assignedToName: "Neel", createdAt: daysAgo(20), source: "other", sourceChannel: "whatsapp" });
    await lead({ createdAt: daysAgo(20), source: "website" });

    expect((await get(`hygiene?owner=${IMRAN}`)).body).toMatchObject({ openTotal: 1, stale: { total: 1, atRisk: 100_000 } });
    expect((await get("hygiene?owner=unassigned")).body.byOwner.map((o: any) => o.ownerName)).toEqual(["Unassigned"]);
    expect((await get("hygiene?source=website")).body.byOwner.map((o: any) => o.ownerName).sort()).toEqual(["Imran", "Unassigned"]);
    expect((await get("hygiene?source=whatsapp")).body.byOwner.map((o: any) => o.ownerName)).toEqual(["Neel"]);
    expect((await get("hygiene?source=other")).body.openTotal).toBe(0); // "other" is overridden by the channel
  });
});

describe("owner / source scope on the command-center aggregates", () => {
  beforeEach(async () => {
    await lead({ assignedTo: IMRAN, assignedToName: "Imran", source: "website", dealValue: 10, dispositionStatus: "In-progress", disposition: "Interested", dispositionAt: now });
    await lead({ assignedTo: IMRAN, assignedToName: "Imran", source: "website", dealValue: 20, stage: "won", dispositionStatus: "Won" });
    await lead({ assignedTo: NEEL, assignedToName: "Neel", source: "referral", dealValue: 40 });
    await lead({ source: "other", sourceChannel: "whatsapp", dealValue: 80 }); // unassigned
    await Opportunity.collection.insertMany([
      { opportunityCode: "OPP-S-1", name: "a", pipeline: "corporate", stage: "proposal", probability: 65, dealValue: 1000, currency: "INR", ownerUserId: IMRAN, serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now },
      { opportunityCode: "OPP-S-2", name: "b", pipeline: "corporate", stage: "proposal", probability: 65, dealValue: 2000, currency: "INR", ownerUserId: NEEL, serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now },
    ] as any[]);
  });

  it("kpis: owner narrows new leads, open pipeline and open opportunities; source narrows the same", async () => {
    const all = await get("kpis");
    expect(all.body).toMatchObject({ newLeads: { current: 4 }, open: 3, pipelineValue: 130, openOpportunities: { count: 2, value: 3000 } });
    const imran = await get(`kpis?owner=${IMRAN}`);
    expect(imran.body).toMatchObject({ newLeads: { current: 2 }, open: 1, pipelineValue: 10, openOpportunities: { count: 1, value: 1000 } });
    const un = await get("kpis?owner=unassigned");
    expect(un.body).toMatchObject({ newLeads: { current: 1 }, open: 1, pipelineValue: 80, openOpportunities: { count: 0 } });
    const web = await get("kpis?source=website");
    expect(web.body).toMatchObject({ newLeads: { current: 2 }, open: 1, pipelineValue: 10 });
    // prior period keeps the scope
    const from = new Date(now.getTime() - DAY), to = new Date(now.getTime() + DAY);
    const bounded = await get(`kpis?owner=${IMRAN}&dateFrom=${encodeURIComponent(from.toISOString())}&dateTo=${encodeURIComponent(to.toISOString())}`);
    expect(bounded.body.newLeads).toEqual({ current: 2, prior: 0 });
  });

  it("funnel, by-source and by-status follow the owner filter", async () => {
    const f = await get(`funnel?owner=${IMRAN}`);
    expect(f.body.steps.map((s: any) => s.count)).toEqual([2, 2, 2, 1, 1]);
    const s = await get(`by-source?owner=${NEEL}`);
    expect(s.body.sources).toEqual([expect.objectContaining({ source: "referral", leads: 1 })]);
    const st = await get("by-status?owner=unassigned");
    expect(st.body.total).toBe(1);
    expect(st.body.byStatus.find((b: any) => b.status === "Open")).toMatchObject({ count: 1, value: 80 });
  });

  it("by-rep follows owner / source and carries avg open age + the activity mix per owner", async () => {
    await Lead.deleteMany({});
    const a = await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(10) });
    const b = await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(30) });
    const c = await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(100), stage: "won", dispositionStatus: "Won" }); // closed — excluded from age
    await lead({ assignedTo: NEEL, assignedToName: "Neel", createdAt: daysAgo(5), source: "referral" });
    await act(a, "call", now); await act(a, "call", now); await act(a, "note", now); await act(a, "disposition", now); // disposition is not an interaction
    await act(b, "email", now); await act(c, "meeting", now);

    const r = await get("by-rep");
    const byName = Object.fromEntries(r.body.reps.map((x: any) => [x.repName, x]));
    expect(byName.Imran).toMatchObject({ total: 3, open: 2, avgOpenAgeDays: 20, activity: { calls: 2, emails: 1, meetings: 1, notes: 1, total: 5 } });
    expect(byName.Neel).toMatchObject({ total: 1, open: 1, avgOpenAgeDays: 5, activity: { calls: 0, emails: 0, meetings: 0, notes: 0, total: 0 } });

    expect((await get(`by-rep?owner=${NEEL}`)).body.reps.map((x: any) => x.repName)).toEqual(["Neel"]);
    expect((await get("by-rep?source=referral")).body.reps.map((x: any) => x.repName)).toEqual(["Neel"]);
    // nothing open → avg age is null, not 0
    await Lead.deleteMany({});
    await lead({ assignedTo: NEEL, assignedToName: "Neel", stage: "lost", dispositionStatus: "Lost" });
    expect((await get("by-rep")).body.reps[0].avgOpenAgeDays).toBeNull();
  });
});

describe("GET /reports/owner-status — LEGACY Owner Wise report (flags-off /crm/reports)", () => {
  it("still serves the legacy 9-stage vocabulary the pre-v2 Reports page indexes by", async () => {
    await Lead.deleteMany({});
    await lead({ assignedTo: NEEL, assignedToName: "Neel", stage: "contacted" });
    await lead({ assignedTo: NEEL, assignedToName: "Neel", stage: "won" });
    await lead({ assignedTo: NEEL, assignedToName: "Neel", stage: "lost" });
    const r = await get("owner-status");
    expect(r.status).toBe(200);
    // legacy stage keys, not the v2 statuses (NEW / CONTACTED / CONVERTED / LOST)
    const stages = r.body.statusSnapshot.map((s: any) => s.stage);
    expect(stages).toEqual(expect.arrayContaining(["new", "contacted", "proposal_sent", "won", "lost"]));
    expect(stages).not.toContain("CONVERTED");
    expect(r.body.totals.byStatus).toMatchObject({ contacted: 1, won: 1, lost: 1 });
    expect(r.body.ownerMatrix.owners.some((o: any) => o.ownerName === "Neel" && o.total === 3)).toBe(true);
  });
});
