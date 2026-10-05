// apps/backend/src/routes/sbt.paymentGate.test.ts
//
// SBT payment containment: the server prices the order, proves the payment
// with Razorpay, and books with TBO only after that (or after reserving the
// business-wallet limit itself).
//
// Real: flights + hotels routers, requireSBT / requireFlightAccess /
//   requireFeature, services/sbtPaymentGate, SBTQuote / SBTPayment /
//   CustomerWorkspace / SBTHotelBooking, in-memory Mongo, checkout signature.
// Stubbed: requireAuth / requireWorkspace (from headers), TBO calls, Razorpay
//   network calls (create order / fetch / capture).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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
    const sbt = req.headers["x-test-sbt"] !== "off";
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    req.workspace = {
      _id: req.workspaceObjectId,
      status: "ACTIVE",
      tenantType: "CORPORATE",
      config: { features: { sbtEnabled: sbt, flightBookingEnabled: true, hotelBookingEnabled: true } },
    };
    next();
  },
}));
vi.mock("../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
vi.mock("../services/tbo.log.consolidator.js", () => ({ consolidateCertificationLogs: async () => {} }));
vi.mock("../jobs/static-data-refresh.js", () => ({
  resolveCityCodeAgainstCatalog: () => null,
  resolveCityCode: () => null,
  TBOHotelMaster: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

const tbo = vi.hoisted(() => ({
  getFareQuote: vi.fn(),
  getSSR: vi.fn(),
  ticketLCC: vi.fn(),
  getBookingDetails: vi.fn(async () => null),
  searchFlights: vi.fn(),
  ticketReissue: vi.fn(),
}));
const mail = vi.hoisted(() => ({ sendMail: vi.fn(async () => ({})) }));
vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: mail.sendMail }));
vi.mock("../utils/companySettings.js", async (orig) => ({
  ...(await orig<any>()),
  getCompanySettings: async () => ({ opsEmail: "ops@test", supportEmail: "support@test", accountManagerEmail: "" }),
}));
vi.mock("../services/tbo.flight.service.js", async (orig) => ({
  ...(await orig<any>()),
  getFareQuote: tbo.getFareQuote,
  getSSR: tbo.getSSR,
  ticketLCC: tbo.ticketLCC,
  getBookingDetails: tbo.getBookingDetails,
  searchFlights: tbo.searchFlights,
  ticketReissue: tbo.ticketReissue,
}));

const rzp = vi.hoisted(() => ({
  createRazorpayOrder: vi.fn(),
  fetchRazorpayPayment: vi.fn(),
  captureRazorpayPayment: vi.fn(),
}));
vi.mock("../services/sbtRazorpay.js", async (orig) => ({
  ...(await orig<any>()),
  createRazorpayOrder: rzp.createRazorpayOrder,
  fetchRazorpayPayment: rzp.fetchRazorpayPayment,
  captureRazorpayPayment: rzp.captureRazorpayPayment,
}));

// The old direct routes are Plumtrips staff only (requireSBTStaffDirect). This
// suite tests the payment gate BEHIND that lock, so here the staff check reads
// a header (callers are staff unless x-test-queue: none). The lock itself runs
// against real Admin Queue grants in sbt.staffDirectRoutes.test.ts.
vi.mock("./approvals.security.js", async (orig) => ({
  ...(await orig<any>()),
  adminQueueAccess: async (req: any) => {
    const work = req.headers?.["x-test-queue"] !== "none";
    return { view: work, work, via: work ? "permission" : "none", scope: "all" };
  },
}));

const { default: flightsRouter } = await import("./sbt.flights.js");
const { default: hotelsRouter } = await import("./sbt.hotels.js");
const app = express();
app.use(express.json());
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/hotels", hotelsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS = oid();
const BOOKER = oid();
const L1 = oid();
const OTHER = oid();

const HOUSE = "69679a7628330a58d29f2254"; // Plumtrips Travel Desk workspace

const as = (r: request.Test, userId: mongoose.Types.ObjectId, opts: { sbt?: boolean; ws?: string; staff?: boolean } = {}) =>
  r
    .set("x-test-user", JSON.stringify({ _id: String(userId), id: String(userId), sub: String(userId), email: "u@test", roles: ["CUSTOMER"] }))
    .set("x-test-ws", opts.ws ?? String(WS))
    .set("x-test-sbt", opts.sbt === false ? "off" : "on")
    .set("x-test-queue", opts.staff === false ? "none" : "work");

const sign = (orderId: string, paymentId: string) =>
  createHmac("sha256", "rzp_test_secret").update(`${orderId}|${paymentId}`).digest("hex");

let orderSeq = 0;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-payment-gate-test"));
  await mongoose.model("SBTPayment").syncIndexes();
  // Only the hotel index the overwrite test relies on (the model also declares
  // clientReferenceId twice, which makes a full syncIndexes fail).
  await col("sbthotelbookings").createIndex(
    { bookingId: 1 },
    { unique: true, partialFilterExpression: { bookingId: { $type: "string", $gt: "0" } }, name: "bookingId_unique_partial" },
  );
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  for (const c of ["users", "customerworkspaces", "sbtquotes", "sbtpayments", "sbtssrsnapshots", "sbthotelbookings", "sbtbookings", "sbtmulticitytraces", "sbtwalletledgers"]) {
    await col(c).deleteMany({});
  }
  await col("users").insertMany([
    { _id: BOOKER, email: "booker@test", sbtEnabled: true, sbtRole: null },
    { _id: L1, email: "l1@test", sbtEnabled: true, sbtRole: "L1" },
    { _id: OTHER, email: "other@test", sbtEnabled: true, sbtRole: "L2" },
  ] as any[]);
  await col("customerworkspaces").insertOne({
    _id: WS, status: "ACTIVE",
    sbtOfficialBooking: { enabled: true, creditLimit: 20000, used: 0 },
  } as any);

  vi.clearAllMocks();
  tbo.getFareQuote.mockImplementation(async (body: any) => ({
    Response: {
      ResponseStatus: 1,
      TraceId: body.TraceId,
      Results: { ResultIndex: body.ResultIndex, IsLCC: true, Fare: { PublishedFare: 11999.5, OfferedFare: 11500, Currency: "INR" } },
    },
  }));
  tbo.getSSR.mockImplementation(async () => ({
    Response: {
      ResponseStatus: 1,
      SeatDynamic: [{ SegmentSeat: [{ RowSeats: [{ Seats: [
        { Code: "12A", Price: 500, Origin: "DEL", Destination: "BOM" },
        { Code: "12B", Price: 0, Origin: "DEL", Destination: "BOM" },
      ] }] }] }],
      MealDynamic: [[{ Code: "VGML", Price: 300, Origin: "DEL", Destination: "BOM" }]],
      Baggage: [[{ Code: "XBPA", Price: 1000, Origin: "DEL", Destination: "BOM" }]],
    },
  }));
  tbo.ticketLCC.mockImplementation(async () => ({
    Response: { ResponseStatus: 1, TraceId: "T1", Response: { BookingId: 777001, PNR: "ABC123" } },
  }));
  tbo.searchFlights.mockImplementation(async () => ({
    Response: { ResponseStatus: 1, TraceId: "MC-T1", Results: [[{ ResultIndex: "MC-RI-1" }]] },
  }));
  tbo.ticketReissue.mockImplementation(async () => ({
    Response: { ResponseStatus: 1, Response: { PNR: "NEWPNR", BookingId: 888001, Fare: { BaseFare: 9000, Tax: 1000, TotalFare: 10000 } } },
  }));
  rzp.createRazorpayOrder.mockImplementation(async (amountPaise: number) => ({
    id: `order_${++orderSeq}`, amount: amountPaise, currency: "INR",
  }));
});

