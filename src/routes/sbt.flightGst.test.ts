// apps/backend/src/routes/sbt.flightGst.test.ts
//
// Client multi-GST P0 side fixes on SBT flights (docs/audits/client-multi-gst-audit.md):
//   • F4: the client's GST details go to TBO only when the fare's stored
//     FareQuote says GSTAllowed or IsGSTMandatory — never on other fares, even
//     when the browser sends a pre-filled GSTIN. A mandatory-GST fare without
//     a GSTIN is refused before TBO is called, and the server's IsGSTMandatory
//     (not the browser's) reaches the TBO call.
//   • N3: the corporate PAN falls back to the company's Customer.panNumber when
//     its workspace has no PAN.
//
// Real: flights router, services/sbtQuote + sbtPaymentGate, models, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers), TBO flight service calls,
//   TBO loggers, mail. Same stubs as sbt.netFare.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";
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
      customerId: String(req.headers["x-test-ws-customer"] || ""),
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
vi.mock("../services/tbo.session.helper.js", () => ({
  withTBOSessionRetry: async (fn: (t: string) => Promise<unknown>) => fn("tok"),
}));
vi.mock("../jobs/static-data-refresh.js", () => ({
  resolveCityCodeAgainstCatalog: () => null,
  resolveCityCode: () => null,
  TBOHotelMaster: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../jobs/deferred-status-check.js", () => ({ runDeferredStatusCheck: async () => {} }));
vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: vi.fn(async () => ({})) }));
vi.mock("../utils/companySettings.js", async (orig) => ({
  ...(await orig<any>()),
  getCompanySettings: async () => ({ opsEmail: "ops@test", supportEmail: "support@test", accountManagerEmail: "" }),
}));

const NET_FARE = { Currency: "INR", BaseFare: 8000, Tax: 1800, YQTax: 600, PublishedFare: 9800, OfferedFare: 9500 };
const NET_BREAKDOWN = [{ PassengerType: 1, PassengerCount: 1, Currency: "INR", BaseFare: 8000, Tax: 1800, YQTax: 600 }];
// What TBO's FareQuote says about GST on this fare.
let fareGst: Record<string, unknown> = {};
const flightResult = (ri: string, isLCC = true) => ({
  ResultIndex: ri, IsLCC: isLCC, Fare: { ...NET_FARE }, FareBreakdown: NET_BREAKDOWN.map((r) => ({ ...r })),
  Segments: [[{ Airline: { AirlineCode: "6E", FlightNumber: "101" }, Origin: { Airport: { AirportCode: "DEL" } }, Destination: { Airport: { AirportCode: "BOM" } } }]],
  ...fareGst,
});
let seq = 0;
const ticketed = () => ({
  Response: {
    ResponseStatus: 1, TraceId: "T1",
    Response: { BookingId: 700000 + (++seq), PNR: `PNR${seq}`, FlightItinerary: { BookingId: 700000 + seq, PNR: `PNR${seq}`, Passenger: [] } },
  },
});

const tbo = vi.hoisted(() => ({
  getFareQuote: vi.fn(),
  ticketLCC: vi.fn(),
  bookFlight: vi.fn(),
  getBookingDetails: vi.fn(async () => null),
}));
vi.mock("../services/tbo.flight.service.js", async (orig) => ({ ...(await orig<any>()), ...tbo }));

const { default: flightsRouter } = await import("./sbt.flights.js");
const app = express();
app.use(express.json());
app.use("/api/sbt/flights", flightsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const HOUSE = "69679a7628330a58d29f2254";
const HOUSE_CUSTOMER = oid();
const STAFF = oid();
const asStaff = (r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ _id: String(STAFF), id: String(STAFF), sub: String(STAFF), email: "desk@plumtrips.com", roles: ["SUPERADMIN"] }))
    .set("x-test-ws", HOUSE).set("x-test-ws-customer", String(HOUSE_CUSTOMER));

