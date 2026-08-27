// Unit cover for the headline-rule ladder.
//
// These are LITERAL fixtures on purpose: selectHeadlineRule is pure, reads
// four fields, and touches no database. The document-level proof — that the
// public endpoint and the create path pick the SAME rule out of real Mongo
// documents — lives in routes/visaHeadlineSelection.test.ts, because that
// is a question about two call sites rather than about this function.
import { describe, it, expect } from "vitest";
import { selectHeadlineRule, isSellableHeadlineRule } from "./visaHeadlineRule.js";

/** A rule priced so its D2C total is predictable: fee + 18% GST. */
function rule(over: Record<string, any> = {}) {
  return {
    variantKey: "base",
    productClass: "VISA",
    visaCategory: "E_VISA",
    purpose: "TOURIST",
    d2cServiceFeeInr: null,
    plumtripsServiceFeeInr: null,
    embassyFeeInr: 0,
    vfsFeeInr: 0,
    ...over,
  };
}

describe("isSellableHeadlineRule — the predicate", () => {
  it("accepts a priced real visa", () => {
    expect(isSellableHeadlineRule(rule({ d2cServiceFeeInr: 500 }))).toBe(true);
  });

  it("accepts a priced VISA_FREE service product (TH/MY TDAC)", () => {
    expect(
      isSellableHeadlineRule(
        rule({ d2cServiceFeeInr: 400, productClass: "ARRIVAL_CARD", visaCategory: "VISA_FREE" }),
      ),
    ).toBe(true);
  });

  it("rejects an UNPRICED rule even when it is a real visa", () => {
    expect(isSellableHeadlineRule(rule({ d2cServiceFeeInr: null }))).toBe(false);
  });

  it("rejects a priced non-visa add-on that is not VISA_FREE", () => {
    expect(
      isSellableHeadlineRule(
        rule({ d2cServiceFeeInr: 100, productClass: "ARRIVAL_CARD", visaCategory: "E_VISA" }),
      ),
    ).toBe(false);
  });

  it("treats undefined and null d2cServiceFeeInr the same (== null, not === null)", () => {
    expect(isSellableHeadlineRule(rule({ d2cServiceFeeInr: undefined }))).toBe(false);
  });

  it("does NOT treat a zero fee as unpriced — 0 is a decision, null is an absence", () => {
    expect(isSellableHeadlineRule(rule({ d2cServiceFeeInr: 0 }))).toBe(true);
  });
});

