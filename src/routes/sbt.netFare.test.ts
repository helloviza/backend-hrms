// apps/backend/src/routes/sbt.netFare.test.ts
//
// SBT net fare stays on the server. Every customer-facing SBT response (flights
// and hotels, every step — search, quote, book / ticket, checkout, booking
// detail) carries selling prices only: no net fare, supplier cost, commission,
// TDS, incentive / PLB, RSP, margin or markup, at any depth. The server — not
// the browser — supplies the net TBO needs: Book / Ticket / hotel Book read it
// from the caller's own SBTQuote (FareQuote / PreBook) and ignore any net value
// the browser sends. Staff endpoints (the SUPERADMIN booking register) still
// see the net and margin.
//
// Real: flights + hotels + booking-register routers, services/sbtFulfil +
//   sbtPaymentGate + sbtQuote, models, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers), TBO flight service calls,
//   TBO hotel HTTP (fetch), Razorpay network calls, mail. Margin forced ON (10%).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { createHmac } from "crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
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
vi.mock("../utils/margin.js", async (orig) => ({
  ...(await orig<any>()),
  getMarginConfig: async () => ({ enabled: true, flight: { domestic: 10, international: 10 }, hotel: { domestic: 10, international: 10 } }),
}));
vi.mock("../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
vi.mock("../services/tbo.log.consolidator.js", () => ({ consolidateCertificationLogs: async () => {} }));
vi.mock("../services/tbo.hotel.shared.js", async (orig) => ({ ...(await orig<any>()), hotelAuthHeader: () => "Basic test" }));
vi.mock("../services/tbo.session.helper.js", () => ({
  withTBOSessionRetry: async (fn: (t: string) => Promise<unknown>) => fn("tok"),
}));
vi.mock("../jobs/static-data-refresh.js", () => ({
  resolveCityCodeAgainstCatalog: () => null,
  resolveCityCode: () => null,
  TBOHotelMaster: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../jobs/deferred-status-check.js", () => ({ runDeferredStatusCheck: async () => {} }));

/* ── TBO flight stubs: a fare with every cost field TBO sends ── */
const NET_FARE = {
  Currency: "INR", BaseFare: 8000, Tax: 1800, YQTax: 600, PublishedFare: 9800, OfferedFare: 9500,
  CommissionEarned: 250, PLBEarned: 30, IncentiveEarned: 20, TdsOnCommission: 12.5, TdsOnPLB: 1.5, TdsOnIncentive: 1,
  AdditionalTxnFeeOfrd: 5, AdditionalTxnFeePub: 5, OtherCharges: 0,
};
const NET_BREAKDOWN = [
  { PassengerType: 1, PassengerCount: 1, Currency: "INR", BaseFare: 8000, Tax: 1800, YQTax: 600, AdditionalTxnFeeOfrd: 5, AdditionalTxnFeePub: 5, PGCharge: 0, TransactionFee: 0 },
];
// The return leg is priced differently, so a mix-up is visible.
const IB_FARE = { ...NET_FARE, BaseFare: 5000, Tax: 1000, PublishedFare: 6000, OfferedFare: 5800, CommissionEarned: 150 };
const IB_BREAKDOWN = [{ ...NET_BREAKDOWN[0], BaseFare: 5000, Tax: 1000 }];
const flightResult = (ri: string, fare = NET_FARE, fb = NET_BREAKDOWN) => ({
  ResultIndex: ri, IsLCC: true, Fare: { ...fare }, FareBreakdown: fb.map((r) => ({ ...r })),
  Segments: [[{ Airline: { AirlineCode: "6E", FlightNumber: "101" }, Origin: { Airport: { AirportCode: "DEL" } }, Destination: { Airport: { AirportCode: "BOM" } } }]],
});
let seq = 0;
const ticketed = (fare = NET_FARE) => ({
  Response: {
    ResponseStatus: 1, TraceId: "T1",
    Response: {
      BookingId: 700000 + (++seq), PNR: `PNR${seq}`,
      FlightItinerary: {
        BookingId: 700000 + seq, PNR: `PNR${seq}`, Fare: { ...fare }, FareBreakdown: NET_BREAKDOWN,
        Passenger: [{ FirstName: "Asha", Fare: { ...fare }, Ticket: { TicketId: 900 + seq } }],
      },
    },
  },
});

const tbo = vi.hoisted(() => ({
  searchFlights: vi.fn(),
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

/* ── TBO hotel stubs (fetch) ── */
const HOTEL_ROOM = {
  Name: ["Deluxe"], BookingCode: "BC1", TotalFare: 10000, TotalTax: 1200, NetAmount: 10000,
  RecommendedSellingRate: 10500, DayRates: [[{ BasePrice: 4400 }, { BasePrice: 4400 }]],
  PriceBreakUp: [{ AgentCommission: 300, RoomRate: 8800 }], MealType: "Room_Only", Inclusion: "Free WiFi",
  IsRefundable: true,
  CancelPolicies: [
    { FromDate: "2026-11-01 00:00:00", ChargeType: "Fixed", CancellationCharge: 0 },
    { FromDate: "2026-11-05 00:00:00", ChargeType: "Fixed", CancellationCharge: 5000 },
  ],
};
const hotelSearchBody = () => ({ Status: { Code: 200 }, HotelResult: [{ HotelCode: "H1", Currency: "INR", TotalFare: 10000, Rooms: [{ ...HOTEL_ROOM }] }] });
let hotelBookBodies: any[] = [];
function stubHotelFetch() {
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    const u = String(url);
    if (/\/book\/?$/i.test(u)) {
      hotelBookBodies.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ BookResult: {
        ResponseStatus: 1, BookingId: 5550000 + (++seq), ConfirmationNo: `CNF${seq}`, BookingRefNo: `REF${seq}`,
        HotelBookingStatus: "Confirmed", Status: 1, IsVoucherBooking: true, VoucherStatus: true, InvoiceNumber: "INV1",
        NetAmount: 10000,
      } }), { status: 200 });
    }
    if (/PreBook/i.test(u)) return new Response(JSON.stringify({ ResponseStatus: 1, ...hotelSearchBody(), ValidationInfo: {} }), { status: 200 });
    return new Response(JSON.stringify(hotelSearchBody()), { status: 200 });
  });
}

const { default: flightsRouter } = await import("./sbt.flights.js");
const { default: hotelsRouter } = await import("./sbt.hotels.js");
const { default: registerRouter } = await import("./sbt.bookingRegister.js");
const { loadFlightNet } = await import("../services/sbtQuote.js");
const app = express();
app.use(express.json());
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/hotels", hotelsRouter);
app.use("/api/admin/sbt/booking-register", registerRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const BOOKER = oid();
const OTHER = oid();
const STAFF = oid();
const HOUSE = "69679a7628330a58d29f2254";

const as = (r: request.Test, userId = BOOKER, ws: string = String(WS), roles = ["CUSTOMER"], email = "u@test") =>
  r.set("x-test-user", JSON.stringify({ _id: String(userId), id: String(userId), sub: String(userId), email, roles }))
    .set("x-test-ws", ws);
const sign = (o: string, p: string) => createHmac("sha256", "rzp_test_secret").update(`${o}|${p}`).digest("hex");

/* ── the deep key scan ── */
const NET_KEYS = [
  "_netPublishedFare", "_netOfferedFare", "_marginPercent", "_marginAmount", "_markupAmount", "_netAmount", "_rsp", "_rspClamped",
  "CommissionEarned", "PLBEarned", "IncentiveEarned", "TdsOnCommission", "TdsOnPLB", "TdsOnIncentive",
  "AdditionalTxnFeeOfrd", "AdditionalTxnFeePub",
  "NetAmount", "netAmount", "NetTax", "DayRates", "RecommendedSellingRate", "recommendedSellingRate",
  "PriceBreakUp", "AgentCommission", "agentCommission", "tds", "isPublishedFare",
  "marginAmount", "marginPercent", "serverNetFare", "supplierResponses",
];
function leaks(v: any, path = "$", hotel = false): string[] {
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  for (const k of Object.keys(v)) {
    if (NET_KEYS.includes(k)) out.push(`${path}.${k}`);
    // Hotel TotalFare is TBO's net (our booking documents use lower-case totalFare).
    if (hotel && k === "TotalFare") out.push(`${path}.${k}`);
    out.push(...leaks(v[k], `${path}.${k}`, hotel));
  }
  return out;
}
/** Flight fare nodes in a customer response: OfferedFare never differs from
 *  PublishedFare (TBO's OfferedFare is our net-of-commission cost). */
function offeredIsSelling(v: any): boolean {
  if (!v || typeof v !== "object") return true;
  if (v.Fare && typeof v.Fare === "object" && "OfferedFare" in v.Fare && v.Fare.OfferedFare !== v.Fare.PublishedFare) return false;
  return Object.values(v).every(offeredIsSelling);
}
const clean = (body: any, hotel = false) => {
  expect(leaks(body, "$", hotel)).toEqual([]);
  expect(offeredIsSelling(body)).toBe(true);
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-net-fare-test"));
  await mongoose.model("SBTPayment").syncIndexes();
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["users", "customerworkspaces", "sbtquotes", "sbtpayments", "sbtssrsnapshots", "sbtbookings",
    "sbthotelbookings", "sbtwalletledgers", "sbtmulticitytraces", "travelbookings", "userpermissions"]) {
    await col(c).deleteMany({});
  }
  await col("users").insertMany([
    { _id: BOOKER, email: "booker@test", sbtEnabled: true, sbtRole: null },
    { _id: OTHER, email: "other@test", sbtEnabled: true, sbtRole: null },
    { _id: STAFF, email: "desk@plumtrips.com", sbtEnabled: true, roles: ["SUPERADMIN"] },
  ] as any[]);
  const month = new Date().toISOString().slice(0, 7);
  await col("customerworkspaces").insertMany([
    { _id: WS, status: "ACTIVE", customerId: oid(), companyName: "Acme",
      sbtOfficialBooking: { enabled: true, monthlyLimit: 0, currentMonthSpend: 0, lastResetMonth: month } },
    { _id: new mongoose.Types.ObjectId(HOUSE), status: "ACTIVE", customerId: oid(), companyName: "Plumtrips",
      sbtOfficialBooking: { enabled: true, monthlyLimit: 0, currentMonthSpend: 0, lastResetMonth: month } },
  ] as any[]);
  for (const m of [...Object.values(tbo), ...Object.values(rzp)]) (m as any).mockReset();
  hotelBookBodies = [];
  tbo.releasePNR.mockResolvedValue({});
  tbo.getBookingDetails.mockResolvedValue(null);
  tbo.searchFlights.mockImplementation(async () => ({
    Response: { ResponseStatus: 1, TraceId: "T1", Results: [[flightResult("RI-1")], [flightResult("RI-2", IB_FARE, IB_BREAKDOWN)]] },
  }));
  tbo.getFareQuote.mockImplementation(async (b: any) => ({
    Response: { ResponseStatus: 1, TraceId: b.TraceId, Results: b.ResultIndex === "RI-2"
      ? flightResult("RI-2", IB_FARE, IB_BREAKDOWN) : flightResult(b.ResultIndex) },
  }));
  tbo.getPriceRBD.mockImplementation(async () => ({ Response: { ResponseStatus: 1, Results: [[flightResult("RBD-1")]] } }));
  tbo.getSSR.mockImplementation(async () => ({ Response: { ResponseStatus: 1, SeatDynamic: [] } }));
  tbo.ticketLCC.mockImplementation(async (p: any) => ticketed(p.ResultIndex === "RI-2" ? IB_FARE : NET_FARE));
  rzp.createRazorpayOrder.mockImplementation(async (paise: number) => ({ id: `order_${++seq}`, amount: paise, currency: "INR" }));
  rzp.refundRazorpayPayment.mockImplementation(async (_p: string, amt: number) => ({ id: `rfnd_${++seq}`, amount: amt }));
  stubHotelFetch();
});
afterEach(() => vi.unstubAllGlobals());

/* ── helpers ── */
async function quote(ri = "RI-1", userId = BOOKER, ws = String(WS)) {
  const fq = await as(request(app).post("/api/sbt/flights/farequote"), userId, ws).send({ TraceId: "T1", ResultIndex: ri, originCountry: "IN", destCountry: "IN" });
  expect(fq.status).toBe(200);
  return fq;
}
const TAMPERED_FARE = { BaseFare: 1, Tax: 1, PublishedFare: 2, OfferedFare: 1, CommissionEarned: 99999, Currency: "INR" };
const pax = (fare: any = TAMPERED_FARE) => [{ Title: "Mr", FirstName: "Asha", LastName: "Rao", PaxType: 1, IsLeadPax: true, Fare: { ...fare } }];
const saveInfo = {
  origin: { code: "DEL", city: "Delhi" }, destination: { code: "BOM", city: "Mumbai" },
  departureTime: "2026-11-01T06:00:00", arrivalTime: "2026-11-01T08:00:00",
  airlineCode: "6E", airlineName: "IndiGo", flightNumber: "101",
  // The browser now only knows the selling base; the stored record must not take it.
  baseFare: 8800, taxes: 1800, totalFare: 10780,
  passengers: [{ firstName: "Asha", lastName: "Rao", paxType: "adult", isLead: true }],
};
async function payCheckout(c: any) {
  const pid = `pay_${c.orderId}`;
  rzp.fetchRazorpayPayment.mockResolvedValueOnce({ id: pid, order_id: c.orderId, amount: c.amount, currency: "INR", status: "captured" });
  return as(request(app).post(`/api/sbt/flights/checkout/${c.checkoutId}/pay`)).send({
    razorpay_order_id: c.orderId, razorpay_payment_id: pid, razorpay_signature: sign(c.orderId, pid),
  });
}
const sellingOf = (published: number) => Math.round(published * 1.1 * 100) / 100;

/* ═════════════════════════ flights ═════════════════════════ */

describe("flight customer responses carry selling prices only", () => {
  it("/search: no cost field anywhere; base + tax = the selling total", async () => {
    const r = await as(request(app).post("/api/sbt/flights/search"))
      .send({ JourneyType: 2, origin: "DEL", destination: "BOM", originCountry: "IN", destCountry: "IN" });
    expect(r.status).toBe(200);
    clean(r.body);
    const fare = r.body.Response.Results[0][0].Fare;
    expect(fare.PublishedFare).toBe(sellingOf(9800));
    expect(fare.OfferedFare).toBe(sellingOf(9800));
    expect(fare.BaseFare + fare.Tax).toBeCloseTo(fare.PublishedFare, 2);
    const fb = r.body.Response.Results[0][0].FareBreakdown[0];
    expect(fb.BaseFare + fb.Tax).toBeCloseTo(fare.PublishedFare, 2);
  });

  it("/search-multi-city and /price-rbd", async () => {
    const mc = await as(request(app).post("/api/sbt/flights/search-multi-city"))
      .send({ legs: [{ Origin: "DEL", Destination: "BOM" }, { Origin: "BOM", Destination: "GOI" }] });
    expect(mc.status).toBe(200);
    expect(mc.body.legs[0].results.length).toBeGreaterThan(0);
    clean(mc.body);
    const rbd = await as(request(app).post("/api/sbt/flights/price-rbd")).send({ TraceId: "T1", AirSearchResult: [] });
    expect(rbd.status).toBe(200);
    clean(rbd.body);
  });

  it("/farequote: selling only to the customer; TBO's own Fare + FareBreakdown stored on the quote", async () => {
    const fq = await quote();
    clean(fq.body);
    expect(fq.body.Response.Results.Fare.PublishedFare).toBe(sellingOf(9800));
    const q: any = await col("sbtquotes").findOne({ quoteId: fq.body.quoteId });
    expect(q.netFare).toEqual(NET_FARE);
    expect(q.netFareBreakdown).toEqual(NET_BREAKDOWN);
    expect(q.sellingFare).toBe(sellingOf(9800));
    expect(q.userId).toBe(String(BOOKER));
    expect(q.workspaceId).toBe(String(WS));
  });

  it("/farequote refuses when the quote cannot be stored (the net would be lost)", async () => {
    const SBTQuote = mongoose.model("SBTQuote");
    const spy = vi.spyOn(SBTQuote, "create").mockRejectedValueOnce(new Error("db down") as never);
    const r = await as(request(app).post("/api/sbt/flights/farequote")).send({ TraceId: "T1", ResultIndex: "RI-1" });
    spy.mockRestore();
    expect(r.status).toBe(503);
    clean(r.body);
  });
});

describe("flight booking: the server supplies the net, the browser's is ignored", () => {
  it("LCC checkout: TBO gets the stored net per passenger, not the tampered client Fare; responses are clean", async () => {
    const fq = await quote();
    const c = await as(request(app).post("/api/sbt/flights/checkout")).send({
      kind: "FLIGHT_LCC", mode: "personal", quoteIds: [fq.body.quoteId],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax() }, save: saveInfo,
    });
    expect(c.status).toBe(200);
    clean(c.body);
    expect(c.body.serverAmount).toBe(Math.ceil(sellingOf(9800)));
    const done = await payCheckout(c.body);
    expect(done.body.status).toBe("TICKETED");
    clean(done.body);

    expect(tbo.ticketLCC).toHaveBeenCalledTimes(1);
    const sent = tbo.ticketLCC.mock.calls[0][0].Passengers[0].Fare;
    expect(sent.OfferedFare).toBe(NET_FARE.OfferedFare);
    expect(sent.PublishedFare).toBe(NET_FARE.PublishedFare);
    expect(sent.BaseFare).toBe(NET_BREAKDOWN[0].BaseFare);
    expect(sent.Tax).toBe(NET_BREAKDOWN[0].Tax);
    expect(sent.CommissionEarned).toBe(NET_FARE.CommissionEarned);
    expect(sent.TdsOnCommission).toBe(NET_FARE.TdsOnCommission);

    // The stored record keeps TBO's real fare and our net — from the server's copy.
    const b: any = await col("sbtbookings").findOne({});
    expect(b.netAmount).toBe(NET_FARE.OfferedFare);
    expect(b.baseFare).toBe(NET_FARE.BaseFare);
    expect(b.taxes).toBe(NET_FARE.Tax);
    expect(b.totalFare).toBe(Math.ceil(sellingOf(9800)));
    expect(b.raw.Response.Response.FlightItinerary.Fare.CommissionEarned).toBe(NET_FARE.CommissionEarned);
  });

  it("split return: each leg is ticketed with its OWN quote's net", async () => {
    const ob = await quote("RI-1");
    const ib = await quote("RI-2");
    const c = await as(request(app).post("/api/sbt/flights/checkout")).send({
      kind: "FLIGHT_LCC", mode: "personal", quoteIds: [ob.body.quoteId, ib.body.quoteId],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax(), isReturn: true, returnResultIndex: "RI-2",
        returnTraceId: "T1", returnPassengers: pax() },
      save: saveInfo,
    });
    const done = await payCheckout(c.body);
    expect(done.body.status).toBe("TICKETED");
    clean(done.body);
    const calls = tbo.ticketLCC.mock.calls.map((x: any[]) => x[0]);
    expect(calls.find((p: any) => p.ResultIndex === "RI-1").Passengers[0].Fare.OfferedFare).toBe(NET_FARE.OfferedFare);
    expect(calls.find((p: any) => p.ResultIndex === "RI-2").Passengers[0].Fare.OfferedFare).toBe(IB_FARE.OfferedFare);
    const b: any = await col("sbtbookings").findOne({});
    expect(b.netAmount).toBe(NET_FARE.OfferedFare + IB_FARE.OfferedFare);
  });

  it("GDS checkout: Book is sent the stored net; Book and Ticket replies carry no fares", async () => {
    tbo.getFareQuote.mockImplementation(async (b: any) => ({
      Response: { ResponseStatus: 1, TraceId: b.TraceId, Results: { ...flightResult(b.ResultIndex), IsLCC: false } },
    }));
    tbo.bookFlight.mockImplementation(async () => ({
      Response: { ResponseStatus: 1, Response: { PNR: "GDS1", BookingId: 8100, FlightItinerary: { Fare: { ...NET_FARE }, Passenger: [{ Fare: { ...NET_FARE } }] } } },
    }));
    tbo.ticketFlight.mockImplementation(async () => ticketed());
    const fq = await quote();
    const c = await as(request(app).post("/api/sbt/flights/checkout")).send({
      kind: "FLIGHT_GDS", mode: "personal", quoteIds: [fq.body.quoteId],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax(), isLCC: false }, save: saveInfo,
    });
    const done = await payCheckout(c.body);
    expect(done.body.status).toBe("TICKETED");
    clean(done.body);
    expect(tbo.bookFlight.mock.calls[0][0].Passengers[0].Fare.OfferedFare).toBe(NET_FARE.OfferedFare);
  });

  it("a quote without a stored net (taken before this release) is never filled from the browser", async () => {
    await col("sbtquotes").insertOne({
      quoteId: "old-q", product: "FLIGHT", serverDisplayFare: 10450, serverNetFare: 9500, sourceRef: "T1:RI-1",
      userId: String(BOOKER), workspaceId: String(WS), resultIndexes: ["RI-1"], traceIds: ["T1"],
      sellingFare: 10780, createdAt: new Date(),
    } as any);
    const c = await as(request(app).post("/api/sbt/flights/checkout")).send({
      kind: "FLIGHT_LCC", mode: "personal", quoteIds: ["old-q"],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax(NET_FARE) }, save: saveInfo,
    });
    const done = await payCheckout(c.body);
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
    expect(done.body.status).toBe("REFUNDED");
  });

  it("loadFlightNet: another user's / workspace's quote, or an expired one, is FARE_EXPIRED", async () => {
    const theirs = (await quote("RI-1", OTHER)).body.quoteId;
    const asReq = (quoteIds: string[], userId = BOOKER, ws = WS) =>
      ({ user: { _id: String(userId) }, workspaceObjectId: ws, body: { quoteIds } });
    const r1: any = await loadFlightNet(asReq([theirs]), { resultIndex: "RI-1" });
    expect(r1.code).toBe("FARE_EXPIRED");
    expect(r1.status).toBe(410);
    expect(r1.error).toBe("Fare expired, please search again");
    const mine = (await quote()).body.quoteId;
    await col("sbtquotes").updateOne({ quoteId: mine }, { $set: { createdAt: new Date(Date.now() - 2 * 3600 * 1000) } });
    const r2: any = await loadFlightNet(asReq([mine]), { resultIndex: "RI-1" });
    expect(r2.code).toBe("FARE_EXPIRED");
    const fresh = (await quote()).body.quoteId;
    const r3: any = await loadFlightNet(asReq([fresh]), { resultIndex: "RI-OTHER" });
    expect(r3.code).toBe("FARE_EXPIRED");
    const r4: any = await loadFlightNet(asReq([fresh]), { resultIndex: "RI-1" });
    expect(r4.ok).toBe(true);
  });

  it("booking detail, list and the save reply carry no net, margin or TBO fare", async () => {
    const fq = await quote();
    const c = await as(request(app).post("/api/sbt/flights/checkout")).send({
      kind: "FLIGHT_LCC", mode: "official", quoteIds: [fq.body.quoteId],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax() }, save: saveInfo,
    });
    expect(c.body.status).toBe("TICKETED");
    clean(c.body);
    const id = c.body.result.bookingDocId;
    const list = await as(request(app).get("/api/sbt/flights/bookings"));
    expect(list.body.bookings).toHaveLength(1);
    clean(list.body);
    expect(JSON.stringify(list.body)).not.toContain('"Fare"');
    const one = await as(request(app).get(`/api/sbt/flights/bookings/${id}`));
    clean(one.body);
    const bk = one.body.booking;
    expect(bk.baseFare + bk.taxes).toBe(bk.totalFare); // the margin folded into the base
    expect(bk.baseFare).not.toBe(NET_FARE.BaseFare);
  });

  it("staff direct route (SUPERADMIN, wallet): TBO payload uses the stored net; reply has no fares", async () => {
    const fq = await quote("RI-1", STAFF, HOUSE);
    const r = await as(request(app).post("/api/sbt/flights/ticket-lcc"), STAFF, HOUSE, ["SUPERADMIN"]).send({
      TraceId: "T1", ResultIndex: "RI-1", Passengers: pax(), quoteIds: [fq.body.quoteId], paymentMode: "official",
    });
    expect(r.status).toBe(200);
    clean(r.body);
    expect(JSON.stringify(r.body)).not.toContain('"Fare"');
    expect(tbo.ticketLCC.mock.calls[0][0].Passengers[0].Fare.OfferedFare).toBe(NET_FARE.OfferedFare);
    // The full supplier response is kept server-side for the booking save.
    const row: any = await col("sbtpayments").findOne({});
    expect(row.supplierResponses[0].response.Response.Response.FlightItinerary.Fare.OfferedFare).toBe(NET_FARE.OfferedFare);
  });

  it("staff still see net and margin: the SUPERADMIN booking register", async () => {
    const fq = await quote();
    await as(request(app).post("/api/sbt/flights/checkout")).send({
      kind: "FLIGHT_LCC", mode: "official", quoteIds: [fq.body.quoteId],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax() }, save: saveInfo,
    });
    const reg = await as(request(app).get("/api/admin/sbt/booking-register?type=air"), STAFF, HOUSE, ["SUPERADMIN"], "desk@plumtrips.com");
    expect(reg.status).toBe(200);
    const row = reg.body.rows[0];
    expect(row.net).toBe(NET_FARE.OfferedFare);
    expect(row.fare).toBe(NET_FARE.BaseFare);
    // The margin the FareQuote recorded (selling − the PublishedFare it was
    // applied to) — not charged − OfferedFare, which also counted commission.
    expect(row.margin).toBe(Math.ceil(sellingOf(9800)) - NET_FARE.PublishedFare);
  });
});