const CLIENT_GST = {
  GSTNumber: "07AAHCM5991L1ZS", GSTCompanyName: "Molnlycke Health Care", GSTCompanyAddress: "New Delhi",
  GSTCompanyContactNumber: "9999999999", GSTCompanyEmail: "ap@example.test",
};
const pax = (gst: Record<string, string> = CLIENT_GST) => [
  { Title: "Mr", FirstName: "Asha", LastName: "Rao", PaxType: 1, Gender: 1, IsLeadPax: true, ...gst },
  { Title: "Mr", FirstName: "Ravi", LastName: "Rao", PaxType: 1, Gender: 1, IsLeadPax: false },
];
const gstKeys = (p: any) => Object.keys(p).filter((k) => k.startsWith("GST"));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-flight-gst-test"));
  await mongoose.model("SBTPayment").syncIndexes();
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await col("users").insertOne({ _id: STAFF, email: "desk@plumtrips.com", sbtEnabled: true, roles: ["SUPERADMIN"] } as any);
  await col("customerworkspaces").insertOne({
    _id: new mongoose.Types.ObjectId(HOUSE), status: "ACTIVE", customerId: String(HOUSE_CUSTOMER), companyName: "Plumtrips",
    sbtOfficialBooking: { enabled: true, creditLimit: 10000000, used: 0 },
  } as any);
  for (const m of Object.values(tbo)) (m as any).mockReset();
  tbo.getBookingDetails.mockResolvedValue(null);
  fareGst = {};
  tbo.getFareQuote.mockImplementation(async (b: any) => ({
    Response: { ResponseStatus: 1, TraceId: b.TraceId, Results: flightResult(b.ResultIndex, b.ResultIndex !== "RI-GDS") },
  }));
  tbo.ticketLCC.mockImplementation(async () => ticketed());
  tbo.bookFlight.mockImplementation(async () => ({
    Response: { ResponseStatus: 1, Response: { PNR: "GDS1", BookingId: 8100, FlightItinerary: { Passenger: [] } } },
  }));
});

async function quote(ri = "RI-1") {
  const fq = await asStaff(request(app).post("/api/sbt/flights/farequote")).send({ TraceId: "T1", ResultIndex: ri, originCountry: "IN", destCountry: "IN" });
  expect(fq.status).toBe(200);
  return fq.body.quoteId as string;
}
const ticketLcc = (quoteId: string, body: Record<string, unknown> = {}) =>
  asStaff(request(app).post("/api/sbt/flights/ticket-lcc")).send({
    TraceId: "T1", ResultIndex: "RI-1", Passengers: pax(), quoteIds: [quoteId], paymentMode: "official", ...body,
  });

