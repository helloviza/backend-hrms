// apps/backend/src/services/travelPolicy/core.ts
//
// Travel Policy — PURE logic. No Mongo, no I/O. Everything here is unit-tested
// in travelPolicy/core.test.ts. The DB layer (travelPolicy.service.ts) and the
// routes only ever go through these functions for: payload sanitising,
// publish validation, version state, tier resolution and rule precedence.
//
// Design: docs/audits/travel-policy-audit.md §6 (decisions D1–D12).
//
// Dates are IST calendar days as "YYYY-MM-DD" strings — never Date objects —
// so a version effective "2026-12-01" means 1 Dec in India regardless of the
// server's clock zone, and string comparison is date comparison.

import { countryName, isIsoCountry, isIsoCurrency } from "../../data/isoCodes.js";

export const CATEGORIES = ["FLIGHT", "HOTEL", "FOREX", "VISA", "ESIM"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CITY_CLASSES = ["METRO", "TIER2", "OTHER", "INTERNATIONAL"] as const;
export type CityClass = (typeof CITY_CLASSES)[number];

/** Rule scopes, MOST specific first — this order IS the precedence. */
export const SCOPE_PRECEDENCE = ["CITY", "COUNTRY", "REGION", "CITY_CLASS", "DEFAULT"] as const;
export type ScopeKind = (typeof SCOPE_PRECEDENCE)[number];

/** Which scopes each category accepts (D11: flights are domestic/intl inside one DEFAULT rule). */
export const ALLOWED_SCOPES: Record<Category, ScopeKind[]> = {
  FLIGHT: ["DEFAULT"],
  HOTEL: ["CITY_CLASS", "REGION", "COUNTRY", "CITY"],
  FOREX: ["DEFAULT", "REGION", "COUNTRY"],
  VISA: ["DEFAULT", "REGION", "COUNTRY"],
  ESIM: ["DEFAULT", "REGION", "COUNTRY"],
};

export const CABINS = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] as const;
export type Cabin = (typeof CABINS)[number];

/** Region → ISO-2 countries. India is never in a region: it is the domestic case. */
export const REGIONS: Record<string, { label: string; countries: string[] }> = {
  SAARC: { label: "SAARC neighbours", countries: ["NP", "BT", "BD", "LK", "MV", "PK", "AF"] },
  GCC: { label: "Gulf (GCC)", countries: ["AE", "SA", "QA", "OM", "KW", "BH"] },
  MIDDLE_EAST: { label: "Middle East (non-GCC)", countries: ["IL", "JO", "LB", "IQ", "IR", "SY", "YE", "EG"] },
  SOUTHEAST_ASIA: { label: "Southeast Asia", countries: ["SG", "MY", "TH", "ID", "VN", "PH", "KH", "LA", "MM", "BN", "TL"] },
  EAST_ASIA: { label: "East Asia", countries: ["CN", "HK", "MO", "TW", "JP", "KR", "MN"] },
  EUROPE: {
    label: "Europe",
    countries: [
      "GB", "IE", "FR", "DE", "IT", "ES", "PT", "NL", "BE", "LU", "CH", "AT", "DK", "SE", "NO", "FI", "IS",
      "PL", "CZ", "SK", "HU", "SI", "HR", "RS", "BA", "ME", "MK", "AL", "GR", "RO", "BG", "EE", "LV", "LT",
      "MT", "CY", "TR", "UA", "MD", "BY", "RU", "MC", "LI", "AD", "SM", "VA",
    ],
  },
  NORTH_AMERICA: { label: "North America", countries: ["US", "CA", "MX"] },
  LATIN_AMERICA: { label: "Latin America & Caribbean", countries: ["BR", "AR", "CL", "PE", "CO", "EC", "UY", "PY", "BO", "VE", "CR", "PA", "CU", "DO", "JM", "TT", "BS", "BB"] },
  AFRICA: { label: "Africa", countries: ["ZA", "KE", "NG", "GH", "TZ", "UG", "RW", "ET", "MA", "TN", "DZ", "MU", "SC", "MG", "ZM", "ZW", "BW", "NA", "MZ", "SN", "CI"] },
  OCEANIA: { label: "Oceania", countries: ["AU", "NZ", "FJ", "PG"] },
  CENTRAL_ASIA: { label: "Central Asia & Caucasus", countries: ["KZ", "UZ", "KG", "TJ", "TM", "AZ", "GE", "AM"] },
};

export function regionOfCountry(country: string | null | undefined): string | null {
  const c = String(country || "").toUpperCase();
  if (!c || c === "IN") return null;
  for (const [key, r] of Object.entries(REGIONS)) if (r.countries.includes(c)) return key;
  return null;
}

/* ── Shapes ───────────────────────────────────────────────────────────── */

export interface Tier {
  tierKey: string; // stable across versions — mapping overrides point at it
  name: string;
  code: string;
  description: string;
  sortOrder: number;
  active: boolean;
  designationIds: string[];
  bandNumbers: number[];
}

