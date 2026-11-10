// Golden conversations — the Pluto conversation-state regression suite.
// Spec: docs/design/pluto-conversation-state-2026-11-10.md §5.
//
// Each fixture is ONE conversation, replayed turn by turn the way the page
// sends it (CP:3333: the previous reply's `context` + its id). Every external
// edge is stubbed (TBO flights + hotels, hotel-city resolution, the model, the
// conversation store) — see copilot.travel.golden.test.ts.
//
// `modes` says how each fixture runs with PLUTO_STATE_V2 off / on:
//   active — must pass
//   todo   — specified, lands in a later slice (it.todo)
//   fails  — must FAIL (it.fails): proof that today's code has the bug
import { expect } from "vitest";

export type Mode = "active" | "todo" | "fails";

export interface TurnExpect {
  branch?: string;
  aiCalled?: boolean;
  /** Supplier calls made during THIS turn. */
  flightCalls?: number;
  hotelCalls?: number;
  lastFlightArgs?: Record<string, any>;
  reply?: (reply: any) => void;
  /** The stored conversation after this turn (the in-memory store). */
  stored?: (state: any) => void;
  /** The prompt the model received this turn. */
  aiPrompt?: (prompt: string) => void;
}

export interface Turn {
  user: string;
  /** Send only `{ id }` as context (sidebar resume before rehydrate). */
  idOnly?: boolean;
  /** Advance the clock before this turn. */
  advanceMs?: number;
  /** Canned model reply for this turn (when it reaches the AI). */
  ai?: any;
  expect?: TurnExpect;
  /** Extra checks only with PLUTO_STATE_V2 on. */
  expectOn?: TurnExpect;
}

export interface Golden {
  name: string;
  modes: { off: Mode; on: Mode };
  /** Why it is todo / what slice it lands in. */
  note?: string;
  turns: Turn[];
}

/* ───────────────────────── supplier stubs ───────────────────────── */

type Seg = { from: string; to: string; dep: string; arr: string; mins: number; ground?: number };

function rawFlight(idx: string, code: string, name: string, no: string, fare: number, segs: Seg[], refundable = true) {
  return {
    ResultIndex: idx,
    IsLCC: code === "6E" || code === "IX",
    IsRefundable: refundable,
    Fare: { PublishedFare: fare, OfferedFare: fare, Currency: "INR" },
    Segments: [segs.map((s, i) => ({
      CabinClass: 2,
      Duration: s.mins,
      ...(i > 0 ? { GroundTime: s.ground ?? 60 } : {}),
      Airline: { AirlineCode: code, AirlineName: name, FlightNumber: no },
      Origin: { DepTime: s.dep, Airport: { AirportCode: s.from } },
      Destination: { ArrTime: s.arr, Airport: { AirportCode: s.to } },
    }))],
  };
}

const D16 = "2026-11-16";
const D17 = "2026-11-17";
/** BLR → DXB, Mon 16 Nov: 4 non-stops, 2 one-stops; the cheapest overall has a stop. */
const BLR_DXB = [
  rawFlight("NS-6E1419", "6E", "IndiGo", "1419", 18420, [{ from: "BLR", to: "DXB", dep: `${D16}T05:10:00`, arr: `${D16}T07:35:00`, mins: 245 }]),
  rawFlight("NS-AI933", "AI", "Air India", "933", 21900, [{ from: "BLR", to: "DXB", dep: `${D16}T09:30:00`, arr: `${D16}T12:00:00`, mins: 240 }]),
  rawFlight("NS-IX881", "IX", "Air India Express", "881", 19800, [{ from: "BLR", to: "DXB", dep: `${D16}T20:55:00`, arr: `${D16}T23:25:00`, mins: 260 }], false),
  rawFlight("NS-EK569", "EK", "Emirates", "569", 24500, [{ from: "BLR", to: "DXB", dep: `${D16}T22:15:00`, arr: `${D17}T00:50:00`, mins: 245 }]),
  rawFlight("1S-AI505", "AI", "Air India", "505", 11576, [
    { from: "BLR", to: "BOM", dep: `${D16}T06:00:00`, arr: `${D16}T07:45:00`, mins: 105 },
    { from: "BOM", to: "DXB", dep: `${D16}T09:15:00`, arr: `${D16}T11:00:00`, mins: 195, ground: 90 },
  ]),
  rawFlight("1S-6E211", "6E", "IndiGo", "211", 13200, [
    { from: "BLR", to: "HYD", dep: `${D16}T13:00:00`, arr: `${D16}T14:15:00`, mins: 75 },
    { from: "HYD", to: "DXB", dep: `${D16}T16:00:00`, arr: `${D16}T18:20:00`, mins: 230, ground: 105 },
  ]),
];

