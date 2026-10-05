// apps/backend/src/routes/sbt.checkout.test.ts
//
// SBT checkout: the server prices, proves the payment, books with TBO itself
// (browser, webhook or retry — exactly once), refunds automatically when the
// supplier fails or the fare changes, alerts ops when the outcome is unknown,
// and keeps the business-wallet limit atomic with a ledger.
//
// Real: flights + hotels routers, Razorpay webhook router, services/sbtFulfil +
//   sbtPaymentGate, models, in-memory Mongo, checkout + webhook signatures.
// Stubbed: requireAuth / requireWorkspace (headers), TBO calls, Razorpay network
//   calls (order / fetch / capture / refund), mail.
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
process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
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
vi.mock("../jobs/static-data-refresh.js", () => ({
  resolveCityCodeAgainstCatalog: () => null,
  resolveCityCode: () => null,
  TBOHotelMaster: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

const tbo = vi.hoisted(() => ({
  getFareQuote: vi.fn(),
  getSSR: vi.fn(),
  ticketLCC: vi.fn(),
  bookFlight: vi.fn(),
  ticketFlight: vi.fn(),
  releasePNR: vi.fn(async () => ({})),
  getBookingDetails: vi.fn(async () => null),
  ticketReissue: vi.fn(),
}));
vi.mock("../services/tbo.flight.service.js", async (orig) => ({ ...(await orig<any>()), ...tbo }));
const hotelSvc = vi.hoisted(() => ({ generateHotelVoucher: vi.fn(), getBookingDetail: vi.fn(async () => null) }));
vi.mock("../services/tbo.hotel.service.js", async (orig) => ({ ...(await orig<any>()), ...hotelSvc }));

const rzp = vi.hoisted(() => ({
  createRazorpayOrder: vi.fn(),
  fetchRazorpayPayment: vi.fn(),
  captureRazorpayPayment: vi.fn(),
  refundRazorpayPayment: vi.fn(),
}));
vi.mock("../services/sbtRazorpay.js", async (orig) => ({ ...(await orig<any>()), ...rzp }));
const mail = vi.hoisted(() => ({ sendMail: vi.fn(async () => ({})) }));
vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: mail.sendMail }));
vi.mock("../utils/companySettings.js", async (orig) => ({
  ...(await orig<any>()),
  getCompanySettings: async () => ({ opsEmail: "ops@test", supportEmail: "support@test", accountManagerEmail: "" }),
}));

const { default: flightsRouter } = await import("./sbt.flights.js");
const { default: hotelsRouter } = await import("./sbt.hotels.js");
const { default: webhookRouter } = await import("./razorpay.webhook.js");
const { sweepCheckouts, SWEEP_AFTER_MS } = await import("../services/sbtFulfil.js");
const { markSbtTestData } = await import("../scripts/mark-sbt-test-data.js");
const app = express();
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhookRouter);
app.use(express.json());
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/hotels", hotelsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const BOOKER = oid();
const L1 = oid();
const HOUSE = "69679a7628330a58d29f2254";

const as = (r: request.Test, userId: mongoose.Types.ObjectId, ws: string = String(WS)) =>
  r.set("x-test-user", JSON.stringify({ _id: String(userId), id: String(userId), sub: String(userId), email: "u@test", roles: ["CUSTOMER"] }))
    .set("x-test-ws", ws);

