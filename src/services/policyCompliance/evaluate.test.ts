// Policy Compliance: evaluation, region mapping, version-at-date (pure).
import { describe, it, expect } from "vitest";
import { pickVersionAt, resolveTier, samePolicy, sanitizeParams, type CityForClass, type Rule, type Tier } from "../travelPolicy/core.js";
import { COMPLIANCE_REGIONS, regionForCountry, workLocationCountry, workLocationRegion } from "./regions.js";
import { buildTravellerIndex, daysBetween, evaluateTrip, istDayOf, leadName, homeCountry, isInternationalFor, sortViolations, summarise, type TripFacts } from "./evaluate.js";
import { buildTrips, type ComplianceBooking, type ComplianceTrip } from "./trips.js";
import { ISO_COUNTRIES } from "../../data/isoCodes.js";

const tier = (tierKey: string, bandNumbers: number[]): Tier => ({ tierKey, name: tierKey, code: "", description: "", sortOrder: 0, active: true, designationIds: [], bandNumbers });
const flight = (tierKey: string, dom: number | null, intl: number | null): Rule => ({
  ruleKey: `${tierKey}-f`, category: "FLIGHT", tierKey, scope: { kind: "DEFAULT", value: null }, currency: "INR", notes: "",
  params: { allowedCabins: [], maxFareDomestic: null, maxFareInternational: null, minAdvanceDaysDomestic: dom, minAdvanceDaysInternational: intl, fareLimitBasis: "ONE_WAY" },
});
const hotel = (tierKey: string, kind: "CITY_CLASS" | "COUNTRY" | "CITY", value: string, days: number | null | undefined): Rule => ({
  ruleKey: `${tierKey}-${value}`, category: "HOTEL", tierKey, scope: { kind, value }, currency: "INR", notes: "",
  params: { maxPerNight: 5000, taxesIncluded: true, maxStarRating: null, ...(days === undefined ? {} : { minAdvanceDays: days }) },
});
const version = (from: string, to: string | null, rules: Rule[], tiers = [tier("std", [1]), tier("exec", [9])], versionNumber = 1) =>
  ({ status: "PUBLISHED", effectiveFrom: from, effectiveTo: to, versionNumber, tiers, rules });
const trip = (over: Partial<TripFacts> = {}): TripFacts => ({
  service: "FLIGHT", requestDay: "2026-11-01", travelDay: "2026-11-08", isInternational: false, destinationCountry: "IN", destinationCity: "Mumbai", ...over,
});
const band = (n: number | null) => (tiers: Tier[]) => resolveTier({ bandNumber: n }, tiers, null);
const nobody = () => null;
const tens = [flight("std", 10, 10), flight("exec", 10, 10)];
const mixed = [flight("std", 10, 14), flight("exec", 7, 10)];

