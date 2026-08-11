// Coverage for the Digital Visa Wallet (Tab 3) and the Travel History Log
// (Tab 5) — slice 3, 2026-08-11.
//
// AGAINST A REAL DATABASE, deliberately, and unlike every other route test
// in this directory (which mocks the models with an in-memory store).
// Three of the four things this slice claims are properties of PERSISTED
// documents rather than of route code:
//
//   - active/expired is DERIVED at read time from a stored "YYYY-MM-DD"
//     against today, so a literal fixture proves nothing about what comes
//     back out of Mongo;
//   - the auto-populate path is an UPSERT on a unique index — the whole
//     idempotency claim IS the index, and a mocked collection cannot have
//     one;
//   - workspace scoping is a filter over real rows in two workspaces.
//
// mongodb-memory-server is ISOLATED: it starts a private mongod on a
// throwaway data directory and is torn down here. Nothing in this file can
// reach a configured MONGO_URI, and nothing writes to any real database.
// (See docs on the literal-vs-document gap that motivated this shape.)
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Only the two middleware are mocked — every model below is REAL and hits
// the in-memory server. requireWorkspace normally derives the workspace
// from the JWT/headers; here the harness injects it directly.
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import travellerRouter from "./workspace.travellers.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerMember from "../models/CustomerMember.js";
import VisaHolding, {
  deriveVisaHoldingStatus,
  isSchengenIso2,
} from "../models/VisaHolding.js";
import TravellerTrip, { deriveTripDurationDays } from "../models/TravellerTrip.js";
import {
  syncVisaHoldingFromApplication,
  summariseVisaWallet,
  resolveSchengenBlock,
  describeVisaType,
  type VisaWalletRow,
} from "../services/visaHolding.service.js";
import VisaRule from "../models/VisaRule.js";

let mongod: MongoMemoryServer;

const WORKSPACE_A = new mongoose.Types.ObjectId();
const WORKSPACE_B = new mongoose.Types.ObjectId();
const CUSTOMER_A = "customer-a";
const CUSTOMER_B = "customer-b";
const LEADER_USER_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // The unique index on {workspaceId, sourceApplicationId} is the whole
  // idempotency guarantee — built explicitly so the assertions below test
  // the real constraint rather than whatever autoIndex happened to do.
  await VisaHolding.syncIndexes();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

/* ── Harness ─────────────────────────────────────────────────────────── */

/**
 * An app whose actor is a WORKSPACE_LEADER of the given workspace — the
 * role that may edit any traveller in it, which is what the wallet and trip
 * routes require. `email` matches the CustomerMember seeded per test.
 */
function makeApp(workspaceId: mongoose.Types.ObjectId, customerId: string, email = "leader@acme.test") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(LEADER_USER_ID), email, roles: ["CUSTOMER"] };
    req.workspaceObjectId = workspaceId;
    req.workspace = { _id: workspaceId, customerId };
    next();
  });
  app.use(travellerRouter);
  return app;
}

async function seedTraveller(workspaceId: mongoose.Types.ObjectId, travelerId: string) {
  return TravellerProfile.create({
    workspaceId,
    travelerId,
    firstName: "Asha",
    lastName: "Rao",
    source: "MANUAL",
    createdBy: LEADER_USER_ID,
  });
}

beforeEach(async () => {
  await Promise.all([
    VisaHolding.deleteMany({ workspaceId: { $in: [WORKSPACE_A, WORKSPACE_B] } }),
    TravellerTrip.deleteMany({ workspaceId: { $in: [WORKSPACE_A, WORKSPACE_B] } }),
    TravellerProfile.deleteMany({ workspaceId: { $in: [WORKSPACE_A, WORKSPACE_B] } }),
    CustomerMember.deleteMany({ customerId: { $in: [CUSTOMER_A, CUSTOMER_B] } }),
    VisaRule.deleteMany({}),
  ]);
  await CustomerMember.create([
    { customerId: CUSTOMER_A, email: "leader@acme.test", role: "WORKSPACE_LEADER", isActive: true },
    { customerId: CUSTOMER_B, email: "leader@acme.test", role: "WORKSPACE_LEADER", isActive: true },
  ]);
});

