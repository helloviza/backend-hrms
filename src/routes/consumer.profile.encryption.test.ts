// apps/backend/src/routes/consumer.profile.encryption.test.ts
//
// ══════════════════════════════════════════════════════════════════════
// STAGE 2 PROOF — ConsumerProfile PII is encrypted at rest.
//
// Sibling to consumer.profile.test.ts (the isolation gate), and built the
// same way: real router, real requireConsumer, real tokens, real Mongo. The
// difference is what it asserts. The isolation suite proves consumer A
// cannot REACH consumer B's passport number; this one proves that a person
// holding the database file cannot read ANYBODY's.
//
// Every "what is at rest" assertion reads the raw collection through the
// driver, bypassing Mongoose and therefore bypassing the plugin. Reading
// back through the model would prove the round trip and nothing about the
// bytes on disk — which is the entire claim.
// ══════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const B2B_SECRET = "b2b-jwt-secret-for-tests";
const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;
process.env.NODE_ENV = "test";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-profile-enc-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

const { default: Consumer } = await import("../models/Consumer.js");
const { default: ConsumerProfile, ENCRYPTED_PII_FIELDS } = await import(
  "../models/ConsumerProfile.js"
);
const { default: SubjectKey } = await import("../models/SubjectKey.js");
const { default: consumerProfileRouter } = await import("./consumer.profile.js");
const { signConsumerAccessToken } = await import("../utils/consumerJwt.js");
const { isEncryptedEnvelope } = await import("../security/fieldCrypto.js");
const { getPiiReadReport, EncryptedFieldUpdateError } = await import(
  "../plugins/fieldEncryption.plugin.js"
);
const { clearSubjectKeyCache, destroySubjectDek } = await import("../security/subjectKeys.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/consumer/profile", consumerProfileRouter);

let mongod: MongoMemoryServer;
const raw = () => mongoose.connection.collection("consumerprofiles");

async function makeConsumer(email: string, name: string) {
  const consumer = await Consumer.create({ email, name, passwordHash: "not-used" });
  const token = signConsumerAccessToken({
    consumerId: String(consumer._id),
    tokenVersion: (consumer as any).tokenVersion,
  });
  return { consumer, auth: `Bearer ${token}` };
}

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
  await Promise.all([
    Consumer.deleteMany({}),
    ConsumerProfile.deleteMany({}),
    SubjectKey.deleteMany({}),
  ]);
});

/** Every PII value this suite writes, so one assertion can hunt for all of them. */
const SECRETS = {
  dateOfBirth: "1988-04-17",
  mobile: "+919812345678",
  alternateEmail: "aisha.private@example.com",
  line1: "42 Turing Lane",
  line2: "Flat 9B",
  city: "Bengaluru",
  postalCode: "560095",
  permLine1: "7 Hopper Street",
  permLine2: "Block C",
  permCity: "Kochi",
  permPostalCode: "682016",
  passportNumber: "M1234567",
  coTravellerDob: "2011-09-02",
  coTravellerPassport: "N7654321",
};

