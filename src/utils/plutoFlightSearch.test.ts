import { describe, it, expect, vi, beforeEach } from "vitest";

// Run under a non-UTC timezone (Amendment W): proves the date derives from the
// raw TBO string, not new Date().toISOString() (which would roll the calendar
// date under IST). Set before the module loads.
vi.hoisted(() => { process.env.TZ = "Asia/Kolkata"; });

// Mock the TBO service so no token/network is required. The factory is hoisted
// by vitest, so it must not reference outer variables.
vi.mock("../services/tbo.flight.service.js", () => ({
  searchFlights: vi.fn(),
}));
// Fare logging is fire-and-forget; captured here so a test can see WHICH rows
// were logged (Hotfix A: matching-airport rows only).
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: vi.fn() }));

import { searchFlights as tboSearchFlights } from "../services/tbo.flight.service.js";
import { recordFareObservations } from "../services/fareObservations.js";
import { searchFlightsForChat, mapTBOFlight, tboElapsedMinutes } from "./plutoFlightSearch.js";

const mockedSearch = tboSearchFlights as unknown as ReturnType<typeof vi.fn>;
const mockedRecord = recordFareObservations as unknown as ReturnType<typeof vi.fn>;

// One realistic raw TBO outbound result. mapTBOFlight reads Segments[0].
function rawFlight(overrides: Record<string, any> = {}) {
  return {
    ResultIndex: "OB1",
    IsLCC: true,
    IsRefundable: true,
    Fare: { PublishedFare: 5000, OfferedFare: 4800, Currency: "INR" },
    Segments: [
      [
        {
          CabinClass: 2,
          Duration: 130,
          Baggage: "15 KG",
          Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "2582" },
          Origin: {
            DepTime: "2026-05-20T07:20:00",
            Airport: { AirportCode: "DEL", CityName: "Delhi", Terminal: "3" },
          },
          Destination: {
            ArrTime: "2026-05-20T09:30:00",
            Airport: { AirportCode: "BOM", CityName: "Mumbai", Terminal: "2" },
          },
        },
      ],
    ],
    ...overrides,
  };
}

const baseParams = {
  origin: "DEL",
  destination: "BOM",
  departDate: "2026-05-20",
  requestId: "test-req",
};

beforeEach(() => {
  mockedSearch.mockReset();
  mockedRecord.mockReset();
});

