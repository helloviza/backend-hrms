// The public Helloviza contract — reachability, the leak whitelist, the
// price gate, and lead capture. Real models on mongodb-memory-server; the
// real router mounted on a bare express app (never server.ts, which would
// boot the whole app and dial the production cluster the dev backend points
// at).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/public-visa-test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.CONSUMER_JWT_SECRET ||= "consumer-distinct-test-secret";
// Turnstile: exercised as a real fail-closed gate in its own describe block
// below; the lead happy-path tests set the dev bypass explicitly.
process.env.NODE_ENV = "test";

const { default: VisaRule } = await import("../models/VisaRule.js");
const { default: VisaDestinationContent } = await import("../models/VisaDestinationContent.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: publicVisaRouter } = await import("./public.visa.js");
const { travelRequestLimiter } = await import("../middleware/rateLimit.js");

// travelRequestLimiter is a REAL, shared, module-level limiter (15 min / 8 per
// IP) — deliberately reused rather than stubbed, so these tests exercise the
// gate the endpoint actually ships with. Its counter is process-global and
// every supertest request arrives from the same loopback address, so without
// this reset the suite would exhaust the window partway through and later
// tests would 429. Its own enforcement is proven explicitly in the
// "rate limiting" block below.
async function resetRateLimiter() {
  const anyLimiter = travelRequestLimiter as any;
  for (const key of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) {
    await anyLimiter.resetKey?.(key);
  }
}

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/public", publicVisaRouter);
  return a;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    VisaRule.deleteMany({}),
    VisaDestinationContent.deleteMany({}),
    ManualBooking.deleteMany({}),
  ]);
  delete process.env.TURNSTILE_SECRET;
  delete process.env.TURNSTILE_DEV_BYPASS;
  await resetRateLimiter();
});

/** TH is in the curated set (rank 1). ZW is not. */
async function makeRule(extra: Record<string, any> = {}) {
  return VisaRule.create({
    nationality: "IN",
    destinationIso2: "TH",
    purpose: "TOURIST",
    entryType: "SINGLE",
    serviceTier: "STANDARD",
    destinationName: "Thailand",
    productClass: "VISA",
    visaCategory: "E_VISA",
    status: "PUBLISHED",
    etaMinDays: 3,
    etaMaxDays: 7,
    etaBasis: "BUSINESS",
    maxStayDays: 60,
    validityDays: 90,
    embassyFeeInr: 8000,
    vfsFeeInr: 1500,
    plumtripsServiceFeeInr: 2000, // B2B — must NEVER surface publicly
    d2cServiceFeeInr: 3000,
    indicativeVisaCostInr: 99999, // must never surface either
    opsNotes: "INTERNAL ops note — must never surface",
    seedSource: "seed-visa-rules@2026-07",
    priceNote: "Fees are indicative.",
    effectiveFrom: new Date("2026-08-16"),
    documentGroups: [
      {
        key: "PASSPORT",
        label: "Passport",
        requirement: "REQUIRED",
        docTypeCodes: ["PASSPORT_ORIGINAL"],
        needsCatalogueMapping: false,
      },
      {
        key: "UNMAPPED",
        label: "Some unmapped requirement",
        requirement: "REQUIRED",
        docTypeCodes: [],
        needsCatalogueMapping: true,
        unmatchedDocumentNames: ["INTERNAL raw extraction text"],
        unmatchedTemplateReference: "INTERNAL template ref",
      },
    ],
    ...extra,
  });
}

/* ═════════════════════════════════════════════════════════════════════
 * STEP 0(c) — reachable with NO token and NO cookie at all.
 * ═══════════════════════════════════════════════════════════════════ */
