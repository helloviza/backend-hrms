// apps/backend/src/routes/sbt.requestBooking.test.ts
//
// SBT Flow 1: an L2 / Workspace Leader books an L1's request through the SAME
// checkout as any SBT booking (server quote → card or company wallet →
// server-side fulfilment). The request moves to BOOKED only once that checkout
// is paid and ticketed; the booking links back to it and is owned by the
// requester; the stored total is the server selling price (net only in the
// staff field). The old direct "book this request" route books nothing.
//
// Real: requests + flights + hotels routers, services/sbtFulfil + sbtPaymentGate
//   + sbtQuote + sbtRequestBooking, models, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers), TBO flight service, TBO hotel
//   HTTP (fetch), Razorpay network calls, mail. Margin forced ON (10%) so the
//   selling price differs from the net.
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
      _id: req.workspaceObjectId, status: "ACTIVE", tenantType: "CORPORATE", customerId: CUSTOMER,
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

const NET_FARE = { Currency: "INR", BaseFare: 8000, Tax: 1800, PublishedFare: 9800, OfferedFare: 9500, CommissionEarned: 250 };
const NET_BREAKDOWN = [{ PassengerType: 1, PassengerCount: 1, Currency: "INR", BaseFare: 8000, Tax: 1800 }];
const SELLING = Math.ceil(9800 * 1.1); // 10780 — what the customer pays
let seq = 0;

