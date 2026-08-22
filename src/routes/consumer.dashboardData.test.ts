// apps/backend/src/routes/consumer.dashboardData.test.ts
//
// THE TWO BACKEND ADDITIONS THE CONSUMER DASHBOARD READS FROM.
//
//   1. the three new fields on the APPLICATIONS LIST projection —
//      etaMinDays / etaMaxDays / actionRequiredReason / outcome, so a
//      dashboard can render a featured card, an action-required list and
//      Approved/Rejected filters WITHOUT a detail fetch per row;
//   2. the `readiness` block on GET /api/consumer/profile.
//
// Real routers, real models, real Mongo (mongodb-memory-server). The
// point of testing these through the ROUTE rather than the projection
// function is that the wire shape is the contract — a field that exists
// on a helper but never reaches the response is not a field.
//
// ── WHAT THE ABSENCE ASSERTIONS ARE FOR ──────────────────────────────
// Each new field is checked twice: present-and-correct when the stored
// value exists, and explicitly NULL when it does not. `outcome` has no
// schema default, so an un-decided case carries `undefined` — and an
// absent key and a pending decision must not look the same to a client.
// The null assertions are what stop that regressing into `?? "PENDING"`
// or a dropped key.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const B2B_SECRET = "b2b-jwt-secret-for-tests";
const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;
process.env.NODE_ENV = "test";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-dashboard-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

/* requireConsumer is the wall, not the subject here — the isolation
 * properties are covered by consumer.profile.test.ts. Injecting the
 * acting consumer keeps these tests about the PROJECTION. Same shape as
 * consumer.paymentOrder.test.ts. */
let actingConsumerId: string;
vi.mock("../middleware/requireConsumer.js", () => ({
  requireConsumer: (req: any, _res: any, next: any) => {
    req.consumer = { id: actingConsumerId, email: "reader@helloviza.dev", name: "Test Reader" };
    req.consumerWorkspaceId = "d2c00000000000000000d2c1";
    next();
  },
}));

const { default: applicationsRouter } = await import("./consumer.applications.js");
const { default: profileRouter } = await import("./consumer.profile.js");
const { default: VisaApplication } = await import("../models/VisaApplication.js");
const { default: ConsumerProfile } = await import("../models/ConsumerProfile.js");
const { default: ConsumerDocument } = await import("../models/ConsumerDocument.js");
const { d2cWorkspaceObjectId } = await import("../services/consumerWorkspace.js");

const app = express();
app.use(express.json());
app.use("/api/consumer/applications", applicationsRouter);
app.use("/api/consumer/profile", profileRouter);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    VisaApplication.deleteMany({}),
    ConsumerProfile.deleteMany({}),
    ConsumerDocument.deleteMany({}),
  ]);
  actingConsumerId = String(new mongoose.Types.ObjectId());
});

/* ── Application fixtures ───────────────────────────────────────────── */

function ruleSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: new mongoose.Types.ObjectId(),
    capturedAt: new Date(),
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
    ...overrides,
  };
}

async function seedApplication(overrides: Record<string, any> = {}) {
  const { snapshot, ...rest } = overrides;
  return VisaApplication.create({
    workspaceId: d2cWorkspaceObjectId(),
    source: "D2C",
    consumerId: new mongoose.Types.ObjectId(actingConsumerId),
    requestId: new mongoose.Types.ObjectId(),
    travellerProfileId: null,
    destinationIso2: "TH",
    ruleSnapshot: ruleSnapshot(snapshot ?? {}),
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 1770 },
    status: "submitted",
    ...rest,
  });
}

function listApplications() {
  return request(app).get("/api/consumer/applications");
}

