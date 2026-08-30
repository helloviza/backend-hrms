// apps/backend/src/routes/consumer.mobileOtp.test.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE GATE THAT DECIDES WHO CAN SUBMIT A VISA APPLICATION.
// ══════════════════════════════════════════════════════════════════════
//
// Two properties are under test here, and both are security properties
// rather than features:
//
//   1. THE NUMBER IS THE SESSION'S OWN. An OTP is sent to the number on
//      the authenticated consumer's profile and to nothing else. If a
//      caller-supplied `mobile` could steer the send, this endpoint would
//      be a free SMS cannon and — worse — a way to earn a verified flag on
//      a profile carrying somebody else's number.
//   2. mobileVerified IS NOT CLIENT-WRITABLE. It has exactly two writers,
//      both server-side. The submit gate trusts it, so anything that lets a
//      client set it is a way to walk through the gate.
//
// ── REAL requireConsumer, REAL TOKENS, DELIBERATELY ──────────────────
// Sibling suites (consumer.dashboardData.test.ts, consumer.paymentOrder.
// test.ts) vi.mock the guard and inject an acting consumer, which is right
// when the subject is a projection. It would be wrong here: "the number
// comes from the SESSION" is the thing being proven, so the session has to
// be real. Same posture as consumer.profile.test.ts.
//
// ── THE ONE MOCK, AND WHY ────────────────────────────────────────────
// global.fetch is stubbed. MSG91 is a paid third party — a suite that
// really called it would bill us per run and would fail in CI where no key
// exists. Everything on OUR side of that boundary (the guard, the profile
// read, the flag write, the limiter, the gate) is real: real router, real
// Mongo, real documents. The stub also lets each test assert on the URL
// that WOULD have been called, which is how the session-binding property is
// checked at all.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Secrets must exist BEFORE any import that reads them — config/env.ts
// captures these into a frozen object at module load, so setting them after
// the dynamic imports below would leave the service permanently
// "not configured". Same preamble shape as consumer.profile.test.ts.
const B2B_SECRET = "b2b-jwt-secret-for-tests";
const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;
process.env.NODE_ENV = "test";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-otp-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

// A fake key and a fake template. Never a real one: a suite that carried a
// live MSG91 credential would put it in the repo.
process.env.MSG91_AUTH_KEY = "test-msg91-auth-key";
process.env.MSG91_VERIFY_TEMPLATE_ID = "test-verify-template-id";

// The Turnstile gate is fail-closed and TURNSTILE_SECRET is unset here, so
// without this every /send would be a 400 before reaching the handler. The
// bypass is honoured only when NODE_ENV !== "production" (see
// middleware/turnstile.ts), and the last test in this file proves that the
// gate really does refuse when the bypass is off.
process.env.TURNSTILE_DEV_BYPASS = "true";
delete process.env.TURNSTILE_SECRET;

const { default: Consumer } = await import("../models/Consumer.js");
const { default: ConsumerProfile } = await import("../models/ConsumerProfile.js");
const { default: VisaRule } = await import("../models/VisaRule.js");
const { default: VisaRequest } = await import("../models/VisaRequest.js");
const { default: VisaApplication } = await import("../models/VisaApplication.js");
const { default: mobileOtpRouter } = await import("./consumer.mobileOtp.js");
const { default: profileRouter } = await import("./consumer.profile.js");
const { default: applicationsRouter } = await import("./consumer.applications.js");
/* THE PUBLIC SIGN-IN DOOR, mounted alongside the session-gated one.
 *
 * It has its own suite (consumer.mobileAuth.test.ts) and this is not a
 * second copy of it. It is here because the property proved at the bottom
 * of this file spans BOTH doors and cannot be stated inside either: that
 * editing your number in the profile stops the OLD number from signing you
 * in. Asserting that the field was unset would only restate the
 * implementation; asking the login door and watching it fail to find the
 * account is the actual security claim. */
const { default: mobileAuthRouter } = await import("./consumer.mobileAuth.js");
const { signConsumerAccessToken } = await import("../utils/consumerJwt.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/consumer/mobile", mobileOtpRouter);
app.use("/api/consumer/profile", profileRouter);
app.use("/api/consumer/applications", applicationsRouter);
app.use("/api/consumer/auth/mobile", mobileAuthRouter);

