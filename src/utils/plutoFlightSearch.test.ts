import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the TBO service so no token/network is required. The factory is hoisted
// by vitest, so it must not reference outer variables.
vi.mock("../services/tbo.flight.service.js", () => ({
  searchFlights: vi.fn(),
}));

import { searchFlights as tboSearchFlights } from "../services/tbo.flight.service.js";
import { searchFlightsForChat } from "./plutoFlightSearch.js";

const mockedSearch = tboSearchFlights as unknown as ReturnType<typeof vi.fn>;

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

  it("margin is NOT applied on the chat path — fare mirrors raw TBO OfferedFare", async () => {
    mockedSearch.mockResolvedValue({
      Response: { TraceId: "T1", ResponseStatus: 1, Results: [[rawFlight()]] },
    });

    const result = await searchFlightsForChat(baseParams);
    expect(result.ok).toBe(true);
    expect(result.flights[0].fare.offered).toBe(4800);
    expect(result.flights[0].fare.published).toBe(5000);
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
