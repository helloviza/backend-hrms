// SBT customer responses carry the SELLING price but none of the margin
// bookkeeping fields (_marginPercent, _marginAmount, _markupAmount, _netAmount,
// _rsp, _rspClamped). Margin is forced ON here — outside production
// getMarginConfig always returns disabled, which would hide the leak.
//
// What this does NOT cover, on purpose: flight _netPublishedFare/_netOfferedFare
// and hotel TotalFare/NetAmount are still returned, because the live Book/Ticket
// path sends them back to TBO as the net fare (SBTReview.tsx:307-308,
// SBTHotelReview.tsx:241/446). Removing them needs a server-side net lookup.
//
// NO DATABASE, NO TBO — services, models, auth and fetch are mocked.
import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const STRIPPED = ["_marginPercent", "_marginAmount", "_markupAmount", "_netAmount", "_rsp", "_rspClamped", "marginPercent", "rspClamped"];

function strippedKeyPaths(v: any, path = "$"): string[] {
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  for (const k of Object.keys(v)) {
    if (STRIPPED.includes(k)) out.push(`${path}.${k}`);
    out.push(...strippedKeyPaths(v[k], `${path}.${k}`));
  }
  return out;
}

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = { id: "U1", _id: "U1", sub: "U1", email: "wl@cust.com", roles: ["WORKSPACE_LEADER"] };
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (req: any, _res: any, next: any) => {
    req.workspaceObjectId = "64b0000000000000000000ff";
    req.workspace = { tenantType: "CORPORATE" };
    next();
  },
}));
vi.mock("../middleware/requireFeature.js", () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/margin.js", async () => {
  const actual: any = await vi.importActual("../utils/margin.js");
  return {
    ...actual,
    getMarginConfig: async () => ({
      enabled: true,
      flight: { domestic: 10, international: 10 },
      hotel: { domestic: 10, international: 10 },
    }),
  };
});
vi.mock("../models/SBTQuote.js", () => ({ default: { create: async () => ({}) } }));
vi.mock("../utils/tboFileLogger.js", () => ({
  logTBOCall: () => {},
  listTBOLogs: () => [],
  readTBOLog: () => null,
}));
vi.mock("../services/tbo.hotel.shared.js", async () => {
  const actual: any = await vi.importActual("../services/tbo.hotel.shared.js");
  return { ...actual, hotelAuthHeader: () => "Basic test" };
});
vi.mock("../jobs/static-data-refresh.js", () => ({
  resolveCityCodeAgainstCatalog: () => null,
  resolveCityCode: () => null,
  TBOHotelMaster: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

const flightFare = { BaseFare: 4000, Tax: 900, PublishedFare: 4900, OfferedFare: 4700, Currency: "INR" };

vi.mock("../services/tbo.flight.service.js", async () => {
  const actual: any = await vi.importActual("../services/tbo.flight.service.js");
  return {
    ...actual,
    searchFlights: async () => ({
      Response: { ResponseStatus: 1, TraceId: "T1", Results: [[{ ResultIndex: "OB1", IsLCC: true, Fare: { ...flightFare } }]] },
    }),
    getFareQuote: async () => ({
      Response: { ResponseStatus: 1, Results: { ResultIndex: "OB1", IsLCC: true, Fare: { ...flightFare } } },
    }),
  };
});

const tboHotelResponse = () => ({
  Status: { Code: 200 },
  HotelResult: [
    {
      HotelCode: "H1",
      Currency: "INR",
      Rooms: [
        {
          Name: ["Deluxe"],
          BookingCode: "BC1",
          TotalFare: 10000,
          TotalTax: 1200,
          NetAmount: 10000,
          RecommendedSellingRate: 10500,
          MealType: "Room_Only",
          IsRefundable: true,
        },
      ],
    },
  ],
});

const { default: flightsRouter } = await import("./sbt.flights.js");
const { default: hotelsRouter } = await import("./sbt.hotels.js");

const app = express();
app.use(express.json());
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/hotels", hotelsRouter);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SBT flights — no margin fields, selling price kept", () => {
  it("POST /search", async () => {
    const res = await request(app)
      .post("/api/sbt/flights/search")
      .send({ JourneyType: 1, origin: "DEL", destination: "BOM", departDate: "2026-10-20", adults: 1, originCountry: "IN", destCountry: "IN" });
    expect(res.status).toBe(200);
    expect(strippedKeyPaths(res.body)).toEqual([]);
    const fare = res.body.Response.Results[0][0].Fare;
    expect(fare.OfferedFare).toBe(5170); // 4700 + 10% — the selling price
    expect(fare.PublishedFare).toBe(5390);
  });

  it("POST /farequote", async () => {
    const res = await request(app)
      .post("/api/sbt/flights/farequote")
      .send({ TraceId: "T1", ResultIndex: "OB1", originCountry: "IN", destCountry: "IN" });
    expect(res.status).toBe(200);
    expect(strippedKeyPaths(res.body)).toEqual([]);
    expect(res.body.Response.Results.Fare.OfferedFare).toBe(5170);
  });
});

describe("SBT hotels — no margin fields, selling price kept", () => {
  it("POST /search", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(tboHotelResponse()), { status: 200 }));
    const res = await request(app)
      .post("/api/sbt/hotels/search")
      .send({ HotelCodes: ["H1"], CheckIn: "2026-10-20", CheckOut: "2026-10-22", Rooms: [{ Adults: 1, Children: 0 }], CountryCode: "IN" });
    expect(res.status).toBe(200);
    expect(res.body.Hotels).toHaveLength(1);
    expect(strippedKeyPaths(res.body)).toEqual([]);
    expect(res.body.Hotels[0].Rooms[0]._displayTotalFare).toBe(11000);
  });

  it("POST /rooms", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(tboHotelResponse()), { status: 200 }));
    const res = await request(app)
      .post("/api/sbt/hotels/rooms")
      .send({ hotelCode: "H1", checkIn: "2026-10-20", checkOut: "2026-10-22", adults: 1, rooms: 1 });
    expect(res.status).toBe(200);
    expect(res.body.rooms).toHaveLength(1);
    expect(strippedKeyPaths(res.body)).toEqual([]);
    expect(res.body.rooms[0]._displayTotalFare).toBe(11000);
  });
});