const tbo = vi.hoisted(() => ({
  getFareQuote: vi.fn(),
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

/* hotel TBO over fetch */
const HOTEL_ROOM = {
  Name: ["Deluxe"], BookingCode: "BC1", TotalFare: 10000, TotalTax: 1200, NetAmount: 10000,
  DayRates: [[{ BasePrice: 4400 }, { BasePrice: 4400 }]], MealType: "Room_Only", IsRefundable: true,
};
const hotelSearchBody = () => ({ Status: { Code: 200 }, HotelResult: [{ HotelCode: "H1", Currency: "INR", Rooms: [{ ...HOTEL_ROOM }] }] });
let hotelBookBodies: any[] = [];
function stubHotelFetch() {
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    const u = String(url);
    if (/\/book\/?$/i.test(u)) {
      const body = JSON.parse(String(init?.body || "{}"));
      hotelBookBodies.push(body);
      const hold = body.IsVoucherBooking === false;
      return new Response(JSON.stringify({ BookResult: {
        ResponseStatus: 1, BookingId: 5550000 + (++seq), ConfirmationNo: `CNF${seq}`, BookingRefNo: `REF${seq}`,
        HotelBookingStatus: "Confirmed", Status: 1, IsVoucherBooking: !hold, VoucherStatus: !hold,
      } }), { status: 200 });
    }
    if (/PreBook/i.test(u)) return new Response(JSON.stringify({ ResponseStatus: 1, ...hotelSearchBody(), ValidationInfo: {} }), { status: 200 });
    return new Response(JSON.stringify(hotelSearchBody()), { status: 200 });
  });
}

const { default: requestsRouter } = await import("./sbt.requests.js");
const { default: flightsRouter } = await import("./sbt.flights.js");
const { default: hotelsRouter } = await import("./sbt.hotels.js");
const app = express();
app.use(express.json());
app.use("/api/sbt/requests", requestsRouter);
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/hotels", hotelsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const CUSTOMER = oid();
const WS = oid();
const REQUESTER = oid(); // L1
const L2 = oid(); // the request's assigned booker
const OTHER_L2 = oid(); // an L2 the request is NOT assigned to
const WL = oid(); // Workspace Leader
let REQ_ID: mongoose.Types.ObjectId;

const as = (r: request.Test, userId: mongoose.Types.ObjectId, roles: string[] = ["CUSTOMER"]) =>
  r.set("x-test-user", JSON.stringify({ _id: String(userId), id: String(userId), sub: String(userId), email: `${userId}@test`, roles }))
    .set("x-test-ws", String(WS));
const sign = (o: string, p: string) => createHmac("sha256", "rzp_test_secret").update(`${o}|${p}`).digest("hex");
const req = async () => (await col("sbtrequests").findOne({ _id: REQ_ID })) as any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-request-booking-test"));
  await mongoose.model("SBTPayment").syncIndexes();
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

async function seedRequest(type: "flight" | "hotel") {
  REQ_ID = oid();
  await col("sbtrequests").insertOne({
    _id: REQ_ID, workspaceId: WS, customerId: CUSTOMER, requesterId: REQUESTER, assignedBookerId: L2, type,
    searchParams: { origin: "DEL", destination: "BOM", departDate: "2026-11-01" },
    selectedOption: { ResultIndex: "RI-1", Fare: { ...NET_FARE } },
    status: "PENDING", bookingId: null, hotelBookingId: null, requestedAt: new Date(),
    passengerDetails: [{ firstName: "Lata", lastName: "Iyer", gender: "Female", paxType: "adult" }],
    contactDetails: { email: "lata@test", phone: "9876543210" },
  } as any);
}

beforeEach(async () => {
  for (const c of ["users", "customerworkspaces", "sbtquotes", "sbtpayments", "sbtssrsnapshots", "sbtbookings",
    "sbthotelbookings", "sbtwalletledgers", "sbtmulticitytraces", "sbtrequests", "travelbookings", "userpermissions"]) {
    await col(c).deleteMany({});
  }
  await col("users").insertMany([
    { _id: REQUESTER, email: "lata@test", name: "Lata Iyer", customerId: CUSTOMER, sbtEnabled: true, sbtRole: "L1", roles: ["CUSTOMER"] },
    { _id: L2, email: "l2@test", customerId: CUSTOMER, sbtEnabled: true, sbtRole: "L2", roles: ["CUSTOMER"] },
    { _id: OTHER_L2, email: "l2b@test", customerId: CUSTOMER, sbtEnabled: true, sbtRole: "L2", roles: ["CUSTOMER"] },
    { _id: WL, email: "wl@test", customerId: CUSTOMER, sbtEnabled: true, roles: ["WORKSPACE_LEADER"] },
  ] as any[]);
  await col("customerworkspaces").insertOne({
    _id: WS, status: "ACTIVE", customerId: CUSTOMER,
    sbtOfficialBooking: { enabled: true, monthlyLimit: 0, currentMonthSpend: 0, lastResetMonth: new Date().toISOString().slice(0, 7) },
  } as any);
  for (const m of [...Object.values(tbo), ...Object.values(rzp)]) (m as any).mockReset();
  hotelBookBodies = [];
  tbo.releasePNR.mockResolvedValue({});
  tbo.getBookingDetails.mockResolvedValue(null);
  tbo.getFareQuote.mockImplementation(async (b: any) => ({
    Response: { ResponseStatus: 1, TraceId: b.TraceId, Results: { ResultIndex: b.ResultIndex, IsLCC: true, Fare: { ...NET_FARE }, FareBreakdown: NET_BREAKDOWN } },
  }));
  tbo.getSSR.mockImplementation(async () => ({ Response: { ResponseStatus: 1 } }));
  tbo.ticketLCC.mockImplementation(async () => ({
    Response: { ResponseStatus: 1, TraceId: "T1", Response: { BookingId: 700000 + (++seq), PNR: `PNR${seq}`,
      FlightItinerary: { Fare: { ...NET_FARE }, Passenger: [{ Ticket: { TicketId: 900 + seq } }] } } },
  }));
  rzp.createRazorpayOrder.mockImplementation(async (paise: number) => ({ id: `order_${++seq}`, amount: paise, currency: "INR" }));
  rzp.refundRazorpayPayment.mockImplementation(async (_p: string, amt: number) => ({ id: `rfnd_${++seq}`, amount: amt }));
  stubHotelFetch();
});
afterEach(() => vi.unstubAllGlobals());

/* ── flight helpers ── */
async function quote(userId: mongoose.Types.ObjectId, roles?: string[]) {
  const fq = await as(request(app).post("/api/sbt/flights/farequote"), userId, roles).send({ TraceId: "T1", ResultIndex: "RI-1" });
  expect(fq.status).toBe(200);
  return fq.body.quoteId as string;
}
const save = (extra: Record<string, any> = {}) => ({
  origin: { code: "DEL", city: "Delhi" }, destination: { code: "BOM", city: "Mumbai" },
  departureTime: "2026-11-01T06:00:00", arrivalTime: "2026-11-01T08:00:00",
  airlineCode: "6E", airlineName: "IndiGo", flightNumber: "101", baseFare: 1, taxes: 0, totalFare: 1,
  passengers: [{ firstName: "Lata", lastName: "Iyer", paxType: "adult", isLead: true }],
  sbtRequestId: String(REQ_ID), ...extra,
});
const checkout = (userId: mongoose.Types.ObjectId, q: string, mode: "personal" | "official", roles?: string[]) =>
  as(request(app).post("/api/sbt/flights/checkout"), userId, roles).send({
    kind: "FLIGHT_LCC", mode, quoteIds: [q],
    request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: [{ Title: "Ms", FirstName: "Lata", LastName: "Iyer", PaxType: 1, IsLeadPax: true }] },
    save: save(),
  });
