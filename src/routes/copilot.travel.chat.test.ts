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

// Policy loader mocked so no Mongo is needed; defaults to no policy.
const { policyRulesMock } = vi.hoisted(() => ({ policyRulesMock: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: policyRulesMock }));

// Route-insights read is AWAITED in the handler → mock the provider (no Mongo).
const { routeInsightsMock } = vi.hoisted(() => ({ routeInsightsMock: vi.fn() }));
vi.mock("../services/routeIntel.provider.js", () => ({
  getRouteIntelProvider: () => ({ name: "mock", getRouteInsights: routeInsightsMock }),
}));
// Fare logging is fire-and-forget; stub to a no-op so no Mongo buffering occurs.
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));

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

const INSUFFICIENT = { typicalFareRange: null, cheapestAirlineRecent: null, observationCount: 3, dataWindowDays: 90, sufficient: false };

beforeEach(() => {
  searchFlightsMock.mockReset();
  emitMetricMock.mockReset();
  policyRulesMock.mockReset();
  policyRulesMock.mockResolvedValue(null); // default: no policy
  routeInsightsMock.mockReset();
  routeInsightsMock.mockResolvedValue(INSUFFICIENT); // default: thin data
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

describe("concierge chat — Phase 2 policy annotation", () => {
  it("zero in-policy → 'clear why' cap message + pluto.policy.evaluated metric", async () => {
    // Strict cap makes the ₹4,800 flight out-of-policy → 0 in policy.
    policyRulesMock.mockResolvedValue({ active: true, maxFlightPriceINR: 1000 });
    searchFlightsMock.mockResolvedValue({ Response: { TraceId: "P", ResponseStatus: 1, Results: [[rawFlight()]] } });

    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026");

    // Results are annotated + still shown (never filtered).
    expect(body.reply.flightSearch.flights).toHaveLength(1);
    expect(body.reply.flightSearch.flights[0].policy.status).toBe("OUT_OF_POLICY");
    // Plain-language "why" naming the cap.
    expect(body.reply.context).toMatch(/exceed your company's ₹1,000 flight cap/i);

    const policyEvents = emitMetricMock.mock.calls.map(c => c[0]).filter(e => e?.type === "pluto.policy.evaluated");
    expect(policyEvents).toHaveLength(1);
    expect(policyEvents[0].metadata).toEqual({ inPolicyCount: 0, totalCount: 1 });
  });
});

describe("concierge chat — Phase 3 route insights", () => {
  it("thin data → routeInsights attached (sufficient:false), no fare sentence, metric served", async () => {
    searchFlightsMock.mockResolvedValue({ Response: { TraceId: "P", ResponseStatus: 1, Results: [[rawFlight()]] } });
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(body.reply.routeInsights).toMatchObject({ sufficient: false });
    expect(body.reply.context).not.toMatch(/typically been/i);
    const types = emitMetricMock.mock.calls.map(c => c[0]?.type);
    expect(types).toContain("pluto.routeinsights.served");
  });

  it("sufficient data → one grounded fare sentence in context", async () => {
    routeInsightsMock.mockResolvedValue({
      typicalFareRange: { p25: 4200, p75: 8700 }, cheapestAirlineRecent: "6E",
      observationCount: 42, dataWindowDays: 90, sufficient: true,
    });
    searchFlightsMock.mockResolvedValue({ Response: { TraceId: "P", ResponseStatus: 1, Results: [[rawFlight()]] } });
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(body.reply.context).toMatch(/typically been ₹4,200–₹8,700 recently/);
    expect(body.reply.routeInsights.sufficient).toBe(true);
  });
});
