// apps/backend/src/routes/visaVariantSelection.test.ts
//
// PHASE 1 OF THE VARIANT PICKER — quote == charge, per VARIANT.
//
// The gap: AU Tourist publishes three priced visas — Easy Apply
// Rs 19,610, Visitor Rs 20,200, and Express Rs 86,193 at five business
// days instead of thirty-five — and the apply flow offered exactly one,
// the cheapest. The premium product was unbuyable at the point of sale.
//
// The earlier fix made quote == charge at the PURPOSE level. Adding a
// picker without extending that would reintroduce the same defect one
// level down, and worse: a reader selects Express, sees Rs 86,193, and
// the submit — which resolved by purpose alone — stores the headline
// Easy Apply rule at Rs 19,610 with a thirty-five-day ETA. They would be
// promised a five-day visa and booked into a five-week one.
//
// So the invariant this file exists to pin is:
//
//   the variant SHOWN  ==  the variant PRICED  ==  the variant STORED
//
// asserted against a fee block computed from the rule the SUBMIT path
// independently resolves, not against a literal.
//
// The second property is the refusal. resolveRuleFor never falls back to
// the headline for an unknown or foreign variantId — a stale handle must
// produce an error the flow can handle, never a plausible wrong visa.
//
// Real models on mongodb-memory-server, the real router on a bare
// express app — same harness as visaHeadlineSelection.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-variant-test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.CONSUMER_JWT_SECRET ||= "consumer-distinct-test-secret";
process.env.NODE_ENV = "test";

const { default: VisaRule } = await import("../models/VisaRule.js");
const { default: publicVisaRouter } = await import("./public.visa.js");
const { resolveRuleFor, variantIdFor } = await import("../utils/visaRuleResolution.js");
const { computeVisaFeeBlock } = await import("../utils/visaFee.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/public", publicVisaRouter);
  return a;
}

function group(key: string, codes: string[]) {
  return { key, label: key, requirement: "REQUIRED", docTypeCodes: codes };
}

function ruleDoc(over: Record<string, any> = {}) {
  return {
    nationality: "IN",
    destinationIso2: "AU",
    destinationName: "Australia",
    purpose: "TOURIST",
    entryType: "UNSPECIFIED",
    serviceTier: "STANDARD",
    productClass: "VISA",
    visaCategory: "E_VISA",
    status: "PUBLISHED",
    isSchengen: false,
    etaMinDays: 35,
    etaMaxDays: 35,
    etaBasis: "BUSINESS",
    embassyFeeInr: 17250,
    vfsFeeInr: 0,
    plumtripsServiceFeeInr: 2000,
    d2cServiceFeeInr: null,
    variantKey: "DEFAULT",
    documentGroups: [
      group("g-passport", ["PASSPORT_ORIGINAL"]),
      group("g-id", ["INDIAN_GOVT_ID_CARD"]),
      group("g-bank", ["APPLICANT_BANK_STATEMENT"]),
      group("g-itr", ["INCOME_TAX_RETURN"]),
    ],
    ...over,
  };
}

const corridor = (iso2: string, purpose: string, variant?: string) =>
  request(app()).get(
    `/api/public/visa/corridor/${iso2}/${purpose}` + (variant ? `?variant=${variant}` : ""),
  );

/** AU as it actually is: three priced Tourist visas, Express the dear one. */
async function seedAu() {
  await VisaRule.create(
    ruleDoc({ variantKey: "VISITOR_VISA_EASY_APPLY", priceNote: "Visitor Visa (Easy Apply)", d2cServiceFeeInr: 2000 }),
  );
  await VisaRule.create(
    ruleDoc({ variantKey: "VISITOR_VISA", priceNote: "Visitor Visa", d2cServiceFeeInr: 2500 }),
  );
  await VisaRule.create(
    ruleDoc({
      variantKey: "VISITOR_VISA_EXPRESS",
      priceNote: "Visitor Visa - Express",
      d2cServiceFeeInr: 3000,
      embassyFeeInr: 82653,
      etaMinDays: 5,
      etaMaxDays: 5,
      // Express asks for LESS — the reason documents must follow the
      // variant and not merely the purpose.
      documentGroups: [
        group("g-passport", ["PASSPORT_ORIGINAL"]),
        group("g-id", ["INDIAN_GOVT_ID_CARD"]),
        group("g-bank", ["APPLICANT_BANK_STATEMENT"]),
      ],
    }),
  );
  // Not a visa (VISA_AMENDMENT) and a different purpose — neither may
  // appear as a selectable Tourist variant.
  await VisaRule.create(
    ruleDoc({ variantKey: "VISA_TRANSFER", priceNote: "Visa Transfer", productClass: "VISA_AMENDMENT", d2cServiceFeeInr: 1200, embassyFeeInr: 0 }),
  );
  await VisaRule.create(
    ruleDoc({ variantKey: "TRANSIT_77", priceNote: "Transit visa", purpose: "TRANSIT", productClass: "TRANSIT_VISA", d2cServiceFeeInr: 1500, embassyFeeInr: 0 }),
  );
}

