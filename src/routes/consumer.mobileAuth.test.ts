// Phase 2 of mobile-OTP: the PUBLIC consumer OTP auth routes.
//
// Against a real mongodb-memory-server with built indexes, and a stubbed
// global.fetch standing in for MSG91 — a paid third party that must never be
// reached from a test run, and whose live credential must never be needed to
// run one.
//
// ── RATE LIMITS ARE PROCESS-WIDE STATE ──────────────────────────────────
// express-rate-limit keeps its counters in module memory, so buckets survive
// between tests in this file. Every test therefore uses its OWN phone number
// (nextMobile()), except the limiter tests, which reuse a number on purpose.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";
process.env.JWT_SECRET = "b2b-jwt-secret-for-tests";
process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;
process.env.CONSUMER_COOKIE_DOMAIN = ".helloviza.ai";
process.env.COOKIE_DOMAIN = ".plumtrips.com";
// The Turnstile gate fails CLOSED with no secret. Non-production bypass is
// the documented way to run without one; NODE_ENV is not "production" here.
process.env.TURNSTILE_DEV_BYPASS = "true";
delete process.env.TURNSTILE_SECRET;
// MSG91 is stubbed at the fetch layer, but the service refuses to call at all
// unless it believes it is configured.
process.env.MSG91_AUTH_KEY = "test-msg91-auth-key";
process.env.MSG91_VERIFY_TEMPLATE_ID = "test-verify-template-id";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-mobileauth-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Consumer } = await import("../models/Consumer.js");
const { default: ConsumerProfile } = await import("../models/ConsumerProfile.js");
const { default: User } = await import("../models/User.js");
const { default: mobileAuthRouter } = await import("./consumer.mobileAuth.js");
const { CONSUMER_ACCESS_COOKIE, CONSUMER_REFRESH_COOKIE, CONSUMER_AUDIENCE } = await import(
  "../config/consumerAuth.js"
);
const { ensureD2CWorkspace } = await import("../services/consumerWorkspace.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/consumer/auth/mobile", mobileAuthRouter);
  return a;
}

/* ── The MSG91 stub ─────────────────────────────────────────────────── */

let msg91Calls: string[] = [];

