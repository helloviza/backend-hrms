// KNOW-in-chat end-to-end: real fare logging + real route-insights + real chat
// wiring; only the FareObservation model, TBO, weather and metrics are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });

const H = vi.hoisted(() => ({
  searchFlights: vi.fn(), insertMany: vi.fn(), find: vi.fn(),
  emitMetric: vi.fn(), loadPolicy: vi.fn(), getWeather: vi.fn(),
  ws: { id: "656565656565656565656565" },
}));

vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: H.searchFlights }));
vi.mock("../models/FareObservation.js", () => ({ default: { insertMany: H.insertMany, find: H.find } }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: H.emitMetric }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: H.loadPolicy }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: H.getWeather }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { _id: "u1", email: "t@x.com" };
  req.workspaceObjectId = H.ws.id; // mutable per test → proves tenant scoping
  req.workspaceId = H.ws.id;
  next();
});
app.use("/", router);

function rawFlight(i: number) {
  return {
    ResultIndex: `R${i}`, IsLCC: true, IsRefundable: false,
    Fare: { OfferedFare: 4000 + i * 100, PublishedFare: 5000 + i * 100, Currency: "INR" },
    Segments: [[{
      CabinClass: 2, Duration: 130,
      Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: `${1000 + i}` },
      Origin: { DepTime: "2026-05-20T07:00:00", Airport: { AirportCode: "DEL" } },
      Destination: { ArrTime: "2026-05-20T09:10:00", Airport: { AirportCode: "BOM" } },
    }]],
  };
}
const chain = (v: any) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });
const chat = (prompt: string) => request(app).post("/").send({ prompt }).then(r => r.body);

beforeEach(() => {
  H.searchFlights.mockReset(); H.insertMany.mockReset(); H.find.mockReset();
  H.emitMetric.mockReset(); H.loadPolicy.mockReset(); H.getWeather.mockReset();
  H.ws.id = "656565656565656565656565";
  H.loadPolicy.mockResolvedValue(null);
  H.insertMany.mockResolvedValue([]);
  H.find.mockReturnValue(chain([]));   // default: thin route data
  H.getWeather.mockResolvedValue(null); // default: no weather line
});

describe("KNOW in chat", () => {
  it("3a: logs FareObservations (<=30, correct shape, workspaceId set)", async () => {
    H.searchFlights.mockResolvedValue({
      Response: { TraceId: "T", ResponseStatus: 1, Results: [Array.from({ length: 40 }, (_, i) => rawFlight(i))] },
    });
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(body.ok).toBe(true);
    expect(H.insertMany).toHaveBeenCalledTimes(1);
    const [docs, opts] = H.insertMany.mock.calls[0];
    expect(opts).toEqual({ ordered: false });
    expect(docs.length).toBe(30); // capped
    expect(docs[0]).toMatchObject({ workspaceId: H.ws.id, origin: "DEL", destination: "BOM", airline: "6E", source: "TBO_SEARCH" });
    expect(typeof docs[0].fareINR).toBe("number");
  });

  it("3b: >=10 observations → routeInsights + one-line fare sentence", async () => {
    H.searchFlights.mockResolvedValue({ Response: { TraceId: "T", ResponseStatus: 1, Results: [[rawFlight(0)]] } });
    const obs = Array.from({ length: 12 }, (_, i) => ({ fareINR: 3000 + i * 500, airline: "6E" }));
    H.find.mockReturnValue(chain(obs));
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(body.reply.routeInsights.sufficient).toBe(true);
    expect(body.reply.routeInsights.typicalFareRange).toHaveProperty("p25");
    expect(body.reply.context).toMatch(/Fares on this route have typically been ₹/);
  });

  it("3c: a DIFFERENT workspace with <10 own observations → NO insights (tenant-scoped read)", async () => {
    H.ws.id = "606060606060606060606060"; // workspace B
    H.searchFlights.mockResolvedValue({ Response: { TraceId: "T", ResponseStatus: 1, Results: [[rawFlight(0)]] } });
    H.find.mockReturnValue(chain([{ fareINR: 5000, airline: "6E" }])); // only 1 obs for B
    const body = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(body.reply.routeInsights.sufficient).toBe(false);
    expect(body.reply.context).not.toMatch(/typically been ₹/);
    // The route-history read was scoped to workspace B.
    const filter = H.find.mock.calls[0][0];
    expect(String(filter.workspaceId)).toBe("606060606060606060606060");
  });

  it("4: weather line appears when available, absent (turn still completes) when it fails", async () => {
    H.searchFlights.mockResolvedValue({ Response: { TraceId: "T", ResponseStatus: 1, Results: [[rawFlight(0)]] } });

    H.getWeather.mockResolvedValueOnce({ tempMaxC: 31, tempMinC: 26, precipMm: 2, code: 61, severe: false, summary: "rain", city: "Mumbai" });
    const withW = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(withW.reply.context).toMatch(/Weather in Mumbai around then: ~31°C, rain/);

    H.getWeather.mockResolvedValueOnce(null); // simulate a failed/timed-out lookup
    const noW = await chat("find flights from Delhi to Mumbai on 20 May 2026");
    expect(noW.ok).toBe(true);
    expect(noW.reply.context).not.toMatch(/Weather in/);
  });
});
