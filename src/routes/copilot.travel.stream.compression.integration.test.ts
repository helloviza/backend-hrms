// Phase 5 smoke — POST /stream through the REAL global compression() middleware.
// Asserts INCREMENTAL delivery (a status event reaches the client BEFORE the
// final is written), heartbeat frames during a slowed stage, and an error event
// (never a bare drop) when the AI is killed mid-turn.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import zlib from "zlib";

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
const { invokePlutoMock, geminiMock } = vi.hoisted(() => ({ invokePlutoMock: vi.fn(), geminiMock: vi.fn() }));
vi.mock("../utils/plutoInvoke.js", () => ({ invokePluto: invokePlutoMock }));
vi.mock("../utils/plutoGeminiInvoke.js", () => ({ invokePlutoGemini: geminiMock, GEMINI_FALLBACK_INVALID: "GEMINI_FALLBACK_INVALID" }));

import express from "express";
import compression from "compression";
import router from "./copilot.travel.js";

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
const flightsResponse = { Response: { TraceId: "S", ResponseStatus: 1, Results: [[rawFlight()]] } };

let server: http.Server;
let port = 0;

// Raw HTTP client that records WHEN each marker first appears in the decoded
// stream (relative ms) — so we can prove status precedes final on the wire.
function driveStream(body: any): Promise<{ text: string; statusAt: number; finalAt: number; heartbeatAt: number; headers: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: "/stream", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "Accept-Encoding": "gzip" } },
      (res) => {
        let stream: NodeJS.ReadableStream = res;
        if (String(res.headers["content-encoding"] || "").includes("gzip")) { const gz = zlib.createGunzip(); res.pipe(gz); stream = gz; }
        let text = ""; let statusAt = 0; let finalAt = 0; let heartbeatAt = 0; const t0 = Date.now();
        stream.on("data", (c: Buffer) => {
          text += c.toString("utf8");
          const now = Date.now() - t0;
          if (!statusAt && /"stage"/.test(text)) statusAt = now;
          if (!heartbeatAt && /: keep-alive/.test(text)) heartbeatAt = now;
          if (!finalAt && /event:\s*final/.test(text)) finalAt = now;
        });
        stream.on("end", () => resolve({ text, statusAt, finalAt, heartbeatAt, headers: res.headers }));
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function parseSSE(text: string): Array<{ event: string; data: any }> {
  return text.split("\n\n").map((f) => f.trim()).filter((f) => f.startsWith("event:")).map((frame) => {
    const ev = frame.match(/^event:\s*(.+)$/m)?.[1] || "";
    const dataLine = frame.match(/^data:\s*([\s\S]*)$/m)?.[1];
    return { event: ev, data: dataLine ? JSON.parse(dataLine) : undefined };
  });
}

beforeAll(() => {
  process.env.CONCIERGE_SSE_HEARTBEAT_MS = "25";
  const app = express();
  app.use(compression()); // the real global middleware from server.ts:219
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { _id: "u1", email: "t@plumtrips.com" }; req.workspaceObjectId = "656565656565656565656565"; req.workspaceId = "656565656565656565656565"; next(); });
  app.use("/", router);
  server = app.listen(0);
  port = (server.address() as any).port;
});

afterAll(() => { delete process.env.CONCIERGE_SSE_HEARTBEAT_MS; server?.close(); });

beforeEach(() => {
  searchFlightsMock.mockReset();
  emitMetricMock.mockReset();
  policyRulesMock.mockReset(); policyRulesMock.mockResolvedValue(null);
  routeInsightsMock.mockReset(); routeInsightsMock.mockResolvedValue({ typicalFareRange: null, cheapestAirlineRecent: null, observationCount: 3, dataWindowDays: 90, sufficient: false });
  invokePlutoMock.mockReset();
  geminiMock.mockReset();
});

describe("POST /stream under real compression()", () => {
  it("delivers a status event BEFORE final (incremental), with heartbeats during a slow stage", async () => {
    // Slow the search so early status frames must be flushed before the final.
    searchFlightsMock.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 250)); return flightsResponse; });

    const r = await driveStream({ prompt: "find flights from Delhi to Mumbai on 20 May 2026" });

    // Frames decoded correctly through the middleware.
    const frames = parseSSE(r.text);
    expect(frames.some((f) => f.event === "final")).toBe(true);
    expect(frames[frames.length - 1].event).toBe("done");

    // Incremental: a status frame reached the client meaningfully before final.
    expect(r.statusAt).toBeGreaterThan(0);
    expect(r.finalAt).toBeGreaterThan(0);
    expect(r.statusAt).toBeLessThan(r.finalAt);
    expect(r.finalAt - r.statusAt).toBeGreaterThanOrEqual(100); // not one end-flush

    // Heartbeat frames appeared during the slowed stage.
    expect(r.heartbeatAt).toBeGreaterThan(0);
    expect(r.text).toContain(": keep-alive");
  }, 15000);

  it("AI killed mid-turn → error event with requestId (never a bare drop)", async () => {
    invokePlutoMock.mockRejectedValue(new Error("openai exploded"));
    geminiMock.mockRejectedValue(new Error("gemini exploded"));

    const r = await driveStream({ prompt: "plan a 3 day cultural itinerary for Rome" });
    const frames = parseSSE(r.text);
    const err = frames.find((f) => f.event === "error");
    expect(err).toBeTruthy();
    expect(err!.data.message).toBeTruthy();
    expect(err!.data.requestId).toBeTruthy();
    // A real error event, not a silent connection close.
    expect(r.text).toContain("event: error");
  }, 15000);
});
