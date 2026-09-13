// GET /leads/reports/by-rep · by-status · daily · monthly — the CRM dashboard
// pivot snapshots (ask #10), against a REAL leads / opportunities collection
// (mongodb-memory-server). Rows are written straight to the collection so the
// fixture controls createdAt, dispositionStatus and dispositionAt exactly.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-reports-snapshots-test";
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

const IMRAN = new mongoose.Types.ObjectId();
const NEEL = new mongoose.Types.ObjectId();
const DAY = 86_400_000;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const monthsAgo = (n: number) => new Date(now.getFullYear(), now.getMonth() - n, 15, 12);

let seq = 0;
async function lead(o: Partial<Record<string, any>>) {
  seq += 1;
  await Lead.collection.insertOne({
    leadCode: `LEAD-T-${String(seq).padStart(4, "0")}`, type: "company", companyName: `Co ${seq}`, contactName: `P${seq}`, contactPhone: "1",
    stage: "new", source: "manual", dealValue: 0, currency: "INR", disposition: "", subDisposition: "", dispositionStage: "", dispositionStatus: "", dispositionAt: null,
    createdAt: now, updatedAt: now, ...o,
  } as any);
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
  await Promise.all([Lead.deleteMany({}), Opportunity.deleteMany({})]);
});

describe("GET /reports/by-rep (agent-wise)", () => {
  it("returns per-agent counts, won value, win rate, dispositioned-today and open opportunities", async () => {
    // Imran: 2 open (one In-progress dispositioned today), 1 won ₹250k, 1 lost (legacy stage).
    await lead({ assignedTo: IMRAN, assignedToName: "Imran", dealValue: 50_000 });
    await lead({ assignedTo: IMRAN, assignedToName: "Imran", dealValue: 80_000, dispositionStatus: "In-progress", dispositionStage: "In-progress", dispositionAt: now });
    await lead({ assignedTo: IMRAN, assignedToName: "Imran", dealValue: 250_000, stage: "won", dispositionStatus: "Won", dispositionStage: "Onboarded", dispositionAt: daysAgo(3) });
    await lead({ assignedTo: IMRAN, assignedToName: "Imran", dealValue: 10_000, stage: "lost" });
    // Neel: 1 open, 1 won via legacy stage only (never dispositioned), yesterday's disposition doesn't count as today.
    await lead({ assignedTo: NEEL, assignedToName: "Neelanchal", dealValue: 20_000, dispositionStatus: "Open", dispositionStage: "Prospect", dispositionAt: daysAgo(1) });
    await lead({ assignedTo: NEEL, assignedToName: "Neelanchal", dealValue: 400_000, stage: "won" });
    // Unassigned row.
    await lead({ dealValue: 5_000 });
    // Opportunities: Imran has one open and one closed; Neel none.
    await Opportunity.collection.insertMany([
      { opportunityCode: "OPP-T-1", name: "a", pipeline: "corporate", stage: "proposal", probability: 65, dealValue: 80_000, currency: "INR", ownerUserId: IMRAN, serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now },
      { opportunityCode: "OPP-T-2", name: "b", pipeline: "corporate", stage: "closed_won", probability: 100, dealValue: 250_000, currency: "INR", ownerUserId: IMRAN, serviceMix: [], serviceLines: [], createdAt: now, updatedAt: now },
    ] as any[]);

    const r = await get(`by-rep?todayStart=${encodeURIComponent(new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString())}`);
    expect(r.status).toBe(200);
    const byName = Object.fromEntries(r.body.reps.map((x: any) => [x.repName, x]));
    expect(byName.Imran).toMatchObject({ repId: String(IMRAN), total: 4, open: 2, won: 1, lost: 1, wonValue: 250_000, pipelineValue: 130_000, dispositionedToday: 1, conversion: 50, openOpportunities: 1 });
    expect(byName.Neelanchal).toMatchObject({ total: 2, open: 1, won: 1, lost: 0, wonValue: 400_000, dispositionedToday: 0, conversion: 100, openOpportunities: 0 });
    expect(byName.Unassigned).toMatchObject({ repId: null, total: 1, open: 1, won: 0 });
    expect(r.body.reps[0].repName).toBe("Imran"); // sorted by total desc
  });

  it("scopes leads on createdAt with dateFrom / dateTo", async () => {
    await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(40) });
    await lead({ assignedTo: IMRAN, assignedToName: "Imran", createdAt: daysAgo(2) });
    const r = await get(`by-rep?dateFrom=${encodeURIComponent(daysAgo(7).toISOString())}`);
    expect(r.body.reps[0]).toMatchObject({ repName: "Imran", total: 1 });
  });
});

