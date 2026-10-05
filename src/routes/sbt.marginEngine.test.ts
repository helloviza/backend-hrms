// apps/backend/src/routes/sbt.marginEngine.test.ts
//
// The SBT margin engine end to end: every pricing path prices at the CALLER'S
// company margin (services/sbtMargin.ts resolveMargin) — flight search,
// multi-city (/search JT3 and /search-multi-city, every leg), the non-success
// fallback, calendar, PriceRBD, FareQuote, concierge search + chat; hotel
// search, rooms, PreBook, concierge hotels — with domestic vs international
// decided on the server from airport / hotel data (the browser's
// originCountry / destCountry / countryCode are ignored). The quote records
// the margin that priced it; checkout and the booking carry that record.
// Seats / meals / bags and airline change fees pass through at cost. Negative
// margins: flights sell below net while TBO still receives the server-held
// net; hotels never go below the RSP floor. No GST on a markup ≤ 0.
//
// Real: flights + hotels + concierge routers, services (sbtMargin, sbtQuote,
//   sbtPaymentGate, sbtFulfil), models, in-memory Mongo; margins switched on
//   with the local-dev flag (SBT_MARGINS_LOCAL=1), config + overrides in the DB.
// Stubbed: requireAuth / requireWorkspace (headers), TBO flight service calls,
//   TBO hotel HTTP (fetch), hotel / city master reads, Razorpay, mail, concierge edges.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.SBT_MARGINS_LOCAL = "1";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
process.env.OPENAI_API_KEY ||= "test-key";
delete process.env.TBO_ENV;

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    req.workspace = {
      _id: req.workspaceObjectId, status: "ACTIVE", tenantType: "CORPORATE",
      config: { features: { sbtEnabled: true, flightBookingEnabled: true, hotelBookingEnabled: true } },
    };
    next();
  },
}));
vi.mock("../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
vi.mock("../services/tbo.log.consolidator.js", () => ({ consolidateCertificationLogs: async () => {} }));
vi.mock("../services/tbo.hotel.shared.js", async (orig) => ({ ...(await orig<any>()), hotelAuthHeader: () => "Basic test" }));
vi.mock("../services/tbo.session.helper.js", () => ({
  withTBOSessionRetry: async (fn: (t: string) => Promise<unknown>) => fn("tok"),
}));
// Hotel master: H1 is in India, H2 in the UAE. City master: nothing.
const MASTER = [{ hotelCode: "H1", countryCode: "IN" }, { hotelCode: "H2", countryCode: "AE" }];
vi.mock("../jobs/static-data-refresh.js", () => ({
  resolveCityCodeAgainstCatalog: () => null,
  resolveCityCode: () => null,
  TBOHotelMaster: {
    find: (q: any) => ({
      select: () => ({
        lean: async () => (q?.hotelCode?.$in ? MASTER.filter((m) => q.hotelCode.$in.includes(m.hotelCode)) : []),
      }),
    }),
  },
  TBOCity: { findOne: () => ({ select: () => ({ lean: async () => null }) }) },
}));
vi.mock("../jobs/deferred-status-check.js", () => ({ runDeferredStatusCheck: async () => {} }));
// Concierge edges (as in copilot.travel.flightbranch.test.ts).
vi.mock("../utils/plutoMetricsSink.js", async (orig) => ({ ...(await orig<any>()), emitMetric: vi.fn() }));
vi.mock("../services/policyService.js", async (orig) => ({ ...(await orig<any>()), loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({ getRouteIntelProvider: () => ({ getRouteInsights: vi.fn().mockResolvedValue({ sufficient: false, observationCount: 0, dataWindowDays: 90 }) }) }));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));
vi.mock("../services/flightService.js", () => ({ getDelightfulFlightStatus: vi.fn().mockResolvedValue(null) }));

/* ── TBO flight fixtures: one domestic (DEL→BOM), one international (DEL→DXB) ── */
const DOM_FARE = {
  Currency: "INR", BaseFare: 8000, Tax: 1800, PublishedFare: 9800, OfferedFare: 9500,
  CommissionEarned: 250, TdsOnCommission: 12.5, OtherCharges: 0,
};
const INTL_FARE = { ...DOM_FARE, BaseFare: 16000, Tax: 4000, PublishedFare: 20000, OfferedFare: 19400 };
const breakdown = (f: any) => [{ PassengerType: 1, PassengerCount: 1, Currency: "INR", BaseFare: f.BaseFare, Tax: f.Tax, YQTax: 0, PGCharge: 0, TransactionFee: 0 }];
const seg = (o: string, d: string) => ({
  Airline: { AirlineCode: "6E", FlightNumber: d === "DXB" ? "1401" : "101", AirlineName: "IndiGo" }, CabinClass: 2, Duration: 120,
  Origin: { DepTime: "2026-11-01T06:00:00", Airport: { AirportCode: o, CityName: o } },
  Destination: { ArrTime: "2026-11-01T08:00:00", Airport: { AirportCode: d, CityName: d } },
});
const flight = (ri: string, intl = false, fare: any = intl ? INTL_FARE : DOM_FARE) => ({
  ResultIndex: ri, IsLCC: true, IsRefundable: true, Fare: { ...fare }, FareBreakdown: breakdown(fare),
  Segments: [[intl ? seg("DEL", "DXB") : seg("DEL", "BOM")]],
});
let seq = 0;
const ticketed = (fare: any) => ({
  Response: { ResponseStatus: 1, TraceId: "T1", Response: {
    BookingId: 700000 + (++seq), PNR: `PNR${seq}`,
    FlightItinerary: { BookingId: 700000 + seq, PNR: `PNR${seq}`, Fare: { ...fare }, FareBreakdown: breakdown(fare),
      Passenger: [{ FirstName: "Asha", Fare: { ...fare }, Ticket: { TicketId: 900 + seq } }] },
  } },
});

const tbo = vi.hoisted(() => ({
  searchFlights: vi.fn(),
  searchMultiCity: vi.fn(),
  getCalendarFare: vi.fn(),
  getFareQuote: vi.fn(),
  getPriceRBD: vi.fn(),
  getSSR: vi.fn(),
  ticketLCC: vi.fn(),
  bookFlight: vi.fn(),
  ticketFlight: vi.fn(),
  releasePNR: vi.fn(async () => ({})),
  getBookingDetails: vi.fn(async () => null),
}));
vi.mock("../services/tbo.flight.service.js", async (orig) => ({ ...(await orig<any>()), ...tbo }));
const rzp = vi.hoisted(() => ({
  createRazorpayOrder: vi.fn(),
  fetchRazorpayPayment: vi.fn(),
  captureRazorpayPayment: vi.fn(),
  refundRazorpayPayment: vi.fn(),
}));
vi.mock("../services/sbtRazorpay.js", async (orig) => ({ ...(await orig<any>()), ...rzp }));
vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: vi.fn(async () => ({})) }));
vi.mock("../utils/companySettings.js", async (orig) => ({
  ...(await orig<any>()),
  getCompanySettings: async () => ({ opsEmail: "ops@test", supportEmail: "support@test", accountManagerEmail: "" }),
}));

