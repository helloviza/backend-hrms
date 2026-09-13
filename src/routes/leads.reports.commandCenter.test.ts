// GET /leads/reports/funnel · by-source · kpis · follow-up-health · activity —
// the CRM command center aggregates, against a REAL leads / leadactivities /
// opportunities collection (mongodb-memory-server). Rows are written straight
// to the collection so the fixture controls status / disposition / dates.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-reports-cc-test";
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
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
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

describe("GET /reports/funnel", () => {
  it("returns cumulative step counts and conversion % from the disposition / status / opportunity data", async () => {
    // 10 leads: 2 untouched, 8 contacted; of those 5 interested; of those 3 with an opportunity; of those 2 won.
    await lead({});
    await lead({ stage: "new" });
    await lead({ stage: "contacted" }); // contacted via legacy stage
    await lead({ disposition: "Not Connected", dispositionStatus: "Open", dispositionAt: now }); // contacted via a disposition
    await lead({ status: "CONTACTED" }); // contacted via v2 status
    await lead({ disposition: "Interested", dispositionStatus: "In-progress", dispositionStage: "In-progress", dispositionAt: now }); // interested
    await lead({ stage: "demo_scheduled" }); // interested via ENGAGED
    await lead({ status: "CONVERTED", opportunityId: new mongoose.Types.ObjectId(), disposition: "Interested", dispositionStatus: "In-progress", dispositionAt: now }); // opportunity
    await lead({ stage: "won", dispositionStatus: "Won", dispositionStage: "Onboarded", dispositionAt: now, dealValue: 100_000, opportunityId: new mongoose.Types.ObjectId() }); // won
    await lead({ stage: "won", dealValue: 50_000 }); // legacy won → CONVERTED + Won

    const r = await get("funnel");
    expect(r.status).toBe(200);
    expect(r.body.steps.map((s: any) => [s.key, s.count, s.fromPrevious, s.fromTop])).toEqual([
      ["leads", 10, null, null],
      ["contacted", 8, 80, 80],
      ["interested", 5, 62.5, 50],
      ["opportunity", 3, 60, 30],
      ["won", 2, 66.7, 20],
    ]);
    expect(r.body.wonValue).toBe(150_000);
    expect(r.body.overallConversion).toBe(20);
  });

  it("treats ABSENT dispositionAt / opportunityId / nextFollowUpDate like null (prod rows predate those paths)", async () => {
    // Raw inserts with NO disposition / opportunity / follow-up fields at all —
    // the shape of every pre-migration prod row. `$ne: ["$missing", null]` is
    // true in an aggregation, which made the prod-copy funnel read 939/939
    // contacted and 939 opportunities, and follow-up health 695 overdue.
    const bare = (o: Record<string, any>) => ({ _id: new mongoose.Types.ObjectId(), type: "company", stage: "new", source: "manual", dealValue: 0, createdAt: now, updatedAt: now, ...o });
    await Lead.collection.insertMany([bare({ stage: "new" }), bare({ stage: "new" }), bare({ stage: "contacted" }), bare({ stage: "won" })] as any);

    const funnel = await get("funnel");
    expect(funnel.body.steps.map((s: any) => [s.key, s.count])).toEqual([["leads", 4], ["contacted", 2], ["interested", 1], ["opportunity", 1], ["won", 1]]);

    const health = await get("follow-up-health");
    expect(health.body).toMatchObject({ open: 3, overdue: 0, noNextAction: 3 });
  });

  it("is zero-safe with no leads and honours the date range", async () => {
    await lead({ createdAt: daysAgo(40), stage: "won" });
    const r = await get(`funnel?dateFrom=${encodeURIComponent(daysAgo(7).toISOString())}`);
    expect(r.body.steps.map((s: any) => [s.count, s.fromPrevious])).toEqual([[0, null], [0, null], [0, null], [0, null], [0, null]]);
    expect(r.body.overallConversion).toBeNull();
  });
});

describe("GET /reports/by-source", () => {
  it("aggregates source-to-outcome per source, preferring sourceChannel over the legacy source", async () => {
    await lead({ source: "linkedin", dealValue: 10_000 }); // open
    await lead({ source: "linkedin", stage: "contacted", dealValue: 20_000, disposition: "Interested", dispositionStatus: "In-progress", dispositionAt: now }); // interested, open
    await lead({ source: "linkedin", stage: "won", dispositionStatus: "Won", dispositionAt: now, dealValue: 300_000, opportunityId: new mongoose.Types.ObjectId() }); // won
    await lead({ source: "linkedin", stage: "lost", dealValue: 5_000 }); // lost
    await lead({ source: "manual", sourceChannel: "referral", dealValue: 40_000 }); // sourceChannel wins
    await lead({ source: "website" });

    const r = await get("by-source");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(6);
    const by = Object.fromEntries(r.body.sources.map((s: any) => [s.source, s]));
    expect(by.linkedin).toEqual({ source: "linkedin", leads: 4, contacted: 3, interested: 2, opportunities: 1, won: 1, lost: 1, wonValue: 300_000, pipelineValue: 30_000, conversion: 25 });
    expect(by.referral).toMatchObject({ leads: 1, won: 0, pipelineValue: 40_000, conversion: 0 });
    expect(by.website).toMatchObject({ leads: 1 });
    expect(by.manual).toBeUndefined();
    expect(r.body.sources[0].source).toBe("linkedin"); // most leads first
  });
});