/* ═════════════════════════ hotels ═════════════════════════ */

const searchBody = { HotelCodes: ["H1"], CheckIn: "2026-11-10", CheckOut: "2026-11-12", Rooms: [{ Adults: 1, Children: 0 }], CountryCode: "IN" };
const guests = [{ Title: "Mr", FirstName: "Asha", LastName: "Rao", PaxType: 1, LeadPassenger: true, Phone: "9876543210", Email: "asha@test.com" }];

async function prebook(userId = BOOKER) {
  await as(request(app).post("/api/sbt/hotels/search"), userId).send(searchBody);
  const pb = await as(request(app).post("/api/sbt/hotels/prebook"), userId).send({ BookingCode: "BC1", searchPrice: 11000, countryCode: "IN" });
  expect(pb.status).toBe(200);
  return pb;
}

describe("hotel customer responses carry selling prices only", () => {
  it("/search and /rooms: rooms from the allow-list — selling total, per-night selling, amount-free cancellation", async () => {
    const s = await as(request(app).post("/api/sbt/hotels/search")).send(searchBody);
    expect(s.status).toBe(200);
    clean(s.body, true);
    const room = s.body.Hotels[0].Rooms[0];
    expect(room._displayTotalFare).toBe(11000);
    expect(room._displayPerNight).toBe((11000 - 1200) / 2);
    expect(room.TotalTax).toBe(1200);
    expect(room.BookingCode).toBe("BC1");
    expect(room.Inclusion).toBe("Free WiFi");
    expect(room.CancelPolicies).toEqual([
      { FromDate: "2026-11-01 00:00:00", ChargeType: "Percentage", CancellationCharge: 0 },
      { FromDate: "2026-11-05 00:00:00", ChargeType: "Percentage", CancellationCharge: 50 },
    ]);
    const rooms = await as(request(app).post("/api/sbt/hotels/rooms")).send({ hotelCode: "H1", checkIn: "2026-11-10", checkOut: "2026-11-12" });
    expect(rooms.status).toBe(200);
    clean(rooms.body, true);
    expect(rooms.body.rooms[0]._displayTotalFare).toBe(11000);
  });

  it("/prebook: no NetAmount / RSP / commission / TDS; the quote keeps them", async () => {
    const pb = await prebook();
    clean(pb.body, true);
    expect(pb.body.displayTotalFare).toBe(11000);
    expect(pb.body.priceChanged).toBe(false);
    expect(pb.body.HotelResult[0].Rooms[0]._displayTotalFare).toBe(11000);
    const q: any = await col("sbtquotes").findOne({ quoteId: pb.body.quoteId });
    expect(q.netAmount).toBe(10000);
    expect(q.recommendedSellingRate).toBe(10500);
    expect(q.agentCommission).toBe(300);
    expect(q.tds).toBe(6);
    expect(q.cancelPolicies[1].CancellationCharge).toBe(5000);
  });

  it("/prebook compares the SELLING price the customer saw", async () => {
    await as(request(app).post("/api/sbt/hotels/search")).send(searchBody);
    const pb = await as(request(app).post("/api/sbt/hotels/prebook")).send({ BookingCode: "BC1", searchPrice: 10000, countryCode: "IN" });
    expect(pb.body.priceChanged).toBe(true);
    expect(pb.body.priceDiff).toBe(1000);
  });
});

