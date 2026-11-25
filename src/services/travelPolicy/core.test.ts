// apps/backend/src/services/travelPolicy/core.test.ts
//
// Pure tests for the Travel Policy rules (no DB): tier resolution (D2/D3),
// rule precedence (audit §6), destination classification, IST version
// state, input sanitising and publish validation.
import { describe, it, expect } from "vitest";
import {
  PolicyInputError,
  addDays,
  MAX_AMOUNT,
  destinationCityKey,
  duplicateTierProblems,
  gapLines,
  policyGaps,
  samePolicy,
  valueWarnings,
  classifyDestination,
  diffContent,
  isIsoDate,
  istToday,
  normalizeKey,
  regionOfCountry,
  resolveTier,
  sanitizeDraft,
  selectRule,
  validateForPublish,
  versionState,
  windowsOverlap,
  type CityForClass,
  type Rule,
  type Tier,
} from "./core.js";
import { TEMPLATE_CITIES, TEMPLATE_RULES, TEMPLATE_TIERS } from "../../data/travelPolicyTemplate.js";

const D1 = "a".repeat(24);
const D2 = "b".repeat(24);
const D3 = "c".repeat(24);

const tier = (tierKey: string, over: Partial<Tier> = {}): Tier => ({
  tierKey,
  name: tierKey.toUpperCase(),
  code: "",
  description: "",
  sortOrder: 0,
  active: true,
  designationIds: [],
  bandNumbers: [],
  ...over,
});

const hotel = (ruleKey: string, tierKey: string, kind: Rule["scope"]["kind"], value: string | null, maxPerNight: number): Rule => ({
  ruleKey,
  category: "HOTEL",
  tierKey,
  scope: { kind, value },
  currency: "INR",
  notes: "",
  params: { maxPerNight, taxesIncluded: true, maxStarRating: null },
});

const CITIES: CityForClass[] = [
  { nameKey: "bengaluru", country: "IN", category: "METRO", isActive: true },
  { nameKey: "jaipur", country: "IN", category: "TIER2", isActive: true },
  { nameKey: "pune", country: "IN", category: "METRO", isActive: false }, // deactivated → OTHER
];

describe("resolveTier — precedence override > designation > band > unmapped", () => {
  const tiers = [
    tier("lead", { sortOrder: 0, designationIds: [D1], bandNumbers: [9, 10] }),
    tier("mid", { sortOrder: 1, designationIds: [D2], bandNumbers: [5, 6] }),
    tier("old", { sortOrder: 2, active: false, designationIds: [D3], bandNumbers: [1] }),
  ];

  it("an explicit override beats the designation and the band", () => {
    const r = resolveTier({ designationId: D1, bandNumber: 9 }, tiers, { tierKey: "mid" });
    expect(r).toEqual({ status: "MAPPED", tierKey: "mid", source: "OVERRIDE", staleOverride: false });
  });

  it("the designation beats the band", () => {
    const r = resolveTier({ designationId: D2, bandNumber: 10 }, tiers);
    expect(r.tierKey).toBe("mid");
    expect(r.source).toBe("DESIGNATION");
  });

  it("falls back to the band when the designation is not mapped", () => {
    const r = resolveTier({ designationId: "f".repeat(24), bandNumber: 10 }, tiers);
    expect(r).toMatchObject({ status: "MAPPED", tierKey: "lead", source: "BAND" });
  });

  it("nothing matches → UNMAPPED", () => {
    expect(resolveTier({ designationId: null, bandNumber: null }, tiers).status).toBe("UNMAPPED");
    expect(resolveTier({ bandNumber: 3 }, tiers).status).toBe("UNMAPPED");
  });

  it("an inactive tier never matches (designation or band)", () => {
    expect(resolveTier({ designationId: D3 }, tiers).status).toBe("UNMAPPED");
    expect(resolveTier({ bandNumber: 1 }, tiers).status).toBe("UNMAPPED");
  });

  it("an override to a missing or inactive tier is stale: ignored, flagged, and resolution continues", () => {
    const r = resolveTier({ designationId: D2 }, tiers, { tierKey: "old" });
    expect(r).toEqual({ status: "MAPPED", tierKey: "mid", source: "DESIGNATION", staleOverride: true });
    const r2 = resolveTier({}, tiers, { tierKey: "gone" });
    expect(r2).toEqual({ status: "UNMAPPED", tierKey: null, source: null, staleOverride: true });
  });

  it("GUEST (D3) wins over everything and is not mapped", () => {
    const r = resolveTier({ designationId: D1, bandNumber: 9 }, tiers, { tierKey: "lead", excluded: "GUEST" });
    expect(r.status).toBe("GUEST");
    expect(r.tierKey).toBeNull();
  });

  it("a draft with the same designation in two tiers resolves deterministically by sortOrder", () => {
    const dup = [tier("b", { sortOrder: 5, designationIds: [D1] }), tier("a", { sortOrder: 1, designationIds: [D1] })];
    expect(resolveTier({ designationId: D1 }, dup).tierKey).toBe("a");
  });
});

