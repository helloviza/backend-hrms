// Slice 2 — Opportunity model against a real collection (mongodb-memory-server):
// the pipeline/stage validator, stage-driven probability, closedAt stamping,
// the one-opportunity-per-lead index (M7), Counter-based codes (D4) and the
// TravelBooking service-vocabulary lock.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/opportunity-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Opportunity } = await import("./Opportunity.js");
const { default: Counter } = await import("./Counter.js");
const { TRAVEL_SERVICES } = await import("./crmTaxonomy.js");
const TravelBookingModule = await import("./TravelBooking.js");

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Opportunity.deleteMany({});
  await Counter.deleteMany({});
});

describe("vocabulary lock", () => {
  it("TRAVEL_SERVICES equals TravelBooking.service's enum (one word per service)", () => {
    const model: any = (TravelBookingModule as any).default ?? Object.values(TravelBookingModule)[0];
    const path = model.schema.path("service");
    expect([...path.enumValues].sort()).toEqual([...TRAVEL_SERVICES].sort());
  });
});

describe("pipeline / stage", () => {
  it("rejects a stage that is not in the pipeline's table", async () => {
    await expect(Opportunity.create({ pipeline: "corporate", stage: "options_sent" })).rejects.toThrow(/not a stage of this pipeline/);
    await expect(Opportunity.create({ pipeline: "galaxy", stage: "proposal" })).rejects.toThrow(/pipeline/);
  });

  it("probability follows the stage table; an explicit value is an override", async () => {
    const a = await Opportunity.create({ pipeline: "corporate", stage: "proposal" });
    expect(a.probability).toBe(65);
    expect(a.probabilityOverridden).toBe(false);

    a.stage = "negotiation";
    await a.save();
    expect(a.probability).toBe(80);

    const b = await Opportunity.create({ pipeline: "travel_enquiry", stage: "options_sent", probability: 40 });
    expect(b.probability).toBe(40);
    expect(b.probabilityOverridden).toBe(true);
  });

  it("closedAt is stamped on a closed stage and cleared when reopened; a supplied closedAt is kept", async () => {
    const o = await Opportunity.create({ pipeline: "corporate", stage: "negotiation" });
    expect(o.closedAt).toBeNull();
    o.stage = "closed_won";
    await o.save();
    expect(o.closedAt).toBeInstanceOf(Date);
    o.stage = "proposal";
    await o.save();
    expect(o.closedAt).toBeNull();

    const when = new Date("2026-03-01T00:00:00Z");
    const w = await Opportunity.create({ pipeline: "corporate", stage: "closed_won", closedAt: when });
    expect(w.closedAt!.toISOString()).toBe(when.toISOString());
  });
});

describe("identity", () => {
  it("one opportunity per lead (unique partial index on leadId); null leadIds do not collide", async () => {
    const leadId = new mongoose.Types.ObjectId();
    await Opportunity.create({ pipeline: "corporate", stage: "proposal", leadId });
    await expect(Opportunity.create({ pipeline: "corporate", stage: "proposal", leadId })).rejects.toMatchObject({ code: 11000 });
    await Opportunity.create({ pipeline: "corporate", stage: "proposal" });
    await Opportunity.create({ pipeline: "corporate", stage: "proposal" });
    expect(await Opportunity.countDocuments({ leadId: null })).toBe(2);
  });

  it("codes come from the atomic Counter, not countDocuments()+1", async () => {
    const a = await Opportunity.create({ pipeline: "corporate", stage: "proposal" });
    const b = await Opportunity.create({ pipeline: "corporate", stage: "proposal" });
    const year = new Date().getFullYear();
    expect(a.opportunityCode).toBe(`OPP-${year}-0001`);
    expect(b.opportunityCode).toBe(`OPP-${year}-0002`);
    await a.deleteOne();
    const c = await Opportunity.create({ pipeline: "corporate", stage: "proposal" });
    expect(c.opportunityCode).toBe(`OPP-${year}-0003`); // no reuse after a delete
  });

  it("reserved tenancy field is null and nothing else is required beyond pipeline/stage", async () => {
    const o = await Opportunity.create({ pipeline: "partnerships", stage: "identified" });
    expect(o.workspaceId).toBeNull();
    expect(o.accountId).toBeNull();
    expect(o.serviceMix).toEqual([]);
    expect(o.serviceLines).toEqual([]);
    expect(o.travelRequirement.serviceMix).toEqual([]);
    expect(o.automatedByRule).toBe("");
    expect(o.forecastCategory).toBe("pipeline");
  });
});

describe("travel requirement (embedded, promotable)", () => {
  it("serviceMix and urgency are enum-validated; shape round-trips", async () => {
    await expect(
      Opportunity.create({ pipeline: "travel_enquiry", stage: "requirement_captured", travelRequirement: { serviceMix: ["CRUISE"] } }),
    ).rejects.toThrow(/serviceMix/);
    const o = await Opportunity.create({
      pipeline: "travel_enquiry",
      stage: "requirement_captured",
      travelRequirement: { serviceMix: ["FLIGHT", "HOTEL"], origin: "DEL", destination: "DXB", destinationCountry: "ae", travellerCount: 4, urgency: "within_7_days" },
      serviceLines: [{ service: "FLIGHT", qty: 4, estAmount: 120000, currency: "INR" }],
    });
    const raw = await Opportunity.collection.findOne({ _id: o._id });
    expect(raw!.travelRequirement.destinationCountry).toBe("AE");
    expect(raw!.travelRequirement.serviceMix).toEqual(["FLIGHT", "HOTEL"]);
    expect(raw!.serviceLines[0].estAmount).toBe(120000);
    expect(raw!.travelRequirement).not.toHaveProperty("passportNumber");
  });
});