/* ── The derivations, on values that came out of Mongo ───────────────── */

describe("VisaHolding status derivation", () => {
  it("derives ACTIVE / EXPIRED / UNKNOWN from a PERSISTED expiryDate", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-001");
    await VisaHolding.create([
      {
        workspaceId: WORKSPACE_A, travellerProfileId: t._id, countryIso2: "DE",
        countryName: "Germany", expiryDate: "2099-01-01", source: "MANUAL", createdBy: LEADER_USER_ID,
      },
      {
        workspaceId: WORKSPACE_A, travellerProfileId: t._id, countryIso2: "US",
        countryName: "United States", expiryDate: "2001-01-01", source: "MANUAL", createdBy: LEADER_USER_ID,
      },
      {
        // No expiry at all — the third state. It must be neither active nor
        // expired: asserting somebody currently holds a valid visa on the
        // strength of a blank field is the fabrication this state prevents.
        workspaceId: WORKSPACE_A, travellerProfileId: t._id, countryIso2: "JP",
        countryName: "Japan", source: "MANUAL", createdBy: LEADER_USER_ID,
      },
    ]);

    const app = makeApp(WORKSPACE_A, CUSTOMER_A);
    const res = await request(app).get(`/${t._id}/visa-holdings`);

    expect(res.status).toBe(200);
    const byCountry = Object.fromEntries(res.body.holdings.map((h: any) => [h.countryIso2, h]));
    expect(byCountry.DE.status).toBe("ACTIVE");
    expect(byCountry.US.status).toBe("EXPIRED");
    expect(byCountry.JP.status).toBe("UNKNOWN");

    expect(res.body.summary).toMatchObject({
      recorded: 3, active: 1, expired: 1, unknownExpiry: 1, countries: 3, activeVisas: 1,
    });
  });

  it("counts a visa expiring TODAY as active, not expired", () => {
    // A visa is valid through its expiry date, not up to the morning of it.
    expect(deriveVisaHoldingStatus("2026-08-11", "2026-08-11")).toBe("ACTIVE");
    expect(deriveVisaHoldingStatus("2026-08-10", "2026-08-11")).toBe("EXPIRED");
  });

  it("treats a malformed or absent expiry as UNKNOWN, never as active", () => {
    expect(deriveVisaHoldingStatus(undefined)).toBe("UNKNOWN");
    expect(deriveVisaHoldingStatus("")).toBe("UNKNOWN");
    expect(deriveVisaHoldingStatus("soon")).toBe("UNKNOWN");
  });
});

describe("wallet summary — the honest-empty rule (§7.3)", () => {
  it("returns activeVisas NULL, not 0, when nothing is recorded", () => {
    const summary = summariseVisaWallet([]);
    // 0 would assert this person holds no visa. null says we do not know.
    expect(summary.activeVisas).toBeNull();
    expect(summary.recorded).toBe(0);
    expect(summary.activeVisasReason).toBe("No visas recorded yet");
  });

  it("returns a REAL 0 once rows exist but none are active", () => {
    const rows = [
      { countryIso2: "US", status: "EXPIRED" },
      { countryIso2: "GB", status: "EXPIRED" },
    ] as VisaWalletRow[];
    const summary = summariseVisaWallet(rows);
    // Zero active out of two recorded is a fact, and it renders as 0.
    expect(summary.activeVisas).toBe(0);
    expect(summary.recorded).toBe(2);
    expect(summary.activeVisasReason).toBeNull();
  });
});

