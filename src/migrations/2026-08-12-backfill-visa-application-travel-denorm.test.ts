// Coverage for the VisaApplication travel/destination/deadline backfill.
//
// Real persistence (mongodb-memory-server), because the whole idempotency
// contract rests on a genuine "$exists: false" distinction between a stored
// null and a missing field — which a hand-rolled in-memory collection models
// only by convention, and which Mongoose's own defaults interact with (they
// apply on write, never to already-stored documents). That interaction IS
// the thing under test, so it has to be real.
//
// main() is never invoked — the module guards its auto-run behind an
// argv[1] check, so importing it for its exports is safe.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import VisaApplication from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import {
  backfillVisaApplicationTravelDenorm,
  assertLocalDatabase,
} from "./2026-08-12-backfill-visa-application-travel-denorm.js";

let mongod: MongoMemoryServer;
const CALLER_ID = new mongoose.Types.ObjectId();
const TRAVEL = new Date("2026-09-01T00:00:00.000Z");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([VisaApplication.deleteMany({}), VisaRequest.deleteMany({})]);
});

/**
 * Creates a request + application pair that PREDATES the denormalisation —
 * the three fields are unset at the driver level, exactly like a row written
 * before the schema declared them.
 */
async function seedLegacyCase(opts: {
  travelDateFrom?: Date | null;
  destinationIso2?: string;
  etaMaxDays?: number | null;
  etaBasis?: "BUSINESS" | "CALENDAR";
  orphan?: boolean;
}) {
  const req = await VisaRequest.create({
    workspaceId: new mongoose.Types.ObjectId(),
    raisedByUserId: CALLER_ID,
    destinationIso2: opts.destinationIso2 ?? "FR",
    purpose: "BUSINESS",
    travelDateFrom: opts.travelDateFrom ?? undefined,
    applicationIds: [],
  });

  const etaMaxDays = opts.etaMaxDays === undefined ? 10 : opts.etaMaxDays;
  const app = await VisaApplication.create({
    workspaceId: req.workspaceId,
    requestId: req._id,
    travellerProfileId: new mongoose.Types.ObjectId(),
    ruleSnapshot: {
      ruleId: new mongoose.Types.ObjectId(),
      capturedAt: new Date(),
      destinationName: "France",
      isSchengen: true,
      productClass: "VISA",
      visaCategory: "STICKER",
      purpose: "BUSINESS",
      entryType: "SINGLE",
      serviceTier: "STANDARD",
      appointmentRequired: false,
      biometricsRequired: false,
      documentRequirements: [],
      ...(etaMaxDays == null ? {} : { etaMaxDays, etaBasis: opts.etaBasis ?? "CALENDAR" }),
    },
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 1000 },
    status: "submitted",
  });

  // Strip the denormalised fields at the driver level — Mongoose's schema
  // defaults would otherwise have written explicit nulls, which is exactly
  // the "already backfilled" state we need to NOT be in.
  await mongoose.connection.db!
    .collection("visaapplications")
    .updateOne(
      { _id: app._id },
      { $unset: { travelDateFrom: "", destinationIso2: "", processingDeadlineAt: "" } },
    );

  if (opts.orphan) await VisaRequest.deleteOne({ _id: req._id });

  return { request: req, applicationId: app._id };
}

async function raw(id: any): Promise<any> {
  return mongoose.connection.db!.collection("visaapplications").findOne({ _id: id });
}

