// Proof for the field-encryption engine, IN ISOLATION.
//
// The schema below is a THROWAWAY defined in this file — collection
// `pii_plugin_probe`, model `PiiPluginProbe`. No real model is imported and
// no real collection is touched; ConsumerProfile and VisaDocument are
// untouched by Stage 1 and are not referenced here. The probe deliberately
// mirrors the two shapes that carry the traps: a String path with
// `uppercase: true` + `trim: true` (TRAP 1) and a date path declared Mixed
// (TRAP 2), plus an array path so `$` resolution is proven too.
//
// Every assertion that claims "this is what is in the database" reads the
// RAW collection through the driver, bypassing the plugin entirely — a test
// that read back through the plugin would prove the round trip and nothing
// about what is at rest.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "node:crypto";
import mongoose, { Schema } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const MASTER_KEY_A = crypto.randomBytes(32).toString("base64");
const MASTER_KEY_B = crypto.randomBytes(32).toString("base64");
process.env.PII_MASTER_KEY = MASTER_KEY_A;

const { default: SubjectKey } = await import("../models/SubjectKey.js");
const { destroySubjectDek, clearSubjectKeyCache, getOrCreateSubjectDek } = await import(
  "../security/subjectKeys.js"
);
const { encryptField, isEncryptedEnvelope } = await import("../security/fieldCrypto.js");
const {
  fieldEncryptionPlugin,
  getPiiReadReport,
  EncryptedFieldUpdateError,
  SubjectUnresolvedError,
  OrphanedCiphertextError,
} = await import("./fieldEncryption.plugin.js");

/* ── the throwaway probe schema ─────────────────────────────────────── */

const ProbePersonalSchema = new Schema(
  {
    firstName: { type: String, trim: true }, // NOT encrypted — the control
    // TRAP 1: normalising setters on an encrypted String path.
    passportNumber: { type: String, trim: true, uppercase: true },
    // TRAP 2: a Date field must be declared Mixed to hold either a real
    // Date (legacy row) or a ciphertext string (encrypted row).
    dateOfBirth: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const ProbeCoTravellerSchema = new Schema(
  { number: { type: String, trim: true, uppercase: true } },
  { _id: false },
);

const ProbeSchema = new Schema(
  {
    consumerId: { type: Schema.Types.ObjectId, required: true, index: true },
    personal: { type: ProbePersonalSchema, default: () => ({}) },
    passports: { type: [ProbeCoTravellerSchema], default: () => [] },
  },
  { timestamps: true, collection: "pii_plugin_probe" },
);

ProbeSchema.plugin(fieldEncryptionPlugin, {
  subject: (doc: any) => (doc?.consumerId ? { subjectType: "CONSUMER", subjectId: doc.consumerId } : null),
  fields: [
    { path: "personal.passportNumber" },
    { path: "personal.dateOfBirth", type: "date" },
    { path: "passports.$.number" },
  ],
});

const Probe = mongoose.model("PiiPluginProbe", ProbeSchema);

let mongod: MongoMemoryServer;
const raw = () => mongoose.connection.collection("pii_plugin_probe");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await SubjectKey.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  process.env.PII_MASTER_KEY = MASTER_KEY_A;
  clearSubjectKeyCache();
  await Promise.all([SubjectKey.deleteMany({}), Probe.deleteMany({})]);
});

const newId = () => new mongoose.Types.ObjectId();
const DOB = new Date("1988-04-17T00:00:00.000Z");

/* ── 1. round trip ──────────────────────────────────────────────────── */