async function pay(c: any, userId: mongoose.Types.ObjectId) {
  const pid = `pay_${c.orderId}`;
  rzp.fetchRazorpayPayment.mockResolvedValueOnce({ id: pid, order_id: c.orderId, amount: c.amount, currency: "INR", status: "captured" });
  return as(request(app).post(`/api/sbt/flights/checkout/${c.checkoutId}/pay`), userId).send({
    razorpay_order_id: c.orderId, razorpay_payment_id: pid, razorpay_signature: sign(c.orderId, pid),
  });
}

describe("the old direct 'book this request' route books nothing", () => {
  it("403 CHECKOUT_REQUIRED for the assigned L2 and for a Workspace Leader — no TBO call, no booking, request PENDING", async () => {
    await seedRequest("flight");
    for (const [who, roles] of [[L2, ["CUSTOMER"]], [WL, ["WORKSPACE_LEADER"]]] as const) {
      const r = await as(request(app).post(`/api/sbt/requests/${REQ_ID}/book`), who, [...roles]).send({ bookerNotes: "x" });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("CHECKOUT_REQUIRED");
    }
    expect(tbo.getFareQuote).not.toHaveBeenCalled();
    expect(tbo.bookFlight).not.toHaveBeenCalled();
    expect(await col("sbtbookings").countDocuments({})).toBe(0);
    expect((await req()).status).toBe("PENDING");
  });
});

