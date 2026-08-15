// Coverage for the channel backfill — against real collections on
// mongodb-memory-server, because the whole migration turns on $exists
// semantics and Mongoose default behaviour, which a mock would simply assert
// into existence.
//
// main()/mongoose.connect are never invoked: the module guards its auto-run
// behind isDirectRun (process.argv[1] === this file), so importing it for its
// exports cannot start a run.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-source-backfill-test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: VisaRequest } = await import("../models/VisaRequest.js");
const { default: VisaApplication } = await import("../models/VisaApplication.js");
const { backfillVisaCaseSource, assertLocalDatabase, describeTarget } = await import(
  "./2026-08-16-backfill-visa-case-source.js"
);

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
  await Promise.all([VisaRequest.deleteMany({}), VisaApplication.deleteMany({})]);
});

/**
 * A row as it existed BEFORE the field was added — inserted through the raw
 * driver so Mongoose's default never applies. Going through the model would
 * stamp source:"B2B" on creation and there would be nothing left to backfill,
 * which would make every assertion below vacuous.
 */
async function insertLegacyApplication() {
  const res = await mongoose.connection.collection("visaapplications").insertOne({
    workspaceId: new mongoose.Types.ObjectId(),
    requestId: new mongoose.Types.ObjectId(),
    travellerProfileId: new mongoose.Types.ObjectId(),
    status: "submitted",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return res.insertedId;
}

async function insertLegacyRequest() {
  const res = await mongoose.connection.collection("visarequests").insertOne({
    workspaceId: new mongoose.Types.ObjectId(),
    raisedByUserId: new mongoose.Types.ObjectId(),
    destinationIso2: "DE",
    purpose: "TOURIST",
    referenceNumber: `HV26-${Math.floor(Math.random() * 900000 + 100000)}`,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return res.insertedId;
}

const raw = (name: string) => mongoose.connection.collection(name);

describe("backfill — correctness", () => {
  it("finds legacy rows that genuinely lack the field", async () => {
    await insertLegacyApplication();
    await insertLegacyRequest();

    const summary = await backfillVisaCaseSource(true);
    expect(summary.applicationsScanned).toBe(1);
    expect(summary.requestsScanned).toBe(1);
  });

  it('sets every existing case to "B2B"', async () => {
    const appId = await insertLegacyApplication();
    const reqId = await insertLegacyRequest();

    const summary = await backfillVisaCaseSource(false);
    expect(summary.applicationsBackfilled).toBe(1);
    expect(summary.requestsBackfilled).toBe(1);

    expect((await raw("visaapplications").findOne({ _id: appId }))!.source).toBe("B2B");
    expect((await raw("visarequests").findOne({ _id: reqId }))!.source).toBe("B2B");
  });

  it("backfills every legacy row, not just the first", async () => {
    for (let i = 0; i < 5; i += 1) await insertLegacyApplication();
    const summary = await backfillVisaCaseSource(false);
    expect(summary.applicationsBackfilled).toBe(5);
    expect(await raw("visaapplications").countDocuments({ source: "B2B" })).toBe(5);
  });
});

describe("backfill — dry run", () => {
  it("writes nothing and reports zero backfilled", async () => {
    const appId = await insertLegacyApplication();

    const summary = await backfillVisaCaseSource(true);
    expect(summary.applicationsScanned).toBe(1);
    expect(summary.applicationsBackfilled).toBe(0);

    const after = await raw("visaapplications").findOne({ _id: appId });
    expect(after!.source).toBeUndefined();
  });
});

describe("backfill — idempotency", () => {
  it("a second run scans nothing", async () => {
    await insertLegacyApplication();
    await insertLegacyRequest();

    const first = await backfillVisaCaseSource(false);
    expect(first.applicationsBackfilled).toBe(1);
    expect(first.requestsBackfilled).toBe(1);

    const second = await backfillVisaCaseSource(false);
    expect(second.applicationsScanned).toBe(0);
    expect(second.requestsScanned).toBe(0);
    expect(second.applicationsBackfilled).toBe(0);
  });

  it("never touches a row already marked D2C", async () => {
    // The selector is $exists:false, so a legitimately-D2C case created
    // before the migration ran is invisible to it. Verified rather than
    // assumed, because getting this wrong would silently re-channel a real
    // consumer case to B2B.
    const d2cId = (
      await raw("visaapplications").insertOne({
        workspaceId: new mongoose.Types.ObjectId(),
        requestId: new mongoose.Types.ObjectId(),
        travellerProfileId: new mongoose.Types.ObjectId(),
        source: "D2C",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    ).insertedId;
    await insertLegacyApplication();

    const summary = await backfillVisaCaseSource(false);
    expect(summary.applicationsScanned).toBe(1); // the legacy row only
    expect((await raw("visaapplications").findOne({ _id: d2cId }))!.source).toBe("D2C");
  });

  it("leaves nothing behind — a dry run after an apply reports a clean slate", async () => {
    await insertLegacyApplication();
    await backfillVisaCaseSource(false);
    const check = await backfillVisaCaseSource(true);
    expect(check.applicationsScanned).toBe(0);
  });
});

describe("assertLocalDatabase — the production guard", () => {
  it("accepts a local URI pointing at plumbox_dev", () => {
    expect(() => assertLocalDatabase("mongodb://127.0.0.1:27017/plumbox_dev")).not.toThrow();
    expect(() => assertLocalDatabase("mongodb://localhost:27017/plumbox_dev")).not.toThrow();
  });

  it("refuses an Atlas mongodb+srv URI outright", () => {
    expect(() =>
      assertLocalDatabase("mongodb+srv://u:p@main-prod-cluster.abc.mongodb.net/Plumtrips_hrms"),
    ).toThrow(/REFUSING TO RUN.*Atlas/s);
  });

  it("refuses a non-local host", () => {
    expect(() => assertLocalDatabase("mongodb://10.0.0.5:27017/plumbox_dev")).toThrow(
      /non-local host/,
    );
  });

  it("refuses a LOCAL host holding a differently-named database", () => {
    // A local mongod can perfectly well hold a restore of production.
    expect(() => assertLocalDatabase("mongodb://127.0.0.1:27017/Plumtrips_hrms")).toThrow(
      /expected 'plumbox_dev'/,
    );
  });

  it("refuses an empty URI", () => {
    expect(() => assertLocalDatabase("")).toThrow(/MONGO_URI is empty/);
  });
});

describe("describeTarget — what the production prompt prints", () => {
  it("extracts host and database from an Atlas URI without leaking credentials", () => {
    const t = describeTarget("mongodb+srv://user:secret@main-prod-cluster.x.mongodb.net/Plumtrips_hrms?retryWrites=true");
    expect(t.host).toBe("main-prod-cluster.x.mongodb.net");
    expect(t.db).toBe("Plumtrips_hrms");
    expect(JSON.stringify(t)).not.toContain("secret");
  });
});