/* ── TBO hotel stubs (fetch): H1 India (net 10000, RSP 10500), H2 Dubai (net 20000, no RSP) ── */
const room = (code: string) => code === "H1"
  ? { Name: ["Deluxe"], BookingCode: "H1!TB!1", TotalFare: 10000, TotalTax: 1200, NetAmount: 10000, RecommendedSellingRate: 10500,
      DayRates: [[{ BasePrice: 4400 }, { BasePrice: 4400 }]], MealType: "Room_Only", IsRefundable: true, CancelPolicies: [] }
  : { Name: ["Suite"], BookingCode: "H2!TB!1", TotalFare: 20000, TotalTax: 2000, NetAmount: 20000,
      DayRates: [[{ BasePrice: 9000 }, { BasePrice: 9000 }]], MealType: "Room_Only", IsRefundable: true, CancelPolicies: [] };
const hotelResult = (code: string) => ({ HotelCode: code, Currency: "INR", TotalFare: room(code).TotalFare, Rooms: [room(code)] });
let hotelBookBodies: any[] = [];
function stubHotelFetch() {
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body || "{}"));
    if (/\/book\/?$/i.test(u)) {
      hotelBookBodies.push(body);
      return new Response(JSON.stringify({ BookResult: {
        ResponseStatus: 1, BookingId: 5550000 + (++seq), ConfirmationNo: `CNF${seq}`, BookingRefNo: `REF${seq}`,
        HotelBookingStatus: "Confirmed", Status: 1, IsVoucherBooking: true, VoucherStatus: true, InvoiceNumber: "INV1",
        NetAmount: body.NetAmount,
      } }), { status: 200 });
    }
    if (/PreBook/i.test(u)) {
      const code = String(body.BookingCode || "").split("!TB!")[0];
      return new Response(JSON.stringify({ ResponseStatus: 1, Status: { Code: 200 }, HotelResult: [hotelResult(code)], ValidationInfo: {} }), { status: 200 });
    }
    const codes = String(body.HotelCodes || "").split(",").filter(Boolean);
    return new Response(JSON.stringify({ Status: { Code: 200 }, HotelResult: codes.map(hotelResult) }), { status: 200 });
  });
}