const D20 = "2026-11-20";
const D21 = "2026-11-21";
/** BLR → BOM, Fri 20 Nov: two morning departures, one afternoon, one red-eye. */
const BLR_BOM = [
  rawFlight("M-6E5301", "6E", "IndiGo", "5301", 5200, [{ from: "BLR", to: "BOM", dep: `${D20}T06:00:00`, arr: `${D20}T07:45:00`, mins: 105 }]),
  rawFlight("M-AI639", "AI", "Air India", "639", 6100, [{ from: "BLR", to: "BOM", dep: `${D20}T08:30:00`, arr: `${D20}T10:15:00`, mins: 105 }]),
  rawFlight("A-IX1581", "IX", "Air India Express", "1581", 4900, [{ from: "BLR", to: "BOM", dep: `${D20}T15:10:00`, arr: `${D20}T16:55:00`, mins: 105 }]),
  rawFlight("N-SG633", "SG", "SpiceJet", "633", 4500, [{ from: "BLR", to: "BOM", dep: `${D20}T23:20:00`, arr: `${D21}T01:20:00`, mins: 120 }]),
];

const BLR_DEL_D5 = [
  rawFlight("D-6E2001", "6E", "IndiGo", "2001", 6400, [{ from: "BLR", to: "DEL", dep: "2026-12-05T07:00:00", arr: "2026-12-05T09:45:00", mins: 165 }]),
];
const DEL_BOM_D5 = [
  rawFlight("DB-AI865", "AI", "Air India", "865", 5600, [{ from: "DEL", to: "BOM", dep: "2026-12-05T10:00:00", arr: "2026-12-05T12:10:00", mins: 130 }]),
];

/** TBO flight responses keyed `ORIGIN-DEST-YYYY-MM-DD`. */
export const FLIGHTS: Record<string, any[]> = {
  [`BLR-DXB-${D16}`]: BLR_DXB,
  [`BLR-BOM-${D20}`]: BLR_BOM,
  "BLR-DEL-2026-12-05": BLR_DEL_D5,
  "DEL-BOM-2026-12-05": DEL_BOM_D5,
};

const hotel = (code: string, name: string, total: number, nights: number, refundable: boolean) => ({
  HotelCode: code, HotelName: name, Address: "", CityName: "", HotelRating: "4", StarRating: 4,
  Latitude: null, Longitude: null,
  Rooms: [{ RoomTypeName: "Deluxe", _displayTotalFare: total, isRefundable: refundable }],
  rating: 4, perNightINR: Math.round(total / nights), totalINR: total, nights,
});

/** Live hotel rows keyed `City|checkIn|checkOut`. */
export const HOTELS: Record<string, any[]> = {
  "Dubai|2026-11-16|2026-11-19": [
    hotel("DXB1", "Asiana Grand", 21000, 3, true),
    hotel("DXB2", "Rove Downtown", 24600, 3, false),
  ],
};

/** Hotel-city catalogue stub (the real one is DB-backed). */
export const HOTEL_CITIES: Record<string, { cityName: string; countryCode: string; cityCode: string }> = {
  dubai: { cityName: "Dubai", countryCode: "AE", cityCode: "115936" },
  singapore: { cityName: "Singapore", countryCode: "SG", cityCode: "138673" },
  goa: { cityName: "Goa", countryCode: "IN", cityCode: "120806" },
  mumbai: { cityName: "Mumbai", countryCode: "IN", cityCode: "144306" },
};

/** The IP-based origin suggestion every scenario sees (QC ran from Bengaluru). */
export const HERE = { city: { cityName: "Bengaluru", countryCode: "IN", cityCode: "111124" }, iata: "BLR", nearestTo: null };
export const HERE_CHIP = "Flying from Bengaluru? (based on your current location)";

