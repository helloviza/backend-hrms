// Route-level coverage for THE NULL-ID JOIN BUG on the ops queue.
//
// ══════════════════════════════════════════════════════════════════════
// WHAT BROKE, AND WHY A UNIT TEST COULD NOT HAVE CAUGHT IT
// ══════════════════════════════════════════════════════════════════════
// GET /queue joins its page to VisaRequest and TravellerProfile with
//
//   const ids = [...new Set(page.map((a) => String(a.requestId)))];
//   await VisaRequest.find({ _id: { $in: ids } })
//
// `String(null)` is "null", and Mongoose casts every `$in` element against
// the path type. Casting "null" to an ObjectId THROWS a CastError, which
// takes the whole handler with it — so ONE row with a null id returns 500
// for the ENTIRE page, every unrelated case on it included.
//
// This needs a REAL database and a REAL router. The cast happens inside
// Mongoose's query builder, so an in-memory model stub would accept "null"
// happily and the test would pass against code that 500s in production.
// Same reasoning admin.visa.queue.test.ts sets out for itself.
//
// ── TWO WAYS TO GET A NULL ID, AND ONE OF THEM IS ALREADY LIVE ───────
//   travellerProfileId  nulled by scripts/erase-traveller-profile.ts —
//                       so GET /queue?includeErased=true 500s TODAY,
//                       before any D2C row exists. This is a regression
//                       test for a bug that was already shipped.
//   requestId           nullable for source:"D2C" (the A-prime model
//                       change). Not a shape the D2C create route
//                       currently produces — it mints a parent request —
//                       but the model permits it, so the queue must
//                       survive it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

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

import router from "./admin.visa.js";
import VisaApplication from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