export interface FlightParams {
  allowedCabins: Cabin[]; // empty = any cabin
  maxFareDomestic: number | null; // null = no cap
  maxFareInternational: number | null;
  minAdvanceDaysDomestic: number | null;
  minAdvanceDaysInternational: number | null;
  fareLimitBasis: "ONE_WAY" | "RETURN";
}
export interface HotelParams {
  maxPerNight: number | null;
  taxesIncluded: boolean;
  maxStarRating: number | null;
}
export interface ForexParams {
  eligible: boolean;
  perTripMax: number | null;
  perDayMax: number | null;
  allowedCurrencies: string[]; // empty = any
  appliesTo: "INTERNATIONAL" | "ALL";
}
export interface VisaParams {
  eligible: boolean;
  applicationFeeMax: number | null;
  serviceFeeMax: number | null;
  requirement: "MANDATORY" | "OPTIONAL";
  reimbursable: boolean;
}
export interface EsimParams {
  eligible: boolean;
  maxCost: number | null;
  limitBasis: "PER_TRIP" | "PER_DAY";
}
export type RuleParams = FlightParams | HotelParams | ForexParams | VisaParams | EsimParams;

export interface Rule {
  ruleKey: string;
  category: Category;
  tierKey: string;
  scope: { kind: ScopeKind; value: string | null };
  currency: string; // D10: INR default, optional other currency, no FX conversion
  params: RuleParams;
  notes: string;
}

export interface DraftContent {
  name: string;
  changeSummary: string;
  effectiveFrom: string | null;
  tiers: Tier[];
  rules: Rule[];
}

export type VersionState = "DRAFT" | "SCHEDULED" | "ACTIVE" | "SUPERSEDED" | "ARCHIVED";

/* ── Words people see (messages, audit items) ─────────────────────────── */

export const CATEGORY_LABEL: Record<Category, string> = { FLIGHT: "Flights", HOTEL: "Hotels", FOREX: "Forex", VISA: "Visa", ESIM: "eSIM" };
export const CITY_CLASS_LABEL: Record<CityClass, string> = { METRO: "Metro", TIER2: "Tier-2", OTHER: "Other cities", INTERNATIONAL: "International" };

/** "Metro", "Region: Europe", "Country: Japan", "City: Mumbai", "" for the default rule. */
export function scopeLabel(scope: Rule["scope"], cityNames?: Map<string, string> | null): string {
  const v = scope.value ?? "";
  switch (scope.kind) {
    case "DEFAULT":
      return "";
    case "CITY_CLASS":
      return CITY_CLASS_LABEL[v as CityClass] ?? v;
    case "REGION":
      return `Region: ${REGIONS[v]?.label ?? v}`;
    case "COUNTRY":
      return `Country: ${countryName(v)}`;
    case "CITY":
      return `City: ${cityNames?.get(v) ?? v.replace(/\b\w/g, (m) => m.toUpperCase())}`;
  }
}

/* ── Value limits (decision 3, 2026-11-25) ────────────────────────────── */

/** Hard: no amount above ₹1 crore (the same number in another currency: there is no FX step, D10). */
export const MAX_AMOUNT = 10_000_000;

/** Soft: allowed, but someone must confirm it. Amounts above these, and every ₹0. */
export const SOFT_LIMITS = { flightFare: 500_000, hotelNight: 100_000, forexTrip: 2_500_000 } as const;

/**
 * Currencies worth less than, or not much more than, a rupee. The soft limits
 * are rupee figures, so they are compared only in INR and in currencies worth
 * clearly more: a JPY 6,00,000 fare is not unusual, a USD 6,00,000 one is.
 */
export const NOT_COMPARED = new Set(
  (
    "AFN ALL AMD AOA ARS BDT BIF CDF CLP COP CRC CUP CVE CZK DJF DOP DZD EGP ETB GMD GNF GYD HTG HUF IDR IQD IRR ISK JMD JPY KES KGS KHR KMF KPW KRW KZT " +
    "LAK LBP LKR LRD MGA MKD MMK MNT MUR MWK MZN NGN NIO NPR PHP PKR PYG RSD RUB RWF SDG SLE SOS SRD SSP SYP TWD TZS UAH UGX UYU UZS VES VND VUV XAF XOF XPF YER"
  ).split(" "),
);

export interface ValueWarning {
  ruleKey: string;
  field: string;
  text: string;
}

const fmtAmount = (n: number, ccy: string) => (ccy === "INR" ? `₹${n.toLocaleString("en-IN")}` : `${ccy} ${n.toLocaleString("en-IN")}`);

/** Amount fields per category, with the words the screen uses for them. */
export const AMOUNT_FIELDS: Record<Category, { field: string; label: string; soft?: number }[]> = {
  FLIGHT: [
    { field: "maxFareDomestic", label: "Max fare (domestic)", soft: SOFT_LIMITS.flightFare },
    { field: "maxFareInternational", label: "Max fare (international)", soft: SOFT_LIMITS.flightFare },
  ],
  HOTEL: [{ field: "maxPerNight", label: "Max per night", soft: SOFT_LIMITS.hotelNight }],
  FOREX: [
    { field: "perTripMax", label: "Max per trip", soft: SOFT_LIMITS.forexTrip },
    { field: "perDayMax", label: "Max per day" },
  ],
  VISA: [
    { field: "applicationFeeMax", label: "Application fee up to" },
    { field: "serviceFeeMax", label: "Service fee up to" },
  ],
  ESIM: [{ field: "maxCost", label: "Max cost" }],
};

