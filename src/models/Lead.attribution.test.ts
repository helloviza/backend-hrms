// PlumConnect Slice 0 — the `attribution` sub-doc is ADDITIVE and nothing
// writes it. This is the regression guard for that claim, against a real
// collection: a Lead.create() with the EXACT shape routes/leads.ts POST /
// uses (`{ ...body, assignedTo, assignedToName, companyId, createdBy }`)
// must produce the same stored document it produced before Slice 0, plus an
// `attribution` whose every field sits at its zero default — under both
// states of CRM_V2_OPPORTUNITY, since the pre-validate hook is the only other
// thing that touches a new lead on the way in.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/lead-attribution-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Lead } = await import("./Lead.js");
const { default: Counter } = await import("./Counter.js");
const { CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;
let savedFlag: string | undefined;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Lead.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  savedFlag = process.env[CRM_V2_OPPORTUNITY_ENV];
  await Lead.deleteMany({});
  await Counter.deleteMany({});
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[CRM_V2_OPPORTUNITY_ENV];
  else process.env[CRM_V2_OPPORTUNITY_ENV] = savedFlag;
});

/** The stored-document keys a POST / create produced before Slice 0, for the
 *  body below. Fields with no schema default and not in the body
 *  (nextFollowUpDate, wonDate, onboardingInviteDate) are absent, as before. */
const PRE_SLICE0_KEYS = [
  "__v",
  "_id",
  "address",
  "assignedTo",
  "assignedToName",
  "budget",
  "companyId",
  "companyName",
  "companySize",
  "contactDesignation",
  "contactEmail",
  "contactName",
  "contactPhone",
  "convertedToCompanyId",
  "convertedToContactId",
  "createdAt",
  "createdBy",
  "currency",
  "dealValue",
  "disposition",
  "dispositionAt",
  "dispositionStage",
  "dispositionStatus",
  "enquiryType",
  "followUpNotes",
  "gstin",
  "importBatchId",
  "industry",
  "leadCode",
  "location",
  "lostReason",
  "notes",
  "onboardingInviteSent",
  "onboardingToken",
  "opportunityId",
  "pipelineId",
  "possibleDuplicateOf",
  "source",
  "sourceChannel",
  "stage",
  "status",
  "subDisposition",
  "travelRequirement",
  "type",
  "updatedAt",
  "website",
  "workspaceId",
].sort();

/** Every attribution field at its zero default, and nothing else — no _id. */
const EMPTY_ATTRIBUTION = {
  channel: "",
  sourceType: "",
  sourceId: "",
  sourceUrl: "",
  ctwaClid: "",
  headline: "",
  body: "",
  mediaType: "",
  capturedAt: null,
  conversationId: null,
};

/** What the Leads form posts (the fields LeadForm sends), i.e. `body`. */
function postBody() {
  return {
    type: "company",
    companyName: "Acme Travels Pvt Ltd",
    industry: "IT/Technology",
    companySize: "51-200",
    location: "Bengaluru",
    website: "https://acme.example",
    gstin: "29ABCDE1234F1Z5",
    contactName: "Rohan Mehta",
    contactPhone: "+91 98765 43210",
    contactEmail: "rohan@acme.example",
    contactDesignation: "Travel Manager",
    source: "linkedin",
    stage: "new",
    budget: "5L/yr",
    dealValue: 500000,
    currency: "INR",
    notes: "Met at the expo.",
  };
}

/** routes/leads.ts POST / — `Lead.create({ ...body, assignedTo, assignedToName, companyId, createdBy })`. */
function createLikeRoute() {
  const assignedTo = new mongoose.Types.ObjectId();
  const companyId = new mongoose.Types.ObjectId();
  return Lead.create({
    ...postBody(),
    assignedTo,
    assignedToName: "Nikita Rao",
    companyId,
    createdBy: assignedTo,
  });
}

async function storedDoc(id: mongoose.Types.ObjectId) {
  // Raw driver read: exactly what is on disk, no hydration defaults.
  return Lead.collection.findOne({ _id: id }) as Promise<Record<string, any>>;
}