let mongod: MongoMemoryServer;
const CALLER_ID = new mongoose.Types.ObjectId();
let workspaceId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  permissionRecord = { modules: { visaApplication: { access: "FULL" } }, status: "active" };
  await Promise.all([
    VisaApplication.deleteMany({}),
    VisaRequest.deleteMany({}),
    TravellerProfile.deleteMany({}),
    CustomerWorkspace.deleteMany({}),
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

/** A normal B2B case: real parent request, real traveller. */
async function seedB2BCase() {
  const traveller = await TravellerProfile.create({
    workspaceId,
    travelerId: `T-${Math.random().toString(36).slice(2)}`,
    firstName: "Asha",
    lastName: "Rao",
    createdBy: CALLER_ID,
    source: "MANUAL",
  });
  const req = await VisaRequest.create({
    workspaceId,
    raisedByUserId: CALLER_ID,
    destinationIso2: "TH",
    purpose: "TOURIST",
    applicationIds: [],
  });
  return VisaApplication.create({
    workspaceId,
    requestId: req._id,
    travellerProfileId: traveller._id,
    destinationIso2: "TH",
    ruleSnapshot: RULE_SNAPSHOT,
    indicativeCostSnapshot: COST_SNAPSHOT,
    status: "submitted",
  });
}

describe("GET /queue — null ids in the page joins", () => {
  it("does NOT 500 when a D2C row on the page has a null requestId", async () => {
    await seedB2BCase();
    const d2c = await VisaApplication.create({
      workspaceId,
      source: "D2C",
      consumerId: new mongoose.Types.ObjectId(),
      // The shape the model now permits. Before the fix this single row
      // returned 500 for the whole page.
      requestId: null,
      travellerProfileId: null,
      destinationIso2: "TH",
      ruleSnapshot: RULE_SNAPSHOT,
      indicativeCostSnapshot: COST_SNAPSHOT,
      status: "submitted",
    });

    const res = await request(makeApp()).get("/queue");

    expect(res.status).toBe(200);
    const ids = res.body.applications.map((a: any) => a.id);
    expect(ids).toContain(String(d2c._id));
    expect(res.body.applications).toHaveLength(2);

    // The row renders with its request-derived fields null rather than
    // being dropped or throwing — everything downstream was already
    // written for a lookup miss.
    const row = res.body.applications.find((a: any) => a.id === String(d2c._id));
    expect(row.request).toBeNull();
    expect(row.traveller).toBeNull();
    // Its OWN fields still resolve — the snapshot is on the application.
    expect(row.destinationName).toBe("Thailand");
  });

  it("leaves a normal B2B row on the same page fully joined", async () => {
    const b2b = await seedB2BCase();
    await VisaApplication.create({
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
    const row = res.body.applications.find((a: any) => a.id === String(b2b._id));
    // The whole point: one bad neighbour must not degrade a good row.
    expect(row.request).not.toBeNull();
    expect(row.request.referenceNumber).toBeTruthy();
    expect(row.traveller).not.toBeNull();
    expect(row.traveller.name).toBe("Asha Rao");
    expect(row.workspace.name).toBe("Acme Ltd");
  });

  it("?includeErased=true no longer 500s — the pre-existing bug", async () => {
    // An erased traveller: travellerProfileId nulled, travellerErasedAt set.
    // The default queue filter excludes these, which is the ONLY reason the
    // bug stayed hidden; asking for them explicitly is what triggered it.
    const req = await VisaRequest.create({
      workspaceId,
      raisedByUserId: CALLER_ID,
      destinationIso2: "TH",
      purpose: "TOURIST",
      applicationIds: [],
    });
    const erased = await VisaApplication.create({
      workspaceId,
      requestId: req._id,
      travellerProfileId: null,
      travellerErasedAt: new Date(),
      destinationIso2: "TH",
      ruleSnapshot: RULE_SNAPSHOT,
      indicativeCostSnapshot: COST_SNAPSHOT,
      status: "submitted",
    });

    const res = await request(makeApp()).get("/queue?includeErased=true");

    expect(res.status).toBe(200);
    const row = res.body.applications.find((a: any) => a.id === String(erased._id));
    expect(row).toBeTruthy();
    expect(row.traveller).toBeNull();
    // The parent request is real here, so it still joins.
    expect(row.request).not.toBeNull();
  });

  it("still excludes erased rows by default (the filter is unchanged)", async () => {
    const req = await VisaRequest.create({
      workspaceId,
      raisedByUserId: CALLER_ID,
      destinationIso2: "TH",
      purpose: "TOURIST",
      applicationIds: [],
    });
    await VisaApplication.create({
      workspaceId,
      requestId: req._id,
      travellerProfileId: null,
      travellerErasedAt: new Date(),
      destinationIso2: "TH",
      ruleSnapshot: RULE_SNAPSHOT,
      indicativeCostSnapshot: COST_SNAPSHOT,
      status: "submitted",
    });

    const res = await request(makeApp()).get("/queue");

    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * THE CHANNEL TAB FILTER — and the proof the B2B tab did not change.
 *
 * The console now always sends ?source=. Three things have to hold, and
 * the middle one is the one that could quietly break production:
 *
 *   1. NO source param  => no filtering at all. Every other caller of
 *      this endpoint, and the endpoint's own history, is unaffected.
 *   2. source=B2B       => B2B rows AND rows with NO source key. `source`
 *      shipped recently; every application written before it has no such
 *      field, and an `$eq: "B2B"` filter would silently drop all of them
 *      from the live ops surface. This is the regression this test exists
 *      to prevent.
 *   3. source=D2C       => only D2C.
 * ───────────────────────────────────────────────────────────────────── */

describe("GET /queue — the B2B | D2C channel tabs", () => {
  async function seedLegacyRowWithNoSourceField() {
    const b2b = await seedB2BCase();
    // Strip the field entirely, the way a pre-channel-tag document looks.
    // Done through the driver so no Mongoose default puts it back.
    await VisaApplication.collection.updateOne({ _id: b2b._id }, { $unset: { source: "" } });
    return b2b;
  }

  it("no ?source at all leaves the queue completely unfiltered", async () => {
    const b2b = await seedB2BCase();
    const d2c = await VisaApplication.create({
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
    const ids = res.body.applications.map((a: any) => a.id).sort();
    expect(ids).toEqual([String(b2b._id), String(d2c._id)].sort());
  });

  it("source=B2B keeps a LEGACY row that has no source field at all", async () => {
    const legacy = await seedLegacyRowWithNoSourceField();

    const res = await request(makeApp()).get("/queue?source=B2B");

    expect(res.status).toBe(200);
    const ids = res.body.applications.map((a: any) => a.id);
    expect(ids).toContain(String(legacy._id));
    // And it reports as B2B rather than as a blank column.
    const row = res.body.applications.find((a: any) => a.id === String(legacy._id));
    expect(row.source).toBe("B2B");
  });

  it("source=B2B excludes D2C, source=D2C excludes B2B", async () => {
    const b2b = await seedB2BCase();
    const d2c = await VisaApplication.create({
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

    const b2bRes = await request(makeApp()).get("/queue?source=B2B");
    expect(b2bRes.body.applications.map((a: any) => a.id)).toEqual([String(b2b._id)]);

    const d2cRes = await request(makeApp()).get("/queue?source=D2C");
    expect(d2cRes.body.applications.map((a: any) => a.id)).toEqual([String(d2c._id)]);
  });

  it("rejects an unknown channel rather than silently ignoring it", async () => {
    const res = await request(makeApp()).get("/queue?source=PARTNER");
    expect(res.status).toBe(400);
  });
});