describe("hotel booking: the server supplies NetAmount and the RSP floor", () => {
  const book = (quoteId: string, extra: Record<string, any> = {}) =>
    as(request(app).post("/api/sbt/hotels/checkout")).send({
      kind: "HOTEL_BOOK", mode: "official", quoteId,
      request: {
        BookingCode: "BC1", GuestNationality: "IN", destinationCountryCode: "IN", HotelRoomsDetails: [{ Guests: guests }],
        // Tampered browser values — all ignored.
        NetAmount: 1, recommendedSellingRate: 1, customerChargedAmount: 1, ...extra,
      },
      save: { hotelName: "Hotel One", checkIn: "2026-11-10", checkOut: "2026-11-12", netAmount: 1, tds: 0, agentCommission: 0, isPublishedFare: false, totalFare: 1 },
    });

  it("TBO Book gets the quote's NetAmount; the booking stores our cost from the server; replies are clean", async () => {
    const pb = await prebook();
    const r = await book(pb.body.quoteId);
    expect(r.body.status).toBe("TICKETED");
    clean(r.body, true);
    expect(hotelBookBodies).toHaveLength(1);
    expect(hotelBookBodies[0].NetAmount).toBe(10000);
    const b: any = await col("sbthotelbookings").findOne({});
    expect(b.netAmount).toBe(10000);
    expect(b.agentCommission).toBe(300);
    expect(b.tds).toBe(6);
    expect(b.recommendedSellingRate).toBe(10500);
    expect(b.totalFare).toBe(11000);
    expect(b.cancelPolicies[1].CancellationCharge).toBe(5000); // TBO's real tiers stay on the record
    const list = await as(request(app).get("/api/sbt/hotels/bookings"));
    expect(list.body.bookings).toHaveLength(1);
    clean(list.body, true);
    expect(list.body.bookings[0].cancelPolicies[1]).toEqual({ FromDate: "2026-11-05 00:00:00", ChargeType: "Percentage", CancellationCharge: 50 });
    const reg = await as(request(app).get("/api/admin/sbt/booking-register?type=hotel"), STAFF, HOUSE, ["SUPERADMIN"], "desk@plumtrips.com");
    expect(JSON.stringify(reg.body)).toContain("10000");
  });

  it("the RSP floor is checked against the server's quote, never the browser's", async () => {
    const pb = await prebook();
    // The server's price is below the supplier floor on this quote.
    await col("sbtquotes").updateOne({ quoteId: pb.body.quoteId }, { $set: { recommendedSellingRate: 99999 } });
    const v = await as(request(app).post("/api/sbt/hotels/validate-before-payment"))
      .send({ BookingCode: "BC1", HotelRoomsDetails: [{ Guests: guests }], recommendedSellingRate: 0, customerChargedAmount: 999999 });
    expect(v.status).toBe(400);
    expect(v.body.code).toBe("RSP_FLOOR_VIOLATED");
    clean(v.body, true);
    expect(JSON.stringify(v.body)).not.toContain("99999");
    // And a browser-sent floor cannot block a valid price.
    await col("sbtquotes").updateOne({ quoteId: pb.body.quoteId }, { $set: { recommendedSellingRate: 10500 } });
    const ok = await as(request(app).post("/api/sbt/hotels/validate-before-payment"))
      .send({ BookingCode: "BC1", HotelRoomsDetails: [{ Guests: guests }], recommendedSellingRate: 999999, customerChargedAmount: 1 });
    expect(ok.body.code).not.toBe("RSP_FLOOR_VIOLATED");
  });

  it("a hold without the caller's own PreBook quote is FARE_EXPIRED (never a browser NetAmount)", async () => {
    await prebook(OTHER);
    const r = await as(request(app).post("/api/sbt/hotels/book")).send({
      BookingCode: "BC1", bookingMode: "hold", GuestNationality: "IN", destinationCountryCode: "IN",
      HotelRoomsDetails: [{ Guests: guests }], NetAmount: 10000,
    });
    expect(r.status).toBe(410);
    expect(r.body.code).toBe("FARE_EXPIRED");
    expect(hotelBookBodies).toHaveLength(0);
  });
});