/** Fill all 14 encrypted paths through the REAL routes, nothing else. */
async function fillEveryPiiField(auth: string) {
  await request(app)
    .patch("/api/consumer/profile/personal")
    .set("Authorization", auth)
    .send({ firstName: "Aisha", lastName: "Alpha", dateOfBirth: SECRETS.dateOfBirth })
    .expect(200);

  await request(app)
    .patch("/api/consumer/profile/contact")
    .set("Authorization", auth)
    .send({
      mobile: SECRETS.mobile,
      alternateEmail: SECRETS.alternateEmail,
      currentAddress: {
        line1: SECRETS.line1,
        line2: SECRETS.line2,
        city: SECRETS.city,
        state: "Karnataka",
        postalCode: SECRETS.postalCode,
        country: "India",
      },
      permanentAddress: {
        line1: SECRETS.permLine1,
        line2: SECRETS.permLine2,
        city: SECRETS.permCity,
        state: "Kerala",
        postalCode: SECRETS.permPostalCode,
        country: "India",
      },
    })
    .expect(200);

  await request(app)
    .post("/api/consumer/profile/passports")
    .set("Authorization", auth)
    .send({ number: SECRETS.passportNumber, issuingCountry: "India", expiryDate: "2031-01-31" })
    .expect(201);

  await request(app)
    .post("/api/consumer/profile/co-travellers")
    .set("Authorization", auth)
    .send({
      fullName: "Rohan Alpha",
      relationship: "Son",
      dateOfBirth: SECRETS.coTravellerDob,
      passportNumber: SECRETS.coTravellerPassport,
      nationality: "Indian",
    })
    .expect(201);
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. AT REST
 * ══════════════════════════════════════════════════════════════════════ */

describe("every marked PII field is ciphertext on disk", () => {
  it("writes all 14 encrypted paths as envelopes, with no plaintext anywhere in the row", async () => {
    const a = await makeConsumer("enc-a@helloviza.test", "Consumer A");
    await fillEveryPiiField(a.auth);

    const stored: any = await raw().findOne({ consumerId: a.consumer._id });
    const asText = JSON.stringify(stored);

    // Not one of the secrets survives in the clear, anywhere in the document.
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(asText, `plaintext "${value}" (${name}) found at rest`).not.toContain(value);
    }

    // And each declared path individually holds an envelope.
    expect(isEncryptedEnvelope(stored.personal.dateOfBirth)).toBe(true);
    expect(isEncryptedEnvelope(stored.contact.mobile)).toBe(true);
    expect(isEncryptedEnvelope(stored.contact.alternateEmail)).toBe(true);
    for (const field of ["line1", "line2", "city", "postalCode"]) {
      expect(isEncryptedEnvelope(stored.contact.currentAddress[field]), `currentAddress.${field}`).toBe(true);
      expect(isEncryptedEnvelope(stored.contact.permanentAddress[field]), `permanentAddress.${field}`).toBe(true);
    }
    expect(isEncryptedEnvelope(stored.passports[0].number)).toBe(true);
    expect(isEncryptedEnvelope(stored.coTravellers[0].dateOfBirth)).toBe(true);
    expect(isEncryptedEnvelope(stored.coTravellers[0].passportNumber)).toBe(true);

    // The declared list and what is actually encrypted agree.
    expect(ENCRYPTED_PII_FIELDS).toHaveLength(14);
  });

  it("leaves the NON-PII fields alone — this is field encryption, not blob encryption", async () => {
    const a = await makeConsumer("enc-b@helloviza.test", "Consumer B");
    await fillEveryPiiField(a.auth);

    const stored: any = await raw().findOne({ consumerId: a.consumer._id });
    expect(stored.personal.firstName).toBe("Aisha");
    expect(stored.contact.currentAddress.state).toBe("Karnataka");
    expect(stored.contact.currentAddress.country).toBe("India");
    expect(stored.passports[0].issuingCountry).toBe("India");
    expect(stored.passports[0].expiryDate).toBeInstanceOf(Date); // NOT encrypted — drives the <6-month warning
    expect(stored.coTravellers[0].fullName).toBe("Rohan Alpha");
  });

  it("mints exactly one SubjectKey for the consumer, keyed on consumerId", async () => {
    const a = await makeConsumer("enc-c@helloviza.test", "Consumer C");
    await fillEveryPiiField(a.auth);

    const keys = await SubjectKey.find({}).lean();
    expect(keys).toHaveLength(1);
    expect(keys[0].subjectType).toBe("CONSUMER");
    expect(String(keys[0].subjectId)).toBe(String(a.consumer._id));
    expect(keys[0].destroyedAt).toBeNull();
  });

  it("gives two consumers different keys — one database read cannot unlock both", async () => {
    const a = await makeConsumer("enc-d@helloviza.test", "Consumer D");
    const b = await makeConsumer("enc-e@helloviza.test", "Consumer E");
    await fillEveryPiiField(a.auth);
    await fillEveryPiiField(b.auth);

    expect(await SubjectKey.countDocuments({})).toBe(2);

    // Same passport number for both, different ciphertext: an attacker
    // cannot even tell the two rows hold the same value.
    const [rowA, rowB] = await Promise.all([
      raw().findOne({ consumerId: a.consumer._id }),
      raw().findOne({ consumerId: b.consumer._id }),
    ]);
    expect((rowA as any).passports[0].number).not.toBe((rowB as any).passports[0].number);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 2. THE API STILL WORKS
 * ══════════════════════════════════════════════════════════════════════ */

describe("the consumer reads their own data back intact", () => {
  it("returns every field through GET /, exactly as written", async () => {
    const a = await makeConsumer("enc-f@helloviza.test", "Consumer F");
    await fillEveryPiiField(a.auth);

    const res = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", a.auth)
      .expect(200);

    const p = res.body.profile;
    expect(p.personal.dateOfBirth).toContain("1988-04-17"); // Date -> ISO on the wire, unchanged
    expect(p.contact.mobile).toBe(SECRETS.mobile);
    expect(p.contact.alternateEmail).toBe(SECRETS.alternateEmail);
    expect(p.contact.currentAddress.line1).toBe(SECRETS.line1);
    expect(p.contact.currentAddress.postalCode).toBe(SECRETS.postalCode);
    expect(p.contact.permanentAddress.city).toBe(SECRETS.permCity);
    expect(p.passports[0].number).toBe(SECRETS.passportNumber);
    expect(p.coTravellers[0].passportNumber).toBe(SECRETS.coTravellerPassport);
    expect(p.coTravellers[0].dateOfBirth).toContain("2011-09-02");
  });

  it("keeps the Date TYPE, not just the value — Mixed did not turn it into a string", async () => {
    const a = await makeConsumer("enc-g@helloviza.test", "Consumer G");
    await fillEveryPiiField(a.auth);

    const doc: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id });
    expect(doc.personal.dateOfBirth).toBeInstanceOf(Date);
    expect(doc.coTravellers[0].dateOfBirth).toBeInstanceOf(Date);
    expect((doc.personal.dateOfBirth as Date).toISOString()).toContain("1988-04-17");
  });

  it("preserves the normalising setters — uppercase passport, lowercase email (TRAP 1)", async () => {
    const a = await makeConsumer("enc-h@helloviza.test", "Consumer H");

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", a.auth)
      .send({ alternateEmail: "  MiXeD.Case@Example.COM  " })
      .expect(200);
    await request(app)
      .post("/api/consumer/profile/passports")
      .set("Authorization", a.auth)
      .send({ number: "  m1234567  " })
      .expect(201);

    // Ciphertext at rest, NOT mangled by uppercase/lowercase...
    const stored: any = await raw().findOne({ consumerId: a.consumer._id });
    expect(stored.passports[0].number).toMatch(/^penc\.1\./);
    expect(stored.contact.alternateEmail).toMatch(/^penc\.1\./);

    // ...and the normalisation the schema promises still happened.
    const doc: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id });
    expect(doc.passports[0].number).toBe("M1234567");
    expect(doc.contact.alternateEmail).toBe("mixed.case@example.com");
  });

  it("decrypts .lean() reads as well as hydrated ones", async () => {
    const a = await makeConsumer("enc-i@helloviza.test", "Consumer I");
    await fillEveryPiiField(a.auth);

    const lean: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id }).lean();
    expect(lean.passports[0].number).toBe(SECRETS.passportNumber);
    expect(lean.personal.dateOfBirth).toBeInstanceOf(Date);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 3. DUAL READ — rows written before encryption was switched on
 * ══════════════════════════════════════════════════════════════════════ */

describe("dual read — nothing has been backfilled, and legacy rows still work", () => {
  /** A row exactly as it looked before this change: plaintext, real Dates, no key. */
  async function insertLegacyRow(consumerId: mongoose.Types.ObjectId) {
    await raw().insertOne({
      consumerId,
      workspaceId: new mongoose.Types.ObjectId(),
      personal: { firstName: "Legacy", dateOfBirth: new Date("1979-11-05T00:00:00.000Z") },
      contact: {
        mobile: "+919800000000",
        alternateEmail: "legacy@example.com",
        currentAddress: { line1: "1 Old Road", city: "Chennai", postalCode: "600001" },
        permanentAddress: {},
      },
      passports: [{ _id: new mongoose.Types.ObjectId(), number: "L9999999", isPrimary: true }],
      coTravellers: [],
      travel: {},
      travelPreferences: {},
      accountPrefs: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("reads a fully legacy row back untouched, and mints no key doing it", async () => {
    const a = await makeConsumer("legacy-a@helloviza.test", "Legacy A");
    await insertLegacyRow(a.consumer._id as any);

    const res = await request(app)
      .get("/api/consumer/profile")
      .set("Authorization", a.auth)
      .expect(200);

    expect(res.body.profile.contact.mobile).toBe("+919800000000");
    expect(res.body.profile.passports[0].number).toBe("L9999999");
    expect(res.body.profile.personal.dateOfBirth).toContain("1979-11-05");

    // A READ never creates a key — that would quietly re-key an erased subject.
    expect(await SubjectKey.countDocuments({})).toBe(0);
  });

  it("reports legacy paths rather than pretending the row is migrated", async () => {
    const a = await makeConsumer("legacy-b@helloviza.test", "Legacy B");
    await insertLegacyRow(a.consumer._id as any);

    const doc = await ConsumerProfile.findOne({ consumerId: a.consumer._id });
    const report = getPiiReadReport(doc)!;
    expect(report.decrypted).toEqual([]);
    expect(report.legacy).toContain("passports.0.number");
    expect(report.legacy).toContain("personal.dateOfBirth");
    expect(report.legacy).toContain("contact.mobile");
  });

  it("converts a legacy row on its NEXT save, without a backfill", async () => {
    const a = await makeConsumer("legacy-c@helloviza.test", "Legacy C");
    await insertLegacyRow(a.consumer._id as any);

    // An ordinary edit to an UNRELATED field.
    await request(app)
      .patch("/api/consumer/profile/personal")
      .set("Authorization", a.auth)
      .send({ firstName: "Converted" })
      .expect(200);

    const stored: any = await raw().findOne({ consumerId: a.consumer._id });
    expect(isEncryptedEnvelope(stored.passports[0].number)).toBe(true);
    expect(isEncryptedEnvelope(stored.contact.mobile)).toBe(true);
    expect(isEncryptedEnvelope(stored.personal.dateOfBirth)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("L9999999");

    const after = await ConsumerProfile.findOne({ consumerId: a.consumer._id });
    expect(getPiiReadReport(after)!.legacy).toEqual([]);
    expect((after as any).passports[0].number).toBe("L9999999");
  });

  it("reads a HALF-migrated row — the mixed state is supported, not a broken migration", async () => {
    const a = await makeConsumer("legacy-d@helloviza.test", "Legacy D");
    await insertLegacyRow(a.consumer._id as any);

    // Encrypt only the contact section, leaving passports/personal legacy.
    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", a.auth)
      .send({ mobile: "+919811111111" })
      .expect(200);

    // Put the passport back to plaintext behind the plugin's back, so the row
    // genuinely holds one encrypted and one legacy value at the same time.
    await raw().updateOne(
      { consumerId: a.consumer._id },
      { $set: { "passports.0.number": "L9999999" } },
    );
    clearSubjectKeyCache();

    const doc = await ConsumerProfile.findOne({ consumerId: a.consumer._id });
    expect((doc as any).contact.mobile).toBe("+919811111111");
    expect((doc as any).passports[0].number).toBe("L9999999");

    const report = getPiiReadReport(doc)!;
    expect(report.decrypted).toContain("contact.mobile");
    expect(report.legacy).toContain("passports.0.number");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. THE WRITES THE AUDIT FLAGGED
 * ══════════════════════════════════════════════════════════════════════ */

describe("the three flagged writes", () => {
  it("loadOwnProfile's upsert is NOT rejected — it touches no encrypted path", async () => {
    const a = await makeConsumer("write-a@helloviza.test", "Writer A");

    // GET / goes through loadOwnProfile's findOneAndUpdate + $setOnInsert.
    await request(app).get("/api/consumer/profile").set("Authorization", a.auth).expect(200);
    expect(await ConsumerProfile.countDocuments({ consumerId: a.consumer._id })).toBe(1);

    // And it stays safe on the second call, which is an update, not an insert.
    await request(app).get("/api/consumer/profile").set("Authorization", a.auth).expect(200);
    expect(await ConsumerProfile.countDocuments({ consumerId: a.consumer._id })).toBe(1);
  });

  it("the arrayFilters $unset of a passport document reference is NOT rejected", async () => {
    const a = await makeConsumer("write-b@helloviza.test", "Writer B");
    await fillEveryPiiField(a.auth);

    const doc: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id });
    const passportId = doc.passports[0]._id;
    const docRef = new mongoose.Types.ObjectId();
    await raw().updateOne(
      { consumerId: a.consumer._id },
      { $set: { "passports.0.frontDocumentId": docRef } },
    );

    // This is the shape routes/consumer.profile.ts's DELETE /documents/:id uses.
    await expect(
      ConsumerProfile.updateOne(
        { consumerId: a.consumer._id },
        { $unset: { "passports.$[front].frontDocumentId": "" } },
        { arrayFilters: [{ "front.frontDocumentId": docRef }] },
      ),
    ).resolves.toBeTruthy();

    const after: any = await raw().findOne({ consumerId: a.consumer._id });
    expect(after.passports[0].frontDocumentId).toBeUndefined();
    // ...and the encrypted sibling in the same array element is untouched.
    expect(isEncryptedEnvelope(after.passports[0].number)).toBe(true);
    expect(String(passportId)).toBe(String(after.passports[0]._id));
  });

  it("a document REFERENCE is deliberately left unencrypted — it is a locator, not identity", async () => {
    const a = await makeConsumer("write-c@helloviza.test", "Writer C");
    await fillEveryPiiField(a.auth);

    const docRef = new mongoose.Types.ObjectId();
    const doc: any = await ConsumerProfile.findOne({ consumerId: a.consumer._id });
    doc.passports[0].frontDocumentId = docRef;
    await doc.save();

    const stored: any = await raw().findOne({ consumerId: a.consumer._id });
    expect(stored.passports[0].frontDocumentId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(stored.passports[0].frontDocumentId)).toBe(String(docRef));
  });

  it("REFUSES an arrayFilters update that WOULD hit an encrypted path", async () => {
    const a = await makeConsumer("write-d@helloviza.test", "Writer D");
    await fillEveryPiiField(a.auth);

    // The guard normalises $[x] / $ / numeric indices to `$` before matching,
    // so all three spellings of "an element of passports" are caught.
    await expect(
      ConsumerProfile.updateOne(
        { consumerId: a.consumer._id },
        { $set: { "passports.$[p].number": "P9999999" } },
        { arrayFilters: [{ "p.isPrimary": true }] },
      ),
    ).rejects.toThrow(EncryptedFieldUpdateError);

    await expect(
      ConsumerProfile.updateOne(
        { consumerId: a.consumer._id },
        { $set: { "passports.0.number": "P9999999" } },
      ),
    ).rejects.toThrow(EncryptedFieldUpdateError);

    await expect(
      ConsumerProfile.updateOne({ consumerId: a.consumer._id }, { $set: { "contact.mobile": "+910000000000" } }),
    ).rejects.toThrow(EncryptedFieldUpdateError);

    // Nothing was written by any of the three.
    const stored: any = await raw().findOne({ consumerId: a.consumer._id });
    expect(JSON.stringify(stored)).not.toContain("P9999999");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 5. CRYPTO-SHRED
 * ══════════════════════════════════════════════════════════════════════ */

describe("crypto-shredding a consumer", () => {
  it("makes their fields unreadable while another consumer reads normally", async () => {
    const victim = await makeConsumer("shred-a@helloviza.test", "Victim");
    const bystander = await makeConsumer("shred-b@helloviza.test", "Bystander");
    await fillEveryPiiField(victim.auth);
    await fillEveryPiiField(bystander.auth);

    await destroySubjectDek("CONSUMER", victim.consumer._id as any, {
      actorEmail: "ops@plumtrips.com",
      reason: "DPDP erasure request",
    });

    const shredded: any = await ConsumerProfile.findOne({ consumerId: victim.consumer._id });
    expect(shredded.passports[0].number).toBeNull();
    expect(shredded.contact.mobile).toBeNull();
    expect(shredded.personal.dateOfBirth).toBeNull();
    expect(getPiiReadReport(shredded)!.shredded).toContain("passports.0.number");

    const ok: any = await ConsumerProfile.findOne({ consumerId: bystander.consumer._id });
    expect(ok.passports[0].number).toBe(SECRETS.passportNumber);
    expect(ok.contact.mobile).toBe(SECRETS.mobile);
  });

  it("takes effect immediately — a cached key does not outlive the shred", async () => {
    const victim = await makeConsumer("shred-c@helloviza.test", "Victim C");
    await fillEveryPiiField(victim.auth);

    // Warm the TTL cache with a real read first.
    const warm: any = await ConsumerProfile.findOne({ consumerId: victim.consumer._id });
    expect(warm.passports[0].number).toBe(SECRETS.passportNumber);

    await destroySubjectDek("CONSUMER", victim.consumer._id as any, {
      actorEmail: "ops@plumtrips.com",
      reason: "immediate",
    });

    // NO clearSubjectKeyCache() — destroySubjectDek must have evicted it.
    const after: any = await ConsumerProfile.findOne({ consumerId: victim.consumer._id });
    expect(after.passports[0].number).toBeNull();
  });

  it("leaves the ciphertext on disk — shredded means unreadable, not silently blanked", async () => {
    const victim = await makeConsumer("shred-d@helloviza.test", "Victim D");
    await fillEveryPiiField(victim.auth);
    await destroySubjectDek("CONSUMER", victim.consumer._id as any, {
      actorEmail: "ops@plumtrips.com",
      reason: "r",
    });

    const stored: any = await raw().findOne({ consumerId: victim.consumer._id });
    expect(isEncryptedEnvelope(stored.passports[0].number)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(SECRETS.passportNumber);
  });
});