describe("searchFlightsForChat — discriminated result", () => {
  it("happy path: status 1 with results → ok:true and mapped flights", async () => {
    mockedSearch.mockResolvedValue({
      Response: { TraceId: "T1", ResponseStatus: 1, Results: [[rawFlight()]] },
    });

    const result = await searchFlightsForChat(baseParams);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.flights).toHaveLength(1);
    expect(result.flights[0].flightNo).toBe("6E-2582");
    expect(result.traceId).toBe("T1");
    // One-way: no inbound leg searched.
    expect(result.inbound).toEqual([]);
  });

  it("chat fares are selling prices — TBO's net OfferedFare is never shown", async () => {
    mockedSearch.mockResolvedValue({
      Response: { TraceId: "T1", ResponseStatus: 1, Results: [[rawFlight()]] },
    });

    const result = await searchFlightsForChat(baseParams);
    expect(result.ok).toBe(true);
    expect(result.flights[0].fare.published).toBe(5000);
    expect(result.flights[0].fare.offered).toBe(5000);

    const margined = await searchFlightsForChat({ ...baseParams, margins: 10 });
    expect(margined.flights[0].fare.published).toBe(5500);
    expect(margined.flights[0].fare.offered).toBe(5500);
  });

  it("TBO non-success ResponseStatus → ok:false reason TBO_ERROR (not empty results)", async () => {
    mockedSearch.mockResolvedValue({
      Response: {
        TraceId: "T2",
        ResponseStatus: 3,
        Error: { ErrorCode: 5, ErrorMessage: "No results" },
        Results: [],
      },
    });

    const result = await searchFlightsForChat(baseParams);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("TBO_ERROR");
    expect(result.flights).toEqual([]);
  });

  it("thrown exception (transport/timeout) → ok:false reason SEARCH_EXCEPTION", async () => {
    mockedSearch.mockRejectedValue(new Error("socket hang up"));

    const result = await searchFlightsForChat(baseParams);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("SEARCH_EXCEPTION");
  });

  it("genuine zero results: status 1, empty Results → ok:true with empty flights (NOT unavailable)", async () => {
    mockedSearch.mockResolvedValue({
      Response: { TraceId: "T3", ResponseStatus: 1, Results: [[]] },
    });

    const result = await searchFlightsForChat(baseParams);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.flights).toEqual([]);
  });

  it("round-trip (journeyType:2): sends JourneyType 2 + returnDate and maps the inbound leg", async () => {
    // Results[0] = outbound options, Results[1] = inbound options.
    const inboundLeg = rawFlight({
      ResultIndex: "IB1",
      Segments: [
        [
          {
            CabinClass: 2,
            Duration: 130,
            Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "2999" },
            Origin: {
              DepTime: "2026-05-27T18:00:00",
              Airport: { AirportCode: "BOM", CityName: "Mumbai", Terminal: "2" },
            },
            Destination: {
              ArrTime: "2026-05-27T20:10:00",
              Airport: { AirportCode: "DEL", CityName: "Delhi", Terminal: "3" },
            },
          },
        ],
      ],
    });
    mockedSearch.mockResolvedValue({
      Response: { TraceId: "RT", ResponseStatus: 1, Results: [[rawFlight()], [inboundLeg]] },
    });

    const result = await searchFlightsForChat({
      ...baseParams,
      returnDate: "2026-05-27",
      journeyType: 2,
    });

    // Request shape: JourneyType 2 with the returnDate threaded through.
    expect(mockedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ JourneyType: 2, returnDate: "2026-05-27" }),
    );

    expect(result.ok).toBe(true);
    expect(result.flights).toHaveLength(1);
    expect(result.flights[0].flightNo).toBe("6E-2582");
    expect(result.inbound).toHaveLength(1);
    expect(result.inbound[0].flightNo).toBe("6E-2999");
  });
});

describe("searchFlightsForChat — policy annotation", () => {
  const lcc = rawFlight({
    ResultIndex: "A", IsLCC: true,
    Fare: { PublishedFare: 4000, OfferedFare: 4000, Currency: "INR" },
    Segments: [[{
      CabinClass: 2, Duration: 130,
      Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "1000" },
      Origin: { DepTime: "2026-05-20T06:00:00", Airport: { AirportCode: "DEL" } },
      Destination: { ArrTime: "2026-05-20T08:10:00", Airport: { AirportCode: "BOM" } },
    }]],
  });
  const fullService = rawFlight({
    ResultIndex: "B", IsLCC: false,
    Fare: { PublishedFare: 8000, OfferedFare: 8000, Currency: "INR" },
    Segments: [[{
      CabinClass: 2, Duration: 130,
      Airline: { AirlineCode: "AI", AirlineName: "Air India", FlightNumber: "500" },
      Origin: { DepTime: "2026-05-20T09:00:00", Airport: { AirportCode: "DEL" } },
      Destination: { ArrTime: "2026-05-20T11:10:00", Airport: { AirportCode: "BOM" } },
    }]],
  });

  it("annotates every flight with a policy field", async () => {
    mockedSearch.mockResolvedValue({ Response: { TraceId: "P", ResponseStatus: 1, Results: [[lcc]] } });
    const result = await searchFlightsForChat({ ...baseParams, policyRules: { active: true, allowLCC: false } });
    expect(result.ok).toBe(true);
    expect(result.flights[0].policy).toEqual({ status: "OUT_OF_POLICY", reasons: ["lcc_not_allowed"] });
  });

  it("sorts in-policy first even when the out-of-policy flight is cheaper", async () => {
    // allowLCC:false → cheap LCC is out-of-policy; pricier full-service is in-policy.
    mockedSearch.mockResolvedValue({ Response: { TraceId: "P", ResponseStatus: 1, Results: [[lcc, fullService]] } });
    const result = await searchFlightsForChat({ ...baseParams, policyRules: { active: true, allowLCC: false } });
    expect(result.flights.map((f: any) => f.flightNo)).toEqual(["AI-500", "6E-1000"]);
    expect(result.flights[0].policy.status).toBe("IN_POLICY");
    expect(result.flights[1].policy.status).toBe("OUT_OF_POLICY");
  });

  it("additive-only: the chat path adds ONLY `policy` and the airport annotation", async () => {
    mockedSearch.mockResolvedValue({ Response: { TraceId: "P", ResponseStatus: 1, Results: [[lcc]] } });
    const result = await searchFlightsForChat({ ...baseParams, policyRules: null });
    const annotated = { ...result.flights[0] };
    expect(annotated.policy).toEqual({ status: "IN_POLICY", reasons: ["no_policy_configured"] });
    // DEL→BOM served exactly: MATCH, and no label (it IS the requested airport).
    expect(annotated.airportMatch).toBe("MATCH");
    expect(annotated.arrivalAirportLabel).toBeUndefined();
    delete annotated.policy;
    delete annotated.airportMatch;
    // Everything except `policy` matches the bare mapper output for the same raw row.
    const bare = mapTBOFlight(lcc, { traceId: "P", originIATA: "DEL", destIATA: "BOM", cabinLabel: "Economy" });
    expect(annotated).toEqual(bare);
  });
});