const { default: flightsRouter } = await import("./sbt.flights.js");
const { default: hotelsRouter } = await import("./sbt.hotels.js");
const { default: conciergeRouter } = await import("./copilot.travel.js");
const { searchFlightsForChat } = await import("../utils/plutoFlightSearch.js");
const { reissueFareDifference } = await import("../services/sbtPaymentGate.js");
const { sbtImportPricing } = await import("./manualBookings.js");
const { invalidateMarginCache } = await import("../utils/margin.js");
const { invalidateOverrideCache } = await import("../services/sbtMargin.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");

const app = express();
app.use(express.json());
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/hotels", hotelsRouter);
app.use("/api/v1/copilot/travel", (req: any, _res, next) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = String(req.headers["x-test-ws"] || "");
  req.workspaceId = req.workspaceObjectId;
  next();
}, conciergeRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid(); // has an override
const WS2 = oid(); // defaults only
const BOOKER = oid();
const BOOKER2 = oid();

const as = (r: request.Test, userId = BOOKER, ws: string = String(WS)) =>
  r.set("x-test-user", JSON.stringify({ _id: String(userId), id: String(userId), sub: String(userId), email: "u@test", roles: ["CUSTOMER"] }))
    .set("x-test-ws", ws);
const asWs2 = (r: request.Test) => as(r, BOOKER2, String(WS2));