describe("GET /reports/kpis — deltas only with a real prior period", () => {
  it("carries a prior count when the range is bounded on both ends, and none otherwise", async () => {
    // Window: last 7 days. Prior window: the 7 days before that.
    await lead({ createdAt: daysAgo(1) });
    await lead({ createdAt: daysAgo(3) });
    await lead({ createdAt: daysAgo(9) });
    await lead({ createdAt: daysAgo(12) });
    await lead({ createdAt: daysAgo(13) });
    await lead({ createdAt: daysAgo(30) });
    const from = daysAgo(7).toISOString();
    const to = now.toISOString();

    const bounded = await get(`kpis?dateFrom=${encodeURIComponent(from)}&dateTo=${encodeURIComponent(to)}`);
    expect(bounded.status).toBe(200);
    expect(bounded.body.newLeads).toEqual({ current: 2, prior: 3 });
    expect(bounded.body.period.prior).not.toBeNull();

    const openEnded = await get(`kpis?dateFrom=${encodeURIComponent(from)}`);
    expect(openEnded.body.newLeads).toEqual({ current: 2, prior: null });
    expect(openEnded.body.period).toBeNull();

    const allTime = await get("kpis");
    expect(allTime.body.newLeads).toEqual({ current: 6, prior: null });
  });

  it("counts hot, open pipeline value and open opportunities", async () => {
    const oppOwner = new mongoose.Types.ObjectId();
    const hotId = await lead({ nextFollowUpDate: daysAgo(2), dealValue: 10_000 }); // overdue → hot
    await lead({ stage: "proposal_sent", dealValue: 20_000 }); // late stage, no fresh touch → not hot; still open pipeline (disposition Open)
    await lead({ stage: "contacted", dealValue: 30_000 }); // open, warm
    await lead({ stage: "won", dealValue: 99_000 }); // closed
    await LeadActivity.collection.insertOne({ leadId: hotId, type: "call", note: "", createdAt: now, updatedAt: now } as any);
    await Opportunity.collection.insertMany([
      { opportunityCode: "OPP-T-1", name: "a", pipeline: "corporate", stage: "proposal", probability: 65, dealValue: 80_000, currency: "INR", ownerUserId: oppOwner, serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now },
      { opportunityCode: "OPP-T-2", name: "b", pipeline: "corporate", stage: "closed_lost", probability: 0, dealValue: 5_000, currency: "INR", ownerUserId: oppOwner, serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now },
    ] as any[]);

    const r = await get("kpis");
    expect(r.body.hot).toBe(1);
    expect(r.body.open).toBe(3);
    expect(r.body.pipelineValue).toBe(60_000);
    expect(r.body.openOpportunities).toEqual({ count: 1, value: 80_000 });
  });
});

describe("GET /reports/follow-up-health + /reports/activity", () => {
  it("counts due today / overdue / no next action / SLA risk over open leads with the Inbox definitions", async () => {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dueBefore = new Date(todayStart.getTime() + DAY);
    await lead({ nextFollowUpDate: new Date(Math.min(now.getTime() + 60_000, dueBefore.getTime() - 1)) }); // due later today (not overdue)
    await lead({ nextFollowUpDate: daysAgo(2) }); // overdue
    await lead({ nextFollowUpDate: daysAgo(0.001) }); // overdue by a minute (still today)
    const untouched = await lead({ createdAt: daysAgo(2) }); // NEW, > 1 day, no activity → SLA risk
    const touched = await lead({ createdAt: daysAgo(2) }); // NEW, > 1 day, but has activity
    await LeadActivity.collection.insertOne({ leadId: touched, type: "call", note: "", createdAt: now, updatedAt: now } as any);
    await lead({ createdAt: daysAgo(0.5) }); // NEW but fresh
    await lead({ stage: "won", nextFollowUpDate: daysAgo(5) }); // closed — ignored entirely
    void untouched;

    const r = await get(`follow-up-health?todayStart=${encodeURIComponent(todayStart.toISOString())}&dueBefore=${encodeURIComponent(dueBefore.toISOString())}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ open: 6, dueToday: 2, overdue: 2, noNextAction: 3, newUntouched: 1, slaRisk: 3 });
  });

  it("counts today's activity by type and gives a zero-filled trend", async () => {
    const id = await lead({});
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    await LeadActivity.collection.insertMany([
      { leadId: id, type: "call", note: "", createdAt: now, updatedAt: now },
      { leadId: id, type: "call", note: "", createdAt: now, updatedAt: now },
      { leadId: id, type: "note", note: "x", createdAt: now, updatedAt: now },
      { leadId: id, type: "disposition", note: "", createdAt: now, updatedAt: now },
      { leadId: id, type: "call", note: "", createdAt: new Date(todayStart.getTime() - 60_000), updatedAt: now }, // yesterday
    ] as any[]);
    const r = await get(`activity?todayStart=${encodeURIComponent(todayStart.toISOString())}&tz=Asia/Kolkata&days=7`);
    expect(r.status).toBe(200);
    expect(r.body.today).toEqual({ call: 2, note: 1, disposition: 1 });
    expect(r.body.total).toBe(4);
    expect(r.body.trend).toHaveLength(7);
    expect(r.body.trend.reduce((s: number, d: any) => s + d.count, 0)).toBe(5);
  });
});
