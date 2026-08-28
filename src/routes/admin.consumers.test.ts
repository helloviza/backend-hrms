// The consumer registry, over real HTTP against a real
// mongodb-memory-server — never importing server.ts, which would boot the
// whole app and dial the cluster the dev backend points at. A minimal
// express app mounts the real routers at their real prefixes instead, the
// same convention consumer.auth.test.ts sets.
//
// ══════════════════════════════════════════════════════════════════════
// WHAT THESE TESTS ARE ACTUALLY FOR
// ══════════════════════════════════════════════════════════════════════
// Three claims, and every one of them is asserted on the RESPONSE BODY
// rather than on a rendered screen — because "a non-admin cannot see the
// address" is a statement about bytes on the wire, and a test that
// inspected a component would prove nothing about what the API sent.
//
//   1. Consent is written on signup ONLY when it was actually given, and
//      an unticked box writes NOTHING (not `optedIn: false`).
//   2. The list is plaintext-only — no ConsumerProfile read, proven by
//      spying on the model and asserting zero calls, not by reading code.
//   3. The tier holds: a Super Admin's bytes contain the real email and
//      phone; a non-Super-Admin's bytes contain neither, anywhere.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

const B2B_SECRET = "b2b-jwt-secret-for-tests";
const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;
process.env.CONSUMER_COOKIE_DOMAIN = ".helloviza.ai";
process.env.COOKIE_DOMAIN = ".plumtrips.com";

// config/env.ts hard-requires these and throws at import time without them.
// The worktree has no .env (correctly gitignored). Nothing under test reads
// them — same preamble as consumer.auth.test.ts.
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/admin-consumers-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Consumer } = await import("../models/Consumer.js");
const { default: ConsumerProfile } = await import("../models/ConsumerProfile.js");
const { default: SavedCountry } = await import("../models/SavedCountry.js");
const { default: VisaD2CLead } = await import("../models/VisaD2CLead.js");
const { default: VisaApplication } = await import("../models/VisaApplication.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: adminConsumersRouter } = await import("./admin.consumers.js");
const { default: consumerAuthRouter } = await import("./consumer.auth.js");
const { MARKETING_CONSENT_VERSION } = await import("./consumer.auth.js");
const { HELLOVIZA_D2C_WORKSPACE_ID } = await import("../services/consumerWorkspace.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/consumer/auth", consumerAuthRouter);
  a.use("/api/admin/consumers", adminConsumersRouter);
  return a;
}

/* The two callers. Both are real B2B users with real signed tokens — the
 * ONLY difference between them is the SUPERADMIN role, which is precisely
 * the variable the tier turns on. */
const SUPER_ID = new mongoose.Types.ObjectId();
const STAFF_ID = new mongoose.Types.ObjectId();

function tokenFor(id: mongoose.Types.ObjectId, roles: string[]) {
  return jwt.sign({ sub: String(id), id: String(id), email: "x@plumtrips.com", roles }, B2B_SECRET, {
    expiresIn: "1h",
  });
}

const SUPER_TOKEN = tokenFor(SUPER_ID, ["SUPERADMIN"]);
/* Holds visaApplication:READ via a real UserPermission row (seeded below),
 * so this caller passes the gate and reaches the handler — which is the
 * only interesting kind of non-Super-Admin. A caller who is refused at the
 * gate proves nothing about masking. */
const STAFF_TOKEN = tokenFor(STAFF_ID, ["OPS"]);

const REAL_EMAIL = "priya.sharma@gmail.com";
const REAL_PHONE = "+919876544417";
const REAL_MOBILE = "+919812345678";
const REAL_PASSPORT = "Z1234567";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    Consumer.deleteMany({}),
    ConsumerProfile.deleteMany({}),
    SavedCountry.deleteMany({}),
    VisaD2CLead.deleteMany({}),
    VisaApplication.deleteMany({}),
    UserPermission.deleteMany({}),
  ]);

  await UserPermission.create({
    userId: String(STAFF_ID),
    email: "ops@plumtrips.com",
    workspaceId: "house",
    universe: "STAFF",
    level: { code: "L4", name: "Ops" },
    modules: { visaApplication: { access: "READ", scope: "ALL" } },
    grantedBy: String(SUPER_ID),
  });
});

