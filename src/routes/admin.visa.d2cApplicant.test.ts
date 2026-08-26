// apps/backend/src/routes/admin.visa.d2cApplicant.test.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE ANONYMOUS TICKET.
//
// Both ops reads on this router — GET /queue and GET /applications/:id —
// resolved their applicant through TravellerProfile and nothing else. A
// D2C case has no TravellerProfile row at all: routes/consumer.
// applications.ts writes travellerProfileId: null by design and carries
// `consumerId` instead. So every consumer case arrived in the concierge
// console with no name in the queue and a null traveller block in the
// detail — a ticket nobody could put a person to.
//
// This suite proves the D2C branch resolves that identity, that it is
// shaped EXACTLY like the B2B one so the console needs no change, and —
// the part that cannot be asserted by reading the code — that the
// passport number and date of birth come back as PLAINTEXT rather than
// the `penc.1.…` envelopes they are stored as.
//
// ── WHY A REAL DATABASE ──────────────────────────────────────────────
// The encryption plugin lives in Mongoose query middleware
// (plugins/fieldEncryption.plugin.ts): post('find') and post('findOne')
// decrypt, and Model.aggregate()/$lookup/$group/distinct BYPASS the whole
// mechanism. A stubbed model would return whatever the stub was told to,
// and would pass just as happily against a $lookup implementation that
// puts ciphertext on an agent's screen. The claim here is about which
// query shape was used, so only a real round trip can make it.
// ══════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

// admin.visa.ts reaches config/env.ts at import time, so these have to be
// in place before the dynamic imports below — the same reason
// consumer.profile.encryption.test.ts sets them at the top of the file.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "admin-visa-d2c-test-secret";
process.env.JWT_REFRESH_SECRET ||= "admin-visa-d2c-test-refresh";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/admin-visa-d2c-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

let permissionRecord: any = null;
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: {
    findOne: (_f: any) => ({ lean: () => Promise.resolve(permissionRecord) }),
    find: (_f: any) => ({ select: () => ({ lean: () => Promise.resolve([]) }) }),
  },
  hasAccess: (actual: string, required: string) => {
    const order = ["NONE", "READ", "WRITE", "FULL"];
    return order.indexOf(actual) >= order.indexOf(required);
  },
}));

vi.mock("../services/visaBillingSync.js", () => ({
  syncVisaApplicationBilling: vi.fn().mockResolvedValue({ action: "noop" }),
  createVisaWorkStartBooking: vi.fn().mockResolvedValue({ action: "noop" }),
}));

const { default: router } = await import("./admin.visa.js");
const { default: VisaApplication } = await import("../models/VisaApplication.js");
const { default: VisaRequest } = await import("../models/VisaRequest.js");
const { default: TravellerProfile } = await import("../models/TravellerProfile.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: Consumer } = await import("../models/Consumer.js");
const { default: ConsumerProfile } = await import("../models/ConsumerProfile.js");
const { default: SubjectKey } = await import("../models/SubjectKey.js");
const { isEncryptedEnvelope } = await import("../security/fieldCrypto.js");
const { clearSubjectKeyCache } = await import("../security/subjectKeys.js");

let mongod: MongoMemoryServer;
const CALLER_ID = new mongoose.Types.ObjectId();
let workspaceId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await SubjectKey.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  clearSubjectKeyCache();
  permissionRecord = { modules: { visaApplication: { access: "FULL" } }, status: "active" };
  await Promise.all([
    VisaApplication.deleteMany({}),
    VisaRequest.deleteMany({}),
    TravellerProfile.deleteMany({}),
    CustomerWorkspace.deleteMany({}),
    Consumer.deleteMany({}),
    ConsumerProfile.deleteMany({}),
    SubjectKey.deleteMany({}),
  ]);
  const ws = await CustomerWorkspace.create({ companyName: "Acme Ltd", customerId: "acme" });
  workspaceId = ws._id as any;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(CALLER_ID), roles: ["OPS"], email: "concierge@plumtrips.com" };
    next();
  });
  app.use("/", router);
  return app;
}

