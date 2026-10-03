// apps/backend/src/routes/sbt.staffDirectRoutes.test.ts
//
// The old direct booking/payment routes are Plumtrips staff only (Admin Queue
// WRITE grant in HOUSE, HOUSE ADMIN, or SUPERADMIN). Customers book through
// /checkout, which runs the same handlers in-process and must keep working.
//
// Real: flights + hotels routers, services/sbtPaymentGate + sbtFulfil,
//   approvals.security adminQueueAccess (UserPermission grants), in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers), TBO calls, Razorpay network
//   calls, mail.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
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
const app = express();
app.use(express.json());
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/hotels", hotelsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const HOUSE = "69679a7628330a58d29f2254";
const WS = oid();
const CUSTOMER = oid();
const AGENT = oid(); // HOUSE + adminQueue WRITE
const VIEWER = oid(); // HOUSE + adminQueue READ
const HOUSE_STAFF = oid(); // HOUSE, no grant
const SUPER = oid();
const BOOKING = oid();
const HELD_HOTEL = oid();

const as = (r: request.Test, userId: mongoose.Types.ObjectId, ws: string, roles: string[] = ["CUSTOMER"]) =>
  r.set("x-test-user", JSON.stringify({ _id: String(userId), id: String(userId), sub: String(userId), email: `${userId}@test`, roles }))
    .set("x-test-ws", ws);

const grant = (userId: mongoose.Types.ObjectId, access: string, workspaceId = HOUSE) =>
  col("userpermissions").insertOne({
    userId: String(userId), email: `${userId}@test`, workspaceId, universe: "STAFF", status: "active", source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access, scope: "ALL" } },
  } as any);

const DIRECT_ROUTES: Array<[string, Record<string, unknown>]> = [
  ["/api/sbt/flights/ticket-lcc", { TraceId: "T1", ResultIndex: "RI-1", Passengers: [] }],
  ["/api/sbt/flights/ticket", { TraceId: "T1", BookingId: 1, PNR: "X" }],
  ["/api/sbt/flights/book", { TraceId: "T1", ResultIndex: "RI-1", Passengers: [] }],
  ["/api/sbt/flights/payment/create-order", { quoteIds: ["q"] }],
  ["/api/sbt/flights/payment/verify", { razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "s" }],
  ["/api/sbt/hotels/payment/create-order", { quoteId: "hq" }],
  ["/api/sbt/hotels/payment/verify", { razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "s" }],
  [`/api/sbt/hotels/bookings/${HELD_HOTEL}/generate-voucher`, {}],
];