// Defaults: flights 10 / 12, hotels 8 / 15. WS: flights domestic 5, hotels
// domestic −10, the international values left to the defaults.
const DEFAULTS = { enabled: true, flight: { domestic: 10, international: 12 }, hotel: { domestic: 8, international: 15 }, version: 3 };
let overrideId = "";
async function setOverride(values: { flight?: any; hotel?: any }) {
  await col("sbtmarginoverrides").deleteMany({});
  const r = await col("sbtmarginoverrides").insertOne({
    workspaceId: WS, reason: "Q4 deal", validUntil: null,
    flight: { domestic: null, international: null, ...(values.flight || {}) },
    hotel: { domestic: null, international: null, ...(values.hotel || {}) },
  } as any);
  overrideId = String(r.insertedId);
  invalidateOverrideCache();
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-margin-engine-test"));
  await mongoose.model("SBTPayment").syncIndexes();
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["users", "customerworkspaces", "sbtquotes", "sbtpayments", "sbtssrsnapshots", "sbtbookings",
    "sbthotelbookings", "sbtwalletledgers", "sbtmulticitytraces", "travelbookings", "sbtconfigs", "manualbookings"]) {
    await col(c).deleteMany({});
  }
  await col("sbtconfigs").insertOne({ key: "margins", value: DEFAULTS } as any);
  invalidateMarginCache();
  await setOverride({ flight: { domestic: 5 }, hotel: { domestic: -10 } });
  await col("users").insertMany([
    { _id: BOOKER, email: "booker@test", sbtEnabled: true, sbtRole: null },
    { _id: BOOKER2, email: "booker2@test", sbtEnabled: true, sbtRole: null },
  ] as any[]);
  const month = new Date().toISOString().slice(0, 7);
  await col("customerworkspaces").insertMany([WS, WS2].map((_id, i) => ({
    _id, status: "ACTIVE", customerId: `C${i}`, companyName: i ? "Beta" : "Acme",
    sbtOfficialBooking: { enabled: true, monthlyLimit: 0, currentMonthSpend: 0, lastResetMonth: month },
  })) as any[]);
  for (const m of [...Object.values(tbo), ...Object.values(rzp)]) (m as any).mockReset();
  hotelBookBodies = [];
  tbo.releasePNR.mockResolvedValue({});
  tbo.getBookingDetails.mockResolvedValue(null);
  tbo.searchFlights.mockImplementation(async (p: any) => {
    // Multi-city legs search one route each; everything else gets both flights.
    if (p?.destination === "BOM") return { Response: { ResponseStatus: 1, TraceId: "T1", Results: [[flight("RI-D")]] } };
    if (p?.destination === "DXB") return { Response: { ResponseStatus: 1, TraceId: "T1", Results: [[flight("RI-I", true)]] } };
    return { Response: { ResponseStatus: 1, TraceId: "T1", Results: [[flight("RI-D"), flight("RI-I", true)]] } };
  });
  tbo.searchMultiCity.mockImplementation(async () => ({
    Response: { ResponseStatus: 1, TraceId: "T1", Results: [[flight("RI-D")], [flight("RI-I", true)]] },
  }));
  tbo.getCalendarFare.mockImplementation(async () => ({
    Response: { SearchResults: [{ DepartureDate: "2026-11-01T00:00:00", Fare: 5001, AirlineCode: "6E", AirlineName: "IndiGo" }] },
  }));
  tbo.getFareQuote.mockImplementation(async (b: any) => {
    const ri = String(b.ResultIndex);
    const f = ri === "RI-I" ? flight(ri, true)
      : ri === "RI-R" ? flight(ri, false, { ...DOM_FARE, BaseFare: 9000, PublishedFare: 11000, OfferedFare: 10700, SupplierReissueCharges: 750 })
      : flight(ri);
    return { Response: { ResponseStatus: 1, TraceId: b.TraceId, Results: f } };
  });
  tbo.getPriceRBD.mockImplementation(async () => ({ Response: { ResponseStatus: 1, Results: [[flight("RBD-1")]] } }));
  tbo.getSSR.mockImplementation(async () => ({ Response: { ResponseStatus: 1,
    SeatDynamic: [{ SegmentSeat: [{ RowSeats: [{ Seats: [{ Code: "12A", Price: 500, Origin: "DEL", Destination: "BOM" }] }] }] }] } }));
  tbo.ticketLCC.mockImplementation(async (p: any) => ticketed(p.ResultIndex === "RI-I" ? INTL_FARE : DOM_FARE));
  rzp.createRazorpayOrder.mockImplementation(async (paise: number) => ({ id: `order_${++seq}`, amount: paise, currency: "INR" }));
  rzp.refundRazorpayPayment.mockImplementation(async (_p: string, amt: number) => ({ id: `rfnd_${++seq}`, amount: amt }));
  stubHotelFetch();
});
afterEach(() => vi.unstubAllGlobals());

// The browser claims a domestic trip everywhere — the server must not believe it.
const LYING = { originCountry: "IN", destCountry: "IN", countryCode: "IN", CountryCode: "IN" };
const pubOf = (f: any) => f?.Fare?.PublishedFare;
// WS: domestic 5% → ceil(9800 × 1.05); international default 12% → ceil(20000 × 1.12).
const WS_DOM = 10290;
const ALL_INTL = 22400;
const WS2_DOM = 10780;

/* ═════════════════════════ flights ═════════════════════════ */