const RULE_SNAPSHOT = {
  ruleId: new mongoose.Types.ObjectId(),
  capturedAt: new Date("2026-08-12T00:00:00.000Z"),
  destinationName: "Thailand",
  isSchengen: false,
  productClass: "VISA",
  visaCategory: "E_VISA",
  purpose: "TOURIST",
  entryType: "SINGLE",
  serviceTier: "STANDARD",
  appointmentRequired: false,
  biometricsRequired: false,
  documentRequirements: [],
};
const COST_SNAPSHOT = { displayMode: "ITEMISED", totalInr: 1770 };

/** The B2B control: real parent request, real TravellerProfile. */
async function seedB2BCase() {
  const traveller = await TravellerProfile.create({
    workspaceId,
    travelerId: `T-${Math.random().toString(36).slice(2)}`,
    firstName: "Asha",
    middleName: "K",
    lastName: "Rao",
    dob: "1988-01-09",
    email: "asha.rao@acme.test",
    nationality: "Indian",
    passportNo: "Z1234567",
    passportExpiry: "2031-05-04",
    passportIssueCountry: "IN",
    passportIssueDate: "2021-05-05",
    createdBy: CALLER_ID,
    source: "MANUAL",
  });
  const visaRequest = await VisaRequest.create({
    workspaceId,
    raisedByUserId: CALLER_ID,
    destinationIso2: "TH",
    purpose: "TOURIST",
    applicationIds: [],
  });
  const application = await VisaApplication.create({
    workspaceId,
    requestId: visaRequest._id,
    travellerProfileId: traveller._id,
    destinationIso2: "TH",
    nationality: "IN",
    ruleSnapshot: RULE_SNAPSHOT,
    indicativeCostSnapshot: COST_SNAPSHOT,
    status: "submitted",
  });
  return { traveller, visaRequest, application };
}

/**
 * A D2C case, written the way routes/consumer.applications.ts writes one:
 * consumerId set, travellerProfileId null, nationality stamped on the
 * application itself.
 *
 * The profile goes in through the MODEL (never the driver) so the
 * encryption plugin's pre('save') actually runs and the fields under test
 * are ciphertext at rest — which is the whole point of the round trip.
 */
async function seedD2CCase(
  opts: { withProfile?: boolean; passports?: any[]; email?: string; name?: string } = {},
) {
  const { withProfile = true, email = "test@helloviza.dev", name = "Ananya Test" } = opts;
  const consumer = await Consumer.create({
    email,
    name,
    phone: "+919000000001",
    passwordHash: "not-used",
  });
  if (withProfile) {
    await ConsumerProfile.create({
      consumerId: consumer._id,
      workspaceId,
      personal: {
        firstName: "Ananya",
        lastName: "Test",
        dateOfBirth: new Date("1994-03-17T00:00:00.000Z"),
        nationality: "Indian",
      },
      passports: opts.passports ?? [
        {
          number: "M8845213",
          issuingCountry: "IN",
          issueDate: new Date("2019-11-02T00:00:00.000Z"),
          expiryDate: new Date("2029-11-01T00:00:00.000Z"),
          isPrimary: true,
        },
      ],
      contact: { mobile: "9000000001" },
    });
  }
  const application = await VisaApplication.create({
    workspaceId,
    source: "D2C",
    consumerId: consumer._id,
    requestId: null,
    travellerProfileId: null,
    destinationIso2: "TH",
    nationality: "IN",
    ruleSnapshot: RULE_SNAPSHOT,
    indicativeCostSnapshot: COST_SNAPSHOT,
    status: "submitted",
  });
  return { consumer, application };
}