describe("GET /reports/by-status (status-wise)", () => {
  it("counts by the disposition taxonomy, mapping never-dispositioned rows through the legacy stage", async () => {
    await lead({ dispositionStatus: "Open", dealValue: 10 });
    await lead({ dispositionStatus: "In-progress", dealValue: 20 });
    await lead({ dispositionStatus: "In-progress", dealValue: 30 });
    await lead({ dispositionStatus: "Won", stage: "won", dealValue: 40 });
    await lead({ dispositionStatus: "Lost", stage: "lost", dealValue: 50 });
    await lead({ stage: "won", dealValue: 60 }); // legacy won, never dispositioned
    await lead({ stage: "lost", dealValue: 70 }); // legacy lost
    await lead({ stage: "contacted", dealValue: 80 }); // legacy open
    await lead({ stage: "proposal_sent", dealValue: 90 }); // legacy open (stage is NOT the status taxonomy)

    const r = await get("by-status");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(9);
    expect(r.body.byStatus).toEqual([
      { status: "Open", count: 3, value: 10 + 80 + 90 },
      { status: "In-progress", count: 2, value: 50 },
      { status: "Won", count: 2, value: 100 },
      { status: "Lost", count: 2, value: 120 },
    ]);
  });

  it("always returns the four buckets, zero-filled, and honours the date range", async () => {
    await lead({ stage: "won", createdAt: daysAgo(60) });
    const r = await get(`by-status?dateFrom=${encodeURIComponent(daysAgo(30).toISOString())}`);
    expect(r.body.total).toBe(0);
    expect(r.body.byStatus.map((b: any) => [b.status, b.count])).toEqual([["Open", 0], ["In-progress", 0], ["Won", 0], ["Lost", 0]]);
  });
});

describe("GET /reports/daily (day-wise)", () => {
  it("buckets created and won per day over the window, zero-filled, in the caller's timezone", async () => {
    await lead({ createdAt: daysAgo(0) });
    await lead({ createdAt: daysAgo(0), stage: "won" });
    await lead({ createdAt: daysAgo(3) });
    await lead({ createdAt: daysAgo(3), dispositionStatus: "Won" });
    await lead({ createdAt: daysAgo(3) });
    await lead({ createdAt: daysAgo(45) }); // outside the window

    const r = await get("daily?days=7&tz=Asia/Kolkata");
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(7);
    expect(r.body.daily).toHaveLength(7);
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
    const today = fmt.format(daysAgo(0));
    const threeAgo = fmt.format(daysAgo(3));
    expect(r.body.daily[6].day).toBe(today);
    expect(r.body.daily.find((d: any) => d.day === today)).toEqual({ day: today, created: 2, won: 1 });
    expect(r.body.daily.find((d: any) => d.day === threeAgo)).toEqual({ day: threeAgo, created: 3, won: 1 });
    expect(r.body.daily.reduce((s: number, d: any) => s + d.created, 0)).toBe(5);
    expect(r.body.daily.filter((d: any) => d.created === 0)).toHaveLength(5);
  });

  it("rejects an unknown timezone", async () => {
    expect((await get("daily?tz=Mars/Olympus")).status).toBe(400);
  });
});

describe("GET /reports/monthly (month-wise)", () => {
  it("returns 12 zero-filled months, oldest first, with created / won / lost per month", async () => {
    await lead({ createdAt: monthsAgo(0) });
    await lead({ createdAt: monthsAgo(0), stage: "won" });
    await lead({ createdAt: monthsAgo(2), dispositionStatus: "Won" });
    await lead({ createdAt: monthsAgo(2), stage: "lost" });
    await lead({ createdAt: monthsAgo(2) });
    await lead({ createdAt: monthsAgo(13) }); // outside

    const r = await get("monthly");
    expect(r.status).toBe(200);
    expect(r.body.monthly).toHaveLength(12);
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    expect(r.body.monthly[11].key).toBe(key(monthsAgo(0)));
    expect(r.body.monthly[0].key).toBe(key(monthsAgo(11)));
    expect(r.body.monthly[11]).toMatchObject({ new: 2, won: 1, lost: 0 });
    expect(r.body.monthly[9]).toMatchObject({ key: key(monthsAgo(2)), new: 3, won: 1, lost: 1 });
    expect(r.body.monthly.reduce((s: number, m: any) => s + m.new, 0)).toBe(5);
    expect(r.body.monthly[11].month).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
  });
});
