// WHICH RULE SPEAKS FOR A CORRIDOR — proven on real documents, on both paths.
//
// utils/visaHeadlineRule.test.ts pins the ladder as a pure function. This
// file exists to prove the thing that function cannot prove about itself:
// that the PUBLIC headline endpoint and the CREATE path resolve the SAME
// rule out of real Mongo documents. A consumer quoted one price and booked
// against another is the defect both call sites are shaped to prevent, and
// only a test that drives both can catch a future divergence.
//
// Real models on mongodb-memory-server, the real router on a bare express
// app — never server.ts, which would boot the whole app.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-headline-test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.CONSUMER_JWT_SECRET ||= "consumer-distinct-test-secret";
process.env.NODE_ENV = "test";

const { default: VisaRule } = await import("../models/VisaRule.js");
const { default: publicVisaRouter } = await import("./public.visa.js");
const { resolveRuleFor } = await import("./consumer.applications.js");
const { computeVisaFeeBlock } = await import("../utils/visaFee.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/public", publicVisaRouter);
  return a;
}

/**
 * A PUBLISHED rule carrying every field VisaRule marks required.
 * `d2cServiceFeeInr: null` is the unpriced case and is the default here,
 * because unpriced is what most of the catalogue actually looks like.
 */
function ruleDoc(over: Record<string, any> = {}) {
  return {
    nationality: "IN",
    destinationIso2: "VN",
    destinationName: "Vietnam",
    purpose: "TOURIST",
    entryType: "SINGLE",
    serviceTier: "STANDARD",
    productClass: "VISA",
    visaCategory: "E_VISA",
    status: "PUBLISHED",
    isSchengen: false,
    etaMinDays: 3,
    etaMaxDays: 7,
    etaBasis: "BUSINESS",
    maxStayDays: 30,
    validityDays: 90,
    embassyFeeInr: 0,
    vfsFeeInr: 0,
    plumtripsServiceFeeInr: 2000, // B2B — constant across every fixture here
    d2cServiceFeeInr: null,
    variantKey: "DEFAULT",
    ...over,
  };
}

