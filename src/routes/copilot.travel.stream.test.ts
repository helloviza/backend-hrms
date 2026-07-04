// Phase 5 Step 4 — POST /stream SSE progress events + final == POST / reply.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });

const { searchFlightsMock } = vi.hoisted(() => ({ searchFlightsMock: vi.fn() }));
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: searchFlightsMock }));
const { emitMetricMock } = vi.hoisted(() => ({ emitMetricMock: vi.fn() }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: emitMetricMock }));
const { policyRulesMock } = vi.hoisted(() => ({ policyRulesMock: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: policyRulesMock }));
const { routeInsightsMock } = vi.hoisted(() => ({ routeInsightsMock: vi.fn() }));
vi.mock("../services/routeIntel.provider.js", () => ({ getRouteIntelProvider: () => ({ name: "mock", getRouteInsights: routeInsightsMock }) }));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.user = { _id: "u1", email: "t@plumtrips.com" }; req.workspaceObjectId = "656565656565656565656565"; req.workspaceId = "656565656565656565656565"; next(); });
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

// Parse an SSE text body into typed frames.
function parseSSE(text: string): Array<{ event: string; data: any }> {
  return text.split("\n\n").map((f) => f.trim()).filter(Boolean).filter((f) => f.startsWith("event:")).map((frame) => {
    const ev = frame.match(/^event:\s*(.+)$/m)?.[1] || "";
    const dataLine = frame.match(/^data:\s*([\s\S]*)$/m)?.[1];
    return { event: ev, data: dataLine ? JSON.parse(dataLine) : undefined };
  });
}

const PROMPT = "find flights from Delhi to Mumbai on 20 May 2026";
const flightsResponse = { Response: { TraceId: "S", ResponseStatus: 1, Results: [[rawFlight()]] } };

beforeEach(() => {
  searchFlightsMock.mockReset();
  emitMetricMock.mockReset();
  policyRulesMock.mockReset();
  policyRulesMock.mockResolvedValue(null);
  routeInsightsMock.mockReset();
  routeInsightsMock.mockResolvedValue({ typicalFareRange: null, cheapestAirlineRecent: null, observationCount: 3, dataWindowDays: 90, sufficient: false });
});

describe("POST /stream", () => {
  it("emits status stages → final → done (happy path)", async () => {
    searchFlightsMock.mockResolvedValue(flightsResponse);
    const res = await request(app).post("/stream").send({ prompt: PROMPT });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const frames = parseSSE(res.text);
    const events = frames.map((f) => f.event);
    const stages = frames.filter((f) => f.event === "status").map((f) => f.data.stage);

    expect(stages).toContain("understanding");
    expect(stages).toContain("searching_flights");
    expect(stages).toContain("assembling");
    expect(events).toContain("final");
    expect(events[events.length - 1]).toBe("done");

    const final = frames.find((f) => f.event === "final")!;
    expect(final.data.ok).toBe(true);
    expect(final.data.reply.flightSearch.flights).toHaveLength(1);
  });

  it("final payload deep-equals the POST / reply for identical mocked inputs (modulo the per-request conversation id)", async () => {
    searchFlightsMock.mockResolvedValue(flightsResponse);
    const plain = await request(app).post("/").send({ prompt: PROMPT });
    const streamRes = await request(app).post("/stream").send({ prompt: PROMPT });
    const final = parseSSE(streamRes.text).find((f) => f.event === "final")!;
    // The computed reply + ok flag are byte-identical between the two paths.
    expect(final.data.ok).toEqual(plain.body.ok);
    expect(final.data.reply).toEqual(plain.body.reply);
    // Both now carry a conversation id so no reply is ever id-less; it is a
    // per-request nonce (crypto.randomUUID) so the two ids legitimately differ.
    // Everything ELSE in the context must still match exactly.
    expect(typeof final.data.context.id).toBe("string");
    expect(typeof plain.body.context.id).toBe("string");
    const { id: _s, ...ctxStream } = final.data.context;
    const { id: _p, ...ctxPlain } = plain.body.context;
    expect(ctxStream).toEqual(ctxPlain);
  });

  it("turn failure → error event with message + requestId (never a silent drop)", async () => {
    policyRulesMock.mockRejectedValue(new Error("policy store down"));
    searchFlightsMock.mockResolvedValue(flightsResponse);
    const res = await request(app).post("/stream").send({ prompt: PROMPT });
    const err = parseSSE(res.text).find((f) => f.event === "error");
    expect(err).toBeTruthy();
    expect(err!.data.message).toBeTruthy();
    expect(err!.data.requestId).toBeTruthy();
  });
});
