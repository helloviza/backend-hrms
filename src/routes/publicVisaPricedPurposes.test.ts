// apps/backend/src/routes/publicVisaPricedPurposes.test.ts
//
// `pricedPurposes` — WHICH OF A CORRIDOR'S PURPOSES CAN ACTUALLY BE SOLD.
//
// The country panel gated its "Get Started" CTA on `data.price`, which is
// the HEADLINE rule's price — and the headline is picked tourist-first. So
// a corridor with an unpriced tourist rule and a priced transit rule
// showed NO apply CTA at all, and that purpose was unreachable rather than
// merely undiscoverable: the purpose picker where the reader would have
// chosen it sits behind that button.
//
// The client cannot work this out for itself, which is why the field
// exists: `price` speaks only for the headline, and `variants[]` is
// filtered to productClass VISA, so a priced TRANSIT_VISA or
// VISA_AMENDMENT purpose appears in neither.
//
// The property that matters most is the LAST describe block: this flag
// must agree with what the apply flow actually resolves. A corridor that
// advertised a purpose the next screen could not price would be the same
// class of defect — a promise the following step breaks.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-priced-purposes-test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.CONSUMER_JWT_SECRET ||= "consumer-distinct-test-secret";
process.env.NODE_ENV = "test";

const { default: VisaRule } = await import("../models/VisaRule.js");
const { default: publicVisaRouter } = await import("./public.visa.js");
const { resolveRuleFor } = await import("../utils/visaRuleResolution.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/public", publicVisaRouter);
  return a;
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
    d2cServiceFeeInr: null, // UNPRICED by default — most of the catalogue
    variantKey: "DEFAULT",
    ...over,
  };
}

const panel = async (iso2: string) =>
  (await request(app()).get(`/api/public/visa/country/${iso2}`)).body;

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

describe("pricedPurposes — the corridor's sellable purposes", () => {
  it("AU as it really is: both purposes priced", async () => {
    await VisaRule.create(ruleDoc({ variantKey: "VISITOR", d2cServiceFeeInr: 2000 }));
    await VisaRule.create(
      ruleDoc({ variantKey: "TRANSIT_77", purpose: "TRANSIT", productClass: "TRANSIT_VISA", embassyFeeInr: 0, d2cServiceFeeInr: 1500 }),
    );
    const b = await panel("AU");
    expect(b.purposes).toEqual(["TOURIST", "TRANSIT"]);
    expect(b.pricedPurposes).toEqual(["TOURIST", "TRANSIT"]);
  });

  it("THE BUG: unpriced tourist + PRICED transit — the CTA's evidence", async () => {
    /* The shape that broke. The headline resolves to the unpriced tourist
     * rule, so `price` is omitted; variants[] holds only that same
     * unpriced tourist row because the transit rule is a TRANSIT_VISA.
     * Both of the client's old signals say "nothing here". */
    await VisaRule.create(ruleDoc({ variantKey: "VISITOR", d2cServiceFeeInr: null }));
    await VisaRule.create(
      ruleDoc({ variantKey: "TRANSIT_77", purpose: "TRANSIT", productClass: "TRANSIT_VISA", embassyFeeInr: 0, d2cServiceFeeInr: 1500 }),
    );

    const b = await panel("AU");
    expect(b.price).toBeUndefined(); // headline unpriced -> old gate said "hide"
    expect(b.variants.every((v: any) => v.price === null)).toBe(true); // and variants agreed
    // The new field is the only thing that knows the corridor is sellable.
    expect(b.pricedPurposes).toEqual(["TRANSIT"]);
  });

  it("nothing priced anywhere -> an empty list, and the CTA stays hidden", async () => {
    // GB today. There is genuinely nothing to sell; the enquiry form is
    // the right path and the flag must not manufacture a button to a dead end.
    await VisaRule.create(ruleDoc({ destinationIso2: "GB", destinationName: "United Kingdom", variantKey: "A" }));
    await VisaRule.create(ruleDoc({ destinationIso2: "GB", destinationName: "United Kingdom", variantKey: "B", purpose: "TRANSIT", productClass: "TRANSIT_VISA" }));
    const b = await panel("GB");
    expect(b.purposes).toEqual(["TOURIST", "TRANSIT"]);
    expect(b.pricedPurposes).toEqual([]);
  });

  it("is always a SUBSET of purposes", async () => {
    await VisaRule.create(ruleDoc({ variantKey: "T", d2cServiceFeeInr: 2000 }));
    await VisaRule.create(ruleDoc({ variantKey: "B", purpose: "BUSINESS" })); // unpriced
    const b = await panel("AU");
    expect(b.purposes).toEqual(["TOURIST", "BUSINESS"]);
    expect(b.pricedPurposes).toEqual(["TOURIST"]);
    for (const p of b.pricedPurposes) expect(b.purposes).toContain(p);
  });

  it("TOURIST_OR_BUSINESS prices BOTH cards it surfaces as", async () => {
    // One rule covering two purposes: if it is priced, both cards are
    // buyable, and the widening must be applied here exactly as the
    // resolver applies it.
    await VisaRule.create(
      ruleDoc({ destinationIso2: "SG", destinationName: "Singapore", variantKey: "BOTH", purpose: "TOURIST_OR_BUSINESS", d2cServiceFeeInr: 900 }),
    );
    const b = await panel("SG");
    expect(b.purposes).toEqual(["TOURIST", "BUSINESS"]);
    expect(b.pricedPurposes).toEqual(["TOURIST", "BUSINESS"]);
  });

  it("the productClass filter on variants[] is UNCHANGED", async () => {
    // The fix reads purposes; it must not have widened this. An amendment
    // is still not a visa type.
    await VisaRule.create(ruleDoc({ variantKey: "VISITOR", d2cServiceFeeInr: 2000 }));
    await VisaRule.create(
      ruleDoc({ variantKey: "TRANSFER", productClass: "VISA_AMENDMENT", embassyFeeInr: 0, d2cServiceFeeInr: 1200 }),
    );
    await VisaRule.create(
      ruleDoc({ variantKey: "TRANSIT_77", purpose: "TRANSIT", productClass: "TRANSIT_VISA", embassyFeeInr: 0, d2cServiceFeeInr: 1500 }),
    );
    const b = await panel("AU");
    expect(b.variants).toHaveLength(1); // the visitor visa alone
    expect(b.variants[0].name).not.toMatch(/transfer|transit/i);
  });
});

