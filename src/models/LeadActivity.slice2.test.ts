// Slice 2 — LeadActivity generalized IN PLACE: subject{type,id} with a
// backfill-on-READ alias from leadId, `demo` type, and the invariant that no
// history row is ever rewritten (risk M1/M11). Real collection, raw inserts
// for the legacy shape so Mongoose defaults cannot mask what is on disk.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leadactivity-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: LeadActivity, activitySubject, ACTIVITY_TYPES } = await import("./LeadActivity.js");
const { default: Lead, effectiveLeadStatus } = await import("./Lead.js");
const { CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

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
  await Promise.all([LeadActivity.deleteMany({}), Lead.deleteMany({})]);
});
afterEach(() => {
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
});

/** A row exactly as prod wrote it before Slice 2: leadId, no subject. */
async function insertLegacyActivity(leadId: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) {
  const res = await LeadActivity.collection.insertOne({
    leadId,
    type: "stage_change",
    note: "Stage changed from contacted to demo_scheduled",
    fromStage: "contacted",
    toStage: "demo_scheduled",
    createdBy: new mongoose.Types.ObjectId(),
    createdByName: "Rep",
    createdAt: new Date("2025-11-03T09:00:00Z"),
    ...extra,
  });
  return res.insertedId;
}

describe("backfill-on-read alias", () => {
  it("a legacy row hydrates with subject {LEAD, leadId} in memory only — nothing written", async () => {
    const leadId = new mongoose.Types.ObjectId();
    const id = await insertLegacyActivity(leadId);

    const doc = await LeadActivity.findById(id);
    expect(doc!.subject?.type).toBe("LEAD");
    expect(String(doc!.subject?.id)).toBe(String(leadId));
    expect(doc!.isModified("subject")).toBe(false);

    // Even an (accidental) save of the hydrated history row writes no subject.
    await doc!.save();
    const raw = await LeadActivity.collection.findOne({ _id: id });
    expect(raw).not.toHaveProperty("subject");
    expect(raw!.toStage).toBe("demo_scheduled"); // legacy vocabulary untouched
  });

  it("activitySubject() aliases lean rows and aggregation output", async () => {
    const leadId = new mongoose.Types.ObjectId();
    const id = await insertLegacyActivity(leadId);
    const lean = await LeadActivity.findById(id).lean();
    expect(lean).not.toHaveProperty("subject");
    expect(activitySubject(lean as any)).toEqual({ type: "LEAD", id: leadId });

    const oppId = new mongoose.Types.ObjectId();
    expect(activitySubject({ subject: { type: "OPPORTUNITY", id: oppId }, leadId })).toEqual({ type: "OPPORTUNITY", id: oppId });
    expect(activitySubject({})).toBeNull();
  });
});

describe("validation", () => {
  it("requires leadId or subject.id", async () => {
    await expect(LeadActivity.create({ type: "note", note: "orphan" })).rejects.toThrow(/leadId or subject\.id/);
  });

  it("a LEAD-subject row backfills leadId so leadId-keyed consumers keep working", async () => {
    const leadId = new mongoose.Types.ObjectId();
    const a = await LeadActivity.create({ subject: { type: "LEAD", id: leadId }, type: "note", note: "x" });
    expect(String(a.leadId)).toBe(String(leadId));
    expect(await LeadActivity.countDocuments({ leadId })).toBe(1);
  });

  it("an OPPORTUNITY-subject row keeps the source leadId so it shows on the lead timeline", async () => {
    const leadId = new mongoose.Types.ObjectId();
    const oppId = new mongoose.Types.ObjectId();
    await LeadActivity.create({
      leadId,
      subject: { type: "OPPORTUNITY", id: oppId },
      type: "stage_change",
      fromStage: "",
      toStage: "proposal",
      automatedByRule: "migration-x",
    });
    const onLead = await LeadActivity.find({ leadId }).lean();
    expect(onLead).toHaveLength(1);
    expect((onLead[0] as any).subject.type).toBe("OPPORTUNITY");
    const byOpp = await LeadActivity.find({ "subject.type": "OPPORTUNITY", "subject.id": oppId }).lean();
    expect(byOpp).toHaveLength(1);
  });

  it("`demo` is a valid type and `meeting` still is", async () => {
    expect(ACTIVITY_TYPES).toContain("demo");
    expect(ACTIVITY_TYPES).toContain("meeting");
    const leadId = new mongoose.Types.ObjectId();
    await LeadActivity.create({ leadId, type: "demo", note: "Demo held" });
    await expect(LeadActivity.create({ leadId, type: "webinar" })).rejects.toThrow(/type/);
  });
});

describe("Lead status coherence hook (CRM_V2_OPPORTUNITY)", () => {
  const base = { contactName: "Priya", contactPhone: "9999999999", companyName: "Acme" };

  it("flag OFF: saving never touches status / sourceChannel (byte-for-byte legacy)", async () => {
    const l = await Lead.create({ ...base, stage: "proposal_sent", source: "linkedin" });
    const raw = await Lead.collection.findOne({ _id: l._id });
    expect(raw!.status).toBeNull();
    expect(raw!.sourceChannel).toBe("");
    // but the effective status is still derivable for any reader
    expect(effectiveLeadStatus(raw as any)).toBe("CONVERTED");
  });

  it("flag ON: a legacy stage write derives status and copies source → sourceChannel", async () => {
    process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
    const l = await Lead.create({ ...base, stage: "demo_scheduled", source: "linkedin" });
    expect(l.status).toBe("ENGAGED");
    expect(l.sourceChannel).toBe("linkedin");
    l.stage = "won";
    await l.save();
    expect(l.status).toBe("CONVERTED");
    expect(l.stage).toBe("won"); // legacy column kept for the frontend
  });

  it("flag ON: a status write derives the mildest legacy stage", async () => {
    process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
    const l = await Lead.create({ ...base, stage: "new" });
    l.status = "ENGAGED";
    await l.save();
    expect(l.stage).toBe("demo_scheduled");
  });

  it("flag ON: a pre-Slice-2 row (status null) gets status on its next save without changing stage", async () => {
    const res = await Lead.collection.insertOne({
      ...base, stage: "negotiation", source: "manual", type: "company", dealValue: 0, currency: "INR",
      createdAt: new Date(), updatedAt: new Date(),
    });
    process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
    const l = await Lead.findById(res.insertedId);
    expect(effectiveLeadStatus(l as any)).toBe("CONVERTED");
    l!.notes = "touched";
    await l!.save();
    const raw = await Lead.collection.findOne({ _id: res.insertedId });
    expect(raw!.status).toBe("CONVERTED");
    expect(raw!.stage).toBe("negotiation");
  });
});