describe("an L2 / Workspace Leader books a request through checkout", () => {
  it("card: nothing is booked and the request stays PENDING until paid; once paid + ticketed it is BOOKED at the selling price", async () => {
    await seedRequest("flight");
    const c = await checkout(L2, await quote(L2), "personal");
    expect(c.status).toBe(200);
    expect(c.body.serverAmount).toBe(SELLING);
    // Created, not paid: no ticket, no booking, request untouched.
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
    expect(await col("sbtbookings").countDocuments({})).toBe(0);
    expect((await req()).status).toBe("PENDING");

    const done = await pay(c.body, L2);
    expect(done.body.status).toBe("TICKETED");
    const b: any = await col("sbtbookings").findOne({});
    const r = await req();
    expect(r.status).toBe("BOOKED");
    expect(String(r.bookingId)).toBe(String(b._id));
    expect(String(b.sbtRequestId)).toBe(String(REQ_ID));
    expect(String(b.userId)).toBe(String(REQUESTER)); // the traveller owns it
    expect(b.totalFare).toBe(SELLING); // server selling price, never net
    expect(b.paymentStatus).toBe("paid");
    expect(b.netAmount).toBe(NET_FARE.OfferedFare); // net only in the staff field
    const row: any = await col("sbtpayments").findOne({});
    expect(row.amount).toBe(SELLING);
    expect(row.status).toBe("TICKETED");
  });

  it("company wallet (Workspace Leader): ledgered, ticketed, request BOOKED", async () => {
    await seedRequest("flight");
    const r = await checkout(WL, await quote(WL, ["WORKSPACE_LEADER"]), "official", ["WORKSPACE_LEADER"]);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("TICKETED");
    expect((await req()).status).toBe("BOOKED");
    const ledger: any = await col("sbtwalletledgers").findOne({ type: "DEBIT" });
    expect(ledger.amount).toBe(SELLING);
    const b: any = await col("sbtbookings").findOne({});
    expect(b.totalFare).toBe(SELLING);
    expect(b.paymentMode).toBe("official");
  });

  it("ticketing fails → refunded, no booking, request stays PENDING", async () => {
    await seedRequest("flight");
    tbo.ticketLCC.mockResolvedValueOnce({ Response: { ResponseStatus: 2, Error: { ErrorMessage: "Fare not available" } } });
    const c = await checkout(L2, await quote(L2), "personal");
    const done = await pay(c.body, L2);
    expect(done.body.status).toBe("REFUNDED");
    expect(await col("sbtbookings").countDocuments({})).toBe(0);
    expect((await req()).status).toBe("PENDING");
  });

  it("an L2 the request is not assigned to is refused before any payment order", async () => {
    await seedRequest("flight");
    const r = await checkout(OTHER_L2, await quote(OTHER_L2), "personal");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("REQUEST_NOT_BOOKABLE");
    expect(rzp.createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("a request already BOOKED cannot be booked again", async () => {
    await seedRequest("flight");
    await col("sbtrequests").updateOne({ _id: REQ_ID }, { $set: { status: "BOOKED" } });
    const r = await checkout(L2, await quote(L2), "official");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("REQUEST_NOT_BOOKABLE");
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("L1 still cannot book (their own request either)", async () => {
    await seedRequest("flight");
    const r = await checkout(REQUESTER, await quote(REQUESTER), "official");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("NOT_BOOKER");
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
    expect((await req()).status).toBe("PENDING");
  });

  it("a booking save naming someone else's request does not link it or change its owner", async () => {
    await seedRequest("flight");
    // OTHER_L2 books for themselves but names the request in the save body.
    const q = await quote(OTHER_L2);
    const r = await as(request(app).post("/api/sbt/flights/checkout"), OTHER_L2).send({
      kind: "FLIGHT_LCC", mode: "official", quoteIds: [q],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: [{ Title: "Mr", FirstName: "A", LastName: "B", PaxType: 1 }] },
      save: save({ sbtRequestId: undefined, common: undefined }),
    });
    expect(r.body.status).toBe("TICKETED");
    // and a direct save naming it (no checkout) is not linked either
    const s = await as(request(app).post("/api/sbt/flights/bookings/save"), OTHER_L2)
      .send({ ...save(), pnr: "X1", bookingId: String(r.body.result.bookingId) });
    expect(s.status).toBeLessThan(500);
    const docs: any[] = await col("sbtbookings").find({}).toArray();
    expect(docs.every((d) => !d.sbtRequestId && String(d.userId) === String(OTHER_L2))).toBe(true);
    expect((await req()).status).toBe("PENDING");
  });
});

describe("hotels", () => {
  const searchBody = { HotelCodes: ["H1"], CheckIn: "2026-11-10", CheckOut: "2026-11-12", Rooms: [{ Adults: 1, Children: 0 }], CountryCode: "IN" };
  const guests = [{ Title: "Ms", FirstName: "Lata", LastName: "Iyer", PaxType: 1, LeadPassenger: true, Phone: "9876543210", Email: "lata.iyer@example.com" }];
  async function prebook(userId: mongoose.Types.ObjectId) {
    await as(request(app).post("/api/sbt/hotels/search"), userId).send(searchBody);
    const pb = await as(request(app).post("/api/sbt/hotels/prebook"), userId).send({ BookingCode: "BC1", searchPrice: 11000, countryCode: "IN" });
    expect(pb.status).toBe(200);
    return pb.body.quoteId as string;
  }
  const bookRequest = { BookingCode: "BC1", GuestNationality: "IN", destinationCountryCode: "IN", HotelRoomsDetails: [{ Guests: guests }] };
  const hotelSave = { hotelName: "Hotel One", checkIn: "2026-11-10", checkOut: "2026-11-12", totalFare: 1, sbtRequestId: "" };

  it("L2 hotel checkout (wallet): vouchered → request BOOKED, linked, selling price stored", async () => {
    await seedRequest("hotel");
    const q = await prebook(L2);
    const r = await as(request(app).post("/api/sbt/hotels/checkout"), L2).send({
      kind: "HOTEL_BOOK", mode: "official", quoteId: q, request: bookRequest,
      save: { ...hotelSave, sbtRequestId: String(REQ_ID) },
    });
    expect(r.body.status).toBe("TICKETED");
    const b: any = await col("sbthotelbookings").findOne({});
    const rq = await req();
    expect(rq.status).toBe("BOOKED");
    expect(String(rq.hotelBookingId)).toBe(String(b._id));
    expect(String(b.sbtRequestId)).toBe(String(REQ_ID));
    expect(b.totalFare).toBe(11000);
    expect(b.netAmount).toBe(10000);
  });

  it("a hold for a request links it but leaves it PENDING (nothing paid yet)", async () => {
    await seedRequest("hotel");
    await prebook(L2);
    const book = await as(request(app).post("/api/sbt/hotels/book"), L2).send({ ...bookRequest, bookingMode: "hold" });
    expect(book.body.ok).toBe(true);
    const s = await as(request(app).post("/api/sbt/hotels/bookings/save"), L2).send({
      ...hotelSave, sbtRequestId: String(REQ_ID), isHeld: true,
      clientReferenceId: book.body.clientReferenceId, bookingId: book.body.bookingId,
    });
    expect(s.status).toBe(200);
    const b: any = await col("sbthotelbookings").findOne({});
    expect(String(b.sbtRequestId)).toBe(String(REQ_ID));
    expect(b.status).toBe("HELD");
    expect((await req()).status).toBe("PENDING");
  });
});