describe("flight pricing paths use the caller's company margin, by the route's own airports", () => {
  it("/search: per company and per result; the browser's 'IN'/'IN' is ignored", async () => {
    const a = await as(request(app).post("/api/sbt/flights/search")).send({ JourneyType: 1, origin: "DEL", destination: "X", ...LYING });
    expect(a.status).toBe(200);
    expect(a.body.Response.Results[0].map(pubOf)).toEqual([WS_DOM, ALL_INTL]); // not 21000 (5% for "domestic")
    const b = await asWs2(request(app).post("/api/sbt/flights/search")).send({ JourneyType: 1, origin: "DEL", destination: "X", ...LYING });
    expect(b.body.Response.Results[0].map(pubOf)).toEqual([WS2_DOM, ALL_INTL]);
  });

  it("/search JT3 multi-city: every leg priced", async () => {
    const r = await as(request(app).post("/api/sbt/flights/search")).send({ JourneyType: 3, segments: [], ...LYING });
    expect(r.status).toBe(200);
    expect(r.body.Response.Results.map((leg: any[]) => pubOf(leg[0]))).toEqual([WS_DOM, ALL_INTL]);
  });

  it("/search-multi-city: every leg priced by its own route", async () => {
    const r = await as(request(app).post("/api/sbt/flights/search-multi-city")).send({
      legs: [{ Origin: "DEL", Destination: "BOM" }, { Origin: "DEL", Destination: "DXB" }], ...LYING,
    });
    expect(r.status).toBe(200);
    expect(r.body.legs.map((l: any) => pubOf(l.results[0]))).toEqual([WS_DOM, ALL_INTL]);
  });

  it("/search: TBO's non-success-with-results fallback is priced too", async () => {
    tbo.searchFlights.mockResolvedValueOnce({ Response: { ResponseStatus: 2, TraceId: "T1", Results: [[flight("RI-D")]] } });
    const r = await as(request(app).post("/api/sbt/flights/search")).send({ JourneyType: 1, ...LYING });
    expect(r.status).toBe(200);
    expect(pubOf(r.body.Response.Results[0][0])).toBe(WS_DOM);
  });

  it("/calendar: whole rupee up, domestic only when both airports are in India", async () => {
    const dom = await as(request(app).post("/api/sbt/flights/calendar")).send({ origin: "DEL", destination: "BOM", month: "2026-11", ...LYING });
    expect(dom.body.fareMap["2026-11-01"].fare).toBe(5252); // ceil(5001 × 1.05 = 5251.05)
    const intl = await as(request(app).post("/api/sbt/flights/calendar")).send({ origin: "DEL", destination: "DXB", month: "2026-11", ...LYING });
    expect(intl.body.fareMap["2026-11-01"].fare).toBe(5602); // ceil(5001 × 1.12 = 5601.12)
  });

  it("/price-rbd", async () => {
    const r = await as(request(app).post("/api/sbt/flights/price-rbd")).send({ TraceId: "T1", AirSearchResult: [], ...LYING });
    expect(pubOf(r.body.Response.Results[0][0])).toBe(WS_DOM);
  });

  it("/farequote records the margin that priced the quote: percent, source, override, defaults version", async () => {
    const d = await as(request(app).post("/api/sbt/flights/farequote")).send({ TraceId: "T1", ResultIndex: "RI-D", ...LYING });
    expect(d.status).toBe(200);
    expect(d.body.Response.Results.Fare.PublishedFare).toBe(WS_DOM);
    const qd: any = await col("sbtquotes").findOne({ quoteId: d.body.quoteId });
    expect(qd).toMatchObject({
      sellingFare: WS_DOM, marginPct: 5, marginSource: "OVERRIDE", marginOverrideId: overrideId,
      marginVersion: 3, isInternational: false, marginAmount: WS_DOM - 9800,
    });
    const i = await as(request(app).post("/api/sbt/flights/farequote")).send({ TraceId: "T1", ResultIndex: "RI-I", ...LYING });
    const qi: any = await col("sbtquotes").findOne({ quoteId: i.body.quoteId });
    expect(qi).toMatchObject({ sellingFare: ALL_INTL, marginPct: 12, marginSource: "DEFAULT", isInternational: true, marginAmount: 2400 });
    expect(qi.marginOverrideId ?? null).toBeNull();
  });

  it("master switch off: net everywhere, override ignored, the quote says OFF", async () => {
    await col("sbtconfigs").updateOne({ key: "margins" }, { $set: { "value.enabled": false } });
    invalidateMarginCache();
    const s = await as(request(app).post("/api/sbt/flights/search")).send({ JourneyType: 1 });
    expect(s.body.Response.Results[0].map(pubOf)).toEqual([9800, 20000]);
    const d = await as(request(app).post("/api/sbt/flights/farequote")).send({ TraceId: "T1", ResultIndex: "RI-D" });
    expect(await col("sbtquotes").findOne({ quoteId: d.body.quoteId })).toMatchObject({ sellingFare: 9800, marginPct: 0, marginSource: "OFF" });
  });

  it("concierge search and concierge chat price like SBT", async () => {
    const r = await as(request(app).post("/api/v1/copilot/travel/flights/search")).send({ origin: "DEL", destination: "GOI", date: "2026-11-01", ...LYING });
    expect(r.status).toBe(200);
    const prices = r.body.results.map((f: any) => f.fare.published).sort((x: number, y: number) => x - y);
    expect(prices).toEqual([WS_DOM, ALL_INTL]);
    const chat = await searchFlightsForChat({ origin: "DEL", destination: "GOI", departDate: "2026-11-01", workspaceObjectId: WS });
    expect(chat.ok).toBe(true);
    expect(chat.flights.map((f: any) => f.fare.published).sort((x: number, y: number) => x - y)).toEqual([WS_DOM, ALL_INTL]);
    // No workspace → the defaults, never net.
    const anon = await searchFlightsForChat({ origin: "DEL", destination: "GOI", departDate: "2026-11-01" });
    expect(anon.flights.map((f: any) => f.fare.published).sort((x: number, y: number) => x - y)).toEqual([WS2_DOM, ALL_INTL]);
  });
});

