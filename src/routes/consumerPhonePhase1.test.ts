// Phase 1 of mobile-OTP: the schema + write-side normalisation foundation.
//
// What this proves, against a REAL mongodb-memory-server rather than a
// literal fixture — because every claim here is about what MONGO does with
// the document (does the index build, does it reject, is the key absent or
// present-but-empty), and none of that is observable on an object that was
// never written.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.JWT_SECRET = "b2b-jwt-secret-for-tests";
process.env.CONSUMER_JWT_SECRET = "consumer-jwt-secret-for-tests";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-phone-phase1-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Consumer, CONSUMER_AUTH_PROVIDERS } = await import("../models/Consumer.js");
const { normaliseIndiaMobile } = await import("../services/consumerMobileOtp.js");
const { default: consumerAuthRouter } = await import("./consumer.auth.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/consumer/auth", consumerAuthRouter);
  return a;
}

const SIGNUP = {
  email: "phase1@example.com",
  name: "Phase One",
  password: "correct horse battery",
};

function signup(overrides: Record<string, any> = {}) {
  return request(app()).post("/api/consumer/auth/signup").send({ ...SIGNUP, ...overrides });
}

/** The RAW document, straight from the driver — Mongoose would hide an absent key. */
async function rawDoc(email: string): Promise<any> {
  return mongoose.connection.db!.collection(Consumer.collection.name).findOne({ email });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // Builds the declared indexes for real. Without this the unique constraint
  // is only a line in a schema and the collision tests below would pass for
  // the wrong reason.
  await Consumer.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Consumer.deleteMany({});
});

/* ══ 1. THE NORMALISER — the single source of truth ══════════════════ */
describe("normaliseIndiaMobile", () => {
  it("passes a bare ten-digit number through unchanged", () => {
    expect(normaliseIndiaMobile("9876543210")).toBe("9876543210");
  });

  it("strips a 91 country code from a twelve-digit number", () => {
    expect(normaliseIndiaMobile("919876543210")).toBe("9876543210");
  });

  it("reduces every written form of one number to the SAME ten digits", () => {
    // The property the unique index depends on: these are one number, so
    // they must not be able to occupy two slots.
    const forms = ["9876543210", "919876543210", "+919876543210", "+91 98765 43210", "98765-43210"];
    const normalised = new Set(forms.map((f) => normaliseIndiaMobile(f)));
    expect([...normalised]).toEqual(["9876543210"]);
  });

  it("returns the empty string for anything it cannot make an Indian ten-digit number of", () => {
    // A +1 number is REJECTED, never truncated to its last ten digits.
    expect(normaliseIndiaMobile("+1 415 555 0100")).toBe("");
    expect(normaliseIndiaMobile("098765432100")).toBe(""); // 12 digits, not 91-prefixed
    expect(normaliseIndiaMobile("12345")).toBe("");
    expect(normaliseIndiaMobile("")).toBe("");
    expect(normaliseIndiaMobile(null)).toBe("");
    expect(normaliseIndiaMobile(undefined)).toBe("");
    expect(normaliseIndiaMobile("not a phone")).toBe("");
  });
});

/* ══ 2. THE ENUM ═════════════════════════════════════════════════════ */
describe("CONSUMER_AUTH_PROVIDERS", () => {
  it("includes mobile so an OTP account can record its door honestly", () => {
    expect(CONSUMER_AUTH_PROVIDERS).toContain("mobile");
  });

  it("persists authProvider mobile without a passwordHash", async () => {
    const c = await Consumer.create({
      email: "otp@example.com",
      name: "OTP User",
      authProvider: "mobile",
    });
    expect(c.authProvider).toBe("mobile");
    expect((c as any).passwordHash).toBeUndefined();
  });
});

