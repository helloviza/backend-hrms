// Chat flight-branch quality: cabin detection (Amendment S), route/date locking
// (Amendment T), compound flight+hotel handling (Step 3), duration flag (Step 4).
// TBO + edges mocked; assertions target the search request + the reply.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });
const { searchFlightsMock } = vi.hoisted(() => ({ searchFlightsMock: vi.fn() }));
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: searchFlightsMock }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({ getRouteIntelProvider: () => ({ getRouteInsights: vi.fn().mockResolvedValue({ sufficient: false, observationCount: 0, dataWindowDays: 90 }) }) }));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));
vi.mock("../services/flightService.js", () => ({ getDelightfulFlightStatus: vi.fn().mockResolvedValue(null) }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.user = { _id: "u1", email: "t@plumtrips.com" }; req.workspaceObjectId = "656565656565656565656565"; req.workspaceId = "656565656565656565656565"; next(); });
app.use("/", router);

function rawFlight(over: Record<string, any> = {}) {
  return { ResultIndex: "OB1", IsLCC: true, IsRefundable: true, Fare: { PublishedFare: 5000, OfferedFare: 4800, Currency: "INR" },
    Segments: [[{ CabinClass: 2, Duration: 130, Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "2582" },
      Origin: { DepTime: "2026-05-20T07:20:00", Airport: { AirportCode: "DEL", CityName: "Delhi" } },
      Destination: { ArrTime: "2026-05-20T09:30:00", Airport: { AirportCode: "BOM", CityName: "Mumbai" } } }]], ...over };
}
const oneFlight = { Response: { TraceId: "T", ResponseStatus: 1, Results: [[rawFlight()]] } };
const chat = (prompt: string, context: any = {}) => request(app).post("/").send({ prompt, context }).then(r => r.body);

beforeEach(() => { searchFlightsMock.mockReset().mockResolvedValue(oneFlight); });

describe("Amendment S — cabin detection is flight-adjacent, never off a hotel word", () => {
  it("'business hotel and cheapest flight' → Economy (cabinClass 2), reply says Economy", async () => {
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026 — need a business hotel and the cheapest flight");
    expect(searchFlightsMock).toHaveBeenCalledWith(expect.objectContaining({ cabinClass: 2 }));
    expect(body.reply.context).toMatch(/Cabin: Economy/);
  });

  it("'business class' → Business (cabinClass 4), reply says Business", async () => {
    const body = await chat("find business class flights from Delhi to Mumbai on 20 May 2026");
    expect(searchFlightsMock).toHaveBeenCalledWith(expect.objectContaining({ cabinClass: 4 }));
    expect(body.reply.context).toMatch(/Cabin searched: Business/);
  });

  it("'premium economy' → Premium Economy (cabinClass 3)", async () => {
    const body = await chat("find premium economy flights from Delhi to Mumbai on 20 May 2026");
    expect(searchFlightsMock).toHaveBeenCalledWith(expect.objectContaining({ cabinClass: 3 }));
    expect(body.reply.context).toMatch(/Premium Economy/);
  });

  it("default is Economy when no cabin is stated", async () => {
    await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(searchFlightsMock).toHaveBeenCalledWith(expect.objectContaining({ cabinClass: 2 }));
  });

  it("'cheapest flight' → reply names the lowest fare", async () => {
    const body = await chat("find the cheapest flight from Delhi to Mumbai on 20 May 2026");
    expect(body.reply.context).toMatch(/Cheapest fare found: ₹/);
  });
});