describe("flight checkout: the recorded margin travels to the booking; add-ons at cost", () => {
  const pax = (seat = false) => [{
    Title: "Mr", FirstName: "Asha", LastName: "Rao", PaxType: 1, IsLeadPax: true,
    Fare: { PublishedFare: 1, OfferedFare: 1, BaseFare: 1, Tax: 0 },
    ...(seat ? { SeatDynamic: [{ SegmentSeat: [{ RowSeats: [{ Seats: [{ Code: "12A", Price: 500, Origin: "DEL", Destination: "BOM" }] }] }] }] } : {}),
  }];
  const saveInfo = {
    origin: { code: "DEL", city: "Delhi" }, destination: { code: "BOM", city: "Mumbai" },
    departureTime: "2026-11-01T06:00:00", arrivalTime: "2026-11-01T08:00:00",
    airlineCode: "6E", airlineName: "IndiGo", flightNumber: "101", baseFare: 1, taxes: 0, totalFare: 1,
    passengers: [{ firstName: "Asha", lastName: "Rao", paxType: "adult", isLead: true }],
  };
  async function bookLcc(seat: boolean) {
    const fq = await as(request(app).post("/api/sbt/flights/farequote")).send({ TraceId: "T1", ResultIndex: "RI-D" });
    await as(request(app).post("/api/sbt/flights/ssr")).send({ TraceId: "T1", ResultIndex: "RI-D" });
    const r = await as(request(app).post("/api/sbt/flights/checkout")).send({
      kind: "FLIGHT_LCC", mode: "official", quoteIds: [fq.body.quoteId],
      request: { TraceId: "T1", ResultIndex: "RI-D", Passengers: pax(seat) }, save: saveInfo,
    });
    expect(r.body.status).toBe("TICKETED");
    return r;
  }

  it("a seat is charged at TBO's price (no margin); the booking's margin is the fare's only", async () => {
    await bookLcc(true);
    const row: any = await col("sbtpayments").findOne({});
    expect(row.amount).toBe(WS_DOM + 500);
    expect(row.addOnAmount).toBe(500);
    expect(row.margin).toMatchObject({ marginPct: 5, marginSource: "OVERRIDE", marginOverrideId: overrideId, marginVersion: 3, marginAmount: 490 });
    const b: any = await col("sbtbookings").findOne({});
    expect(b).toMatchObject({
      totalFare: WS_DOM + 500, marginAmount: 490, marginPercent: 5,
      marginSource: "OVERRIDE", marginOverrideId: overrideId, marginVersion: 3,
    });
  });

  it("negative flight margin: the customer pays below net, Plumtrips absorbs it, TBO still gets the server's net", async () => {
    await setOverride({ flight: { domestic: -5 } });
    const s = await as(request(app).post("/api/sbt/flights/search")).send({ JourneyType: 1 });
    const fare = s.body.Response.Results[0][0].Fare;
    expect(fare.PublishedFare).toBe(9310); // ceil(9800 × 0.95)
    expect(fare.BaseFare + fare.Tax).toBe(9310); // the discount comes off the base, not a hidden line
    await bookLcc(false);
    const sent = tbo.ticketLCC.mock.calls[0][0] as any;
    expect(sent.Passengers[0].Fare.PublishedFare).toBe(9800);
    expect(sent.Passengers[0].Fare.OfferedFare).toBe(9500);
    const row: any = await col("sbtpayments").findOne({});
    expect(row.amount).toBe(9310);
    const b: any = await col("sbtbookings").findOne({});
    expect(b).toMatchObject({ totalFare: 9310, marginAmount: -490, marginPercent: -5, marginSource: "OVERRIDE" });
  });

  it("reissue: the margin applies to the fare difference; the airline's change fee passes through at cost", async () => {
    const fq = await as(request(app).post("/api/sbt/flights/farequote")).send({ TraceId: "T1", ResultIndex: "RI-R" });
    expect(fq.status).toBe(200);
    const scopeReq = { user: { _id: String(BOOKER), id: String(BOOKER) }, workspaceObjectId: WS, workspaceId: String(WS) };
    // Paid: the WS domestic fare (+ a ₹500 seat, which is not part of the fare).
    const r: any = await reissueFareDifference(scopeReq, { totalFare: WS_DOM + 500, extras: 500 }, "RI-R");
    expect(r.ok).toBe(true);
    // New fare 11000 → ceil(11000 × 1.05) = 11550. Net difference 1200 → 1260 with
    // the 5% margin; the ₹750 change fee is added as is.
    expect(r.newFare).toBe(11550);
    expect(r.reissueCharges).toBe(750);
    expect(r.diff).toBe(1260 + 750);
  });
});