const sign = (o: string, p: string) => createHmac("sha256", "rzp_test_secret").update(`${o}|${p}`).digest("hex");
const waitFor = async (fn: () => Promise<boolean>, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error("timed out waiting");
};
let seq = 0;
const row = async (id: string) => (await col("sbtpayments").findOne({ _id: new mongoose.Types.ObjectId(id) })) as any;
const spend = async () => ((await col("customerworkspaces").findOne({ _id: WS })) as any).sbtOfficialBooking.used;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-checkout-test"));
  await mongoose.model("SBTPayment").syncIndexes();
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["users", "customerworkspaces", "sbtquotes", "sbtpayments", "sbtssrsnapshots", "sbtbookings",
    "sbthotelbookings", "sbtwalletledgers", "sbtmulticitytraces", "travelbookings", "paymentorphans", "userpermissions"]) {
    await col(c).deleteMany({});
  }
  await col("users").insertMany([
    { _id: BOOKER, email: "booker@test", sbtEnabled: true, sbtRole: null },
    { _id: L1, email: "l1@test", sbtEnabled: true, sbtRole: "L1" },
  ] as any[]);
  await col("customerworkspaces").insertOne({
    _id: WS, status: "ACTIVE", customerId: oid(),
    sbtOfficialBooking: { enabled: true, creditLimit: 30000, used: 0 },
  } as any);
  // Reset, not clear: a queued mockResolvedValueOnce left unused by one test
  // (e.g. /pay short-circuits for a known payment) must not leak into the next.
  for (const m of [...Object.values(tbo), ...Object.values(rzp), ...Object.values(hotelSvc), mail.sendMail]) (m as any).mockReset();
  tbo.releasePNR.mockResolvedValue({});
  tbo.getBookingDetails.mockResolvedValue(null);
  hotelSvc.getBookingDetail.mockResolvedValue(null);
  mail.sendMail.mockResolvedValue({});
  tbo.getFareQuote.mockImplementation(async (body: any) => ({
    Response: { ResponseStatus: 1, TraceId: body.TraceId,
      Results: { ResultIndex: body.ResultIndex, IsLCC: true, Fare: { PublishedFare: body.ResultIndex === "LEG-2" ? 6000 : 11999.5, OfferedFare: 11500 } } },
  }));
  tbo.getSSR.mockImplementation(async () => ({ Response: { ResponseStatus: 1,
    SeatDynamic: [{ SegmentSeat: [{ RowSeats: [{ Seats: [{ Code: "12A", Price: 500, Origin: "DEL", Destination: "BOM" }] }] }] }] } }));
  tbo.ticketLCC.mockImplementation(async (p: any) => ({
    Response: { ResponseStatus: 1, TraceId: p.TraceId, Response: { BookingId: 700000 + (++seq), PNR: `PNR${seq}`,
      FlightItinerary: { Passenger: [{ Ticket: { TicketId: 900 + seq } }] } } },
  }));
  rzp.createRazorpayOrder.mockImplementation(async (paise: number) => ({ id: `order_${++seq}`, amount: paise, currency: "INR" }));
  rzp.refundRazorpayPayment.mockImplementation(async (_p: string, amt: number) => ({ id: `rfnd_${++seq}`, amount: amt }));
});

async function quote(ri = "RI-1", userId = BOOKER, ws?: string) {
  const fq = await as(request(app).post("/api/sbt/flights/farequote"), userId, ws).send({ TraceId: "T1", ResultIndex: ri });
  await as(request(app).post("/api/sbt/flights/ssr"), userId, ws).send({ TraceId: "T1", ResultIndex: ri });
  return fq.body.Response.Results.quoteId as string;
}
const pax = (seat?: { code: string; price: number }) => [{
  FirstName: "A", LastName: "B", PaxType: 1, IsLeadPax: true,
  ...(seat ? { SeatDynamic: [{ SegmentSeat: [{ RowSeats: [{ Seats: [{ Code: seat.code, Price: seat.price, Origin: "DEL", Destination: "BOM" }] }] }] }] } : {}),
}];
const saveInfo = {
  origin: { code: "DEL", city: "Delhi" }, destination: { code: "BOM", city: "Mumbai" },
  departureTime: "2026-11-01T06:00:00", arrivalTime: "2026-11-01T08:00:00",
  airlineCode: "6E", airlineName: "IndiGo", flightNumber: "101", baseFare: 1, taxes: 0, totalFare: 1,
  passengers: [{ firstName: "A", lastName: "B", paxType: "adult", isLead: true }],
};
const lccCheckout = (q: string, mode: "personal" | "official", extra: Record<string, any> = {}, userId = BOOKER) =>
  as(request(app).post("/api/sbt/flights/checkout"), userId).send({
    kind: "FLIGHT_LCC", mode, quoteIds: [q],
    request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax(), ...extra },
    save: saveInfo,
  });