/** "Senior · Hotels · City: Mumbai": how every message and audit item names a rule. */
export function ruleLabel(r: Pick<Rule, "category" | "tierKey" | "scope">, tierNames: Map<string, string>, cityNames?: Map<string, string> | null): string {
  return [tierNames.get(r.tierKey) ?? r.tierKey, CATEGORY_LABEL[r.category], scopeLabel(r.scope, cityNames)].filter(Boolean).join(" · ");
}

/** Values that are allowed but unusual enough that someone has to confirm them. Active tiers only. */
export function valueWarnings(content: Pick<DraftContent, "tiers" | "rules">, cityNames?: Map<string, string> | null): ValueWarning[] {
  const names = new Map(content.tiers.map((t) => [t.tierKey, t.name]));
  const active = new Set(content.tiers.filter((t) => t.active).map((t) => t.tierKey));
  const out: ValueWarning[] = [];
  for (const r of content.rules) {
    if (!active.has(r.tierKey)) continue;
    const p: any = r.params;
    if (p?.eligible === false) continue; // a limit nobody can use is not worth asking about
    for (const f of AMOUNT_FIELDS[r.category]) {
      const n = p?.[f.field];
      if (typeof n !== "number") continue;
      const where = `${ruleLabel(r, names, cityNames)} · ${f.label}`;
      if (n === 0) out.push({ ruleKey: r.ruleKey, field: f.field, text: `${where} is ${fmtAmount(0, r.currency)}: nothing would be allowed (leave it empty for no cap)` });
      else if (f.soft && n > f.soft && !NOT_COMPARED.has(r.currency)) {
        out.push({ ruleKey: r.ruleKey, field: f.field, text: `${where} is ${fmtAmount(n, r.currency)}, above the usual ${fmtAmount(f.soft, "INR")}` });
      }
    }
  }
  return out;
}

/* ── IST calendar dates ───────────────────────────────────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function istToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Display state of a version on `today` (derived from dates — no cron needed). */
export function versionState(
  v: { status: string; effectiveFrom?: string | null; effectiveTo?: string | null },
  today: string,
): VersionState {
  if (v.status === "DRAFT") return "DRAFT";
  if (v.status === "ARCHIVED") return "ARCHIVED";
  const from = v.effectiveFrom || "";
  if (from > today) return "SCHEDULED";
  if (v.effectiveTo && v.effectiveTo < today) return "SUPERSEDED";
  return "ACTIVE";
}

/** Does a published window [from, to|∞] contain `day`? */
export function windowContains(v: { effectiveFrom?: string | null; effectiveTo?: string | null }, day: string): boolean {
  if (!v.effectiveFrom || v.effectiveFrom > day) return false;
  return !v.effectiveTo || v.effectiveTo >= day;
}

/** Do two windows overlap? (null `to` = open-ended) */
export function windowsOverlap(
  a: { effectiveFrom: string; effectiveTo?: string | null },
  b: { effectiveFrom: string; effectiveTo?: string | null },
): boolean {
  const aTo = a.effectiveTo || "9999-12-31";
  const bTo = b.effectiveTo || "9999-12-31";
  return a.effectiveFrom <= bTo && b.effectiveFrom <= aTo;
}

/* ── Sanitising a draft payload ───────────────────────────────────────── */

export class PolicyInputError extends Error {
  constructor(public errors: string[]) {
    super(errors.join("; "));
  }
}

const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const bool = (v: unknown, dflt = false) => (typeof v === "boolean" ? v : dflt);

function money(v: unknown, path: string, errors: string[]): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    errors.push(`${path}: enter a number, or leave it empty for no cap`);
    return null;
  }
  if (n < 0) {
    errors.push(`${path}: enter 0 or more, or leave it empty for no cap`);
    return null;
  }
  if (n > MAX_AMOUNT) {
    errors.push(`${path}: the most a limit can be is 1,00,00,000 (1 crore)`);
    return null;
  }
  return Math.round(n * 100) / 100;
}

function wholeDays(v: unknown, path: string, errors: string[]): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 365) {
    errors.push(`${path}: enter whole days from 0 to 365, or leave it empty`);
    return null;
  }
  return n;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  const s = String(v ?? "").toUpperCase() as T;
  return allowed.includes(s) ? s : dflt;
}

