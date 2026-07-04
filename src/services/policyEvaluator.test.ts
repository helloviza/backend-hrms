import { describe, it, expect } from "vitest";
import {
  evaluateFlightPolicy,
  evaluateHotelPolicy,
  policyRulesFromDoc,
  type PolicyRules,
} from "./policyEvaluator.js";

const baseFlight = { priceINR: 10000, cabinClass: 2, fareType: "RETAIL" as const, isLCC: false, isRefundable: true };

describe("evaluateFlightPolicy — individual rules", () => {
  it("no policy → IN_POLICY with no_policy_configured", () => {
    expect(evaluateFlightPolicy(baseFlight, null)).toEqual({ status: "IN_POLICY", reasons: ["no_policy_configured"] });
    expect(evaluateFlightPolicy(baseFlight, undefined)).toEqual({ status: "IN_POLICY", reasons: ["no_policy_configured"] });
  });

  it("inactive policy is treated as no policy", () => {
    expect(evaluateFlightPolicy(baseFlight, { active: false, maxFlightPriceINR: 1 })).toEqual({
      status: "IN_POLICY",
      reasons: ["no_policy_configured"],
    });
  });

  it("empty policy → IN_POLICY with no reasons", () => {
    expect(evaluateFlightPolicy(baseFlight, { active: true })).toEqual({ status: "IN_POLICY", reasons: [] });
  });

  it("fare type not allowed → OUT_OF_POLICY", () => {
    const p: PolicyRules = { active: true, allowedFareTypes: ["CORPORATE"] };
    const r = evaluateFlightPolicy({ ...baseFlight, fareType: "RETAIL" }, p);
    expect(r.status).toBe("OUT_OF_POLICY");
    expect(r.reasons).toContain("fare_type_not_allowed");
  });

  it("cabin above cap → OUT_OF_POLICY", () => {
    const r = evaluateFlightPolicy({ ...baseFlight, cabinClass: 4 }, { active: true, cabinClassCap: 2 });
    expect(r.status).toBe("OUT_OF_POLICY");
    expect(r.reasons).toContain("cabin_above_cap");
  });

  it("price above hard cap → OUT_OF_POLICY", () => {
    const r = evaluateFlightPolicy({ ...baseFlight, priceINR: 20000 }, { active: true, maxFlightPriceINR: 15000 });
    expect(r.status).toBe("OUT_OF_POLICY");
    expect(r.reasons).toContain("price_above_cap");
  });

  it("requireRefundable + non-refundable → OUT_OF_POLICY", () => {
    const r = evaluateFlightPolicy({ ...baseFlight, isRefundable: false }, { active: true, requireRefundable: true });
    expect(r.status).toBe("OUT_OF_POLICY");
    expect(r.reasons).toContain("not_refundable");
  });

  it("allowLCC false + LCC flight → OUT_OF_POLICY", () => {
    const r = evaluateFlightPolicy({ ...baseFlight, isLCC: true }, { active: true, allowLCC: false });
    expect(r.status).toBe("OUT_OF_POLICY");
    expect(r.reasons).toContain("lcc_not_allowed");
  });

  it("above approval threshold (under hard cap) → NEEDS_APPROVAL", () => {
    const r = evaluateFlightPolicy({ ...baseFlight, priceINR: 12000 }, { active: true, approvalAbovePriceINR: 10000 });
    expect(r.status).toBe("NEEDS_APPROVAL");
    expect(r.reasons).toEqual(["needs_approval_price"]);
  });
});

describe("evaluateFlightPolicy — boundaries", () => {
  it("price exactly at cap is IN_POLICY (strictly greater triggers)", () => {
    expect(evaluateFlightPolicy({ ...baseFlight, priceINR: 15000 }, { active: true, maxFlightPriceINR: 15000 }).status).toBe("IN_POLICY");
    expect(evaluateFlightPolicy({ ...baseFlight, priceINR: 15001 }, { active: true, maxFlightPriceINR: 15000 }).status).toBe("OUT_OF_POLICY");
  });

  it("price exactly at approval threshold is IN_POLICY", () => {
    expect(evaluateFlightPolicy({ ...baseFlight, priceINR: 10000 }, { active: true, approvalAbovePriceINR: 10000 }).status).toBe("IN_POLICY");
  });

  it("cabin exactly at cap is IN_POLICY", () => {
    expect(evaluateFlightPolicy({ ...baseFlight, cabinClass: 2 }, { active: true, cabinClassCap: 2 }).status).toBe("IN_POLICY");
  });
});

describe("evaluateFlightPolicy — combined rules", () => {
  it("hard + soft both present → OUT_OF_POLICY, reasons include both", () => {
    const p: PolicyRules = { active: true, maxFlightPriceINR: 15000, approvalAbovePriceINR: 10000, allowLCC: false };
    const r = evaluateFlightPolicy({ ...baseFlight, priceINR: 20000, isLCC: true }, p);
    expect(r.status).toBe("OUT_OF_POLICY");
    expect(r.reasons).toEqual(expect.arrayContaining(["price_above_cap", "lcc_not_allowed", "needs_approval_price"]));
  });

  it("fully compliant flight → IN_POLICY, no reasons", () => {
    const p: PolicyRules = { active: true, allowedFareTypes: ["RETAIL"], cabinClassCap: 4, maxFlightPriceINR: 50000, approvalAbovePriceINR: 40000, allowLCC: true };
    expect(evaluateFlightPolicy(baseFlight, p)).toEqual({ status: "IN_POLICY", reasons: [] });
  });
});

describe("evaluateHotelPolicy", () => {
  it("no policy → no_policy_configured", () => {
    expect(evaluateHotelPolicy({ pricePerNightINR: 5000, starRating: 5 }, null)).toEqual({ status: "IN_POLICY", reasons: ["no_policy_configured"] });
  });

  it("star above cap → OUT_OF_POLICY", () => {
    const r = evaluateHotelPolicy({ starRating: 5, pricePerNightINR: 5000 }, { active: true, hotelStarCap: 4 });
    expect(r.status).toBe("OUT_OF_POLICY");
    expect(r.reasons).toContain("star_above_cap");
  });

  it("price above cap → OUT_OF_POLICY; above approval only → NEEDS_APPROVAL", () => {
    expect(evaluateHotelPolicy({ pricePerNightINR: 9000 }, { active: true, maxHotelPricePerNightINR: 8000 }).status).toBe("OUT_OF_POLICY");
    expect(evaluateHotelPolicy({ pricePerNightINR: 9000 }, { active: true, approvalAbovePriceINR: 8000 }).status).toBe("NEEDS_APPROVAL");
  });
});

describe("policyRulesFromDoc", () => {
  it("null doc → null", () => {
    expect(policyRulesFromDoc(null)).toBeNull();
  });
  it("maps doc fields, defaulting active true", () => {
    const rules = policyRulesFromDoc({ maxFlightPriceINR: 15000, allowedFareTypes: ["RETAIL"] });
    expect(rules).toMatchObject({ maxFlightPriceINR: 15000, allowedFareTypes: ["RETAIL"], active: true, cabinClassCap: null });
  });
});