let seq = 0;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-staff-direct-test"));
  await mongoose.model("SBTPayment").syncIndexes();
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["users", "customerworkspaces", "userpermissions", "sbtquotes", "sbtpayments", "sbtssrsnapshots",
    "sbtbookings", "sbthotelbookings", "sbtwalletledgers", "sbtmulticitytraces", "travelbookings"]) {
    await col(c).deleteMany({});
  }
  await col("users").insertMany([CUSTOMER, AGENT, VIEWER, HOUSE_STAFF, SUPER].map((_id) => ({
    _id, email: `${_id}@test`, sbtEnabled: true, sbtRole: null,
  })) as any[]);
  await col("customerworkspaces").insertOne({
    _id: WS, status: "ACTIVE", customerId: oid(),
    sbtOfficialBooking: { enabled: true, monthlyLimit: 30000, currentMonthSpend: 0, lastResetMonth: new Date().toISOString().slice(0, 7) },
  } as any);
  await col("sbtbookings").insertOne({
    _id: BOOKING, userId: CUSTOMER, workspaceId: WS, pnr: "OLD", bookingId: "777", status: "CONFIRMED",
    ticketingStatus: "TICKETED", isLCC: true, origin: { code: "DEL", city: "Delhi" }, destination: { code: "BOM", city: "Mumbai" },
    departureTime: "x", arrivalTime: "y", airlineCode: "6E", airlineName: "IndiGo", flightNumber: "1",
    passengers: [{ firstName: "A", lastName: "B", paxType: "adult", isLead: true }],
    baseFare: 9000, taxes: 1000, extras: 0, totalFare: 10000, paymentMode: "personal",
  } as any);
  await grant(AGENT, "WRITE");
  await grant(VIEWER, "READ");

  for (const m of [...Object.values(tbo), ...Object.values(rzp), ...Object.values(hotelSvc), mail.sendMail]) (m as any).mockReset();
  tbo.releasePNR.mockResolvedValue({});
  tbo.getBookingDetails.mockResolvedValue(null);
  hotelSvc.getBookingDetail.mockResolvedValue(null);
  mail.sendMail.mockResolvedValue({});
  tbo.getFareQuote.mockImplementation(async (body: any) => ({
    Response: { ResponseStatus: 1, TraceId: body.TraceId,
      Results: { ResultIndex: body.ResultIndex, IsLCC: true, Fare: { PublishedFare: 11999.5, OfferedFare: 11500 } } },
  }));
  tbo.getSSR.mockImplementation(async () => ({ Response: { ResponseStatus: 1 } }));
  tbo.ticketLCC.mockImplementation(async (p: any) => ({
    Response: { ResponseStatus: 1, TraceId: p.TraceId, Response: { BookingId: 700000 + (++seq), PNR: `PNR${seq}`,
      FlightItinerary: { Passenger: [{ Ticket: { TicketId: 900 + seq } }] } } },
  }));
  rzp.createRazorpayOrder.mockImplementation(async (paise: number) => ({ id: `order_${++seq}`, amount: paise, currency: "INR" }));
});

const noSupplierOrGatewayCalls = () => {
  expect(tbo.ticketLCC).not.toHaveBeenCalled();
  expect(tbo.bookFlight).not.toHaveBeenCalled();
  expect(tbo.ticketFlight).not.toHaveBeenCalled();
  expect(hotelSvc.generateHotelVoucher).not.toHaveBeenCalled();
  expect(rzp.createRazorpayOrder).not.toHaveBeenCalled();
  expect(rzp.fetchRazorpayPayment).not.toHaveBeenCalled();
};

