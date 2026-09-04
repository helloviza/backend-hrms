// apps/backend/src/routes/publicVisaCorridorPurpose.test.ts
//
// THE APPLY-FLOW WRONG-RULE BUG, pinned on real documents.
//
// Reported symptom: applied for an Australian TRANSIT visa; the upload
// step rendered the TOURIST rule's four document slots — no PHOTOGRAPH —
// and quoted the Tourist price, while the application that got created
// carried the Transit rule's fourteen checklist rows at the Transit
// price. "3 of 14 attached", two uploads matching no row on the stored
// checklist, and a photograph never asked for.
//
// Cause: the Apply flow read GET /visa/country/:iso2, whose contract is
// ONE REPRESENTATIVE rule for the corridor — and whose pool is filtered
// to tourist-ish BEFORE selecting, so on AU the Transit rule was never
// even a candidate. The submit resolved by the chosen purpose. Two pools,
// one shared tie-breaker, and a shared tie-breaker guarantees nothing.
//
// GET /visa/corridor/:iso2/:purpose is the fix: it calls resolveRuleFor()
// — the same function POST /consumer/applications calls — so the quote
// and the charge are one computation.
//
// Real models on mongodb-memory-server, the real router on a bare express
// app — never server.ts, which would boot the whole app. Same harness as
// visaHeadlineSelection.test.ts, deliberately: that file pins "both paths
// agree for TOURIST", this one pins the case where they did not.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/visa-corridor-purpose-test";
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

function ruleDoc(over: Record<string, any> = {}) {
  return {
    nationality: "IN",
    destinationIso2: "AU",
    destinationName: "Australia",
    purpose: "TOURIST",
    entryType: "SINGLE",
    serviceTier: "STANDARD",
    productClass: "VISA",
    visaCategory: "STICKER",
    status: "PUBLISHED",
    isSchengen: false,
    etaMinDays: 3,
    etaMaxDays: 7,
    etaBasis: "BUSINESS",
    maxStayDays: 30,
    validityDays: 90,
    embassyFeeInr: 0,
    vfsFeeInr: 0,
    plumtripsServiceFeeInr: 2000,
    d2cServiceFeeInr: null,
    variantKey: "DEFAULT",
    ...over,
  };
}

/** A group carrying real docTypeCodes, as the checklist hydrator reads it. */
function group(key: string, codes: string[]) {
  return { key, label: key, requirement: "REQUIRED", docTypeCodes: codes };
}

const browse = async (iso2: string) =>
  (await request(app()).get(`/api/public/visa/country/${iso2}`)).body;
const corridor = async (iso2: string, purpose: string) =>
  await request(app()).get(`/api/public/visa/corridor/${iso2}/${purpose}`);

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
 * AUSTRALIA AS IT ACTUALLY IS: four TOURIST rules and one TRANSIT.
 * The fixture mirrors the live corridor, including the detail that made
 * the bug total rather than partial — the Transit rule's productClass is
 * TRANSIT_VISA, so it is not merely outranked in the tourist pool, it is
 * filtered out of it before ranking begins.
 * ═════════════════════════════════════════════════════════════════════ */
async function seedAustralia() {
  await VisaRule.create(
    ruleDoc({
      variantKey: "VISITOR_VISA_EASY_APPLY",
      purpose: "TOURIST",
      d2cServiceFeeInr: 2000,
      documentGroups: [
        group("g-passport", ["PASSPORT_ORIGINAL"]),
        group("g-id", ["INDIAN_GOVT_ID_CARD"]),
        group("g-bank", ["APPLICANT_BANK_STATEMENT"]),
        group("g-itr", ["INCOME_TAX_RETURN"]),
      ],
    }),
  );
  await VisaRule.create(
    ruleDoc({ variantKey: "VISITOR_VISA", purpose: "TOURIST", d2cServiceFeeInr: 2500 }),
  );
  await VisaRule.create(
    ruleDoc({ variantKey: "VISITOR_VISA_EXPRESS", purpose: "TOURIST", d2cServiceFeeInr: 3000 }),
  );
  await VisaRule.create(
    ruleDoc({
      variantKey: "TRANSIT_VISA_SUBCLASS_77",
      purpose: "TRANSIT",
      productClass: "TRANSIT_VISA",
      d2cServiceFeeInr: 1500,
      documentGroups: [
        group("g-passport-front", ["PASSPORT_FRONT"]),
        group("g-passport", ["PASSPORT_ORIGINAL"]),
        group("g-photo", ["PHOTOGRAPH"]),
        group("g-nid", ["NATIONAL_ID"]),
        group("g-flight", ["FLIGHT_ITINERARY"]),
        group("g-bank", ["APPLICANT_BANK_STATEMENT"]),
      ],
    }),
  );
}