async function pay(checkout: any, paise?: number) {
  const pid = `pay_${checkout.orderId}`;
  rzp.fetchRazorpayPayment.mockResolvedValueOnce({ id: pid, order_id: checkout.orderId, amount: paise ?? checkout.amount, currency: "INR", status: "captured" });
  return as(request(app).post(`/api/sbt/flights/checkout/${checkout.checkoutId}/pay`), BOOKER).send({
    razorpay_order_id: checkout.orderId, razorpay_payment_id: pid, razorpay_signature: sign(checkout.orderId, pid),
  });
}
function webhook(event: string, entity: Record<string, any>) {
  const raw = JSON.stringify({ event, payload: { payment: { entity } } });
  return request(app).post("/api/webhooks/razorpay").set("content-type", "application/json")
    .set("x-razorpay-signature", createHmac("sha256", "whsec_test").update(raw).digest("hex")).send(raw);
}

describe("card checkout — the server books after proving payment", () => {
  it("prices on the server, books with TBO, saves the booking with the charged amount", async () => {
    const q = await quote();
    const c = await lccCheckout(q, "personal", { amount: 1, totalFare: 1 });
    expect(c.status).toBe(200);
    expect(c.body.serverAmount).toBe(12000);
    const r = await pay(c.body);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("TICKETED");
    expect(r.body.result.pnr).toMatch(/^PNR/);
    expect(tbo.ticketLCC).toHaveBeenCalledTimes(1);
    expect(tbo.ticketLCC.mock.calls[0][0].acceptPriceChange).toBe(false);
    const booking: any = await col("sbtbookings").findOne({});
    expect(booking.totalFare).toBe(12000);
    expect(booking.paymentStatus).toBe("paid");
    expect(booking.razorpayAmount).toBe(1200000);
  });

  it("a ₹1 payment against the ₹12,000 order is refused — nothing booked", async () => {
    const c = await lccCheckout(await quote(), "personal");
    const r = await pay(c.body, 100);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("AMOUNT_MISMATCH");
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("an L1 requester cannot start a checkout", async () => {
    const q = await quote("RI-1", L1);
    const r = await lccCheckout(q, "personal", {}, L1);
    expect(r.status).toBe(403);
    expect(rzp.createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("a payment id cannot buy a second checkout", async () => {
    const c1 = await lccCheckout(await quote(), "personal");
    await pay(c1.body);
    const c2 = await lccCheckout(await quote(), "personal");
    const pid = `pay_${c1.body.orderId}`;
    rzp.fetchRazorpayPayment.mockResolvedValueOnce({ id: pid, order_id: c1.body.orderId, amount: c2.body.amount, currency: "INR", status: "captured" });
    const r = await as(request(app).post(`/api/sbt/flights/checkout/${c2.body.checkoutId}/pay`), BOOKER)
      .send({ razorpay_order_id: c2.body.orderId, razorpay_payment_id: pid, razorpay_signature: sign(c2.body.orderId, pid) });
    expect(r.status).toBe(400);
    expect(tbo.ticketLCC).toHaveBeenCalledTimes(1);
  });
});

describe("the webhook completes a booking whose browser closed", () => {
  it("payment.captured → PAID → booked server-side, and a late browser call does not book twice", async () => {
    const c = await lccCheckout(await quote(), "personal");
    const w = await webhook("payment.captured", { id: "pay_wh1", order_id: c.body.orderId, amount: c.body.amount, currency: "INR" });
    expect(w.status).toBe(200);
    await waitFor(async () => (await row(c.body.checkoutId)).status === "TICKETED");
    expect(await col("sbtbookings").countDocuments({})).toBe(1);
    // The browser comes back with the same payment.
    rzp.fetchRazorpayPayment.mockResolvedValueOnce({ id: "pay_wh1", order_id: c.body.orderId, amount: c.body.amount, currency: "INR", status: "captured" });
    const r = await as(request(app).post(`/api/sbt/flights/checkout/${c.body.checkoutId}/pay`), BOOKER)
      .send({ razorpay_order_id: c.body.orderId, razorpay_payment_id: "pay_wh1", razorpay_signature: sign(c.body.orderId, "pay_wh1") });
    expect(r.body.status).toBe("TICKETED");
    expect(tbo.ticketLCC).toHaveBeenCalledTimes(1);
    // A replayed webhook is a no-op.
    await webhook("payment.captured", { id: "pay_wh1", order_id: c.body.orderId, amount: c.body.amount, currency: "INR" });
    expect(tbo.ticketLCC).toHaveBeenCalledTimes(1);
  });

  it("a captured amount that differs from the order is NOT marked paid — ops alerted", async () => {
    const c = await lccCheckout(await quote(), "personal");
    await webhook("payment.captured", { id: "pay_wh2", order_id: c.body.orderId, amount: 100, currency: "INR" });
    const r = await row(c.body.checkoutId);
    expect(r.status).toBe("NEEDS_OPS");
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
    expect(mail.sendMail).toHaveBeenCalled();
  });

  it("payment.failed never demotes a confirmed booking (legacy order)", async () => {
    const id = oid();
    await col("sbtbookings").insertOne({ _id: id, userId: BOOKER, workspaceId: WS, status: "CONFIRMED", razorpayOrderId: "order_legacy" } as any);
    await webhook("payment.failed", { id: "pay_f", order_id: "order_legacy", error_description: "late failure" });
    expect(((await col("sbtbookings").findOne({ _id: id })) as any).status).toBe("CONFIRMED");
  });
});

describe("failures after payment are never silent", () => {
  it("fare change at ticketing → full automatic refund, nothing saved", async () => {
    tbo.ticketLCC.mockResolvedValueOnce({ Response: { ResponseStatus: 2, IsPriceChanged: true }, _priceChanged: true });
    const c = await lccCheckout(await quote(), "personal");
    const r = await pay(c.body);
    expect(r.body.status).toBe("REFUNDED");
    expect(r.body.failureCode).toBe("FARE_CHANGED");
    expect(rzp.refundRazorpayPayment).toHaveBeenCalledWith(`pay_${c.body.orderId}`, 1200000, expect.any(Object));
    expect(await col("sbtbookings").countDocuments({})).toBe(0);
    expect(mail.sendMail).toHaveBeenCalled();
  });

  it("supplier failure → refund", async () => {
    tbo.ticketLCC.mockResolvedValueOnce({ Response: { ResponseStatus: 2, Error: { ErrorMessage: "Fare not available" } } });
    const c = await lccCheckout(await quote(), "personal");
    const r = await pay(c.body);
    expect(r.body.status).toBe("REFUNDED");
    expect(r.body.refundedAmount).toBe(12000);
  });

  it("supplier timeout → NEEDS_OPS, never refunded blind", async () => {
    tbo.ticketLCC.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const c = await lccCheckout(await quote(), "personal");
    const r = await pay(c.body);
    expect(r.body.status).toBe("NEEDS_OPS");
    expect(rzp.refundRazorpayPayment).not.toHaveBeenCalled();
    expect(mail.sendMail).toHaveBeenCalled();
  });

  it("a failed refund → NEEDS_OPS + alert", async () => {
    tbo.ticketLCC.mockResolvedValueOnce({ Response: { ResponseStatus: 2 } });
    rzp.refundRazorpayPayment.mockRejectedValueOnce(new Error("refund refused"));
    const c = await lccCheckout(await quote(), "personal");
    const r = await pay(c.body);
    expect(r.body.status).toBe("NEEDS_OPS");
    expect((await row(c.body.checkoutId)).refundedPaise).toBe(0);
  });

  it("add-ons TBO rejected are refunded (seat stripped on retry)", async () => {
    tbo.ticketLCC
      .mockResolvedValueOnce({ Response: { ResponseStatus: 2, Error: { ErrorMessage: "Invalid seat" } } })
      .mockImplementationOnce(async () => ({ Response: { ResponseStatus: 1, Response: { BookingId: 711, PNR: "PNRS" } } }));
    const q = await quote();
    const c = await as(request(app).post("/api/sbt/flights/checkout"), BOOKER).send({
      kind: "FLIGHT_LCC", mode: "personal", quoteIds: [q],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax({ code: "12A", price: 0 }) }, save: saveInfo,
    });
    expect(c.body.serverAmount).toBe(12500);
    const r = await pay(c.body);
    expect(r.body.status).toBe("TICKETED");
    expect(rzp.refundRazorpayPayment).toHaveBeenCalledWith(expect.any(String), 50000, expect.any(Object));
  });
});

describe("business wallet — atomic, ledgered, credited back", () => {
  it("reserves before TBO with a DEBIT; a supplier failure credits it back once", async () => {
    tbo.ticketLCC.mockResolvedValueOnce({ Response: { ResponseStatus: 2 } });
    const r = await lccCheckout(await quote(), "official");
    expect(r.body.status).toBe("REFUNDED");
    expect(await spend()).toBe(0);
    const ledger = await col("sbtwalletledgers").find({}).sort({ createdAt: 1 }).toArray();
    expect(ledger.map((l: any) => [l.type, l.amount])).toEqual([["DEBIT", 12000], ["CREDIT", 12000]]);
  });

  it("success leaves the spend reserved and the booking marked official", async () => {
    const r = await lccCheckout(await quote(), "official");
    expect(r.body.status).toBe("TICKETED");
    expect(await spend()).toBe(12000);
    const b: any = await col("sbtbookings").findOne({});
    expect(b.paymentMode).toBe("official");
    expect(b.totalFare).toBe(12000);
    expect(b.paymentStatus).toBe("paid");
  });

  it("over the limit is refused before TBO; two concurrent checkouts cannot both pass", async () => {
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { "sbtOfficialBooking.used": 10000 } });
    const q = await quote();
    const [a, b] = await Promise.all([lccCheckout(q, "official"), lccCheckout(q, "official")]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
    expect(await spend()).toBe(22000);
    expect(tbo.ticketLCC).toHaveBeenCalledTimes(1);
  });

  it("cancellation credit is ledgered and applied once", async () => {
    const { creditOfficial } = await import("../services/sbtPaymentGate.js");
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { "sbtOfficialBooking.used": 5000 } });
    const month = new Date().toISOString().slice(0, 7);
    expect(await creditOfficial(WS, 3000, month, { key: "cancel:X", reason: "CANCELLATION" })).toBe(true);
    expect(await creditOfficial(WS, 3000, month, { key: "cancel:X", reason: "CANCELLATION" })).toBe(false);
    expect(await spend()).toBe(2000);
  });
});

describe("Demo Platform", () => {
  it("a demo user's checkout never reaches TBO and never moves the wallet counter", async () => {
    const q = await quote();
    const r = await request(app).post("/api/sbt/flights/checkout")
      .set("x-test-user", JSON.stringify({ _id: String(BOOKER), id: String(BOOKER), sub: String(BOOKER), email: "d@test", roles: ["CUSTOMER"], isDemoUser: true }))
      .set("x-test-ws", String(WS))
      .send({ kind: "FLIGHT_LCC", mode: "official", quoteIds: [q], request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax() }, save: saveInfo });
    expect(r.status).toBe(200);
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
    expect(await spend()).toBe(0);
    expect(await col("sbtwalletledgers").countDocuments({})).toBe(0);
  });
});