describe("mapTBOFlight — dates derive from the raw TBO string, never UTC (Amendment W)", () => {
  const opts = { traceId: "T", originIATA: "DEL", destIATA: "NRT", cabinLabel: "Economy" };
  const withTimes = (dep: string, arr: string) => ({
    ResultIndex: "OB1",
    IsLCC: false,
    IsRefundable: true,
    Fare: { PublishedFare: 5000, OfferedFare: 4800, Currency: "INR" },
    Segments: [[{
      CabinClass: 2, Duration: 360,
      Airline: { AirlineCode: "AI", AirlineName: "Air India", FlightNumber: "301" },
      Origin: { DepTime: dep, Airport: { AirportCode: "DEL", CityName: "Delhi", Terminal: "3" } },
      Destination: { ArrTime: arr, Airport: { AirportCode: "NRT", CityName: "Tokyo", Terminal: "1" } },
    }]],
  });

  it("early-morning departure keeps its calendar date (would roll back to the 19th via toISOString under IST)", () => {
    const f = mapTBOFlight(withTimes("2026-09-20T03:30:00", "2026-09-20T13:30:00"), opts)!;
    expect(f.departure.date).toBe("2026-09-20");
    expect(f.departure.time).toBe("03:30:00");
    expect(f.arrival.date).toBe("2026-09-20");
  });

  it("late-evening departure keeps its date (no forward roll)", () => {
    const f = mapTBOFlight(withTimes("2026-09-20T21:15:00", "2026-09-21T12:45:00"), opts)!;
    expect(f.departure.date).toBe("2026-09-20");
    expect(f.departure.time).toBe("21:15:00");
    expect(f.arrival.date).toBe("2026-09-21"); // next-day arrival preserved from the raw string
  });
});

/* ───────────── Pluto Hotfix A — F-02 wrong airport, F-04 durations ───────────── */

// One raw row: dep → arr (optionally via a connection), with TBO durations.
function leg(o: {
  idx: string; dep: string; arr: string; fare: number; depTime: string; arrTime: string;
  duration: number; via?: string; ground?: number; accumulated?: number; airline?: string;
}) {
  const airline = { AirlineCode: o.airline || "EK", AirlineName: o.airline || "Emirates", FlightNumber: o.idx };
  const segs = o.via
    ? [
        { CabinClass: 2, Duration: Math.floor(o.duration / 2), Airline: airline,
          Origin: { DepTime: o.depTime, Airport: { AirportCode: o.dep } },
          Destination: { ArrTime: o.depTime, Airport: { AirportCode: o.via } } },
        { CabinClass: 2, Duration: o.duration - Math.floor(o.duration / 2), GroundTime: o.ground ?? 0,
          AccumulatedDuration: o.accumulated, Airline: airline,
          Origin: { DepTime: o.depTime, Airport: { AirportCode: o.via } },
          Destination: { ArrTime: o.arrTime, Airport: { AirportCode: o.arr } } },
      ]
    : [{ CabinClass: 2, Duration: o.duration, Airline: airline,
        Origin: { DepTime: o.depTime, Airport: { AirportCode: o.dep } },
        Destination: { ArrTime: o.arrTime, Airport: { AirportCode: o.arr } } }];
  return { ResultIndex: o.idx, IsLCC: false, IsRefundable: true, Fare: { PublishedFare: o.fare, OfferedFare: o.fare, Currency: "INR" }, Segments: [segs] };
}