/** The public payload for a corridor. */
async function panel(iso2: string) {
  return (await request(app()).get(`/api/public/visa/country/${iso2}`)).body;
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

/* ═══════════════════════════════════════════════════════════════════════
 * 1. A priced real visa outranks an add-on — the headline bug itself.
 * ═════════════════════════════════════════════════════════════════════ */
describe("mixed corridor: priced visa + unpriced add-on", () => {
  beforeEach(async () => {
    await VisaRule.create(
      ruleDoc({
        variantKey: "ARRIVAL-CARD",
        productClass: "ARRIVAL_CARD",
        visaCategory: "E_VISA",
        d2cServiceFeeInr: null, // totals 0 — would win the OLD sort
      }),
    );
    await VisaRule.create(ruleDoc({ variantKey: "TOURIST-EVISA", d2cServiceFeeInr: 1500 }));
    await VisaRule.create(
      ruleDoc({ variantKey: "EXPRESS", d2cServiceFeeInr: 4000 }), // priced but dearer
    );
  });

  it("the PUBLIC panel headlines the priced real visa, not the free add-on", async () => {
    const body = await panel("VN");
    const expected = computeVisaFeeBlock({ d2cServiceFeeInr: 1500 } as any, "D2C").totalInr;

    expect(body.serviced).toBe(true);
    expect(body.price).not.toBeNull();
    expect(body.price.totalInr).toBe(expected);
  });

  it("the CREATE path resolves the SAME rule", async () => {
    const rule = await resolveRuleFor("VN", "TOURIST");
    expect(rule?.variantKey).toBe("TOURIST-EVISA");
  });

  it("both paths agree on the total — the quote/booking contract", async () => {
    const body = await panel("VN");
    const rule = await resolveRuleFor("VN", "TOURIST");
    expect(computeVisaFeeBlock(rule as any, "D2C").totalInr).toBe(body.price.totalInr);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 2. VISA_FREE stays serviced and priced (TH/MY TDAC).
 * ═════════════════════════════════════════════════════════════════════ */
describe("visa-free corridor with a priced service product", () => {
  beforeEach(async () => {
    await VisaRule.create(
      ruleDoc({
        destinationIso2: "TH",
        destinationName: "Thailand",
        variantKey: "TDAC",
        productClass: "ARRIVAL_CARD",
        visaCategory: "VISA_FREE",
        d2cServiceFeeInr: 350,
      }),
    );
    await VisaRule.create(
      ruleDoc({
        destinationIso2: "TH",
        destinationName: "Thailand",
        variantKey: "ZZ-UNPRICED",
        d2cServiceFeeInr: null,
      }),
    );
  });

  it("the TDAC headlines rather than falling through to the unpriced rule", async () => {
    const body = await panel("TH");
    const expected = computeVisaFeeBlock({ d2cServiceFeeInr: 350 } as any, "D2C").totalInr;

    expect(body.serviced).toBe(true);
    expect(body.price?.totalInr).toBe(expected);
  });

  it("the CREATE path picks the TDAC too", async () => {
    const rule = await resolveRuleFor("TH", "TOURIST");
    expect(rule?.variantKey).toBe("TDAC");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 3. THE PREFERENCE, NOT A FILTER — an unpriced corridor is unchanged.
 * ═════════════════════════════════════════════════════════════════════ */
describe("uncurated/unpriced corridor: today's behaviour, exactly", () => {
  beforeEach(async () => {
    await VisaRule.create(
      ruleDoc({ destinationIso2: "AZ", destinationName: "Azerbaijan", variantKey: "A", embassyFeeInr: 5000 }),
    );
    await VisaRule.create(
      ruleDoc({ destinationIso2: "AZ", destinationName: "Azerbaijan", variantKey: "B", embassyFeeInr: 2000 }),
    );
  });

  it("still renders a full serviced payload and simply omits the price", async () => {
    const body = await panel("AZ");

    expect(body.ok).toBe(true);
    expect(body.serviced).toBe(true);
    // The key is OMITTED, not null — `if (price) payload.price = price`
    // (public.visa.ts). Deliberate: a ₹0 price claims the visa is free,
    // whereas an absent price says "we do not quote this corridor", which is
    // the truth. Asserted as absence so a future `price: null` regression
    // fails here rather than reaching the panel.
    expect(body.price).toBeUndefined();
    expect(Object.keys(body)).not.toContain("price");
    expect(body).toHaveProperty("documents");
    expect(body).toHaveProperty("documentGroups");
  });

  it("does NOT 500 — the failure mode a hard filter would have shipped", async () => {
    const res = await request(app()).get("/api/public/visa/country/AZ");
    expect(res.status).toBe(200);
  });

  it("falls back to cheapest-of-all, so the OLD winner still wins", async () => {
    const rule = await resolveRuleFor("AZ", "TOURIST");
    expect(rule?.variantKey).toBe("B"); // 2000 < 5000
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 4. Ties resolve deterministically inside the preferred pool.
 * ═════════════════════════════════════════════════════════════════════ */
describe("tie inside the preferred pool", () => {
  it("picks the same winner regardless of insertion order", async () => {
    // Inserted zzz-first so Mongo's natural order would hand back ZZZ first.
    await VisaRule.create(
      ruleDoc({ destinationIso2: "GE", destinationName: "Georgia", variantKey: "ZZZ", d2cServiceFeeInr: 1000 }),
    );
    await VisaRule.create(
      ruleDoc({ destinationIso2: "GE", destinationName: "Georgia", variantKey: "AAA", d2cServiceFeeInr: 1000 }),
    );

    expect((await resolveRuleFor("GE", "TOURIST"))?.variantKey).toBe("AAA");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 5. B2B IS UNTOUCHED.
 * ═════════════════════════════════════════════════════════════════════ */
describe("B2B channel is unaffected by D2C headline selection", () => {
  it("the B2B total reads plumtripsServiceFeeInr regardless of D2C fields", async () => {
    const priced = ruleDoc({ d2cServiceFeeInr: 1500, plumtripsServiceFeeInr: 2000 });
    const unpriced = ruleDoc({ d2cServiceFeeInr: null, plumtripsServiceFeeInr: 2000 });

    const a = computeVisaFeeBlock(priced as any, "B2B").totalInr;
    const b = computeVisaFeeBlock(unpriced as any, "B2B").totalInr;

    // Identical: the D2C fee is invisible to the B2B channel, so nothing the
    // headline selector prefers can move a B2B number.
    expect(a).toBe(b);
    expect(a).toBe(computeVisaFeeBlock({ plumtripsServiceFeeInr: 2000 } as any, "B2B").totalInr);
  });
});