describe("evaluateTrip", () => {
  const v = [version("2026-01-01", null, mixed)];

  it("boundary: exactly the required days is compliant, one fewer is a violation", () => {
    expect(evaluateTrip(trip({ travelDay: "2026-11-11" }), v, band(1))).toMatchObject({ outcome: "COMPLIANT", requiredDays: 10, actualDays: 10, daysShort: 0 });
    expect(evaluateTrip(trip({ travelDay: "2026-11-10" }), v, band(1))).toMatchObject({ outcome: "VIOLATION", requiredDays: 10, actualDays: 9, daysShort: 1 });
  });
  it("domestic and international use their own days, per tier", () => {
    const at12 = { travelDay: "2026-11-13" };
    expect(evaluateTrip(trip(at12), v, band(1)).outcome).toBe("COMPLIANT"); // 12 >= 10
    expect(evaluateTrip(trip({ ...at12, isInternational: true, destinationCountry: "GB" }), v, band(1))).toMatchObject({ outcome: "VIOLATION", requiredDays: 14, daysShort: 2 });
    expect(evaluateTrip(trip({ ...at12, isInternational: true, destinationCountry: "GB" }), v, band(9))).toMatchObject({ outcome: "COMPLIANT", requiredDays: 10 });
    // International flight that lands in India: the mirror's flag decides, not the destination.
    expect(evaluateTrip(trip({ ...at12, isInternational: true, destinationCountry: "IN" }), v, band(1)).requiredDays).toBe(14);
  });
  it("unmapped traveller: bucketed when tiers differ, evaluated when every tier agrees", () => {
    expect(evaluateTrip(trip(), v, nobody).outcome).toBe("UNMAPPED");
    expect(evaluateTrip(trip(), v, band(null)).outcome).toBe("UNMAPPED");
    const same = [version("2026-01-01", null, tens)];
    expect(evaluateTrip(trip(), same, nobody)).toMatchObject({ outcome: "VIOLATION", requiredDays: 10, daysShort: 3 });
    // A tier without a rule is a difference too; an inactive one is not.
    expect(evaluateTrip(trip(), [version("2026-01-01", null, [flight("std", 10, 10)])], nobody).outcome).toBe("UNMAPPED");
    const off = [tier("std", [1]), { ...tier("exec", [9]), active: false }];
    expect(evaluateTrip(trip(), [version("2026-01-01", null, mixed, off)], nobody).requiredDays).toBe(10);
  });
  it("guest, no rule, bad dates, not configured", () => {
    expect(evaluateTrip(trip(), v, (tiers) => resolveTier({ bandNumber: 1 }, tiers, { excluded: "GUEST" })).outcome).toBe("GUEST");
    expect(evaluateTrip(trip(), [version("2026-01-01", null, [flight("std", null, 14)])], band(1)).outcome).toBe("NO_RULE");
    expect(evaluateTrip(trip({ travelDay: null }), v, band(1)).outcome).toBe("BAD_DATES");
    expect(evaluateTrip(trip({ travelDay: "2026-10-30" }), v, band(1)).outcome).toBe("BAD_DATES");
    expect(evaluateTrip(trip(), [], band(1)).outcome).toBe("NOT_CONFIGURED");
    expect(evaluateTrip(trip({ travelDay: null }), [], band(1)).outcome).toBe("NOT_CONFIGURED");
    expect(evaluateTrip(trip(), [{ ...v[0], status: "DRAFT" }], band(1)).outcome).toBe("NOT_CONFIGURED");
  });
  it("0 required days is a rule, and same-day travel meets it", () => {
    expect(evaluateTrip(trip({ travelDay: "2026-11-01" }), [version("2026-01-01", null, [flight("std", 0, 0)])], band(1)).outcome).toBe("COMPLIANT");
  });
  it("unknown domestic/international is only evaluated when both need the same days", () => {
    expect(evaluateTrip(trip({ isInternational: null, destinationCountry: null }), v, band(1)).outcome).toBe("UNKNOWN_DESTINATION");
    expect(evaluateTrip(trip({ isInternational: null, destinationCountry: null }), [version("2026-01-01", null, tens)], band(1)).outcome).toBe("VIOLATION");
  });
});

