// Pluto Hotfix A — route-level behaviour for the QC cases (F-02, F-04, F-23).
// Same harness as copilot.travel.flightbranch.test.ts: TBO + edges mocked.
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

function row(idx: string, dep: string, arr: string, fare: number, duration: number, depTime = "2026-11-16T20:55:00", arrTime = "2026-11-16T23:45:00") {
  return {
    ResultIndex: idx, IsLCC: false, IsRefundable: true,
    Fare: { PublishedFare: fare, OfferedFare: fare, Currency: "INR" },
    Segments: [[{
      CabinClass: 2, Duration: duration,
      Airline: { AirlineCode: "EY", AirlineName: "Etihad", FlightNumber: idx },
      Origin: { DepTime: depTime, Airport: { AirportCode: dep } },
      Destination: { ArrTime: arrTime, Airport: { AirportCode: arr } },
    }]],
  };
}
const tbo = (outbound: any[]) => ({ Response: { TraceId: "T", ResponseStatus: 1, Results: [outbound] } });
const chat = (prompt: string, context: any = {}) => request(app).post("/").send({ prompt, context }).then((r) => r.body);

beforeEach(() => { searchFlightsMock.mockReset(); });

describe("F-02 — a Dubai search never answers with Abu Dhabi", () => {
  it("AUH rows are excluded from flights/cheapest/fastest and returned as otherAirport", async () => {
    searchFlightsMock.mockResolvedValue(tbo([
      row("AUH-CHEAP", "BLR", "AUH", 14000, 260),
      row("AUH-FAST", "BLR", "AUH", 15000, 200),
      row("DXB-1", "BLR", "DXB", 18000, 245),
    ]));
    const body = await chat("find flights from Bangalore to Dubai on 16 Nov 2026");
    const fs = body.reply.flightSearch;
    expect(fs.flights.map((f: any) => f.ResultIndex)).toEqual(["DXB-1"]);
    expect(fs.cheapest.ResultIndex).toBe("DXB-1");
    expect(fs.fastest.ResultIndex).toBe("DXB-1");
    expect(fs.otherAirport.map((f: any) => f.ResultIndex).sort()).toEqual(["AUH-CHEAP", "AUH-FAST"]);
    expect(body.reply.context).toMatch(/Found 1 flights for BLR → DXB/);
    expect(body.reply.context).toMatch(/2 more options use a different airport \(Abu Dhabi Int'l \(AUH\)\)/);
  });

  it("the prod EY-239 shape (BLR→AUH + coach to XNB 'Dubai Bus Station') is never Best — it's in otherAirport, labelled", async () => {
    const ey239 = {
      ResultIndex: "EY239", IsLCC: false, IsRefundable: false,
      Fare: { PublishedFare: 13352, OfferedFare: 13352, Currency: "INR" },
      Segments: [[
        { CabinClass: 2, Duration: 260, Airline: { AirlineCode: "EY", AirlineName: "Etihad Airways", FlightNumber: "239" },
          Origin: { DepTime: "2026-11-16T22:00:00", Airport: { AirportCode: "BLR" } },
          Destination: { ArrTime: "2026-11-17T00:50:00", Airport: { AirportCode: "AUH" } } },
        { CabinClass: 2, Duration: 105, GroundTime: 70, Airline: { AirlineCode: "EY", AirlineName: "Etihad Airways", FlightNumber: "5413" },
          Origin: { DepTime: "2026-11-17T02:00:00", Airport: { AirportCode: "AUH" } },
          Destination: { ArrTime: "2026-11-17T03:45:00", Airport: { AirportCode: "XNB" } } },
      ]],
    };
    searchFlightsMock.mockResolvedValue(tbo([ey239, row("DXB-1", "BLR", "DXB", 18000, 245)]));
    const body = await chat("find flights from Bangalore to Dubai on 16 Nov 2026");
    const fs = body.reply.flightSearch;
    expect(fs.flights.map((f: any) => f.ResultIndex)).toEqual(["DXB-1"]);
    expect(fs.cheapest.ResultIndex).toBe("DXB-1");
    expect(fs.otherAirport.map((f: any) => f.ResultIndex)).toEqual(["EY239"]);
    expect(fs.otherAirport[0].arrivalAirportLabel).toBe("Abu Dhabi Int'l (AUH) · coach to Dubai Bus Station (XNB)");
  });

  it("zero MATCH rows: says so plainly and still shows the other-airport group", async () => {
    searchFlightsMock.mockResolvedValue(tbo([row("AUH-1", "BLR", "AUH", 14000, 260)]));
    const body = await chat("find flights from Bangalore to Dubai on 16 Nov 2026");
    const fs = body.reply.flightSearch;
    expect(fs.flights).toEqual([]);
    expect(fs.cheapest).toBeNull();
    expect(fs.otherAirport).toHaveLength(1);
    expect(fs.source).toBe("tbo");
    expect(body.reply.context).toMatch(/I found no flights BLR → DXB on .*use Abu Dhabi Int'l \(AUH\) instead/);
    expect(body.reply.context).not.toMatch(/Found \d+ flights/);
  });
});

describe("F-04 — Fastest ranks on the time-zone-correct duration", () => {
  it("the 4h20m BLR→DXB row (20:55→23:45 local) is not beaten by a 'shorter' clock-subtracted one", async () => {
    // Clock subtraction would make A 2h50m and B 3h40m; TBO says A is 260m, B is 220m.
    searchFlightsMock.mockResolvedValue(tbo([
      row("A", "BLR", "DXB", 15000, 260, "2026-11-16T20:55:00", "2026-11-16T23:45:00"),
      row("B", "BLR", "DXB", 16000, 220, "2026-11-16T08:00:00", "2026-11-16T11:40:00"),
    ]));
    const body = await chat("find flights from Bangalore to Dubai on 16 Nov 2026");
    const fs = body.reply.flightSearch;
    expect(fs.fastest.ResultIndex).toBe("B");
    expect(fs.flights.find((f: any) => f.ResultIndex === "A").duration).toBe("4h 20m");
  });
});

describe("F-23 — the HR guard, first turn and follow-up", () => {
  it("first message 'how many leaves do I have' → HRMS redirect with a Leaves link, no search", async () => {
    const body = await chat("[QC] how many leaves do I have");
    expect(body.reply.title).toBe("That's one for HRMS");
    expect(body.reply.links).toEqual([{ label: "Open Leaves", href: "/leaves/my" }]);
    expect(body.context.id).toBeTruthy();
    expect(searchFlightsMock).not.toHaveBeenCalled();
  });

  it("the same question mid-trip → redirected, and the locked trip survives untouched", async () => {
    const seeded = {
      id: "c-trip",
      locked: { destination: { name: "Dubai", iata: "DXB", source: "user" }, dates: { start: "2026-11-16", end: "2026-11-19" } },
    };
    const body = await chat("how many leaves do I have", seeded);
    expect(body.reply.links).toEqual([{ label: "Open Leaves", href: "/leaves/my" }]);
    expect(body.context.id).toBe("c-trip");
    expect(body.context.locked).toEqual(seeded.locked);
  });

  it("'ok leave flights for now' mid-trip is NOT treated as an HR question", async () => {
    searchFlightsMock.mockResolvedValue(tbo([row("DXB-1", "BLR", "DXB", 18000, 245)]));
    const body = await chat("ok leave flights for now", { id: "c-trip", locked: {} });
    expect(body.reply?.title).not.toBe("That's one for HRMS");
  });
});
