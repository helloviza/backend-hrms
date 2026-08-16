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
const { listSeedCountries } = await import("../config/visaCountrySeed.js");
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
    // The rule says Thailand is E_VISA. The seed says an Indian passport
    // enters Thailand visa-free. The map states the passport fact.
    await makeRule({ visaCategory: "E_VISA" });
    const th = await find("TH");

    expect(seedCategory("TH")).toBe("VISA_FREE");
    expect(th.visaType).toBe("VISA_FREE");
    expect(th.visaCategory).toBe("VISA_FREE"); // 2a alias, same value
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
    const sourced = new Set(Object.keys(SOURCED_APPROVAL));

    for (const d of res.body.destinations) {
      if (sourced.has(d.iso2)) {
        expect(d.approvalChances, d.iso2).toMatch(/%/);
      } else {
        // The whole honesty guarantee, asserted 165 times.
        expect(d.approvalChances, d.iso2).not.toMatch(/\d/);
        expect(["Not required", "Very High", "Varies by profile"]).toContain(d.approvalChances);
      }
    }
  });

  it("uses the three sourced figures verbatim and spreads them nowhere else", async () => {
    const res = await request(app()).get("/api/public/visa/map");
    const chance = (iso2: string) =>
      res.body.destinations.find((d: any) => d.iso2 === iso2).approvalChances;

    expect(chance("US")).toBe("~78% (India, FY25)");
    expect(chance("GB")).toBe("~93% (India)");
    expect(chance("FR")).toBe("~85% (India, 2024)");
    // A sticker country with no sourced rate says so.
    expect(chance("CN")).toBe("Varies by profile");
    expect(chance("AE")).toBe("Varies by profile");
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

    expect(by.VISA_FREE).toBe(26);
    expect(by.VOA).toBe(28);
    expect(by.E_VISA).toBe(52);
    expect(by.STICKER).toBe(90);
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
        "categoryIsMixed",
        "countryName",
        "destinationName",
        "difficulty",
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
    expect(res.body.difficulty).toBe("Hard");
    expect(res.body.approvalChances).toBe("~85% (India, 2024)");
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
    for (const key of ["documents", "documentGroups", "price", "isCurated", "purpose"]) {
      expect(key in res.body, key).toBe(false);
    }
  });

  it("exposes exactly the documented keys", async () => {
    const res = await request(app()).get("/api/public/visa/country/DE");
    expect(Object.keys(res.body).sort()).toEqual([
      "approvalChances",
      "countryName",
      "destinationName",
      "difficulty",
      "disclaimer",
      "iso2",
      "lastVerified",
      "ok",
      "serviced",
      "visaCategory",
      "visaType",
    ]);
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
    expect(res.body.approvalChances).toBe("Not required");
    expect(res.body.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.disclaimer).toMatch(/verify/i);

    // 2a keys, untouched.
    expect(res.body.destinationName).toBe("Thailand");
    expect(res.body.purpose).toBe("TOURIST");
    expect(res.body.documents.length).toBeGreaterThan(0);
  });

  it("keeps visaCategory RULE-derived while visaType is SEED-derived", async () => {
    // The one deliberate divergence, pinned so it cannot drift unnoticed:
    // the rule says E_VISA (what we will process), the seed says VISA_FREE
    // (what the passport faces). Design note §6/§8.
    await makeRule({ visaCategory: "E_VISA" });
    const res = await request(app()).get("/api/public/visa/country/TH");

    expect(res.body.visaCategory).toBe("E_VISA");
    expect(res.body.visaType).toBe("VISA_FREE");
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
    const { isSeedReady, getSeedMeta } = await import("../config/visaCountrySeed.js");
    expect(isSeedReady()).toBe(true);
    expect(SEED).toHaveLength(196);
    expect(getSeedMeta().nationality).toBe("IN");
    for (const c of SEED) {
      expect(c.iso2, c.iso2).toMatch(/^[A-Z]{2}$/);
      expect(c.countryName, c.iso2).toBeTruthy();
      expect(["VISA_FREE", "E_VISA", "VOA", "STICKER"], c.iso2).toContain(c.visaCategory);
    }
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
