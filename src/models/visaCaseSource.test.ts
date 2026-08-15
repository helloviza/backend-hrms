// Coverage for the channel tag and — the part that actually matters — its
// IMMUTABILITY, against real models on mongodb-memory-server.
//
// Mongoose's `immutable: true` only covers save()/create(). It silently does
// NOT cover findOneAndUpdate/updateOne/updateMany, which is exactly how
// routes/admin.visa.ts mutates applications. A test that only exercised
// save() would pass while the field was wide open through every route that
// touches it — so every update operation is exercised here by name.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-source-test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: VisaRequest } = await import("./VisaRequest.js");
const { default: VisaApplication } = await import("./VisaApplication.js");
const { default: VisaActivityLog, logVisaActivity } = await import("./VisaActivityLog.js");
const { updateTouchesSource, VISA_CASE_SOURCES, DEFAULT_VISA_CASE_SOURCE } = await import(
  "./visaCaseSource.js"
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
  await Promise.all([
    VisaRequest.deleteMany({}),
    VisaApplication.deleteMany({}),
    VisaActivityLog.deleteMany({}),
  ]);
});

const wsId = () => new mongoose.Types.ObjectId();

async function makeRequest(extra: Record<string, any> = {}) {
  return VisaRequest.create({
    workspaceId: wsId(),
    raisedByUserId: new mongoose.Types.ObjectId(),
    destinationIso2: "DE",
    purpose: "TOURIST",
    referenceNumber: `HV26-${Math.floor(Math.random() * 900000 + 100000)}`,
    ...extra,
  });
}

// ruleSnapshot/indicativeCostSnapshot are `required: true` on the model —
// a real application always has both, so the fixture carries them rather
// than the test relaxing the schema.
const RULE_SNAPSHOT = {
  ruleId: new mongoose.Types.ObjectId(),
  capturedAt: new Date(),
  destinationName: "Germany",
  isSchengen: true,
  productClass: "VISA",
  visaCategory: "STICKER",
  purpose: "TOURIST",
  entryType: "SINGLE",
  serviceTier: "STANDARD",
  isExtension: false,
  appointmentRequired: false,
  biometricsRequired: true,
};

const COST_SNAPSHOT = { displayMode: "ITEMISED", totalInr: 11860 };

async function makeApplication(extra: Record<string, any> = {}) {
  return VisaApplication.create({
    workspaceId: wsId(),
    requestId: new mongoose.Types.ObjectId(),
    travellerProfileId: new mongoose.Types.ObjectId(),
    ruleSnapshot: RULE_SNAPSHOT,
    indicativeCostSnapshot: COST_SNAPSHOT,
    ...extra,
  });
}

describe("source — default and accepted values", () => {
  it('has exactly two channels, defaulting to "B2B"', () => {
    expect([...VISA_CASE_SOURCES]).toEqual(["B2B", "D2C"]);
    expect(DEFAULT_VISA_CASE_SOURCE).toBe("B2B");
  });

  it('defaults a VisaRequest to "B2B"', async () => {
    const r = await makeRequest();
    expect(r.source).toBe("B2B");
  });

  it('defaults a VisaApplication to "B2B"', async () => {
    const a = await makeApplication();
    expect(a.source).toBe("B2B");
  });

  it('accepts an explicit "D2C" at creation on both models', async () => {
    const r = await makeRequest({ source: "D2C" });
    const a = await makeApplication({ source: "D2C" });
    expect(r.source).toBe("D2C");
    expect(a.source).toBe("D2C");
  });

  it("rejects a channel outside the enum", async () => {
    await expect(makeApplication({ source: "PARTNER" })).rejects.toThrow();
  });
});