describe("empty states", () => {
  it("an empty wallet returns no rows and no computed count", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-002");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/visa-holdings`);

    expect(res.status).toBe(200);
    expect(res.body.holdings).toEqual([]);
    expect(res.body.summary.activeVisas).toBeNull();
    expect(res.body.schengen.holdings).toEqual([]);
  });

  it("the dossier header reports activeVisas null with its reason when the wallet is empty", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-003");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}`);

    expect(res.status).toBe(200);
    expect(res.body.header.activeVisas).toBeNull();
    expect(res.body.header.activeVisasReason).toBe("No visas recorded yet");
  });

  it("the dossier header count comes from the SAME summary the wallet renders", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-004");
    await VisaHolding.create({
      workspaceId: WORKSPACE_A, travellerProfileId: t._id, countryIso2: "FR",
      countryName: "France", expiryDate: "2099-06-01", source: "MANUAL", createdBy: LEADER_USER_ID,
    });

    const app = makeApp(WORKSPACE_A, CUSTOMER_A);
    const detail = await request(app).get(`/${t._id}`);
    const wallet = await request(app).get(`/${t._id}/visa-holdings`);

    expect(detail.body.header.activeVisas).toBe(1);
    expect(wallet.body.summary.activeVisas).toBe(1);
  });

  it("an empty trip log returns zero recorded and no trips", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-005");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/trips`);

    expect(res.status).toBe(200);
    expect(res.body.trips).toEqual([]);
    expect(res.body.summary.recorded).toBe(0);
  });
});

/* ── Manual entry ────────────────────────────────────────────────────── */

describe("manual visa records", () => {
  it("adds a manual holding, stamped MANUAL and editable", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-010");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A))
      .post(`/${t._id}/visa-holdings`)
      .send({
        country: "US", visaType: "B1/B2", visaNumber: "X1234567",
        entryType: "MULTIPLE", issueDate: "2026-01-10", expiryDate: "2036-01-09",
      });

    expect(res.status).toBe(201);
    expect(res.body.holding).toMatchObject({
      countryIso2: "US", countryName: "United States", visaType: "B1/B2",
      source: "MANUAL", editable: true, status: "ACTIVE",
    });

    const stored: any = await VisaHolding.findById(res.body.holding._id).lean();
    expect(stored.source).toBe("MANUAL");
    // A client must never be able to claim a real application issued this.
    expect(stored.sourceApplicationId).toBeNull();
  });

  it("refuses a source the client tried to claim — source is stamped, never taken from the body", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-011");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A))
      .post(`/${t._id}/visa-holdings`)
      .send({ country: "DE", source: "AUTO", sourceApplicationId: String(new mongoose.Types.ObjectId()) });

    expect(res.status).toBe(201);
    expect(res.body.holding.source).toBe("MANUAL");
    expect(res.body.holding.sourceApplicationId).toBeNull();
  });

  it("rejects an unrecognised country rather than storing free text", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-012");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A))
      .post(`/${t._id}/visa-holdings`)
      .send({ country: "Wakanda" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Wakanda");
    expect(await VisaHolding.countDocuments({ workspaceId: WORKSPACE_A })).toBe(0);
  });

  it("rejects an expiry before the issue date", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-013");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A))
      .post(`/${t._id}/visa-holdings`)
      .send({ country: "FR", issueDate: "2026-05-01", expiryDate: "2026-04-01" });

    expect(res.status).toBe(400);
  });

  it("edits and soft-deletes a manual holding", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-014");
    const app = makeApp(WORKSPACE_A, CUSTOMER_A);

    const created = await request(app).post(`/${t._id}/visa-holdings`).send({ country: "JP", visaType: "Tourist" });
    const id = created.body.holding._id;

    const edited = await request(app)
      .put(`/${t._id}/visa-holdings/${id}`)
      .send({ country: "JP", visaType: "Business", expiryDate: "2099-01-01" });
    expect(edited.status).toBe(200);
    expect(edited.body.holding.visaType).toBe("Business");

    const removed = await request(app).delete(`/${t._id}/visa-holdings/${id}`);
    expect(removed.status).toBe(200);

    // SOFT delete — the row survives, it just leaves the wallet.
    const stored: any = await VisaHolding.findById(id).lean();
    expect(stored).not.toBeNull();
    expect(stored.deletedAt).toBeInstanceOf(Date);

    const after = await request(app).get(`/${t._id}/visa-holdings`);
    expect(after.body.holdings).toEqual([]);
    expect(after.body.summary.activeVisas).toBeNull();
  });
});

/* ── AUTO holdings ───────────────────────────────────────────────────── */

