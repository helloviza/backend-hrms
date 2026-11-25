// apps/backend/src/services/policyCompliance/evaluate.ts
//
// Policy Compliance (Travel Spend): was each trip requested far enough ahead
// of travel? Pure, no I/O. policyCompliance/service.ts reads the rows and the
// policy versions and calls these.
//
// Rule: travel date minus request date (IST calendar days) must be at least
// the minimum advance days of the policy version IN FORCE ON THE REQUEST DATE,
// for the traveller's tier, domestic or international. Nothing is guessed:
// when the tier or the destination is unknown AND it would change the answer,
// the trip goes to its own bucket instead of being counted either way.
import {
  normalizeKey,
  pickVersionAt,
  regionOfCountry,
  selectRule,
  type CityForClass,
  type FlightParams,
  type HotelParams,
  type Rule,
  type Tier,
  type TierResolution,
} from "../travelPolicy/core.js";
import { COMPLIANCE_REGIONS, UNKNOWN_REGION } from "./regions.js";
import type { ComplianceTrip } from "./trips.js";

const DAY = 86400000;
const IST_MS = 330 * 60000;

/** IST calendar day of an instant, "YYYY-MM-DD", or null. */
export function istDayOf(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  return Number.isFinite(t) ? new Date(t + IST_MS).toISOString().slice(0, 10) : null;
}

export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY);
}

export interface PolicyVersionLite {
  status: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  versionNumber?: number | null;
  tiers: Tier[];
  rules: Rule[];
}

/* ── Domestic or international ─────────────────────────────────────────── */

/** Per workspace: what "domestic" means (CustomerWorkspace.config.policyDomesticBasis). */
export const DOMESTIC_BASES = ["INDIA", "WORK_COUNTRY"] as const;
export type DomesticBasis = (typeof DOMESTIC_BASES)[number];
export const readDomesticBasis = (v: unknown): DomesticBasis => (v === "WORK_COUNTRY" ? "WORK_COUNTRY" : "INDIA");

/** The country that is domestic for this traveller. No (or unrecognised) work location → India. */
export function homeCountry(basis: DomesticBasis, workCountry: string | null): string {
  return basis === "WORK_COUNTRY" ? workCountry ?? "IN" : "IN";
}

/**
 * Is the booking international for someone whose home country is `home`? For
 * India this is the mirror's own flag. Elsewhere a booking is domestic only
 * when every end is known and at home. null = not known.
 */
export function isInternationalFor(
  home: string,
  b: { service: string; mirrorInternational: boolean | null; destinationCountry: string | null; endpoints: (string | null)[] },
): boolean | null {
  if (home === "IN") return b.mirrorInternational;
  if (b.mirrorInternational === false) return true; // wholly within India
  if (b.service === "HOTEL") return b.destinationCountry ? b.destinationCountry !== home : null;
  if ([...b.endpoints, b.destinationCountry].some((c) => c && c !== home)) return true;
  return b.endpoints.length >= 2 && b.endpoints.every((c) => c === home) ? false : null;
}

export interface TripFacts {
  service: string; // FLIGHT | HOTEL
  requestDay: string | null;
  travelDay: string | null;
  /** For the traveller's home country (isInternationalFor); null = not known. */
  isInternational: boolean | null;
  destinationCountry: string | null; // ISO-2
  destinationCity: string | null;
  /** ISO-2 country that counts as domestic. Default India. */
  home?: string;
}

export type Outcome =
  | "COMPLIANT"
  | "VIOLATION"
  | "UNMAPPED"
  | "GUEST"
  | "UNKNOWN_DESTINATION"
  | "NO_RULE"
  | "BAD_DATES"
  | "NOT_IN_FORCE"
  | "NOT_CONFIGURED";

export interface Evaluation {
  outcome: Outcome;
  requiredDays: number | null;
  actualDays: number | null;
  daysShort: number | null;
  versionNumber: number | null;
}

type Need = number | null; // null = this tier has no advance rule for the trip
const setOf = (xs: Need[]) => new Set<Need>(xs);
const same = (a: Set<Need>, b: Set<Need>) => a.size === b.size && [...a].every((x) => b.has(x));

function flightNeeds(rules: Rule[], tierKey: string, trip: TripFacts): Set<Need> {
  const hit = selectRule(rules, "FLIGHT", tierKey, { cityKey: null, country: null }, []);
  if (!hit) return setOf([null]);
  const p = hit.rule.params as FlightParams;
  const dom = p.minAdvanceDaysDomestic ?? null;
  const intl = p.minAdvanceDaysInternational ?? null;
  return trip.isInternational === null ? setOf([dom, intl]) : setOf([trip.isInternational ? intl : dom]);
}

const HOTEL_CLASSES = ["METRO", "TIER2", "OTHER", "INTERNATIONAL"];