describe("round trip", () => {
  it("stores ciphertext at rest and reads back the exact original — String AND Date", async () => {
    const consumerId = newId();
    const doc = await Probe.create({
      consumerId,
      personal: { firstName: "Asha", passportNumber: "M1234567", dateOfBirth: DOB },
    });

    // What is actually on disk.
    const stored = await raw().findOne({ _id: doc._id });
    expect(isEncryptedEnvelope(stored!.personal.passportNumber)).toBe(true);
    expect(isEncryptedEnvelope(stored!.personal.dateOfBirth)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("M1234567");
    expect(JSON.stringify(stored)).not.toContain("1988-04-17");
    expect(stored!.personal.firstName).toBe("Asha"); // the control: untouched

    // What a reader gets.
    const read = await Probe.findById(doc._id);
    expect(read!.personal.passportNumber).toBe("M1234567");
    expect(read!.personal.dateOfBirth).toBeInstanceOf(Date);
    expect((read!.personal.dateOfBirth as Date).getTime()).toBe(DOB.getTime());

    const report = getPiiReadReport(read);
    expect(report!.decrypted.sort()).toEqual(["personal.dateOfBirth", "personal.passportNumber"]);
    expect(report!.legacy).toEqual([]);
    expect(report!.shredded).toEqual([]);
  });

  it("hands the saved document back in plaintext, not as the envelope it just wrote", async () => {
    const doc = await Probe.create({ consumerId: newId(), personal: { passportNumber: "M1234567" } });
    expect(doc.personal.passportNumber).toBe("M1234567");
  });

  it("decrypts `.lean()` results too — the read path is query middleware, not post('init')", async () => {
    const consumerId = newId();
    await Probe.create({ consumerId, personal: { passportNumber: "M1234567", dateOfBirth: DOB } });

    const lean: any = await Probe.findOne({ consumerId }).lean();
    expect(lean.personal.passportNumber).toBe("M1234567");
    expect(lean.personal.dateOfBirth).toBeInstanceOf(Date);
  });

  it("decrypts every document of a find(), not just the first", async () => {
    const a = newId();
    const b = newId();
    await Probe.create({ consumerId: a, personal: { passportNumber: "AAA111" } });
    await Probe.create({ consumerId: b, personal: { passportNumber: "BBB222" } });

    const docs = await Probe.find({}).sort({ createdAt: 1 });
    expect(docs.map((d: any) => d.personal.passportNumber)).toEqual(["AAA111", "BBB222"]);
  });

  it("resolves `$` array paths — every element encrypted, every element decrypted", async () => {
    const consumerId = newId();
    const doc = await Probe.create({
      consumerId,
      passports: [{ number: "M1111111" }, { number: "N2222222" }],
    });

    const stored = await raw().findOne({ _id: doc._id });
    expect(stored!.passports.every((p: any) => isEncryptedEnvelope(p.number))).toBe(true);

    const read = await Probe.findById(doc._id);
    expect(read!.passports.map((p: any) => p.number)).toEqual(["M1111111", "N2222222"]);
    expect(getPiiReadReport(read)!.decrypted.sort()).toEqual(["passports.0.number", "passports.1.number"]);
  });
});

/* ── 2. randomized ──────────────────────────────────────────────────── */

describe("randomized encryption", () => {
  it("gives two different ciphertexts for the same plaintext, and both decrypt", async () => {
    const consumerId = newId();
    const one = await Probe.create({ consumerId, personal: { passportNumber: "M1234567" } });
    const two = await Probe.create({ consumerId: newId(), personal: { passportNumber: "M1234567" } });

    const [a, b] = await Promise.all([raw().findOne({ _id: one._id }), raw().findOne({ _id: two._id })]);
    expect(a!.personal.passportNumber).not.toBe(b!.personal.passportNumber);

    const readA = await Probe.findById(one._id);
    const readB = await Probe.findById(two._id);
    expect(readA!.personal.passportNumber).toBe("M1234567");
    expect(readB!.personal.passportNumber).toBe("M1234567");
  });

  it("is randomized even within ONE subject — two rows of the same consumer do not match", async () => {
    const consumerId = newId();
    const one = await Probe.create({ consumerId, personal: { passportNumber: "M1234567" } });
    const two = await Probe.create({ consumerId, personal: { passportNumber: "M1234567" } });

    const [a, b] = await Promise.all([raw().findOne({ _id: one._id }), raw().findOne({ _id: two._id })]);
    expect(a!.personal.passportNumber).not.toBe(b!.personal.passportNumber);
  });
});

/* ── 3. dual read ───────────────────────────────────────────────────── */

describe("dual-read migration window", () => {
  it("passes a fully legacy (plaintext) row through untouched, and says so", async () => {
    const consumerId = newId();
    // Written the way every row in the collection looks TODAY — real Date
    // in BSON, plain string passport, no SubjectKey row anywhere.
    await raw().insertOne({
      consumerId,
      personal: { firstName: "Asha", passportNumber: "M1234567", dateOfBirth: DOB },
      passports: [],
    });

    const read = await Probe.findOne({ consumerId });
    expect(read!.personal.passportNumber).toBe("M1234567");
    expect(read!.personal.dateOfBirth).toBeInstanceOf(Date);
    expect((read!.personal.dateOfBirth as Date).getTime()).toBe(DOB.getTime());

    const report = getPiiReadReport(read)!;
    expect(report.legacy.sort()).toEqual(["personal.dateOfBirth", "personal.passportNumber"]);
    expect(report.decrypted).toEqual([]);
    expect(await SubjectKey.countDocuments({})).toBe(0); // a read never mints a key
  });

  it("reads a MIXED row — one path encrypted, one still legacy — correctly, and reports both", async () => {
    const consumerId = newId();
    const dek = await getOrCreateSubjectDek("CONSUMER", consumerId);

    await raw().insertOne({
      consumerId,
      personal: {
        firstName: "Asha",
        passportNumber: encryptField("M1234567", dek, "personal.passportNumber"),
        dateOfBirth: DOB, // never migrated
      },
      passports: [],
    });

    const read = await Probe.findOne({ consumerId });
    expect(read!.personal.passportNumber).toBe("M1234567");
    expect((read!.personal.dateOfBirth as Date).getTime()).toBe(DOB.getTime());

    const report = getPiiReadReport(read)!;
    expect(report.decrypted).toEqual(["personal.passportNumber"]);
    expect(report.legacy).toEqual(["personal.dateOfBirth"]);
  });

  it("migrates a legacy row on its next save, without the caller doing anything", async () => {
    const consumerId = newId();
    await raw().insertOne({
      consumerId,
      personal: { firstName: "Asha", passportNumber: "M1234567", dateOfBirth: DOB },
      passports: [],
    });

    const doc: any = await Probe.findOne({ consumerId });
    doc.personal.firstName = "Asha K";
    await doc.save();

    const stored = await raw().findOne({ consumerId });
    expect(isEncryptedEnvelope(stored!.personal.passportNumber)).toBe(true);
    expect(isEncryptedEnvelope(stored!.personal.dateOfBirth)).toBe(true);
    expect(getPiiReadReport(await Probe.findOne({ consumerId }))!.legacy).toEqual([]);
  });

  it("never double-encrypts a value that is already an envelope", async () => {
    const consumerId = newId();
    const doc: any = await Probe.create({ consumerId, personal: { passportNumber: "M1234567" } });
    const first = (await raw().findOne({ consumerId }))!.personal.passportNumber;

    // Save again WITHOUT an intervening read: the in-memory doc still holds
    // plaintext (post('save') restored it), so this re-encrypts once, not twice.
    await doc.save();
    const second = (await raw().findOne({ consumerId }))!.personal.passportNumber;

    expect(first).not.toBe(second); // fresh IV
    expect((await Probe.findOne({ consumerId }))!.personal.passportNumber).toBe("M1234567");
  });
});

/* ── 4. crypto-shred ────────────────────────────────────────────────── */

describe("crypto-shredding", () => {
  it("makes a subject's stored ciphertext unreadable, while a DIFFERENT subject still reads", async () => {
    const victim = newId();
    const bystander = newId();
    await Probe.create({ consumerId: victim, personal: { passportNumber: "M1234567", dateOfBirth: DOB } });
    await Probe.create({ consumerId: bystander, personal: { passportNumber: "N7654321", dateOfBirth: DOB } });

    await destroySubjectDek("CONSUMER", victim, { actorEmail: "ops@plumtrips.com", reason: "erasure" });

    const shredded = await Probe.findOne({ consumerId: victim });
    expect(shredded!.personal.passportNumber).toBeNull();
    expect(shredded!.personal.dateOfBirth).toBeNull();
    expect(getPiiReadReport(shredded)!.shredded.sort()).toEqual([
      "personal.dateOfBirth",
      "personal.passportNumber",
    ]);

    const untouched = await Probe.findOne({ consumerId: bystander });
    expect(untouched!.personal.passportNumber).toBe("N7654321");
    expect((untouched!.personal.dateOfBirth as Date).getTime()).toBe(DOB.getTime());
  });

  it("does NOT return garbage — the ciphertext is still on disk, it just cannot be read", async () => {
    const victim = newId();
    await Probe.create({ consumerId: victim, personal: { passportNumber: "M1234567" } });
    await destroySubjectDek("CONSUMER", victim, { actorEmail: "ops@plumtrips.com", reason: "erasure" });

    const stored = await raw().findOne({ consumerId: victim });
    expect(isEncryptedEnvelope(stored!.personal.passportNumber)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("M1234567");

    const read = await Probe.findOne({ consumerId: victim });
    expect(read!.personal.passportNumber).toBeNull();
  });

  it("refuses to write new PII for a shredded subject", async () => {
    const victim = newId();
    await Probe.create({ consumerId: victim, personal: { passportNumber: "M1234567" } });
    await destroySubjectDek("CONSUMER", victim, { actorEmail: "ops@plumtrips.com", reason: "erasure" });

    await expect(
      Probe.create({ consumerId: victim, personal: { passportNumber: "P9999999" } }),
    ).rejects.toThrow(/crypto-shredded/);
  });

  it("throws on ciphertext with no key row at all — an inconsistency, not an erasure", async () => {
    const consumerId = newId();
    const dek = await getOrCreateSubjectDek("CONSUMER", consumerId);
    await raw().insertOne({
      consumerId,
      personal: { passportNumber: encryptField("M1234567", dek, "personal.passportNumber") },
      passports: [],
    });
    await SubjectKey.deleteMany({}); // simulate a key row lost, never tombstoned
    clearSubjectKeyCache();

    await expect(Probe.findOne({ consumerId })).rejects.toThrow(OrphanedCiphertextError);
  });
});

/* ── 5. setter ordering (TRAP 1) ────────────────────────────────────── */

describe("setter ordering", () => {
  it("stores ciphertext and reads back the UPPERCASED, TRIMMED plaintext", async () => {
    const consumerId = newId();
    const doc = await Probe.create({ consumerId, personal: { passportNumber: "  m1234567  " } });

    const stored = await raw().findOne({ _id: doc._id });
    // The ciphertext is NOT uppercased — the setter did not get to maul it.
    expect(isEncryptedEnvelope(stored!.personal.passportNumber)).toBe(true);
    expect(stored!.personal.passportNumber).toMatch(/^penc\.1\./);
    expect(stored!.personal.passportNumber).not.toBe(stored!.personal.passportNumber.toUpperCase());

    // And the NORMALISATION survived: what was encrypted is the value the
    // schema's setters produced, not the raw input.
    const read = await Probe.findById(doc._id);
    expect(read!.personal.passportNumber).toBe("M1234567");
  });

  it("normalises array-element paths the same way", async () => {
    const consumerId = newId();
    const doc = await Probe.create({ consumerId, passports: [{ number: " n7654321 " }] });
    const stored = await raw().findOne({ _id: doc._id });
    expect(stored!.passports[0].number).toMatch(/^penc\.1\./);
    expect((await Probe.findById(doc._id))!.passports[0].number).toBe("N7654321");
  });
});

/* ── 6. wrong / absent master key ───────────────────────────────────── */

describe("master key failure", () => {
  it("FAILS CLOSED on the wrong master key — throws, returns no plaintext-looking value", async () => {
    const consumerId = newId();
    await Probe.create({ consumerId, personal: { passportNumber: "M1234567" } });

    process.env.PII_MASTER_KEY = MASTER_KEY_B;
    clearSubjectKeyCache();

    await expect(Probe.findOne({ consumerId })).rejects.toThrow(/PII_MASTER_KEY does not match/);
  });

  it("fails closed on a write too, rather than storing plaintext", async () => {
    const consumerId = newId();
    await Probe.create({ consumerId, personal: { passportNumber: "M1234567" } });

    process.env.PII_MASTER_KEY = MASTER_KEY_B;
    clearSubjectKeyCache();

    await expect(
      Probe.create({ consumerId, personal: { passportNumber: "P9999999" } }),
    ).rejects.toThrow(/PII_MASTER_KEY does not match/);

    process.env.PII_MASTER_KEY = MASTER_KEY_A;
    clearSubjectKeyCache();
    const rows = await raw().find({ consumerId }).toArray();
    expect(rows.every((r: any) => isEncryptedEnvelope(r.personal.passportNumber))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("P9999999");
  });
});

/* ── 7. tamper ──────────────────────────────────────────────────────── */

describe("tamper detection", () => {
  it("rejects a flipped ciphertext byte — the GCM auth tag refuses it on read", async () => {
    const consumerId = newId();
    const doc = await Probe.create({ consumerId, personal: { passportNumber: "M1234567" } });

    const stored = await raw().findOne({ _id: doc._id });
    const parts = String(stored!.personal.passportNumber).split(".");
    const ct = Buffer.from(parts[4], "base64url");
    ct[0] ^= 0x01;
    parts[4] = ct.toString("base64url");
    await raw().updateOne({ _id: doc._id }, { $set: { "personal.passportNumber": parts.join(".") } });

    await expect(Probe.findById(doc._id)).rejects.toThrow(/Authenticated decryption failed/);
  });

  it("rejects a ciphertext moved from one FIELD to another — the path is authenticated", async () => {
    const consumerId = newId();
    const doc = await Probe.create({
      consumerId,
      personal: { passportNumber: "M1234567" },
      passports: [{ number: "N7654321" }],
    });

    const stored = await raw().findOne({ _id: doc._id });
    await raw().updateOne(
      { _id: doc._id },
      { $set: { "personal.passportNumber": stored!.passports[0].number } },
    );

    await expect(Probe.findById(doc._id)).rejects.toThrow(/Authenticated decryption failed/);
  });
});

/* ── 8. the refusals ────────────────────────────────────────────────── */

describe("guardrails", () => {
  it("refuses a direct updateOne that would write an encrypted path in the clear", async () => {
    const consumerId = newId();
    await Probe.create({ consumerId, personal: { passportNumber: "M1234567" } });

    await expect(
      Probe.updateOne({ consumerId }, { $set: { "personal.passportNumber": "P9999999" } }),
    ).rejects.toThrow(EncryptedFieldUpdateError);

    await expect(
      Probe.findOneAndUpdate({ consumerId }, { $set: { passports: [{ number: "P9999999" }] } }),
    ).rejects.toThrow(EncryptedFieldUpdateError);

    // ...and still allows an update that touches nothing encrypted.
    await expect(
      Probe.updateOne({ consumerId }, { $set: { "personal.firstName": "Asha K" } }),
    ).resolves.toBeTruthy();
  });

  it("refuses to hand a caller ciphertext when the subject cannot be resolved", async () => {
    const consumerId = newId();
    await Probe.create({ consumerId, personal: { passportNumber: "M1234567" } });

    await expect(Probe.findOne({ consumerId }).select("personal")).rejects.toThrow(SubjectUnresolvedError);

    // A projection that drops the subject AND the encrypted fields is fine.
    const ok: any = await Probe.findOne({ consumerId }).select("createdAt").lean();
    expect(ok).toBeTruthy();
  });

  it("refuses at attach time when a `date` path is not declared Mixed (TRAP 2)", () => {
    const bad = new Schema({ consumerId: Schema.Types.ObjectId, dob: { type: Date } });
    expect(() =>
      bad.plugin(fieldEncryptionPlugin, {
        subject: (d: any) => ({ subjectType: "CONSUMER", subjectId: d.consumerId }),
        fields: [{ path: "dob", type: "date" }],
      }),
    ).toThrow(/must be Schema.Types.Mixed/);
  });

  it("refuses at attach time for an unknown path or a non-String `string` path", () => {
    const base = () => new Schema({ consumerId: Schema.Types.ObjectId, n: { type: Number } });
    const subject = (d: any) => ({ subjectType: "CONSUMER" as const, subjectId: d.consumerId });

    expect(() =>
      base().plugin(fieldEncryptionPlugin, { subject, fields: [{ path: "nope" }] }),
    ).toThrow(/does not exist on this schema/);

    expect(() => base().plugin(fieldEncryptionPlugin, { subject, fields: [{ path: "n" }] })).toThrow(
      /schema declares it as Number/,
    );
  });
});