describe("selectRule — CITY > COUNTRY > REGION > CITY_CLASS > DEFAULT, no merge, no cross-tier fallback", () => {
  const rules: Rule[] = [
    hotel("m", "mid", "CITY_CLASS", "METRO", 7000),
    hotel("t", "mid", "CITY_CLASS", "TIER2", 5000),
    hotel("o", "mid", "CITY_CLASS", "OTHER", 4000),
    hotel("i", "mid", "CITY_CLASS", "INTERNATIONAL", 12000),
    hotel("blr", "mid", "CITY", "bengaluru", 9000),
    hotel("eu", "mid", "REGION", "EUROPE", 15000),
    hotel("gb", "mid", "COUNTRY", "GB", 18000),
    hotel("lead-m", "lead", "CITY_CLASS", "METRO", 15000),
  ];

  const pick = (cityKey: string | null, country: string | null, tierKey = "mid") =>
    selectRule(rules, "HOTEL", tierKey, { cityKey, country }, CITIES);

  it("a CITY override beats the city class", () => {
    expect(pick("bengaluru", "IN")).toMatchObject({ matchedBy: "CITY", rule: { ruleKey: "blr" } });
  });
  it("an Indian city in the master takes its class", () => {
    expect(pick("jaipur", "IN")).toMatchObject({ matchedBy: "CITY_CLASS", rule: { ruleKey: "t" } });
  });
  it("an Indian city not in the master, or deactivated, is OTHER", () => {
    expect(pick("bhilai", "IN")!.rule.ruleKey).toBe("o");
    expect(pick("pune", "IN")!.rule.ruleKey).toBe("o");
  });
  it("COUNTRY beats REGION beats CITY_CLASS for international", () => {
    expect(pick("london", "GB")).toMatchObject({ matchedBy: "COUNTRY", rule: { ruleKey: "gb" } });
    expect(pick("paris", "FR")).toMatchObject({ matchedBy: "REGION", rule: { ruleKey: "eu" } });
    expect(pick("dubai", "AE")).toMatchObject({ matchedBy: "CITY_CLASS", rule: { ruleKey: "i" } });
  });
  it("a tier with no rule for the category gets null, never another tier's rule", () => {
    expect(selectRule(rules, "HOTEL", "junior", { cityKey: "bengaluru", country: "IN" }, CITIES)).toBeNull();
    expect(selectRule(rules, "FOREX", "mid", { cityKey: null, country: "GB" }, CITIES)).toBeNull();
    // lead has only METRO: an OTHER city is a gap, not mid's rule
    expect(pick("bhilai", "IN", "lead")).toBeNull();
  });
  it("DEFAULT is the last resort", () => {
    const withDefault: Rule[] = [
      { ruleKey: "fx", category: "FOREX", tierKey: "mid", scope: { kind: "DEFAULT", value: null }, currency: "INR", notes: "", params: { eligible: true, perTripMax: 1, perDayMax: 1, allowedCurrencies: [], appliesTo: "INTERNATIONAL" } },
      { ruleKey: "fx-us", category: "FOREX", tierKey: "mid", scope: { kind: "COUNTRY", value: "US" }, currency: "USD", notes: "", params: { eligible: true, perTripMax: 2, perDayMax: 2, allowedCurrencies: ["USD"], appliesTo: "INTERNATIONAL" } },
    ];
    expect(selectRule(withDefault, "FOREX", "mid", { cityKey: null, country: "US" }, [])!.rule.ruleKey).toBe("fx-us");
    expect(selectRule(withDefault, "FOREX", "mid", { cityKey: null, country: "JP" }, [])).toMatchObject({ matchedBy: "DEFAULT" });
  });
});

