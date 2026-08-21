// apps/backend/src/models/visaDocument.encryption.test.ts
//
// STAGE 2 PROOF — VisaDocument.extractedFields is encrypted at rest, under
// the RIGHT subject, and the erasure cascade shreds that subject's key.
//
// Real mongod (MongoMemoryServer), real models. "What is at rest" is always
// read through the raw driver, bypassing Mongoose and therefore the plugin.
//
// The subject rule under test is two-branch and easy to get wrong:
//   B2B — VisaApplication.travellerProfileId -> TRAVELLER_PROFILE
//   D2C — travellerProfileId is null by design (routes/consumer.applications.ts),
//         consumerId is set -> CONSUMER, the SAME key their ConsumerProfile uses.
// Encrypting a consumer's extracted passport under a traveller key nobody
// will ever shred is precisely the failure this file exists to catch.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-document-enc-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: VisaDocument, subjectFromApplication } = await import("./VisaDocument.js");
const { default: SubjectKey } = await import("./SubjectKey.js");
const { isEncryptedEnvelope } = await import("../security/fieldCrypto.js");
const { getPiiReadReport, EncryptedFieldUpdateError, SubjectUnresolvedError } = await import(
  "../plugins/fieldEncryption.plugin.js"
);
const { clearSubjectKeyCache, getSubjectDek } = await import("../security/subjectKeys.js");
const { destroyErasureSubjectKey } = await import("../scripts/lib/visaErasureCascade.js");

let mongod: MongoMemoryServer;
const raw = () => mongoose.connection.collection("visadocuments");
const newId = () => new mongoose.Types.ObjectId();

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
  await Promise.all([VisaDocument.deleteMany({}), SubjectKey.deleteMany({})]);
});

/** The MRZ shape services/visaPassportExtraction.ts actually stores. */
const MRZ = [
  { key: "documentType", value: "P" },
  { key: "issuingState", value: "IND" },
  { key: "surname", value: "ALPHA" },
  { key: "givenNames", value: "AISHA" },
  { key: "documentNumber", value: "M1234567" },
  { key: "nationality", value: "IND" },
  { key: "dateOfBirth", value: "1988-04-17" },
  { key: "sex", value: "F" },
  { key: "check_documentNumber", value: "passed" },
];