function stubMsg91(body: unknown) {
  global.fetch = vi.fn(async (url: any) => {
    msg91Calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;
}

const MSG91_OK = { type: "success", message: "OTP sent successfully" };
const MSG91_BAD_CODE = { type: "error", message: "OTP not match" };

/* ── A fresh number per test, so rate-limit buckets never overlap ───── */
let mobileSeq = 0;
function nextMobile(): string {
  mobileSeq += 1;
  // 9 + 9 digits, always ten long and always distinct.
  return `9${String(800000000 + mobileSeq).padStart(9, "0")}`;
}

const START = "/api/consumer/auth/mobile/start";
const VERIFY = "/api/consumer/auth/mobile/verify";
const COMPLETE = "/api/consumer/auth/mobile/complete";

function setCookies(res: any): string[] {
  return (res.headers["set-cookie"] as string[] | undefined) ?? [];
}
function hasCookie(res: any, name: string): boolean {
  return setCookies(res).some((c) => c.startsWith(`${name}=`));
}

/** Drive a full verify for a number with no account: returns the proof token. */
async function proofFor(mobile: string): Promise<string> {
  stubMsg91({ type: "success", message: "OTP verified success" });
  const res = await request(app()).post(VERIFY).send({ mobile, code: "1234" });
  expect(res.status).toBe(200);
  expect(res.body.mode).toBe("signup_required");
  return res.body.proofToken;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Consumer.syncIndexes();
  await ensureD2CWorkspace();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Consumer.deleteMany({});
  await ConsumerProfile.deleteMany({});
  await User.deleteMany({});
  msg91Calls = [];
  stubMsg91(MSG91_OK);
});

/* ══ POST /start ═════════════════════════════════════════════════════ */
describe("POST /start", () => {
  it("rejects a number it cannot normalise WITHOUT calling the provider", async () => {
    const res = await request(app()).post(START).send({ mobile: "+1 415 555 0100" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_MOBILE");
    // The point of rejecting early: junk must never cost a billable SMS.
    expect(msg91Calls).toHaveLength(0);
  });

  it("rejects an empty number without calling the provider", async () => {
    const res = await request(app()).post(START).send({});
    expect(res.status).toBe(400);
    expect(msg91Calls).toHaveLength(0);
  });

  it("sends a code and answers with the number MASKED, never in full", async () => {
    const mobile = nextMobile();
    const res = await request(app()).post(START).send({ mobile });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(msg91Calls).toHaveLength(1);
    expect(msg91Calls[0]).toContain(`mobile=91${mobile}`);
    expect(res.body.mobileMasked).toContain("•");
    expect(res.body.mobileMasked).not.toBe(mobile);
    expect(JSON.stringify(res.body)).not.toContain(mobile);
  });

  it("NO ENUMERATION: the response is identical whether an account exists", async () => {
    const known = nextMobile();
    const unknown = nextMobile();
    await Consumer.create({
      email: "known@example.com",
      name: "Known",
      verifiedPhone: known,
      authProvider: "mobile",
    });

    const a = await request(app()).post(START).send({ mobile: known });
    const b = await request(app()).post(START).send({ mobile: unknown });

    expect(a.status).toBe(b.status);
    // Same shape, same keys, and nothing that distinguishes the two cases.
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    expect(a.body.ok).toBe(b.body.ok);
    expect(JSON.stringify(a.body)).not.toMatch(/exist|account|register|login|signup/i);
  });
});

/* ══ POST /verify — LOGIN ════════════════════════════════════════════ */
describe("POST /verify — login", () => {
  it("logs in the account owning verifiedPhone and sets both cookies", async () => {
    const mobile = nextMobile();
    const consumer = await Consumer.create({
      email: "owner@example.com",
      name: "Owner",
      phone: mobile,
      verifiedPhone: mobile,
      authProvider: "mobile",
    });

    stubMsg91({ type: "success", message: "OTP verified success" });
    const res = await request(app()).post(VERIFY).send({ mobile, code: "1234" });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("login");
    expect(res.body.consumer.id).toBe(String(consumer._id));
    expect(res.body.consumer.email).toBe("owner@example.com");
    expect(hasCookie(res, CONSUMER_ACCESS_COOKIE)).toBe(true);
    expect(hasCookie(res, CONSUMER_REFRESH_COOKIE)).toBe(true);
    // Never leaks the hash, even though this account has none.
    expect(res.body.consumer.passwordHash).toBeUndefined();
  });

  it("finds the account whatever format the number is typed in", async () => {
    const mobile = nextMobile();
    await Consumer.create({
      email: "fmt@example.com",
      name: "Fmt",
      verifiedPhone: mobile,
      authProvider: "mobile",
    });
    stubMsg91({ type: "success", message: "OTP verified success" });
    const res = await request(app())
      .post(VERIFY)
      .send({ mobile: `+91 ${mobile}`, code: "1234" });
    expect(res.body.mode).toBe("login");
  });

  it("refuses a non-ACTIVE account — a second door must not bypass the status gate", async () => {
    const mobile = nextMobile();
    await Consumer.create({
      email: "disabled@example.com",
      name: "Disabled",
      verifiedPhone: mobile,
      authProvider: "mobile",
      status: "DISABLED",
    });
    stubMsg91({ type: "success", message: "OTP verified success" });
    const res = await request(app()).post(VERIFY).send({ mobile, code: "1234" });
    expect(res.status).toBe(403);
    expect(hasCookie(res, CONSUMER_ACCESS_COOKIE)).toBe(false);
  });

  it("does NOT match on the unverified phone hint — only verifiedPhone logs in", async () => {
    // Somebody typed this number at email signup and never proved it. It must
    // not be a login key, or an unverified claim would grant a session.
    const mobile = nextMobile();
    await Consumer.create({ email: "hint@example.com", name: "Hint", phone: mobile });
    stubMsg91({ type: "success", message: "OTP verified success" });
    const res = await request(app()).post(VERIFY).send({ mobile, code: "1234" });
    expect(res.body.mode).toBe("signup_required");
    expect(hasCookie(res, CONSUMER_ACCESS_COOKIE)).toBe(false);
  });
});

/* ══ POST /verify — SIGNUP ═══════════════════════════════════════════ */
describe("POST /verify — signup", () => {
  it("hands back a proof token and creates NOTHING", async () => {
    const mobile = nextMobile();
    stubMsg91({ type: "success", message: "OTP verified success" });
    const res = await request(app()).post(VERIFY).send({ mobile, code: "1234" });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("signup_required");
    expect(res.body.proofToken).toBeTruthy();
    expect(hasCookie(res, CONSUMER_ACCESS_COOKIE)).toBe(false);
    // No account, and no pending row of any kind.
    expect(await Consumer.countDocuments({})).toBe(0);
    expect(await ConsumerProfile.countDocuments({})).toBe(0);
  });

  it("mints a token carrying the normalised phone and the signup purpose", async () => {
    const mobile = nextMobile();
    const token = await proofFor(mobile);
    const claims: any = jwt.verify(token, CONSUMER_SECRET, { audience: CONSUMER_AUDIENCE });
    expect(claims.phone).toBe(mobile);
    expect(claims.purpose).toBe("mobile_signup");
    // Ten minutes, not a session lifetime.
    expect(claims.exp - claims.iat).toBe(600);
  });

  it("rejects a wrong code with one message for wrong AND expired", async () => {
    const mobile = nextMobile();
    stubMsg91(MSG91_BAD_CODE);
    const res = await request(app()).post(VERIFY).send({ mobile, code: "9999" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CODE");
    // Must not reveal whether a live code currently exists for this number.
    expect(res.body.error).toMatch(/incorrect or has expired/i);
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("requires a code at all", async () => {
    const res = await request(app()).post(VERIFY).send({ mobile: nextMobile() });
    expect(res.status).toBe(400);
    expect(msg91Calls).toHaveLength(0);
  });
});

/* ══ POST /complete ══════════════════════════════════════════════════ */
describe("POST /complete", () => {
  it("creates the account, the verified profile and a session", async () => {
    const mobile = nextMobile();
    const proofToken = await proofFor(mobile);

    const res = await request(app())
      .post(COMPLETE)
      .send({ proofToken, email: "New@Example.com", name: "New Person" });

    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("signup");
    expect(res.body.created).toBe(true);
    expect(hasCookie(res, CONSUMER_ACCESS_COOKIE)).toBe(true);
    expect(hasCookie(res, CONSUMER_REFRESH_COOKIE)).toBe(true);

    const doc: any = await Consumer.findOne({ email: "new@example.com" });
    expect(doc).toBeTruthy();
    expect(doc.name).toBe("New Person");
    expect(doc.authProvider).toBe("mobile");
    // BOTH fields, and both the proved number.
    expect(doc.phone).toBe(mobile);
    expect(doc.verifiedPhone).toBe(mobile);
    // No fabricated credential.
    expect(doc.passwordHash).toBeUndefined();

    const profile: any = await ConsumerProfile.findOne({ consumerId: doc._id });
    expect(profile.contact.mobile).toBe(mobile);
    expect(profile.contact.mobileVerified).toBe(true);
    expect(profile.contact.mobileVerifiedAt).toBeTruthy();
  });

  it("records marketing consent through the shared builder", async () => {
    const proofToken = await proofFor(nextMobile());
    await request(app()).post(COMPLETE).send({
      proofToken,
      email: "consent@example.com",
      name: "Consent",
      marketingConsentEmail: true,
    });
    const doc: any = await Consumer.findOne({ email: "consent@example.com" });
    expect(doc.marketingConsent.email.optedIn).toBe(true);
    expect(doc.marketingConsent.email.source).toBe("signup");
    expect(doc.marketingConsent.whatsapp).toBeUndefined();
  });

  /* ── THE CENTRAL SECURITY INVARIANT ──────────────────────────────── */
  it("takes the phone from the TOKEN and IGNORES a body-supplied number", async () => {
    const proved = nextMobile();
    const someoneElses = nextMobile();
    const proofToken = await proofFor(proved);

    const res = await request(app()).post(COMPLETE).send({
      proofToken,
      email: "attacker@example.com",
      name: "Attacker",
      // The number they did NOT prove. If this were trusted, the OTP would
      // be decorative and anyone could claim any number's login key.
      mobile: someoneElses,
      phone: someoneElses,
      verifiedPhone: someoneElses,
    });

    expect(res.status).toBe(201);
    const doc: any = await Consumer.findOne({ email: "attacker@example.com" });
    expect(doc.verifiedPhone).toBe(proved);
    expect(doc.phone).toBe(proved);
    expect(doc.verifiedPhone).not.toBe(someoneElses);
    // And the number they tried to claim is still free for its real owner.
    expect(await Consumer.exists({ verifiedPhone: someoneElses })).toBeNull();
  });

  it("NO OTP, NO ACCOUNT: a request with no proof token creates nothing", async () => {
    const res = await request(app())
      .post(COMPLETE)
      .send({ email: "skip@example.com", name: "Skipper", mobile: nextMobile() });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROOF_INVALID");
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { phone: nextMobile(), purpose: "mobile_signup" },
      "not-the-consumer-secret",
      { expiresIn: 600, audience: CONSUMER_AUDIENCE },
    );
    const res = await request(app())
      .post(COMPLETE)
      .send({ proofToken: forged, email: "forged@example.com", name: "Forged" });
    expect(res.status).toBe(400);
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({ phone: nextMobile(), purpose: "mobile_signup" }, CONSUMER_SECRET, {
      expiresIn: -10,
      audience: CONSUMER_AUDIENCE,
    });
    const res = await request(app())
      .post(COMPLETE)
      .send({ proofToken: expired, email: "expired@example.com", name: "Expired" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROOF_INVALID");
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("rejects a correctly-signed token with the WRONG PURPOSE", async () => {
    // The shape of a consumer ACCESS token: same secret, same audience. The
    // purpose claim is the only thing keeping the two families disjoint.
    const sessionShaped = jwt.sign(
      { consumerId: "abc123", tokenVersion: 0, phone: nextMobile() },
      CONSUMER_SECRET,
      { expiresIn: "30m", audience: CONSUMER_AUDIENCE },
    );
    const res = await request(app())
      .post(COMPLETE)
      .send({ proofToken: sessionShaped, email: "wrongpurpose@example.com", name: "WP" });
    expect(res.status).toBe(400);
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("validates email and name the way /signup does", async () => {
    const t1 = await proofFor(nextMobile());
    const bad = await request(app())
      .post(COMPLETE)
      .send({ proofToken: t1, email: "not-an-email", name: "X" });
    expect(bad.status).toBe(400);

    const t2 = await proofFor(nextMobile());
    const noName = await request(app())
      .post(COMPLETE)
      .send({ proofToken: t2, email: "noname@example.com", name: "   " });
    expect(noName.status).toBe(400);
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("409s on an email that is already a consumer", async () => {
    await Consumer.create({ email: "taken@example.com", name: "Taken" });
    const proofToken = await proofFor(nextMobile());
    const res = await request(app())
      .post(COMPLETE)
      .send({ proofToken, email: "taken@example.com", name: "Second" });
    expect(res.status).toBe(409);
    expect(await Consumer.countDocuments({})).toBe(1);
  });

  it("409s with the B2B marker on a corporate address", async () => {
    await User.create({
      email: "corp@example.com",
      name: "Corp",
      passwordHash: "x",
      roles: ["EMPLOYEE"],
      // Required by workspaceScopePlugin on User; the B2B lookup itself is
      // global and does not scope, but the fixture still has to be valid.
      workspaceId: new mongoose.Types.ObjectId(),
    });
    const proofToken = await proofFor(nextMobile());
    const res = await request(app())
      .post(COMPLETE)
      .send({ proofToken, email: "corp@example.com", name: "Corp Person" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("B2B_ACCOUNT_EXISTS");
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("409s when the number was registered between /verify and /complete", async () => {
    const mobile = nextMobile();
    const proofToken = await proofFor(mobile);
    // The race: somebody else finished signup on this number in between.
    await Consumer.create({
      email: "faster@example.com",
      name: "Faster",
      verifiedPhone: mobile,
      authProvider: "mobile",
    });

    const res = await request(app())
      .post(COMPLETE)
      .send({ proofToken, email: "slower@example.com", name: "Slower" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PHONE_ALREADY_REGISTERED");
    expect(await Consumer.countDocuments({})).toBe(1);
  });

  it("a proof token is not single-use, but the unique index still holds", async () => {
    // Honest documentation of a real property: the token has no server-side
    // consumption, so replaying it is possible until it expires. The second
    // attempt cannot produce a second account on the same number, because
    // verifiedPhone is unique — the index, not the token, is the guard.
    const mobile = nextMobile();
    const proofToken = await proofFor(mobile);
    const first = await request(app())
      .post(COMPLETE)
      .send({ proofToken, email: "first@example.com", name: "First" });
    expect(first.status).toBe(201);

    const replay = await request(app())
      .post(COMPLETE)
      .send({ proofToken, email: "second@example.com", name: "Second" });
    expect(replay.status).toBe(409);
    expect(await Consumer.countDocuments({})).toBe(1);
  });
});

/* ══ THE RATE LIMITER ════════════════════════════════════════════════ */
describe("per-phone rate limiting", () => {
  it("a rapid second send for the SAME number is refused by the cooldown", async () => {
    const mobile = nextMobile();
    const first = await request(app()).post(START).send({ mobile });
    expect(first.status).toBe(200);

    const second = await request(app()).post(START).send({ mobile });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("OTP_COOLDOWN");
    // The refusal happened BEFORE the provider — no second billable SMS.
    expect(msg91Calls).toHaveLength(1);
  });

  it("NORMALISE BEFORE KEYING: a reformatted number hits the SAME bucket", async () => {
    // The bypass this guards: keyed on the raw string, "+91 98765 43210" and
    // "9876543210" are two buckets and the cap is defeated by a space.
    const mobile = nextMobile();
    const first = await request(app()).post(START).send({ mobile });
    expect(first.status).toBe(200);

    for (const variant of [`+91${mobile}`, `91${mobile}`, `+91 ${mobile}`]) {
      const res = await request(app()).post(START).send({ mobile: variant });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("OTP_COOLDOWN");
    }
    expect(msg91Calls).toHaveLength(1);
  });

  it("keys on the NUMBER, not the caller: a different number is unaffected", async () => {
    const a = nextMobile();
    const b = nextMobile();
    expect((await request(app()).post(START).send({ mobile: a })).status).toBe(200);
    expect((await request(app()).post(START).send({ mobile: a })).status).toBe(429);
    // Same client, same IP, different number — its own allowance.
    expect((await request(app()).post(START).send({ mobile: b })).status).toBe(200);
    expect(msg91Calls).toHaveLength(2);
  });
});