describe("destination helpers", () => {
  it("classifyDestination: non-IN is always INTERNATIONAL, even with a city row", () => {
    expect(classifyDestination({ cityKey: "bengaluru", country: "US" }, CITIES)).toBe("INTERNATIONAL");
    expect(classifyDestination({ cityKey: "bengaluru", country: null }, CITIES)).toBe("METRO");
  });
  it("regionOfCountry: India is never in a region", () => {
    expect(regionOfCountry("IN")).toBeNull();
    expect(regionOfCountry("ae")).toBe("GCC");
    expect(regionOfCountry("ZZ")).toBeNull();
  });
  it("normalizeKey strips case, accents and punctuation", () => {
    expect(normalizeKey("  Navi-Mumbai ")).toBe("navi mumbai");
    expect(normalizeKey("Zürich")).toBe("zurich");
  });
});

describe("IST dates and version state", () => {
  it("istToday is the Indian calendar day, not UTC", () => {
    // 20:00 UTC on 30 Nov = 01:30 IST on 1 Dec
    expect(istToday(new Date("2026-11-30T20:00:00Z"))).toBe("2026-12-01");
    expect(istToday(new Date("2026-11-30T18:00:00Z"))).toBe("2026-11-30");
  });
  it("isIsoDate rejects impossible dates", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-1-01")).toBe(false);
  });
  it("addDays crosses months and years", () => {
    expect(addDays("2026-12-01", -1)).toBe("2026-11-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("versionState is derived from dates", () => {
    const today = "2026-11-21";
    expect(versionState({ status: "DRAFT" }, today)).toBe("DRAFT");
    expect(versionState({ status: "ARCHIVED", effectiveFrom: "2026-12-01" }, today)).toBe("ARCHIVED");
    expect(versionState({ status: "PUBLISHED", effectiveFrom: "2026-11-22" }, today)).toBe("SCHEDULED");
    expect(versionState({ status: "PUBLISHED", effectiveFrom: "2026-11-21" }, today)).toBe("ACTIVE");
    expect(versionState({ status: "PUBLISHED", effectiveFrom: "2026-01-01", effectiveTo: "2026-11-21" }, today)).toBe("ACTIVE");
    expect(versionState({ status: "PUBLISHED", effectiveFrom: "2026-01-01", effectiveTo: "2026-11-20" }, today)).toBe("SUPERSEDED");
  });
  it("windowsOverlap treats a null end as open", () => {
    expect(windowsOverlap({ effectiveFrom: "2026-01-01", effectiveTo: "2026-11-30" }, { effectiveFrom: "2026-12-01" })).toBe(false);
    expect(windowsOverlap({ effectiveFrom: "2026-01-01", effectiveTo: "2026-12-01" }, { effectiveFrom: "2026-12-01" })).toBe(true);
    expect(windowsOverlap({ effectiveFrom: "2026-01-01" }, { effectiveFrom: "2027-01-01" })).toBe(true);
  });
});