describe("evaluateTrip — hotels", () => {
  const cities: CityForClass[] = [{ cityKey: "c-mum", nameKey: "mumbai", country: "IN", category: "METRO", isActive: true }];
  const rules = [hotel("std", "CITY_CLASS", "METRO", 5), hotel("std", "CITY_CLASS", "OTHER", 3), hotel("std", "CITY_CLASS", "TIER2", 3), hotel("std", "CITY_CLASS", "INTERNATIONAL", 12)];
  const v = [version("2026-01-01", null, rules)];
  const at = (over: Partial<TripFacts>) => evaluateTrip(trip({ service: "HOTEL", ...over }), v, band(1), cities);

  it("uses the rule for the destination", () => {
    expect(at({ destinationCity: "Mumbai" }).requiredDays).toBe(5);
    expect(at({ destinationCity: "Nashik" }).requiredDays).toBe(3);
    expect(at({ destinationCity: "London", destinationCountry: "GB", isInternational: true })).toMatchObject({ outcome: "VIOLATION", requiredDays: 12, daysShort: 5 });
    expect(at({ destinationCity: null, destinationCountry: "GB", isInternational: true }).requiredDays).toBe(12);
  });
  it("never reads an unknown place as India", () => {
    expect(at({ destinationCity: null, destinationCountry: null, isInternational: null }).outcome).toBe("UNKNOWN_DESTINATION");
    expect(at({ destinationCity: null, destinationCountry: "IN" }).outcome).toBe("UNKNOWN_DESTINATION");
  });
  it("a hotel rule saved before advance days existed is no rule, and equals one saved with none", () => {
    const old = [version("2026-01-01", null, [hotel("std", "CITY_CLASS", "METRO", undefined)])];
    expect(evaluateTrip(trip({ service: "HOTEL" }), old, band(1), cities).outcome).toBe("NO_RULE");
    const a = { tiers: [tier("std", [1])], rules: [hotel("std", "CITY_CLASS", "METRO", undefined)] };
    const b = { tiers: [tier("std", [1])], rules: [hotel("std", "CITY_CLASS", "METRO", null)] };
    const c = { tiers: [tier("std", [1])], rules: [hotel("std", "CITY_CLASS", "METRO", 4)] };
    expect(samePolicy(a, b)).toBe(true);
    expect(samePolicy(a, c)).toBe(false);
  });
  it("the sanitiser keeps whole days 0-365 only", () => {
    const errors: string[] = [];
    expect(sanitizeParams("HOTEL", { minAdvanceDays: "9" }, "x", errors)).toMatchObject({ minAdvanceDays: 9 });
    expect(errors).toEqual([]);
    sanitizeParams("HOTEL", { minAdvanceDays: 400 }, "x", errors);
    expect(errors[0]).toMatch(/Min advance/);
  });
});

describe("version in force on the request date", () => {
  const v1 = version("2026-08-01", "2026-10-31", [flight("std", 7, 7)], undefined, 1);
  const v2 = version("2026-11-01", null, [flight("std", 10, 10)], undefined, 2);
  const versions = [v2, v1];
  it("pickVersionAt: window edges are inclusive, order does not matter, drafts and archived are ignored", () => {
    expect(pickVersionAt(versions, "2026-10-31")).toBe(v1);
    expect(pickVersionAt(versions, "2026-11-01")).toBe(v2);
    expect(pickVersionAt(versions, "2026-07-31")).toBeNull();
    expect(pickVersionAt([{ ...v1, status: "ARCHIVED" }, { ...v1, status: "DRAFT" }], "2026-09-01")).toBeNull();
  });
  it("the request date picks the version, not the travel date or today", () => {
    // Both trips travel 8 days after the request, in November.
    expect(evaluateTrip(trip({ requestDay: "2026-10-31", travelDay: "2026-11-08" }), versions, band(1))).toMatchObject({ outcome: "COMPLIANT", requiredDays: 7, versionNumber: 1 });
    expect(evaluateTrip(trip({ requestDay: "2026-11-01", travelDay: "2026-11-09" }), versions, band(1))).toMatchObject({ outcome: "VIOLATION", requiredDays: 10, versionNumber: 2 });
    expect(evaluateTrip(trip({ requestDay: "2026-07-31" }), versions, band(1)).outcome).toBe("NOT_IN_FORCE");
  });
  it("the tier is resolved under that version's tiers", () => {
    const old = version("2026-08-01", "2026-10-31", [flight("std", 7, 7), flight("exec", 3, 3)], [tier("std", []), tier("exec", [1])], 1);
    expect(evaluateTrip(trip({ requestDay: "2026-10-01", travelDay: "2026-10-05" }), [old, v2], band(1))).toMatchObject({ outcome: "COMPLIANT", requiredDays: 3 });
  });
  it("days are IST calendar days", () => {
    expect(istDayOf(new Date("2026-11-01T18:29:59Z"))).toBe("2026-11-01");
    expect(istDayOf(new Date("2026-11-01T18:30:00Z"))).toBe("2026-11-02");
    expect(istDayOf(null)).toBeNull();
    expect(istDayOf("not a date")).toBeNull();
    expect(daysBetween("2026-10-28", "2026-11-03")).toBe(6);
  });
});