async function idOf(namePart: RegExp) {
  const body = (await corridor("AU", "TOURIST")).body;
  return body.variants.find((v: any) => namePart.test(v.name)).variantId;
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
  await VisaRule.deleteMany({});
});

describe("variantId — an opaque, stable handle", () => {
  beforeEach(seedAu);

  it("every priced visa is addressable", async () => {
    const variants = (await corridor("AU", "TOURIST")).body.variants;
    expect(variants).toHaveLength(3); // Transfer + Transit are not visas
    for (const v of variants) expect(v.variantId).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set(variants.map((v: any) => v.variantId)).size).toBe(3);
  });

  it("does NOT leak variantKey — the deny-list still holds", async () => {
    const raw = JSON.stringify((await corridor("AU", "TOURIST")).body);
    expect(raw).not.toContain("variantKey");
    expect(raw).not.toContain("VISITOR_VISA_EXPRESS");
  });

  it("is stable across calls, and NOT the array position", async () => {
    /* The list sorts priced-cheapest-first, so ops re-pricing one visa
     * reshuffles it. An index-based handle would silently repoint a saved
     * draft at a different visa; the id must not move when the order does. */
    const before = (await corridor("AU", "TOURIST")).body.variants;
    const expressId = before.find((v: any) => /Express/.test(v.name)).variantId;
    expect(before.map((v: any) => v.name)).toEqual([
      "Visitor Visa (Easy Apply)",
      "Visitor Visa",
      "Visitor Visa - Express",
    ]);

    // Make Express the CHEAPEST. Its position changes; its id must not.
    await VisaRule.updateOne({ variantKey: "VISITOR_VISA_EXPRESS" }, { $set: { embassyFeeInr: 0 } });

    const after = (await corridor("AU", "TOURIST")).body.variants;
    expect(after[0].name).toBe("Visitor Visa - Express"); // moved to the front
    expect(after[0].variantId).toBe(expressId); // same identity
  });

  it("carries the fact fields the option cards render", async () => {
    await VisaRule.updateOne(
      { variantKey: "VISITOR_VISA_EXPRESS" },
      { $set: { maxStayDays: 90, validityDays: 365 } },
    );
    const v = (await corridor("AU", "TOURIST")).body.variants.find((x: any) => /Express/.test(x.name));
    expect(v.maxStayDays).toBe(90);
    expect(v.validityDays).toBe(365);
    expect(v.processingTime).toEqual({ minDays: 5, maxDays: 5, basis: "BUSINESS" });
  });
});

describe("THE INVARIANT — the variant shown is the variant charged and stored", () => {
  beforeEach(seedAu);

  it("Express: quoted == what the SUBMIT path independently resolves", async () => {
    const expressId = await idOf(/Express/);

    // What the reader is shown.
    const shown = (await corridor("AU", "TOURIST", expressId)).body;

    // What the submit would store — resolved by the SAME function POST /
    // calls, not by re-reading the response.
    const stored = await resolveRuleFor("AU", "TOURIST", expressId);
    const charged = computeVisaFeeBlock(stored as any, "D2C").totalInr;

    expect(stored?.variantKey).toBe("VISITOR_VISA_EXPRESS");
    expect(shown.price.totalInr).toBe(charged);
    expect(shown.price.totalInr).toBe(86193);
    expect(shown.resolvedVariantId).toBe(expressId);
  });

  it("Express brings its OWN documents — three, not the headline's four", async () => {
    const expressId = await idOf(/Express/);
    const shown = (await corridor("AU", "TOURIST", expressId)).body.documentGroups.flatMap(
      (g: any) => g.docCodes,
    );
    const stored: any = await resolveRuleFor("AU", "TOURIST", expressId);
    const snapshot = stored.documentGroups.flatMap((g: any) => g.docTypeCodes);

    expect(shown).toHaveLength(3);
    expect(shown).not.toContain("INCOME_TAX_RETURN");
    expect(shown.slice().sort()).toEqual(snapshot.slice().sort());
  });

  it("holds for EVERY priced variant, not just the interesting one", async () => {
    const variants = (await corridor("AU", "TOURIST")).body.variants;
    for (const v of variants) {
      const shown = (await corridor("AU", "TOURIST", v.variantId)).body;
      const stored = await resolveRuleFor("AU", "TOURIST", v.variantId);
      expect(shown.price.totalInr).toBe(computeVisaFeeBlock(stored as any, "D2C").totalInr);
      expect(shown.price.totalInr).toBe(v.price.totalInr);
    }
  });

  it("the three variants really are different products", async () => {
    // Guards against a resolver bug that returned the same rule for every
    // id and still passed every equality above.
    const totals = (await corridor("AU", "TOURIST")).body.variants.map((v: any) => v.price.totalInr);
    expect(totals).toEqual([19610, 20200, 86193]);
  });
});