describe("source — IMMUTABILITY", () => {
  it("ignores a reassignment through save() (Mongoose immutable:true)", async () => {
    const a = await makeApplication({ source: "B2B" });
    (a as any).source = "D2C";
    await a.save();

    const fresh: any = await VisaApplication.findById(a._id).lean();
    expect(fresh.source).toBe("B2B");
  });

  it("THROWS on findOneAndUpdate — the half immutable:true does not cover", async () => {
    const a = await makeApplication();
    await expect(
      VisaApplication.findOneAndUpdate({ _id: a._id }, { $set: { source: "D2C" } }),
    ).rejects.toThrow(/source is immutable/);

    const fresh: any = await VisaApplication.findById(a._id).lean();
    expect(fresh.source).toBe("B2B");
  });

  it("THROWS on findByIdAndUpdate (routes through findOneAndUpdate)", async () => {
    const a = await makeApplication();
    await expect(
      VisaApplication.findByIdAndUpdate(a._id, { $set: { source: "D2C" } }),
    ).rejects.toThrow(/source is immutable/);
  });

  it("THROWS on updateOne", async () => {
    const a = await makeApplication();
    await expect(
      VisaApplication.updateOne({ _id: a._id }, { $set: { source: "D2C" } }),
    ).rejects.toThrow(/source is immutable/);
  });

  it("THROWS on updateMany — the bulk-assign shape", async () => {
    await makeApplication();
    await makeApplication();
    await expect(
      VisaApplication.updateMany({}, { $set: { source: "D2C" } }),
    ).rejects.toThrow(/source is immutable/);
  });

  it("THROWS on a bare (non-$set) update document", async () => {
    const a = await makeApplication();
    await expect(
      VisaApplication.findOneAndUpdate({ _id: a._id }, { source: "D2C" } as any),
    ).rejects.toThrow(/source is immutable/);
  });

  it("THROWS on $unset — clearing it is a mutation too, and the field is required", async () => {
    const a = await makeApplication();
    await expect(
      VisaApplication.updateOne({ _id: a._id }, { $unset: { source: 1 } } as any),
    ).rejects.toThrow(/source is immutable/);
  });

  it("enforces the same rules on VisaRequest", async () => {
    const r = await makeRequest();
    await expect(
      VisaRequest.updateOne({ _id: r._id }, { $set: { source: "D2C" } }),
    ).rejects.toThrow(/source is immutable/);
  });

  it("does NOT block an unrelated update on the same document", async () => {
    // The guard must be surgical — an ordinary status change is how every
    // ops route works, and blocking it would be far worse than the bug.
    const a = await makeApplication();
    await VisaApplication.updateOne({ _id: a._id }, { $set: { status: "submitted" } });
    const fresh: any = await VisaApplication.findById(a._id).lean();
    expect(fresh.status).toBe("submitted");
    expect(fresh.source).toBe("B2B");
  });

  it("ALLOWS $setOnInsert — on an upsert-insert, that branch IS the creation", async () => {
    const id = new mongoose.Types.ObjectId();
    await VisaApplication.findOneAndUpdate(
      { _id: id },
      {
        $setOnInsert: {
          workspaceId: wsId(),
          requestId: new mongoose.Types.ObjectId(),
          travellerProfileId: new mongoose.Types.ObjectId(),
          ruleSnapshot: RULE_SNAPSHOT,
          indicativeCostSnapshot: COST_SNAPSHOT,
          source: "D2C",
        },
      },
      { upsert: true, new: true },
    );
    const fresh: any = await VisaApplication.findById(id).lean();
    expect(fresh.source).toBe("D2C");
  });
});

describe("updateTouchesSource — the guard's own predicate", () => {
  it("detects every mutating shape and ignores the rest", () => {
    expect(updateTouchesSource({ $set: { source: "D2C" } })).toBe(true);
    expect(updateTouchesSource({ source: "D2C" })).toBe(true);
    expect(updateTouchesSource({ $unset: { source: 1 } })).toBe(true);

    expect(updateTouchesSource({ $setOnInsert: { source: "D2C" } })).toBe(false);
    expect(updateTouchesSource({ $set: { status: "lodged" } })).toBe(false);
    expect(updateTouchesSource({})).toBe(false);
    expect(updateTouchesSource(null)).toBe(false);
    expect(updateTouchesSource(undefined)).toBe(false);
  });
});

describe("VisaActivityLog — denormalised source", () => {
  const base = () => ({
    requestId: new mongoose.Types.ObjectId(),
    workspaceId: new mongoose.Types.ObjectId(),
    actorType: "SYSTEM" as const,
  });

  it('defaults to "B2B" when the caller omits it — every existing call site', async () => {
    await logVisaActivity({ ...base(), eventType: "SUBMITTED" });
    const row: any = await VisaActivityLog.findOne({}).lean();
    expect(row.source).toBe("B2B");
  });

  it('records "D2C" when the caller passes it', async () => {
    await logVisaActivity({ ...base(), eventType: "SUBMITTED", source: "D2C" });
    const row: any = await VisaActivityLog.findOne({}).lean();
    expect(row.source).toBe("D2C");
  });

  it("is segmentable by channel without joining back to the application", async () => {
    // The whole reason the field is denormalised: admin.visa.dashboard.ts's
    // throughput/outcome tiles match on eventType + a date window and never
    // join to VisaApplication at all.
    await logVisaActivity({ ...base(), eventType: "SUBMITTED", source: "B2B" });
    await logVisaActivity({ ...base(), eventType: "SUBMITTED", source: "D2C" });
    await logVisaActivity({ ...base(), eventType: "SUBMITTED", source: "D2C" });

    expect(await VisaActivityLog.countDocuments({ eventType: "SUBMITTED", source: "D2C" })).toBe(2);
    expect(await VisaActivityLog.countDocuments({ eventType: "SUBMITTED", source: "B2B" })).toBe(1);
  });
});
