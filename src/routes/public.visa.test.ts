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
/* ManualBooking is still imported, and now for the OPPOSITE reason: the
 * enquiry door used to write one and must never write one again. Every
 * assertion on it below is a zero. */
const { default: ManualBooking } = await import("../models/ManualBooking.js");
/* The identity and support models the enquiry door creates. Real models on
 * the in-memory server, never fixtures — the point of these tests is what is
 * actually persisted, and a literal object would prove nothing about a
 * schema default (authProvider, tokenVersion, status) or a pre-save hook
 * (ticketRef). */
const { default: Consumer } = await import("../models/Consumer.js");
const { default: User } = await import("../models/User.js");
const { default: Ticket } = await import("../models/Ticket.js");
const { default: TicketMessage } = await import("../models/TicketMessage.js");
const { CONSUMER_SUPPORT_SUBJECTS } = await import("../services/consumerSupport.js");
const { default: bcrypt } = await import("bcryptjs");
const { default: publicVisaRouter } = await import("./public.visa.js");
const { travelRequestLimiter } = await import("../middleware/rateLimit.js");
const { listSeedCountries } = await import("../config/visaCountrySeed.js");
// Used only to PROVE the premise of the M1 tests — that the seed-only
// countries really are absent from countryCodes.ts, so their acceptance can
// only come from the seed-first resolver.
const { normaliseToIso2 } = await import("../utils/countryCodes.js");
const { DIFFICULTY_BANDS, SOURCED_APPROVAL } = await import("../utils/visaDifficulty.js");

/** The real shipped seed — these tests read it, never a fixture copy. */
const SEED = listSeedCountries();
const seedCategory = (iso2: string) => SEED.find((c) => c.iso2 === iso2)?.visaCategory;

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