describe("GET /visa/corridor/:iso2/:purpose — the rule the SUBMIT will store", () => {
  beforeEach(seedAustralia);

  it("THE BUG: TRANSIT resolves the Transit rule, not the Tourist one", async () => {
    const res = await corridor("AU", "TRANSIT");
    expect(res.status).toBe(200);
    expect(res.body.purpose).toBe("TRANSIT");
    expect(res.body.resolvedForPurpose).toBe("TRANSIT");
  });

  it("and it asks for the PHOTOGRAPH the Tourist rule never mentions", async () => {
    // The single most visible symptom: the applicant was never shown a
    // photo slot, so the 35x45 cropper could not fire and the ops team
    // received a case with no photograph on it.
    const codes = (await corridor("AU", "TRANSIT")).body.documentGroups.flatMap(
      (g: any) => g.docCodes,
    );
    expect(codes).toContain("PHOTOGRAPH");

    const tourist = (await corridor("AU", "TOURIST")).body.documentGroups.flatMap(
      (g: any) => g.docCodes,
    );
    expect(tourist).not.toContain("PHOTOGRAPH");
  });

  it("QUOTE == CHARGE: the endpoint prices the rule resolveRuleFor stores", async () => {
    /* THE INVARIANT THE WHOLE CHANGE EXISTS FOR.
     * Not "both look like 1770" — the quoted figure is compared against a
     * fee block computed from the rule the CREATE path independently
     * resolves, so a future divergence in either pool fails here. */
    const quoted = (await corridor("AU", "TRANSIT")).body.price.totalInr;
    const stored = await resolveRuleFor("AU", "TRANSIT");
    const charged = computeVisaFeeBlock(stored as any, "D2C").totalInr;

    expect(stored?.variantKey).toBe("TRANSIT_VISA_SUBCLASS_77");
    expect(quoted).toBe(charged);
  });

  it("the documents shown are the documents that get stored", async () => {
    const shown = (await corridor("AU", "TRANSIT")).body.documentGroups.flatMap(
      (g: any) => g.docCodes,
    );
    const stored = await resolveRuleFor("AU", "TRANSIT");
    const snapshot = (stored as any).documentGroups.flatMap((g: any) => g.docTypeCodes);
    expect(shown.slice().sort()).toEqual(snapshot.slice().sort());
  });

  it("TOURIST still resolves what it always did — the common case is untouched", async () => {
    const res = await corridor("AU", "TOURIST");
    const quoted = res.body.price.totalInr;
    const charged = computeVisaFeeBlock(
      (await resolveRuleFor("AU", "TOURIST")) as any,
      "D2C",
    ).totalInr;
    expect(res.body.purpose).toBe("TOURIST");
    expect(quoted).toBe(charged);
    // The cheapest sellable tourist variant, exactly as before.
    expect(res.body.documentGroups.flatMap((g: any) => g.docCodes)).toEqual([
      "PASSPORT_ORIGINAL",
      "INDIAN_GOVT_ID_CARD",
      "APPLICANT_BANK_STATEMENT",
      "INCOME_TAX_RETURN",
    ]);
  });

  it("`purposes` stays CORRIDOR-WIDE so step 1 can still offer both", async () => {
    // Narrowing this to the selected purpose would delete the reader's
    // ability to switch visa type — a fix that broke the flow it fixed.
    for (const p of ["TOURIST", "TRANSIT"]) {
      expect((await corridor("AU", p)).body.purposes).toEqual(["TOURIST", "TRANSIT"]);
    }
  });
});

describe("the browse endpoint is NOT changed by any of this", () => {
  beforeEach(seedAustralia);

  it("GET /country/:iso2 still headlines the representative tourist rule", async () => {
    // Its contract — one representative rule for a reader who has not
    // chosen — is correct for the requirements slider and stays.
    const body = await browse("AU");
    expect(body.purpose).toBe("TOURIST");
    expect(body.documentGroups.flatMap((g: any) => g.docCodes)).not.toContain("PHOTOGRAPH");
  });

  it("and it does NOT claim to have been resolved for a purpose", async () => {
    // The client gates on this field. A browse payload that carried one
    // would be admitted by that gate and price the wrong visa again.
    expect((await browse("AU")).resolvedForPurpose).toBeUndefined();
  });

  it("browse and corridor/TOURIST agree — the divergence was purpose-specific", async () => {
    const b = await browse("AU");
    const c = (await corridor("AU", "TOURIST")).body;
    expect(c.price.totalInr).toBe(b.price.totalInr);
    expect(c.documentGroups).toEqual(b.documentGroups);
  });
});

describe("refusals — it never falls back to another purpose's rule", () => {
  it("404s for a purpose the corridor publishes nothing for", async () => {
    await seedAustralia(); // AU has TOURIST + TRANSIT, no BUSINESS
    const res = await corridor("AU", "BUSINESS");
    expect(res.status).toBe(404);
    // The important half: it did not quietly serve the Tourist rule.
    expect(res.body.purpose).toBeUndefined();
    expect(res.body.price).toBeUndefined();
  });

  it("404s for a purpose that is not a purpose at all", async () => {
    await seedAustralia();
    const res = await corridor("AU", "STUDENT");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unknown visa purpose");
  });

  it("404s for an unknown destination", async () => {
    const res = await corridor("ZZ", "TOURIST");
    expect(res.status).toBe(404);
  });

  it("TOURIST widens to a TOURIST_OR_BUSINESS rule, as the cards promise", async () => {
    /* purposeMatchValues' widening, proven end to end: a corridor whose
     * only rule covers both is bookable as either, and the endpoint
     * reports the REQUESTED purpose rather than the rule's own value —
     * which is exactly why the client gates on resolvedForPurpose. */
    await VisaRule.create(
      ruleDoc({
        destinationIso2: "SG",
        destinationName: "Singapore",
        purpose: "TOURIST_OR_BUSINESS",
        variantKey: "SG-BOTH",
        d2cServiceFeeInr: 900,
      }),
    );
    for (const asked of ["TOURIST", "BUSINESS"]) {
      const res = await corridor("SG", asked);
      expect(res.status).toBe(200);
      expect(res.body.purpose).toBe("TOURIST_OR_BUSINESS"); // the rule's own value
      expect(res.body.resolvedForPurpose).toBe(asked); // what was asked
    }
  });
});
