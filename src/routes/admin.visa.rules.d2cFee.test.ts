// Route coverage for the D2C service fee reaching the database — Phase 1b.
//
// A REAL round trip: the actual admin.visa.rules router, mounted on a bare
// express app, authenticated with a genuinely-signed SUPERADMIN token (which
// isSuperAdmin lets past requirePermission), writing to a real VisaRule on
// mongodb-memory-server. No mocked models — the point is that the field
// survives validateRuleFields, Mongoose casting, save(), and comes back out
// through mapRuleSummary, and a mock proves none of that.
//
// Deliberately narrow: admin.visa.rules.test.ts already covers this router's
// permission gates, publish/retire machinery and audit trail. This file only
// asks whether the new field is writable, validated and readable.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

const B2B_SECRET = "b2b-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/d2c-fee-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.CONSUMER_JWT_SECRET ||= "consumer-jwt-secret-for-tests";

const { default: VisaRule } = await import("../models/VisaRule.js");
const { default: VisaRuleAudit } = await import("../models/VisaRuleAudit.js");
const { default: adminVisaRulesRouter, mapRuleSummary } = await import("./admin.visa.rules.js");

let mongod: MongoMemoryServer;

// A real token, signed with the real secret, carrying SUPERADMIN — which
// middleware/isSuperAdmin.ts honours, so requirePermission("visaApplication",
// "FULL") passes without needing a UserPermission fixture.
const SUPERADMIN_TOKEN = jwt.sign(
  { sub: new mongoose.Types.ObjectId().toString(), roles: ["SUPERADMIN"], email: "ops@plumtrips.com" },
  B2B_SECRET,
  { expiresIn: "30m" },
);

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/admin/visa", adminVisaRulesRouter);
  return a;
}

const auth = (r: any) => r.set("Authorization", `Bearer ${SUPERADMIN_TOKEN}`);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([VisaRule.deleteMany({}), VisaRuleAudit.deleteMany({})]);
});

async function makeRule(extra: Record<string, any> = {}) {
  return VisaRule.create({
    nationality: "IN",
    destinationIso2: "DE",
    purpose: "TOURIST",
    entryType: "SINGLE",
    serviceTier: "STANDARD",
    destinationName: "Germany",
    productClass: "VISA",
    visaCategory: "STICKER",
    embassyFeeInr: 8000,
    vfsFeeInr: 1500,
    plumtripsServiceFeeInr: 2000,
    effectiveFrom: new Date("2026-08-16"),
    ...extra,
  });
}

const TODAY = "2026-08-16";

describe("PATCH /rules/:id — d2cServiceFeeInr", () => {
  it("writes the D2C fee to the database", async () => {
    const rule = await makeRule();

    const res = await auth(request(app()).patch(`/api/admin/visa/rules/${rule._id}`)).send({
      d2cServiceFeeInr: 3000,
      effectiveFrom: TODAY,
    });

    expect(res.status).toBe(200);

    const stored: any = await VisaRule.findById(rule._id).lean();
    expect(stored.d2cServiceFeeInr).toBe(3000);
  });

  it("leaves the B2B service fee untouched", async () => {
    const rule = await makeRule();
    await auth(request(app()).patch(`/api/admin/visa/rules/${rule._id}`)).send({
      d2cServiceFeeInr: 3000,
      effectiveFrom: TODAY,
    });

    const stored: any = await VisaRule.findById(rule._id).lean();
    expect(stored.plumtripsServiceFeeInr).toBe(2000);
    // And the shared pass-throughs are untouched too.
    expect(stored.embassyFeeInr).toBe(8000);
    expect(stored.vfsFeeInr).toBe(1500);
  });

  it("accepts zero — a genuinely free D2C service, not 'unset'", async () => {
    const rule = await makeRule();
    const res = await auth(request(app()).patch(`/api/admin/visa/rules/${rule._id}`)).send({
      d2cServiceFeeInr: 0,
      effectiveFrom: TODAY,
    });
    expect(res.status).toBe(200);
    const stored: any = await VisaRule.findById(rule._id).lean();
    expect(stored.d2cServiceFeeInr).toBe(0);
  });

  it("rejects a negative fee with a 400", async () => {
    const rule = await makeRule();
    const res = await auth(request(app()).patch(`/api/admin/visa/rules/${rule._id}`)).send({
      d2cServiceFeeInr: -1,
      effectiveFrom: TODAY,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/d2cServiceFeeInr must be a non-negative number/);
  });

  it("rejects a non-numeric fee", async () => {
    const rule = await makeRule();
    const res = await auth(request(app()).patch(`/api/admin/visa/rules/${rule._id}`)).send({
      d2cServiceFeeInr: "3000",
      effectiveFrom: TODAY,
    });
    expect(res.status).toBe(400);
  });

  it("records the change in the audit trail, like every other priced term", async () => {
    const rule = await makeRule();
    await auth(request(app()).patch(`/api/admin/visa/rules/${rule._id}`)).send({
      d2cServiceFeeInr: 3000,
      effectiveFrom: TODAY,
    });

    const audits: any[] = await VisaRuleAudit.find({ ruleId: rule._id }).lean();
    const changed = audits.flatMap((a) => a.changes ?? []).map((c: any) => c.field);
    expect(changed).toContain("d2cServiceFeeInr");
  });

  it("does not disturb the B2B-derived displayMode", async () => {
    // d2cServiceFeeInr is excluded from VisaRule's pre-validate derivation on
    // purpose — a D2C-only price must not flip a field every B2B read consumes.
    const rule = await makeRule();
    await auth(request(app()).patch(`/api/admin/visa/rules/${rule._id}`)).send({
      d2cServiceFeeInr: 3000,
      effectiveFrom: TODAY,
    });
    const stored: any = await VisaRule.findById(rule._id).lean();
    expect(stored.displayMode).toBe("ITEMISED");
  });
});

describe("GET /rules/:id — the field comes back out", () => {
  it("returns d2cServiceFeeInr", async () => {
    const rule = await makeRule({ d2cServiceFeeInr: 3000 });
    const res = await auth(request(app()).get(`/api/admin/visa/rules/${rule._id}`));
    expect(res.status).toBe(200);
    expect(res.body.rule.d2cServiceFeeInr).toBe(3000);
  });

  it("returns null (not undefined) when no D2C price is authored", async () => {
    const rule = await makeRule();
    const res = await auth(request(app()).get(`/api/admin/visa/rules/${rule._id}`));
    expect(res.body.rule.d2cServiceFeeInr).toBeNull();
  });
});

describe("mapRuleSummary", () => {
  it("exposes the field, nulled when absent", () => {
    expect(mapRuleSummary({ _id: new mongoose.Types.ObjectId(), d2cServiceFeeInr: 3000 }).d2cServiceFeeInr).toBe(3000);
    expect(mapRuleSummary({ _id: new mongoose.Types.ObjectId() }).d2cServiceFeeInr).toBeNull();
  });
});