/** A minimal application document shape — only the fields the sync reads. */
async function makeApprovedApplication(overrides: Record<string, any> = {}) {
  const rule = await VisaRule.create({
    nationality: "IN",
    destinationIso2: "DE",
    purpose: "TOURIST",
    entryType: "SINGLE",
    serviceTier: "STANDARD",
    variantKey: `v-${new mongoose.Types.ObjectId()}`,
    destinationName: "Germany",
    productClass: "VISA",
    effectiveFrom: new Date("2026-01-01"),
  });

  return {
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE_A,
    travellerProfileId: new mongoose.Types.ObjectId(),
    outcome: "APPROVED",
    visaNumber: "DE-98765",
    visaIssuedAt: new Date("2026-03-01T00:00:00Z"),
    visaExpiresAt: new Date("2027-02-28T00:00:00Z"),
    ruleSnapshot: {
      ruleId: rule._id,
      capturedAt: new Date(),
      destinationName: "Germany",
      isSchengen: true,
      entryType: "MULTIPLE",
      visaCategory: "STICKER",
      purpose: "TOURIST",
    },
    ...overrides,
  };
}

describe("auto-populate from an ISSUED visa application", () => {
  it("creates an AUTO holding from outcome APPROVED", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-020");
    const application = await makeApprovedApplication({ travellerProfileId: t._id });

    const result = await syncVisaHoldingFromApplication(application, LEADER_USER_ID);
    expect(result.action).toBe("created");

    const stored: any = await VisaHolding.findOne({
      workspaceId: WORKSPACE_A,
      sourceApplicationId: application._id,
    }).lean();

    expect(stored).toMatchObject({
      countryIso2: "DE",
      countryName: "Germany",
      visaNumber: "DE-98765",
      entryType: "MULTIPLE",
      issueDate: "2026-03-01",
      expiryDate: "2027-02-28",
      source: "AUTO",
    });
    expect(String(stored.travellerProfileId)).toBe(String(t._id));
  });

  it("writes NOTHING for REJECTED, WITHDRAWN or an unset outcome", async () => {
    for (const outcome of ["REJECTED", "WITHDRAWN", undefined]) {
      const application = await makeApprovedApplication({ outcome });
      const result = await syncVisaHoldingFromApplication(application, LEADER_USER_ID);
      expect(result.action).toBe("not_issued");
    }
    expect(await VisaHolding.countDocuments({ workspaceId: WORKSPACE_A })).toBe(0);
  });

  it("is idempotent — re-recording the same decision UPDATES, never adds a second visa", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-021");
    const application = await makeApprovedApplication({ travellerProfileId: t._id });

    const first = await syncVisaHoldingFromApplication(application, LEADER_USER_ID);
    expect(first.action).toBe("created");

    // A concierge correcting a mistyped number is fixing the SAME visa.
    application.visaNumber = "DE-11111";
    const second = await syncVisaHoldingFromApplication(application, LEADER_USER_ID);
    expect(second.action).toBe("updated");

    const rows = await VisaHolding.find({ workspaceId: WORKSPACE_A, sourceApplicationId: application._id }).lean();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).visaNumber).toBe("DE-11111");
  });

  it("skips an application whose traveller was erased", async () => {
    const application = await makeApprovedApplication({ travellerProfileId: null });
    const result = await syncVisaHoldingFromApplication(application, LEADER_USER_ID);
    expect(result.action).toBe("skipped_no_traveller");
    expect(await VisaHolding.countDocuments({ workspaceId: WORKSPACE_A })).toBe(0);
  });

  it("refuses to write a holding whose country cannot be resolved", async () => {
    const application = await makeApprovedApplication({
      ruleSnapshot: { ruleId: new mongoose.Types.ObjectId(), destinationName: "Atlantis" },
    });
    const result = await syncVisaHoldingFromApplication(application, LEADER_USER_ID);
    expect(result.action).toBe("skipped_unresolved_country");
    expect(await VisaHolding.countDocuments({ workspaceId: WORKSPACE_A })).toBe(0);
  });

  it("stores a HUMAN visa type, never the raw enum tokens", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-025");
    const application = await makeApprovedApplication({ travellerProfileId: t._id });
    application.ruleSnapshot.visaCategory = "E_VISA";
    application.ruleSnapshot.purpose = "TOURIST";

    await syncVisaHoldingFromApplication(application, LEADER_USER_ID);
    const stored: any = await VisaHolding.findOne({ sourceApplicationId: application._id }).lean();

    // This lands in the same free-text field a person types "B1/B2" into.
    // "TOURIST"/"E_VISA" beside that reads as a bug, and the raw token is
    // our internal vocabulary, not anything printed on their visa.
    expect(stored.visaType).toBe("Tourist (e-visa)");
    expect(stored.visaType).not.toMatch(/_|[A-Z]{4,}/);
  });

  it("drops an unrecognised vocabulary token rather than echoing it", () => {
    expect(describeVisaType({ purpose: "TOURIST" })).toBe("Tourist");
    expect(describeVisaType({ visaCategory: "STICKER" })).toBe("Sticker");
    // An honest blank beats a raw enum in a user-facing field.
    expect(describeVisaType({ purpose: "SOMETHING_NEW" })).toBeUndefined();
    expect(describeVisaType({})).toBeUndefined();
  });

  it("falls back to the snapshot's destination NAME when the rule row is gone", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-022");
    const application = await makeApprovedApplication({ travellerProfileId: t._id });
    await VisaRule.deleteMany({});

    const result = await syncVisaHoldingFromApplication(application, LEADER_USER_ID);
    expect(result.action).toBe("created");
    const stored: any = await VisaHolding.findOne({ sourceApplicationId: application._id }).lean();
    expect(stored.countryIso2).toBe("DE");
  });

  it("an AUTO holding is read-only — 409 on edit and on delete", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-023");
    const application = await makeApprovedApplication({ travellerProfileId: t._id });
    await syncVisaHoldingFromApplication(application, LEADER_USER_ID);
    const holding: any = await VisaHolding.findOne({ sourceApplicationId: application._id }).lean();

    const app = makeApp(WORKSPACE_A, CUSTOMER_A);
    const edited = await request(app).put(`/${t._id}/visa-holdings/${holding._id}`).send({ country: "FR" });
    expect(edited.status).toBe(409);

    const removed = await request(app).delete(`/${t._id}/visa-holdings/${holding._id}`);
    expect(removed.status).toBe(409);

    const still: any = await VisaHolding.findById(holding._id).lean();
    expect(still.countryIso2).toBe("DE");
    expect(still.deletedAt).toBeNull();
  });

  it("marks an AUTO row non-editable in the wallet payload", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-024");
    const application = await makeApprovedApplication({ travellerProfileId: t._id });
    await syncVisaHoldingFromApplication(application, LEADER_USER_ID);

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/visa-holdings`);
    const row = res.body.holdings[0];
    expect(row.source).toBe("AUTO");
    expect(row.editable).toBe(false);
    expect(row.sourceApplicationId).toBe(String(application._id));
  });
});

/* ── Schengen: a grouping, never a calculation ───────────────────────── */

describe("Schengen block (§7.4) — no day math anywhere", () => {
  it("flags Schengen holdings from the country table", () => {
    expect(isSchengenIso2("DE")).toBe(true);
    expect(isSchengenIso2("FR")).toBe(true);
    // Not Schengen, and an unmapped code is never classified as one.
    expect(isSchengenIso2("US")).toBe(false);
    expect(isSchengenIso2("GB")).toBe(false);
    expect(isSchengenIso2("ZZ")).toBe(false);
    expect(isSchengenIso2(null)).toBe(false);
  });

  it("lists Schengen holdings and offers NO day counter", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-030");
    await VisaHolding.create([
      {
        workspaceId: WORKSPACE_A, travellerProfileId: t._id, countryIso2: "DE",
        countryName: "Germany", expiryDate: "2099-01-01", source: "MANUAL", createdBy: LEADER_USER_ID,
      },
      {
        workspaceId: WORKSPACE_A, travellerProfileId: t._id, countryIso2: "US",
        countryName: "United States", expiryDate: "2099-01-01", source: "MANUAL", createdBy: LEADER_USER_ID,
      },
    ]);

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/visa-holdings`);
    expect(res.body.schengen.holdings).toHaveLength(1);
    expect(res.body.schengen.holdings[0].countryIso2).toBe("DE");
    expect(res.body.schengen.trackerAvailable).toBe(false);
    expect(res.body.schengen.trackerReason).toMatch(/entry and exit dates/i);
  });

  it("carries NO ingredient a client could build a 90/180 figure from", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-031");
    await VisaHolding.create({
      workspaceId: WORKSPACE_A, travellerProfileId: t._id, countryIso2: "IT",
      countryName: "Italy", expiryDate: "2099-01-01", source: "MANUAL", createdBy: LEADER_USER_ID,
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/visa-holdings`);

    // A guard, not a formality: the surest way to keep a day counter off
    // this tab is for the payload never to carry one. If a future change
    // adds any of these KEYS, this fails before a UI can render them.
    //
    // Asserted over key NAMES, not over the serialised text — the
    // trackerReason prose legitimately says "a 90/180 allowance is counted
    // from entry and exit dates", and a substring scan would flag the very
    // sentence that exists to explain why no number is shown. What must not
    // exist is a FIELD holding a figure.
    const keysOf = (v: any): string[] =>
      v && typeof v === "object"
        ? Object.keys(v).concat(Object.values(v).flatMap(keysOf))
        : [];
    const keys = keysOf(res.body.schengen).map((k) => k.toLowerCase());
    for (const forbidden of ["daysremaining", "daysused", "dayscount", "allowance", "windowstart", "windowend", "percent"]) {
      expect(keys).not.toContain(forbidden);
    }
    // And nothing anywhere in it is a bare number that could be read as a
    // day count — every value is a string, a boolean or a holding row.
    expect(typeof res.body.schengen.trackerAvailable).toBe("boolean");
    expect(typeof res.body.schengen.trackerReason).toBe("string");
  });

  it("resolveSchengenBlock returns no numeric fields of its own", () => {
    const block = resolveSchengenBlock([]);
    expect(Object.keys(block).sort()).toEqual(["holdings", "trackerAvailable", "trackerReason"]);
  });
});

/* ── Workspace scoping ───────────────────────────────────────────────── */

describe("workspace scoping", () => {
  it("never returns another workspace's holdings or trips", async () => {
    const tA = await seedTraveller(WORKSPACE_A, "ACME-040");
    const tB = await seedTraveller(WORKSPACE_B, "BETA-040");

    await VisaHolding.create([
      {
        workspaceId: WORKSPACE_A, travellerProfileId: tA._id, countryIso2: "DE",
        countryName: "Germany", source: "MANUAL", createdBy: LEADER_USER_ID,
      },
      {
        workspaceId: WORKSPACE_B, travellerProfileId: tB._id, countryIso2: "US",
        countryName: "United States", source: "MANUAL", createdBy: LEADER_USER_ID,
      },
    ]);
    await TravellerTrip.create([
      {
        workspaceId: WORKSPACE_A, travellerProfileId: tA._id, countryIso2: "DE",
        countryName: "Germany", purpose: "BUSINESS", datePrecision: "MONTH",
        tripMonth: "2026-03", createdBy: LEADER_USER_ID,
      },
      {
        workspaceId: WORKSPACE_B, travellerProfileId: tB._id, countryIso2: "US",
        countryName: "United States", purpose: "TOURIST", datePrecision: "MONTH",
        tripMonth: "2026-04", createdBy: LEADER_USER_ID,
      },
    ]);

    const appA = makeApp(WORKSPACE_A, CUSTOMER_A);
    const wallet = await request(appA).get(`/${tA._id}/visa-holdings`);
    expect(wallet.body.holdings.map((h: any) => h.countryIso2)).toEqual(["DE"]);
    const trips = await request(appA).get(`/${tA._id}/trips`);
    expect(trips.body.trips.map((t: any) => t.countryIso2)).toEqual(["DE"]);
  });

  it("404s a traveller that belongs to another workspace", async () => {
    const tB = await seedTraveller(WORKSPACE_B, "BETA-041");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${tB._id}/visa-holdings`);
    expect(res.status).toBe(404);
  });

  it("404s a holdingId from another traveller, rather than editing it", async () => {
    const t1 = await seedTraveller(WORKSPACE_A, "ACME-042");
    const t2 = await seedTraveller(WORKSPACE_A, "ACME-043");
    const holding = await VisaHolding.create({
      workspaceId: WORKSPACE_A, travellerProfileId: t2._id, countryIso2: "DE",
      countryName: "Germany", source: "MANUAL", createdBy: LEADER_USER_ID,
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A))
      .put(`/${t1._id}/visa-holdings/${holding._id}`)
      .send({ country: "FR" });
    expect(res.status).toBe(404);

    const still: any = await VisaHolding.findById(holding._id).lean();
    expect(still.countryIso2).toBe("DE");
  });
});