/** FareQuote + SSR as the booking pages do; returns the quoteId. */
async function quoteFlight(userId = BOOKER, ri = "RI-1") {
  const fq = await as(request(app).post("/api/sbt/flights/farequote"), userId).send({ TraceId: "T1", ResultIndex: ri });
  expect(fq.status).toBe(200);
  await as(request(app).post("/api/sbt/flights/ssr"), userId).send({ TraceId: "T1", ResultIndex: ri });
  return fq.body.Response.Results.quoteId as string;
}

const seatPax = (seat: string, price: number) => [{
  FirstName: "A", LastName: "B", PaxType: 1, IsLeadPax: true,
  SeatDynamic: [{ SegmentSeat: [{ RowSeats: [{ Seats: [{ Code: seat, Price: price, Origin: "DEL", Destination: "BOM" }] }] }] }],
}];

/** create-order → Razorpay checkout (stubbed) → verify. Returns the order id. */
async function payFlight(quoteId: string, passengers: any[] = [], paidPaise?: number) {
  const order = await as(request(app).post("/api/sbt/flights/payment/create-order"), BOOKER)
    .send({ quoteIds: [quoteId], Passengers: passengers, amount: 1 });
  expect(order.status).toBe(200);
  const paymentId = `pay_${order.body.orderId}`;
  rzp.fetchRazorpayPayment.mockResolvedValueOnce({
    id: paymentId, order_id: order.body.orderId, amount: paidPaise ?? order.body.amount, currency: "INR", status: "captured",
  });
  const verify = await as(request(app).post("/api/sbt/flights/payment/verify"), BOOKER).send({
    razorpay_order_id: order.body.orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(order.body.orderId, paymentId),
  });
  return { order, verify, paymentId };
}