describe("multi-city — every leg quoted, priced, ticketed", () => {
  const mc = async (q1: string, q2: string) => as(request(app).post("/api/sbt/flights/checkout"), BOOKER).send({
    kind: "FLIGHT_MULTI", mode: "official", quoteIds: [q1, q2],
    request: { legs: [
      { isLCC: true, request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax() } },
      { isLCC: true, request: { TraceId: "T1", ResultIndex: "LEG-2", Passengers: pax() } },
    ] },
    save: { common: { passengers: saveInfo.passengers }, legs: [saveInfo, { ...saveInfo, origin: { code: "BOM", city: "Mumbai" }, destination: { code: "GOI", city: "Goa" } }] },
  });

  it("charges both legs and saves one booking per leg sharing the charge", async () => {
    const r = await mc(await quote("RI-1"), await quote("LEG-2"));
    expect(r.body.status).toBe("TICKETED");
    expect(tbo.ticketLCC).toHaveBeenCalledTimes(2);
    const bookings = await col("sbtbookings").find({}).sort({ legIndex: 1 }).toArray() as any[];
    expect(bookings).toHaveLength(2);
    expect(bookings[0].multiCityGroupId).toBe(bookings[1].multiCityGroupId);
    expect(bookings[0].totalFare + bookings[1].totalFare).toBe(18000); // ceil(11999.5 + 6000)
    expect(await spend()).toBe(18000);
  });

  it("leg 2 fails → leg 1 kept, leg 2's share credited back", async () => {
    tbo.ticketLCC.mockImplementationOnce(async () => ({ Response: { ResponseStatus: 1, Response: { BookingId: 1, PNR: "L1PNR" } } }))
      .mockResolvedValueOnce({ Response: { ResponseStatus: 2 } });
    const r = await mc(await quote("RI-1"), await quote("LEG-2"));
    expect(r.body.status).toBe("TICKETED");
    expect(await col("sbtbookings").countDocuments({})).toBe(1);
    expect(r.body.result.partialRefundAmount).toBe(6000);
    expect(await spend()).toBe(12000);
  });

  it("a multi-city checkout with a leg missing its quote is refused", async () => {
    const q1 = await quote("RI-1");
    const r = await as(request(app).post("/api/sbt/flights/checkout"), BOOKER).send({
      kind: "FLIGHT_MULTI", mode: "official", quoteIds: [q1],
      request: { legs: [
        { request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax() } },
        { request: { TraceId: "T1", ResultIndex: "LEG-2", Passengers: pax() } },
      ] }, save: {},
    });
    expect(r.status).toBe(410);
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });
});