/* ── Access ──────────────────────────────────────────────────────────── */

describe("edit-level access gate", () => {
  it("refuses a REQUESTER who is neither the subject nor the creator", async () => {
    await CustomerMember.deleteMany({ customerId: CUSTOMER_A });
    await CustomerMember.create({
      customerId: CUSTOMER_A, email: "employee@acme.test", role: "REQUESTER", isActive: true,
    });
    const t = await TravellerProfile.create({
      workspaceId: WORKSPACE_A, travelerId: "ACME-050", firstName: "Someone", lastName: "Else",
      source: "MANUAL", createdBy: new mongoose.Types.ObjectId(),
    });

    const app = makeApp(WORKSPACE_A, CUSTOMER_A, "employee@acme.test");
    // The READ is gated too, not just the write — a colleague's wallet and
    // trip log are not needed by any booking flow.
    expect((await request(app).get(`/${t._id}/visa-holdings`)).status).toBe(403);
    expect((await request(app).get(`/${t._id}/trips`)).status).toBe(403);
    expect((await request(app).post(`/${t._id}/visa-holdings`).send({ country: "DE" })).status).toBe(403);
  });

  it("lets the claimed subject manage their OWN wallet and trips", async () => {
    await CustomerMember.deleteMany({ customerId: CUSTOMER_A });
    await CustomerMember.create({
      customerId: CUSTOMER_A, email: "employee@acme.test", role: "REQUESTER", isActive: true,
    });
    const t = await TravellerProfile.create({
      workspaceId: WORKSPACE_A, travelerId: "ACME-051", firstName: "Asha", lastName: "Rao",
      source: "MANUAL", createdBy: new mongoose.Types.ObjectId(), claimedBy: LEADER_USER_ID,
    });

    const app = makeApp(WORKSPACE_A, CUSTOMER_A, "employee@acme.test");
    expect((await request(app).get(`/${t._id}/visa-holdings`)).status).toBe(200);
    const added = await request(app).post(`/${t._id}/trips`).send({
      country: "AE", purpose: "BUSINESS", datePrecision: "EXACT",
      startDate: "2026-02-01", endDate: "2026-02-05",
    });
    expect(added.status).toBe(201);
  });
});

