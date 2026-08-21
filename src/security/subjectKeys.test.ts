// Coverage for the key service against a REAL mongod (MongoMemoryServer) —
// the unique index, the tombstone and the create race are all database
// behaviours, and asserting them against a stubbed model would be asserting
// our belief about Mongo rather than Mongo.
//
// NO REAL COLLECTION IS TOUCHED beyond `subjectkeys` itself, which is the
// engine's own storage. ConsumerProfile and VisaDocument are not imported
// here or anywhere else in Stage 1.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const MASTER_KEY_A = crypto.randomBytes(32).toString("base64");
const MASTER_KEY_B = crypto.randomBytes(32).toString("base64");
process.env.PII_MASTER_KEY = MASTER_KEY_A;

const { default: SubjectKey } = await import("../models/SubjectKey.js");
const {
  getOrCreateSubjectDek,
  getSubjectDek,
  destroySubjectDek,
  clearSubjectKeyCache,
  SubjectKeyDestroyedError,
  SubjectKeyUnwrapError,
} = await import("./subjectKeys.js");
const { resolveMasterKey, PiiMasterKeyError } = await import("./piiMasterKey.js");

let mongod: MongoMemoryServer;

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
  await SubjectKey.deleteMany({});
});

const newId = () => new mongoose.Types.ObjectId();

describe("getOrCreateSubjectDek", () => {
  it("mints and persists a wrapped key on first use, and returns the SAME key afterwards", async () => {
    const id = newId();
    const first = await getOrCreateSubjectDek("CONSUMER", id);
    clearSubjectKeyCache();
    const second = await getOrCreateSubjectDek("CONSUMER", id);

    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
    expect(await SubjectKey.countDocuments({ subjectType: "CONSUMER", subjectId: id })).toBe(1);
  });

  it("never stores the key in the clear — the row holds an envelope, not the DEK", async () => {
    const id = newId();
    const dek = await getOrCreateSubjectDek("CONSUMER", id);
    const row = await SubjectKey.findOne({ subjectId: id }).lean();

    expect(row!.wrappedDek).toMatch(/^penc\.1\./);
    expect(row!.wrappedDek).not.toContain(dek.toString("base64"));
    expect(row!.encVersion).toBe(1);
    expect(row!.destroyedAt).toBeNull();
  });

  it("gives DIFFERENT subjects different keys, and separates the two subject types", async () => {
    const a = await getOrCreateSubjectDek("CONSUMER", newId());
    const b = await getOrCreateSubjectDek("CONSUMER", newId());
    expect(a.equals(b)).toBe(false);

    const sharedId = newId();
    const asConsumer = await getOrCreateSubjectDek("CONSUMER", sharedId);
    const asTraveller = await getOrCreateSubjectDek("TRAVELLER_PROFILE", sharedId);
    expect(asConsumer.equals(asTraveller)).toBe(false);
  });

  it("survives a concurrent first-write race with ONE key, not two", async () => {
    const id = newId();
    clearSubjectKeyCache();
    const results = await Promise.all([
      getOrCreateSubjectDek("CONSUMER", id),
      getOrCreateSubjectDek("CONSUMER", id),
      getOrCreateSubjectDek("CONSUMER", id),
    ]);

    expect(await SubjectKey.countDocuments({ subjectId: id })).toBe(1);
    expect(results.every((r) => r.equals(results[0]))).toBe(true);
  });
});