export function normalizeKey(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OID_RE = /^[a-f0-9]{24}$/i;

export function sanitizeParams(category: Category, p: any, path: string, errors: string[]): RuleParams {
  p = p && typeof p === "object" ? p : {};
  switch (category) {
    case "FLIGHT": {
      const cabins = Array.isArray(p.allowedCabins) ? p.allowedCabins.map((c: any) => String(c).toUpperCase()) : [];
      const bad = cabins.filter((c: string) => !CABINS.includes(c as Cabin));
      if (bad.length) errors.push(`${path} · Cabin class: unknown cabin ${bad.join(", ")}`);
      return {
        allowedCabins: CABINS.filter((c) => cabins.includes(c)),
        maxFareDomestic: money(p.maxFareDomestic, `${path} · Max fare (domestic)`, errors),
        maxFareInternational: money(p.maxFareInternational, `${path} · Max fare (international)`, errors),
        minAdvanceDaysDomestic: wholeDays(p.minAdvanceDaysDomestic, `${path} · Min advance (domestic)`, errors),
        minAdvanceDaysInternational: wholeDays(p.minAdvanceDaysInternational, `${path} · Min advance (international)`, errors),
        fareLimitBasis: oneOf(p.fareLimitBasis, ["ONE_WAY", "RETURN"] as const, "ONE_WAY"),
      };
    }
    case "HOTEL": {
      let stars: number | null = null;
      if (p.maxStarRating !== null && p.maxStarRating !== undefined && p.maxStarRating !== "") {
        const n = Number(p.maxStarRating);
        if (!Number.isInteger(n) || n < 1 || n > 7) errors.push(`${path} · Star category: choose 1 to 7, or Any`);
        else stars = n;
      }
      return {
        maxPerNight: money(p.maxPerNight, `${path} · Max per night`, errors),
        taxesIncluded: bool(p.taxesIncluded, true),
        maxStarRating: stars,
      };
    }
    case "FOREX": {
      const ccys = Array.isArray(p.allowedCurrencies)
        ? Array.from(new Set(p.allowedCurrencies.map((c: any) => String(c).trim().toUpperCase()).filter(Boolean)))
        : [];
      const bad = (ccys as string[]).filter((c) => !isIsoCurrency(c));
      if (bad.length) errors.push(`${path} · Permitted currencies: ${bad.join(", ")} is not a currency code`);
      return {
        eligible: bool(p.eligible, true),
        perTripMax: money(p.perTripMax, `${path} · Max per trip`, errors),
        perDayMax: money(p.perDayMax, `${path} · Max per day`, errors),
        allowedCurrencies: (ccys as string[]).filter((c) => isIsoCurrency(c)),
        appliesTo: oneOf(p.appliesTo, ["INTERNATIONAL", "ALL"] as const, "INTERNATIONAL"),
      };
    }
    case "VISA":
      return {
        eligible: bool(p.eligible, true),
        applicationFeeMax: money(p.applicationFeeMax, `${path} · Application fee up to`, errors),
        serviceFeeMax: money(p.serviceFeeMax, `${path} · Service fee up to`, errors),
        requirement: oneOf(p.requirement, ["MANDATORY", "OPTIONAL"] as const, "OPTIONAL"),
        reimbursable: bool(p.reimbursable, true),
      };
    case "ESIM":
      return {
        eligible: bool(p.eligible, true),
        maxCost: money(p.maxCost, `${path} · Max cost`, errors),
        limitBasis: oneOf(p.limitBasis, ["PER_TRIP", "PER_DAY"] as const, "PER_TRIP"),
      };
  }
}

const SCOPE_WORD: Record<ScopeKind, string> = { CITY: "city", COUNTRY: "country", REGION: "region", CITY_CLASS: "city class", DEFAULT: "default" };

/** Closed lists the workspace owns. Absent = not checked (pure tests only; the service always passes them). */
export interface DraftLists {
  /** Stable keys of the workspace's city list (TravelPolicyCity.cityKey). */
  cityKeys?: Set<string>;
  cityNames?: Map<string, string>;
}

function sanitizeScope(category: Category, s: any, path: string, errors: string[], lists: DraftLists): Rule["scope"] {
  const kind = String(s?.kind ?? "DEFAULT").toUpperCase() as ScopeKind;
  if (!SCOPE_PRECEDENCE.includes(kind)) {
    errors.push(`${path}: "${s?.kind}" is not a kind of rule`);
    return { kind: "DEFAULT", value: null };
  }
  if (!ALLOWED_SCOPES[category].includes(kind)) {
    errors.push(`${path}: ${CATEGORY_LABEL[category]} rules cannot be set by ${SCOPE_WORD[kind]}`);
  }
  if (kind === "DEFAULT") return { kind, value: null };
  const raw = str(s?.value, 100);
  if (kind === "CITY_CLASS") {
    const v = raw.toUpperCase();
    if (!CITY_CLASSES.includes(v as CityClass)) errors.push(`${path}: the city class must be one of ${CITY_CLASSES.map((c) => CITY_CLASS_LABEL[c]).join(", ")}`);
    return { kind, value: v };
  }
  if (kind === "REGION") {
    const v = raw.toUpperCase();
    if (!REGIONS[v]) errors.push(`${path}: "${raw}" is not a known region`);
    return { kind, value: v };
  }
  if (kind === "COUNTRY") {
    const v = raw.toUpperCase();
    if (!isIsoCountry(v)) errors.push(`${path}: "${raw}" is not a country code`);
    return { kind, value: v };
  }
  // CITY: the stable key of a row in the workspace's city list, so renaming
  // the city keeps the override. normalizeKey is idempotent on those keys.
  const v = normalizeKey(raw);
  if (!v) errors.push(`${path}: choose a city`);
  else if (lists.cityKeys && !lists.cityKeys.has(v)) errors.push(`${path}: "${raw}" is not in this workspace's city list. Add it on City & Region Rules first, or remove the override`);
  return { kind, value: v };
}

/**
 * Sanitise a draft body. Throws PolicyInputError for malformed input (wrong
 * types, unknown enums, negative money). Completeness (every tier has rules,
 * an effective date …) is NOT checked here — a draft may be half-done; that
 * is validateForPublish's job.
 */
export function sanitizeDraft(input: any, lists: DraftLists = {}): DraftContent {
  const errors: string[] = [];
  const body = input && typeof input === "object" ? input : {};

  let effectiveFrom: string | null = null;
  if (body.effectiveFrom !== null && body.effectiveFrom !== undefined && body.effectiveFrom !== "") {
    if (!isIsoDate(body.effectiveFrom)) errors.push("Effective from: choose a date");
    else effectiveFrom = body.effectiveFrom;
  }

  const rawTiers: any[] = Array.isArray(body.tiers) ? body.tiers : [];
  if (rawTiers.length > 30) errors.push("At most 30 tiers");
  const tiers: Tier[] = rawTiers.slice(0, 30).map((t, i) => {
    const tierKey = str(t?.tierKey, 64).toLowerCase();
    const name = str(t?.name, 80);
    const p = `Tier "${name || `number ${i + 1}`}"`;
    if (!KEY_RE.test(tierKey)) errors.push(`${p}: its internal key is missing or invalid`);
    if (!name) errors.push(`${p} needs a name`);
    const designationIds = Array.isArray(t?.designationIds)
      ? Array.from(new Set(t.designationIds.map((d: any) => String(d))))
      : [];
    const badIds = (designationIds as string[]).filter((d) => !OID_RE.test(d));
    if (badIds.length) errors.push(`${p} has a designation that is not valid`);
    const bandNumbers = Array.isArray(t?.bandNumbers)
      ? Array.from(new Set(t.bandNumbers.map((b: any) => Number(b))))
      : [];
    if ((bandNumbers as number[]).some((b) => !Number.isInteger(b) || b < 1 || b > 10)) {
      errors.push(`${p}: bands run from L1 to L10`);
    }
    return {
      tierKey,
      name,
      code: str(t?.code, 20).toUpperCase(),
      description: str(t?.description, 500),
      sortOrder: Number.isFinite(Number(t?.sortOrder)) ? Number(t.sortOrder) : i,
      active: bool(t?.active, true),
      designationIds: (designationIds as string[]).filter((d) => OID_RE.test(d)),
      bandNumbers: (bandNumbers as number[]).filter((b) => Number.isInteger(b) && b >= 1 && b <= 10).sort((a, b) => a - b),
    };
  });
  const tierKeys = tiers.map((t) => t.tierKey);
  const dupTier = tierKeys.find((k, i) => tierKeys.indexOf(k) !== i);
  if (dupTier) errors.push(`Two tiers have the same internal key "${dupTier}"`);
  errors.push(...duplicateTierProblems(tiers));
  const tierNames = new Map(tiers.map((t) => [t.tierKey, t.name]));

  const rawRules: any[] = Array.isArray(body.rules) ? body.rules : [];
  if (rawRules.length > 2000) errors.push("At most 2000 rules");
  const rules: Rule[] = rawRules.slice(0, 2000).map((r, i) => {
    const category = String(r?.category ?? "").toUpperCase() as Category;
    if (!CATEGORIES.includes(category)) {
      errors.push(`Rule number ${i + 1}: "${r?.category}" is not a category`);
    }
    const cat: Category = CATEGORIES.includes(category) ? category : "FLIGHT";
    const ruleKey = str(r?.ruleKey, 64).toLowerCase();
    const tierKey = str(r?.tierKey, 64).toLowerCase();
    const at = [tierNames.get(tierKey) ?? (tierKey || `rule number ${i + 1}`), CATEGORY_LABEL[cat]].join(" · ");
    const scope = sanitizeScope(cat, r?.scope, at, errors, lists);
    const p = ruleLabel({ category: cat, tierKey, scope }, tierNames, lists.cityNames);
    if (!KEY_RE.test(ruleKey)) errors.push(`${p}: the rule's internal key is missing or invalid`);
    const currency = str(r?.currency || "INR", 10).toUpperCase();
    if (!isIsoCurrency(currency)) errors.push(`${p} · Currency: "${currency}" is not a currency code`);
    return { ruleKey, category: cat, tierKey, scope, currency, params: sanitizeParams(cat, r?.params, p, errors), notes: str(r?.notes, 500) };
  });
  const ruleKeys = rules.map((r) => r.ruleKey);
  const dupRule = ruleKeys.find((k, i) => ruleKeys.indexOf(k) !== i);
  if (dupRule) errors.push(`Two rules have the same internal key "${dupRule}"`);

  if (errors.length) throw new PolicyInputError(errors);
  return {
    name: str(body.name, 120),
    changeSummary: str(body.changeSummary, 2000),
    effectiveFrom,
    tiers,
    rules,
  };
}

/* ── Publish validation ───────────────────────────────────────────────── */

export function scopeId(r: Pick<Rule, "category" | "tierKey" | "scope">): string {
  return `${r.category}|${r.tierKey}|${r.scope.kind}|${r.scope.value ?? ""}`;
}

/** Two tiers may not share a name or a code (compared without case or outer spaces). */
export function duplicateTierProblems(tiers: Pick<Tier, "name" | "code">[]): string[] {
  const out: string[] = [];
  const seenName = new Set<string>();
  const seenCode = new Set<string>();
  for (const t of tiers) {
    const n = t.name.trim().toLowerCase();
    const c = t.code.trim().toUpperCase();
    if (n && seenName.has(n)) out.push(`Two tiers are called "${t.name}". Give each its own name`);
    if (c && seenCode.has(c)) out.push(`Two tiers have the code "${c}". Give each its own code`);
    seenName.add(n);
    seenCode.add(c);
  }
  return Array.from(new Set(out));
}

/**
 * Everything a version must satisfy before it can be published. Returns a
 * list of human-readable problems (empty = publishable). `knownDesignationIds`
 * are the workspace's designations, so a tier cannot map one that was deleted
 * or belongs to another workspace.
 */
export function validateForPublish(
  content: Pick<DraftContent, "tiers" | "rules">,
  knownDesignationIds: Set<string>,
): string[] {
  const problems: string[] = [];
  const active = content.tiers.filter((t) => t.active);
  if (!active.length) problems.push("At least one active tier is required");
  const activeKeys = new Set(active.map((t) => t.tierKey));
  if (active.length && !content.rules.some((r) => activeKeys.has(r.tierKey))) problems.push("This version has no rules. Add at least one rule before publishing");
  problems.push(...duplicateTierProblems(content.tiers));
  const tierNames = new Map(content.tiers.map((t) => [t.tierKey, t.name]));

  const keys = new Set(content.tiers.map((t) => t.tierKey));
  for (const r of content.rules) {
    if (!keys.has(r.tierKey)) problems.push(`A ${CATEGORY_LABEL[r.category]} rule points at a tier that does not exist (${r.tierKey})`);
  }

  const seen = new Map<string, number>();
  for (const r of content.rules) seen.set(scopeId(r), (seen.get(scopeId(r)) ?? 0) + 1);
  for (const [id, n] of seen) {
    if (n > 1) {
      const [cat, tier, kind, value] = id.split("|");
      const where = scopeLabel({ kind: kind as ScopeKind, value: value || null }) || "Default";
      problems.push(`${tierNames.get(tier) ?? tier} has two ${CATEGORY_LABEL[cat as Category]} rules for the same place (${where})`);
    }
  }

  // One designation / band may belong to ONE active tier only.
  // Owners are compared by tierKey: names are not identity.
  const desigOwner = new Map<string, string>();
  const bandOwner = new Map<number, string>();
  for (const t of active) {
    for (const d of t.designationIds) {
      if (!knownDesignationIds.has(d)) problems.push(`Tier "${t.name}" maps a designation that is not in this workspace`);
      const prev = desigOwner.get(d);
      if (prev && prev !== t.tierKey) problems.push(`A designation is mapped to both "${tierNames.get(prev)}" and "${t.name}"`);
      desigOwner.set(d, t.tierKey);
    }
    for (const b of t.bandNumbers) {
      const prev = bandOwner.get(b);
      if (prev && prev !== t.tierKey) problems.push(`Band L${b} is mapped to both "${tierNames.get(prev)}" and "${t.name}"`);
      bandOwner.set(b, t.tierKey);
    }
  }
  return Array.from(new Set(problems));
}

export interface Gap {
  category: Category;
  tierKey: string;
  tierName: string;
  /** "no rule", "no rule for Tier-2, Other cities", "no default rule (only overrides)" */
  missing: string;
}

/**
 * What each active tier is missing, per category: shown on Policy Health and
 * acknowledged at publish. Hotels need all four city classes (a tier with
 * only a Metro rule has no hotel policy anywhere else); Forex, Visa and eSIM
 * need a default rule, because overrides alone leave the rest of the world out.
 */
export function policyGaps(content: Pick<DraftContent, "tiers" | "rules">): Gap[] {
  const out: Gap[] = [];
  const active = content.tiers.filter((t) => t.active).sort((a, b) => a.sortOrder - b.sortOrder);
  for (const category of CATEGORIES) {
    for (const t of active) {
      const mine = content.rules.filter((r) => r.category === category && r.tierKey === t.tierKey);
      let missing = "";
      if (!mine.length) missing = "no rule";
      else if (category === "HOTEL") {
        const without = CITY_CLASSES.filter((c) => !mine.some((r) => r.scope.kind === "CITY_CLASS" && r.scope.value === c));
        if (without.length) missing = `no rule for ${without.map((c) => CITY_CLASS_LABEL[c]).join(", ")}`;
      } else if (!mine.some((r) => r.scope.kind === "DEFAULT")) missing = "no default rule (only overrides)";
      if (missing) out.push({ category, tierKey: t.tierKey, tierName: t.name, missing });
    }
  }
  return out;
}

/** One line per category: "Hotels: Junior (no rule for Metro), Senior (no rule)". */
export function gapLines(gaps: Gap[]): { category: Category; text: string; tierKey: string }[] {
  return CATEGORIES.filter((c) => gaps.some((g) => g.category === c)).map((category) => {
    const mine = gaps.filter((g) => g.category === category);
    const text = mine.every((g) => g.missing === "no rule")
      ? `${CATEGORY_LABEL[category]} has no rule for ${mine.map((g) => g.tierName).join(", ")}`
      : `${CATEGORY_LABEL[category]}: ${mine.map((g) => `${g.tierName} (${g.missing})`).join(", ")}`;
    return { category, text, tierKey: mine[0].tierKey };
  });
}

/* ── Tier resolution ──────────────────────────────────────────────────── */

export interface TravellerForTier {
  designationId?: string | null;
  bandNumber?: number | null;
}
export interface AssignmentForTier {
  tierKey?: string | null;
  excluded?: "GUEST" | null;
}
export type TierResolution =
  | { status: "GUEST"; tierKey: null; source: "GUEST"; staleOverride: false }
  | { status: "MAPPED"; tierKey: string; source: "OVERRIDE" | "DESIGNATION" | "BAND"; staleOverride: boolean }
  | { status: "UNMAPPED"; tierKey: null; source: null; staleOverride: boolean };

/**
 * Which tier does a traveller fall in? (D2/D3)
 *   1. Marked Guest on the mapping → excluded from coverage entirely.
 *   2. An explicit override to an ACTIVE tier of this version wins.
 *   3. Their designation is mapped to an active tier.
 *   4. Their band (L1–L10) is mapped to an active tier.
 *   5. Otherwise UNMAPPED.
 * An override naming a tier this version no longer has (or has deactivated)
 * is "stale": it is ignored and flagged, never silently re-pointed.
 * Ties (same designation in two tiers) are refused at publish; in a draft the
 * lowest sortOrder wins so the preview is deterministic.
 */
export function resolveTier(
  traveller: TravellerForTier,
  tiers: Tier[],
  assignment?: AssignmentForTier | null,
): TierResolution {
  if (assignment?.excluded === "GUEST") return { status: "GUEST", tierKey: null, source: "GUEST", staleOverride: false };
  const active = tiers.filter((t) => t.active).sort((a, b) => a.sortOrder - b.sortOrder);
  let staleOverride = false;
  if (assignment?.tierKey) {
    const hit = active.find((t) => t.tierKey === assignment.tierKey);
    if (hit) return { status: "MAPPED", tierKey: hit.tierKey, source: "OVERRIDE", staleOverride: false };
    staleOverride = true;
  }
  const d = traveller.designationId ? String(traveller.designationId) : "";
  if (d) {
    const hit = active.find((t) => t.designationIds.includes(d));
    if (hit) return { status: "MAPPED", tierKey: hit.tierKey, source: "DESIGNATION", staleOverride };
  }
  const b = traveller.bandNumber;
  if (b != null) {
    const hit = active.find((t) => t.bandNumbers.includes(Number(b)));
    if (hit) return { status: "MAPPED", tierKey: hit.tierKey, source: "BAND", staleOverride };
  }
  return { status: "UNMAPPED", tierKey: null, source: null, staleOverride };
}

/* ── Destination classification + rule precedence ─────────────────────── */

export interface CityForClass {
  /** Stable for the row's life; what CITY rules store. Rows from before it existed use their nameKey. */
  cityKey?: string | null;
  nameKey: string;
  country: string;
  category: CityClass;
  isActive: boolean;
}

export interface Destination {
  cityKey: string | null; // normalizeKey(the city's current name)
  country: string | null; // ISO-2
}

/**
 * City class of a destination: any country other than India is
 * INTERNATIONAL; an Indian city takes its active city-master row's class;
 * an Indian city not in the master (or deactivated) is OTHER.
 */
export function classifyDestination(dest: Destination, cities: CityForClass[]): CityClass {
  const country = String(dest.country || "IN").toUpperCase();
  if (country !== "IN") return "INTERNATIONAL";
  const row = dest.cityKey ? cities.find((c) => c.isActive && c.nameKey === dest.cityKey && c.country === "IN") : undefined;
  return row ? row.category : "OTHER";
}

export function cityKeyOf(c: Pick<CityForClass, "cityKey" | "nameKey">): string {
  return c.cityKey || c.nameKey;
}

/**
 * The stable key of the city a destination names, or null when it is not in
 * the list. Inactive rows still identify the city: deactivating one changes
 * its class, not which city an override is about.
 */
export function destinationCityKey(dest: Destination, cities: CityForClass[]): string | null {
  if (!dest.cityKey) return null;
  const country = String(dest.country || "IN").toUpperCase();
  const row = cities.find((c) => c.nameKey === dest.cityKey && c.country === country);
  return row ? cityKeyOf(row) : null;
}

export interface RuleMatch {
  rule: Rule;
  matchedBy: ScopeKind;
}

/**
 * The single place rule precedence lives (spec §9): for one category and one
 * tier, the MOST specific scope that matches the destination wins outright —
 * CITY > COUNTRY > REGION > CITY_CLASS > DEFAULT. Values are never merged
 * across levels, and a tier with no matching rule gets null (never another
 * tier's rule, never the template's).
 */
export function selectRule(
  rules: Rule[],
  category: Category,
  tierKey: string,
  dest: Destination,
  cities: CityForClass[],
): RuleMatch | null {
  const candidates = rules.filter((r) => r.category === category && r.tierKey === tierKey);
  if (!candidates.length) return null;
  const country = String(dest.country || "IN").toUpperCase();
  const region = regionOfCountry(country);
  const cityClass = classifyDestination(dest, cities);
  const listKey = destinationCityKey(dest, cities);
  const matches = (r: Rule): boolean => {
    switch (r.scope.kind) {
      case "CITY":
        return !!listKey && r.scope.value === listKey;
      case "COUNTRY":
        return r.scope.value === country;
      case "REGION":
        return !!region && r.scope.value === region;
      case "CITY_CLASS":
        return r.scope.value === cityClass;
      case "DEFAULT":
        return true;
    }
  };
  for (const kind of SCOPE_PRECEDENCE) {
    const hit = candidates.find((r) => r.scope.kind === kind && matches(r));
    if (hit) return { rule: hit, matchedBy: kind };
  }
  return null;
}

/* ── Diff for the audit log ───────────────────────────────────────────── */

export interface Change {
  category: Category | "TIER" | "VERSION";
  field: string;
  from: unknown;
  to: unknown;
}

// Key order must not matter: Mongo, the sanitiser and the browser each build
// the same rule with its keys in a different order.
const canonical = (v: any): any =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;
const json = (v: unknown) => JSON.stringify(canonical(v ?? null));

/** Same tiers and rules? Ignores the version's name, summary and date, and rule ids. */
export function samePolicy(a: Pick<DraftContent, "tiers" | "rules">, b: Pick<DraftContent, "tiers" | "rules">): boolean {
  const tiers = (c: Pick<DraftContent, "tiers" | "rules">) =>
    c.tiers.map((t) => json({ ...t, designationIds: [...t.designationIds].sort(), bandNumbers: [...t.bandNumbers].sort((m, n) => m - n) })).sort();
  const rules = (c: Pick<DraftContent, "tiers" | "rules">) => c.rules.map(({ ruleKey: _id, ...r }) => json(r)).sort();
  return json(tiers(a)) === json(tiers(b)) && json(rules(a)) === json(rules(b));
}

/** Field-level differences between two draft contents, for the audit log (spec §10: previous/new value). */
export function diffContent(before: Partial<DraftContent>, after: Partial<DraftContent>, cityNames?: Map<string, string> | null): Change[] {
  const changes: Change[] = [];
  for (const f of ["name", "changeSummary", "effectiveFrom"] as const) {
    if (json(before[f]) !== json(after[f])) changes.push({ category: "VERSION", field: f, from: before[f] ?? null, to: after[f] ?? null });
  }
  const bt = new Map((before.tiers ?? []).map((t) => [t.tierKey, t]));
  const at = new Map((after.tiers ?? []).map((t) => [t.tierKey, t]));
  for (const [k, t] of at) {
    const prev = bt.get(k);
    if (!prev) changes.push({ category: "TIER", field: t.name, from: null, to: t });
    else if (json(prev) !== json(t)) changes.push({ category: "TIER", field: t.name, from: prev, to: t });
  }
  for (const [k, t] of bt) if (!at.has(k)) changes.push({ category: "TIER", field: t.name, from: t, to: null });

  const br = new Map((before.rules ?? []).map((r) => [r.ruleKey, r]));
  const ar = new Map((after.rules ?? []).map((r) => [r.ruleKey, r]));
  const tierNames = new Map([...(before.tiers ?? []), ...(after.tiers ?? [])].map((t) => [t.tierKey, t.name]));
  const label = (r: Rule) => [tierNames.get(r.tierKey) ?? r.tierKey, scopeLabel(r.scope, cityNames)].filter(Boolean).join(" · ");
  for (const [k, r] of ar) {
    const prev = br.get(k);
    if (!prev) changes.push({ category: r.category, field: label(r), from: null, to: r });
    else if (json(prev) !== json(r)) changes.push({ category: r.category, field: label(r), from: prev, to: r });
  }
  for (const [k, r] of br) if (!ar.has(k)) changes.push({ category: r.category, field: label(r), from: r, to: null });
  return changes;
}