describe("regions", () => {
  it.each([
    ["IN", "India"], ["US", "Americas"], ["BR", "Americas"], ["SG", "APAC"], ["AU", "APAC"], ["NP", "APAC"], ["AE", "Middle East"],
    ["ZA", "Africa"], ["EG", "Africa"], ["GB", "Europe"], ["tr", "Europe"], ["", "Not set"], [null, "Not set"], ["XX", "Not set"],
  ])("country %s → %s", (c, r) => expect(regionForCountry(c)).toBe(r));
  it("every inhabited ISO country has exactly one region", () => {
    const none = ISO_COUNTRIES.map((c) => c.code).filter((c) => regionForCountry(c) === "Not set");
    expect(none.sort()).toEqual(["AQ", "BV", "GS", "TF"]);
    expect(COMPLIANCE_REGIONS).toHaveLength(6);
  });
  it.each([
    ["Bengaluru", "IN"], ["Gurugram, India", "IN"], ["San Francisco, USA", "US"], ["Austin, United States", "US"], ["US", "US"], ["Singapore", "SG"],
    ["Sydney, Australia", "AU"], ["Cape Town, South Africa", "ZA"], ["Johannesburg", "ZA"], ["London (UK)", "GB"], ["Dubai, UAE", "AE"], ["Mumbai - BKC office", "IN"],
    ["San Francisco, CA", "US"], ["Head office", null], ["", null], [undefined, null],
  ])("work location %s → %s", (loc, c) => {
    const got = workLocationCountry(loc);
    // "CA" is never Canada here; an unknown city stays unknown.
    if (loc === "San Francisco, CA") expect([c, null]).toContain(got);
    else expect(got).toBe(c);
  });
  it("region of a work location", () => {
    expect(workLocationRegion("Sydney, Australia")).toBe("APAC");
    expect(workLocationRegion("WFH")).toBe("Not set");
  });
});

describe("traveller matching", () => {
  const p = (id: string, firstName: string, lastName: string, over: any = {}) => ({ _id: id, firstName, lastName, isActive: true, ...over });
  const find = buildTravellerIndex([
    p("1", "Asha", "Rao", { email: "asha@x.test", claimedBy: "u1" }), p("2", "Ravi", "Nair"), p("3", "Ravi", "Nair"),
    p("4", "Meera", "Shah", { isActive: false }), p("5", "Meera", "Shah"), p("6", "Tom", "Lee", { middleName: "J", email: "tom@x.test" }),
  ]);
  it("profile id, then login, then email, then exact name", () => {
    expect(find({ profileId: "2", email: "asha@x.test" })?._id).toBe("2");
    expect(find({ userId: "u1", name: "Someone Else" })?._id).toBe("1");
    expect(find({ email: "ASHA@x.test ", name: "Tom Lee" })?._id).toBe("1");
    expect(find({ email: "new@x.test", name: "tom  lee" })?._id).toBe("6");
    expect(find({ name: "Tom J Lee" })?._id).toBe("6");
    expect(find({ name: "Tom" })).toBeNull();
  });
  it("two people with one name are never guessed; an inactive namesake does not block the active one", () => {
    expect(find({ name: "Ravi Nair" })).toBeNull();
    expect(find({ name: "Meera Shah" })?._id).toBe("5");
    expect(find({})).toBeNull();
  });
  it("leadName drops the +N", () => {
    expect(leadName("Asha Rao +2")).toBe("Asha Rao");
    expect(leadName("Asha Rao")).toBe("Asha Rao");
  });
});

