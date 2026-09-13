// GET /leads/company-check — same-company dedupe context for the new-lead
// form. Against a REAL leads + crmcompanies collection (mongodb-memory-server),
// no model mocks: what matters is which rows come back and how "open" and the
// owner label are derived. Auth/House are passthroughs (ADMIN passes the
// leads-access gate implicitly, exactly as in leads.opportunity.test.ts).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-company-check-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();
const REP_ID = new mongoose.Types.ObjectId().toHexString();

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
const { default: User } = await import("../models/User.js");
const { default: router } = await import("./leads.js");
const { CRM_V2_DISPOSITION_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/leads", router);
  return a;
}

const check = (qs: string) => request(app()).get(`/api/leads/company-check?${qs}`);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(ADMIN_ID), name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" },
    { _id: new mongoose.Types.ObjectId(REP_ID), name: "Imran", email: "imran@plumtrips.com", roles: ["ADMIN"], passwordHash: "x" },
  ] as any[]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), CRMCompany.deleteMany({})]);
});
afterEach(() => {
  delete process.env[CRM_V2_DISPOSITION_ENV];
});

async function createLead(body: Record<string, any>) {
  const r = await request(app()).post("/api/leads").send({ contactName: "Priya", contactPhone: "9999999999", ...body });
  expect(r.status).toBe(201);
  return r.body.lead as any;
}

describe("GET /leads/company-check", () => {
  it("returns the company's open lead with its owner", async () => {
    await createLead({ companyName: "Onboarded Demo Co", contactName: "Arjun Sethi", stage: "contacted", assignedTo: REP_ID });

    const r = await check("name=Onboarded%20Demo%20Co");
    expect(r.status).toBe(200);
    expect(r.body.match).toBe(true);
    expect(r.body.company.name).toBe("Onboarded Demo Co");
    expect(r.body.total).toBe(1);
    expect(r.body.openCount).toBe(1);
    expect(r.body.leads[0]).toMatchObject({
      contactName: "Arjun Sethi",
      stage: "contacted",
      status: "CONTACTED",
      assignedTo: REP_ID,
      assignedToName: "Imran",
      open: true,
    });
    expect(r.body.leads[0].leadCode).toMatch(/^LEAD-/);
  });

  it("returns no match for a company nobody has created", async () => {
    const r = await check("name=Fresh%20Company%20Ltd");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ match: false, company: null, leads: [], openCount: 0, total: 0 });
  });

  it("matches the company but reports openCount 0 when every lead is converted or lost", async () => {
    await createLead({ companyName: "Closed Co", contactName: "Won One", stage: "won" });
    await createLead({ companyName: "Closed Co", contactName: "Lost One", stage: "lost" });

    const r = await check("name=Closed%20Co");
    expect(r.status).toBe(200);
    expect(r.body.match).toBe(true);
    expect(r.body.total).toBe(2);
    expect(r.body.openCount).toBe(0);
    expect(r.body.leads.map((l: any) => [l.contactName, l.status, l.open])).toEqual(
      expect.arrayContaining([
        ["Won One", "CONVERTED", false],
        ["Lost One", "LOST", false],
      ])
    );
  });

  it("resolves on nameNormalized — 'acme', 'Acme' and '  ACME  ' hit the same company", async () => {
    await createLead({ companyName: "Acme", contactName: "First", stage: "new" });

    for (const spelled of ["acme", "Acme", "%20%20ACME%20%20", "aCmE"]) {
      const r = await check(`name=${spelled}`);
      expect(r.status, spelled).toBe(200);
      expect(r.body.match, spelled).toBe(true);
      expect(r.body.company.name, spelled).toBe("Acme");
      expect(r.body.openCount, spelled).toBe(1);
    }
    // Punctuation is part of the key: "acme.com" is a different company.
    const other = await check("name=acme.com");
    expect(other.body.match).toBe(false);
  });

  it("accepts ?companyId= and separates open from closed leads", async () => {
    const open = await createLead({ companyName: "Mixed Co", contactName: "Open One", stage: "follow_up", assignedTo: REP_ID });
    await createLead({ companyName: "Mixed Co", contactName: "Lost One", stage: "lost" });

    const r = await check(`companyId=${open.companyId}`);
    expect(r.status).toBe(200);
    expect(r.body.match).toBe(true);
    expect(r.body.company._id).toBe(String(open.companyId));
    expect(r.body.total).toBe(2);
    expect(r.body.openCount).toBe(1);
    const openRow = r.body.leads.find((l: any) => l.open);
    expect(openRow).toMatchObject({ contactName: "Open One", assignedToName: "Imran", leadCode: open.leadCode });
  });

  it("falls back to a case-insensitive exact name for a legacy company whose key is still empty", async () => {
    const raw = await CRMCompany.collection.insertOne({
      companyCode: "COMP-2025-0001", name: "Legacy Traders", nameNormalized: "", industry: "", companySize: "", website: "", phone: "", email: "",
      city: "", state: "", country: "", address: "", notes: "", leadId: null, contactCount: 0, isPrivate: false, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    // An unanchored legacy lead: companyName only, no companyId.
    await Lead.collection.insertOne({
      leadCode: "LEAD-2025-0001", type: "company", companyName: "Legacy Traders", companyId: null, contactName: "Old Contact", contactPhone: "1",
      stage: "contacted", source: "manual", dealValue: 0, currency: "INR", assignedToName: "Stored Owner", createdAt: new Date(), updatedAt: new Date(),
    } as any);

    const r = await check("name=legacy%20traders");
    expect(r.status).toBe(200);
    expect(r.body.match).toBe(true);
    expect(r.body.company._id).toBe(String(raw.insertedId));
    expect(r.body.openCount).toBe(1);
    expect(r.body.leads[0]).toMatchObject({ contactName: "Old Contact", assignedToName: "Stored Owner", open: true });
  });

  it("is read-only and 400s without a name or companyId", async () => {
    const before = await Lead.countDocuments({});
    const r = await check("name=%20%20");
    expect(r.status).toBe(400);
    expect(await Lead.countDocuments({})).toBe(before);
    expect(await CRMCompany.countDocuments({})).toBe(0);
  });

  it("does not block creation: a second lead at the same company still creates (advisory only)", async () => {
    await createLead({ companyName: "Onboarded Demo Co", contactName: "Arjun Sethi", stage: "contacted", assignedTo: REP_ID });
    const warn = await check("name=Onboarded%20Demo%20Co");
    expect(warn.body.openCount).toBe(1);

    const second = await createLead({ companyName: "onboarded demo co", contactName: "Second Person", stage: "new" });
    expect(second.companyId).toBe(warn.body.company._id);
    const after = await check("name=Onboarded%20Demo%20Co");
    expect(after.body.openCount).toBe(2);
    expect(await CRMCompany.countDocuments({})).toBe(1);
  });
});