const dxbParams = { origin: "BLR", destination: "DXB", departDate: "2026-11-16", requestId: "qc" };

describe("Hotfix A F-02 — only rows into the requested city are the answer", () => {
  // The QC shape: the cheapest and the fastest rows both land in Abu Dhabi.
  const auhCheap = leg({ idx: "AUH1", dep: "BLR", arr: "AUH", fare: 14000, depTime: "2026-11-16T20:55:00", arrTime: "2026-11-16T23:45:00", duration: 260 });
  const auhFast = leg({ idx: "AUH2", dep: "BLR", arr: "AUH", fare: 15000, depTime: "2026-11-16T09:00:00", arrTime: "2026-11-16T11:20:00", duration: 230 });
  const dxb = leg({ idx: "DXB1", dep: "BLR", arr: "DXB", fare: 18000, depTime: "2026-11-16T10:00:00", arrTime: "2026-11-16T12:35:00", duration: 245 });
  const dwc = leg({ idx: "DWC1", dep: "BLR", arr: "DWC", fare: 19000, depTime: "2026-11-16T04:00:00", arrTime: "2026-11-16T06:40:00", duration: 250 });

  it("DXB search: AUH rows leave `flights` and come back in otherAirportFlights, labelled", async () => {
    mockedSearch.mockResolvedValue({ Response: { TraceId: "T", ResponseStatus: 1, Results: [[auhCheap, auhFast, dxb, dwc]] } });
    const r = await searchFlightsForChat(dxbParams);
    expect(r.ok).toBe(true);
    expect(r.flights.map((f: any) => f.destination.code).sort()).toEqual(["DWC", "DXB"]);
    expect(r.otherAirportFlights.map((f: any) => f.ResultIndex).sort()).toEqual(["AUH1", "AUH2"]);
    for (const f of r.otherAirportFlights) {
      expect(f.airportMatch).toBe("OTHER");
      expect(f.arrivalAirportLabel).toBe("Abu Dhabi Int'l (AUH)");
    }
    // DWC is Dubai per the catalog — eligible, but its card says which Dubai airport.
    const dwcRow = r.flights.find((f: any) => f.destination.code === "DWC");
    expect(dwcRow.airportMatch).toBe("MATCH");
    expect(dwcRow.arrivalAirportLabel).toBe("Al Maktoum (DWC)");
  });

  it("fare observations are written from MATCH rows only", async () => {
    mockedSearch.mockResolvedValue({ Response: { TraceId: "T", ResponseStatus: 1, Results: [[auhCheap, auhFast, dxb, dwc]] } });
    await searchFlightsForChat(dxbParams);
    expect(mockedRecord).toHaveBeenCalledTimes(1);
    const logged = mockedRecord.mock.calls[0][0].rawRows.map((r: any) => r.ResultIndex).sort();
    expect(logged).toEqual(["DWC1", "DXB1"]);
  });

  it("all-OTHER: zero eligible rows, every row in the other group, nothing logged as a DXB fare", async () => {
    mockedSearch.mockResolvedValue({ Response: { TraceId: "T", ResponseStatus: 1, Results: [[auhCheap, auhFast]] } });
    const r = await searchFlightsForChat(dxbParams);
    expect(r.ok).toBe(true);
    expect(r.flights).toEqual([]);
    expect(r.otherAirportFlights).toHaveLength(2);
    expect(mockedRecord.mock.calls[0][0].rawRows).toEqual([]);
  });

  it("return leg is split on ITS direction (DXB → BLR): an AUH departure is OTHER", async () => {
    const backDxb = leg({ idx: "R-DXB", dep: "DXB", arr: "BLR", fare: 17000, depTime: "2026-11-19T22:00:00", arrTime: "2026-11-20T03:10:00", duration: 280 });
    const backAuh = leg({ idx: "R-AUH", dep: "AUH", arr: "BLR", fare: 12000, depTime: "2026-11-19T21:00:00", arrTime: "2026-11-20T02:30:00", duration: 300 });
    mockedSearch.mockResolvedValue({ Response: { TraceId: "T", ResponseStatus: 1, Results: [[dxb], [backAuh, backDxb]] } });
    const r = await searchFlightsForChat({ ...dxbParams, journeyType: 2, returnDate: "2026-11-19" });
    expect(r.inbound.map((f: any) => f.ResultIndex)).toEqual(["R-DXB"]);
    expect(r.inboundOtherAirport.map((f: any) => f.ResultIndex)).toEqual(["R-AUH"]);
    expect(r.inboundOtherAirport[0].departureAirportLabel).toBe("Abu Dhabi Int'l (AUH)");
  });

  it("Mumbai: an NMI arrival is never a BOM answer, and is labelled Navi Mumbai (NMI)", async () => {
    const bom = leg({ idx: "BOM1", dep: "BLR", arr: "BOM", fare: 6000, depTime: "2026-11-20T06:00:00", arrTime: "2026-11-20T07:45:00", duration: 105, airline: "6E" });
    const nmi = leg({ idx: "NMI1", dep: "BLR", arr: "NMI", fare: 4500, depTime: "2026-11-20T05:00:00", arrTime: "2026-11-20T06:30:00", duration: 90, airline: "6E" });
    mockedSearch.mockResolvedValue({ Response: { TraceId: "T", ResponseStatus: 1, Results: [[nmi, bom]] } });
    const r = await searchFlightsForChat({ origin: "BLR", destination: "BOM", departDate: "2026-11-20" });
    expect(r.flights.map((f: any) => f.ResultIndex)).toEqual(["BOM1"]);
    expect(r.otherAirportFlights.map((f: any) => f.ResultIndex)).toEqual(["NMI1"]);
    expect(r.otherAirportFlights[0].arrivalAirportLabel).toBe("Navi Mumbai (NMI)");
  });
});