/* ───────────────────────── reply helpers ───────────────────────── */

const rows = (r: any): any[] => r?.flightSearch?.flights || [];
const depMin = (f: any) => {
  const [h, m] = String(f?.departure?.time || "").split(":").map(Number);
  return h * 60 + m;
};
const fareOf = (f: any) => Number(f?.fare?.offered ?? f?.fare?.published);

/* ───────────────────────── the fixtures ───────────────────────── */

export const GOLDEN: Golden[] = [
  /* ── A · Dubai leisure ── */
  {
    name: "A1–A2 · next week to Dubai → origin ask → tapped location chip searches",
    modes: { off: "active", on: "active" },
    turns: [
      {
        user: "Flights to Dubai next week",
        expect: {
          branch: "flight_route",
          aiCalled: false,
          flightCalls: 0,
          reply: (r) => {
            expect(r.title).toBe("Where are you flying from?");
            expect(r.context).toMatch(/I read "next week" as/);
            expect(r.nextSteps).toContain(HERE_CHIP);
          },
        },
        expectOn: {
          stored: (s) => {
            expect(s.pending).toMatchObject({ kind: "flight", need: "origin", notesShown: ["rel_date"] });
            expect(s.v).toBe(2);
            expect(s.rev).toBe(1);
          },
        },
      },
      {
        user: HERE_CHIP,
        expect: {
          branch: "answer_pending",
          aiCalled: false,
          flightCalls: 1,
          lastFlightArgs: { origin: "BLR", destination: "DXB", departDate: D16 },
          reply: (r) => {
            expect(r.title).toMatch(/Flights: Bengaluru → Dubai/);
            expect(rows(r).length).toBe(6);
          },
        },
        expectOn: {
          stored: (s) => {
            expect(s.lastSearch.active).toBe("flight");
            expect(s.lastSearch.flight).toMatchObject({ origin: "BLR", destination: "DXB", date: D16, traceId: "T-BLR-DXB" });
            expect(s.lastSearch.flight.rows.flights).toHaveLength(6);
            expect(s.locked.destination.name).toBe("Dubai");
          },
        },
      },
    ],
  },
  {
    name: "A2-note · the 'next week' note is said once, not again on the answered turn (F-18)",
    modes: { off: "todo", on: "active" },
    turns: [
      { user: "Flights to Dubai next week" },
      {
        user: HERE_CHIP,
        expect: { flightCalls: 1, reply: (r) => expect(r.context).not.toMatch(/I read "next week"/) },
      },
    ],
  },
  {
    name: "A3–A5 · only non-stop → cheaper? → leave flights for now (F-05, F-06)",
    modes: { off: "todo", on: "active" },
    turns: [
      { user: "Flights to Dubai next week" },
      { user: HERE_CHIP, expect: { flightCalls: 1 } },
      {
        user: "only non-stop",
        expect: {
          branch: "refine_flight",
          aiCalled: false,
          flightCalls: 0,
          reply: (r) => {
            expect(rows(r).length).toBe(4);
            expect(rows(r).every((f: any) => f.stops === 0)).toBe(true);
            expect(r.context).toMatch(/Non-stop: 4 of 6 flights/);
            expect(r.context).not.toMatch(/4 to 5 hours/);
            expect(r.flightSearch.traceId).toBe("T-BLR-DXB");
            expect(r.flightSearch.activeFilters).toEqual(["non-stop"]);
            expect(r.nextSteps).toContain("Clear filters");
          },
          stored: (s) => expect(s.lastSearch.flight.filters).toEqual({ maxStops: 0 }),
        },
      },
      {
        user: "cheaper option?",
        expect: {
          branch: "refine_flight",
          aiCalled: false,
          flightCalls: 0,
          reply: (r) => {
            const f = rows(r);
            expect(f.length).toBe(4);
            expect(f.every((x: any) => x.stops === 0)).toBe(true);
            expect(f.map(fareOf)).toEqual([...f.map(fareOf)].sort((a, b) => a - b));
            // names the cheapest non-stop AND the cheapest overall (1 stop)
            expect(r.context).toMatch(/Cheapest match ₹18,420/);
            expect(r.context).toMatch(/Without the filters, the cheapest is ₹11,576/);
            expect(r.context).not.toMatch(/holiday|months in advance/i);
          },
          stored: (s) => expect(s.lastSearch.flight.filters).toEqual({ maxStops: 0, sort: "price" }),
        },
      },
      {
        user: "ok leave flights for now",
        expect: {
          branch: "park",
          aiCalled: false,
          flightCalls: 0,
          hotelCalls: 0,
          reply: (r) => {
            expect(r.title).toBe("Flights on hold");
            expect(r.flightSearch).toBeUndefined();
            expect(r.context).toMatch(/Your Dubai trip \(from Bengaluru, 16 Nov\) is kept/);
            expect(r.nextSteps).toEqual(["Hotels in Dubai", "Things to do in Dubai", "Back to flights"]);
          },
          stored: (s) => {
            expect(typeof s.parked.flight).toBe("number");
            expect(s.locked.destination.name).toBe("Dubai");
            expect(s.lastSearch.flight.filters).toEqual({ maxStops: 0, sort: "price" });
            expect(s.pending).toBeUndefined();
          },
        },
      },
      {
        user: "Back to flights",
        expect: {
          branch: "resume_flight",
          flightCalls: 0,
          reply: (r) => expect(rows(r).length).toBe(4),
          stored: (s) => expect(s.parked.flight).toBeUndefined(),
        },
      },
    ],
  },
  {
    name: "A · 'ok leave flight right now' (the user's own phrasing) parks too",
    modes: { off: "todo", on: "active" },
    turns: [
      { user: "find flights from Bengaluru to Dubai on 16 Nov", expect: { flightCalls: 1 } },
      { user: "ok leave flight right now", expect: { branch: "park", flightCalls: 0, aiCalled: false } },
    ],
  },
  { name: "A6 · famous attractions in dubai → no itinerary unless asked", modes: { off: "todo", on: "todo" }, note: "S3 (PLAN_READINESS gate)", turns: [] },
  { name: "A7 · hotels near Burj Khalifa for 3 nights → 16→19 Nov, no dates-ask", modes: { off: "todo", on: "todo" }, note: "S2 (nights)", turns: [] },
  { name: "A7′–A8′ · hotel dates-ask → '16 to 19 nov, same as the flight' searches", modes: { off: "todo", on: "todo" }, note: "S2 (hotel pending)", turns: [] },
  { name: "A13 · plan 3 days → itinerary allowed, Burj Khalifa base passed", modes: { off: "todo", on: "todo" }, note: "S3", turns: [] },

  /* ── B · Mumbai business ── */
  { name: "B1–B2 · need to be in Mumbai on 20 Nov → origin ask → 'from bengaluru, morning only'", modes: { off: "todo", on: "todo" }, note: "S4 (arrive-by) / S2", turns: [] },
  {
    name: "B3 · 'bengaluru to mumbai on 20 nov, morning flights only' is a route ask (F-11)",
    modes: { off: "todo", on: "active" },
    turns: [
      {
        user: "bengaluru to mumbai on 20 nov, morning flights only",
        expect: {
          branch: "flight_route",
          aiCalled: false,
          flightCalls: 1,
          lastFlightArgs: { origin: "BLR", destination: "BOM", departDate: D20 },
          reply: (r) => {
            expect(r.title).not.toMatch(/Where are you flying from/);
            const f = rows(r);
            expect(f.length).toBe(2);
            expect(f.every((x: any) => depMin(x) >= 5 * 60 && depMin(x) < 12 * 60)).toBe(true);
            expect(r.context).toMatch(/Filtered to morning departures \(05:00–11:59\): 2 of 4/);
          },
          stored: (s) => {
            expect(s.lastSearch.flight.filters).toEqual({ departWindow: "morning" });
            expect(s.lastSearch.flight.rows.flights).toHaveLength(4);
          },
        },
      },
    ],
  },
  {
    name: "B3 · 'BLR-DEL 5 Dec' is a route ask",
    modes: { off: "todo", on: "active" },
    turns: [{
      user: "BLR-DEL 5 Dec",
      expect: { branch: "flight_route", flightCalls: 1, lastFlightArgs: { origin: "BLR", destination: "DEL", departDate: "2026-12-05" } },
    }],
  },
  {
    name: "B3 · 'bengaluru to goa trip ideas' is NOT a route ask",
    modes: { off: "active", on: "active" },
    turns: [{ user: "bengaluru to goa trip ideas", expect: { branch: "ai", aiCalled: true, flightCalls: 0 } }],
  },
  { name: "B5 · hotel near BKC → check-in 20 Nov known, asks check-out", modes: { off: "todo", on: "todo" }, note: "S2", turns: [] },
  { name: "B8–B9 · change to 21 Nov → re-search; round trip back on 22nd → JourneyType 2", modes: { off: "todo", on: "todo" }, note: "S2", turns: [] },

  /* ── C · Goa weekend ── */
  { name: "C1–C3 · plan a goa weekend → hotels 12–14 dec (adults 2) → how to get around", modes: { off: "todo", on: "todo" }, note: "S2/S3", turns: [] },
  { name: "C2-guard · 'These hotel options…' with no cards is removed", modes: { off: "todo", on: "todo" }, note: "S3", turns: [] },

  /* ── E · Dubai → Singapore ── */
  {
    name: "E1 · hotels in dubai 16 to 19 nov → live hotel cards",
    modes: { off: "active", on: "active" },
    turns: [{
      user: "hotels in dubai 16 to 19 nov",
      expect: {
        branch: "hotel_search",
        aiCalled: false,
        hotelCalls: 1,
        reply: (r) => {
          expect(r.hotelSearch.hotels).toHaveLength(2);
          expect(r.context).toMatch(/3 nights/);
        },
      },
      expectOn: {
        stored: (s) => {
          expect(s.lastSearch.active).toBe("hotel");
          expect(s.lastSearch.hotel).toMatchObject({ city: "Dubai", checkIn: "2026-11-16", checkOut: "2026-11-19" });
          expect(s.locked.dates).toMatchObject({ start: "2026-11-16", end: "2026-11-19" });
        },
      },
    }],
  },
  { name: "E2–E3 · actually singapore instead, same dates → Singapore hotels; 'must see places there' never says Dubai", modes: { off: "todo", on: "todo" }, note: "S3", turns: [] },
  { name: "E3-guard · model titles 'Must-See Places in Dubai' → retried, rebuilt", modes: { off: "todo", on: "todo" }, note: "S3", turns: [] },

  /* ── F · date edits ── */
  { name: "F · change to 21 Nov / a day later / round trip back on the 2nd / one way / 2 of us, business class", modes: { off: "todo", on: "todo" }, note: "S2", turns: [] },

  /* ── P · negatives: these must NOT park or refine ── */
  {
    name: "P1 · 'flights for 2 adults from DEL to BOM on 5 Dec' is a search, not a park",
    modes: { off: "active", on: "active" },
    turns: [{
      user: "flights for 2 adults from DEL to BOM on 5 Dec",
      expect: { branch: "flight_route", flightCalls: 1, lastFlightArgs: { origin: "DEL", destination: "BOM", adults: 2 } },
    }],
  },
  {
    name: "P2 · 'not now' with nothing searched → a plain ack, no search",
    modes: { off: "todo", on: "active" },
    turns: [{
      user: "not now",
      expect: { branch: "park", aiCalled: false, flightCalls: 0, hotelCalls: 0, reply: (r) => expect(r.title).toBe("No problem") },
    }],
  },
  {
    name: "P3 · a new from→to route after results is a NEW search, not a refine",
    modes: { off: "active", on: "active" },
    turns: [
      { user: "find flights from Bengaluru to Dubai on 16 Nov", expect: { flightCalls: 1 } },
      {
        user: "show me non-stop flights from Bengaluru to Mumbai on 20 Nov",
        expect: { branch: "flight_route", flightCalls: 1, lastFlightArgs: { origin: "BLR", destination: "BOM", departDate: D20 } },
      },
    ],
  },
  {
    name: "P4 · 'cheaper hotels' after flight results never filters the flights",
    modes: { off: "active", on: "active" },
    turns: [
      { user: "find flights from Bengaluru to Dubai on 16 Nov", expect: { flightCalls: 1 } },
      { user: "cheaper hotels in Dubai?", expect: { flightCalls: 0, reply: (r) => expect(r.flightSearch).toBeUndefined() } },
    ],
  },

  /* ── R · the state drifts of design §0 ── */
  {
    name: "R1 · AI→hotel→AI: the second AI turn still knows the hotel dates (§0 drift 1)",
    // off: FAILS — proof of the drift. The AI turn saved a doc; the hotel lane
    // locked the dates into the client's copy only; the next AI turn loaded the
    // older doc and dropped the client's copy.
    modes: { off: "fails", on: "active" },
    turns: [
      { user: "Trip to Dubai, what should I pack?", ai: { title: "Packing", context: "Light layers." }, expect: { branch: "ai" } },
      { user: "hotels in dubai 16 to 19 nov", expect: { hotelCalls: 1 } },
      {
        user: "what should I pack?",
        ai: { title: "Packing", context: "Light layers." },
        expect: { branch: "ai", aiCalled: true, aiPrompt: (p) => expect(p).toMatch(/"end": "2026-11-19"/) },
      },
    ],
  },
  {
    name: "R2 · resume with only { id } (before rehydrate) still refines the stored search (§0 drift 2)",
    modes: { off: "todo", on: "active" },
    turns: [
      { user: "find flights from Bengaluru to Dubai on 16 Nov", expect: { flightCalls: 1 } },
      {
        user: "only non-stop",
        idOnly: true,
        expect: { branch: "refine_flight", flightCalls: 0, reply: (r) => expect(rows(r).every((f: any) => f.stops === 0)).toBe(true) },
      },
    ],
  },

  /* ── S · stale rows, filters ── */
  {
    name: "S1 · rows older than 12 min are never filtered: offer a fresh search, call nobody",
    modes: { off: "todo", on: "active" },
    turns: [
      { user: "find flights from Bengaluru to Dubai on 16 Nov", expect: { flightCalls: 1 } },
      {
        user: "only non-stop",
        advanceMs: 13 * 60 * 1000,
        expect: {
          branch: "refine_flight",
          flightCalls: 0,
          aiCalled: false,
          reply: (r) => {
            expect(r.flightSearch).toBeUndefined();
            expect(r.context).toMatch(/more than 12 minutes old/);
            expect(r.nextSteps[0]).toMatch(/^Search non-stop flights from Bengaluru to Dubai on 16 Nov$/);
          },
        },
      },
    ],
  },
  {
    name: "S2 · filters accumulate, show, and clear (design Q4)",
    modes: { off: "todo", on: "active" },
    turns: [
      { user: "find flights from Bengaluru to Dubai on 16 Nov", expect: { flightCalls: 1 } },
      { user: "only non-stop", expect: { reply: (r) => expect(rows(r)).toHaveLength(4) } },
      {
        user: "morning flights",
        expect: {
          reply: (r) => {
            expect(rows(r).map((f: any) => f.ResultIndex)).toEqual(["NS-6E1419", "NS-AI933"]);
            expect(r.flightSearch.activeFilters).toEqual(["non-stop", "morning departures (05:00–11:59)"]);
          },
        },
      },
      { user: "no Air India", expect: { reply: (r) => expect(rows(r).map((f: any) => f.ResultIndex)).toEqual(["NS-6E1419"]) } },
      { user: "only Emirates", expect: { reply: (r) => { expect(r.title).toMatch(/^No matches/); expect(r.flightSearch).toBeUndefined(); } } },
      {
        user: "Clear filters",
        expect: {
          branch: "refine_flight",
          reply: (r) => { expect(rows(r)).toHaveLength(6); expect(r.nextSteps).not.toContain("Clear filters"); },
          stored: (s) => expect(s.lastSearch.flight.filters).toEqual({}),
        },
      },
    ],
  },
  {
    name: "S3 · 'arrive by 10am' filters on ARRIVAL; the next-day red-eye never qualifies (design Q2)",
    modes: { off: "todo", on: "active" },
    turns: [
      { user: "find flights from Bengaluru to Mumbai on 20 Nov", expect: { flightCalls: 1 } },
      {
        user: "I need to arrive by 10am",
        expect: { branch: "refine_flight", reply: (r) => expect(rows(r).map((f: any) => f.ResultIndex)).toEqual(["M-6E5301"]) },
      },
    ],
  },
];