describe("GET /api/consumer/applications — the new list fields", () => {
  it("sends etaMinDays / etaMaxDays off the FROZEN snapshot", async () => {
    await seedApplication({ snapshot: { etaMinDays: 3, etaMaxDays: 5, etaBasis: "BUSINESS" } });

    const res = await listApplications();

    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(1);
    expect(res.body.applications[0].etaMinDays).toBe(3);
    expect(res.body.applications[0].etaMaxDays).toBe(5);
  });

  it("sends NULL etas when the corridor's snapshot published none", async () => {
    await seedApplication();

    const [row] = (await listApplications()).body.applications;

    // Present as keys, null as values. "Typically —" is right where
    // "Typically 0 days" would be a fabrication.
    expect(row).toHaveProperty("etaMinDays", null);
    expect(row).toHaveProperty("etaMaxDays", null);
  });

  it("does NOT confuse the etas with processingDeadlineAt", async () => {
    // The two mean opposite things — see the projection's own note. A
    // snapshot with etas but no travel date has no deadline at all, and
    // the deadline must not be back-filled from the ETA or vice versa.
    await seedApplication({
      snapshot: { etaMinDays: 3, etaMaxDays: 5 },
      travelDateFrom: null,
      processingDeadlineAt: null,
    });

    const [row] = (await listApplications()).body.applications;

    expect(row.etaMaxDays).toBe(5);
    expect(row.processingDeadlineAt).toBeNull();
  });

  it("sends actionRequiredReason when ops has set one", async () => {
    await seedApplication({
      status: "action_required",
      actionRequiredReason: "Passport copy unclear — please re-upload",
    });

    const [row] = (await listApplications()).body.applications;

    expect(row.actionRequiredReason).toBe("Passport copy unclear — please re-upload");
    expect(row.status).toBe("action_required");
  });

  it("sends NULL actionRequiredReason on a case with nothing outstanding", async () => {
    await seedApplication();

    const [row] = (await listApplications()).body.applications;
    expect(row).toHaveProperty("actionRequiredReason", null);
  });

  it("sends outcome once a decision is recorded", async () => {
    await seedApplication({ status: "decision_received", outcome: "APPROVED" });

    const [row] = (await listApplications()).body.applications;
    expect(row.outcome).toBe("APPROVED");
  });

  it("sends NULL outcome — not an absent key — while a case is undecided", async () => {
    await seedApplication();

    const [row] = (await listApplications()).body.applications;
    expect(row).toHaveProperty("outcome", null);
  });

  it("keeps the fields per-row across a mixed list", async () => {
    // The filter tabs read these across the whole list at once, so the
    // per-row correctness is the property that matters — one shared
    // `have`/`required` bug in the list handler would smear them.
    await seedApplication({
      snapshot: { etaMinDays: 10, etaMaxDays: 15, destinationName: "Japan" },
      destinationIso2: "JP",
      status: "decision_received",
      outcome: "REJECTED",
    });
    await seedApplication({
      status: "action_required",
      actionRequiredReason: "Bank statement is older than 90 days",
    });

    const rows = (await listApplications()).body.applications;
    expect(rows).toHaveLength(2);

    const japan = rows.find((r: any) => r.destinationIso2 === "JP");
    const thailand = rows.find((r: any) => r.destinationIso2 === "TH");

    expect(japan.outcome).toBe("REJECTED");
    expect(japan.etaMaxDays).toBe(15);
    expect(japan.actionRequiredReason).toBeNull();

    expect(thailand.outcome).toBeNull();
    expect(thailand.etaMaxDays).toBeNull();
    expect(thailand.actionRequiredReason).toBe("Bank statement is older than 90 days");
  });

  it("still withholds every B2B-only field the whitelist has always excluded", async () => {
    // The projection grew; the wall did not move. These four are the ones
    // the file header names as the reason it is a whitelist at all.
    await seedApplication({
      discrepancyReason: "internal ops note",
      actionRequiredSetByUserId: new mongoose.Types.ObjectId(),
    });

    const [row] = (await listApplications()).body.applications;

    expect(row).not.toHaveProperty("discrepancyReason");
    expect(row).not.toHaveProperty("actionRequiredSetByUserId");
    expect(row).not.toHaveProperty("assignedConciergeUserId");
    expect(row).not.toHaveProperty("workspaceId");
  });
});