describe("no auth of any kind", () => {
  it("GET /visa/map answers with no Authorization and no Cookie header", async () => {
    await makeRule();
    const res = await request(app()).get("/api/public/visa/map");

    expect(res.status).toBe(200);
    // Proof the request genuinely carried neither.
    expect(res.request.getHeader("Authorization")).toBeUndefined();
    expect(res.request.getHeader("Cookie")).toBeUndefined();
  });

  it("GET /visa/country/:iso2 answers with no token", async () => {
    await makeRule();
    const res = await request(app()).get("/api/public/visa/country/TH");
    expect(res.status).toBe(200);
    expect(res.request.getHeader("Authorization")).toBeUndefined();
  });

  it("never 401s or 403s — there is no auth layer to reject anything", async () => {
    await makeRule();
    for (const path of ["/api/public/visa/map", "/api/public/visa/country/TH"]) {
      const res = await request(app()).get(path);
      expect([401, 403]).not.toContain(res.status);
    }
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * GET /visa/map
 * ═══════════════════════════════════════════════════════════════════ */
describe("GET /visa/map", () => {
  it("returns one entry per destination with the legend counts", async () => {
    await makeRule();
    await makeRule({ destinationIso2: "ZW", destinationName: "Zimbabwe", visaCategory: "STICKER" });

    const res = await request(app()).get("/api/public/visa/map");

    expect(res.body.ok).toBe(true);
    expect(res.body.nationality).toBe("IN");
    expect(res.body.destinations).toHaveLength(2);
    expect(res.body.stats.total).toBe(2);
    expect(res.body.stats.byCategory.E_VISA).toBe(1);
    expect(res.body.stats.byCategory.STICKER).toBe(1);
    expect(res.body.stats.byCategory.VISA_FREE).toBe(0);
  });

  it("collapses several rules for one destination into a single pin", async () => {
    await makeRule();
    await makeRule({ purpose: "BUSINESS", entryType: "MULTIPLE" });
    const res = await request(app()).get("/api/public/visa/map");
    expect(res.body.destinations).toHaveLength(1);
  });

  it("EXCLUDES unpublished rules", async () => {
    await makeRule({ status: "DRAFT", destinationIso2: "DE", destinationName: "Germany" });
    await makeRule({ status: "RETIRED", destinationIso2: "FR", destinationName: "France" });
    await makeRule(); // the only PUBLISHED one

    const res = await request(app()).get("/api/public/visa/map");
    const iso2s = res.body.destinations.map((d: any) => d.iso2);
    expect(iso2s).toEqual(["TH"]);
  });

  it("resolves a disagreeing destination to the most permissive category and flags it", async () => {
    await makeRule({ visaCategory: "STICKER" });
    await makeRule({ purpose: "BUSINESS", visaCategory: "VISA_FREE" });

    const res = await request(app()).get("/api/public/visa/map");
    const th = res.body.destinations.find((d: any) => d.iso2 === "TH");
    expect(th.visaCategory).toBe("VISA_FREE");
    expect(th.categoryIsMixed).toBe(true);
  });

  it("marks a single-category destination as not mixed", async () => {
    await makeRule();
    const th = (await request(app()).get("/api/public/visa/map")).body.destinations[0];
    expect(th.categoryIsMixed).toBe(false);
  });

  it("leaks NOTHING beyond the four documented keys", async () => {
    await makeRule();
    const res = await request(app()).get("/api/public/visa/map");
    for (const d of res.body.destinations) {
      expect(Object.keys(d).sort()).toEqual([
        "categoryIsMixed",
        "destinationName",
        "iso2",
        "visaCategory",
      ]);
    }
    // No fee of any kind anywhere in the map payload.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/FeeInr|plumtrips|opsNotes|seedSource|99999/i);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * GET /visa/country/:iso2 — the leak whitelist
 * ═══════════════════════════════════════════════════════════════════ */
describe("GET /visa/country/:iso2 — whitelist", () => {
  it("returns the requirements payload", async () => {
    await makeRule();
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.status).toBe(200);
    expect(res.body.iso2).toBe("TH");
    expect(res.body.destinationName).toBe("Thailand");
    expect(res.body.visaCategory).toBe("E_VISA");
    expect(res.body.processingTime).toEqual({ minDays: 3, maxDays: 7, basis: "BUSINESS" });
    expect(res.body.maxStayDays).toBe(60);
    expect(res.body.documents.length).toBeGreaterThan(0);
  });

  it("NEVER exposes the B2B service fee or the indicative cost", async () => {
    await makeRule();
    const raw = JSON.stringify((await request(app()).get("/api/public/visa/country/TH")).body);
    expect(raw).not.toContain("plumtripsServiceFeeInr");
    expect(raw).not.toContain("2000"); // the B2B fee amount
    expect(raw).not.toContain("indicativeVisaCostInr");
    expect(raw).not.toContain("99999"); // the indicative amount
  });

  it("NEVER exposes ops/internal fields", async () => {
    await makeRule();
    const raw = JSON.stringify((await request(app()).get("/api/public/visa/country/TH")).body);
    for (const forbidden of [
      "opsNotes",
      "INTERNAL ops note",
      "seedSource",
      "seed-visa-rules",
      "needsCatalogueMapping",
      "unmatchedDocumentNames",
      "unmatchedTemplateReference",
      "INTERNAL raw extraction text",
      "INTERNAL template ref",
      "effectiveFrom",
      "lastReviewedAt",
      "reviewedBy",
      "applicability",
      "appliesWhen",
      "variantKey",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("narrows document rows to the four public fields", async () => {
    await makeRule();
    const res = await request(app()).get("/api/public/visa/country/TH");
    for (const d of res.body.documents) {
      expect(Object.keys(d).sort()).toEqual(["docCode", "name", "notes", "requirement"]);
    }
    // The signed-in-only signals are gone.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("satisfiedByBooking");
    expect(raw).not.toContain("conciergeArrangeable");
    expect(raw).not.toContain("isPassport");
  });

  it("404s an unpublished corridor without revealing it exists", async () => {
    await makeRule({ status: "DRAFT", destinationIso2: "DE", destinationName: "Germany" });
    const draft = await request(app()).get("/api/public/visa/country/DE");
    const missing = await request(app()).get("/api/public/visa/country/ZZ");
    expect(draft.status).toBe(404);
    expect(missing.status).toBe(404);
    // Indistinguishable.
    expect(draft.body).toEqual(missing.body);
  });

  it("returns heroImageUrl only from PUBLISHED destination content", async () => {
    await makeRule();
    await VisaDestinationContent.create({
      destinationIso2: "TH",
      status: "DRAFT",
      heroImageUrl: "https://example.test/draft-hero.jpg",
    });
    const draftRes = await request(app()).get("/api/public/visa/country/TH");
    expect(draftRes.body.heroImageUrl).toBeNull();

    await VisaDestinationContent.updateOne({ destinationIso2: "TH" }, { $set: { status: "PUBLISHED" } });
    const pubRes = await request(app()).get("/api/public/visa/country/TH");
    expect(pubRes.body.heroImageUrl).toBe("https://example.test/draft-hero.jpg");
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * THE PRICE GATE — both conditions, and absence (never ₹0)
 * ═══════════════════════════════════════════════════════════════════ */
describe("price gate", () => {
  it("INCLUDES a price for a curated corridor with a populated D2C fee", async () => {
    await makeRule(); // TH, curated, d2cServiceFeeInr 3000
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.body.isCurated).toBe(true);
    expect(res.body.price).toBeDefined();
    // embassy 8000 + vfs 1500 + d2c 3000 + GST 540
    expect(res.body.price.totalInr).toBe(13040);
    expect(res.body.price.currency).toBe("INR");
  });

  it('labels the service line "Service fee", never "Plumtrips Service Fee"', async () => {
    await makeRule();
    const res = await request(app()).get("/api/public/visa/country/TH");
    const service = res.body.price.lineItems.find((li: any) => li.code === "SERVICE_FEE");
    expect(service.label).toBe("Service fee");
    expect(JSON.stringify(res.body)).not.toMatch(/Plumtrips/i);
  });

  it("prices off the D2C fee — GST is 18% of it, not of the B2B fee", async () => {
    await makeRule();
    const res = await request(app()).get("/api/public/visa/country/TH");
    const amount = (code: string) =>
      res.body.price.lineItems.find((li: any) => li.code === code)?.amountInr;
    expect(amount("SERVICE_FEE")).toBe(3000);
    expect(amount("GST")).toBe(540); // 18% of 3000, not of 2000
    expect(amount("EMBASSY_FEE")).toBe(8000);
    expect(amount("VFS_FEE")).toBe(1500);
  });

  it("OMITS price entirely for a curated corridor with NO D2C fee — not zero", async () => {
    await makeRule({ d2cServiceFeeInr: undefined });
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.body.isCurated).toBe(true);
    expect("price" in res.body).toBe(false);
    expect(res.body.price).toBeUndefined();
    // And emphatically not a zero-price claim.
    expect(JSON.stringify(res.body)).not.toContain('"totalInr":0');
  });

  it("OMITS price for a NON-curated corridor even with a D2C fee populated", async () => {
    await makeRule({ destinationIso2: "ZW", destinationName: "Zimbabwe", d2cServiceFeeInr: 3000 });
    const res = await request(app()).get("/api/public/visa/country/ZW");

    expect(res.body.isCurated).toBe(false);
    expect("price" in res.body).toBe(false);
  });

  it("INCLUDES a price when the D2C fee is a deliberate zero", async () => {
    // 0 != null — a free service on top of real embassy costs is a real,
    // quotable price and must not be dropped by a truthiness check.
    await makeRule({ d2cServiceFeeInr: 0 });
    const res = await request(app()).get("/api/public/visa/country/TH");
    expect(res.body.price).toBeDefined();
    expect(res.body.price.totalInr).toBe(9500); // 8000 + 1500 + 0 + 0
  });

  it("never falls back to the B2B price under any condition", async () => {
    await makeRule({ d2cServiceFeeInr: undefined });
    const res = await request(app()).get("/api/public/visa/country/TH");
    // The B2B all-in would have been 8000+1500+2000+360 = 11860.
    expect(JSON.stringify(res.body)).not.toContain("11860");
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * POST /visa/lead
 * ═══════════════════════════════════════════════════════════════════ */
describe("POST /visa/lead", () => {
  const LEAD = {
    name: "Asha Menon",
    email: "asha@example.com",
    phone: "+919876543210",
    iso2: "TH",
    message: "Need a tourist visa for December.",
    submissionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  };

  function withBypass() {
    process.env.TURNSTILE_DEV_BYPASS = "true";
    process.env.NODE_ENV = "test"; // not production, so the bypass is permitted
  }

  it("REQUIRES Turnstile — fail-closed when the secret is unset", async () => {
    // No secret, no bypass.
    const res = await request(app()).post("/api/public/visa/lead").send(LEAD);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Verification unavailable/);
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });

  it("rejects a missing Turnstile token when a secret IS configured", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    const res = await request(app()).post("/api/public/visa/lead").send(LEAD);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Verification required/);
  });

  it("creates the concierge-funnel row on a valid submission", async () => {
    withBypass();
    const res = await request(app()).post("/api/public/visa/lead").send(LEAD);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, reference: LEAD.submissionId });

    const booking: any = await ManualBooking.findOne({}).lean();
    expect(booking).toBeTruthy();
    // The SAME fan-out the travel-request form uses: HOUSE tenant, VISA type,
    // zero price, namespaced intakeRef.
    expect(booking.type).toBe("VISA");
    expect(booking.metadata.intakeRef).toBe(`hvlead:${LEAD.submissionId}`);
    expect(booking.metadata.channel).toBe("HELLOVIZA_VISA_LEAD");
    expect(booking.pricing.quotedPrice).toBe(0);
    expect(booking.passengers[0].name).toBe("Asha Menon");
    expect(booking.passengers[0].email).toBe("asha@example.com");
    expect(booking.notes).toContain("Helloviza visa lead");
    expect(booking.notes).toContain(LEAD.message);
  });

  it("DEDUPS on a resubmitted submissionId", async () => {
    withBypass();
    await request(app()).post("/api/public/visa/lead").send(LEAD);
    await request(app()).post("/api/public/visa/lead").send(LEAD);

    expect(await ManualBooking.countDocuments({})).toBe(1);
  });

  it("does not false-dedupe against the travel form's namespace", async () => {
    withBypass();
    const { createIntakeBookings } = await import("../services/travelIntake.create.js");
    // A travel-form row with the SAME uuid but the other namespace.
    await createIntakeBookings({
      intakeRef: `public:${LEAD.submissionId}`,
      fullName: "Someone Else",
      travelDate: "2026-12-01",
      services: ["Visa"],
    });

    await request(app()).post("/api/public/visa/lead").send(LEAD);

    // Two distinct rows — the namespaces kept them apart.
    expect(await ManualBooking.countDocuments({})).toBe(2);
  });

  it("records that no travel date was supplied", async () => {
    withBypass();
    await request(app()).post("/api/public/visa/lead").send(LEAD);
    const booking: any = await ManualBooking.findOne({}).lean();
    expect(booking.notes).toContain("No travel date supplied");
    // The placeholder is still a real date, so the required field is satisfied.
    expect(booking.travelDate).toBeInstanceOf(Date);
  });

  it("validates name, contact and destination", async () => {
    withBypass();
    const bad = async (patch: Record<string, any>) =>
      (await request(app()).post("/api/public/visa/lead").send({ ...LEAD, ...patch })).status;

    expect(await bad({ name: "  " })).toBe(400);
    expect(await bad({ email: "", phone: "" })).toBe(400);
    expect(await bad({ email: "not-an-email", phone: "" })).toBe(400);
    expect(await bad({ iso2: "ZZZZ" })).toBe(400);
    expect(await bad({ submissionId: "not-a-uuid" })).toBe(400);
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });

  it("accepts phone-only and email-only leads", async () => {
    withBypass();
    const a = await request(app())
      .post("/api/public/visa/lead")
      .send({ ...LEAD, email: "" });
    const b = await request(app())
      .post("/api/public/visa/lead")
      .send({ ...LEAD, phone: "", submissionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("swallows a honeypot hit with a fake 201 and writes nothing", async () => {
    withBypass();
    const res = await request(app())
      .post("/api/public/visa/lead")
      .send({ ...LEAD, hpField: "i am a bot" });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });

  it("creates NO visa case and NO consumer identity — this is a lead, not an application", async () => {
    withBypass();
    await request(app()).post("/api/public/visa/lead").send(LEAD);

    const { default: VisaRequest } = await import("../models/VisaRequest.js");
    const { default: VisaApplication } = await import("../models/VisaApplication.js");
    const { default: Consumer } = await import("../models/Consumer.js");

    expect(await VisaRequest.countDocuments({})).toBe(0);
    expect(await VisaApplication.countDocuments({})).toBe(0);
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("never returns a Mongo id", async () => {
    withBypass();
    const res = await request(app()).post("/api/public/visa/lead").send(LEAD);
    expect(res.status).toBe(201);
    const booking: any = await ManualBooking.findOne({}).lean();
    expect(booking).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(String(booking._id));
  });
});

describe("rate limiting", () => {
  it("429s past the shared travelRequestLimiter window (15 min / 8 per IP)", async () => {
    process.env.TURNSTILE_DEV_BYPASS = "true";
    const a = app();

    // 8 allowed, the 9th refused. Distinct submissionIds so dedup is not what
    // stops them — this must fail on the limiter, not on the write path.
    const statuses: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const res = await request(a)
        .post("/api/public/visa/lead")
        .send({
          name: "Rate Limited",
          email: "rl@example.com",
          iso2: "TH",
          submissionId: `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(10 + i)}`,
        });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 8).every((s) => s === 201)).toBe(true);
    expect(statuses[8]).toBe(429);
  });
});