describe("the flag agrees with what the APPLY FLOW resolves", () => {
  it("every priced purpose really does resolve to a priced rule", async () => {
    await VisaRule.create(ruleDoc({ variantKey: "VISITOR", d2cServiceFeeInr: null }));
    await VisaRule.create(
      ruleDoc({ variantKey: "TRANSIT_77", purpose: "TRANSIT", productClass: "TRANSIT_VISA", embassyFeeInr: 0, d2cServiceFeeInr: 1500 }),
    );
    const b = await panel("AU");

    for (const p of b.pricedPurposes) {
      // resolveRuleFor is what POST /consumer/applications calls.
      const rule: any = await resolveRuleFor("AU", p);
      expect(rule).not.toBeNull();
      expect(rule.d2cServiceFeeInr).not.toBeNull();
      // ...and the corridor endpoint can therefore quote it.
      const res = await request(app()).get(`/api/public/visa/corridor/AU/${p}`);
      expect(res.status).toBe(200);
      expect(res.body.price).toBeTruthy();
    }
  });

  it("and every purpose it EXCLUDES genuinely cannot be quoted", async () => {
    await VisaRule.create(ruleDoc({ variantKey: "VISITOR", d2cServiceFeeInr: null }));
    await VisaRule.create(
      ruleDoc({ variantKey: "TRANSIT_77", purpose: "TRANSIT", productClass: "TRANSIT_VISA", embassyFeeInr: 0, d2cServiceFeeInr: 1500 }),
    );
    const b = await panel("AU");
    const excluded = b.purposes.filter((p: string) => !b.pricedPurposes.includes(p));
    expect(excluded).toEqual(["TOURIST"]);

    for (const p of excluded) {
      const res = await request(app()).get(`/api/public/visa/corridor/AU/${p}`);
      // The purpose is published (200) but carries no price — exactly why
      // it is not advertised as buyable.
      expect(res.status).toBe(200);
      expect(res.body.price).toBeUndefined();
    }
  });
});