/* ═════════════════════════ hotels ═════════════════════════ */

const hotelSearch = { HotelCodes: ["H1", "H2"], CheckIn: "2026-11-10", CheckOut: "2026-11-12", Rooms: [{ Adults: 1, Children: 0 }], ...LYING };
const totals = (hotels: any[]) => Object.fromEntries(hotels.map((h: any) => [h.HotelCode, h.Rooms[0]._displayTotalFare]));

describe("hotel pricing paths use the caller's company margin, by the hotel master's country", () => {
  it("/search: H1 (India) at the company's domestic, H2 (UAE) at international — despite CountryCode 'IN'", async () => {
    const b = await asWs2(request(app).post("/api/sbt/hotels/search")).send(hotelSearch);
    expect(b.status).toBe(200);
    expect(totals(b.body.Hotels)).toEqual({ H1: 10800, H2: 23000 });
    // WS: −10% on H1 would be 9000, below the supplier's RSP 10500 → RSP.
    const a = await as(request(app).post("/api/sbt/hotels/search")).send(hotelSearch);
    expect(totals(a.body.Hotels)).toEqual({ H1: 10500, H2: 23000 });
    expect(JSON.stringify(a.body)).not.toMatch(/_marginPercent|_isInternational|marginSource/);
  });

  it("/rooms: international from the master, the body's countryCode ignored", async () => {
    const r = await asWs2(request(app).post("/api/sbt/hotels/rooms")).send({ hotelCode: "H2", checkIn: "2026-11-10", checkOut: "2026-11-12", countryCode: "IN" });
    expect(r.status).toBe(200);
    expect(r.body.rooms[0]._displayTotalFare).toBe(23000);
  });

  it("/prebook records the margin on the quote", async () => {
    await asWs2(request(app).post("/api/sbt/hotels/search")).send(hotelSearch);
    const pb = await asWs2(request(app).post("/api/sbt/hotels/prebook")).send({ BookingCode: "H2!TB!1", countryCode: "IN" });
    expect(pb.status).toBe(200);
    expect(pb.body.displayTotalFare).toBe(23000);
    expect(await col("sbtquotes").findOne({ quoteId: pb.body.quoteId })).toMatchObject({
      serverDisplayFare: 23000, marginPct: 15, marginSource: "DEFAULT", marginVersion: 3, isInternational: true, marginAmount: 3000,
    });
  });

  it("concierge hotel search prices like SBT", async () => {
    const r = await as(request(app).post("/api/v1/copilot/travel/hotels/search")).send(hotelSearch);
    expect(r.status).toBe(200);
    expect(totals(r.body.Hotels)).toEqual({ H1: 10500, H2: 23000 });
  });

  it("negative hotel margin: never below the RSP floor; TBO is sent the quote's net; the booking records the margin", async () => {
    await as(request(app).post("/api/sbt/hotels/search")).send(hotelSearch);
    const pb = await as(request(app).post("/api/sbt/hotels/prebook")).send({ BookingCode: "H1!TB!1" });
    expect(pb.body.displayTotalFare).toBe(10500);
    expect(await col("sbtquotes").findOne({ quoteId: pb.body.quoteId })).toMatchObject({
      marginPct: -10, marginSource: "OVERRIDE", marginOverrideId: overrideId, marginAmount: 500,
    });
    const r = await as(request(app).post("/api/sbt/hotels/checkout")).send({
      kind: "HOTEL_BOOK", mode: "official", quoteId: pb.body.quoteId,
      request: {
        BookingCode: "H1!TB!1", GuestNationality: "IN", destinationCountryCode: "IN", NetAmount: 1,
        HotelRoomsDetails: [{ Guests: [{ Title: "Mr", FirstName: "Asha", LastName: "Rao", PaxType: 1, LeadPassenger: true, Phone: "9876543210", Email: "asha@test.com" }] }],
      },
      save: { hotelName: "Hotel One", checkIn: "2026-11-10", checkOut: "2026-11-12", totalFare: 1 },
    });
    expect(r.body.status).toBe("TICKETED");
    expect(hotelBookBodies[0].NetAmount).toBe(10000);
    expect((await col("sbtpayments").findOne({})) as any).toMatchObject({ amount: 10500, margin: { marginPct: -10, marginSource: "OVERRIDE" } });
    expect(await col("sbthotelbookings").findOne({})).toMatchObject({
      totalFare: 10500, netAmount: 10000, marginPercent: -10, marginAmount: 500, marginSource: "OVERRIDE", marginVersion: 3,
    });
  });
});