function hotelNeeds(rules: Rule[], tierKey: string, trip: TripFacts, cities: CityForClass[]): Set<Need> {
  const home = trip.home ?? "IN";
  const mine = rules.filter((r) => r.category === "HOTEL" && r.tierKey === tierKey);
  const need = (r: Rule | undefined): Need => (r ? ((r.params as HotelParams).minAdvanceDays ?? null) : null);
  const country = trip.destinationCountry ? trip.destinationCountry.toUpperCase() : trip.isInternational === false ? home : null;
  const city = trip.destinationCity ? normalizeKey(trip.destinationCity) : null;
  if (country && city) {
    return setOf([need(selectRule(rules, "HOTEL", tierKey, { cityKey: city, country }, cities, home)?.rule)]);
  }
  // City or country unknown: every rule that could have applied.
  const classNeed = (cls: string) => need(mine.find((r) => r.scope.kind === "CITY_CLASS" && r.scope.value === cls));
  const cityNeeds = mine.filter((r) => r.scope.kind === "CITY").map(need);
  if (country === home) {
    const settled = mine.find((r) => r.scope.kind === "COUNTRY" && r.scope.value === home) ?? mine.find((r) => r.scope.kind === "REGION" && r.scope.value === regionOfCountry(home));
    return setOf([...cityNeeds, ...(settled ? [need(settled)] : ["METRO", "TIER2", "OTHER"].map(classNeed))]);
  }
  if (country) {
    return setOf([...cityNeeds, need(selectRule(rules, "HOTEL", tierKey, { cityKey: null, country }, cities, home)?.rule)]);
  }
  return setOf([...mine.map(need), ...HOTEL_CLASSES.map(classNeed)]);
}

/** Every advance-day requirement that could apply to this trip for one tier (one value = settled). */
export function tierNeeds(rules: Rule[], tierKey: string, trip: TripFacts, cities: CityForClass[]): Set<Need> {
  return trip.service === "HOTEL" ? hotelNeeds(rules, tierKey, trip, cities) : flightNeeds(rules, tierKey, trip);
}

/**
 * `resolveTierFor` is asked for the traveller's tier under the version in
 * force (tiers change between versions). null = the traveller was not matched
 * to a profile.
 */
export function evaluateTrip(
  trip: TripFacts,
  versions: PolicyVersionLite[],
  resolveTierFor: (tiers: Tier[]) => TierResolution | null,
  cities: CityForClass[] = [],
): Evaluation {
  const out = (outcome: Outcome, over: Partial<Evaluation> = {}): Evaluation => ({
    outcome,
    requiredDays: null,
    actualDays: null,
    daysShort: null,
    versionNumber: null,
    ...over,
  });
  if (!versions.some((v) => v.status === "PUBLISHED")) return out("NOT_CONFIGURED");
  if (!trip.requestDay || !trip.travelDay) return out("BAD_DATES");
  const actualDays = daysBetween(trip.requestDay, trip.travelDay);
  // Travel before the request is a data-entry error, as in Booking lead time.
  if (actualDays < 0) return out("BAD_DATES");
  const version = pickVersionAt(versions, trip.requestDay);
  if (!version) return out("NOT_IN_FORCE", { actualDays });
  const base = { actualDays, versionNumber: version.versionNumber ?? null };

  const tier = resolveTierFor(version.tiers);
  if (tier?.status === "GUEST") return out("GUEST", base);

  let needs: Set<Need>;
  if (tier?.status === "MAPPED") {
    needs = tierNeeds(version.rules, tier.tierKey, trip, cities);
  } else {
    const perTier = version.tiers.filter((t) => t.active).map((t) => tierNeeds(version.rules, t.tierKey, trip, cities));
    if (!perTier.length || perTier.some((s) => !same(s, perTier[0]))) return out("UNMAPPED", base);
    needs = perTier[0];
  }
  if (needs.size > 1) return out("UNKNOWN_DESTINATION", base);
  const requiredDays = [...needs][0];
  if (requiredDays === null) return out("NO_RULE", base);
  return actualDays < requiredDays
    ? out("VIOLATION", { ...base, requiredDays, daysShort: requiredDays - actualDays })
    : out("COMPLIANT", { ...base, requiredDays, daysShort: 0 });
}

/* ── Traveller matching ───────────────────────────────────────────────── */

export interface ProfileLite {
  _id: unknown;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  email?: string;
  claimedBy?: unknown;
  isActive?: boolean;
}

export const nameKeyOf = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
/** The lead name of a mirror row: "Asha Rao +2" → "Asha Rao". */
export const leadName = (s: unknown) => String(s ?? "").replace(/\s\+\d+$/, "").trim();