/* ── Trips ───────────────────────────────────────────────────────────── */

describe("travel history log — manual only", () => {
  it("records an exact-date trip and counts its duration inclusively", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-060");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).post(`/${t._id}/trips`).send({
      country: "SG", purpose: "CONFERENCE", datePrecision: "EXACT",
      startDate: "2026-04-01", endDate: "2026-04-03", visaType: "Visa-free",
    });

    expect(res.status).toBe(201);
    // Out on the 1st, back on the 3rd is 3 days — how a visa form counts
    // days of stay.
    expect(res.body.trip).toMatchObject({
      countryIso2: "SG", countryName: "Singapore", purpose: "CONFERENCE", durationDays: 3,
    });
  });

  it("shows NO duration for a month-precision trip", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-061");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).post(`/${t._id}/trips`).send({
      country: "TH", purpose: "TOURIST", datePrecision: "MONTH", tripMonth: "2019-03",
    });

    expect(res.status).toBe(201);
    // A month is not a duration, and turning it into one would put a
    // made-up number of days on a consular form.
    expect(res.body.trip.durationDays).toBeNull();
    expect(res.body.trip.tripMonth).toBe("2019-03");
    expect(res.body.trip.startDate).toBeNull();
  });

  it("derives no duration from a half-filled exact trip", () => {
    expect(deriveTripDurationDays({ datePrecision: "EXACT", startDate: "2026-01-01" })).toBeNull();
    expect(deriveTripDurationDays({ datePrecision: "MONTH", tripMonth: "2026-01" } as any)).toBeNull();
    expect(
      deriveTripDurationDays({ datePrecision: "EXACT", startDate: "2026-01-05", endDate: "2026-01-01" }),
    ).toBeNull();
  });

  it("clears the exact dates when a trip is switched to month precision", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-062");
    const app = makeApp(WORKSPACE_A, CUSTOMER_A);
    const created = await request(app).post(`/${t._id}/trips`).send({
      country: "MY", purpose: "BUSINESS", datePrecision: "EXACT",
      startDate: "2026-01-01", endDate: "2026-01-10",
    });

    const edited = await request(app).put(`/${t._id}/trips/${created.body.trip._id}`).send({
      country: "MY", purpose: "BUSINESS", datePrecision: "MONTH", tripMonth: "2026-01",
    });

    expect(edited.status).toBe(200);
    expect(edited.body.trip.durationDays).toBeNull();
    // The day-precision dates must not survive as data the surface has
    // stopped showing but that still asserts something.
    const stored: any = await TravellerTrip.findById(created.body.trip._id).lean();
    expect(stored.startDate).toBeUndefined();
    expect(stored.endDate).toBeUndefined();
  });

  it("rejects an unrecognised purpose and an unrecognised country", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-063");
    const app = makeApp(WORKSPACE_A, CUSTOMER_A);
    expect(
      (await request(app).post(`/${t._id}/trips`).send({ country: "SG", purpose: "HOLIDAYING" })).status,
    ).toBe(400);
    expect(
      (await request(app).post(`/${t._id}/trips`).send({ country: "Neverland", purpose: "BUSINESS" })).status,
    ).toBe(400);
  });

  it('reports "recorded" counts only, and soft-deletes', async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-064");
    const app = makeApp(WORKSPACE_A, CUSTOMER_A);
    const a = await request(app).post(`/${t._id}/trips`).send({
      country: "DE", purpose: "BUSINESS", datePrecision: "MONTH", tripMonth: "2026-02",
    });
    await request(app).post(`/${t._id}/trips`).send({
      country: "FR", purpose: "TOURIST", datePrecision: "MONTH", tripMonth: "2026-05",
    });

    const listed = await request(app).get(`/${t._id}/trips`);
    expect(listed.body.summary).toMatchObject({ recorded: 2, countries: 2 });

    await request(app).delete(`/${t._id}/trips/${a.body.trip._id}`);
    const after = await request(app).get(`/${t._id}/trips`);
    expect(after.body.summary.recorded).toBe(1);
    const stored: any = await TravellerTrip.findById(a.body.trip._id).lean();
    expect(stored.deletedAt).toBeInstanceOf(Date);
  });

  it("offers no derive-from-bookings path at all", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-065");
    const app = makeApp(WORKSPACE_A, CUSTOMER_A);

    // §6's rule, asserted as a route contract: there is no import, no
    // suggest, and no name-matched trip anywhere. A future "helpful"
    // endpoint would fail here before it could put somebody else's travel
    // into a consular history.
    for (const path of [`/${t._id}/trips/import`, `/${t._id}/trips/from-bookings`, `/${t._id}/trips/suggest`]) {
      const res = await request(app).post(path).send({});
      expect(res.status).toBe(404);
    }

    const listed = await request(app).get(`/${t._id}/trips`);
    expect(listed.body.trips).toEqual([]);
    // Nothing was inferred from the traveller's name, which is the only
    // join a booking could have offered.
    expect(listed.body.summary.recorded).toBe(0);
  });
});