describe("sanitizeDraft", () => {
  it("rejects negative money, bad enums, invalid keys and scopes a category does not allow", () => {
    try {
      sanitizeDraft({
        tiers: [{ tierKey: "Bad Key!", name: "" }],
        rules: [
          { ruleKey: "r1", category: "HOTEL", tierKey: "x", scope: { kind: "CITY_CLASS", value: "METRO" }, params: { maxPerNight: -5 } },
          { ruleKey: "r2", category: "FLIGHT", tierKey: "x", scope: { kind: "CITY", value: "pune" }, params: { allowedCabins: ["LUXURY"] } },
          { ruleKey: "r3", category: "CAB", tierKey: "x" },
        ],
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyInputError);
      const msg = (e as PolicyInputError).errors.join(" | ");
      expect(msg).toMatch(/internal key is missing or invalid/);
      expect(msg).toMatch(/needs a name/);
      expect(msg).toMatch(/x · Hotels · Metro · Max per night: enter 0 or more/);
      expect(msg).toMatch(/Flights rules cannot be set by city/);
      expect(msg).toMatch(/unknown cabin/);
      expect(msg).toMatch(/"CAB" is not a category/);
    }
  });
  it("keeps only known fields (no mass assignment) and defaults currency to INR (D10)", () => {
    const d = sanitizeDraft({
      status: "PUBLISHED",
      versionNumber: 99,
      workspaceId: "x",
      tiers: [{ tierKey: "mid", name: "Mid", designationIds: [D1, D1], bandNumbers: [6, "5"], evil: 1 }],
      rules: [{ ruleKey: "r", category: "esim", tierKey: "MID", params: { eligible: false, maxCost: "1500", hack: true } }],
    });
    expect(Object.keys(d).sort()).toEqual(["changeSummary", "effectiveFrom", "name", "rules", "tiers"]);
    expect(d.tiers[0]).not.toHaveProperty("evil");
    expect(d.tiers[0].designationIds).toEqual([D1]);
    expect(d.tiers[0].bandNumbers).toEqual([5, 6]);
    expect(d.rules[0]).toMatchObject({ category: "ESIM", tierKey: "mid", currency: "INR", params: { eligible: false, maxCost: 1500, limitBasis: "PER_TRIP" } });
    expect(d.rules[0].params).not.toHaveProperty("hack");
  });
  it("accepts another currency per rule without converting (D10)", () => {
    const d = sanitizeDraft({ tiers: [], rules: [{ ruleKey: "r", category: "FOREX", tierKey: "a", currency: "usd", params: { perDayMax: 300 } }] });
    expect(d.rules[0].currency).toBe("USD");
    expect((d.rules[0].params as any).perDayMax).toBe(300);
  });
});

describe("validateForPublish", () => {
  const known = new Set([D1, D2]);
  it("the shipped template passes once (it maps nothing, so nothing clashes)", () => {
    expect(validateForPublish({ tiers: TEMPLATE_TIERS, rules: TEMPLATE_RULES }, known)).toEqual([]);
    expect(policyGaps({ tiers: TEMPLATE_TIERS, rules: TEMPLATE_RULES })).toEqual([]);
    expect(valueWarnings({ tiers: TEMPLATE_TIERS, rules: TEMPLATE_RULES })).toEqual([]);
  });
  it("refuses: no active tier, dangling tierKey, duplicate scope, shared designation/band, foreign designation", () => {
    expect(validateForPublish({ tiers: [tier("a", { active: false })], rules: [] }, known)).toContain("At least one active tier is required");
    const p = validateForPublish(
      {
        tiers: [tier("a", { designationIds: [D1], bandNumbers: [3] }), tier("b", { designationIds: [D1, D3], bandNumbers: [3] })],
        rules: [hotel("1", "a", "CITY_CLASS", "METRO", 1), hotel("2", "a", "CITY_CLASS", "METRO", 2), hotel("3", "zz", "CITY_CLASS", "METRO", 1)],
      },
      known,
    ).join(" | ");
    expect(p).toMatch(/tier that does not exist \(zz\)/);
    expect(p).toMatch(/A has two Hotels rules for the same place \(Metro\)/);
    expect(p).toMatch(/designation is mapped to both/);
    expect(p).toMatch(/Band L3 is mapped to both/);
    expect(p).toMatch(/not in this workspace/);
  });
  it("an inactive tier may keep a designation another tier now owns", () => {
    const rules = [hotel("1", "a", "CITY_CLASS", "METRO", 1)];
    expect(validateForPublish({ tiers: [tier("a", { designationIds: [D1] }), tier("b", { active: false, designationIds: [D1] })], rules }, known)).toEqual([]);
  });
  it("M2: a clash is found by tierKey, so two tiers with the same name cannot hide it", () => {
    const p = validateForPublish({ tiers: [tier("x1", { name: "A", bandNumbers: [3] }), tier("x2", { name: "A", bandNumbers: [3] })], rules: [hotel("1", "x1", "CITY_CLASS", "METRO", 1)] }, known).join(" | ");
    expect(p).toMatch(/Band L3 is mapped to both "A" and "A"/);
    expect(p).toMatch(/Two tiers are called "A"/);
  });
  it("M5: a version with no rules (or rules only on inactive tiers) is refused", () => {
    const msg = /This version has no rules/;
    expect(validateForPublish({ tiers: [tier("a")], rules: [] }, known).join()).toMatch(msg);
    expect(validateForPublish({ tiers: [tier("a"), tier("b", { active: false })], rules: [hotel("1", "b", "CITY_CLASS", "METRO", 1)] }, known).join()).toMatch(msg);
  });
  it("gaps: no rule, a missing hotel city class, and overrides without a default all count", () => {
    const fx: Rule = { ruleKey: "fx", category: "FOREX", tierKey: "a", scope: { kind: "COUNTRY", value: "US" }, currency: "USD", notes: "", params: { eligible: true, perTripMax: 2, perDayMax: 2, allowedCurrencies: [], appliesTo: "INTERNATIONAL" } };
    const gaps = policyGaps({ tiers: [tier("a"), tier("b"), tier("off", { active: false })], rules: [hotel("1", "a", "CITY_CLASS", "METRO", 1), fx] });
    const of = (c: string) => gaps.filter((g) => g.category === c).map((g) => `${g.tierName}: ${g.missing}`);
    expect(of("HOTEL")).toEqual(["A: no rule for Tier-2, Other cities, International", "B: no rule"]);
    expect(of("FOREX")).toEqual(["A: no default rule (only overrides)", "B: no rule"]);
    expect(of("FLIGHT")).toEqual(["A: no rule", "B: no rule"]);
    expect(gapLines(gaps).map((g) => g.text)).toEqual([
      "Flights has no rule for A, B",
      "Hotels: A (no rule for Tier-2, Other cities, International), B (no rule)",
      "Forex: A (no default rule (only overrides)), B (no rule)",
      "Visa has no rule for A, B",
      "eSIM has no rule for A, B",
    ]);
  });
});

describe("diffContent (audit before/after)", () => {
  it("reports added, changed and removed tiers and rules, plus version fields", () => {
    const before = { name: "v", effectiveFrom: null, tiers: [tier("a"), tier("b")], rules: [hotel("1", "a", "CITY_CLASS", "METRO", 5000)] };
    const after = { name: "v2", effectiveFrom: "2026-12-01", tiers: [tier("a", { name: "A+" }), tier("c")], rules: [hotel("1", "a", "CITY_CLASS", "METRO", 6000)] };
    const ch = diffContent(before, after);
    expect(ch.find((c) => c.field === "name")).toMatchObject({ from: "v", to: "v2" });
    expect(ch.find((c) => c.field === "effectiveFrom")).toMatchObject({ from: null, to: "2026-12-01" });
    expect(ch.filter((c) => c.category === "TIER")).toHaveLength(3); // a changed, c added, b removed
    const h = ch.find((c) => c.category === "HOTEL")!;
    expect((h.from as any).params.maxPerNight).toBe(5000);
    expect((h.to as any).params.maxPerNight).toBe(6000);
  });
});

describe("template city list (D7)", () => {
  it("has the agreed Metro set and no duplicates", () => {
    const metro = TEMPLATE_CITIES.filter((c) => c.category === "METRO").map((c) => c.name).sort();
    expect(metro).toEqual(
      ["Ahmedabad", "Bengaluru", "Chennai", "Delhi", "Faridabad", "Ghaziabad", "Gurugram", "Hyderabad", "Kolkata", "Mumbai", "Navi Mumbai", "Noida", "Pune", "Thane"].sort(),
    );
    const keys = TEMPLATE_CITIES.map((c) => normalizeKey(c.name));
    expect(new Set(keys).size).toBe(keys.length);
    expect(TEMPLATE_CITIES.every((c) => c.country === "IN")).toBe(true);
  });
  it("every template amount is INR (D10)", () => {
    expect(TEMPLATE_RULES.every((r) => r.currency === "INR")).toBe(true);
  });
});

/* ── QA fix round, 2026-11-25 ────────────────────────────────────────── */

const errorsOf = (input: any, lists?: any): string[] => {
  try {
    sanitizeDraft(input, lists);
    return [];
  } catch (e) {
    return (e as PolicyInputError).errors;
  }
};
const oneRule = (over: any) => ({ tiers: [{ tierKey: "snr", name: "Senior" }], rules: [{ ruleKey: "r", tierKey: "snr", ...over }] });

describe("value limits (decision 3)", () => {
  const flight = (params: any, currency = "INR") => oneRule({ category: "FLIGHT", currency, params });
  it("hard: no negatives, at most 1 crore, numbers only — in words that name the tier, category and field (M9)", () => {
    expect(errorsOf(flight({ maxFareDomestic: -500 }))).toEqual(["Senior · Flights · Max fare (domestic): enter 0 or more, or leave it empty for no cap"]);
    expect(errorsOf(flight({ maxFareInternational: MAX_AMOUNT + 1 }))).toEqual(["Senior · Flights · Max fare (international): the most a limit can be is 1,00,00,000 (1 crore)"]);
    expect(errorsOf(flight({ maxFareDomestic: 999999999999999999 })).length).toBe(1);
    expect(errorsOf(flight({ maxFareDomestic: "abc" }))[0]).toMatch(/enter a number/);
    expect(errorsOf(flight({ maxFareDomestic: true }))[0]).toMatch(/enter a number/);
    expect(errorsOf(flight({ maxFareDomestic: [5] }))[0]).toMatch(/enter a number/);
    expect(errorsOf(flight({ minAdvanceDaysDomestic: 3.5 }))[0]).toMatch(/Senior · Flights · Min advance \(domestic\): enter whole days/);
    expect(errorsOf(flight({ maxFareDomestic: MAX_AMOUNT, maxFareInternational: 0 }))).toEqual([]); // the limit itself and ₹0 are allowed
    expect(errorsOf(oneRule({ category: "HOTEL", scope: { kind: "CITY_CLASS", value: "METRO" }, params: { maxStarRating: 8 } }))[0]).toBe("Senior · Hotels · Metro · Star category: choose 1 to 7, or Any");
  });
  it("lists: currency from ISO 4217, country from ISO 3166, hotel city from the workspace's list", () => {
    expect(errorsOf(flight({}, "XYZ"))[0]).toBe('Senior · Flights · Currency: "XYZ" is not a currency code');
    expect(errorsOf(flight({}, "US"))[0]).toMatch(/"US" is not a currency code/);
    expect(errorsOf(flight({}, "USDD"))[0]).toMatch(/is not a currency code/);
    expect(errorsOf(flight({}, "eur"))).toEqual([]);
    const fx = (value: string, extra: any = {}) => oneRule({ category: "FOREX", scope: { kind: "COUNTRY", value }, params: extra });
    expect(errorsOf(fx("ZZ"))[0]).toBe('Senior · Forex: "ZZ" is not a country code');
    expect(errorsOf(fx("JP"))).toEqual([]);
    expect(errorsOf(fx("JP", { allowedCurrencies: ["USD", "QQQ"] }))[0]).toMatch(/Forex · Country: Japan · Permitted currencies: QQQ is not a currency code/);
    const city = oneRule({ category: "HOTEL", scope: { kind: "CITY", value: "Atlantis" }, params: {} });
    expect(errorsOf(city, { cityKeys: new Set(["mumbai"]) })[0]).toMatch(/Senior · Hotels: "Atlantis" is not in this workspace's city list/);
    expect(errorsOf(oneRule({ category: "HOTEL", scope: { kind: "CITY", value: "MUMBAI " }, params: {} }), { cityKeys: new Set(["mumbai"]) })).toEqual([]);
  });
  it("soft: ₹0, flight > 5 L, hotel > 1 L a night, forex > 25 L a trip — and nothing at the limit itself", () => {
    const rule = (category: any, params: any, over: any = {}): Rule => ({ ruleKey: "r", category, tierKey: "a", scope: { kind: "DEFAULT", value: null }, currency: "INR", notes: "", params, ...over });
    const warn = (r: Rule) => valueWarnings({ tiers: [tier("a")], rules: [r] }).map((w) => w.text);
    expect(warn(rule("FLIGHT", { maxFareDomestic: 500000, maxFareInternational: 500001 }))).toEqual(["A · Flights · Max fare (international) is ₹5,00,001, above the usual ₹5,00,000"]);
    expect(warn(rule("HOTEL", { maxPerNight: 100001 }, { scope: { kind: "CITY_CLASS", value: "METRO" } }))).toHaveLength(1);
    expect(warn(rule("FOREX", { perTripMax: 2500001, perDayMax: 9000000 }))).toHaveLength(1); // per day has no soft limit
    expect(warn(rule("ESIM", { maxCost: 0 }))[0]).toMatch(/Max cost is ₹0: nothing would be allowed/);
    expect(warn(rule("VISA", { applicationFeeMax: null, serviceFeeMax: 5 }))).toEqual([]);
    expect(warn(rule("FOREX", { eligible: false, perTripMax: 0, perDayMax: 0 }))).toEqual([]);
    expect(warn(rule("FLIGHT", { maxFareDomestic: 600000 }, { currency: "USD" }))).toHaveLength(1);
    expect(warn(rule("FLIGHT", { maxFareDomestic: 600000 }, { currency: "JPY" }))).toEqual([]);
    expect(valueWarnings({ tiers: [tier("a", { active: false })], rules: [rule("ESIM", { maxCost: 0 })] })).toEqual([]);
  });
});

describe("tiers", () => {
  it("L4/M2: duplicate names and codes are refused on save, without case or spaces", () => {
    expect(errorsOf({ tiers: [{ tierKey: "a", name: "Mid", code: "m" }, { tierKey: "b", name: " mid ", code: "M" }] })).toEqual([
      'Two tiers are called "mid". Give each its own name',
      'Two tiers have the code "M". Give each its own code',
    ]);
    expect(duplicateTierProblems([{ name: "A", code: "" }, { name: "B", code: "" }])).toEqual([]);
  });
});

describe("M17: overrides follow the city, not its name", () => {
  const rules = [hotel("mum", "mid", "CITY", "mumbai", 9000), hotel("m", "mid", "CITY_CLASS", "METRO", 7000)];
  const row = (over: Partial<CityForClass>): CityForClass => ({ cityKey: "mumbai", nameKey: "mumbai", country: "IN", category: "METRO", isActive: true, ...over });
  const pick = (cityKey: string, cities: CityForClass[], country = "IN") => selectRule(rules, "HOTEL", "mid", { cityKey, country }, cities)?.rule.ruleKey ?? null;
  it("a renamed city keeps its override; the old name no longer finds it", () => {
    const renamed = [row({ nameKey: "bombay" })];
    expect(pick("bombay", renamed)).toBe("mum");
    expect(pick("mumbai", renamed)).toBeNull(); // not in the list: OTHER, which has no rule here
  });
  it("a different city that later takes the old name does not inherit the override", () => {
    expect(pick("mumbai", [row({ nameKey: "bombay" }), row({ cityKey: "mumbai 2" })])).toBe("m");
  });
  it("rows from before cityKey match by name; country must match; inactive still identifies the city", () => {
    expect(pick("mumbai", [row({ cityKey: undefined })])).toBe("mum");
    expect(destinationCityKey({ cityKey: "mumbai", country: "US" }, [row({})])).toBeNull();
    expect(pick("mumbai", [row({ isActive: false })])).toBe("mum");
  });
});

describe("diff wording and sameness", () => {
  it("names tiers and places, not keys", () => {
    const ch = diffContent({ tiers: [tier("a", { name: "Senior" })], rules: [] }, { tiers: [tier("a", { name: "Senior" })], rules: [hotel("1", "a", "CITY", "navi mumbai", 1), hotel("2", "a", "REGION", "EUROPE", 1)] }, new Map([["navi mumbai", "Navi Mumbai"]]));
    expect(ch.map((c) => c.field)).toEqual(["Senior · City: Navi Mumbai", "Senior · Region: Europe"]);
  });
  it("key order is not a change; samePolicy ignores rule ids but sees values", () => {
    const a = { tiers: [tier("a")], rules: [hotel("1", "a", "CITY_CLASS", "METRO", 5)] };
    const shuffled = { tiers: [tier("a")], rules: [{ notes: "", params: a.rules[0].params, currency: "INR", scope: { value: "METRO", kind: "CITY_CLASS" as const }, tierKey: "a", category: "HOTEL" as const, ruleKey: "1" }] };
    expect(diffContent(a, shuffled)).toEqual([]);
    expect(samePolicy(a, { ...a, rules: [{ ...a.rules[0], ruleKey: "other" }] })).toBe(true);
    expect(samePolicy(a, { ...a, rules: [hotel("1", "a", "CITY_CLASS", "METRO", 6)] })).toBe(false);
    expect(samePolicy(a, { ...a, tiers: [tier("a", { sortOrder: 4 })] })).toBe(false);
  });
});