describe("old direct routes refuse customers", () => {
  for (const [path, body] of DIRECT_ROUTES) {
    it(`customer → 403 CHECKOUT_REQUIRED on ${path.replace(String(HELD_HOTEL), ":id")}`, async () => {
      const r = await as(request(app).post(path), CUSTOMER, String(WS)).send({ ...body, paymentMode: "official" });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("CHECKOUT_REQUIRED");
      noSupplierOrGatewayCalls();
    });
  }

  it("a tenant ADMIN of a customer workspace is still a customer", async () => {
    const r = await as(request(app).post("/api/sbt/flights/ticket-lcc"), CUSTOMER, String(WS), ["ADMIN"])
      .send({ TraceId: "T1", ResultIndex: "RI-1", Passengers: [], paymentMode: "official" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("CHECKOUT_REQUIRED");
  });

  it("an Admin Queue grant only counts when signed in to HOUSE", async () => {
    await grant(CUSTOMER, "WRITE", String(WS));
    const r = await as(request(app).post("/api/sbt/flights/payment/create-order"), CUSTOMER, String(WS)).send({ quoteIds: ["q"] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("CHECKOUT_REQUIRED");
  });

  it("customer reissue-order: refused with the Travel Desk message, no payment order", async () => {
    const r = await as(request(app).post(`/api/sbt/flights/bookings/${BOOKING}/reissue-order`), CUSTOMER, String(WS))
      .send({ ResultIndex: "RI-NEW", priceDiff: 2000 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("FARE_DIFFERENCE_TRAVEL_DESK");
    expect(rzp.createRazorpayOrder).not.toHaveBeenCalled();
  });
});

describe("Plumtrips staff only", () => {
  const ticketNoPayment = (userId: mongoose.Types.ObjectId, roles?: string[]) =>
    as(request(app).post("/api/sbt/flights/ticket-lcc"), userId, HOUSE, roles)
      .send({ TraceId: "T1", ResultIndex: "RI-1", Passengers: [] });

  it("HOUSE without a grant, or with READ only, is refused", async () => {
    for (const who of [HOUSE_STAFF, VIEWER]) {
      const r = await ticketNoPayment(who, ["EMPLOYEE"]);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("CHECKOUT_REQUIRED");
    }
  });

  it("an Admin Queue WRITE agent passes the lock (the payment gate still applies)", async () => {
    const r = await ticketNoPayment(AGENT, ["EMPLOYEE"]);
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("PAYMENT_REQUIRED");
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("SUPERADMIN passes the lock", async () => {
    const r = await ticketNoPayment(SUPER, ["SUPERADMIN"]);
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("PAYMENT_REQUIRED");
  });

  it("an agent can open a hotel payment order", async () => {
    await col("sbtquotes").insertOne({
      quoteId: "hq-1", product: "HOTEL", serverDisplayFare: 8450, serverNetFare: 8000, sourceRef: "BC-1",
      userId: String(AGENT), workspaceId: HOUSE, createdAt: new Date(),
    } as any);
    const r = await as(request(app).post("/api/sbt/hotels/payment/create-order"), AGENT, HOUSE, ["EMPLOYEE"]).send({ quoteId: "hq-1" });
    expect(r.status).toBe(200);
    expect(rzp.createRazorpayOrder).toHaveBeenCalledWith(845000, expect.any(String));
  });
});

describe("checkout is unaffected for customers", () => {
  it("a customer's wallet checkout still tickets through the in-process handler", async () => {
    const fq = await as(request(app).post("/api/sbt/flights/farequote"), CUSTOMER, String(WS)).send({ TraceId: "T1", ResultIndex: "RI-1" });
    await as(request(app).post("/api/sbt/flights/ssr"), CUSTOMER, String(WS)).send({ TraceId: "T1", ResultIndex: "RI-1" });
    const q = fq.body.Response.Results.quoteId as string;
    const c = await as(request(app).post("/api/sbt/flights/checkout"), CUSTOMER, String(WS)).send({
      kind: "FLIGHT_LCC", mode: "official", quoteIds: [q],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: [{ FirstName: "A", LastName: "B", PaxType: 1, IsLeadPax: true }] },
      save: {
        origin: { code: "DEL", city: "Delhi" }, destination: { code: "BOM", city: "Mumbai" },
        departureTime: "2026-11-01T06:00:00", arrivalTime: "2026-11-01T08:00:00",
        airlineCode: "6E", airlineName: "IndiGo", flightNumber: "101", baseFare: 1, taxes: 0, totalFare: 1,
        passengers: [{ firstName: "A", lastName: "B", paxType: "adult", isLead: true }],
      },
    });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("TICKETED");
    expect(tbo.ticketLCC).toHaveBeenCalledTimes(1);
    const booking: any = await col("sbtbookings").findOne({ userId: CUSTOMER, _id: { $ne: BOOKING } });
    expect(booking.totalFare).toBe(12000);
  });

  it("a customer's card checkout still opens a Razorpay order", async () => {
    const fq = await as(request(app).post("/api/sbt/flights/farequote"), CUSTOMER, String(WS)).send({ TraceId: "T1", ResultIndex: "RI-1" });
    const q = fq.body.Response.Results.quoteId as string;
    const c = await as(request(app).post("/api/sbt/flights/checkout"), CUSTOMER, String(WS)).send({
      kind: "FLIGHT_LCC", mode: "personal", quoteIds: [q],
      request: { TraceId: "T1", ResultIndex: "RI-1", Passengers: [{ FirstName: "A", LastName: "B", PaxType: 1, IsLeadPax: true }] },
      save: { totalFare: 1 },
    });
    expect(c.status).toBe(200);
    expect(c.body.serverAmount).toBe(12000);
    expect(rzp.createRazorpayOrder).toHaveBeenCalledWith(1200000, expect.any(String));
  });
});