/* ═══════════════════════════════════════════════════════════════════
 * 1. CONSENT IS WRITTEN ON SIGNUP — AND ONLY WHEN IT WAS GIVEN
 * ═══════════════════════════════════════════════════════════════ */
describe("signup captures marketing consent", () => {
  it("writes both channels with at/source/version when the box was ticked", async () => {
    const before = Date.now();
    const res = await request(app()).post("/api/consumer/auth/signup").send({
      email: "ticked@example.com",
      name: "Ticked",
      password: "correct-horse",
      marketingConsentEmail: true,
      marketingConsentWhatsapp: true,
    });
    expect(res.status).toBe(201);

    const doc: any = await Consumer.findOne({ email: "ticked@example.com" }).lean();
    expect(doc.marketingConsent.email.optedIn).toBe(true);
    expect(doc.marketingConsent.email.source).toBe("signup");
    expect(doc.marketingConsent.email.version).toBe(MARKETING_CONSENT_VERSION);
    // A real instant, from this request — not a placeholder and not the
    // epoch. The whole point of `at` is that it is evidence.
    expect(new Date(doc.marketingConsent.email.at).getTime()).toBeGreaterThanOrEqual(before - 1000);

    expect(doc.marketingConsent.whatsapp.optedIn).toBe(true);
    expect(doc.marketingConsent.whatsapp.source).toBe("signup");
  });

  it("writes NOTHING when the box was left unticked", async () => {
    const res = await request(app()).post("/api/consumer/auth/signup").send({
      email: "unticked@example.com",
      name: "Unticked",
      password: "correct-horse",
      marketingConsentEmail: false,
      marketingConsentWhatsapp: false,
    });
    expect(res.status).toBe(201);

    const doc: any = await Consumer.findOne({ email: "unticked@example.com" }).lean();
    /* ⚠ THE ASSERTION THAT MATTERS. Not `optedIn === false` — the field
     * must be ABSENT. A stored `{ optedIn: false, at: … }` would be a
     * fabricated consent event: a record claiming this person actively
     * declined at a moment when they simply did not click anything. */
    expect(doc.marketingConsent).toBeUndefined();
  });

  it("is non-breaking: a body with no consent keys at all still signs up", async () => {
    const res = await request(app())
      .post("/api/consumer/auth/signup")
      .send({ email: "legacy@example.com", name: "Legacy", password: "correct-horse" });
    expect(res.status).toBe(201);

    const doc: any = await Consumer.findOne({ email: "legacy@example.com" }).lean();
    expect(doc.name).toBe("Legacy");
    expect(doc.marketingConsent).toBeUndefined();
  });

  it("refuses to be opted in by a truthy non-true value", async () => {
    /* "false" and "0" are TRUTHY strings in JS. A truthiness test here
     * would silently opt somebody in on a malformed body — which is the
     * exact failure buildSignupConsent()'s strict equality exists to make
     * impossible, so it is asserted rather than assumed. */
    const res = await request(app()).post("/api/consumer/auth/signup").send({
      email: "truthy@example.com",
      name: "Truthy",
      password: "correct-horse",
      marketingConsentEmail: "false",
      marketingConsentWhatsapp: "0",
    });
    expect(res.status).toBe(201);

    const doc: any = await Consumer.findOne({ email: "truthy@example.com" }).lean();
    expect(doc.marketingConsent).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════
 * 2. THE LIST IS PLAINTEXT-ONLY
 * ═══════════════════════════════════════════════════════════════ */
describe("GET /api/admin/consumers — the list", () => {
  async function seed() {
    const older: any = await Consumer.create({
      email: "older@example.com",
      name: "Older",
      passwordHash: "x",
      marketingConsent: {
        email: { optedIn: true, at: new Date(), source: "signup", version: "2026-08-v1" },
      },
    });
    const newer: any = await Consumer.create({
      email: REAL_EMAIL,
      name: "Priya Sharma",
      phone: REAL_PHONE,
      passwordHash: "x",
      authProvider: "google",
      googleSub: "google-sub-123",
    });

    await SavedCountry.create([
      { consumerId: newer._id, workspaceId: HELLOVIZA_D2C_WORKSPACE_ID, iso2: "TH", source: "manual" },
      { consumerId: newer._id, workspaceId: HELLOVIZA_D2C_WORKSPACE_ID, iso2: "AE", source: "manual" },
    ]);
    await VisaD2CLead.create({
      consumerId: newer._id,
      workspaceId: HELLOVIZA_D2C_WORKSPACE_ID,
      destinationIso2: "TH",
      destinationName: "Thailand",
      startedAt: new Date(),
    });
    /* The two snapshots are `required` on the real schema and are
     * irrelevant to this test — the registry only ever counts these rows
     * and reads their reference/status. Empty subdocuments satisfy the
     * requirement without inventing a fake rule the assertions would then
     * be tempted to read. */
    await VisaApplication.create({
      consumerId: newer._id,
      workspaceId: HELLOVIZA_D2C_WORKSPACE_ID,
      source: "D2C",
      destinationIso2: "TH",
      nationality: "IN",
      ruleSnapshot: {
        ruleId: new mongoose.Types.ObjectId(),
        destinationName: "Thailand",
        purpose: "TOURIST",
        visaCategory: "E_VISA",
        entryType: "SINGLE",
        serviceTier: "STANDARD",
        productClass: "VISA",
        isSchengen: false,
        capturedAt: new Date(),
      },
      indicativeCostSnapshot: { totalInr: 0, displayMode: "INDICATIVE" },
    });
    return { older, newer };
  }

  it("returns rows newest-first with the derived counts joined", async () => {
    const { newer } = await seed();
    const res = await request(app())
      .get("/api/admin/consumers")
      .set("Authorization", `Bearer ${SUPER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    // Newest first — `newer` was created second.
    expect(res.body.rows[0].id).toBe(String(newer._id));

    const row = res.body.rows[0];
    /* The three $in aggregations. A 0 here would be the SILENT failure
     * mode this route's ObjectId-cast comment warns about — aggregate()
     * does no casting, so a string $in matches nothing and every count
     * reads zero with no error anywhere. These numbers are the proof the
     * cast is right. */
    expect(row.savedCountryCount).toBe(2);
    expect(row.leadCount).toBe(1);
    expect(row.applicationCount).toBe(1);
    expect(row.latestLead.destinationIso2).toBe("TH");
    // Enum PLUS label — the console holds no copy of the vocabulary.
    expect(row.latestLead.stage).toBeTruthy();
    expect(row.latestLead.stageLabel).toBeTruthy();

    expect(res.body.summary).toEqual({ total: 2, optedInEmail: 1, optedInWhatsapp: 0 });
  });

  it("NEVER reads ConsumerProfile — the encrypted collection is untouched", async () => {
    await seed();
    /* Proven by observation, not by reading the source. Any find/findOne/
     * aggregate against the encrypted collection increments one of these,
     * so this test fails the day somebody "helpfully" joins the profile in
     * to add a column — which is exactly the change that would put
     * `penc.1.…` ciphertext on an agent's screen. */
    const find = vi.spyOn(ConsumerProfile, "find");
    const findOne = vi.spyOn(ConsumerProfile, "findOne");
    const aggregate = vi.spyOn(ConsumerProfile, "aggregate");

    const res = await request(app())
      .get("/api/admin/consumers")
      .set("Authorization", `Bearer ${SUPER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(find).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("filters by consent, provider and has-applied", async () => {
    await seed();
    const get = (qs: string) =>
      request(app()).get(`/api/admin/consumers?${qs}`).set("Authorization", `Bearer ${SUPER_TOKEN}`);

    expect((await get("consent=email")).body.rows).toHaveLength(1);
    expect((await get("consent=whatsapp")).body.rows).toHaveLength(0);
    // `none` must catch the row where the field is ABSENT entirely, which
    // is the common case and the one a presence test would miss.
    expect((await get("consent=none")).body.rows).toHaveLength(1);
    expect((await get("authProvider=google")).body.rows).toHaveLength(1);
    expect((await get("authProvider=password")).body.rows).toHaveLength(1);
    expect((await get("hasApplied=true")).body.rows).toHaveLength(1);
    expect((await get("hasApplied=false")).body.rows).toHaveLength(1);
  });

  it("counts a consumer with NO authProvider field as password", async () => {
    await seed();
    /* Rows written before authProvider existed carry no such field — a
     * Mongoose `default` applies only to documents Mongoose writes. Three
     * of the consumers on the live system are in exactly this state, so
     * the raw insert here is the real shape, not a contrived one.
     *
     * The shaped row SHOWS "password" via `?? "password"`; the filter must
     * agree, or the list displays a consumer as Email while the Email
     * filter refuses to return them. */
    await Consumer.collection.insertOne({
      email: "ancient@example.com",
      name: "Ancient",
      tokenVersion: 0,
      status: "ACTIVE",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as any);

    const res = await request(app())
      .get("/api/admin/consumers?authProvider=password")
      .set("Authorization", `Bearer ${SUPER_TOKEN}`);
    const emails = res.body.rows.map((r: any) => r.email);
    expect(emails).toContain("ancient@example.com");
    expect(res.body.rows.find((r: any) => r.email === "ancient@example.com").authProvider).toBe(
      "password",
    );
    // …and is still excluded from the google filter, which is the other
    // half of the same claim.
    const g = await request(app())
      .get("/api/admin/consumers?authProvider=google")
      .set("Authorization", `Bearer ${SUPER_TOKEN}`);
    expect(g.body.rows.map((r: any) => r.email)).not.toContain("ancient@example.com");
  });

  it("ANDs two OR-shaped filters instead of letting one clobber the other", async () => {
    await seed();
    /* Both `consent=any` and `authProvider=password` need an OR. A
     * document has one `$or` key, so assigning both to `filter.$or` would
     * silently drop the first — returning rows matching only ONE of the
     * two filters the caller asked for, with no error. `older` is the
     * opted-in one AND is a password account, so it is the only row that
     * satisfies both; `newer` is a google account and must not appear. */
    const res = await request(app())
      .get("/api/admin/consumers?consent=any&authProvider=password")
      .set("Authorization", `Bearer ${SUPER_TOKEN}`);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].email).toBe("older@example.com");
  });

  it("summary counts never contradict the filtered rows", async () => {
    await seed();
    /* ?consent=none returns people who have NOT opted in, so "opted in"
     * within that set is zero by definition. A spread-merged count would
     * overwrite the base filter's own key and report a nonzero number
     * above a table of people who did not opt in. */
    const res = await request(app())
      .get("/api/admin/consumers?consent=none")
      .set("Authorization", `Bearer ${SUPER_TOKEN}`);
    expect(res.body.summary.optedInEmail).toBe(0);
    expect(res.body.summary.optedInWhatsapp).toBe(0);
    expect(res.body.summary.total).toBe(res.body.rows.length);
  });

  it("paginates", async () => {
    await seed();
    const res = await request(app())
      .get("/api/admin/consumers?limit=1&page=2")
      .set("Authorization", `Bearer ${SUPER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
  });

  it("refuses a caller with no visaApplication permission at all", async () => {
    await seed();
    const nobody = tokenFor(new mongoose.Types.ObjectId(), ["EMPLOYEE"]);
    const res = await request(app())
      .get("/api/admin/consumers")
      .set("Authorization", `Bearer ${nobody}`);
    expect(res.status).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════
 * 3. THE TIER — ASSERTED ON THE RESPONSE BYTES
 * ═══════════════════════════════════════════════════════════════ */
describe("the 3-tier PII masking", () => {
  async function seedOne() {
    const c: any = await Consumer.create({
      email: REAL_EMAIL,
      name: "Priya Sharma",
      phone: REAL_PHONE,
      passwordHash: "x",
    });
    // Written through .save() so the field-encryption plugin actually
    // encrypts — an insertMany/updateOne would not exercise the real path.
    await ConsumerProfile.create({
      consumerId: c._id,
      workspaceId: HELLOVIZA_D2C_WORKSPACE_ID,
      personal: { firstName: "Priya", lastName: "Sharma", dateOfBirth: new Date("1992-04-11") },
      contact: { mobile: REAL_MOBILE },
      passports: [{ number: REAL_PASSPORT, isPrimary: true, issuingCountry: "IN" }],
    });
    return c;
  }

  it("Super Admin: the detail returns decrypted PII in full", async () => {
    const c = await seedOne();
    const res = await request(app())
      .get(`/api/admin/consumers/${c._id}`)
      .set("Authorization", `Bearer ${SUPER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.viewer.canSeeFullPii).toBe(true);
    expect(res.body.consumer.email).toBe(REAL_EMAIL);
    expect(res.body.consumer.phone).toBe(REAL_PHONE);
    // Decrypted, not ciphertext — proves the findOne path ran the plugin.
    expect(res.body.contact.mobile).toBe(REAL_MOBILE);
    expect(res.body.identity.passportNo).toBe(REAL_PASSPORT);
    expect(res.body.identity.dob).toBe("1992-04-11");
  });

  it("non-Super-Admin: the detail bytes contain NO real value anywhere", async () => {
    const c = await seedOne();
    const res = await request(app())
      .get(`/api/admin/consumers/${c._id}`)
      .set("Authorization", `Bearer ${STAFF_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.viewer.canSeeFullPii).toBe(false);

    // The masked shapes, positively asserted.
    expect(res.body.consumer.email).toBe("p•••@gmail.com");
    expect(res.body.consumer.phone).toBe("+91 •••••• 4417");
    expect(res.body.contact.mobile).toBe("+91 •••••• 5678");
    expect(res.body.identity.passportNo).toBe("****4567");
    expect(res.body.identity.dob).toBe("••••-••-••");

    /* ⚠ THE CRITICAL ASSERTION. Not a field-by-field check — the WHOLE
     * serialised body, searched for each real value. This is what catches
     * a leak through a sibling field, a nested object, an echo of the
     * query, or a field somebody adds next year without thinking about
     * this tier. If the string is not in the bytes, the reader cannot
     * have it. */
    const bytes = JSON.stringify(res.body);
    expect(bytes).not.toContain(REAL_EMAIL);
    expect(bytes).not.toContain(REAL_PHONE);
    expect(bytes).not.toContain(REAL_MOBILE);
    expect(bytes).not.toContain(REAL_PASSPORT);
    expect(bytes).not.toContain("1992-04-11");
    // And no ciphertext either — a `penc.1.…` envelope reaching the client
    // would be its own kind of failure.
    expect(bytes).not.toContain("penc.");
  });

  it("non-Super-Admin: the LIST is masked too — the sibling-response leak", async () => {
    await seedOne();
    /* Masking only the detail would be theatre: `?limit=100` would hand
     * back every address in the collection in plaintext. This is the test
     * that makes the tier mean something. */
    const res = await request(app())
      .get("/api/admin/consumers")
      .set("Authorization", `Bearer ${STAFF_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].email).toBe("p•••@gmail.com");
    expect(res.body.rows[0].phone).toBe("+91 •••••• 4417");
    expect(res.body.rows[0].piiMasked).toBe(true);

    const bytes = JSON.stringify(res.body);
    expect(bytes).not.toContain(REAL_EMAIL);
    expect(bytes).not.toContain(REAL_PHONE);
  });

  it("has no unmask escape hatch", async () => {
    const c = await seedOne();
    /* Every plausible bypass a reader might try, in one place. If any of
     * these ever starts working, this test says so. */
    for (const qs of ["unmask=true", "full=true", "raw=1", "reveal=true", "piiMasked=false"]) {
      const res = await request(app())
        .get(`/api/admin/consumers/${c._id}?${qs}`)
        .set("Authorization", `Bearer ${STAFF_TOKEN}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(REAL_EMAIL);
    }
  });

  it("masking does not corrupt the stored value", async () => {
    const c = await seedOne();
    await request(app())
      .get(`/api/admin/consumers/${c._id}`)
      .set("Authorization", `Bearer ${STAFF_TOKEN}`);

    /* The masked read is a RESPONSE transform and nothing else. A campaign
     * sender reading this collection server-side later must still find the
     * real address — so the row is re-read from the database after a
     * masked request and checked byte for byte. */
    const stored: any = await Consumer.findById(c._id).lean();
    expect(stored.email).toBe(REAL_EMAIL);
    expect(stored.phone).toBe(REAL_PHONE);

    const profile: any = await ConsumerProfile.findOne({ consumerId: c._id }).lean();
    expect(profile.contact.mobile).toBe(REAL_MOBILE);
    expect(profile.passports[0].number).toBe(REAL_PASSPORT);
  });
});