describe("destroySubjectDek — crypto-shredding", () => {
  it("tombstones the row: key gone, proof kept", async () => {
    const id = newId();
    await getOrCreateSubjectDek("CONSUMER", id);

    const result = await destroySubjectDek("CONSUMER", id, {
      actorEmail: "Ops@Plumtrips.com",
      reason: "erasure request #1",
    });

    expect(result).toEqual({ destroyed: true, hadNoKey: false, alreadyDestroyed: false });

    const row = await SubjectKey.findOne({ subjectId: id }).lean();
    expect(row).not.toBeNull(); // the row SURVIVES — it is the evidence
    expect(row!.wrappedDek).toBeNull();
    expect(row!.destroyedAt).toBeInstanceOf(Date);
    expect(row!.destroyedByEmail).toBe("ops@plumtrips.com");
    expect(row!.destroyReason).toBe("erasure request #1");
  });

  it("reports 'destroyed' on lookup afterwards — a state, not an error", async () => {
    const id = newId();
    await getOrCreateSubjectDek("CONSUMER", id);
    await destroySubjectDek("CONSUMER", id, { actorEmail: "ops@plumtrips.com", reason: "r" });

    const lookup = await getSubjectDek("CONSUMER", id);
    expect(lookup.status).toBe("destroyed");
  });

  it("REFUSES to mint a replacement for a shredded subject", async () => {
    const id = newId();
    await getOrCreateSubjectDek("CONSUMER", id);
    await destroySubjectDek("CONSUMER", id, { actorEmail: "ops@plumtrips.com", reason: "r" });

    await expect(getOrCreateSubjectDek("CONSUMER", id)).rejects.toThrow(SubjectKeyDestroyedError);
    expect(await SubjectKey.countDocuments({ subjectId: id })).toBe(1);
  });

  it("leaves every OTHER subject untouched", async () => {
    const victim = newId();
    const bystander = newId();
    await getOrCreateSubjectDek("CONSUMER", victim);
    const bystanderKey = await getOrCreateSubjectDek("CONSUMER", bystander);

    await destroySubjectDek("CONSUMER", victim, { actorEmail: "ops@plumtrips.com", reason: "r" });
    clearSubjectKeyCache();

    const stillThere = await getSubjectDek("CONSUMER", bystander);
    expect(stillThere.status).toBe("active");
    expect(stillThere.status === "active" && stillThere.dek.equals(bystanderKey)).toBe(true);
  });

  it("is idempotent — a second run reports alreadyDestroyed, it does not fail", async () => {
    const id = newId();
    await getOrCreateSubjectDek("CONSUMER", id);
    await destroySubjectDek("CONSUMER", id, { actorEmail: "ops@plumtrips.com", reason: "r" });

    expect(await destroySubjectDek("CONSUMER", id, { actorEmail: "ops@plumtrips.com", reason: "r" })).toEqual({
      destroyed: false,
      hadNoKey: false,
      alreadyDestroyed: true,
    });
  });

  it("reports hadNoKey for a subject that never encrypted anything", async () => {
    expect(await destroySubjectDek("TRAVELLER_PROFILE", newId(), { actorEmail: "a@b.c", reason: "r" })).toEqual({
      destroyed: false,
      hadNoKey: true,
      alreadyDestroyed: false,
    });
  });

  it("drops the cached key so an in-process reader cannot keep using it", async () => {
    const id = newId();
    await getOrCreateSubjectDek("CONSUMER", id); // now cached
    await destroySubjectDek("CONSUMER", id, { actorEmail: "a@b.c", reason: "r" });

    // NO clearSubjectKeyCache() here — destroySubjectDek must have done it.
    expect((await getSubjectDek("CONSUMER", id)).status).toBe("destroyed");
  });
});

describe("master key handling", () => {
  it("throws loudly when the master key is WRONG — never degrades to missing/destroyed", async () => {
    const id = newId();
    await getOrCreateSubjectDek("CONSUMER", id);

    process.env.PII_MASTER_KEY = MASTER_KEY_B;
    clearSubjectKeyCache();

    await expect(getSubjectDek("CONSUMER", id)).rejects.toThrow(SubjectKeyUnwrapError);
    await expect(getSubjectDek("CONSUMER", id)).rejects.toThrow(/PII_MASTER_KEY does not match/);
  });

  it("rejects a malformed master key in ANY environment rather than falling back", () => {
    process.env.PII_MASTER_KEY = Buffer.alloc(16).toString("base64");
    expect(() => resolveMasterKey()).toThrow(PiiMasterKeyError);
    expect(() => resolveMasterKey()).toThrow(/exactly 32 bytes/);
  });

  it("throws in production when the key is absent, and falls back deterministically outside it", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.PII_MASTER_KEY;
    try {
      process.env.NODE_ENV = "production";
      expect(() => resolveMasterKey()).toThrow(/PII_MASTER_KEY is not set/);

      process.env.NODE_ENV = "test";
      const first = resolveMasterKey();
      const second = resolveMasterKey();
      expect(first.source).toBe("dev-fallback");
      // Deterministic across calls — a random per-process key would read to a
      // developer as database corruption after every restart.
      expect(first.key.equals(second.key)).toBe(true);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.PII_MASTER_KEY = MASTER_KEY_A;
    }
  });
});
