import { describe, it, expect, afterEach } from "vitest";
import {
  isStateV2Enabled,
  parseFlightRefinement,
  mergeFlightFilters,
  applyFlightFilters,
  describeFlightFilters,
  matchXToYRoute,
  parseParkTask,
  isResumeFlights,
  projectForClient,
} from "./plutoTurnState.js";

const row = (idx: string, code: string, name: string, dep: string, arr: string, stops = 0, fare = 10000, refundable = true, arrDate = "2026-11-20") => ({
  ResultIndex: idx, airline: { code, name }, flightNo: `${code}-${idx}`, stops, isRefundable: refundable,
  fare: { offered: fare, published: fare }, durationMin: 120, duration: "2h 0m",
  departure: { time: `${dep}:00`, date: "2026-11-20" }, arrival: { time: `${arr}:00`, date: arrDate },
});
const ROWS = [
  row("a", "6E", "IndiGo", "06:00", "07:45", 0, 5200),
  row("b", "AI", "Air India", "08:30", "10:15", 0, 6100),
  row("c", "IX", "Air India Express", "15:10", "16:55", 0, 4900, false),
  row("d", "SG", "SpiceJet", "23:20", "01:20", 1, 4500, true, "2026-11-21"),
];
const ids = (r: any[]) => r.map((x) => x.ResultIndex);
const filtersOf = (p: string, rows: any[] = ROWS) => {
  const r = parseFlightRefinement(p, rows);
  return r && "filters" in r ? r.filters : r;
};

afterEach(() => { delete process.env.PLUTO_STATE_V2; });

describe("isStateV2Enabled", () => {
  it("off unless explicitly on", () => {
    delete process.env.PLUTO_STATE_V2;
    expect(isStateV2Enabled()).toBe(false);
    for (const v of ["", "off", "false", "0"]) { process.env.PLUTO_STATE_V2 = v; expect(isStateV2Enabled()).toBe(false); }
    for (const v of ["on", "ON", "true", "1"]) { process.env.PLUTO_STATE_V2 = v; expect(isStateV2Enabled()).toBe(true); }
  });
});

describe("parseFlightRefinement", () => {
  it.each([
    ["only non-stop", { maxStops: 0 }],
    ["direct flights please", { maxStops: 0 }],
    ["fewer stops", { maxStops: 1 }],
    ["cheaper option?", { sort: "price" }],
    ["something under 12k", { maxFare: 12000 }],
    ["fastest", { sort: "duration" }],
    ["morning only", { departWindow: "morning" }],
    ["evening flights", { departWindow: "evening" }],
    ["red-eye is fine", { departWindow: "night" }],
    ["after 6pm", { departAfter: "18:00" }],
    ["arrive by 10am", { arriveBy: "10:00" }],
    ["I need to be there by noon", { arriveBy: "12:00" }],
    ["reach before morning", { arriveBy: "12:00" }],
    ["refundable only", { refundableOnly: true }],
  ])("%s", (p, want) => expect(filtersOf(p)).toEqual(want));

  it("arrive-by never doubles as a departure window (design Q2)", () => {
    expect(filtersOf("be there by morning")).toEqual({ arriveBy: "12:00" });
  });
  it("dates are not clock times", () => {
    expect(filtersOf("need to be in Mumbai by 20 Nov")).toBeNull();
    expect(filtersOf("returning after 3 days")).toBeNull();
  });
  it("airlines: only names in the rows; longest first; exclusion", () => {
    expect(filtersOf("only Air India Express")).toEqual({ airlinesInclude: ["IX"] });
    expect(filtersOf("no Air India")).toEqual({ airlinesExclude: ["AI"] });
    expect(filtersOf("only Emirates")).toBeNull(); // not in these rows
  });
  it("clear", () => {
    expect(parseFlightRefinement("Clear filters")).toEqual({ clear: true });
    expect(parseFlightRefinement("show all flights")).toEqual({ clear: true });
  });
  it("non-refinements", () => {
    for (const p of ["thanks", "what's the baggage allowance?", "Pune", "non-refundable is fine"]) expect(filtersOf(p)).toBeNull();
  });
});

describe("mergeFlightFilters — accumulate (design Q4)", () => {
  it("adds, overrides, and moves an airline between include/exclude", () => {
    let f = mergeFlightFilters({}, { maxStops: 0 });
    f = mergeFlightFilters(f, { sort: "price" });
    expect(f).toEqual({ maxStops: 0, sort: "price" });
    f = mergeFlightFilters(f, { airlinesInclude: ["AI"] });
    f = mergeFlightFilters(f, { airlinesExclude: ["AI"] });
    expect(f.airlinesInclude).toBeUndefined();
    expect(f.airlinesExclude).toEqual(["AI"]);
    expect(mergeFlightFilters({ departAfter: "18:00" }, { departWindow: "morning" })).toEqual({ departWindow: "morning" });
  });
});

describe("applyFlightFilters", () => {
  it("windows, arrive-by on the leg date, stops, refundable, sort", () => {
    expect(ids(applyFlightFilters(ROWS, { departWindow: "morning" }, { leg: "out", legDate: "2026-11-20" }))).toEqual(["a", "b"]);
    expect(ids(applyFlightFilters(ROWS, { departWindow: "night" }, { leg: "out" }))).toEqual(["d"]);
    expect(ids(applyFlightFilters(ROWS, { arriveBy: "10:00" }, { leg: "out", legDate: "2026-11-20" }))).toEqual(["a"]);
    expect(ids(applyFlightFilters(ROWS, { maxStops: 0, refundableOnly: true }, { leg: "out" }))).toEqual(["a", "b"]);
    expect(ids(applyFlightFilters(ROWS, { sort: "price" }, { leg: "out" }))).toEqual(["d", "c", "a", "b"]);
  });
  it("time filters never apply to the return leg", () => {
    expect(ids(applyFlightFilters(ROWS, { departWindow: "morning" }, { leg: "in" }))).toEqual(["a", "b", "c", "d"]);
  });
  it("never mutates its input", () => {
    const before = ids(ROWS);
    applyFlightFilters(ROWS, { sort: "price" }, { leg: "out" });
    expect(ids(ROWS)).toEqual(before);
  });
  it("labels", () => {
    expect(describeFlightFilters({ maxStops: 0, departWindow: "morning", airlinesExclude: ["AI"], sort: "price" }, ROWS))
      .toEqual(["non-stop", "morning departures (05:00–11:59)", "no Air India", "cheapest first"]);
  });
});