describe("GDS — Book then Ticket, held PNR released on failure", () => {
  it("fare change at Ticket → PNR released, refunded", async () => {
    tbo.bookFlight.mockResolvedValueOnce({ Response: { ResponseStatus: 1, Response: { PNR: "GDS1", BookingId: 5551 } } });
    tbo.ticketFlight.mockResolvedValueOnce({ Response: { ResponseStatus: 2, IsPriceChanged: true }, _priceChanged: true });
    const q = await quote();
    const r = await as(request(app).post("/api/sbt/flights/checkout"), BOOKER).send({
      kind: "FLIGHT_GDS", mode: "official", quoteIds: [q],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: pax() }, save: saveInfo,
    });
    expect(r.body.status).toBe("REFUNDED");
    expect(r.body.failureCode).toBe("FARE_CHANGED");
    expect(tbo.releasePNR).toHaveBeenCalledWith({ BookingId: 5551, PNR: "GDS1" });
    expect(await spend()).toBe(0);
  });
});

describe("the 20-minute sweep", () => {
  it("refunds a paid checkout nobody booked; flags one stuck mid-booking", async () => {
    const c = await lccCheckout(await quote(), "personal");
    const old = new Date(Date.now() - SWEEP_AFTER_MS - 60_000);
    await col("sbtpayments").updateOne({ razorpayOrderId: c.body.orderId }, { $set: { status: "PAID", razorpayPaymentId: "pay_sw", paidAt: old } });
    const c2 = await lccCheckout(await quote(), "personal");
    await col("sbtpayments").updateOne({ razorpayOrderId: c2.body.orderId }, { $set: { status: "CLAIMED", razorpayPaymentId: "pay_sw2", claimedAt: old } });
    const r = await sweepCheckouts();
    expect(r).toEqual({ refunded: 1, flagged: 1 });
    expect((await row(c.body.checkoutId)).status).toBe("REFUNDED");
    expect((await row(c2.body.checkoutId)).status).toBe("NEEDS_OPS");
    expect(rzp.refundRazorpayPayment).toHaveBeenCalledTimes(1);
  });
});