const ticket = (userId: mongoose.Types.ObjectId, body: Record<string, unknown>) =>
  as(request(app).post("/api/sbt/flights/ticket-lcc"), userId).send({
    TraceId: "T1", ResultIndex: "RI-1", Passengers: [{ FirstName: "A", LastName: "B", PaxType: 1, IsLeadPax: true }], ...body,
  });

describe("create-order — the server sets the amount", () => {
  it("ignores a tampered client amount and charges ceil(selling fare) + TBO add-on prices", async () => {
    const q = await quoteFlight();
    // Browser claims the seat is free and sends amount ₹1.
    const res = await as(request(app).post("/api/sbt/flights/payment/create-order"), BOOKER)
      .send({ quoteIds: [q], Passengers: seatPax("12A", 0), amount: 1 });
    expect(res.status).toBe(200);
    expect(res.body.serverAmount).toBe(12000 + 500);
    expect(rzp.createRazorpayOrder).toHaveBeenCalledWith(1250000, expect.any(String));
  });

  it("refuses an unknown or someone else's quote", async () => {
    const q = await quoteFlight(OTHER);
    const res = await as(request(app).post("/api/sbt/flights/payment/create-order"), BOOKER).send({ quoteIds: [q] });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("FARE_EXPIRED");
    expect(rzp.createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("refuses an add-on TBO never priced", async () => {
    const q = await quoteFlight();
    const res = await as(request(app).post("/api/sbt/flights/payment/create-order"), BOOKER)
      .send({ quoteIds: [q], Passengers: seatPax("99Z", 50) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ADDON_NOT_PRICED");
  });
});

describe("verify + ticket — paid before TBO", () => {
  it("tickets after a captured payment for the server amount, and records it", async () => {
    const q = await quoteFlight();
    const { verify, order } = await payFlight(q);
    expect(verify.status).toBe(200);
    const t = await ticket(BOOKER, { razorpayOrderId: order.body.orderId });
    expect(t.status).toBe(200);
    expect(tbo.ticketLCC).toHaveBeenCalledTimes(1);
    const row: any = await col("sbtpayments").findOne({ razorpayOrderId: order.body.orderId });
    expect(row.status).toBe("TICKETED");
    expect(row.tboBookingId).toBe("777001");
  });

  it("refuses a ₹1 payment against the server's ₹12,000 order — and no ticket", async () => {
    const q = await quoteFlight();
    const { verify, order } = await payFlight(q, [], 100);
    expect(verify.status).toBe(400);
    expect(verify.body.code).toBe("AMOUNT_MISMATCH");
    const t = await ticket(BOOKER, { razorpayOrderId: order.body.orderId });
    expect(t.status).toBe(402);
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("refuses a payment that was never captured", async () => {
    const q = await quoteFlight();
    const order = await as(request(app).post("/api/sbt/flights/payment/create-order"), BOOKER).send({ quoteIds: [q] });
    rzp.fetchRazorpayPayment.mockResolvedValueOnce({ id: "pay_x", order_id: order.body.orderId, amount: order.body.amount, currency: "INR", status: "failed" });
    const v = await as(request(app).post("/api/sbt/flights/payment/verify"), BOOKER).send({
      razorpay_order_id: order.body.orderId, razorpay_payment_id: "pay_x", razorpay_signature: sign(order.body.orderId, "pay_x"),
    });
    expect(v.status).toBe(402);
  });

  it("refuses a forged signature without asking Razorpay", async () => {
    const q = await quoteFlight();
    const order = await as(request(app).post("/api/sbt/flights/payment/create-order"), BOOKER).send({ quoteIds: [q] });
    const v = await as(request(app).post("/api/sbt/flights/payment/verify"), BOOKER).send({
      razorpay_order_id: order.body.orderId, razorpay_payment_id: "pay_y", razorpay_signature: "f".repeat(64),
    });
    expect(v.status).toBe(400);
    expect(rzp.fetchRazorpayPayment).not.toHaveBeenCalled();
  });

  it("refuses a ticket with no payment at all", async () => {
    await quoteFlight();
    const t = await ticket(BOOKER, {});
    expect(t.status).toBe(402);
    expect(t.body.code).toBe("PAYMENT_REQUIRED");
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("refuses a ticket for a flight the payment was not made for", async () => {
    const q = await quoteFlight();
    const { order } = await payFlight(q);
    await quoteFlight(BOOKER, "RI-PRICIER");
    const t = await ticket(BOOKER, { razorpayOrderId: order.body.orderId, ResultIndex: "RI-PRICIER" });
    expect(t.status).toBe(409);
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("refuses add-ons at ticket time that the payment did not cover", async () => {
    const q = await quoteFlight();
    const { order } = await payFlight(q); // paid fare only
    const t = await ticket(BOOKER, { razorpayOrderId: order.body.orderId, Passengers: seatPax("12A", 0) });
    expect(t.status).toBe(409);
    expect(t.body.code).toBe("AMOUNT_NOT_COVERED");
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("refuses a replayed payment: one payment, one ticket", async () => {
    const q = await quoteFlight();
    const { order, paymentId } = await payFlight(q);
    expect((await ticket(BOOKER, { razorpayOrderId: order.body.orderId })).status).toBe(200);
    const again = await ticket(BOOKER, { razorpayOrderId: order.body.orderId });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PAYMENT_ALREADY_USED");
    expect(tbo.ticketLCC).toHaveBeenCalledTimes(1);

    // The same captured payment presented against a second order.
    const q2 = await quoteFlight();
    const order2 = await as(request(app).post("/api/sbt/flights/payment/create-order"), BOOKER).send({ quoteIds: [q2] });
    rzp.fetchRazorpayPayment.mockResolvedValueOnce({
      id: paymentId, order_id: order.body.orderId, amount: order2.body.amount, currency: "INR", status: "captured",
    });
    const v2 = await as(request(app).post("/api/sbt/flights/payment/verify"), BOOKER).send({
      razorpay_order_id: order2.body.orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(order2.body.orderId, paymentId),
    });
    expect(v2.status).toBe(400);
    expect(v2.body.code).toBe("ORDER_MISMATCH");
  });

  it("a failed TBO ticket leaves the payment usable for a retry", async () => {
    const q = await quoteFlight();
    const { order } = await payFlight(q);
    tbo.ticketLCC.mockResolvedValueOnce({ Response: { ResponseStatus: 2, Error: { ErrorCode: 3, ErrorMessage: "Fare not available" } } });
    await ticket(BOOKER, { razorpayOrderId: order.body.orderId });
    const row: any = await col("sbtpayments").findOne({ razorpayOrderId: order.body.orderId });
    expect(row.status).toBe("PAID");
    expect((await ticket(BOOKER, { razorpayOrderId: order.body.orderId })).status).toBe(200);
  });
});

describe("who may book", () => {
  it("refuses an L1 requester at create-order and at ticket", async () => {
    const q = await quoteFlight(L1);
    const o = await as(request(app).post("/api/sbt/flights/payment/create-order"), L1).send({ quoteIds: [q] });
    expect(o.status).toBe(403);
    expect(o.body.code).toBe("NOT_BOOKER");
    const t = await ticket(L1, { paymentMode: "official", quoteIds: [q] });
    expect(t.status).toBe(403);
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("refuses a workspace that is not on SBT", async () => {
    const q = await quoteFlight();
    const t = await as(request(app).post("/api/sbt/flights/ticket-lcc"), BOOKER, { sbt: false })
      .send({ TraceId: "T1", ResultIndex: "RI-1", Passengers: [], paymentMode: "official", quoteIds: [q] });
    expect(t.status).toBe(403);
    const w = await as(request(app).get("/api/sbt/wallet/check?amount=100"), BOOKER, { sbt: false });
    expect([403, 404]).toContain(w.status);
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });
});

describe("business wallet (official booking)", () => {
  const spend = async () => ((await col("customerworkspaces").findOne({ _id: WS })) as any).sbtOfficialBooking.used;

  it("reserves the server amount before TBO and credits it back when TBO fails", async () => {
    const q = await quoteFlight();
    tbo.ticketLCC.mockResolvedValueOnce({ Response: { ResponseStatus: 2, Error: { ErrorMessage: "fail" } } });
    await ticket(BOOKER, { paymentMode: "official", quoteIds: [q] });
    expect(await spend()).toBe(0);
    const t = await ticket(BOOKER, { paymentMode: "official", quoteIds: [q] });
    expect(t.status).toBe(200);
    expect(await spend()).toBe(12000);
  });

  it("refuses when the booking would exceed the monthly limit — TBO never called", async () => {
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { "sbtOfficialBooking.used": 9000 } });
    const q = await quoteFlight();
    const t = await ticket(BOOKER, { paymentMode: "official", quoteIds: [q] });
    expect(t.status).toBe(402);
    expect(t.body.code).toBe("LIMIT_EXCEEDED");
    expect(await spend()).toBe(9000);
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("two concurrent bookings cannot both pass the limit", async () => {
    const q = await quoteFlight();
    const [a, b] = await Promise.all([
      ticket(BOOKER, { paymentMode: "official", quoteIds: [q] }),
      ticket(BOOKER, { paymentMode: "official", quoteIds: [q] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
    expect(await spend()).toBe(12000);
  });
});

describe("hotel bookings/save is scoped to the caller", () => {
  it("cannot overwrite another user's booking with the same booking id or reference", async () => {
    const theirs = oid();
    await col("sbthotelbookings").insertOne({
      _id: theirs, userId: OTHER, workspaceId: WS, bookingId: "555", clientReferenceId: "PLM-theirs",
      hotelName: "Their Hotel", status: "CONFIRMED", totalFare: 9000,
    } as any);
    // isHeld: a hold is the only save that needs no payment row (an unpaid save is 402).
    const byId = await as(request(app).post("/api/sbt/hotels/bookings/save"), BOOKER)
      .send({ isHeld: true, bookingId: "555", hotelName: "Hijack", totalFare: 1, checkIn: "2026-11-01", checkOut: "2026-11-02" });
    expect(byId.status).toBe(409);
    // Their reference is not found in the caller's scope, so it is never filled in.
    await as(request(app).post("/api/sbt/hotels/bookings/save"), BOOKER)
      .send({ isHeld: true, clientReferenceId: "PLM-theirs", hotelName: "Hijack", totalFare: 1, checkIn: "2026-11-01", checkOut: "2026-11-02" });
    const doc: any = await col("sbthotelbookings").findOne({ _id: theirs });
    expect(doc.hotelName).toBe("Their Hotel");
    expect(doc.totalFare).toBe(9000);
  });

  it("hotel create-order charges the PreBook quote's server total, not the client's", async () => {
    await col("sbtquotes").insertOne({
      quoteId: "hq-1", product: "HOTEL", serverDisplayFare: 8450, serverNetFare: 8000, sourceRef: "BC-1",
      userId: String(BOOKER), workspaceId: String(WS), createdAt: new Date(),
    } as any);
    const res = await as(request(app).post("/api/sbt/hotels/payment/create-order"), BOOKER).send({ quoteId: "hq-1", amount: 1 });
    expect(res.status).toBe(200);
    expect(rzp.createRazorpayOrder).toHaveBeenCalledWith(845000, expect.any(String));
  });

  it("hotel voucher booking without payment is refused before TBO", async () => {
    const res = await as(request(app).post("/api/sbt/hotels/book"), BOOKER)
      .send({ BookingCode: "BC-1", bookingMode: "voucher", destinationCountryCode: "IN" });
    expect(res.status).toBe(402);
  });
});

describe("multi-city is Travel Desk only", () => {
  const MC = "For multi-city trips, please contact the Travel Desk";

  async function quoteMultiCity(ws?: string) {
    const search = await as(request(app).post("/api/sbt/flights/search-multi-city"), BOOKER, { ws })
      .send({ legs: [{ Origin: "DEL", Destination: "BOM" }, { Origin: "BOM", Destination: "GOI" }] });
    expect(search.status).toBe(200);
    const fq = await as(request(app).post("/api/sbt/flights/farequote"), BOOKER, { ws })
      .send({ TraceId: "MC-T1", ResultIndex: "RI-1" });
    return fq.body.Response.Results.quoteId as string;
  }

  it("self-service: no payment order for a multi-city quote, even without the browser's flag", async () => {
    const q = await quoteMultiCity();
    const res = await as(request(app).post("/api/sbt/flights/payment/create-order"), BOOKER).send({ quoteIds: [q] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MULTI_CITY_TRAVEL_DESK");
    expect(res.body.error).toBe(MC);
    expect(rzp.createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("self-service: no business-wallet ticket for a multi-city quote, TBO never called", async () => {
    const q = await quoteMultiCity();
    const t = await ticket(BOOKER, { paymentMode: "official", quoteIds: [q] });
    expect(t.status).toBe(403);
    expect(t.body.error).toBe(MC);
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("self-service: a ticket flagged multi-city is refused", async () => {
    const q = await quoteFlight();
    const t = await ticket(BOOKER, { paymentMode: "official", quoteIds: [q], isMultiCity: true });
    expect(t.status).toBe(403);
    expect(t.body.code).toBe("MULTI_CITY_TRAVEL_DESK");
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("the Travel Desk (HOUSE) can still take payment for multi-city", async () => {
    const q = await quoteMultiCity(HOUSE);
    const res = await as(request(app).post("/api/sbt/flights/payment/create-order"), BOOKER, { ws: HOUSE }).send({ quoteIds: [q] });
    expect(res.status).toBe(200);
  });
});

describe("reissue: a fare difference goes to the Travel Desk", () => {
  const FD = "A fare difference applies \u2014 our Travel Desk will contact you";
  const BOOKING = oid();

  beforeEach(async () => {
    await col("sbtbookings").insertOne({
      _id: BOOKING, userId: BOOKER, workspaceId: WS, pnr: "OLDPNR", bookingId: "777001",
      status: "CONFIRMED", ticketingStatus: "TICKETED", isLCC: true,
      origin: { code: "DEL", city: "Delhi" }, destination: { code: "BOM", city: "Mumbai" },
      departureTime: "2026-11-01T06:00:00", arrivalTime: "2026-11-01T08:00:00",
      airlineCode: "6E", airlineName: "IndiGo", flightNumber: "101",
      passengers: [{ firstName: "A", lastName: "B", paxType: "adult", isLead: true }],
      baseFare: 9000, taxes: 1000, extras: 0, totalFare: 10000, paymentMode: "personal",
    } as any);
  });

  const reissue = (body: Record<string, unknown>) =>
    as(request(app).post(`/api/sbt/flights/bookings/${BOOKING}/reissue`), BOOKER)
      .send({ ResultIndex: "RI-NEW", TraceId: "T1", ...body });

  it("a positive difference is refused for self-service, raises ONE ops request, never calls TBO, even if the browser says 0", async () => {
    await as(request(app).post("/api/sbt/flights/farequote"), BOOKER).send({ TraceId: "T1", ResultIndex: "RI-NEW" }); // 11999.50
    const r1 = await reissue({ priceDiff: 0 });
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe("FARE_DIFFERENCE_TRAVEL_DESK");
    expect(r1.body.error).toBe(FD);
    expect(tbo.ticketReissue).not.toHaveBeenCalled();
    const r2 = await reissue({ priceDiff: 0 });
    expect(r2.status).toBe(409);
    const doc: any = await col("sbtbookings").findOne({ _id: BOOKING });
    const reqs = (doc.changeRequests || []).filter((c: any) => c.requestType === "reissue-fare-difference");
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe("submitted");
    expect(reqs[0].remarks).toContain("2000");
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(doc.status).toBe("CONFIRMED");
  });

  it("self-service cannot open a payment for a fare difference", async () => {
    const r = await as(request(app).post(`/api/sbt/flights/bookings/${BOOKING}/reissue-order`), BOOKER, { staff: false }).send({ priceDiff: 2000 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(FD);
    expect(rzp.createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("a zero difference stays self-service", async () => {
    tbo.getFareQuote.mockImplementationOnce(async (body: any) => ({
      Response: { ResponseStatus: 1, TraceId: body.TraceId, Results: { ResultIndex: body.ResultIndex, Fare: { PublishedFare: 10000, OfferedFare: 9600 } } },
    }));
    await as(request(app).post("/api/sbt/flights/farequote"), BOOKER).send({ TraceId: "T1", ResultIndex: "RI-NEW" });
    const r = await reissue({ priceDiff: 0 });
    expect(r.status).toBe(200);
    expect(tbo.ticketReissue).toHaveBeenCalledTimes(1);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it("supplier reissue charges count toward the difference", async () => {
    tbo.getFareQuote.mockImplementationOnce(async (body: any) => ({
      Response: { ResponseStatus: 1, TraceId: body.TraceId, Results: { ResultIndex: body.ResultIndex, Fare: { PublishedFare: 10000, OfferedFare: 9600, SupplierReissueCharges: 1500 } } },
    }));
    await as(request(app).post("/api/sbt/flights/farequote"), BOOKER).send({ TraceId: "T1", ResultIndex: "RI-NEW" });
    const r = await reissue({ priceDiff: 0 });
    expect(r.status).toBe(409);
    expect(tbo.ticketReissue).not.toHaveBeenCalled();
  });

  it("a reissue onto a flight the caller never quoted is refused", async () => {
    const r = await reissue({ priceDiff: 0, ResultIndex: "RI-UNQUOTED" });
    expect(r.status).toBe(410);
    expect(tbo.ticketReissue).not.toHaveBeenCalled();
  });
});

describe("booking save + cancel: the business wallet moves only by the ledger", () => {
  const spend = async () => ((await col("customerworkspaces").findOne({ _id: WS })) as any).sbtOfficialBooking.used;
  const setSpend = (n: number) => col("customerworkspaces").updateOne({ _id: WS }, { $set: { "sbtOfficialBooking.used": n } });
  const credits = () => col("sbtwalletledgers").find({ type: "CREDIT" }).toArray();
  const FLIGHT = {
    origin: { city: "Delhi", code: "DEL" }, destination: { city: "Mumbai", code: "BOM" },
    departureTime: "2026-11-01T06:00:00", arrivalTime: "2026-11-01T08:00:00",
    airlineCode: "6E", airlineName: "IndiGo", flightNumber: "6E 101", baseFare: 10000,
  };

  it("a flight save with no payment record is refused — browser amount and official flag never stored", async () => {
    const res = await as(request(app).post("/api/sbt/flights/bookings/save"), BOOKER)
      .send({ pnr: "FAKE01", bookingId: "424242", totalFare: 50000, paymentMode: "official", ticketingStatus: "NOT_ATTEMPTED" });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("PAYMENT_REQUIRED");
    expect(await col("sbtbookings").countDocuments({})).toBe(0);
  });

  it("a paid hotel save with no payment record is refused", async () => {
    const res = await as(request(app).post("/api/sbt/hotels/bookings/save"), BOOKER)
      .send({ bookingId: "H-FAKE", hotelName: "Fake", totalFare: 50000, paymentMode: "official", checkIn: "2026-11-01", checkOut: "2026-11-02" });
    expect(res.status).toBe(402);
    expect(await col("sbthotelbookings").countDocuments({})).toBe(0);
  });

  it("a hold keeps the server price /book stamped, not the browser's, and is not official until paid", async () => {
    await col("sbthotelbookings").insertOne({
      userId: BOOKER, workspaceId: WS, clientReferenceId: "PLM-h1", bookingId: "H-1", serverSellingTotal: 8450,
      hotelName: "", status: "HELD", totalFare: 0,
    } as any);
    const res = await as(request(app).post("/api/sbt/hotels/bookings/save"), BOOKER).send({
      isHeld: true, bookingId: "H-1", hotelName: "Held Hotel", totalFare: 999999, paymentMode: "official",
      checkIn: "2026-11-01", checkOut: "2026-11-02",
    });
    expect(res.status).toBe(200);
    const doc: any = await col("sbthotelbookings").findOne({ bookingId: "H-1" });
    expect(doc.totalFare).toBe(8450);
    expect(doc.paymentMode).toBe("personal");
  });

  it("cancel credits only the ledger amount reserved for the booking, never its stored totalFare", async () => {
    const q = await quoteFlight();
    const t = await ticket(BOOKER, { paymentMode: "official", quoteIds: [q] });
    expect(t.status).toBe(200);
    const saved = await as(request(app).post("/api/sbt/flights/bookings/save"), BOOKER)
      .send({ ...FLIGHT, pnr: "ABC123", bookingId: "777001", totalFare: 1, paymentMode: "personal", ticketingStatus: "NOT_ATTEMPTED" });
    expect(saved.status).toBe(200);
    expect(saved.body.booking.totalFare).toBe(12000);
    expect(saved.body.booking.paymentMode).toBe("official");
    // Other bookings this month, and a booking record tampered upwards.
    await setSpend(15000);
    await col("sbtbookings").updateOne({ pnr: "ABC123" }, { $set: { totalFare: 50000 } });

    const c = await as(request(app).post(`/api/sbt/flights/bookings/${saved.body.booking._id}/cancel`), BOOKER).send({});
    expect(c.status).toBe(200);
    expect(await spend()).toBe(3000);
    const cr = await credits();
    expect(cr.map((x: any) => x.amount)).toEqual([12000]);
  });

  it("a fabricated official booking + cancel cannot raise the available limit", async () => {
    await setSpend(15000);
    const fake = oid();
    // A record as an older save could write it from the browser — no payment row, no ledger.
    await col("sbtbookings").insertOne({
      ...FLIGHT, _id: fake, userId: BOOKER, workspaceId: WS, pnr: "FAKE02", bookingId: "424243", status: "CONFIRMED",
      ticketingStatus: "NOT_ATTEMPTED", paymentMode: "official", totalFare: 50000, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    const c = await as(request(app).post(`/api/sbt/flights/bookings/${fake}/cancel`), BOOKER).send({});
    expect(c.status).toBe(200);
    expect(await spend()).toBe(15000);
    expect(await credits()).toHaveLength(0);
    // Cancelling again changes nothing either.
    await col("sbtbookings").updateOne({ _id: fake }, { $set: { status: "CONFIRMED" } });
    await as(request(app).post(`/api/sbt/flights/bookings/${fake}/cancel`), BOOKER).send({});
    expect(await spend()).toBe(15000);
  });
});

describe("creditCancelledBooking (hotel cancel + multi-leg rows)", () => {
  const month = new Date().toISOString().slice(0, 7);
  const spend = async () => ((await col("customerworkspaces").findOne({ _id: WS })) as any).sbtOfficialBooking.used;
  const officialRow = async (amount: number, extra: Record<string, unknown>) => {
    const _id = oid();
    await col("sbtpayments").insertOne({
      _id, product: "HOTEL", mode: "OFFICIAL", status: "TICKETED", userId: String(BOOKER), workspaceId: String(WS),
      amount, amountPaise: amount * 100, monthKey: month, bookingDocIds: [], createdAt: new Date(), ...extra,
    } as any);
    await col("sbtwalletledgers").insertOne({
      workspaceId: String(WS), type: "DEBIT", amount, monthKey: month, reason: "BOOKING",
      paymentId: String(_id), idempotencyKey: `debit:${_id}`, createdAt: new Date(),
    } as any);
    return _id;
  };

  it("a vouchered hold gives back the row's reserved amount; an unpaid hold gives back nothing", async () => {
    const { creditCancelledBooking } = await import("../services/sbtPaymentGate.js");
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { "sbtOfficialBooking.used": 10000 } });
    const held = oid();
    await officialRow(8450, { heldBookingId: String(held) });
    expect((await creditCancelledBooking("HOTEL", { _id: held, workspaceId: WS, totalFare: 99999 })).credited).toBe(8450);
    expect(await spend()).toBe(1550);
    expect((await creditCancelledBooking("HOTEL", { _id: oid(), workspaceId: WS, totalFare: 99999 })).credited).toBe(0);
    expect(await spend()).toBe(1550);
  });

  it("legs sharing one row give back at most what the row reserved", async () => {
    const { creditCancelledBooking } = await import("../services/sbtPaymentGate.js");
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { "sbtOfficialBooking.used": 10000 } });
    const a = oid();
    const b = oid();
    await officialRow(10000, { product: "FLIGHT", bookingDocIds: [String(a), String(b)] });
    expect((await creditCancelledBooking("FLIGHT", { _id: a, workspaceId: WS, totalFare: 6000 })).credited).toBe(6000);
    expect((await creditCancelledBooking("FLIGHT", { _id: b, workspaceId: WS, totalFare: 6000 })).credited).toBe(4000);
    expect(await spend()).toBe(0);
  });
});
