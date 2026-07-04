// Integration test for the concierge chat flight-search wiring: mounts the real
// router with the TBO service + metrics sink mocked and stub auth/workspace, and
// asserts the distinct reply states + the multi-city loud downgrade.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  // The OpenAI client constructs at import time; a dummy key lets us import the
  // router without a real key. The AI is never invoked on these flight paths.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
});

const { searchFlightsMock } = vi.hoisted(() => ({ searchFlightsMock: vi.fn() }));
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: searchFlightsMock }));

const { emitMetricMock } = vi.hoisted(() => ({ emitMetricMock: vi.fn() }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: emitMetricMock }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { _id: "u1", email: "t@plumtrips.com" };
  req.workspaceObjectId = "656565656565656565656565";
  req.workspaceId = "656565656565656565656565";
  next();
});
app.use("/", router);

function rawFlight(over: Record<string, any> = {}) {
  return {
    ResultIndex: "OB1", IsLCC: true, IsRefundable: true,
    Fare: { PublishedFare: 5000, OfferedFare: 4800, Currency: "INR" },
    Segments: [[{
      CabinClass: 2, Duration: 130,
      Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "2582" },
      Origin: { DepTime: "2026-05-20T07:20:00", Airport: { AirportCode: "DEL", CityName: "Delhi" } },
      Destination: { ArrTime: "2026-05-20T09:30:00", Airport: { AirportCode: "BOM", CityName: "Mumbai" } },
    }]],
    ...over,
  };
}

const chat = (prompt: string) => request(app).post("/").send({ prompt }).then(r => r.body);

beforeEach(() => {
  searchFlightsMock.mockReset();
  emitMetricMock.mockReset();
});

describe("concierge chat — Phase 1 reply states", () => {
  it("TBO throws → distinct 'temporarily unavailable' reply + pluto.search.error", async () => {
    searchFlightsMock.mockImplementation(async () => { throw new Error("TBO down"); });
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(body.reply.flightSearch.source).toBe("unavailable");
    expect(body.reply.context).toMatch(/temporarily unavailable/i);
    const types = emitMetricMock.mock.calls.map(c => c[0]?.type);
    expect(types).toContain("pluto.search.error");
  });

  it("TBO ok but empty → genuine zero-results reply, distinct from unavailable", async () => {
    searchFlightsMock.mockResolvedValue({ Response: { TraceId: "Z", ResponseStatus: 1, Results: [[]] } });
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(body.reply.flightSearch.source).toBe("none");
    expect(body.reply.context).toMatch(/couldn't find any live flights/i);
    expect(body.reply.context).not.toMatch(/temporarily unavailable/i);
  });

  it("round-trip → JourneyType 2 request + inbound leg in the reply", async () => {
    const inbound = rawFlight({
      ResultIndex: "IB1",
      Segments: [[{
        CabinClass: 2, Duration: 130,
        Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "2999" },
        Origin: { DepTime: "2026-05-27T18:00:00", Airport: { AirportCode: "BOM", CityName: "Mumbai" } },
        Destination: { ArrTime: "2026-05-27T20:10:00", Airport: { AirportCode: "DEL", CityName: "Delhi" } },
      }]],
    });
    searchFlightsMock.mockResolvedValue({ Response: { TraceId: "RT", ResponseStatus: 1, Results: [[rawFlight()], [inbound]] } });
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026 returning 27 May 2026");
    expect(searchFlightsMock).toHaveBeenCalledWith(
      expect.objectContaining({ JourneyType: 2, returnDate: "2026-05-27" }),
    );
    expect(body.reply.flightSearch.journeyType).toBe(2);
    expect(body.reply.flightSearch.inbound).toHaveLength(1);
    expect(body.reply.flightSearch.inbound[0].flightNo).toBe("6E-2999");
  });

  it("multi-city (3 cities) → loud downgrade + pluto.multicity.downgraded, NOT the clarify reply", async () => {
    searchFlightsMock.mockResolvedValue({ Response: { TraceId: "M", ResponseStatus: 1, Results: [[rawFlight()]] } });
    const body = await chat("find flights from Delhi to Mumbai to Goa on 20 May 2026");
    expect(body.reply.title).toMatch(/multi-city isn't supported/i);
    expect(body.reply.title).not.toMatch(/which airport/i);
    const types = emitMetricMock.mock.calls.map(c => c[0]?.type);
    expect(types).toContain("pluto.multicity.downgraded");
    // Loud downgrade must NOT run a search with a mis-parsed "Mumbai to Goa".
    expect(searchFlightsMock).not.toHaveBeenCalled();
  });
});