describe("F4: GST details reach TBO only on fares that take GST", () => {
  it("GSTAllowed false: a pre-filled GSTIN is removed from every passenger before TBO", async () => {
    fareGst = { GSTAllowed: false, IsGSTMandatory: false };
    const q = await quote();
    expect(((await col("sbtquotes").findOne({ quoteId: q })) as any)).toMatchObject({ gstAllowed: false, isGstMandatory: false });
    const r = await ticketLcc(q);
    expect(r.status).toBe(200);
    const sent = tbo.ticketLCC.mock.calls[0][0];
    for (const p of sent.Passengers) expect(gstKeys(p)).toEqual([]);
    expect(sent.Passengers[0].FirstName).toBe("Asha");
    expect(sent.IsGSTMandatory).toBe(false);
  });

  it("GSTAllowed true: the client's GST details go on the lead passenger as before", async () => {
    fareGst = { GSTAllowed: true, IsGSTMandatory: false };
    const r = await ticketLcc(await quote());
    expect(r.status).toBe(200);
    expect(tbo.ticketLCC.mock.calls[0][0].Passengers[0]).toMatchObject(CLIENT_GST);
  });

  it("IsGSTMandatory: refused before TBO when the lead passenger has no GSTIN", async () => {
    fareGst = { GSTAllowed: true, IsGSTMandatory: true };
    const r = await ticketLcc(await quote(), { Passengers: pax({}) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("GST_REQUIRED");
    expect(tbo.ticketLCC).not.toHaveBeenCalled();
  });

  it("IsGSTMandatory: the server's flag reaches TBO with the GST details (the browser's flag is ignored)", async () => {
    fareGst = { GSTAllowed: false, IsGSTMandatory: true };
    const r = await ticketLcc(await quote(), { IsGSTMandatory: false });
    expect(r.status).toBe(200);
    const sent = tbo.ticketLCC.mock.calls[0][0];
    expect(sent.IsGSTMandatory).toBe(true);
    expect(sent.Passengers[0]).toMatchObject(CLIENT_GST);
  });

  it("GDS /book: GSTAllowed false strips the GST details too", async () => {
    fareGst = { GSTAllowed: false, IsGSTMandatory: false };
    const q = await quote("RI-GDS");
    const r = await asStaff(request(app).post("/api/sbt/flights/book")).send({
      TraceId: "T1", ResultIndex: "RI-GDS", Passengers: pax(), quoteIds: [q], paymentMode: "official", isLCC: false,
    });
    expect(r.status).toBe(200);
    const sent = tbo.bookFlight.mock.calls[0][0];
    for (const p of sent.Passengers) expect(gstKeys(p)).toEqual([]);
    expect(sent.IsGSTMandatory).toBe(false);
  });

  it("a quote taken before the flags were stored passes GST through unchanged", async () => {
    fareGst = {}; // FareQuote without GSTAllowed / IsGSTMandatory
    const q = await quote();
    const stored: any = await col("sbtquotes").findOne({ quoteId: q });
    expect(stored.gstAllowed).toBeUndefined();
    const r = await ticketLcc(q);
    expect(r.status).toBe(200);
    expect(tbo.ticketLCC.mock.calls[0][0].Passengers[0]).toMatchObject(CLIENT_GST);
  });
});

describe("F4: GST allowed but not mandatory — the client's GST status decides", () => {
  // The workspace's Customer carries the GST status stripSbtGstIfUnregistered reads.
  const company = (gstStatus: string) =>
    col("customers").insertOne({ _id: HOUSE_CUSTOMER, name: "Client Co", gstStatus, gstNumber: CLIENT_GST.GSTNumber } as any);
  const lead = (call: any) => call.Passengers.find((p: any) => p.IsLeadPax);

  it("REGISTERED client, LCC: GSTNumber + all four GSTCompany* fields reach TBO on the lead passenger", async () => {
    await company("REGISTERED");
    fareGst = { GSTAllowed: true, IsGSTMandatory: false };
    const r = await ticketLcc(await quote());
    expect(r.status).toBe(200);
    const sent = tbo.ticketLCC.mock.calls[0][0];
    expect(lead(sent)).toMatchObject(CLIENT_GST);
    expect(gstKeys(lead(sent)).sort()).toEqual(Object.keys(CLIENT_GST).sort());
    expect(sent.IsGSTMandatory).toBe(false);
    // Only the lead carries GST (the second passenger never had it).
    expect(gstKeys(sent.Passengers.find((p: any) => !p.IsLeadPax))).toEqual([]);
  });

  it("REGISTERED client, GDS /book: same — all five GST fields on the lead passenger", async () => {
    await company("REGISTERED");
    fareGst = { GSTAllowed: true, IsGSTMandatory: false };
    const q = await quote("RI-GDS");
    const r = await asStaff(request(app).post("/api/sbt/flights/book")).send({
      TraceId: "T1", ResultIndex: "RI-GDS", Passengers: pax(), quoteIds: [q], paymentMode: "official", isLCC: false,
    });
    expect(r.status).toBe(200);
    const sent = tbo.bookFlight.mock.calls[0][0];
    expect(lead(sent)).toMatchObject(CLIENT_GST);
    expect(sent.IsGSTMandatory).toBe(false);
  });

  it("UNREGISTERED (B2C) client on the same GST-allowed fare: no GST field reaches TBO", async () => {
    await company("UNREGISTERED");
    fareGst = { GSTAllowed: true, IsGSTMandatory: false };
    const r = await ticketLcc(await quote());
    expect(r.status).toBe(200);
    for (const p of tbo.ticketLCC.mock.calls[0][0].Passengers) expect(gstKeys(p)).toEqual([]);
  });
});

describe("N3: corporate PAN falls back to the Customer's panNumber", () => {
  it("workspace has no PAN → the company's Customer.panNumber is sent as the corporate PAN", async () => {
    await col("customers").insertOne({ _id: HOUSE_CUSTOMER, name: "Plumtrips", panNumber: "AAACP1234A" } as any);
    fareGst = { GSTAllowed: true };
    const r = await ticketLcc(await quote(), { corporateBookingAllowed: true });
    expect(r.status).toBe(200);
    expect(tbo.ticketLCC.mock.calls[0][0]).toMatchObject({ isCorporate: true, corporatePAN: "AAACP1234A" });
  });

  it("the workspace's own PAN still wins; no PAN anywhere → not corporate", async () => {
    await col("customers").insertOne({ _id: HOUSE_CUSTOMER, name: "Plumtrips", panNumber: "AAACP1234A" } as any);
    await col("customerworkspaces").updateOne({ _id: new mongoose.Types.ObjectId(HOUSE) }, { $set: { pan: "AAACW9999W" } });
    fareGst = { GSTAllowed: true };
    await ticketLcc(await quote(), { corporateBookingAllowed: true });
    expect(tbo.ticketLCC.mock.calls[0][0]).toMatchObject({ isCorporate: true, corporatePAN: "AAACW9999W" });

    await col("customerworkspaces").updateOne({ _id: new mongoose.Types.ObjectId(HOUSE) }, { $set: { pan: "" } });
    await col("customers").updateOne({ _id: HOUSE_CUSTOMER }, { $set: { panNumber: "" } });
    await ticketLcc(await quote(), { corporateBookingAllowed: true });
    expect(tbo.ticketLCC.mock.calls[1][0].isCorporate).toBeUndefined();
  });
});