/* ── Readiness, on the wire ─────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;

function itemsByKey(readiness: any): Record<string, boolean> {
  return Object.fromEntries(readiness.items.map((i: any) => [i.key, i.ready]));
}

async function seedProfile(patch: Record<string, any>) {
  return ConsumerProfile.create({
    consumerId: new mongoose.Types.ObjectId(actingConsumerId),
    workspaceId: d2cWorkspaceObjectId(),
    ...patch,
  });
}

async function seedDocument(docCode: string | null) {
  return ConsumerDocument.create({
    consumerId: new mongoose.Types.ObjectId(actingConsumerId),
    workspaceId: d2cWorkspaceObjectId(),
    category: "IDENTITY",
    ...(docCode ? { docCode } : {}),
    originalFilename: `${docCode ?? "untitled"}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 1024,
    storageKey: `test/${docCode ?? "untitled"}.pdf`,
    driver: "local-disk",
  });
}

describe("GET /api/consumer/profile — the readiness block", () => {
  it("returns readiness ALONGSIDE completion, not instead of it", async () => {
    await seedProfile({});

    const res = await request(app).get("/api/consumer/profile");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("completion");
    expect(res.body).toHaveProperty("readiness");
    expect(res.body.readiness.total).toBe(6);
    expect(res.body.readiness.items).toHaveLength(6);
    // Two different questions. Nothing here relabels one as the other.
    expect(res.body.readiness).not.toEqual(res.body.completion);
  });

  it("scores 6/6 for a consumer who genuinely has everything", async () => {
    await seedProfile({
      personal: {
        firstName: "Aditi",
        lastName: "Rao",
        dateOfBirth: new Date("1994-03-11T00:00:00.000Z"),
        nationality: "Indian",
      },
      passports: [
        { number: "Z1234567", expiryDate: new Date(Date.now() + 400 * DAY_MS), isPrimary: true },
      ],
      travel: { travelHistory: [{ country: "Thailand", travelDate: new Date("2025-01-04") }] },
    });
    await seedDocument("PHOTO");
    await seedDocument("BANK_STATEMENT");

    const { readiness } = (await request(app).get("/api/consumer/profile")).body;

    expect(readiness.readyCount).toBe(6);
    expect(readiness.percent).toBe(100);
  });

  it("scores 0/6 for a brand-new consumer with an empty locker", async () => {
    // Note: no seedProfile() at all — the route upserts one on read, which
    // is the real first-load path.
    const { readiness } = (await request(app).get("/api/consumer/profile")).body;

    expect(readiness.readyCount).toBe(0);
    expect(readiness.percent).toBe(0);
    expect(Object.values(itemsByKey(readiness)).every((v) => v === false)).toBe(true);
  });

  it("flips Passport Validity to false for a passport expiring inside six months", async () => {
    // THE PARTIAL CASE, end to end: the passport survives the round trip
    // (its number is encrypted at rest and decrypted by the model on the
    // way back out), and the gauge still reads 5/6 because the expiry is
    // 120 days away.
    await seedProfile({
      personal: {
        firstName: "Aditi",
        lastName: "Rao",
        dateOfBirth: new Date("1994-03-11T00:00:00.000Z"),
        nationality: "Indian",
      },
      passports: [
        { number: "Z1234567", expiryDate: new Date(Date.now() + 120 * DAY_MS), isPrimary: true },
      ],
      travel: { travelHistory: [{ country: "Thailand", travelDate: new Date("2025-01-04") }] },
    });
    await seedDocument("PHOTO");
    await seedDocument("BANK_STATEMENT");

    const res = await request(app).get("/api/consumer/profile");
    const items = itemsByKey(res.body.readiness);

    expect(items.passport).toBe(true);
    expect(items.passportValidity).toBe(false);
    expect(res.body.readiness.readyCount).toBe(5);

    // And the encrypted field really did come back as plaintext — proof
    // this path reads through the model's post('find') decryption and not
    // around it. A ciphertext envelope here would still have scored the
    // same, which is exactly why it is asserted separately.
    expect(res.body.profile.passports[0].number).toBe("Z1234567");
  });

  it("ignores a SOFT-DELETED document — a deleted photo is not a photo", async () => {
    await seedProfile({});
    const photo = await seedDocument("PHOTO");
    await ConsumerDocument.updateOne({ _id: photo._id }, { $set: { deletedAt: new Date() } });

    const { readiness } = (await request(app).get("/api/consumer/profile")).body;

    expect(itemsByKey(readiness).photograph).toBe(false);
  });

  it("PATCH /travel returns a refreshed readiness, not a stale one", async () => {
    await seedProfile({});

    const before = (await request(app).get("/api/consumer/profile")).body.readiness;
    expect(itemsByKey(before).travelHistory).toBe(false);

    const patched = await request(app)
      .patch("/api/consumer/profile/travel")
      .send({ travelHistory: [{ country: "Japan", travelDate: "2025-06-01" }] });

    expect(patched.status).toBe(200);
    expect(patched.body).toHaveProperty("readiness");
    expect(itemsByKey(patched.body.readiness).travelHistory).toBe(true);
  });
});