let mongod: MongoMemoryServer;

/* ── The MSG91 stub ──────────────────────────────────────────────────── */

/** Every URL the service asked for this test, in order. */
let msg91Calls: string[] = [];

/**
 * Stubs global.fetch with a canned MSG91 payload.
 *
 * `body` is what MSG91 would answer. The service's whole contract with the
 * provider is `type === "success"`, so a test drives an outcome by choosing
 * that one field.
 */
function stubMsg91(body: unknown, init?: { status?: number; raw?: string }) {
  global.fetch = vi.fn(async (url: any) => {
    msg91Calls.push(String(url));
    const text = init?.raw ?? JSON.stringify(body);
    return new Response(text, {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;
}

const MSG91_OK = { type: "success", message: "OTP sent successfully" };

/* ── Fixtures ────────────────────────────────────────────────────────── */

const createdConsumerIds: string[] = [];

/** A real consumer plus a real token for them. */
async function makeConsumer(email: string, name = "Test Consumer") {
  const consumer = await Consumer.create({
    email,
    name,
    passwordHash: "not-used-in-these-tests",
  });
  createdConsumerIds.push(String(consumer._id));
  const token = signConsumerAccessToken({
    consumerId: String(consumer._id),
    tokenVersion: (consumer as any).tokenVersion,
  });
  return { consumer, token, auth: `Bearer ${token}` };
}

/**
 * A consumer WITH a profile carrying a mobile number.
 *
 * Written through the PATCH endpoint rather than ConsumerProfile.create,
 * deliberately: contact.mobile is an encrypted field, and going through the
 * route means the value is stored exactly the way production stores it —
 * so the read path in the OTP router is decrypting a real envelope rather
 * than reading a plaintext string a test happened to insert.
 */
async function makeConsumerWithMobile(email: string, mobile: string) {
  const c = await makeConsumer(email);
  await request(app)
    .patch("/api/consumer/profile/contact")
    .set("Authorization", c.auth)
    .send({ mobile })
    .expect(200);
  return c;
}

/** Marks a consumer's mobile verified the ONLY way the app can: through /verify. */
async function verifyMobileFor(auth: string) {
  stubMsg91({ type: "success", message: "OTP verified success" });
  await request(app)
    .post("/api/consumer/mobile/otp/verify")
    .set("Authorization", auth)
    .send({ code: "1234" })
    .expect(200);
}

/** A PUBLISHED rule the submit handler can actually resolve and snapshot. */
async function makePublishedRule() {
  return VisaRule.create({
    status: "PUBLISHED",
    nationality: "IN",
    destinationIso2: "AE",
    destinationName: "United Arab Emirates",
    purpose: "TOURIST",
    isSchengen: false,
    // Real enum members — see VISA_PRODUCT_CLASSES / VISA_CATEGORIES in
    // models/VisaRule.ts. productClass is the KIND of product ("VISA"),
    // visaCategory is how it is issued ("STICKER"); they are easy to
    // transpose and Mongoose rejects both if you do.
    productClass: "VISA",
    visaCategory: "STICKER",
    entryType: "SINGLE",
    serviceTier: "STANDARD",
    governmentFeeInr: 6500,
    serviceFeeInr: 1500,
  } as any);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  msg91Calls = [];
  stubMsg91(MSG91_OK);
  await Promise.all([
    Consumer.deleteMany({}),
    ConsumerProfile.deleteMany({}),
    VisaRule.deleteMany({}),
    VisaRequest.deleteMany({}),
    VisaApplication.deleteMany({}),
  ]);
});

/* ══════════════════════════════════════════════════════════════════════
 * 1. THE SEND IS BOUND TO THE SESSION
 * ══════════════════════════════════════════════════════════════════════ */

describe("send binds to the authenticated consumer's own number", () => {
  it("sends to the number on the caller's profile", async () => {
    const c = await makeConsumerWithMobile("own@helloviza.test", "9876543210");

    const res = await request(app)
      .post("/api/consumer/mobile/otp/send")
      .set("Authorization", c.auth)
      .send({})
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(msg91Calls).toHaveLength(1);
    expect(msg91Calls[0]).toContain("mobile=919876543210");
    // The response never echoes the full number back.
    expect(res.body.mobileMasked).toBe("•••••• 3210");
    expect(JSON.stringify(res.body)).not.toContain("9876543210");
  });

  it("IGNORES a mobile supplied in the request body — the attacker's number is never called", async () => {
    const c = await makeConsumerWithMobile("bound@helloviza.test", "9876543210");

    await request(app)
      .post("/api/consumer/mobile/otp/send")
      .set("Authorization", c.auth)
      // Every field name the reference implementation accepted, at once.
      .send({ mobile: "9000000001", phone: "9000000002", to: "9000000003" })
      .expect(200);

    expect(msg91Calls).toHaveLength(1);
    expect(msg91Calls[0]).toContain("mobile=919876543210");
    expect(msg91Calls[0]).not.toContain("9000000001");
    expect(msg91Calls[0]).not.toContain("9000000002");
    expect(msg91Calls[0]).not.toContain("9000000003");
  });

  it("verify checks the code against the SESSION's number, not a supplied one", async () => {
    const c = await makeConsumerWithMobile("vbound@helloviza.test", "9876543210");
    stubMsg91({ type: "success", message: "OTP verified success" });

    await request(app)
      .post("/api/consumer/mobile/otp/verify")
      .set("Authorization", c.auth)
      .send({ code: "1234", mobile: "9000000001" })
      .expect(200);

    expect(msg91Calls[0]).toContain("mobile=919876543210");
    expect(msg91Calls[0]).not.toContain("9000000001");
  });

  it("401s an unauthenticated caller before any SMS is considered", async () => {
    await request(app)
      .post("/api/consumer/mobile/otp/send")
      .send({ mobile: "9876543210" })
      .expect(401);

    expect(msg91Calls).toHaveLength(0);
  });

  it("refuses when no mobile is on the profile", async () => {
    const c = await makeConsumer("nomobile@helloviza.test");

    const res = await request(app)
      .post("/api/consumer/mobile/otp/send")
      .set("Authorization", c.auth)
      .send({})
      .expect(400);

    expect(res.body.code).toBe("MOBILE_NOT_SET");
    expect(msg91Calls).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 2. VERIFY SETS THE FLAG — AND ONLY VERIFY DOES
 * ══════════════════════════════════════════════════════════════════════ */

describe("verify sets mobileVerified", () => {
  it("writes mobileVerified + mobileVerifiedAt on a successful verify", async () => {
    const c = await makeConsumerWithMobile("setflag@helloviza.test", "9876543210");

    const before = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(before?.contact?.mobileVerified).toBe(false);

    stubMsg91({ type: "success", message: "OTP verified success" });
    const res = await request(app)
      .post("/api/consumer/mobile/otp/verify")
      .set("Authorization", c.auth)
      .send({ code: "1234" })
      .expect(200);

    expect(res.body.verified).toBe(true);
    expect(msg91Calls[0]).toContain("otp=1234");

    const after = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(after?.contact?.mobileVerified).toBe(true);
    expect(after?.contact?.mobileVerifiedAt).toBeInstanceOf(Date);
  });

  it("does NOT set the flag when MSG91 rejects the code", async () => {
    const c = await makeConsumerWithMobile("badcode@helloviza.test", "9876543210");

    stubMsg91({ type: "error", message: "OTP not match" });
    const res = await request(app)
      .post("/api/consumer/mobile/otp/verify")
      .set("Authorization", c.auth)
      .send({ code: "0000" })
      .expect(400);

    expect(res.body.code).toBe("INVALID_CODE");

    const after = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(after?.contact?.mobileVerified).toBe(false);
  });

  it("classifies an expired code distinctly, so the UI can offer a resend", async () => {
    const c = await makeConsumerWithMobile("expired@helloviza.test", "9876543210");

    stubMsg91({ type: "error", message: "OTP expired" });
    const res = await request(app)
      .post("/api/consumer/mobile/otp/verify")
      .set("Authorization", c.auth)
      .send({ code: "1234" })
      .expect(400);

    expect(res.body.code).toBe("EXPIRED");
  });

  it("survives MSG91 answering with an HTML error page", async () => {
    const c = await makeConsumerWithMobile("html@helloviza.test", "9876543210");

    stubMsg91(null, { raw: "<html><body>Blocked</body></html>", status: 403 });
    const res = await request(app)
      .post("/api/consumer/mobile/otp/verify")
      .set("Authorization", c.auth)
      .send({ code: "1234" })
      .expect(502);

    expect(res.body.code).toBe("PROVIDER_ERROR");
    // The provider's raw HTML must not be handed to the browser.
    expect(JSON.stringify(res.body)).not.toContain("Blocked");

    const after = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(after?.contact?.mobileVerified).toBe(false);
  });

  it("the PATCH allowlist still refuses a client-supplied mobileVerified", async () => {
    const c = await makeConsumerWithMobile("forge@helloviza.test", "9876543210");

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ mobile: "9876543210", mobileVerified: true, mobileVerifiedAt: new Date() })
      .expect(200);

    const after = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(after?.contact?.mobileVerified).toBe(false);
  });

  it("an already-verified number short-circuits instead of spending another SMS", async () => {
    const c = await makeConsumerWithMobile("already@helloviza.test", "9876543210");
    await verifyMobileFor(c.auth);

    msg91Calls = [];
    const res = await request(app)
      .post("/api/consumer/mobile/otp/send")
      .set("Authorization", c.auth)
      .send({})
      .expect(200);

    expect(res.body.alreadyVerified).toBe(true);
    expect(msg91Calls).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 3. RESET ON EDIT
 * ══════════════════════════════════════════════════════════════════════ */

describe("changing the number un-verifies it", () => {
  it("clears mobileVerified when the mobile changes", async () => {
    const c = await makeConsumerWithMobile("reset@helloviza.test", "9876543210");
    await verifyMobileFor(c.auth);

    const verified = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(verified?.contact?.mobileVerified).toBe(true);

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ mobile: "9123456780" })
      .expect(200);

    const after = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(after?.contact?.mobileVerified).toBe(false);
    expect(after?.contact?.mobileVerifiedAt ?? null).toBeNull();
  });

  it("KEEPS mobileVerified when the number is re-saved unchanged", async () => {
    const c = await makeConsumerWithMobile("keep@helloviza.test", "9876543210");
    await verifyMobileFor(c.auth);

    // The shape of a real contact-tab save: the number is resubmitted
    // untouched alongside an address the user actually edited.
    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({
        mobile: "9876543210",
        currentAddress: { line1: "12 Residency Rd", city: "Bengaluru", country: "IN" },
      })
      .expect(200);

    const after = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(after?.contact?.mobileVerified).toBe(true);
  });

  it("KEEPS mobileVerified when only the FORMATTING changes", async () => {
    const c = await makeConsumerWithMobile("format@helloviza.test", "9876543210");
    await verifyMobileFor(c.auth);

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ mobile: "+91 98765 43210" })
      .expect(200);

    const after = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(after?.contact?.mobileVerified).toBe(true);
  });

  it("KEEPS mobileVerified when the contact tab is saved without touching mobile at all", async () => {
    const c = await makeConsumerWithMobile("untouched@helloviza.test", "9876543210");
    await verifyMobileFor(c.auth);

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ alternateEmail: "alt@helloviza.test" })
      .expect(200);

    const after = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(after?.contact?.mobileVerified).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. THE SUBMIT GATE
 * ══════════════════════════════════════════════════════════════════════ */

describe("application submit requires a verified mobile", () => {
  it("BLOCKS an unverified consumer with 403 MOBILE_NOT_VERIFIED", async () => {
    const c = await makeConsumerWithMobile("blocked@helloviza.test", "9876543210");
    await makePublishedRule();

    const res = await request(app)
      .post("/api/consumer/applications")
      .set("Authorization", c.auth)
      .send({ iso2: "AE", purpose: "TOURIST" })
      .expect(403);

    expect(res.body.code).toBe("MOBILE_NOT_VERIFIED");

    // Nothing was minted — the gate is before the writes, not after.
    expect(await VisaApplication.countDocuments({})).toBe(0);
    expect(await VisaRequest.countDocuments({})).toBe(0);
  });

  it("BLOCKS a consumer with no profile at all", async () => {
    const c = await makeConsumer("noprofile@helloviza.test");
    await makePublishedRule();

    const res = await request(app)
      .post("/api/consumer/applications")
      .set("Authorization", c.auth)
      .send({ iso2: "AE", purpose: "TOURIST" })
      .expect(403);

    expect(res.body.code).toBe("MOBILE_NOT_VERIFIED");
  });

  it("ALLOWS a verified consumer through — the application is created", async () => {
    const c = await makeConsumerWithMobile("allowed@helloviza.test", "9876543210");
    await verifyMobileFor(c.auth);
    await makePublishedRule();

    const res = await request(app)
      .post("/api/consumer/applications")
      .set("Authorization", c.auth)
      .send({ iso2: "AE", purpose: "TOURIST" })
      .expect(201);

    expect(res.body.ok).toBe(true);
    expect(await VisaApplication.countDocuments({})).toBe(1);
  });

  it("re-BLOCKS after the number is edited — verification does not survive a change", async () => {
    const c = await makeConsumerWithMobile("relapse@helloviza.test", "9876543210");
    await verifyMobileFor(c.auth);
    await makePublishedRule();

    // Passes today.
    await request(app)
      .post("/api/consumer/applications")
      .set("Authorization", c.auth)
      .send({ iso2: "AE", purpose: "TOURIST" })
      .expect(201);

    // Changes their number...
    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ mobile: "9123456780" })
      .expect(200);

    // ...and is stopped on the next submit.
    const res = await request(app)
      .post("/api/consumer/applications")
      .set("Authorization", c.auth)
      .send({ iso2: "AE", purpose: "TOURIST" })
      .expect(403);

    expect(res.body.code).toBe("MOBILE_NOT_VERIFIED");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 5. ABUSE SURFACE — EVERY SEND COSTS MONEY
 * ══════════════════════════════════════════════════════════════════════ */

describe("send is rate limited", () => {
  it("caps sends at 5 per consumer per hour and 429s the sixth", async () => {
    const c = await makeConsumerWithMobile("flood@helloviza.test", "9876543210");

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/consumer/mobile/otp/send")
        .set("Authorization", c.auth)
        .send({})
        .expect(200);
    }

    const blocked = await request(app)
      .post("/api/consumer/mobile/otp/send")
      .set("Authorization", c.auth)
      .send({})
      .expect(429);

    expect(blocked.body.code).toBe("OTP_RATE_LIMITED");
    // Five SMS, not six — the limiter refused before the provider call.
    expect(msg91Calls).toHaveLength(5);
  });

  it("RESEND DRAWS FROM THE SAME BUCKET — 5 sends + 1 resend is still capped", async () => {
    const c = await makeConsumerWithMobile("sharedbucket@helloviza.test", "9876543210");

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/consumer/mobile/otp/send")
        .set("Authorization", c.auth)
        .send({})
        .expect(200);
    }

    await request(app)
      .post("/api/consumer/mobile/otp/resend")
      .set("Authorization", c.auth)
      .send({})
      .expect(429);

    expect(msg91Calls).toHaveLength(5);
  });

  it("one consumer's flood does not exhaust another's allowance", async () => {
    const flooder = await makeConsumerWithMobile("noisy@helloviza.test", "9876543210");
    const bystander = await makeConsumerWithMobile("quiet@helloviza.test", "9123456780");

    for (let i = 0; i < 6; i++) {
      await request(app)
        .post("/api/consumer/mobile/otp/send")
        .set("Authorization", flooder.auth)
        .send({});
    }

    await request(app)
      .post("/api/consumer/mobile/otp/send")
      .set("Authorization", bystander.auth)
      .send({})
      .expect(200);
  });

  it("the Turnstile gate is FAIL-CLOSED when the bypass is off and no secret is set", async () => {
    const c = await makeConsumerWithMobile("turnstile@helloviza.test", "9876543210");

    process.env.TURNSTILE_DEV_BYPASS = "false";
    try {
      await request(app)
        .post("/api/consumer/mobile/otp/send")
        .set("Authorization", c.auth)
        .send({})
        .expect(400);

      expect(msg91Calls).toHaveLength(0);
    } finally {
      process.env.TURNSTILE_DEV_BYPASS = "true";
    }
  });
});

/*
 * The verify limiter had NO coverage before this, which mattered once the
 * codes shrank to 4 digits: its `max` is the only thing bounding guesses
 * against an outstanding code, and an accidental loosening of it would have
 * been invisible. Asserts the cap itself, not merely that a 429 is possible.
 */
describe("verify is rate limited", () => {
  it("caps verify attempts at 5 per consumer per 15 min and 429s the sixth", async () => {
    const c = await makeConsumerWithMobile("guess@helloviza.test", "9876543210");

    stubMsg91({ type: "error", message: "OTP not match" });

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/consumer/mobile/otp/verify")
        .set("Authorization", c.auth)
        .send({ code: "0000" })
        .expect(400);
    }

    const blocked = await request(app)
      .post("/api/consumer/mobile/otp/verify")
      .set("Authorization", c.auth)
      .send({ code: "0000" })
      .expect(429);

    expect(blocked.body.code).toBe("OTP_RATE_LIMITED");
    // Five provider calls, not six — the limiter refused before MSG91.
    expect(msg91Calls).toHaveLength(5);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 6. THE LOGIN KEY — Consumer.verifiedPhone
 * ══════════════════════════════════════════════════════════════════════
 * contact.mobileVerified answers "can we reach this person by SMS?" and
 * gates the submit path. Consumer.verifiedPhone answers "which account
 * does this number sign in to?" and is the unique, sparse index the public
 * OTP door resolves against. Two fields, two questions — and every test
 * below is about the ONE relationship that has to hold between them:
 *
 *   contact.mobileVerified === true  ⟹  Consumer.verifiedPhone === it
 *
 * Both directions of drift were live bugs. The badge could be set with no
 * key written (the mirror swallowed its own duplicate-key failure), and
 * the key could outlive the badge (changing your number cleared one and
 * not the other, leaving the old number able to sign in).
 * ══════════════════════════════════════════════════════════════════════ */

/** The consumers row as MONGO holds it — no Mongoose casting in between.
 *
 *  Needed because the distinction under test is ABSENT vs null vs "", and a
 *  hydrated document flattens all three to undefined. The sparse index only
 *  skips the first one, so only the raw read can prove the clear was safe. */
async function rawConsumer(id: any) {
  return mongoose.connection.db!.collection("consumers").findOne({ _id: id });
}

describe("verify writes the login key, and will not claim verified without it", () => {
  it("mirrors the proven number to Consumer.verifiedPhone", async () => {
    const c = await makeConsumerWithMobile("mirror@helloviza.test", "9811100001");
    await verifyMobileFor(c.auth);

    const fresh = await Consumer.findById(c.consumer._id);
    expect(fresh?.verifiedPhone).toBe("9811100001");
  });

  it("409s when ANOTHER account already verified that number", async () => {
    // The index entry is taken. Whether that other account is real or a
    // leftover is not this endpoint's business — it cannot have the key.
    await Consumer.create({
      email: "holder@helloviza.test",
      name: "Holder",
      verifiedPhone: "9811100002",
    });
    const c = await makeConsumerWithMobile("second@helloviza.test", "9811100002");

    stubMsg91({ type: "success", message: "OTP verified success" });
    const res = await request(app)
      .post("/api/consumer/mobile/otp/verify")
      .set("Authorization", c.auth)
      .send({ code: "1234" })
      .expect(409);

    expect(res.body.code).toBe("PHONE_ON_ANOTHER_ACCOUNT");
    // Not the old lie. The response must never say this succeeded.
    expect(res.body.verified).toBeUndefined();
  });

  it("DOES NOT SET THE BADGE when the key could not be written", async () => {
    // The regression that mattered: MSG91 says yes, the mirror says no, and
    // the profile used to keep the flag anyway — a verified badge with no
    // login key behind it, on a number belonging to somebody else.
    await Consumer.create({
      email: "holder2@helloviza.test",
      name: "Holder",
      verifiedPhone: "9811100003",
    });
    const c = await makeConsumerWithMobile("second2@helloviza.test", "9811100003");

    stubMsg91({ type: "success", message: "OTP verified success" });
    await request(app)
      .post("/api/consumer/mobile/otp/verify")
      .set("Authorization", c.auth)
      .send({ code: "1234" })
      .expect(409);

    const p = await ConsumerProfile.findOne({ consumerId: c.consumer._id });
    expect(p?.contact?.mobileVerified).toBe(false);
    expect(p?.contact?.mobileVerifiedAt ?? null).toBeNull();

    // And the key stayed with the account that earned it.
    const mine = await Consumer.findById(c.consumer._id);
    expect(mine?.verifiedPhone ?? null).toBeNull();
  });

  it("the refused account is still BLOCKED at the submit gate", async () => {
    /* Why the badge and the key must move together, stated as the thing a
     * user can actually do. Without this, one SIM yields any number of
     * gate-passing identities: sign up again under a new address, verify
     * the same number, and the unique index — the constraint meant to stop
     * exactly that — is bypassed, because the gate reads the unindexed
     * flag and the flag was set regardless. */
    await Consumer.create({
      email: "holder3@helloviza.test",
      name: "Holder",
      verifiedPhone: "9811100004",
    });
    const c = await makeConsumerWithMobile("second3@helloviza.test", "9811100004");
    await makePublishedRule();

    stubMsg91({ type: "success", message: "OTP verified success" });
    await request(app)
      .post("/api/consumer/mobile/otp/verify")
      .set("Authorization", c.auth)
      .send({ code: "1234" })
      .expect(409);

    const res = await request(app)
      .post("/api/consumer/applications")
      .set("Authorization", c.auth)
      .send({ iso2: "AE", purpose: "TOURIST" })
      .expect(403);

    expect(res.body.code).toBe("MOBILE_NOT_VERIFIED");
    expect(await VisaApplication.countDocuments({})).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 7. CHANGING THE NUMBER RELEASES THE KEY — the security invariant
 * ══════════════════════════════════════════════════════════════════════ */

describe("changing the number releases the login key", () => {
  it("A REMOVED NUMBER CAN NO LONGER SIGN IN", async () => {
    /* THE INVARIANT THIS WHOLE SECTION EXISTS FOR.
     *
     * Deliberately asked at the PUBLIC door rather than by inspecting the
     * field: "the column is empty" is an implementation detail, "the old
     * number does not open this account" is the security property. Before
     * the fix this test got mode:"login" and a set of session cookies for
     * a number the owner had already replaced. */
    const c = await makeConsumerWithMobile("released@helloviza.test", "9811100010");
    await verifyMobileFor(c.auth);
    expect((await Consumer.findById(c.consumer._id))?.verifiedPhone).toBe("9811100010");

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ mobile: "9811100011" })
      .expect(200);

    stubMsg91({ type: "success", message: "OTP verified success" });
    const res = await request(app)
      .post("/api/consumer/auth/mobile/verify")
      .send({ mobile: "9811100010", code: "1234" })
      .expect(200);

    expect(res.body.mode).toBe("signup_required");
    expect(res.body.consumer).toBeUndefined();
  });

  it("clears it by REMOVING the field, never by writing null or the empty string", async () => {
    /* The sparse index skips ABSENT fields and nothing else. A null or a ""
     * is a present value, so every cleared account would pile onto one
     * index key and the SECOND clear would die with a duplicate-key error
     * — see the two-empty-strings case in consumerPhonePhase1.test.ts. */
    const c = await makeConsumerWithMobile("unset@helloviza.test", "9811100012");
    await verifyMobileFor(c.auth);

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ mobile: "9811100013" })
      .expect(200);

    const raw = await rawConsumer(c.consumer._id);
    expect("verifiedPhone" in raw!).toBe(false);
  });

  it("a SECOND account clearing its number does not collide with the first", async () => {
    // The direct consequence of the line above, proved rather than argued.
    const a = await makeConsumerWithMobile("clearA@helloviza.test", "9811100014");
    await verifyMobileFor(a.auth);
    const b = await makeConsumerWithMobile("clearB@helloviza.test", "9811100015");
    await verifyMobileFor(b.auth);

    for (const [c, next] of [
      [a, "9811100016"],
      [b, "9811100017"],
    ] as const) {
      await request(app)
        .patch("/api/consumer/profile/contact")
        .set("Authorization", c.auth)
        .send({ mobile: next })
        .expect(200);
    }

    expect("verifiedPhone" in (await rawConsumer(a.consumer._id))!).toBe(false);
    expect("verifiedPhone" in (await rawConsumer(b.consumer._id))!).toBe(false);
  });

  it("releases it when the number is CLEARED rather than replaced", async () => {
    // "I do not want a number on file" has to revoke the login too.
    const c = await makeConsumerWithMobile("emptied@helloviza.test", "9811100018");
    await verifyMobileFor(c.auth);

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ mobile: "" })
      .expect(200);

    expect("verifiedPhone" in (await rawConsumer(c.consumer._id))!).toBe(false);
  });

  it("KEEPS the key when the number is re-saved unchanged", async () => {
    // The mirror of the existing mobileVerified case: a contact-tab save
    // that changes an address must not cost somebody their OTP login.
    const c = await makeConsumerWithMobile("keepkey@helloviza.test", "9811100019");
    await verifyMobileFor(c.auth);

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ mobile: "9811100019", currentAddress: { city: "Pune" } })
      .expect(200);

    expect((await Consumer.findById(c.consumer._id))?.verifiedPhone).toBe("9811100019");
  });

  it("KEEPS the key when only the FORMATTING changes", async () => {
    const c = await makeConsumerWithMobile("reformat@helloviza.test", "9811100020");
    await verifyMobileFor(c.auth);

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ mobile: "+91 98111 00020" })
      .expect(200);

    expect((await Consumer.findById(c.consumer._id))?.verifiedPhone).toBe("9811100020");
  });

  it("KEEPS the key when the contact tab is saved without touching mobile", async () => {
    const c = await makeConsumerWithMobile("untouched@helloviza.test", "9811100021");
    await verifyMobileFor(c.auth);

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", c.auth)
      .send({ currentAddress: { city: "Kochi" } })
      .expect(200);

    expect((await Consumer.findById(c.consumer._id))?.verifiedPhone).toBe("9811100021");
  });

  it("HANDS THE NUMBER BACK to whoever actually holds the SIM", async () => {
    /* The two bugs compounding, and the proof that fixing both undoes it.
     *
     * A verifies a number and later moves on from it. B, who now holds that
     * SIM, tries to verify it. Before: A's row kept the index entry
     * forever, so B's mirror hit E11000 — which was swallowed, so B was
     * told "verified" and then could never sign in with it. The number was
     * permanently unusable and nobody was told why. */
    const a = await makeConsumerWithMobile("previous@helloviza.test", "9811100022");
    await verifyMobileFor(a.auth);

    await request(app)
      .patch("/api/consumer/profile/contact")
      .set("Authorization", a.auth)
      .send({ mobile: "9811100023" })
      .expect(200);

    const b = await makeConsumerWithMobile("current@helloviza.test", "9811100022");
    await verifyMobileFor(b.auth);

    expect((await Consumer.findById(b.consumer._id))?.verifiedPhone).toBe("9811100022");

    // And the number now signs B in — the whole point of releasing it.
    stubMsg91({ type: "success", message: "OTP verified success" });
    const res = await request(app)
      .post("/api/consumer/auth/mobile/verify")
      .send({ mobile: "9811100022", code: "1234" })
      .expect(200);

    expect(res.body.mode).toBe("login");
    expect(res.body.consumer?.email).toBe("current@helloviza.test");
  });
});