describe("backfillVisaApplicationTravelDenorm", () => {
  it("dry-run reports what it WOULD do and writes nothing", async () => {
    const { applicationId } = await seedLegacyCase({ travelDateFrom: TRAVEL });

    const summary = await backfillVisaApplicationTravelDenorm(true);
    expect(summary).toMatchObject({ applicationsScanned: 1, backfilled: 1, dateless: 0, orphaned: 0 });

    const doc = await raw(applicationId);
    expect(doc.processingDeadlineAt).toBeUndefined();
    expect(doc.travelDateFrom).toBeUndefined();
  });

  it("copies the travel date and destination down, and computes the deadline from the row's own snapshot", async () => {
    const { applicationId } = await seedLegacyCase({
      travelDateFrom: TRAVEL,
      destinationIso2: "GB",
      etaMaxDays: 10,
      etaBasis: "CALENDAR",
    });

    await backfillVisaApplicationTravelDenorm(false);

    const doc = await raw(applicationId);
    expect(doc.destinationIso2).toBe("GB");
    expect(new Date(doc.travelDateFrom).toISOString()).toBe(TRAVEL.toISOString());
    // 10 calendar days before 1 Sep.
    expect(new Date(doc.processingDeadlineAt).toISOString()).toBe("2026-08-22T00:00:00.000Z");
  });

  it("honours the BUSINESS basis, walking the deadline back over weekends", async () => {
    const { applicationId } = await seedLegacyCase({
      travelDateFrom: new Date("2026-08-24T00:00:00.000Z"), // Monday
      etaMaxDays: 5,
      etaBasis: "BUSINESS",
    });

    await backfillVisaApplicationTravelDenorm(false);

    const doc = await raw(applicationId);
    expect(new Date(doc.processingDeadlineAt).toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("writes an explicit null for a dateless request — counted separately, never conflated with a failure", async () => {
    const { applicationId } = await seedLegacyCase({ travelDateFrom: null });

    const summary = await backfillVisaApplicationTravelDenorm(false);
    expect(summary).toMatchObject({ applicationsScanned: 1, backfilled: 0, dateless: 1, orphaned: 0 });

    const doc = await raw(applicationId);
    // Explicit null, NOT missing — that is what makes the run converge.
    expect(doc.processingDeadlineAt).toBeNull();
    expect("processingDeadlineAt" in doc).toBe(true);
  });

  it("is idempotent — a second run finds nothing left to do", async () => {
    await seedLegacyCase({ travelDateFrom: TRAVEL });
    await seedLegacyCase({ travelDateFrom: null });

    const first = await backfillVisaApplicationTravelDenorm(false);
    expect(first.applicationsScanned).toBe(2);

    const second = await backfillVisaApplicationTravelDenorm(false);
    expect(second).toMatchObject({ applicationsScanned: 0, backfilled: 0, dateless: 0, orphaned: 0 });
  });

  it("converges for dateless rows too — they are not re-selected forever", async () => {
    await seedLegacyCase({ travelDateFrom: null });
    await backfillVisaApplicationTravelDenorm(false);
    const second = await backfillVisaApplicationTravelDenorm(false);
    expect(second.applicationsScanned).toBe(0);
  });

  it("leaves an orphaned application ALONE rather than asserting a null it cannot know", async () => {
    const { applicationId } = await seedLegacyCase({ travelDateFrom: TRAVEL, orphan: true });

    const summary = await backfillVisaApplicationTravelDenorm(false);
    expect(summary).toMatchObject({ applicationsScanned: 1, backfilled: 0, dateless: 0, orphaned: 1 });

    const doc = await raw(applicationId);
    expect(doc.processingDeadlineAt).toBeUndefined();

    // Deliberately still reported next time — loud, not silently "done".
    const again = await backfillVisaApplicationTravelDenorm(false);
    expect(again.orphaned).toBe(1);
  });

  it("never touches a row that already carries the fields", async () => {
    const { applicationId } = await seedLegacyCase({ travelDateFrom: TRAVEL });
    await backfillVisaApplicationTravelDenorm(false);
    const afterFirst = await raw(applicationId);

    // Change the parent underneath it. The backfill must NOT re-copy — the
    // field is write-once, and a second pass is not a sync mechanism.
    await VisaRequest.updateOne({ _id: afterFirst.requestId }, { $set: { destinationIso2: "ZZ" } });
    await backfillVisaApplicationTravelDenorm(false);

    const afterSecond = await raw(applicationId);
    expect(afterSecond.destinationIso2).toBe(afterFirst.destinationIso2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE GUARD — the only thing between this script and production
 * ═══════════════════════════════════════════════════════════════════════ */

describe("assertLocalDatabase", () => {
  it("accepts the local development database", () => {
    expect(() => assertLocalDatabase("mongodb://127.0.0.1:27017/plumbox_dev")).not.toThrow();
    expect(() => assertLocalDatabase("mongodb://localhost:27017/plumbox_dev")).not.toThrow();
  });

  it("REFUSES the production Atlas URI shape — the default .env target", () => {
    expect(() =>
      assertLocalDatabase("mongodb+srv://user:pw@main-prod-cluster.8ntwji.mongodb.net/Plumtrips_hrms"),
    ).toThrow(/REFUSING TO RUN/);
  });

  it("REFUSES a remote host even on the plain mongodb:// scheme", () => {
    expect(() => assertLocalDatabase("mongodb://user:pw@10.0.0.5:27017/plumbox_dev")).toThrow(
      /non-local host/,
    );
  });

  it("REFUSES a replica-set list where ANY member is remote", () => {
    expect(() =>
      assertLocalDatabase("mongodb://127.0.0.1:27017,db.internal:27017/plumbox_dev"),
    ).toThrow(/non-local host/);
  });

  it("REFUSES a local host pointed at the wrong database — a local mongod can hold a prod restore", () => {
    expect(() => assertLocalDatabase("mongodb://127.0.0.1:27017/Plumtrips_hrms")).toThrow(
      /expected 'plumbox_dev'/,
    );
  });

  it("REFUSES an empty URI rather than connecting to a driver default", () => {
    expect(() => assertLocalDatabase("")).toThrow(/REFUSING TO RUN/);
  });

  it("tolerates query params and credentials on an otherwise-local URI", () => {
    expect(() =>
      assertLocalDatabase("mongodb://dev:dev@127.0.0.1:27017/plumbox_dev?retryWrites=false"),
    ).not.toThrow();
  });
});