/* ═════════════════════════ invoices / GST ═════════════════════════ */

describe("GST on a markup ≤ 0 is 0, and the invoice import uses the recorded margin", () => {
  const base = (pricing: Record<string, unknown>) => ({
    workspaceId: WS, bookedBy: oid(), type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    travelDate: new Date("2026-11-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, ...pricing },
  });

  it("sold below cost: no negative GST on the record", async () => {
    const neg: any = await ManualBooking.create(base({ actualPrice: 9800, quotedPrice: 9310 }));
    expect(neg.pricing.gstAmount).toBe(0);
    expect(neg.pricing.markupAmount).toBe(-490);
    expect(neg.pricing.basePrice).toBe(-490);
    expect(neg.pricing.grandTotal).toBe(9310);
    const zero: any = await ManualBooking.create(base({ actualPrice: 9800, quotedPrice: 9800 }));
    expect(zero.pricing.gstAmount).toBe(0);
    const pos: any = await ManualBooking.create(base({ actualPrice: 1000, quotedPrice: 1118 }));
    expect(pos.pricing.gstAmount).toBe(18);
  });

  it("import-from-SBT pricing: cost = paid − recorded margin (add-ons at cost); older bookings unchanged", () => {
    expect(sbtImportPricing({ marginSource: "OVERRIDE", totalFare: 10790, marginAmount: 490, netAmount: 9500, displayAmount: 10790 }))
      .toMatchObject({ actualPrice: 10300, quotedPrice: 10790, gstMode: "ON_MARKUP" });
    expect(sbtImportPricing({ marginSource: "OVERRIDE", totalFare: 9310, marginAmount: -490 }))
      .toMatchObject({ actualPrice: 9800, quotedPrice: 9310 });
    expect(sbtImportPricing({ totalFare: 10780, netAmount: 9500, displayAmount: 10780 }))
      .toMatchObject({ actualPrice: 9500, quotedPrice: 10780 });
  });
});