/* ══ 3. THE SIGNUP WRITE BOUNDARY ════════════════════════════════════ */
describe("POST /signup — phone normalisation on write", () => {
  it("stores the normalised bare ten digits, not what was typed", async () => {
    const res = await signup({ phone: "+91 98765-43210" });
    expect(res.status).toBe(201);
    const doc = await rawDoc("phase1@example.com");
    expect(doc.phone).toBe("9876543210");
  });

  it("stores the same ten digits whichever form is posted", async () => {
    for (const form of ["9876543210", "919876543210", "+919876543210"]) {
      await Consumer.deleteMany({});
      await signup({ phone: form });
      expect((await rawDoc("phase1@example.com")).phone).toBe("9876543210");
    }
  });

  it("OMITS the key entirely for an unusable number — never stores an empty string", async () => {
    const res = await signup({ phone: "+1 415 555 0100" });
    expect(res.status).toBe(201);
    const doc = await rawDoc("phase1@example.com");
    // The distinction that matters: absent, not present-and-empty.
    expect("phone" in doc).toBe(false);
    expect(doc.phone).toBeUndefined();
  });

  it("leaves phone absent when none is sent at all", async () => {
    await signup();
    expect("phone" in (await rawDoc("phase1@example.com"))).toBe(false);
  });

  // Seven signups plus seven wipes. Comfortably under 5s alone, but it runs
  // alongside 200 other files, so it gets an explicit budget rather than
  // inheriting the 5s default and going red on a busy machine.
  it("never writes an empty-string phone for any junk input", async () => {
    const junk = ["", "   ", "abc", "12345", null, undefined, "+1 415 555 0100"];
    for (const p of junk) {
      await Consumer.deleteMany({});
      await signup({ phone: p });
      const doc = await rawDoc("phase1@example.com");
      expect(doc.phone).not.toBe("");
      expect("phone" in doc).toBe(false);
    }
  }, 30_000);

  it("never populates verifiedPhone — signup proves nothing", async () => {
    await signup({ phone: "9876543210" });
    expect("verifiedPhone" in (await rawDoc("phase1@example.com"))).toBe(false);
  });
});

/* ══ 4. THE INDEX, AGAINST A REAL MONGO ══════════════════════════════ */
describe("verifiedPhone unique+sparse — the login key", () => {
  it("is declared unique AND sparse on the collection", async () => {
    const idx = await Consumer.collection.indexes();
    const vp = idx.find((i: any) => i.key?.verifiedPhone === 1) as any;
    expect(vp).toBeTruthy();
    expect(vp.unique).toBe(true);
    expect(vp.sparse).toBe(true);
  });

  it("SPARSE: many consumers with no verified number coexist", async () => {
    // The everyday case — every Google and email account. Without sparse
    // these would all collide on the missing value.
    await Consumer.create({ email: "a@example.com", name: "A" });
    await Consumer.create({ email: "b@example.com", name: "B" });
    await Consumer.create({ email: "c@example.com", name: "C" });
    expect(await Consumer.countDocuments({})).toBe(3);
  });

  it("UNIQUE: a second account cannot claim the same verified number", async () => {
    await Consumer.create({ email: "a@example.com", name: "A", verifiedPhone: "9876543210" });
    await expect(
      Consumer.create({ email: "b@example.com", name: "B", verifiedPhone: "9876543210" }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("resolves a verified number to exactly ONE account — what login needs", async () => {
    await Consumer.create({ email: "a@example.com", name: "A", verifiedPhone: "9876543210" });
    await Consumer.create({ email: "b@example.com", name: "B", verifiedPhone: "9000000001" });
    const found = await Consumer.find({ verifiedPhone: "9876543210" });
    expect(found).toHaveLength(1);
    expect(found[0].email).toBe("a@example.com");
  });

  it("THE EMPTY-STRING TRAP: two empty strings collide, which is why writers omit", async () => {
    // Not a wish — the demonstration. sparse skips ABSENT fields; the empty
    // string is a present value and lands in the index like any other.
    await Consumer.create({ email: "a@example.com", name: "A", verifiedPhone: "" });
    await expect(
      Consumer.create({ email: "b@example.com", name: "B", verifiedPhone: "" }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("unverified phone duplicates freely — a typo cannot block a real owner", async () => {
    // The reason phone and verifiedPhone are two fields. A stranger's
    // unverified claim on a number must not deny it to whoever holds it.
    await Consumer.create({ email: "typo@example.com", name: "Typo", phone: "9876543210" });
    await Consumer.create({ email: "owner@example.com", name: "Owner", phone: "9876543210" });
    expect(await Consumer.countDocuments({ phone: "9876543210" })).toBe(2);

    // ...and the real owner can still verify it.
    const owner = await Consumer.findOne({ email: "owner@example.com" });
    (owner as any).verifiedPhone = "9876543210";
    await expect((owner as any).save()).resolves.toBeTruthy();
  });
});