describe("summarise", () => {
  let n = 0;
  const row = (over: Partial<ComplianceTrip>): ComplianceTrip => ({
    id: String(++n), companyId: "c", company: "", travellerKey: "a", employee: "Asha", employeeId: "E1", department: "Sales", workLocation: "", workRegion: "India", destinationRegion: "Europe",
    services: [], sector: "", isInternational: true, requestedOn: "2026-11-01", travelOn: "2026-11-05", amount: 100, outcome: "VIOLATION", requiredDays: 10, actualDays: 4, daysShort: 6, versionNumber: 1, ...over,
  });
  const rows = [
    row({}), row({ daysShort: 2 }), row({ outcome: "COMPLIANT", daysShort: 0 }),
    row({ travellerKey: "b", employee: "Ben", workRegion: "APAC", isInternational: false, destinationRegion: "APAC", daysShort: 4 }),
    row({ travellerKey: "c", employee: "Cy", outcome: "UNMAPPED", workRegion: "Not set", daysShort: null }),
    row({ outcome: "GUEST", isInternational: null, daysShort: null }),
  ];
  it("totals, split and buckets", () => {
    const s = summarise(rows, "work");
    expect(s.totals).toEqual({ trips: 6, evaluated: 4, compliant: 1, violations: 3, violationPct: 75, avgDaysShort: 4, violators: 2 });
    expect(s.notEvaluated).toMatchObject({ UNMAPPED: 1, GUEST: 1, NO_RULE: 0 });
    expect(s.split.DOMESTIC).toEqual({ trips: 1, evaluated: 1, violations: 1, violationPct: 100 });
    expect(s.split.INTERNATIONAL).toMatchObject({ trips: 4, evaluated: 3, violations: 2 });
    expect(s.split.UNKNOWN.trips).toBe(1);
    expect(s.totals.trips).toBe(s.totals.evaluated + Object.values(s.notEvaluated).reduce((a, b) => a + b, 0));
  });
  it("regions and top violators follow the toggle", () => {
    const work = summarise(rows, "work");
    expect(work.regions.map((r) => [r.region, r.violations])).toEqual([["India", 2], ["APAC", 1], ["Not set", 0]]);
    expect(work.topViolators[0]).toEqual({ region: "India", people: [{ employee: "Asha", employeeId: "E1", department: "Sales", company: "", violations: 2, trips: 3, avgDaysShort: 4 }] });
    expect(summarise(rows, "destination").regions.map((r) => [r.region, r.violations])).toEqual([["Europe", 2], ["APAC", 1]]);
  });
  it("no violations → no average, no division by zero", () => {
    expect(summarise([], "work").totals).toMatchObject({ trips: 0, violationPct: 0, avgDaysShort: null });
  });
  it("the table lists only violations, newest request first", () => {
    const s = sortViolations([row({ requestedOn: "2026-10-01" }), row({ requestedOn: "2026-11-09" }), row({ outcome: "COMPLIANT" })]);
    expect(s.map((t) => t.requestedOn)).toEqual(["2026-11-09", "2026-10-01"]);
  });
});