describe("Lead.attribution — additive, never written by the POST / shape", () => {
  it("flag OFF: stored document = pre-Slice-0 keys + attribution at defaults", async () => {
    delete process.env[CRM_V2_OPPORTUNITY_ENV];
    const lead = await createLikeRoute();
    const doc = await storedDoc(lead._id as mongoose.Types.ObjectId);

    expect(Object.keys(doc).sort()).toEqual([...PRE_SLICE0_KEYS, "attribution"].sort());
    expect(doc.attribution).toEqual(EMPTY_ATTRIBUTION);
    expect(doc.attribution).not.toHaveProperty("_id");

    // The pre-existing fields are what the body and the schema defaults say,
    // exactly as before: flag OFF leaves the Slice-2 paths untouched.
    expect(doc.contactName).toBe("Rohan Mehta");
    expect(doc.contactPhone).toBe("+91 98765 43210");
    expect(doc.source).toBe("linkedin");
    expect(doc.stage).toBe("new");
    expect(doc.status).toBeNull();
    expect(doc.sourceChannel).toBe("");
    expect(doc.enquiryType).toBe("");
    expect(doc.assignedToName).toBe("Nikita Rao");
    expect(doc.leadCode).toMatch(/^LEAD-\d{4}-\d{4}$/);
  });

  it("flag ON: the pre-validate hook still derives status/sourceChannel; attribution stays at defaults", async () => {
    process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
    const lead = await createLikeRoute();
    const doc = await storedDoc(lead._id as mongoose.Types.ObjectId);

    expect(Object.keys(doc).sort()).toEqual([...PRE_SLICE0_KEYS, "attribution"].sort());
    expect(doc.attribution).toEqual(EMPTY_ATTRIBUTION);
    expect(doc.status).toBe("NEW");
    expect(doc.sourceChannel).toBe("linkedin");
  });

  it("a legacy row with no attribution field is read back with an empty one (no backfill needed)", async () => {
    // Raw insert, bypassing the schema — the shape of the 939 legacy rows.
    const _id = new mongoose.Types.ObjectId();
    await Lead.collection.insertOne({
      _id,
      contactName: "Legacy",
      contactPhone: "9876543210",
      stage: "contacted",
      source: "manual",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-01"),
    });

    const hydrated = await Lead.findById(_id);
    expect(hydrated!.toObject().attribution).toEqual(EMPTY_ATTRIBUTION);

    const lean = await Lead.findById(_id).lean();
    expect(lean!.attribution).toBeUndefined(); // absent on disk, untouched

    const raw = await storedDoc(_id);
    expect(raw).not.toHaveProperty("attribution");
  });

  it("the sub-doc accepts the fields the Slice-3 consumer will write, and no others", async () => {
    const lead = await Lead.create({
      contactName: "Ad Lead",
      contactPhone: "919876543210",
      attribution: {
        channel: "whatsapp",
        sourceType: "ad",
        sourceId: "120212345678901234",
        ctwaClid: "AfeXYZ",
        headline: "Bali from ₹49,999",
        capturedAt: new Date("2026-09-20T00:00:00Z"),
        unknownField: "dropped",
      } as any,
    });
    const doc = await storedDoc(lead._id as mongoose.Types.ObjectId);
    expect(doc.attribution).toEqual({
      ...EMPTY_ATTRIBUTION,
      channel: "whatsapp",
      sourceType: "ad",
      sourceId: "120212345678901234",
      ctwaClid: "AfeXYZ",
      headline: "Bali from ₹49,999",
      capturedAt: new Date("2026-09-20T00:00:00Z"),
    });
    expect(doc.attribution).not.toHaveProperty("unknownField");
  });

  it("declares no index on attribution", async () => {
    const indexes = await Lead.collection.indexes();
    expect(indexes.some((i) => Object.keys(i.key).some((k) => k.startsWith("attribution")))).toBe(false);
  });
});