describe("refusals — a stale handle NEVER becomes the headline", () => {
  beforeEach(seedAu);

  it("an unknown variantId 404s rather than falling back", async () => {
    const res = await corridor("AU", "TOURIST", "deadbeef1234");
    expect(res.status).toBe(404);
    expect(res.body.price).toBeUndefined();
    expect(await resolveRuleFor("AU", "TOURIST", "deadbeef1234")).toBeNull();
  });

  it("a variantId from ANOTHER purpose is not honoured", async () => {
    // The Transit visa's own id, offered to the Tourist pool. Resolving it
    // would sell a transit visa to someone who chose a tourist one.
    const transitId = (await corridor("AU", "TRANSIT")).body.resolvedVariantId;
    expect(transitId).toBeTruthy();
    expect((await corridor("AU", "TOURIST", transitId)).status).toBe(404);
    expect(await resolveRuleFor("AU", "TOURIST", transitId)).toBeNull();
  });

  it("a variantId from another CORRIDOR is not honoured", async () => {
    await VisaRule.create(
      ruleDoc({ destinationIso2: "VN", destinationName: "Vietnam", variantKey: "VN-1", d2cServiceFeeInr: 900 }),
    );
    const vn: any = await resolveRuleFor("VN", "TOURIST");
    expect(await resolveRuleFor("AU", "TOURIST", variantIdFor(vn))).toBeNull();
  });

  it("an UNPUBLISHED variant stops resolving", async () => {
    // The real staleness case: a reader holds an id from a page they
    // opened before ops retired that visa.
    const expressId = await idOf(/Express/);
    await VisaRule.updateOne({ variantKey: "VISITOR_VISA_EXPRESS" }, { $set: { status: "DRAFT" } });
    expect(await resolveRuleFor("AU", "TOURIST", expressId)).toBeNull();
    expect((await corridor("AU", "TOURIST", expressId)).status).toBe(404);
  });

  it("no variantId still means the headline — the pre-picker path", async () => {
    const headline = await resolveRuleFor("AU", "TOURIST");
    expect(headline?.variantKey).toBe("VISITOR_VISA_EASY_APPLY");
    expect((await corridor("AU", "TOURIST")).body.price.totalInr).toBe(19610);
  });
});

describe("unpriced corridors are untouched", () => {
  it("a corridor with no D2C fee still resolves its headline and lists its variants", async () => {
    // GB's shape: several published visas, none priced. Nothing here may
    // change — the picker filters to priced variants client-side, and the
    // server keeps answering exactly as before.
    for (const k of ["GB-PRIORITY", "GB-SUPER", "GB-STD"]) {
      await VisaRule.create(
        ruleDoc({ destinationIso2: "GB", destinationName: "United Kingdom", variantKey: k, priceNote: k, d2cServiceFeeInr: null }),
      );
    }
    const body = (await corridor("GB", "TOURIST")).body;
    expect(body.serviced).toBe(true);
    expect(body.price).toBeUndefined(); // omitted, never zeroed
    expect(body.variants).toHaveLength(3);
    for (const v of body.variants) {
      expect(v.price).toBeNull();
      expect(v.variantId).toMatch(/^[0-9a-f]{12}$/); // addressable anyway
    }
  });
});