async function makeDocument(subject: { subjectType: string; subjectId: any } | null, extra: any = {}) {
  return VisaDocument.create({
    workspaceId: newId(),
    applicationId: newId(),
    docCode: "DOC-01",
    s3Key: "visa-applications/x/y/z.jpg",
    originalFilename: "passport.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    uploadedByUserId: newId(),
    extractionStatus: "COMPLETED",
    extractedFields: MRZ,
    subjectType: subject?.subjectType ?? null,
    subjectId: subject?.subjectId ?? null,
    ...extra,
  } as any);
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. THE SUBJECT RULE
 * ══════════════════════════════════════════════════════════════════════ */

describe("subjectFromApplication", () => {
  it("prefers the TravellerProfile (B2B)", () => {
    const travellerProfileId = newId();
    expect(subjectFromApplication({ travellerProfileId, consumerId: newId() })).toEqual({
      subjectType: "TRAVELLER_PROFILE",
      subjectId: travellerProfileId,
    });
  });

  it("falls back to the Consumer when there is no TravellerProfile (D2C)", () => {
    const consumerId = newId();
    expect(subjectFromApplication({ travellerProfileId: null, consumerId })).toEqual({
      subjectType: "CONSUMER",
      subjectId: consumerId,
    });
  });

  it("returns null rather than guessing when the application can name neither", () => {
    expect(subjectFromApplication({ travellerProfileId: null, consumerId: null })).toBeNull();
    expect(subjectFromApplication(null)).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 2. AT REST
 * ══════════════════════════════════════════════════════════════════════ */

describe("extractedFields at rest", () => {
  it("stores every value as an envelope, keeps every key in the clear", async () => {
    const travellerProfileId = newId();
    const doc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: travellerProfileId });

    const stored: any = await raw().findOne({ _id: doc._id });
    expect(stored.extractedFields).toHaveLength(MRZ.length);
    for (const field of stored.extractedFields) {
      expect(isEncryptedEnvelope(field.value), `${field.key} not encrypted`).toBe(true);
    }
    // Keys stay readable — they are what every consumer of this array filters on.
    expect(stored.extractedFields.map((f: any) => f.key)).toEqual(MRZ.map((f) => f.key));
    expect(JSON.stringify(stored)).not.toContain("M1234567");
    expect(JSON.stringify(stored)).not.toContain("ALPHA");
  });

  it("decrypts on read, in order, with the report naming every path", async () => {
    const doc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: newId() });

    const read = await VisaDocument.findById(doc._id);
    expect((read as any).extractedFields.map((f: any) => ({ key: f.key, value: f.value }))).toEqual(MRZ);
    expect(getPiiReadReport(read)!.decrypted).toHaveLength(MRZ.length);
  });

  it("keys a B2B document to the TravellerProfile", async () => {
    const travellerProfileId = newId();
    await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: travellerProfileId });

    const keys = await SubjectKey.find({}).lean();
    expect(keys).toHaveLength(1);
    expect(keys[0].subjectType).toBe("TRAVELLER_PROFILE");
    expect(String(keys[0].subjectId)).toBe(String(travellerProfileId));
  });

  it("keys a D2C document to the CONSUMER — the same key their ConsumerProfile uses", async () => {
    const consumerId = newId();
    await makeDocument({ subjectType: "CONSUMER", subjectId: consumerId });

    const keys = await SubjectKey.find({}).lean();
    expect(keys).toHaveLength(1);
    expect(keys[0].subjectType).toBe("CONSUMER");
    expect(String(keys[0].subjectId)).toBe(String(consumerId));

    // ONE key for that consumer, shared with their profile — a second
    // document for the same consumer must not mint a second key.
    await makeDocument({ subjectType: "CONSUMER", subjectId: consumerId });
    expect(await SubjectKey.countDocuments({})).toBe(1);
  });

  it("is randomized — the same MRZ on two documents does not look the same at rest", async () => {
    const subjectId = newId();
    const one = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId });
    const two = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId });

    const [a, b] = await Promise.all([raw().findOne({ _id: one._id }), raw().findOne({ _id: two._id })]);
    expect((a as any).extractedFields[4].value).not.toBe((b as any).extractedFields[4].value);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 3. THE CONVERTED WRITE — markFailed
 * ══════════════════════════════════════════════════════════════════════ */

describe("markFailed's write shape", () => {
  it("REJECTS the old findByIdAndUpdate $set — this is why it had to be converted", async () => {
    const doc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: newId() });

    await expect(
      VisaDocument.findByIdAndUpdate(doc._id, {
        $set: {
          extractionStatus: "FAILED",
          extractedFields: [{ key: "failureCategory", value: "SERVICE_ERROR" }],
        },
      }),
    ).rejects.toThrow(EncryptedFieldUpdateError);

    // Nothing was written in the clear by the rejected call.
    const stored: any = await raw().findOne({ _id: doc._id });
    expect(JSON.stringify(stored)).not.toContain("SERVICE_ERROR");
  });

  it("accepts the converted load-and-save, and encrypts the diagnostics too", async () => {
    const doc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: newId() });

    // Exactly the shape services/visaPassportExtraction.ts's markFailed now uses.
    const loaded: any = await VisaDocument.findById(doc._id);
    loaded.extractionStatus = "FAILED";
    loaded.extractedFields = [
      { key: "failureCategory", value: "SERVICE_ERROR" },
      { key: "error", value: "Gemini call timed out" },
    ];
    await loaded.save();

    const stored: any = await raw().findOne({ _id: doc._id });
    expect(stored.extractionStatus).toBe("FAILED");
    expect(stored.extractedFields).toHaveLength(2);
    expect(stored.extractedFields.every((f: any) => isEncryptedEnvelope(f.value))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("SERVICE_ERROR");

    const read: any = await VisaDocument.findById(doc._id);
    expect(read.extractedFields.map((f: any) => f.value)).toEqual([
      "SERVICE_ERROR",
      "Gemini call timed out",
    ]);
  });

  it("still allows the review/soft-delete updates, which touch no encrypted path", async () => {
    const doc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: newId() });

    // routes/admin.visa.ts's document review.
    const reviewed: any = await VisaDocument.findOneAndUpdate(
      { _id: doc._id, deletedAt: null },
      { $set: { reviewStatus: "VERIFIED", reviewedAt: new Date() }, $unset: { rejectionReason: "" } },
      { new: true },
    );
    expect(reviewed.reviewStatus).toBe("VERIFIED");
    // ...and the returned document came back decrypted, not as envelopes.
    expect(reviewed.extractedFields[4].value).toBe("M1234567");

    // routes/visa.ts's soft delete.
    await expect(
      VisaDocument.findOneAndUpdate({ _id: doc._id }, { $set: { deletedAt: new Date() } }, { new: true }),
    ).resolves.toBeTruthy();
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. DUAL READ + PROJECTIONS
 * ══════════════════════════════════════════════════════════════════════ */