describe("matchXToYRoute (F-11)", () => {
  it.each([
    ["bengaluru to mumbai on 20 nov", "flights from bengaluru to mumbai on 20 nov"],
    ["bengaluru to mumbai on 20 nov, morning flights only", "flights from bengaluru to mumbai on 20 nov, morning flights only"],
    ["BLR-DEL 5 Dec", "flights from BLR to DEL 5 Dec"],
    ["blr → bom tomorrow", "flights from blr to bom tomorrow"],
    ["Delhi to Goa", "flights from Delhi to Goa"],
  ])("%s", (p, rewritten) => expect(matchXToYRoute(p)?.prompt).toBe(rewritten));

  it.each([
    "bengaluru to goa trip ideas",
    "hotels from delhi to agra",
    "flights from Delhi to Mumbai on 20 May", // already read by the "from" form
    "I want to go to Goa",
    "BLR to DEL to BOM", // multi-city
    "delhi to delhi",
    "yes to both",
    "how far is delhi to agra",
  ])("not a route: %s", (p) => expect(matchXToYRoute(p)).toBeNull());
});

describe("parseParkTask (F-06)", () => {
  it.each([
    ["ok leave flights for now", "flight"],
    ["ok leave flight right now", "flight"],
    ["skip hotels", "hotel"],
    ["forget the hotel for now", "hotel"],
    ["hold off on flights", "flight"],
    ["no flights for now", "flight"],
    ["hotels can wait", "hotel"],
    ["not now", null],
    ["maybe later", null],
  ])("%s", (p, kind) => expect(parseParkTask(p)).toEqual({ kind }));

  it.each([
    "flights for 2 adults from DEL to BOM on 5 Dec",
    "flights for now to Goa",
    "skip hotels, show me flights to Goa", // compound: slice S4
    "leave for the airport at 6",
    "what time should I leave?",
  ])("not a park: %s", (p) => expect(parseParkTask(p)).toBeNull());

  it("resume", () => {
    expect(isResumeFlights("Back to flights")).toBe(true);
    expect(isResumeFlights("show the flights again")).toBe(true);
    expect(isResumeFlights("flights to Goa")).toBe(false);
  });
});

describe("whole-message parsers tolerate filler (S2 a)", () => {
  it.each([
    "[QC3] ok leave flights for now",
    "ok leave flights for now 🙏",
    "okay, leave flights for now!",
    "hey Pluto, leave flights for now please",
    "pls leave flights for now thanks",
    "hi, no flights for now",
  ])("park: %s", (p) => expect(parseParkTask(p)).toEqual({ kind: "flight" }));

  it.each(["thanks! skip hotels", "[QC] skip hotels 🙂", "hey, hotels can wait"])("park hotels: %s", (p) =>
    expect(parseParkTask(p)).toEqual({ kind: "hotel" }));

  it.each(["[QC3] Back to flights", "ok back to flights please", "hey Pluto, show the flights again 🙂", "go back to flights"])(
    "resume: %s",
    (p) => expect(isResumeFlights(p)).toBe(true),
  );

  it.each([
    ["[QC3] bengaluru to mumbai on 20 nov, morning flights only", "flights from bengaluru to mumbai on 20 nov, morning flights only"],
    ["hi Pluto, bengaluru to mumbai on 20 nov, morning flights only 🙂", "flights from bengaluru to mumbai on 20 nov, morning flights only"],
    ["please BLR-DEL 5 Dec thanks", "flights from BLR to DEL 5 Dec"],
    ["ok, Delhi to Goa", "flights from Delhi to Goa"],
  ])("X to Y: %s", (p, rewritten) => expect(matchXToYRoute(p)?.prompt).toBe(rewritten));

  it("filler never turns a non-park into a park", () => {
    expect(parseParkTask("ok skip hotels, show me flights to Goa")).toBeNull();
    expect(parseParkTask("[QC3] flights for 2 adults from DEL to BOM on 5 Dec")).toBeNull();
  });
});

describe("projectForClient", () => {
  it("strips rows, shownRefs and the timestamp; keeps the rest", () => {
    const state = {
      id: "c1", rev: 3, locked: { destination: { name: "Dubai" } },
      pending: { kind: "flight", need: "origin", prompt: "Flights to Dubai next week" },
      lastSearch: {
        active: "flight",
        flight: { at: 1, origin: "BLR", destination: "DXB", filters: { maxStops: 0 }, rows: { flights: [1, 2, 3] }, shownRefs: ["x"] },
        hotel: { at: 2, city: "Dubai", rows: [1, 2] },
      },
    };
    const out = projectForClient(state);
    expect(out.lastSearch).toEqual({
      active: "flight",
      flight: { origin: "BLR", destination: "DXB", filters: { maxStops: 0 }, count: 3 },
      hotel: { city: "Dubai", count: 2 },
    });
    expect(out.pending).toEqual(state.pending);
    expect(out.locked).toEqual(state.locked);
    expect(state.lastSearch.flight.rows.flights).toHaveLength(3); // input untouched
  });
});