/** Match by profile id, else login, else email, else exact name. Two people with the same key = no match. */
export function buildTravellerIndex<T extends ProfileLite>(profiles: T[]) {
  const byId = new Map<string, T>();
  const byLogin = new Map<string, T[]>();
  const byEmail = new Map<string, T[]>();
  const byName = new Map<string, T[]>();
  const add = (m: Map<string, T[]>, k: string, p: T) => {
    if (!k) return;
    const list = m.get(k) ?? [];
    if (!list.includes(p)) list.push(p);
    m.set(k, list);
  };
  for (const p of profiles) {
    byId.set(String(p._id), p);
    if (p.claimedBy) add(byLogin, String(p.claimedBy), p);
    add(byEmail, String(p.email ?? "").trim().toLowerCase(), p);
    add(byName, nameKeyOf([p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ")), p);
    add(byName, nameKeyOf([p.firstName, p.lastName].filter(Boolean).join(" ")), p);
  }
  const only = (list: T[] | undefined): T | null => {
    if (!list?.length) return null;
    const active = list.filter((p) => p.isActive !== false);
    const pool = active.length ? active : list;
    return pool.length === 1 ? pool[0] : null;
  };
  return (who: { profileId?: unknown; userId?: unknown; email?: string | null; name?: string | null }): T | null => {
    if (who.profileId && byId.has(String(who.profileId))) return byId.get(String(who.profileId))!;
    if (who.userId) {
      const hit = only(byLogin.get(String(who.userId)));
      if (hit) return hit;
    }
    const email = String(who.email ?? "").trim().toLowerCase();
    if (email && byEmail.has(email)) return only(byEmail.get(email));
    return only(byName.get(nameKeyOf(who.name)));
  };
}

/* ── Summary ──────────────────────────────────────────────────────────── */

export type RegionBy = "work" | "destination";
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
export const TOP_PER_REGION = 5;

export function summarise(trips: ComplianceTrip[], regionBy: RegionBy) {
  const count = (o: Outcome) => trips.filter((t) => t.outcome === o).length;
  const isEvaluated = (t: ComplianceTrip) => t.outcome === "COMPLIANT" || t.outcome === "VIOLATION";
  const regionOf = (t: ComplianceTrip) => (regionBy === "destination" ? t.destinationRegion : t.workRegion);
  const violations = trips.filter((t) => t.outcome === "VIOLATION");
  const evaluated = trips.filter(isEvaluated).length;

  const part = (rows: ComplianceTrip[]) => {
    const ev = rows.filter(isEvaluated).length;
    const vi = rows.filter((t) => t.outcome === "VIOLATION").length;
    return { trips: rows.length, evaluated: ev, violations: vi, violationPct: pct(vi, ev) };
  };

  const order = [...COMPLIANCE_REGIONS, UNKNOWN_REGION] as string[];
  const regions = order
    .map((region) => ({ region, ...part(trips.filter((t) => regionOf(t) === region)) }))
    .filter((r) => r.trips > 0)
    .sort((a, b) => b.violations - a.violations || order.indexOf(a.region) - order.indexOf(b.region));

  const topViolators = regions
    .filter((r) => r.violations > 0)
    .map((r) => {
      const people = new Map<string, { employee: string; employeeId: string; department: string; company: string; violations: number; trips: number; short: number }>();
      for (const t of trips) {
        if (regionOf(t) !== r.region || !isEvaluated(t)) continue;
        const k = `${t.companyId}|${t.travellerKey}`;
        const p = people.get(k) ?? {
          employee: t.employee,
          employeeId: t.employeeId,
          department: t.department,
          company: t.company,
          violations: 0,
          trips: 0,
          short: 0,
        };
        p.trips++;
        if (t.outcome === "VIOLATION") {
          p.violations++;
          p.short += t.daysShort ?? 0;
        }
        people.set(k, p);
      }
      return {
        region: r.region,
        people: [...people.values()]
          .filter((p) => p.violations > 0)
          .sort((a, b) => b.violations - a.violations || b.short - a.short || a.employee.localeCompare(b.employee))
          .slice(0, TOP_PER_REGION)
          .map(({ short, ...p }) => ({ ...p, avgDaysShort: r1(short / p.violations) })),
      };
    });

  return {
    totals: {
      trips: trips.length,
      evaluated,
      compliant: count("COMPLIANT"),
      violations: violations.length,
      violationPct: pct(violations.length, evaluated),
      avgDaysShort: violations.length ? r1(violations.reduce((a, t) => a + (t.daysShort ?? 0), 0) / violations.length) : null,
      violators: new Set(violations.map((t) => `${t.companyId}|${t.travellerKey}`)).size,
    },
    notEvaluated: {
      UNMAPPED: count("UNMAPPED"),
      GUEST: count("GUEST"),
      UNKNOWN_DESTINATION: count("UNKNOWN_DESTINATION"),
      NO_RULE: count("NO_RULE"),
      BAD_DATES: count("BAD_DATES"),
      NOT_IN_FORCE: count("NOT_IN_FORCE"),
      NOT_CONFIGURED: count("NOT_CONFIGURED"),
    },
    split: {
      DOMESTIC: part(trips.filter((t) => t.isInternational === false)),
      INTERNATIONAL: part(trips.filter((t) => t.isInternational === true)),
      UNKNOWN: part(trips.filter((t) => t.isInternational === null)),
    },
    regions,
    topViolators,
  };
}

/** Most recent request first, then the longest shortfall. */
export function sortViolations(trips: ComplianceTrip[]): ComplianceTrip[] {
  return trips
    .filter((t) => t.outcome === "VIOLATION")
    .sort(
      (a, b) =>
        String(b.requestedOn).localeCompare(String(a.requestedOn)) || (b.daysShort ?? 0) - (a.daysShort ?? 0) || a.id.localeCompare(b.id),
    );
}