describe("trips: bookings grouped into one trip", () => {
  let n = 0;
  const bk = (over: Partial<ComplianceBooking> = {}): ComplianceBooking => ({
    id: `b${++n}`, companyId: "c", company: "", travellerKey: "p:asha", employee: "Asha", employeeId: "E1", department: "Sales", workLocation: "", workRegion: "India",
    destinationRegion: "Europe", destinationKey: "london", approvalRequestId: null, service: "FLIGHT", sector: "Delhi → London", isInternational: true,
    requestedOn: "2026-11-01", travelOn: "2026-11-05", travelEnd: "2026-11-09", amount: 100, outcome: "VIOLATION", requiredDays: 10, actualDays: 4, daysShort: 6, versionNumber: 1, ...over,
  });
  const hotel = (over: Partial<ComplianceBooking> = {}) => bk({ service: "HOTEL", sector: "Hilton, London", amount: 50, ...over });
  const sizes = (rows: ComplianceBooking[]) => buildTrips(rows).map((t) => t.services.length).sort();

  it("flight + hotel, same traveller, destination and dates: one trip, one violation", () => {
    const [t, ...rest] = buildTrips([hotel(), bk()]);
    expect(rest).toEqual([]);
    expect(t).toMatchObject({ outcome: "VIOLATION", amount: 150, sector: "Delhi → London", daysShort: 6 });
    expect(t.services.map((s) => [s.service, s.late])).toEqual([["FLIGHT", true], ["HOTEL", true]]);
    expect(summarise([t], "work").totals).toMatchObject({ trips: 1, violations: 1 });
  });
  it("dates touch on one day = overlap; a day apart = two trips; overlap chains", () => {
    expect(sizes([bk(), hotel({ travelOn: "2026-11-09", travelEnd: "2026-11-11" })])).toEqual([2]);
    expect(sizes([bk(), hotel({ travelOn: "2026-11-10", travelEnd: "2026-11-11" })])).toEqual([1, 1]);
    expect(sizes([bk(), hotel({ travelOn: "2026-11-08", travelEnd: "2026-11-12" }), hotel({ travelOn: "2026-11-12", travelEnd: "2026-11-14" })])).toEqual([3]);
    expect(sizes([bk({ travelEnd: null }), hotel({ travelOn: "2026-11-05", travelEnd: "2026-11-08" })])).toEqual([2]);
    expect(sizes([bk({ travelEnd: "2026-10-01" }), hotel({ travelOn: "2026-11-06", travelEnd: "2026-11-08" })])).toEqual([1, 1]);
  });
  it("another traveller, destination or company is another trip; so is a booking we cannot place", () => {
    expect(sizes([bk(), hotel({ travellerKey: "p:ben" })])).toEqual([1, 1]);
    expect(sizes([bk(), hotel({ destinationKey: "paris" })])).toEqual([1, 1]);
    expect(sizes([bk(), hotel({ companyId: "d" })])).toEqual([1, 1]);
    expect(sizes([bk({ travellerKey: "" }), hotel({ travellerKey: "" })])).toEqual([1, 1]);
    expect(sizes([bk({ destinationKey: "" }), hotel({ destinationKey: "" })])).toEqual([1, 1]);
    expect(sizes([bk({ travelOn: null }), hotel({ travelOn: null })])).toEqual([1, 1]);
  });
  it("the approval request wins over dates and destination, per traveller", () => {
    expect(sizes([bk({ approvalRequestId: "r1" }), hotel({ approvalRequestId: "r1", destinationKey: "paris", travelOn: "2026-12-20", travelEnd: null })])).toEqual([2]);
    expect(sizes([bk({ approvalRequestId: "r1" }), bk({ approvalRequestId: "r1", travellerKey: "p:ben" })])).toEqual([1, 1]);
    expect(sizes([bk({ approvalRequestId: "r1" }), hotel({ approvalRequestId: "r2" })])).toEqual([1, 1]);
  });
  it("a booking with no request joins the overlapping requested trip, and never glues two requests", () => {
    expect(sizes([bk({ approvalRequestId: "r1" }), hotel()])).toEqual([2]);
    expect(sizes([bk({ approvalRequestId: "r1" }), bk({ approvalRequestId: "r2", travelOn: "2026-11-09", travelEnd: "2026-11-12" }), hotel({ travelOn: "2026-11-08", travelEnd: "2026-11-10" })])).toEqual([1, 2]);
  });
  it("one verdict: any late booking makes the trip late, and the worst one is shown", () => {
    const [t] = buildTrips([bk({ outcome: "COMPLIANT", requiredDays: 10, actualDays: 20, daysShort: 0, requestedOn: "2026-10-16" }), hotel({ requiredDays: 7, actualDays: 2, daysShort: 5, requestedOn: "2026-11-03" })]);
    expect(t).toMatchObject({ outcome: "VIOLATION", requiredDays: 7, actualDays: 2, requestedOn: "2026-11-03" });
    expect(t.services.map((s) => s.late)).toEqual([false, true]);
    expect(buildTrips([bk({ daysShort: 2 }), hotel({ daysShort: 8 })])[0].daysShort).toBe(8);
  });
  it("an unsettled booking is never called compliant; one with no rule does not block it", () => {
    const ok = { outcome: "COMPLIANT" as const, daysShort: 0 };
    expect(buildTrips([bk(ok), hotel({ outcome: "UNMAPPED", daysShort: null })])[0].outcome).toBe("UNMAPPED");
    expect(buildTrips([bk(ok), hotel({ outcome: "UNKNOWN_DESTINATION", daysShort: null })])[0].outcome).toBe("UNKNOWN_DESTINATION");
    expect(buildTrips([bk(ok), hotel({ outcome: "NO_RULE", daysShort: null })])[0].outcome).toBe("COMPLIANT");
    expect(buildTrips([bk({ outcome: "UNMAPPED", daysShort: null }), hotel()])[0].outcome).toBe("VIOLATION");
  });
  it("a trip is international when any booking is", () => {
    expect(buildTrips([bk({ isInternational: false }), hotel({ isInternational: true })])[0].isInternational).toBe(true);
    expect(buildTrips([bk({ isInternational: null }), hotel({ isInternational: false })])[0].isInternational).toBe(false);
    expect(buildTrips([bk({ isInternational: null })])[0].isInternational).toBeNull();
  });
});

