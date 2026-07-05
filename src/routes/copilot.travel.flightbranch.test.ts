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

describe("Amendment T — the flight branch writes route/dates into locked", () => {
  it("locks origin + dates (start/end) after a flight search", async () => {
    const body = await chat("flights from Delhi to Mumbai on 20 May 2026 returning 24 May 2026");
    expect(body.context.locked.origin.city).toBe("Delhi");
    expect(body.context.locked.dates.start).toBe("2026-05-20");
    expect(body.context.locked.dates.end).toBe("2026-05-24");
  });

  it("keeps a previously-locked destination (set-if-absent) while adding origin/dates", async () => {
    const seeded = { id: "c1", locked: { destination: { name: "Mumbai", iata: "BOM", source: "user" }, duration: { days: 3 } } };
    const body = await chat("find flights from Delhi on 20 May 2026, back on 24 May", seeded);
    expect(body.context.locked.destination.name).toBe("Mumbai"); // retained
    expect(body.context.locked.origin.city).toBe("Delhi");       // added
    expect(body.context.locked.dates.start).toBe("2026-05-20");
  });
});

describe("Step 3 — compound flight + hotel is never silently dropped", () => {
  it("compound message → flight search runs AND the hotel ask is acknowledged with a trigger", async () => {
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026 and suggest a business hotel");
    expect(searchFlightsMock).toHaveBeenCalledTimes(1); // flight still runs
    expect(body.reply.context).toMatch(/business hotel in Mumbai/i);
    expect(body.reply.nextSteps[0]).toBe("Show me business hotels in Mumbai");
  });

  it("flight-only message → no hotel trigger", async () => {
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(body.reply.nextSteps.some((s: string) => /hotels in/i.test(s))).toBe(false);
    expect(body.reply.context).not.toMatch(/noted you want/i);
  });

  it("qualifier passthrough — '5-star hotel' → '5-star hotels' trigger", async () => {
    const body = await chat("flights from Delhi to Mumbai on 20 May 2026, also a 5-star hotel please");
    expect(body.reply.nextSteps[0]).toBe("Show me 5-star hotels in Mumbai");
  });
});

describe("Step 4 — duration consistency flag", () => {
  it("locked 3-day plan + dates spanning 5 days → flagged AND locked.duration updated to 5 (dates win)", async () => {
    const seeded = { id: "c1", locked: { destination: { name: "Mumbai", iata: "BOM", source: "user" }, duration: { days: 3, source: "user" } } };
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026 returning 24 May 2026", seeded);
    expect(body.reply.context).toMatch(/spans 5 days.*differs from your original 3-day plan/i);
    expect(body.context.locked.duration).toMatchObject({ days: 5, source: "dates" });
  });

  it("dates consistent with locked duration → no flag", async () => {
    const seeded = { id: "c1", locked: { destination: { name: "Mumbai", iata: "BOM", source: "user" }, duration: { days: 5, source: "user" } } };
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026 returning 24 May 2026", seeded);
    expect(body.reply.context).not.toMatch(/differs from your original/i);
  });
});