describe("Hotfix A F-04 — one time-zone-correct duration, layovers included", () => {
  it("BLR 20:55 → AUH 23:45 local is 4h 20m (TBO Duration 260), not the 2h 50m clock subtraction gives", () => {
    const f = mapTBOFlight(
      leg({ idx: "X", dep: "BLR", arr: "AUH", fare: 1, depTime: "2026-11-16T20:55:00", arrTime: "2026-11-16T23:45:00", duration: 260 }),
      { traceId: "T", originIATA: "BLR", destIATA: "AUH", cabinLabel: "Economy" },
    )!;
    expect(f.durationMin).toBe(260);
    expect(f.duration).toBe("4h 20m");
  });

  it("one-stop: segment durations PLUS the layover (GroundTime)", () => {
    expect(tboElapsedMinutes([{ Duration: 120 }, { Duration: 150, GroundTime: 95 }])).toBe(365);
  });

  it("one-stop: TBO's AccumulatedDuration on the last segment wins when present", () => {
    expect(tboElapsedMinutes([{ Duration: 120 }, { Duration: 150, GroundTime: 95, AccumulatedDuration: 370 }])).toBe(370);
  });

  it("a mapped one-stop row carries the layover-inclusive total", () => {
    const f = mapTBOFlight(
      leg({ idx: "Y", dep: "BLR", arr: "DXB", via: "BOM", fare: 1, depTime: "2026-11-16T06:00:00", arrTime: "2026-11-16T12:00:00", duration: 300, ground: 90 }),
      { traceId: "T", originIATA: "BLR", destIATA: "DXB", cabinLabel: "Economy" },
    )!;
    expect(f.durationMin).toBe(390);
    expect(f.duration).toBe("6h 30m");
    expect(f.stops).toBe(1);
  });
});