describe("GET /queue — the D2C applicant", () => {
  it("names a D2C row that used to arrive anonymous", async () => {
    const { consumer, application } = await seedD2CCase();

    const res = await request(makeApp()).get("/queue");

    expect(res.status).toBe(200);
    const row = res.body.applications.find((a: any) => a.id === String(application._id));
    // Before the branch existed this was null for every consumer case.
    expect(row.traveller).toEqual({ id: String(consumer._id), name: "Ananya Test" });
    expect(row.source).toBe("D2C");
  });

  it("leaves a B2B row on the same page resolved exactly as before", async () => {
    const { traveller, application } = await seedB2BCase();
    await seedD2CCase();

    const res = await request(makeApp()).get("/queue");

    const row = res.body.applications.find((a: any) => a.id === String(application._id));
    // The TravellerProfile join, its three-part name join and the shape of
    // the object are all untouched by the D2C branch.
    expect(row.traveller).toEqual({ id: String(traveller._id), name: "Asha K Rao" });
    expect(row.source).toBe("B2B");
  });

  it("still renders null — not a crash — for a D2C row whose consumer is gone", async () => {
    // The shape admin.visa.nullJoins.test.ts already pins: a consumerId
    // that resolves to nothing is a lookup MISS, exactly as a missing
    // TravellerProfile is on the B2B side.
    const orphan = await VisaApplication.create({
      workspaceId,
      source: "D2C",
      consumerId: new mongoose.Types.ObjectId(),
      requestId: null,
      travellerProfileId: null,
      destinationIso2: "TH",
      ruleSnapshot: RULE_SNAPSHOT,
      indicativeCostSnapshot: COST_SNAPSHOT,
      status: "submitted",
    });

    const res = await request(makeApp()).get("/queue");

    expect(res.status).toBe(200);
    const row = res.body.applications.find((a: any) => a.id === String(orphan._id));
    expect(row.traveller).toBeNull();
  });

  it("does not read the encrypted collection to render a name column", async () => {
    // The queue shows a NAME. Reading ConsumerProfile here would decrypt
    // every passport number on the page for a column that never shows
    // one — so the join is deliberately Consumer-only.
    await seedD2CCase();
    const find = vi.spyOn(ConsumerProfile, "find");
    const findOne = vi.spyOn(ConsumerProfile, "findOne");

    const res = await request(makeApp()).get("/queue");

    expect(res.status).toBe(200);
    expect(find).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
    find.mockRestore();
    findOne.mockRestore();
  });
});