describe("hotel voucher of a held booking", () => {
  it("charges the stamped server price via the wallet and vouchers", async () => {
    const held = oid();
    await col("sbthotelbookings").insertOne({
      _id: held, userId: BOOKER, workspaceId: WS, status: "HELD", isHeld: true, bookingId: "4444",
      totalFare: 1, netAmount: 1, serverSellingTotal: 8450, isVouchered: false,
    } as any);
    hotelSvc.generateHotelVoucher.mockResolvedValueOnce({ GenerateVoucherResult: { ResponseStatus: 1, VoucherStatus: true, BookingStatus: "Vouchered", InvoiceNumber: "INV1" } });
    const r = await as(request(app).post("/api/sbt/hotels/checkout"), BOOKER).send({
      kind: "HOTEL_VOUCHER", mode: "official", heldBookingId: String(held), request: {}, save: {},
    });
    expect(r.body.status).toBe("TICKETED");
    expect(await spend()).toBe(8450);
  });
});

describe("reissue — priced by the server end to end (Travel Desk)", () => {
  const BOOKING = oid();
  beforeEach(async () => {
    await col("sbtbookings").insertOne({
      _id: BOOKING, userId: BOOKER, workspaceId: new mongoose.Types.ObjectId(HOUSE), pnr: "OLD", bookingId: "777",
      status: "CONFIRMED", ticketingStatus: "TICKETED", isLCC: true, origin: { code: "DEL", city: "Delhi" },
      destination: { code: "BOM", city: "Mumbai" }, departureTime: "x", arrivalTime: "y", airlineCode: "6E",
      airlineName: "IndiGo", flightNumber: "1", passengers: [{ firstName: "A", lastName: "B", paxType: "adult", isLead: true }],
      baseFare: 9000, taxes: 1000, extras: 0, totalFare: 10000, paymentMode: "personal",
    } as any);
    // A Travel Desk agent: HOUSE + Access Console "Admin Queue" WRITE.
    await col("userpermissions").insertOne({
      userId: String(BOOKER), email: "booker@test", workspaceId: HOUSE, universe: "STAFF", status: "active", source: "manual",
      level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access: "WRITE", scope: "ALL" } },
    } as any);
  });

  it("reissue-order charges the server difference; /reissue without payment is refused", async () => {
    await quote("RI-NEW", BOOKER, HOUSE); // ₹11,999.50 → difference ₹2,000
    const o = await as(request(app).post(`/api/sbt/flights/bookings/${BOOKING}/reissue-order`), BOOKER, HOUSE)
      .send({ ResultIndex: "RI-NEW", priceDiff: 1 });
    expect(o.status).toBe(200);
    expect(rzp.createRazorpayOrder).toHaveBeenCalledWith(200000, expect.any(String)); // ₹2,000, not the ₹1 sent
    const unpaid = await as(request(app).post(`/api/sbt/flights/bookings/${BOOKING}/reissue`), BOOKER, HOUSE)
      .send({ ResultIndex: "RI-NEW", TraceId: "T1", priceDiff: 0 });
    expect(unpaid.status).toBe(402);
    expect(tbo.ticketReissue).not.toHaveBeenCalled();
  });

  it("wallet reissue reserves the difference and credits it back when TBO fails", async () => {
    await col("customerworkspaces").insertOne({
      _id: new mongoose.Types.ObjectId(HOUSE), status: "ACTIVE", customerId: oid(),
      sbtOfficialBooking: { enabled: true, creditLimit: 10000000, used: 0 },
    } as any);
    await quote("RI-NEW", BOOKER, HOUSE);
    tbo.ticketReissue.mockResolvedValueOnce({ Response: { ResponseStatus: 2, Error: { ErrorMessage: "no" } } });
    const r = await as(request(app).post(`/api/sbt/flights/bookings/${BOOKING}/reissue`), BOOKER, HOUSE)
      .send({ ResultIndex: "RI-NEW", TraceId: "T1", paymentMode: "WALLET" });
    expect(r.status).toBe(502);
    const ledger = await col("sbtwalletledgers").find({ workspaceId: HOUSE }).toArray() as any[];
    expect(ledger.map((l) => [l.type, l.amount])).toEqual([["DEBIT", 2000], ["CREDIT", 2000]]);
  });
});