/** One country off the live map payload. */
async function find(iso2: string) {
  const res = await request(app()).get("/api/public/visa/map");
  return res.body.destinations.find((d: any) => d.iso2 === iso2);
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
    /* The enquiry door's own collections. Without these, "creates exactly
     * one account" would pass or fail depending on which test ran before
     * it — and the whole suite leans on absolute counts rather than deltas,
     * because a delta cannot tell a duplicate account apart from a
     * carried-over one. */
    Consumer.deleteMany({}),
    User.deleteMany({}),
    Ticket.deleteMany({}),
    TicketMessage.deleteMany({}),
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
 * GET /visa/map — Phase 2c: ALL ~196 countries, decoupled from what we serve.
 *
 * The map states where an Indian passport can go. `VisaRule` no longer decides
 * who appears or what colour they are — only `serviced`, which branches the
 * CTA. Every assertion below exists to hold that line.
 * ═══════════════════════════════════════════════════════════════════ */
describe("GET /visa/map — every country, not just the served ones", () => {
  it("returns all 196 seed countries even with NOTHING published", async () => {
    const res = await request(app()).get("/api/public/visa/map");

    expect(res.body.ok).toBe(true);
    expect(res.body.nationality).toBe("IN");
    expect(res.body.destinations).toHaveLength(SEED.length);
    expect(res.body.destinations).toHaveLength(196);
    expect(res.body.stats.total).toBe(196);
    // Not one rule exists in this test, and the map is still complete.
    expect(res.body.stats.serviced).toBe(0);
    expect(res.body.stats.unserviced).toBe(196);
  });

  it("carries every seed iso2 exactly once", async () => {
    await makeRule();
    const iso2s = (await request(app()).get("/api/public/visa/map")).body.destinations.map(
      (d: any) => d.iso2,
    );
    expect(new Set(iso2s).size).toBe(iso2s.length);
    expect(iso2s.sort()).toEqual(SEED.map((c) => c.iso2).sort());
  });

  it("takes visaType from the SEED, not from the published rule", async () => {
    // The rule says Thailand is E_VISA. The v3 seed says an Indian
    // passport needs a TDAC — an arrival card, not a visa. The map states
    // the passport fact. (v2 said VISA_FREE here; the seed changed on
    // 2026-08-16 and this assertion follows it, which is the point of
    // reading the value from `seedCategory` on the line above.)
    await makeRule({ visaCategory: "E_VISA" });
    const th = await find("TH");

    expect(seedCategory("TH")).toBe("TRAVEL_AUTH");
    expect(th.visaType).toBe("TRAVEL_AUTH");
    expect(th.visaCategory).toBe("TRAVEL_AUTH"); // 2a alias, same value
    expect(th.serviced).toBe(true); // still served — display is decoupled
  });

  it("keeps the 2a aliases so Phase 2b's components need no change", async () => {
    await makeRule();
    const th = await find("TH");
    expect(th.destinationName).toBe(th.countryName);
    expect(th.visaCategory).toBe(th.visaType);
  });

  /* ── serviced: the ONLY thing a published rule decides ── */

  it("marks serviced true ONLY where a published rule exists", async () => {
    await makeRule(); // TH
    const res = await request(app()).get("/api/public/visa/map");

    const serviced = res.body.destinations.filter((d: any) => d.serviced);
    expect(serviced.map((d: any) => d.iso2)).toEqual(["TH"]);
    expect(res.body.stats.serviced).toBe(1);
    expect(res.body.stats.unserviced).toBe(195);
  });

  it("does NOT count DRAFT or RETIRED rules as serviced", async () => {
    await makeRule({ status: "DRAFT", destinationIso2: "DE", destinationName: "Germany" });
    await makeRule({ status: "RETIRED", destinationIso2: "FR", destinationName: "France" });
    await makeRule(); // the only PUBLISHED one

    const res = await request(app()).get("/api/public/visa/map");
    expect(res.body.destinations.filter((d: any) => d.serviced).map((d: any) => d.iso2)).toEqual(["TH"]);
    // …and Germany and France are still ON the map, just unserviced.
    expect((await find("DE")).serviced).toBe(false);
    expect((await find("FR")).serviced).toBe(false);
  });

  it("collapses several rules for one destination into a single pin", async () => {
    await makeRule();
    await makeRule({ purpose: "BUSINESS", entryType: "MULTIPLE" });
    const res = await request(app()).get("/api/public/visa/map");
    expect(res.body.destinations.filter((d: any) => d.iso2 === "TH")).toHaveLength(1);
  });

  it("flags a corridor whose published rules disagree, and never flags an unserved one", async () => {
    await makeRule({ visaCategory: "STICKER" });
    await makeRule({ purpose: "BUSINESS", visaCategory: "VISA_FREE" });

    expect((await find("TH")).categoryIsMixed).toBe(true);
    // Nothing published for Zimbabwe — it cannot be "mixed".
    expect((await find("ZW")).categoryIsMixed).toBe(false);
  });

  it("marks a single-category destination as not mixed", async () => {
    await makeRule();
    expect((await find("TH")).categoryIsMixed).toBe(false);
  });

  /* ── the four tooltip fields, for every country ── */

  it("resolves all four tooltip fields for all 196 — no nulls, no dashes", async () => {
    const res = await request(app()).get("/api/public/visa/map");
    for (const d of res.body.destinations) {
      for (const field of ["countryName", "visaType", "difficulty", "approvalChances"]) {
        expect(d[field], `${d.iso2}.${field}`).toBeTruthy();
        expect(typeof d[field], `${d.iso2}.${field}`).toBe("string");
        expect(d[field], `${d.iso2}.${field}`).not.toBe("—");
      }
      expect(DIFFICULTY_BANDS, d.iso2).toContain(d.difficulty);
    }
  });

  it("bands difficulty correctly, including the escalated set", async () => {
    const res = await request(app()).get("/api/public/visa/map");
    const band = (iso2: string) =>
      res.body.destinations.find((d: any) => d.iso2 === iso2).difficulty;

    expect(band("US")).toBe("Very Hard");
    expect(band("CN")).toBe("Very Hard");
    expect(band("GB")).toBe("Hard");
    expect(band("FR")).toBe("Hard"); // Schengen
    expect(band("DE")).toBe("Hard"); // Schengen
    expect(band("TH")).toBe("Easy"); // VISA_FREE
    expect(band("VN")).toBe("Moderate"); // E_VISA
  });

  it("never states a difficulty as a percentage", async () => {
    const res = await request(app()).get("/api/public/visa/map");
    for (const d of res.body.destinations) {
      expect(d.difficulty).not.toMatch(/\d|%/);
    }
  });

  it("carries a numeric approval rate ONLY for SOURCED_APPROVAL members", async () => {
    const res = await request(app()).get("/api/public/visa/map");
    /* THE HONESTY GUARANTEE, in its post-dataset form.
     *
     * "Is there a row?" is no longer the same question as "is a number
     * shown?" — the dataset covers 194 countries, but the category
     * short-circuit still returns a fixed string for every VISA_FREE /
     * E_VISA / VOA / TRAVEL_AUTH corridor regardless. So this asks the
     * only question that matters to a reader: whatever string is on the
     * surface, either it is a sourced figure WITH its figures object, or
     * it is one of exactly three fixed phrases carrying no digit at all.
     * There is still no fourth possibility. */
    const sourced = new Set(Object.keys(SOURCED_APPROVAL));

    for (const d of res.body.destinations) {
      if (/%/.test(d.approvalChances)) {
        expect(sourced.has(d.iso2), `${d.iso2} shows a figure so must be sourced`).toBe(true);
        expect(d.approvalFigures, d.iso2).toBeTruthy();
      } else {
        expect(d.approvalChances, d.iso2).not.toMatch(/\d/);
        expect(["Not required", "Very High", "Varies by profile"]).toContain(d.approvalChances);
        // No figures may ride along with a fixed phrase.
        expect(d.approvalFigures, d.iso2).toBeNull();
      }
    }
  });

  it("uses the three sourced figures verbatim and spreads them nowhere else", async () => {
    const res = await request(app()).get("/api/public/visa/map");
    const chance = (iso2: string) =>
      res.body.destinations.find((d: any) => d.iso2 === iso2).approvalChances;

    // Per-country now, each derived from that country's own y2026 — the
    // 29 Schengen members no longer share one aggregate string.
    const figures = (iso2: string) =>
      res.body.destinations.find((d: any) => d.iso2 === iso2).approvalFigures;

    expect(figures("FR")).toEqual({ avg5: 79, avg3: 81, y2026: 82 });
    expect(chance("FR")).toBe("~82% (India, 2026)");
    expect(chance("FR")).not.toBe(chance("PT"));
    /* The three seed countries the dataset does NOT cover. CN and AE used
     * to stand here as "Varies by profile" and no longer can — both now
     * carry figures.
     *
     * ⚠ WORTH KNOWING: "Varies by profile" is now UNREACHABLE on this
     * endpoint. It was the string for a STICKER country with no sourced
     * rate, and there is no longer such a country — the dataset covers
     * every STICKER corridor in the seed, and CI/HK/MO (the only gaps)
     * are E_VISA, TRAVEL_AUTH and VISA_FREE, so all three short-circuit
     * on category first. The phrase is kept as the fallback because the
     * gap can reopen the moment a country is added to the seed and not
     * to the dataset; it is simply not exercised today.
     *
     * So this asserts the property that still holds for them: no digit
     * reaches a reader, and no figures object rides along. */
    for (const iso2 of ["CI", "HK", "MO"]) {
      expect(chance(iso2), iso2).not.toMatch(/\d/);
      expect(figures(iso2), iso2).toBeNull();
    }
  });

  /* ── provenance, legend, leak whitelist ── */

  it("surfaces the seed's source, lastVerified and disclaimer", async () => {
    const res = await request(app()).get("/api/public/visa/map");
    expect(res.body.source).toBeTruthy();
    expect(res.body.sourceUrl).toMatch(/^https?:\/\//);
    expect(res.body.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.disclaimer).toMatch(/verify/i);
  });

  it("keeps the per-category counts, still summing to the whole map", async () => {
    const res = await request(app()).get("/api/public/visa/map");
    const by = res.body.stats.byCategory;

    // The v3 seed's own numbers (2026-08-16). Six categories now: eight
    // countries moved to TRAVEL_AUTH and one to RESTRICTED, which is
    // where the two the VISA_FREE and VOA counts lost, and the one
    // STICKER lost, went.
    expect(by.VISA_FREE).toBe(24);
    expect(by.VOA).toBe(22);
    expect(by.E_VISA).toBe(52);
    expect(by.TRAVEL_AUTH).toBe(8);
    expect(by.STICKER).toBe(89);
    expect(by.RESTRICTED).toBe(1);
    expect(by.STAMP).toBe(0); // shape kept for the frontend Legend
    const sum = Object.values(by).reduce((a: any, b: any) => a + b, 0);
    expect(sum).toBe(196);
  });

  it("leaks NOTHING beyond the documented keys", async () => {
    await makeRule();
    const res = await request(app()).get("/api/public/visa/map");
    for (const d of res.body.destinations) {
      expect(Object.keys(d).sort()).toEqual([
        "approvalChances",
        "approvalFigures",
        "categoryIsMixed",
        "continent",
        "countryName",
        "destinationName",
        "difficulty",
        "groups",
        "iso2",
        "serviced",
        "visaCategory",
        "visaType",
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

  it("404s only a code that is in neither the seed nor the catalogue", async () => {
    // ZZ is not a country. XK (Kosovo) is not in the seed either.
    for (const code of ["ZZ", "XK"]) {
      const res = await request(app()).get(`/api/public/visa/country/${code}`);
      expect(res.status, code).toBe(404);
      expect(res.body, code).toEqual({ error: "Destination not found" });
    }
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
 * GET /visa/country/:iso2 — the UNSERVICED branch (Phase 2c)
 *
 * A country we do not sell is still a real country. It answers 200 with the
 * same four tooltip fields the map gave it, so the frontend can render the
 * Request-form CTA instead of a dead end.
 * ═══════════════════════════════════════════════════════════════════ */
describe("GET /visa/country/:iso2 — unserviced", () => {
  it("answers 200 with the lightweight payload, not 404", async () => {
    const res = await request(app()).get("/api/public/visa/country/DE");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.iso2).toBe("DE");
    expect(res.body.countryName).toBe("Germany");
    expect(res.body.serviced).toBe(false);
    expect(res.body.visaType).toBe(seedCategory("DE"));
    /* Hard, unchanged from HEAD. Germany's own 2026 figure is 78% — a 22%
     * refusal, which WOULD have escalated it while the approval data was
     * wired into difficulty. The figures are display-only, so it does not. */
    expect(res.body.difficulty).toBe("Hard");
    expect(res.body.approvalChances).toBe("~78% (India, 2026)");
    expect(res.body.approvalFigures).toEqual({ avg5: 73, avg3: 73, y2026: 78 });
  });

  it("treats a DRAFT-only corridor as unserviced", async () => {
    await makeRule({ status: "DRAFT", destinationIso2: "DE", destinationName: "Germany" });
    const res = await request(app()).get("/api/public/visa/country/DE");
    expect(res.status).toBe(200);
    expect(res.body.serviced).toBe(false);
  });

  it("carries lastVerified and the verify-before-travel disclaimer", async () => {
    const res = await request(app()).get("/api/public/visa/country/DE");
    expect(res.body.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.disclaimer).toMatch(/verify/i);
  });

  it("omits documents, groups and price entirely — there is no rule behind it", async () => {
    const res = await request(app()).get("/api/public/visa/country/DE");
    // `purposes` belongs on this list for the same reason `documents` does:
    // an empty array would read as "we checked and this corridor offers no
    // visa types", when the truth is that we hold no rule for it at all.
    for (const key of [
      "documents",
      "documentGroups",
      "price",
      "isCurated",
      "purpose",
      "purposes",
    ]) {
      expect(key in res.body, key).toBe(false);
    }
  });

  it("exposes exactly the documented keys", async () => {
    const res = await request(app()).get("/api/public/visa/country/DE");
    expect(Object.keys(res.body).sort()).toEqual([
      "approvalChances",
      "approvalFigures",
      // The panel's Sources footnote. `approvalSource` is a KEY THAT IS
      // ALWAYS PRESENT and a VALUE THAT IS USUALLY NULL — see the
      // provenance block below for what decides which.
      "countryName",
      "destinationName",
      "difficulty",
      "disclaimer",
      "iso2",
      "lastVerified",
      "ok",
      "serviced",
      // The seed's own attribution for the CATEGORY. It was already on
      // the /map response; the country response used to carry only
      // lastVerified and disclaimer, so a panel could print the date and
      // the warning but not say where the category came from.
      "source",
      "sourceUrl",
      "visaCategory",
      "visaType",
    ]);
  });

  /* ── WHAT REPLACED PER-COUNTRY PROVENANCE ─────────────────────────
   *
   * `approvalSource` is GONE from this payload. The rule it enforced — a
   * citation may only appear next to the figure it justifies — could not
   * survive a dataset aggregated from many public sources with no single
   * publisher per row, and the alternative (a fabricated per-country
   * credit) is the exact failure the data layer exists to prevent.
   *
   * The honesty guarantee moved to the surface: every figure is rendered
   * beside APPROVAL_ESTIMATE_DISCLAIMER by the same component, so no
   * arrangement of props yields a number without it. What this endpoint
   * still owes is narrower and asserted below — figures appear only where
   * the sourced label is what is displayed, and the payload never adopts
   * the vocabulary of a personal prediction. */

  it("carries NO per-country citation machinery at all", async () => {
    const res = await request(app()).get("/api/public/visa/country/US");
    expect(res.body.approvalSource).toBeUndefined();
    const blob = JSON.stringify(res.body);
    for (const gone of ["TODO_CITATION", "sourceName", "metricType", "citation"]) {
      expect(blob, gone).not.toContain(gone);
    }
  });

  it("says nothing that reads as a personal prediction", async () => {
    /* The wording rule, asserted rather than trusted to review. It used to
     * be scoped to the approvalSource object; with that gone it applies to
     * the approval fields themselves. */
    const res = await request(app()).get("/api/public/visa/country/FR");
    /* VALUES ONLY. Stringifying the object would fold in the KEY
     * `approvalChances`, which contains "chance" — the field name is not
     * copy a reader ever sees, and matching it would fail every payload
     * forever. */
    const blob = [res.body.approvalChances, JSON.stringify(res.body.approvalFigures)]
      .join(" ")
      .toLowerCase();
    for (const banned of ["chance", "odds", "likelihood", "guarantee"]) {
      expect(blob, banned).not.toContain(banned);
    }
  });

  /* ── THE E-VISA THRESHOLD ──────────────────────────────────────────
   *
   * An e-visa/VOA/travel-auth corridor keeps the words "Very High" only
   * while its own data agrees. Below VERY_HIGH_MIN_PCT the figures win,
   * because a card asserting "Very High" over a 3% dataset entry is worse
   * than a card that says less. */

  it("shows figures for an e-visa corridor whose own data contradicts \"Very High\"", async () => {
    const res = await request(app()).get("/api/public/visa/country/UA");
    expect(res.body.visaType).toBe("E_VISA");
    expect(res.body.approvalFigures).toEqual({ avg5: 3, avg3: 4, y2026: 3 });
    expect(res.body.approvalChances).toBe("~3% (India, 2026)");
  });

  it("shows a HIGH e-visa corridor's figures too — no threshold, no substitution", async () => {
    /* Russia was the case that outlived both earlier rules: "Very High"
     * unconditionally, then "Very High" because 95% is above 90. Under the
     * plain rule it shows what we hold, like everything else that is not
     * visa-free. */
    const res = await request(app()).get("/api/public/visa/country/RU");
    expect(res.body.visaType).toBe("E_VISA");
    expect(res.body.approvalChances).toBe("~95% (India, 2026)");
    expect(res.body.approvalFigures).toEqual({ avg5: 93, avg3: 94, y2026: 95 });
  });

  it("keeps \"Very High\" only where the dataset has no row at all", async () => {
    for (const iso2 of ["CI", "HK"]) {
      const res = await request(app()).get(`/api/public/visa/country/${iso2}`);
      expect(res.body.approvalChances, iso2).toBe("Very High");
      expect(res.body.approvalFigures, iso2).toBeNull();
    }
  });

  it("is reachable with NO token and NO cookie", async () => {
    const res = await request(app()).get("/api/public/visa/country/DE");
    expect(res.status).toBe(200);
    expect(res.request.getHeader("Authorization")).toBeUndefined();
    expect(res.request.getHeader("Cookie")).toBeUndefined();
  });

  /* ── the 77-country resolver gap (design note §3) ── */

  it("resolves countries that countryCodes.ts has never heard of", async () => {
    // SR, MG and GT are in the seed and NOT in countryCodes.ts. Before the
    // seed-first resolver these 404'd — the 5-pin defect Phase 2b reported,
    // which the all-country map would have widened to 77.
    for (const iso2 of ["SR", "MG", "GT"]) {
      const res = await request(app()).get(`/api/public/visa/country/${iso2}`);
      expect(res.status, iso2).toBe(200);
      expect(res.body.iso2, iso2).toBe(iso2);
      expect(res.body.countryName, iso2).toBeTruthy();
    }
  });

  it("fixes the five map pins Phase 2b diagnosed as 404s", async () => {
    for (const iso2 of ["BY", "BJ", "DO", "GA", "MG"]) {
      const res = await request(app()).get(`/api/public/visa/country/${iso2}`);
      expect(res.status, iso2).toBe(200);
    }
  });

  it("still resolves a name or alpha-3 through the countryCodes fallback", async () => {
    await makeRule();
    const byName = await request(app()).get("/api/public/visa/country/Thailand");
    const byAlpha3 = await request(app()).get("/api/public/visa/country/THA");
    expect(byName.body.iso2).toBe("TH");
    expect(byAlpha3.body.iso2).toBe("TH");
  });

  it("every seed country answers 200 — no pin on the map is a dead end", async () => {
    // The honesty guard, proven exhaustively rather than by sampling.
    const results = await Promise.all(
      SEED.map(async (c) => ({
        iso2: c.iso2,
        status: (await request(app()).get(`/api/public/visa/country/${c.iso2}`)).status,
      })),
    );
    expect(results.filter((r) => r.status !== 200)).toEqual([]);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * The SERVICED payload keeps 2a intact and gains the tooltip fields
 * ═══════════════════════════════════════════════════════════════════ */
describe("GET /visa/country/:iso2 — serviced", () => {
  it("adds the four tooltip fields without disturbing the 2a payload", async () => {
    await makeRule(); // TH, PUBLISHED, E_VISA
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.body.serviced).toBe(true);
    expect(res.body.countryName).toBe("Thailand");
    expect(res.body.difficulty).toBe("Easy");
    /* TH is TRAVEL_AUTH in the v3 seed and used to answer "Very High" —
     * the same string e-visa and on-arrival gave, and never "Not required",
     * because something IS required. It holds figures (99/100/100), so
     * under the plain rule it shows them instead. The phrase now appears
     * only where the dataset has no row. */
    /* Stored 99/100/100; displayed 99/99/99 — the 1-99 clamp, applied per
     * line and to the headline alike. A flat 100% reads as "guaranteed",
     * which no aggregate can support. */
    expect(res.body.approvalChances).toBe("~99% (India, 2026)");
    expect(res.body.approvalFigures).toEqual({ avg5: 99, avg3: 99, y2026: 99 });
    expect(res.body.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.disclaimer).toMatch(/verify/i);

    // 2a keys, untouched.
    expect(res.body.destinationName).toBe("Thailand");
    expect(res.body.purpose).toBe("TOURIST");
    expect(res.body.documents.length).toBeGreaterThan(0);
  });

  it("keeps visaCategory RULE-derived while visaType is SEED-derived", async () => {
    // The one deliberate divergence, pinned so it cannot drift unnoticed:
    // the rule says E_VISA (what we will process), the seed says
    // TRAVEL_AUTH (what the passport faces). Design note §6/§8.
    await makeRule({ visaCategory: "E_VISA" });
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.body.visaCategory).toBe("E_VISA");
    expect(res.body.visaType).toBe("TRAVEL_AUTH");
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * `purposes[]` — THE CORRIDOR'S VISA TYPES, HONESTLY
 *
 * Step 1 of the consumer Apply flow renders one card per entry here, so
 * every one of these assertions is a statement about what a customer is
 * offered. The rule under test is: a card exists if and only if a
 * PUBLISHED rule behind it exists.
 * ═══════════════════════════════════════════════════════════════════ */
describe("GET /visa/country/:iso2 — purposes[]", () => {
  it("reports only the purposes the corridor's rules actually cover", async () => {
    await makeRule({ purpose: "TOURIST" });
    const res = await request(app()).get("/api/public/visa/country/TH");

    // One rule, one purpose — not the full CUSTOMER_FACING_PURPOSES menu.
    expect(res.body.purposes).toEqual(["TOURIST"]);
  });

  it("surfaces a TOURIST_OR_BUSINESS rule as BOTH cards, never as its own", async () => {
    // The honest-render rule. TOURIST_OR_BUSINESS is one rule covering two
    // real choices; showing it as a third "Tourist or Business" option would
    // name a visa type no customer would recognise and no rule is filed under.
    await makeRule({ purpose: "TOURIST_OR_BUSINESS" });
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.body.purposes).toEqual(["TOURIST", "BUSINESS"]);
    expect(res.body.purposes).not.toContain("TOURIST_OR_BUSINESS");
  });

  it("reports ['TRANSIT'] alone for an all-transit corridor", async () => {
    // The inverse failure: a corridor we only sell transit visas for must
    // not offer a Tourist card. TRANSIT never widens.
    await makeRule({ purpose: "TRANSIT" });
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.body.purposes).toEqual(["TRANSIT"]);
  });

  it("dedupes across rules and reports in canonical card order", async () => {
    // Three rules, overlapping coverage. TOURIST appears twice (once on its
    // own rule, once via the TOURIST_OR_BUSINESS one) and must appear once.
    await makeRule({ purpose: "TOURIST" });
    await makeRule({ purpose: "TOURIST_OR_BUSINESS", entryType: "MULTIPLE" });
    await makeRule({ purpose: "TRANSIT", entryType: "MULTIPLE" });
    const res = await request(app()).get("/api/public/visa/country/TH");

    // VISA_PURPOSES' declared order, not insertion order and not alphabetical.
    expect(res.body.purposes).toEqual(["TOURIST", "BUSINESS", "TRANSIT"]);
  });

  it("counts the whole corridor, not just the rule the payload resolved to", async () => {
    // `purpose` (scalar) belongs to the ONE resolved rule; `purposes` is the
    // corridor. A BUSINESS-only second rule is invisible to `purpose` and
    // must still produce a Business card.
    await makeRule({ purpose: "TOURIST" });
    await makeRule({ purpose: "BUSINESS", entryType: "MULTIPLE" });
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.body.purpose).toBe("TOURIST"); // tourist-preferred resolution
    expect(res.body.purposes).toEqual(["TOURIST", "BUSINESS"]);
  });

  it("ignores DRAFT rules — an unpublished purpose is not an offer", async () => {
    await makeRule({ purpose: "TOURIST" });
    await makeRule({ purpose: "BUSINESS", entryType: "MULTIPLE", status: "DRAFT" });
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.body.purposes).toEqual(["TOURIST"]);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * `documentGroups[].docCodes` — the locker join key
 * ═══════════════════════════════════════════════════════════════════ */
describe("GET /visa/country/:iso2 — documentGroups docCodes", () => {
  it("exposes the catalogue codes, index-aligned with docNames", async () => {
    await makeRule();
    const res = await request(app()).get("/api/public/visa/country/TH");

    const passport = res.body.documentGroups.find((g: any) => g.key === "PASSPORT");
    expect(passport.docCodes).toEqual(["PASSPORT_ORIGINAL"]);
    expect(passport.docCodes).toHaveLength(passport.docNames.length);
  });

  it("gives an unmapped group an EMPTY docCodes, and still no internal fields", async () => {
    // The UNMAPPED fixture group has no docTypeCodes. It must come through as
    // [] — the client shows the requirement with an upload but no locker
    // match — and must NOT drag needsCatalogueMapping /
    // unmatchedDocumentNames / unmatchedTemplateReference along with it.
    await makeRule();
    const res = await request(app()).get("/api/public/visa/country/TH");

    const unmapped = res.body.documentGroups.find((g: any) => g.key === "UNMAPPED");
    expect(unmapped.docCodes).toEqual([]);
    expect(unmapped).not.toHaveProperty("needsCatalogueMapping");
    expect(unmapped).not.toHaveProperty("unmatchedDocumentNames");
    expect(unmapped).not.toHaveProperty("unmatchedTemplateReference");
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * DEPLOY SAFETY — the seed is read, never imported
 * ═══════════════════════════════════════════════════════════════════ */
describe("seed loading", () => {
  it("loads via readFileSync from ../data, never a JSON import", async () => {
    // `tsc` does not copy .json; the file reaches dist/ only via the build's
    // `cp -r src/data dist/`. A JSON import would resolve at build time and
    // 404 in production while working locally. See the design note §1.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../config/visaCountrySeed.ts", import.meta.url),
      "utf-8",
    );

    expect(src).toContain("readFileSync");
    expect(src).toContain('path.join(__dirname, "../data/visa-country-seed.json")');

    // Comments are stripped first: the module's header deliberately QUOTES the
    // forbidden import to explain why it is forbidden, and that explanation
    // must not be what this test trips over.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");

    expect(code).not.toMatch(/import\s+.*visa-country-seed\.json/);
    expect(code).not.toMatch(/(with|assert)\s*\{\s*type:\s*["']json["']\s*\}/);
  });

  it("validated all 196 entries at startup", async () => {
    const { isSeedReady, getSeedMeta, SEED_VISA_CATEGORIES } = await import(
      "../config/visaCountrySeed.js"
    );
    expect(isSeedReady()).toBe(true);
    expect(SEED).toHaveLength(196);
    expect(getSeedMeta().nationality).toBe("IN");
    for (const c of SEED) {
      expect(c.iso2, c.iso2).toMatch(/^[A-Z]{2}$/);
      expect(c.countryName, c.iso2).toBeTruthy();
      // Read from the module's own union rather than a copy of it: the v3
      // seed added TRAVEL_AUTH and RESTRICTED, and a hardcoded list here
      // failed for eight countries that were perfectly valid.
      expect(SEED_VISA_CATEGORIES as readonly string[], c.iso2).toContain(c.visaCategory);
    }
  });

  /* The region block the rail is driven by. Asserted at the loader, not
   * through the endpoint, because the guarantee is about what was
   * VALIDATED at startup: a group whose membership disagrees with the
   * countries tagged into it must refuse to load at all. */
  it("parsed the region vocabulary and its curated groupings", async () => {
    const { getSeedRegions } = await import("../config/visaCountrySeed.js");
    const regions = getSeedRegions();

    expect(regions.continents).toEqual(["Asia", "Europe", "Africa", "Americas", "Oceania"]);
    for (const c of SEED) {
      expect(regions.continents as readonly string[], c.iso2).toContain(c.continent);
    }

    const schengen = regions.groups.find((g) => g.key === "SCHENGEN");
    expect(schengen?.members).toHaveLength(29);
    expect(SEED.filter((c) => c.groups.includes("SCHENGEN"))).toHaveLength(29);
    expect(regions.groups.find((g) => g.key === "GCC")?.members).toHaveLength(6);
    expect(regions.groups.find((g) => g.key === "ASEAN")?.members).toHaveLength(10);
    expect(SEED.filter((c) => c.continent === "Europe")).toHaveLength(45);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * THE PRICE GATE — one condition (a populated D2C fee), and absence
 * (never ₹0). Curation is NOT a condition: see the non-curated pair below.
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

  /* THE NEW CONTRACT (2026-08-27): a D2C fee alone makes a corridor
   * sellable. This test used to assert the opposite — that a priced
   * corridor stayed unpriced unless it was also in the hardcoded curated
   * set. That AND had never once been satisfied in production (the one
   * corridor with a fee was not curated; all eleven curated ones were
   * unpriced), so it was not gating a decision, it was holding the door
   * shut. Inverted deliberately, and kept, because it is now the test that
   * pins "authoring a fee IS the act of making a corridor sellable". */
  it("INCLUDES a price for a NON-curated corridor with a D2C fee populated", async () => {
    await makeRule({ destinationIso2: "ZW", destinationName: "Zimbabwe", d2cServiceFeeInr: 3000 });
    const res = await request(app()).get("/api/public/visa/country/ZW");

    // Not curated — and that no longer has any bearing on the price.
    expect(res.body.isCurated).toBe(false);
    expect("price" in res.body).toBe(true);
    // Same arithmetic as the curated case: embassy 8000 + vfs 1500 + d2c 3000 + GST 540.
    expect(res.body.price.totalInr).toBe(13040);
    expect(res.body.price.currency).toBe("INR");
  });

  it("OMITS price for a NON-curated corridor with NO D2C fee — the fee is the only gate", async () => {
    await makeRule({
      destinationIso2: "ZW",
      destinationName: "Zimbabwe",
      d2cServiceFeeInr: undefined,
    });
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
 * variants[] — every genuine visa the corridor publishes
 *
 * Modelled on the real AU and GB catalogues: AU publishes three visitor
 * visas plus a Visa Transfer and a Transit 771 (both retyped off VISA in
 * the 2026-08-27 migration); GB publishes a dozen visas, none priced yet.
 * ═══════════════════════════════════════════════════════════════════ */
describe("variants[] — the corridor's visa types", () => {
  /** AU as production actually holds it, post-retype. */
  async function makeAu() {
    const base = {
      nationality: "IN",
      destinationIso2: "AU",
      destinationName: "Australia",
      purpose: "TOURIST",
      entryType: "SINGLE",
      serviceTier: "STANDARD",
      productClass: "VISA",
      visaCategory: "E_VISA",
      status: "PUBLISHED",
      isSchengen: false,
      embassyFeeInr: 17250,
      vfsFeeInr: 0,
      plumtripsServiceFeeInr: 1200,
    };
    await VisaRule.create({ ...base, variantKey: "VISITOR_VISA_EASY_APPLY", priceNote: "Visitor Visa (Easy Apply) | validity Decided by embassy", d2cServiceFeeInr: 2000 });
    await VisaRule.create({ ...base, variantKey: "VISITOR_VISA", priceNote: "Visitor Visa | validity Decided by embassy", d2cServiceFeeInr: 2500 });
    await VisaRule.create({ ...base, variantKey: "VISITOR_VISA_EXPRESS", priceNote: "Visitor Visa - Express | validity Decided by embassy", d2cServiceFeeInr: 3000, embassyFeeInr: 82653 });
    // The two the retype moved OFF productClass VISA — they must not appear.
    await VisaRule.create({ ...base, variantKey: "VISA_TRANSFER", priceNote: "Visa Transfer | validity Decided by embassy", productClass: "VISA_AMENDMENT", d2cServiceFeeInr: 1200, embassyFeeInr: 0 });
    await VisaRule.create({ ...base, variantKey: "TRANSIT_VISA_SUBCLASS_77", priceNote: "Transit visa - (Subclass 771) | validity 3 days post issue", productClass: "TRANSIT_VISA", purpose: "TRANSIT", d2cServiceFeeInr: 1500, embassyFeeInr: 0 });
  }

  it("lists exactly the three genuine visas — Transfer and Transit are absent", async () => {
    await makeAu();
    const res = await request(app()).get("/api/public/visa/country/AU");

    expect(Array.isArray(res.body.variants)).toBe(true);
    expect(res.body.variants).toHaveLength(3);
    expect(res.body.variants.map((v: any) => v.name)).toEqual([
      "Visitor Visa (Easy Apply)",
      "Visitor Visa",
      "Visitor Visa - Express",
    ]);

    const keys = JSON.stringify(res.body.variants);
    expect(keys).not.toMatch(/Visa Transfer|Transit visa/i);
    // variantKey is ops-internal and stays off this surface — see the
    // leak whitelist above.
    expect(keys).not.toContain("variantKey");
  });

  it("strips the ` | validity …` suffix from the display name", async () => {
    await makeAu();
    const res = await request(app()).get("/api/public/visa/country/AU");
    expect(res.body.variants.map((v: any) => v.name)).toEqual([
      "Visitor Visa (Easy Apply)",
      "Visitor Visa",
      "Visitor Visa - Express",
    ]);
    expect(JSON.stringify(res.body.variants)).not.toContain("validity");
  });

  it("sorts priced variants cheapest-first", async () => {
    await makeAu();
    const res = await request(app()).get("/api/public/visa/country/AU");
    const totals = res.body.variants.map((v: any) => v.price.totalInr);
    // 17250+2000+360, 17250+2500+450, 82653+3000+540
    expect(totals).toEqual([19610, 20200, 86193]);
    expect([...totals].sort((a: number, b: number) => a - b)).toEqual(totals);
  });

  it("INCLUDES unpriced variants, carrying price: null (the GB case)", async () => {
    const base = {
      nationality: "IN", destinationIso2: "GB", destinationName: "United Kingdom",
      purpose: "TOURIST", entryType: "SINGLE", serviceTier: "STANDARD",
      productClass: "VISA", visaCategory: "E_VISA", status: "PUBLISHED", isSchengen: false,
      embassyFeeInr: 15574, vfsFeeInr: 0, plumtripsServiceFeeInr: 2000, d2cServiceFeeInr: undefined,
    };
    await VisaRule.create({ ...base, variantKey: "TOURIST_VISA_6_MONTHS", priceNote: "Tourist Visa - 6 Months. | validity 180 days post issue" });
    await VisaRule.create({ ...base, variantKey: "PRIORITY_VISA_2_YEARS", priceNote: "Priority Visa - 2 years | validity 730 days post issue" });

    const res = await request(app()).get("/api/public/visa/country/GB");
    expect(res.body.variants).toHaveLength(2);
    for (const v of res.body.variants) expect(v.price).toBeNull();
    // Trailing full stop removed too — ops types it inconsistently.
    expect(res.body.variants.map((v: any) => v.name).sort()).toEqual([
      "Priority Visa - 2 years",
      "Tourist Visa - 6 Months",
    ]);
  });

  it("puts every priced variant ahead of every unpriced one", async () => {
    await makeAu();
    await VisaRule.create({
      nationality: "IN", destinationIso2: "AU", destinationName: "Australia",
      purpose: "TOURIST", entryType: "SINGLE", serviceTier: "STANDARD",
      productClass: "VISA", visaCategory: "E_VISA", status: "PUBLISHED", isSchengen: false,
      variantKey: "AAA_UNPRICED", priceNote: "AAA Unpriced Visa | validity Decided by embassy",
      embassyFeeInr: 100, vfsFeeInr: 0, plumtripsServiceFeeInr: 900, d2cServiceFeeInr: undefined,
    });

    const res = await request(app()).get("/api/public/visa/country/AU");
    const priced = res.body.variants.map((v: any) => v.price !== null);
    // Alphabetically first and by far the cheapest — and still last, because
    // it cannot be quoted.
    expect(priced).toEqual([true, true, true, false]);
    expect(res.body.variants[3].name).toBe("AAA Unpriced Visa");
  });

  it("is ADDITIVE — the headline fields still describe the single selected rule", async () => {
    await makeAu();
    const res = await request(app()).get("/api/public/visa/country/AU");

    // The headline price is the cheapest genuine visa, unchanged by variants[].
    expect(res.body.price.totalInr).toBe(19610);
    // And the scalar rule-derived fields are still present and scalar.
    expect(res.body.purpose).toBe("TOURIST");
    expect(res.body.entryType).toBe("SINGLE");
    expect(Array.isArray(res.body.purposes)).toBe(true);
    expect(res.body).toHaveProperty("documents");
    expect(res.body).toHaveProperty("documentGroups");
  });

  it("a corridor whose only rules are ancillary reports an EMPTY list, not a missing key", async () => {
    await VisaRule.create({
      nationality: "IN", destinationIso2: "TH", destinationName: "Thailand",
      purpose: "TOURIST", entryType: "SINGLE", serviceTier: "STANDARD",
      productClass: "ARRIVAL_CARD", visaCategory: "VISA_FREE", status: "PUBLISHED", isSchengen: false,
      variantKey: "TDAC", priceNote: "Tourist Visa TDAC. | validity 30 days post issue",
      embassyFeeInr: 0, vfsFeeInr: 0, plumtripsServiceFeeInr: 0, d2cServiceFeeInr: 350,
    });

    const res = await request(app()).get("/api/public/visa/country/TH");
    // serviced is still true — the corridor IS sold, just not as a "visa".
    expect(res.body.serviced).toBe(true);
    expect(res.body.variants).toEqual([]);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * POST /visa/lead — THE PUBLIC ENQUIRY DOOR
 *
 * The route kept its path and changed its whole job: it used to write a ₹0
 * HOUSE ManualBooking and nothing else, and it now creates a CONSUMER
 * ACCOUNT plus a SUPPORT TICKET and writes no booking at all.
 *
 * So the assertions below come in two halves. The ones that survived
 * unchanged are the GUARDS and the iso2 resolution — the honeypot, the
 * fail-closed Turnstile, the rate limiter, the seed-first M1 cases — because
 * none of that was what changed. The ones that are new are about identity:
 * which of the three forks an address takes, what exactly gets created on
 * each, and the negative that pays for the whole change, which is that NO
 * ManualBooking is written on any path any more.
 * ═══════════════════════════════════════════════════════════════════ */
describe("POST /visa/lead — the public enquiry door", () => {
  const ENQUIRY = {
    name: "Asha Menon",
    email: "asha@example.com",
    password: "correct-horse-battery",
    phone: "+919876543210",
    iso2: "TH",
    message: "Need a tourist visa for December.",
    submissionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  };

  function withBypass() {
    process.env.TURNSTILE_DEV_BYPASS = "true";
    process.env.NODE_ENV = "test"; // not production, so the bypass is permitted
  }

  const post = (patch: Record<string, any> = {}) =>
    request(app()).post("/api/public/visa/lead").send({ ...ENQUIRY, ...patch });

  /** Did this response hand out a consumer session? */
  const hasSession = (res: any) =>
    (res.headers["set-cookie"] ?? []).some((c: string) => c.startsWith("hv_consumerAccess="));

  /* ── THE GUARDS, UNCHANGED BY THE REWRITE ────────────────────────────
   * These matter MORE than they did, not less: the endpoint they protect
   * creates accounts now. Kept verbatim from the lead suite so a
   * regression in the chain reads as a regression, not as a rewritten
   * expectation. */

  it("REQUIRES Turnstile — fail-closed when the secret is unset", async () => {
    // No secret, no bypass.
    delete process.env.TURNSTILE_DEV_BYPASS;
    delete process.env.TURNSTILE_SECRET;
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Verification unavailable/);
    expect(await Consumer.countDocuments({})).toBe(0);
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it("rejects a missing Turnstile token when a secret IS configured", async () => {
    delete process.env.TURNSTILE_DEV_BYPASS;
    process.env.TURNSTILE_SECRET = "test-secret";
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Verification required/);
    expect(await Consumer.countDocuments({})).toBe(0);
  });

  it("swallows a honeypot hit with a fake 201 that creates NOTHING", async () => {
    withBypass();
    const res = await post({ hpField: "i am a bot" });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    // The no-side-effect outcome, so a bot gets a plausible answer and the
    // frontend it is imitating would navigate nowhere.
    expect(res.body.outcome).toBe("existing_account");
    expect(hasSession(res)).toBe(false);
    expect(await Consumer.countDocuments({})).toBe(0);
    expect(await Ticket.countDocuments({})).toBe(0);
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });

  /* ── FORK 3 — A NEW ADDRESS ──────────────────────────────────────── */

  it("NEW EMAIL: creates the account, files the case, and issues the session", async () => {
    withBypass();
    const res = await post();

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe("created");
    expect(res.body.reference).toBe(ENQUIRY.submissionId);
    expect(hasSession(res)).toBe(true);

    const consumer: any = await Consumer.findOne({}).lean();
    expect(consumer).toBeTruthy();
    expect(consumer.email).toBe("asha@example.com");
    expect(consumer.name).toBe("Asha Menon");

    const ticket: any = await Ticket.findOne({}).lean();
    expect(ticket).toBeTruthy();
    expect(String(ticket.consumerId)).toBe(String(consumer._id));
    expect(ticket.ticketRef).toBeTruthy();
    // The ref is echoed so the reader can quote it before they can read the
    // thread — the one branch where they cannot see it any other way.
    expect(res.body.ticketRef).toBe(ticket.ticketRef);
  });

  it("NEW EMAIL: the ticket is a consumer WEB case with the allowlisted subject", async () => {
    withBypass();
    await post();

    const ticket: any = await Ticket.findOne({}).lean();
    expect(ticket.subject).toBe("Visa application help");
    // The subject the enquiry door hard-codes must be one the consumer
    // router would itself accept — the same allowlist, not a parallel one.
    expect(CONSUMER_SUPPORT_SUBJECTS).toContain(ticket.subject);
    expect(ticket.sourceChannel).toBe("WEB");
    expect(ticket.status).toBe("NEW");
    expect(ticket.tags).toContain("d2c-support");
    // A consumer has no employer, so no Customer workspace and no B2B lead.
    expect(ticket.workspaceId ?? null).toBeNull();
    expect(ticket.leadId ?? null).toBeNull();
    // fromEmail is read from the Consumer row, never from the request body.
    expect(ticket.fromEmail).toBe("asha@example.com");
  });

  it("NEW EMAIL: the case body carries the corridor, the date and their words", async () => {
    withBypass();
    await post({ travelDate: "2026-12-01" });

    const msg: any = await TicketMessage.findOne({}).lean();
    expect(msg.direction).toBe("INBOUND");
    // The country NAME, not just the code — an agent should not have to
    // decode "TH" to know what they are looking at.
    expect(msg.bodyText).toContain("Country enquiry: Thailand (TH)");
    expect(msg.bodyText).toContain("Intended travel date: 2026-12-01");
    expect(msg.bodyText).toContain("Need a tourist visa for December.");
    // The unverified number rides in the body so an agent has it in the
    // thread rather than on a record they would have to go and open.
    expect(msg.bodyText).toContain("9876543210");
  });

  it("NEW EMAIL: says so plainly when no travel date was given", async () => {
    withBypass();
    await post({ travelDate: "" });
    const msg: any = await TicketMessage.findOne({}).lean();
    expect(msg.bodyText).toContain("No travel date supplied");
  });

  it("NEW EMAIL: the account matches one made at the normal signup door", async () => {
    withBypass();
    await post();

    // passwordHash is select:false, so it has to be asked for by name.
    const consumer: any = await Consumer.findOne({}).select("+passwordHash").lean();

    // The default the model documents for every email-created account.
    expect(consumer.authProvider).toBe("password");
    expect(consumer.status).toBe("ACTIVE");
    expect(consumer.tokenVersion).toBe(0);
    // A real bcrypt hash at the shared cost, never the plaintext.
    expect(consumer.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(consumer.passwordHash).not.toContain(ENQUIRY.password);
    expect(await bcrypt.compare(ENQUIRY.password, consumer.passwordHash)).toBe(true);

    // The phone is the UNVERIFIED signup hint, normalised to bare ten
    // digits — and it must NOT have become a verified login key. This door
    // does no OTP, so granting one would be a login credential minted from
    // an unproven number.
    expect(consumer.phone).toBe("9876543210");
    expect(consumer.verifiedPhone).toBeUndefined();
    expect(consumer.mobileVerified ?? false).toBe(false);

    // No consent was posted, so no consent block is written at all —
    // "never asked" must stay distinguishable from "said no".
    expect(consumer.marketingConsent).toBeUndefined();
    expect(consumer.googleSub).toBeUndefined();
  });

  it("NEW EMAIL: records marketing consent through the SHARED builder", async () => {
    withBypass();
    // The flat body keys buildSignupConsent reads — the same two the signup
    // form posts. A second door inventing its own consent shape is how one
    // of them ends up writing a record the registry cannot read.
    await post({ marketingConsentEmail: true });

    const consumer: any = await Consumer.findOne({}).lean();
    expect(consumer.marketingConsent?.email?.optedIn).toBe(true);
    expect(consumer.marketingConsent?.email?.source).toBe("signup");
    // Only what was ticked. Nothing infers the other channel.
    expect(consumer.marketingConsent?.whatsapp).toBeUndefined();
  });

  it("NEW EMAIL: only `true` opts anybody in", async () => {
    withBypass();
    // A JSON body is attacker-shaped, and "false" is truthy in JS.
    await post({ marketingConsentEmail: "false" });
    const consumer: any = await Consumer.findOne({}).lean();
    expect(consumer.marketingConsent).toBeUndefined();
  });

  /* ── FORK 1 — AN ADDRESS WE ALREADY KNOW ─────────────────────────── */

  it("EXISTING EMAIL: files against the existing account, makes no second one, issues NO session", async () => {
    withBypass();
    const existing: any = await Consumer.create({
      email: "asha@example.com",
      name: "Asha From Before",
      passwordHash: await bcrypt.hash("her-real-password", 12),
    });

    const res = await post();

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe("existing_account");
    expect(res.body.email).toBe("asha@example.com");

    // THE WHOLE POINT: no session. We cannot sign somebody in from an email
    // address alone, and this endpoint never checks the password it was
    // given, so issuing one here would be an account takeover with extra
    // steps.
    expect(hasSession(res)).toBe(false);
    expect(res.body.accessToken).toBeUndefined();

    // Exactly one account, and it is the one that was already there —
    // unchanged, including its name.
    expect(await Consumer.countDocuments({})).toBe(1);
    const after: any = await Consumer.findById(existing._id).select("+passwordHash").lean();
    expect(after.name).toBe("Asha From Before");
    expect(await bcrypt.compare("her-real-password", after.passwordHash)).toBe(true);

    // The case is filed all the same — that is what makes the "sign in to
    // read it" answer honest.
    const ticket: any = await Ticket.findOne({}).lean();
    expect(String(ticket.consumerId)).toBe(String(existing._id));
    expect(ticket.subject).toBe("Visa application help");
  });

  it("EXISTING EMAIL: matches on the NORMALISED address, not the typed one", async () => {
    withBypass();
    const existing: any = await Consumer.create({ email: "asha@example.com", name: "Asha" });

    // Same address, shouted, with padding. normalizeEmail is the shared
    // key — a second door that keyed differently would mint a duplicate.
    const res = await post({ email: "  ASHA@Example.COM  " });

    expect(res.body.outcome).toBe("existing_account");
    expect(await Consumer.countDocuments({})).toBe(1);
    const ticket: any = await Ticket.findOne({}).lean();
    expect(String(ticket.consumerId)).toBe(String(existing._id));
  });

  /* ── FORK 2 — A BUSINESS ACCOUNT ─────────────────────────────────── */

  it("B2B EMAIL: 409 with the shared marker, and creates NOTHING", async () => {
    withBypass();
    await User.create({
      email: "asha@example.com",
      name: "Asha At Work",
      passwordHash: "irrelevant",
      roles: ["EMPLOYEE"],
      // required on User — a B2B account always belongs to a tenant, which
      // is exactly the thing a consumer does not have.
      workspaceId: new mongoose.Types.ObjectId(),
    });

    const res = await post();

    expect(res.status).toBe(409);
    // Switched on the TYPED CODE — the frontend forks on this, not on prose.
    expect(res.body.code).toBe("B2B_ACCOUNT_EXISTS");
    expect(res.body.error).toMatch(/business account/i);
    expect(hasSession(res)).toBe(false);

    // No consumer, and no ticket: there is no consumerId to hang one on.
    expect(await Consumer.countDocuments({})).toBe(0);
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it("B2B is never consulted for an address that is ALREADY a consumer", async () => {
    withBypass();
    // The same address on both sides. Consumers are checked first, so this
    // must take the consumer fork and reveal nothing about the B2B row.
    const consumer: any = await Consumer.create({ email: "asha@example.com", name: "Asha" });
    await User.create({
      email: "asha@example.com",
      name: "Asha At Work",
      passwordHash: "irrelevant",
      roles: ["EMPLOYEE"],
      // required on User — a B2B account always belongs to a tenant, which
      // is exactly the thing a consumer does not have.
      workspaceId: new mongoose.Types.ObjectId(),
    });

    const res = await post();

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe("existing_account");
    expect(res.body.code).toBeUndefined();
    const ticket: any = await Ticket.findOne({}).lean();
    expect(String(ticket.consumerId)).toBe(String(consumer._id));
  });

  /* ── VALIDATION ──────────────────────────────────────────────────── */

  it("requires name, email, a >=8 password, a real destination and a v4 submissionId", async () => {
    withBypass();
    const status = async (patch: Record<string, any>) => (await post(patch)).status;

    expect(await status({ name: "  " })).toBe(400);
    // EMAIL IS NOW REQUIRED. The old route took email-OR-phone; an account
    // has no key without one.
    expect(await status({ email: "" })).toBe(400);
    expect(await status({ email: "not-an-email" })).toBe(400);
    expect(await status({ password: "" })).toBe(400);
    expect(await status({ password: "short" })).toBe(400);
    expect(await status({ iso2: "ZZZZ" })).toBe(400);
    expect(await status({ submissionId: "not-a-uuid" })).toBe(400);

    // Not one of them got as far as creating anything.
    expect(await Consumer.countDocuments({})).toBe(0);
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it("a phone-only submission is now REJECTED — it used to be accepted", async () => {
    withBypass();
    const res = await post({ email: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email address is required/i);
  });

  it("password floor matches the signup door exactly at 8", async () => {
    withBypass();
    expect((await post({ password: "1234567" })).status).toBe(400);
    expect((await post({ password: "12345678" })).status).toBe(201);
  });

  /* ── THE NEGATIVE THAT PAYS FOR THE CHANGE ───────────────────────── */

  it("writes NO ManualBooking on ANY path — the booking IS the thing replaced", async () => {
    withBypass();

    await post(); // created
    await post({ submissionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302" }); // existing now
    await post({ hpField: "bot", submissionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3303" });
    await post({ email: "", submissionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3304" }); // 400

    expect(await ManualBooking.countDocuments({})).toBe(0);
    // And the register the leads used to land in is untouched entirely.
    expect(await ManualBooking.countDocuments({ "metadata.channel": "HELLOVIZA_VISA_LEAD" })).toBe(0);
  });

  it("creates no VisaRequest and no VisaApplication — there is still no self-serve application", async () => {
    withBypass();
    await post();

    const { default: VisaRequest } = await import("../models/VisaRequest.js");
    const { default: VisaApplication } = await import("../models/VisaApplication.js");
    expect(await VisaRequest.countDocuments({})).toBe(0);
    expect(await VisaApplication.countDocuments({})).toBe(0);
  });

  /**
   * The lead route returned no id at all, because it had none worth
   * returning. The created branch DOES return the consumer's id, and that is
   * correct rather than a regression: it is `publicConsumer(...)`, the same
   * allowlisted shape POST /signup answers with, and the frontend session
   * store keys on it.
   *
   * So the invariant is not "no ids" any more — it is that the body carries
   * the consumer ALLOWLIST and nothing else, and that no OPS id leaks. A
   * ticket's Mongo id is ops-internal; the human-readable ticketRef is what
   * a customer is given.
   */
  it("returns the consumer allowlist and no ops ids", async () => {
    withBypass();
    const res = await post();
    const consumer: any = await Consumer.findOne({}).select("+passwordHash").lean();
    const ticket: any = await Ticket.findOne({}).lean();

    expect(res.body.consumer).toEqual({
      id: String(consumer._id),
      email: "asha@example.com",
      name: "Asha Menon",
      phone: "9876543210",
    });
    // Never the hash, never the ticket's internal id.
    expect(JSON.stringify(res.body)).not.toContain(consumer.passwordHash);
    expect(JSON.stringify(res.body)).not.toContain(String(ticket._id));
    // The customer-facing reference IS returned — that is the point of it.
    expect(res.body.ticketRef).toBe(ticket.ticketRef);
  });

  it("EXISTING EMAIL: leaks nothing about the account it found", async () => {
    withBypass();
    const existing: any = await Consumer.create({
      email: "asha@example.com",
      name: "Asha From Before",
    });
    const res = await post();

    // The address they typed comes back so the sign-in field can be
    // prefilled. Nothing else about the account does — not its id, not the
    // name it is under, not when it was made.
    expect(res.body.consumer).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(String(existing._id));
    expect(JSON.stringify(res.body)).not.toContain("Asha From Before");
  });

  /* ── IDEMPOTENCY ─────────────────────────────────────────────────── */

  it("DEDUPES a resubmitted submissionId into ONE case", async () => {
    withBypass();
    await post();
    const second = await post(); // same submissionId, minted once per page load

    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe("existing_account");
    expect(await Ticket.countDocuments({})).toBe(1);
    expect(await Consumer.countDocuments({})).toBe(1);
    // No second session handed out on the replay.
    expect(hasSession(second)).toBe(false);
  });

  it("the dedup key is namespaced, so it cannot collide with the travel form's", async () => {
    withBypass();
    await post();
    const ticket: any = await Ticket.findOne({}).lean();
    expect(ticket.extractedFields?.enquiryRef).toBe(`hvenq:${ENQUIRY.submissionId}`);
    // Same uuid, the travel form's namespace — a different key entirely.
    expect(ticket.extractedFields?.enquiryRef).not.toBe(`public:${ENQUIRY.submissionId}`);
  });

  it("a DIFFERENT submissionId from the same person files a second case", async () => {
    withBypass();
    await post();
    await post({ submissionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3399" });

    // Two enquiries, one account.
    expect(await Ticket.countDocuments({})).toBe(2);
    expect(await Consumer.countDocuments({})).toBe(1);
  });

  /* ═══════════════════════════════════════════════════════════════════
   * M1 — the door accepts every country the map draws.
   *
   * Carried over unchanged from the lead suite. The resolver is the part
   * of this route the rewrite did NOT touch, and it is the part with a
   * history: resolving through `normaliseToIso2` alone 400'd the 77 seed
   * countries countryCodes.ts has no row for — a dead Request button on
   * 39% of the map, on exactly the long-tail corridors an enquiry form
   * exists to catch.
   * ═════════════════════════════════════════════════════════════════ */

  // Seed-only: present in the 196-country seed, absent from countryCodes.ts.
  const SEED_ONLY = ["DO", "JM", "BS", "VA", "MO"] as const;

  /* The explicit timeout is about BCRYPT, not about the resolver this test
   * is checking. Five sequential enquiries now mean five cost-12 hashes,
   * which is deliberately expensive work, and under a full parallel suite
   * run that overruns vitest'''s 5s default. Raising it here is honest;
   * lowering the cost to make a test fast would not be. */
  it("M1: accepts the seed-only countries that used to 400", async () => {
    withBypass();

    for (const [i, iso2] of SEED_ONLY.entries()) {
      // Proves the premise rather than assuming it.
      expect(normaliseToIso2(iso2)).toBeNull();
      expect(SEED.some((c) => c.iso2 === iso2)).toBe(true);

      const res = await post({
        iso2,
        email: `enquirer-${i}@example.com`,
        submissionId: `3f2504e0-4f89-41d3-9a0c-0305e82c34${10 + i}`,
      });

      expect(res.status).toBe(201);
      expect(res.body.outcome).toBe("created");
    }

    // Every one produced a real case, stamped with its own corridor.
    const messages = await TicketMessage.find({}).lean();
    expect(messages).toHaveLength(SEED_ONLY.length);
    for (const iso2 of SEED_ONLY) {
      expect(messages.some((m: any) => m.bodyText.includes(`(${iso2})`))).toBe(true);
    }
  }, 30_000);

  it("M1: the validator and the handler resolve to the SAME code", async () => {
    withBypass();
    // Lowercase and padded — the validator must not accept a value the
    // handler then resolves differently (or throws on).
    const res = await post({ iso2: "  mo  " });

    expect(res.status).toBe(201);
    const msg: any = await TicketMessage.findOne({}).lean();
    expect(msg.bodyText).toContain("(MO)");
  });
});

describe("rate limiting", () => {
  it("429s past the shared travelRequestLimiter window (15 min / 8 per IP)", async () => {
    process.env.TURNSTILE_DEV_BYPASS = "true";
    const a = app();

    // 8 allowed, the 9th refused. Distinct submissionIds AND distinct
    // addresses, so neither the dedup nor the existing-account fork is what
    // stops them — this must fail on the limiter, not on the write path.
    //
    // The payload gained a password when the route became an
    // account-creation door; without it every request would 400 at
    // validation and the limiter would never be the thing under test.
    const statuses: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const res = await request(a)
        .post("/api/public/visa/lead")
        .send({
          name: "Rate Limited",
          email: `rl-${i}@example.com`,
          password: "a-long-enough-password",
          iso2: "TH",
          submissionId: `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(10 + i)}`,
        });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 8).every((s) => s === 201)).toBe(true);
    expect(statuses[8]).toBe(429);
    /* 30s for the same reason the M1 case above carries one: eight of these
     * nine requests now create an account, and a cost-12 bcrypt hash apiece
     * is the single slowest thing in this suite. */
  }, 30_000);
});

/* ═════════════════════════════════════════════════════════════════════
 * THE DIVERGENCE GUARD (Phase 2d)
 *
 * A serviced corridor whose seed category disagrees with its rule-derived
 * one shows one colour on the map and another in the panel. The guard
 * REPORTS it; it does not resolve it — the seed still wins the display.
 * ═══════════════════════════════════════════════════════════════════ */
describe("seed/rule category divergence", () => {
  it("flags a serviced corridor whose two categories disagree", async () => {
    const { findCategoryDivergence } = await import("./public.visa.js");
    const found = findCategoryDivergence([
      { iso2: "TH", seedCategory: "VISA_FREE", ruleCategory: "E_VISA" },
    ]);
    expect(found).toEqual([{ iso2: "TH", seedCategory: "VISA_FREE", ruleCategory: "E_VISA" }]);
  });

  it("stays silent when they agree", async () => {
    const { findCategoryDivergence } = await import("./public.visa.js");
    expect(
      findCategoryDivergence([{ iso2: "AE", seedCategory: "STICKER", ruleCategory: "STICKER" }]),
    ).toEqual([]);
  });

  it("treats STAMP as STICKER — the same thing to a traveller", async () => {
    const { findCategoryDivergence } = await import("./public.visa.js");
    expect(
      findCategoryDivergence([{ iso2: "AE", seedCategory: "STICKER", ruleCategory: "STAMP" }]),
    ).toEqual([]);
  });

  it("ignores a corridor with nothing published — there is no disagreement", async () => {
    const { findCategoryDivergence } = await import("./public.visa.js");
    expect(
      findCategoryDivergence([{ iso2: "US", seedCategory: "STICKER", ruleCategory: null }]),
    ).toEqual([]);
  });

  it("does NOT change what the map serves — the seed still wins", async () => {
    // TH: seed TRAVEL_AUTH, rule E_VISA. Divergent, and the pin is still
    // the seed's colour.
    await makeRule({ visaCategory: "E_VISA" });
    const th = await find("TH");
    expect(th.visaType).toBe("TRAVEL_AUTH");
    expect(th.serviced).toBe(true);
  });
});