describe("GET /applications/:id — the D2C applicant", () => {
  it("returns the identity in the SAME nine keys the B2B branch returns", async () => {
    const { application: b2bApplication } = await seedB2BCase();
    const { application: d2cApplication } = await seedD2CCase();

    const b2b = await request(makeApp()).get(`/applications/${b2bApplication._id}`);
    const d2c = await request(makeApp()).get(`/applications/${d2cApplication._id}`);

    expect(b2b.status).toBe(200);
    expect(d2c.status).toBe(200);
    // Not "a superset" and not "close enough" — the console types this
    // block once (TravellerDetail) and must not learn a second shape.
    expect(Object.keys(d2c.body.traveller).sort()).toEqual(Object.keys(b2b.body.traveller).sort());
  });

  it("resolves name, DOB, email, nationality and passport for a D2C case", async () => {
    const { consumer, application } = await seedD2CCase();

    const res = await request(makeApp()).get(`/applications/${application._id}`);

    expect(res.body.traveller).toEqual({
      id: String(consumer._id),
      name: "Ananya Test",
      // "YYYY-MM-DD", the shape TravellerProfile stores dates in — never
      // the ISO datetime ConsumerProfile actually holds.
      dob: "1994-03-17",
      email: "test@helloviza.dev",
      // Off the APPLICATION, which is what the rule was resolved against.
      nationality: "IN",
      passportNo: "M8845213",
      passportExpiry: "2029-11-01",
      passportIssueCountry: "IN",
      passportIssueDate: "2019-11-02",
    });
  });

  it("hands back PLAINTEXT while the same fields are ciphertext at rest", async () => {
    const { application } = await seedD2CCase();

    // What is actually on disk, read through the driver so the plugin
    // cannot intervene — the same technique
    // consumer.profile.encryption.test.ts uses for its own claim.
    const stored: any = await mongoose.connection
      .collection("consumerprofiles")
      .findOne({ workspaceId });
    expect(isEncryptedEnvelope(stored.passports[0].number)).toBe(true);
    expect(isEncryptedEnvelope(stored.personal.dateOfBirth)).toBe(true);
    expect(String(stored.passports[0].number)).toMatch(/^penc\./);

    const res = await request(makeApp()).get(`/applications/${application._id}`);

    // …and what the agent sees.
    expect(res.body.traveller.passportNo).toBe("M8845213");
    expect(res.body.traveller.passportNo).not.toMatch(/^penc\./);
    expect(res.body.traveller.dob).toBe("1994-03-17");
  });

  it("resolves the PRIMARY passport when a consumer holds several", async () => {
    const { application } = await seedD2CCase({
      passports: [
        {
          number: "OLDBOOK1",
          issuingCountry: "IN",
          expiryDate: new Date("2026-01-01T00:00:00.000Z"),
          isPrimary: false,
        },
        {
          number: "M8845213",
          issuingCountry: "IN",
          expiryDate: new Date("2029-11-01T00:00:00.000Z"),
          isPrimary: true,
        },
      ],
    });

    const res = await request(makeApp()).get(`/applications/${application._id}`);

    // Not passports[0] — the renewed book is the one the application is
    // being made on.
    expect(res.body.traveller.passportNo).toBe("M8845213");
    expect(res.body.traveller.passportExpiry).toBe("2029-11-01");
  });

  it("still names a consumer who has not filled their profile in", async () => {
    const { consumer, application } = await seedD2CCase({ withProfile: false });

    const res = await request(makeApp()).get(`/applications/${application._id}`);

    // A true statement about the case — and the cue for an agent to go
    // and ask — rather than a null block that reads as a bug.
    expect(res.body.traveller.id).toBe(String(consumer._id));
    expect(res.body.traveller.name).toBe("Ananya Test");
    expect(res.body.traveller.email).toBe("test@helloviza.dev");
    expect(res.body.traveller.passportNo).toBeNull();
    expect(res.body.traveller.dob).toBeNull();
  });

  it("leaves the B2B traveller block byte-for-byte what it was", async () => {
    const { traveller, application } = await seedB2BCase();

    const res = await request(makeApp()).get(`/applications/${application._id}`);

    expect(res.body.traveller).toEqual({
      id: String(traveller._id),
      name: "Asha K Rao",
      dob: "1988-01-09",
      email: "asha.rao@acme.test",
      nationality: "Indian",
      passportNo: "Z1234567",
      passportExpiry: "2031-05-04",
      passportIssueCountry: "IN",
      passportIssueDate: "2021-05-05",
    });
  });

  it("never resolves the encrypted collection through an aggregate", async () => {
    // aggregate()/$lookup/$group/distinct bypass the decryption middleware
    // entirely and would return `penc.1.…` envelopes. This is the guard
    // against a future "optimisation" that folds the two reads into one
    // pipeline — see the plugin's own header.
    const { application } = await seedD2CCase();
    const aggregate = vi.spyOn(ConsumerProfile, "aggregate");
    const distinct = vi.spyOn(ConsumerProfile, "distinct");

    const res = await request(makeApp()).get(`/applications/${application._id}`);

    expect(res.status).toBe(200);
    expect(aggregate).not.toHaveBeenCalled();
    expect(distinct).not.toHaveBeenCalled();
    aggregate.mockRestore();
    distinct.mockRestore();
  });
});