describe("test data", () => {
  it("dry run writes nothing; --apply marks bookings + mirrors, never demo rows or unnamed-account orphans", async () => {
    const before = new Date(Date.now() + 1000).toISOString();
    const f = oid(); const demo = oid();
    await col("sbtbookings").insertMany([
      { _id: f, userId: BOOKER, workspaceId: WS, pnr: "T1", createdAt: new Date() },
      { _id: demo, userId: BOOKER, workspaceId: WS, pnr: "DMO", isDemo: true, createdAt: new Date() },
    ] as any[]);
    await col("travelbookings").insertOne({ reference: f, source: "SBT" } as any);
    await col("paymentorphans").insertMany([
      { razorpayPaymentId: "p1", razorpayOrderId: "o1", amount: 1, webhookPayload: { account_id: "acc_SBT" }, createdAt: new Date() },
      { razorpayPaymentId: "p2", razorpayOrderId: "o2", amount: 1, webhookPayload: { account_id: "acc_D2C" }, createdAt: new Date() },
    ] as any[]);
    const db = mongoose.connection.name;
    const dry = await markSbtTestData({ expectDb: db, before, sbtAccounts: ["acc_SBT"], log: () => {} });
    expect(dry.flights).toBe(1);
    expect(await col("sbtbookings").countDocuments({ isTest: true })).toBe(0);
    await markSbtTestData({ expectDb: db, before, sbtAccounts: ["acc_SBT"], apply: true, log: () => {} });
    expect(((await col("sbtbookings").findOne({ _id: f })) as any).isTest).toBe(true);
    expect(((await col("sbtbookings").findOne({ _id: demo })) as any).isTest).toBeUndefined();
    expect(((await col("travelbookings").findOne({ reference: f })) as any).isTest).toBe(true);
    expect(((await col("paymentorphans").findOne({ razorpayPaymentId: "p1" })) as any).isTest).toBe(true);
    expect(((await col("paymentorphans").findOne({ razorpayPaymentId: "p2" })) as any).isTest).toBeUndefined();
    // Test bookings leave the customer's booking list.
    const list = await as(request(app).get("/api/sbt/flights/bookings"), BOOKER);
    expect((list.body.bookings || []).map((b: any) => String(b._id))).not.toContain(String(f));
  });

  it("refuses without --expect-db or --before", async () => {
    await expect(markSbtTestData({ expectDb: undefined, before: "2026-01-01", log: () => {} })).rejects.toThrow(/expect-db/);
    await expect(markSbtTestData({ expectDb: mongoose.connection.name, before: undefined, log: () => {} })).rejects.toThrow(/before/);
  });
});