describe("selectHeadlineRule — the ladder", () => {
  it("a priced real visa beats a CHEAPER unpriced add-on (the headline bug)", () => {
    // The add-on totals 0 and would win the old cheapest-of-all sort.
    const addon = rule({ variantKey: "arrival-card", productClass: "ARRIVAL_CARD", d2cServiceFeeInr: null });
    const visa = rule({ variantKey: "tourist-evisa", d2cServiceFeeInr: 1500 });

    expect(selectHeadlineRule([addon, visa])?.variantKey).toBe("tourist-evisa");
  });

  it("a priced real visa beats a CHEAPER PRICED add-on", () => {
    const addon = rule({ variantKey: "arrival-card", productClass: "ARRIVAL_CARD", d2cServiceFeeInr: 200 });
    const visa = rule({ variantKey: "tourist-evisa", d2cServiceFeeInr: 1500 });

    expect(selectHeadlineRule([addon, visa])?.variantKey).toBe("tourist-evisa");
  });

  it("authoring a D2C price CHANGES the winner — the field now does something", () => {
    const unpriced = rule({ variantKey: "unpriced", d2cServiceFeeInr: null });
    const before = selectHeadlineRule([unpriced, rule({ variantKey: "other", d2cServiceFeeInr: null })]);
    expect(before?.d2cServiceFeeInr).toBeNull(); // fallback: nothing priced

    const priced = rule({ variantKey: "other", d2cServiceFeeInr: 900 });
    expect(selectHeadlineRule([unpriced, priced])?.variantKey).toBe("other");
  });

  it("VISA_FREE with a price headlines rather than falling through (TH/MY)", () => {
    const tdac = rule({
      variantKey: "tdac",
      productClass: "ARRIVAL_CARD",
      visaCategory: "VISA_FREE",
      d2cServiceFeeInr: 350,
    });
    const unpricedOther = rule({ variantKey: "zz-other", d2cServiceFeeInr: null });

    expect(selectHeadlineRule([unpricedOther, tdac])?.variantKey).toBe("tdac");
  });

  it("cheapest wins WITHIN the preferred pool", () => {
    const dear = rule({ variantKey: "express", d2cServiceFeeInr: 4000 });
    const cheap = rule({ variantKey: "standard", d2cServiceFeeInr: 1200 });

    expect(selectHeadlineRule([dear, cheap])?.variantKey).toBe("standard");
  });

  it("ties resolve deterministically by variantKey, NOT by array order", () => {
    const a = rule({ variantKey: "aaa", d2cServiceFeeInr: 1000 });
    const z = rule({ variantKey: "zzz", d2cServiceFeeInr: 1000 });

    // Same answer whichever order Mongo hands them back.
    expect(selectHeadlineRule([z, a])?.variantKey).toBe("aaa");
    expect(selectHeadlineRule([a, z])?.variantKey).toBe("aaa");
  });

  /* ── the preference, not a filter ─────────────────────────────────── */

  it("falls back to cheapest-of-all when NOTHING is priced — never undefined", () => {
    const a = rule({ variantKey: "a", d2cServiceFeeInr: null, embassyFeeInr: 5000 });
    const b = rule({ variantKey: "b", d2cServiceFeeInr: null, embassyFeeInr: 2000 });

    const picked = selectHeadlineRule([a, b]);
    expect(picked).toBeDefined();
    expect(picked?.variantKey).toBe("b"); // cheapest of all, exactly as before
  });

  it("falls back when the only priced rules are non-visa add-ons", () => {
    const addon = rule({
      variantKey: "addon",
      productClass: "FORM_SERVICE",
      visaCategory: "E_VISA",
      d2cServiceFeeInr: 100,
    });
    const unpricedVisa = rule({ variantKey: "visa", d2cServiceFeeInr: null, embassyFeeInr: 9000 });

    // Pool is empty -> old behaviour -> the cheap add-on wins on total.
    // Documented consequence: a corridor with no priced VISA still renders,
    // and buildPublicPrice gates the price off separately.
    expect(selectHeadlineRule([addon, unpricedVisa])?.variantKey).toBe("addon");
  });

  it("the FALLBACK comparator is unchanged — no variantKey tie-break there", () => {
    // Both unpriced, identical totals. Old behaviour = array order wins.
    const z = rule({ variantKey: "zzz", d2cServiceFeeInr: null });
    const a = rule({ variantKey: "aaa", d2cServiceFeeInr: null });

    expect(selectHeadlineRule([z, a])?.variantKey).toBe("zzz");
    expect(selectHeadlineRule([a, z])?.variantKey).toBe("aaa");
  });

  it("returns undefined only for an empty array (callers guard this)", () => {
    expect(selectHeadlineRule([])).toBeUndefined();
  });

  /* ── the 2026-08-27 product classes ───────────────────────────────────
   * The predicate is an ALLOWLIST (`productClass === "VISA"`), so every
   * non-VISA class is excluded by construction and adding a class needs no
   * change here. These pin that property per value, so a future edit that
   * turns the allowlist into a denylist fails loudly instead of silently
   * letting a transit visa headline a corridor again.
   * ─────────────────────────────────────────────────────────────────── */
  for (const cls of ["TRANSIT_VISA", "VISA_AMENDMENT", "TRAVEL_LEVY", "DOCUMENT_SERVICE"] as const) {
    it(`excludes a PRICED ${cls} from the preferred pool`, () => {
      const ancillary = rule({ variantKey: "anc", productClass: cls, d2cServiceFeeInr: 300 });
      const visa = rule({ variantKey: "real-visa", d2cServiceFeeInr: 5000 });

      expect(isSellableHeadlineRule(ancillary)).toBe(false);
      // Dearer, but it is the only genuine visa — it must still headline.
      expect(selectHeadlineRule([ancillary, visa])?.variantKey).toBe("real-visa");
    });
  }

  it("the AU case end-to-end: a priced Visa Transfer never outranks the visitor visa", () => {
    const transfer = rule({ variantKey: "VISA_TRANSFER", productClass: "VISA_AMENDMENT", d2cServiceFeeInr: 1200 });
    const transit = rule({ variantKey: "TRANSIT_771", productClass: "TRANSIT_VISA", d2cServiceFeeInr: 1500 });
    const visitor = rule({ variantKey: "VISITOR_EASY_APPLY", d2cServiceFeeInr: 2000, embassyFeeInr: 17250 });

    expect(selectHeadlineRule([transfer, transit, visitor])?.variantKey).toBe("VISITOR_EASY_APPLY");
  });

  it("TH/MY survive the retype: an ARRIVAL_CARD that is VISA_FREE stays eligible", () => {
    // Retyped away from VISA, so arm one now fails — arm two is what saves it,
    // and this is the case that arm exists for.
    const tdac = rule({
      variantKey: "TDAC",
      productClass: "ARRIVAL_CARD",
      visaCategory: "VISA_FREE",
      d2cServiceFeeInr: 350,
    });

    expect(isSellableHeadlineRule(tdac)).toBe(true);
    expect(selectHeadlineRule([tdac])?.variantKey).toBe("TDAC");
  });

  it("an ARRIVAL_CARD that is NOT visa-free is excluded (SG/VN-style)", () => {
    const card = rule({ variantKey: "sg-card", productClass: "ARRIVAL_CARD", visaCategory: "E_VISA", d2cServiceFeeInr: 500 });
    const visa = rule({ variantKey: "sg-visa", d2cServiceFeeInr: 1800 });

    expect(isSellableHeadlineRule(card)).toBe(false);
    expect(selectHeadlineRule([card, visa])?.variantKey).toBe("sg-visa");
  });

  it("a single unpriced rule still resolves — the uncurated-corridor case", () => {
    const only = rule({ variantKey: "solo", d2cServiceFeeInr: null });
    expect(selectHeadlineRule([only])?.variantKey).toBe("solo");
  });
});