describe("domestic means: within India / within the work country", () => {
  it("home country: India unless the setting says otherwise; no work location → India", () => {
    expect(homeCountry("INDIA", "US")).toBe("IN");
    expect(homeCountry("WORK_COUNTRY", "US")).toBe("US");
    expect(homeCountry("WORK_COUNTRY", null)).toBe("IN");
  });
  const f = (endpoints: (string | null)[], mirrorInternational: boolean | null = true) =>
    isInternationalFor("US", { service: "FLIGHT", mirrorInternational, destinationCountry: endpoints[endpoints.length - 1], endpoints });
  it("India keeps the booking's own flag", () => {
    for (const m of [true, false, null]) expect(isInternationalFor("IN", { service: "FLIGHT", mirrorInternational: m, destinationCountry: "US", endpoints: ["US", "US"] })).toBe(m);
  });
  it("flights: domestic only when every end is known and at home", () => {
    expect(f(["US", "US"])).toBe(false);
    expect(f(["US", "GB"])).toBe(true);
    expect(f(["IN", "US"])).toBe(true);
    expect(f(["US", "GB", "GB", "US"])).toBe(true);
    expect(f([null, "US"])).toBeNull();
    expect(f([null, "GB"])).toBe(true);
    expect(f(["IN", "IN"], false)).toBe(true); // wholly within India
  });
  it("hotels: by the destination", () => {
    const h = (c: string | null) => isInternationalFor("AU", { service: "HOTEL", mirrorInternational: c ? true : null, destinationCountry: c, endpoints: [] });
    expect([h("AU"), h("GB"), h(null)]).toEqual([false, true, null]);
  });
  it("picks the domestic days for a trip at home, the international ones for India", () => {
    const v = [version("2026-01-01", null, mixed)];
    const usHome = trip({ isInternational: false, destinationCountry: "US", destinationCity: "Chicago", home: "US", travelDay: "2026-11-12" });
    expect(evaluateTrip(usHome, v, band(1))).toMatchObject({ outcome: "COMPLIANT", requiredDays: 10 });
    expect(evaluateTrip({ ...usHome, isInternational: true, destinationCountry: "IN" }, v, band(1))).toMatchObject({ outcome: "VIOLATION", requiredDays: 14 });
  });
  it("hotels: a city at home is not International; India is, for someone who works abroad", () => {
    const cities: CityForClass[] = [
      { cityKey: "mumbai", nameKey: "mumbai", country: "IN", category: "METRO", isActive: true },
      { cityKey: "chicago", nameKey: "chicago", country: "US", category: "INTERNATIONAL", isActive: true },
      { cityKey: "boston", nameKey: "boston", country: "US", category: "METRO", isActive: true },
    ];
    const v = [version("2026-01-01", null, [hotel("std", "CITY_CLASS", "METRO", 5), hotel("std", "CITY_CLASS", "OTHER", 3), hotel("std", "CITY_CLASS", "INTERNATIONAL", 12)])];
    const days = (home: string, destinationCity: string, destinationCountry: string) =>
      evaluateTrip(trip({ service: "HOTEL", home, destinationCity, destinationCountry, isInternational: destinationCountry !== home }), v, band(1), cities).requiredDays;
    expect(days("US", "Chicago", "US")).toBe(3);
    expect(days("US", "Boston", "US")).toBe(5);
    expect(days("US", "Mumbai", "IN")).toBe(12);
    expect(days("IN", "Mumbai", "IN")).toBe(5);
    expect(days("IN", "Boston", "US")).toBe(12);
  });
});