describe("dual read and projections", () => {
  /** A document exactly as it looked before encryption: plaintext, no subject. */
  async function insertLegacyDocument() {
    const _id = newId();
    await raw().insertOne({
      _id,
      workspaceId: newId(),
      applicationId: newId(),
      docCode: "DOC-01",
      s3Key: "legacy/key.jpg",
      originalFilename: "passport.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 100,
      uploadedByUserId: newId(),
      version: 1,
      extractionStatus: "COMPLETED",
      extractedFields: MRZ,
      reviewStatus: "PENDING",
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return _id;
  }

  it("reads a legacy plaintext document with NO subject stamped, and mints no key", async () => {
    const _id = await insertLegacyDocument();

    const read: any = await VisaDocument.findById(_id);
    expect(read.extractedFields.map((f: any) => f.value)).toEqual(MRZ.map((f) => f.value));
    expect(read.subjectType).toBeNull();
    expect(getPiiReadReport(read)!.legacy).toHaveLength(MRZ.length);
    expect(await SubjectKey.countDocuments({})).toBe(0);
  });

  it("converts a legacy document once a subject is stamped and it is saved — the self-heal", async () => {
    const _id = await insertLegacyDocument();
    const subjectId = newId();

    // What services/visaPassportExtraction.ts now does before its first save.
    const doc: any = await VisaDocument.findById(_id);
    const subject = subjectFromApplication({ travellerProfileId: subjectId });
    doc.subjectType = subject!.subjectType;
    doc.subjectId = subject!.subjectId;
    doc.extractionStatus = "PROCESSING";
    await doc.save();

    const stored: any = await raw().findOne({ _id });
    expect(stored.extractedFields.every((f: any) => isEncryptedEnvelope(f.value))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("M1234567");
    expect(getPiiReadReport(await VisaDocument.findById(_id))!.legacy).toEqual([]);
  });

  it("the FIXED projections carry the subject fields and decrypt", async () => {
    const doc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: newId() });

    // routes/workspace.travellers.ts's dossier read, as patched.
    const dossier: any = await VisaDocument.find({ _id: doc._id })
      .select("extractedFields extractionStatus extractionConfidence createdAt applicationId subjectType subjectId")
      .lean();
    expect(dossier[0].extractedFields[4].value).toBe("M1234567");

    // scripts/rerun-visa-passport-extraction.ts's verification read, as patched.
    const rerun: any = await VisaDocument.findById(doc._id)
      .select("extractionStatus extractionConfidence extractedFields subjectType subjectId")
      .lean();
    expect(rerun.extractedFields[2].value).toBe("ALPHA");
  });

  it("a projection that keeps extractedFields but DROPS the subject fails loud", async () => {
    const doc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: newId() });

    await expect(
      VisaDocument.findById(doc._id).select("extractedFields extractionStatus"),
    ).rejects.toThrow(SubjectUnresolvedError);
  });

  it("a projection that drops extractedFields ENTIRELY is unaffected", async () => {
    const doc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: newId() });

    // The six safe projections in the codebase all have this shape.
    await expect(VisaDocument.findById(doc._id).select("_id s3Key").lean()).resolves.toBeTruthy();
    await expect(VisaDocument.find({}).select("applicationId docCode").lean()).resolves.toHaveLength(1);
    await expect(VisaDocument.distinct("applicationId")).resolves.toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 5. THE ERASURE CASCADE
 * ══════════════════════════════════════════════════════════════════════ */

describe("destroyErasureSubjectKey — the key dies last", () => {
  it("shreds the traveller's key and reports 1 for the erasure log", async () => {
    const travellerProfileId = newId();
    await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: travellerProfileId });

    const count = await destroyErasureSubjectKey(
      "TRAVELLER_PROFILE",
      travellerProfileId,
      "ops@plumtrips.com",
      "erasure request",
    );
    expect(count).toBe(1);

    const row: any = await SubjectKey.findOne({ subjectId: travellerProfileId }).lean();
    expect(row.wrappedDek).toBeNull();
    expect(row.destroyedAt).toBeInstanceOf(Date);
    expect(row.destroyedByEmail).toBe("ops@plumtrips.com");
    expect(row.destroyReason).toBe("erasure request");
  });

  it("is idempotent — a re-run reports 0 and does not fail", async () => {
    const travellerProfileId = newId();
    await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: travellerProfileId });

    expect(await destroyErasureSubjectKey("TRAVELLER_PROFILE", travellerProfileId, "a@b.c", "r")).toBe(1);
    expect(await destroyErasureSubjectKey("TRAVELLER_PROFILE", travellerProfileId, "a@b.c", "r")).toBe(0);
  });

  it("reports 0 for a subject that never encrypted anything", async () => {
    expect(await destroyErasureSubjectKey("TRAVELLER_PROFILE", newId(), "a@b.c", "r")).toBe(0);
  });

  it("makes a surviving document's fields unreadable, and leaves a bystander alone", async () => {
    // The realistic residue case: the cascade deletes this traveller's own
    // documents, but a row that escaped it (or a copy elsewhere) must still
    // be unreadable after the shred.
    const victim = newId();
    const bystander = newId();
    const victimDoc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: victim });
    const bystanderDoc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: bystander });

    await destroyErasureSubjectKey("TRAVELLER_PROFILE", victim, "ops@plumtrips.com", "erasure");

    const shredded: any = await VisaDocument.findById(victimDoc._id);
    expect(shredded.extractedFields.every((f: any) => f.value === null)).toBe(true);
    expect(getPiiReadReport(shredded)!.shredded).toHaveLength(MRZ.length);

    const untouched: any = await VisaDocument.findById(bystanderDoc._id);
    expect(untouched.extractedFields[4].value).toBe("M1234567");
  });

  it("evicts the in-process cache, so the shred is immediate", async () => {
    const victim = newId();
    const doc = await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: victim });

    // Warm the cache with a real read.
    expect(((await VisaDocument.findById(doc._id)) as any).extractedFields[4].value).toBe("M1234567");
    expect((await getSubjectDek("TRAVELLER_PROFILE", victim)).status).toBe("active");

    await destroyErasureSubjectKey("TRAVELLER_PROFILE", victim, "ops@plumtrips.com", "erasure");

    // NO clearSubjectKeyCache() anywhere in this test.
    expect((await getSubjectDek("TRAVELLER_PROFILE", victim)).status).toBe("destroyed");
    expect(((await VisaDocument.findById(doc._id)) as any).extractedFields[4].value).toBeNull();
  });

  it("refuses to write new PII for a shredded subject", async () => {
    const victim = newId();
    await makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: victim });
    await destroyErasureSubjectKey("TRAVELLER_PROFILE", victim, "ops@plumtrips.com", "erasure");

    await expect(makeDocument({ subjectType: "TRAVELLER_PROFILE", subjectId: victim })).rejects.toThrow(
      /crypto-shredded/,
    );
  });
});
