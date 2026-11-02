// apps/backend/src/routes/approvals.searchPrices.test.ts
//
// The per-workspace price switch on approval live search (slice S3, inert):
//   - config.features.approvalFlightPricesEnabled / approvalHotelPricesEnabled,
//     read off the lean req.workspace with === true (missing = OFF)
//   - OFF: the response is exactly today's, no `display` anywhere
//   - ON: a separate `display` per flight fare / hotel room, the SELLING total
//     from sellingFlight / customerRoom on the workspace's margin (override
//     first), nothing else priced
//   - SUPERADMIN and HOUSE get no bypass
//   - a client-sent `display` never reaches the request or the snapshot
//   - margins not live on this server (marginsLiveHere), or the SBT margin
//     master switch off (every percent resolves to 0 = net): no display
//
// Real: approvals router, search gates, searchHotels, margin engine (F13: margins
// are switched on for this process with SBT_MARGINS_LOCAL=1), session and
// snapshot models, on an in-memory Mongo. Stubbed: requireAuth / requireWorkspace
// (headers), searchFlights (TBO), TBO hotel HTTP (global fetch), mail.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.SBT_MARGINS_LOCAL = "1";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";
delete process.env.TBO_ENV;

vi.mock("../middleware/auth.js", () => {
  const requireAuth = async (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    const { default: mg } = await import("mongoose");
    const users = mg.connection.db!.collection("users");
    const sub = String(req.user.sub || "");
    if (mg.isValidObjectId(sub) && !(await users.findOne({ _id: new mg.Types.ObjectId(sub) }))) {
      await users.insertOne({ _id: new mg.Types.ObjectId(sub), email: req.user.email, roles: req.user.roles || [] } as any);
    }
    next();
  };
  return { requireAuth, default: requireAuth };
});
// Like the real one: the workspace is a LEAN document, so schema defaults never apply.
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: async (req: any, res: any, next: any) => {
    const { default: mg } = await import("mongoose");
    const id = String(req.headers["x-test-ws"] || "");
    const ws = await mg.connection.db!.collection("customerworkspaces").findOne({ _id: new mg.Types.ObjectId(id) });
    if (!ws) return res.status(403).json({ error: "no workspace" });
    req.workspace = ws;
    req.workspaceObjectId = ws._id;
    req.workspaceId = String(ws._id);
    next();
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));
vi.mock("../utils/emailActionToken.js", () => ({ signEmailActionToken: () => "tok", verifyEmailActionToken: () => null }));
vi.mock("../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
vi.mock("../services/tbo.hotel.shared.js", async (orig) => ({ ...(await orig<any>()), hotelAuthHeader: () => "Basic test" }));
const tbo = vi.hoisted(() => ({ flights: null as any }));
vi.mock("../services/tbo.flight.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  tbo.flights = v.fn();
  return { ...(await orig<any>()), searchFlights: tbo.flights };
});

const { default: approvalsRouter } = await import("./approvals.js");
const { default: superadminWorkspacesRouter } = await import("./superadmin.workspaces.js");
const { isPriceKey } = await import("./approvals.security.js");
const { invalidateMarginCache } = await import("../utils/margin.js");
const { invalidateOverrideCache } = await import("../services/sbtMargin.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
app.use("/api/superadmin", superadminWorkspacesRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const WS = {
  missing: oid(), off: oid(), flight: oid(), hotel: oid(), override: oid(), plain: oid(), switched: oid(),
};
const REQ = oid();
const SA = oid();
const STAFF = oid();
const REQ_FC = oid(); // own user: the per-user search limit would trip on REQ
const REQ_E2E = oid();
const REQ_MS = oid();

const ws = (_id: any, customerId: string, prices?: { flight?: boolean; hotel?: boolean }) => ({
  _id, customerId, name: `WS ${customerId}`, status: "ACTIVE", tenantType: "CORPORATE",
  defaultApproverEmails: ["approver@cust.test"],
  config: {
    travelFlow: "APPROVAL_FLOW",
    features: {
      approvalFlowEnabled: true,
      // `prices` absent = the keys are missing from the stored document altogether.
      ...(prices?.flight !== undefined ? { approvalFlightPricesEnabled: prices.flight } : {}),
      ...(prices?.hotel !== undefined ? { approvalHotelPricesEnabled: prices.hotel } : {}),
    },
  },
});

// Defaults: flight 10 %, hotel 8 % (domestic). Override workspace: 20 % both.
const DEFAULTS = { enabled: true, flight: { domestic: 10, international: 12 }, hotel: { domestic: 8, international: 15 }, version: 1 };

/* ── TBO-shaped raw results: net prices and our cost keys everywhere ──────── */

const seg = (no: string, dep: string) => ({
  Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: no },
  Origin: { Airport: { AirportCode: "BLR", CityName: "Bengaluru", Terminal: "1", CountryCode: "IN" }, DepTime: dep },
  Destination: { Airport: { AirportCode: "BOM", CityName: "Mumbai", Terminal: "2", CountryCode: "IN" }, ArrTime: dep.replace("T06", "T08") },
  Duration: 105, GroundTime: 0, Baggage: "15 Kg", CabinBaggage: "7 Kg", CabinClass: 2,
});
// PublishedFare is TBO's total for every passenger searched.
const flightRaw = (no: string, dep: string, fareType: string, published: number) => ({
  ResultIndex: `OB-${no}-${fareType}`, IsLCC: true, IsRefundable: true, FareClassification: { Type: fareType },
  Fare: {
    Currency: "INR", BaseFare: published - 800, Tax: 800, YQTax: 300, PublishedFare: published, OfferedFare: published - 152,
    CommissionEarned: 120, PLBEarned: 30, TdsOnCommission: 6, OtherCharges: 50,
  },
  FareBreakdown: [{ Currency: "INR", PassengerType: 1, PassengerCount: 2, BaseFare: published - 800, Tax: 800 }],
  MiniFareRules: [[{ Type: "Cancellation", Details: "INR 3,500" }]],
  Segments: [[seg(no, dep)]],
});
const FLIGHTS = [
  flightRaw("5321", "2027-03-12T06:10:00", "Saver", 5432),
  flightRaw("5321", "2027-03-12T06:10:00", "Flexi", 6250),
  flightRaw("6123", "2027-03-12T06:45:00", "Saver", 4980),
];
// Selling = net × (1 + pct), whole rupee rounded up.
const SELL = {
  default: { 5432: 5976, 6250: 6875, 4980: 5478 } as Record<number, number>,
  override: { 5432: 6519, 6250: 7500, 4980: 5976 } as Record<number, number>,
};

const CITY = "144306";
const NET_ROOM = { Deluxe: 10000, Suite: 15000 } as Record<string, number>;
const tboRoom = (name: string) => ({
  Name: [name], BookingCode: `H1!TB!${name}`, TotalFare: NET_ROOM[name], TotalTax: 1200, NetAmount: NET_ROOM[name],
  DayRates: [[{ BasePrice: (NET_ROOM[name] - 1200) / 2 }, { BasePrice: (NET_ROOM[name] - 1200) / 2 }]],
  MealType: "Room_Only", IsRefundable: true, Inclusion: "Free WiFi",
  CancelPolicies: [{ FromDate: "11-03-2027 00:00:00", ChargeType: "Fixed", CancellationCharge: 2500 }],
});

const user = (sub: any, roles: string[] = ["EMPLOYEE"]) =>
  JSON.stringify({ sub: String(sub), email: `${String(sub)}@cust.test`, name: "Test User", roles });
const as = (r: request.Test, wsId: any, sub: any = REQ, roles?: string[]) =>
  r.set("x-test-user", user(sub, roles)).set("x-test-ws", String(wsId));

const flightBody = { origin: "BLR", destination: "BOM", departDate: "2027-03-12", adults: 2 };
const hotelBody = { city: "mumbai", checkIn: "2027-03-12", checkOut: "2027-03-14", adults: 1, rooms: 1 };
const searchFlights = (wsId: any, sub?: any, roles?: string[]) =>
  as(request(app).post("/api/approvals/search/flights"), wsId, sub, roles).send(flightBody);
const searchHotels = (wsId: any, sub?: any, roles?: string[]) =>
  as(request(app).post("/api/approvals/search/hotels"), wsId, sub, roles).send(hotelBody);

/* ── walkers ─────────────────────────────────────────────────────────────── */

function paths(v: any, path = "$"): string[] {
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  for (const k of Object.keys(v)) {
    const p = Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`;
    out.push(p, ...paths(v[k], p));
  }
  return out;
}
const priceKeyPaths = (v: any) => paths(v).filter((p) => !p.endsWith("]") && isPriceKey(p.split(".").pop()!));
const displayPaths = (v: any) => paths(v).filter((p) => /\.display$/.test(p));
const COST = /_net|_margin|_markup|_display|_rsp|OfferedFare|PublishedFare|Commission|PLB|Tds|BaseFare|YQTax|DayRates|TotalFare|TotalTax|NetAmount|CancellationCharge|RecommendedSellingRate|5432|6250|4980|5280|10000|15000|2500/;

// Session ids and times differ between two searches; nothing else may.
const normalise = (body: any) =>
  JSON.parse(JSON.stringify(body).replace(/"optionRef":"[^"]+"/g, '"optionRef":"ref"').replace(/"searchedAt":"[^"]+"/g, '"searchedAt":"t"'));
const withoutDisplay = (body: any): any =>
  Array.isArray(body) ? body.map(withoutDisplay)
    : body && typeof body === "object"
      ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== "display").map(([k, v]) => [k, withoutDisplay(v)]))
      : body;

/* ── setup ───────────────────────────────────────────────────────────────── */

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-search-prices-test"));
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    ws(WS.missing, "C1"),
    ws(WS.off, "C2", { flight: false, hotel: false }),
    ws(WS.flight, "C3", { flight: true, hotel: false }),
    ws(WS.hotel, "C4", { flight: false, hotel: true }),
    ws(WS.override, "C5", { flight: true, hotel: true }),
    ws(WS.plain, "C6", { flight: true, hotel: true }),
    ws(WS.switched, "C7"),
    { ...ws(HOUSE, "PLUMTRIPS-HOUSE"), name: "Plumtrips" },
  ] as any[]);
  await col("sbtconfigs").insertOne({ key: "margins", value: DEFAULTS } as any);
  await col("sbtmarginoverrides").insertOne({
    workspaceId: WS.override, flight: { domestic: 20, international: null }, hotel: { domestic: 20, international: null },
  } as any);
  await col("tbocities").insertOne({ code: CITY, name: "Mumbai", searchName: "mumbai", countryCode: "IN" });
  await col("tbohotelmasters").insertOne({ hotelCode: "H1", hotelName: "Hotel One", cityCode: CITY, countryCode: "IN", rating: "FiveStar", address: "Bandra" });

  vi.stubGlobal("fetch", async (_url: any, init?: any) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const codes = String(body.HotelCodes || "").split(",").filter(Boolean);
    return new Response(JSON.stringify({
      Status: { Code: 200 },
      HotelResult: codes.map((c) => ({ HotelCode: c, Currency: "INR", Rooms: [tboRoom("Suite"), tboRoom("Deluxe")] })),
    }), { status: 200 });
  });
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  tbo.flights.mockReset();
  tbo.flights.mockResolvedValue({ Response: { ResponseStatus: 1, TraceId: "t1", Results: [FLIGHTS.map((f) => structuredClone(f))] } });
  invalidateMarginCache();
  invalidateOverrideCache();
  for (const c of ["approvalsearchsessions", "approvalrequests", "approvalselectionsnapshots"]) await col(c).deleteMany({});
});

/* ── tests ───────────────────────────────────────────────────────────────── */

describe("price switch OFF: today's response", () => {
  for (const [label, id] of [["flags missing on the lean document", WS.missing], ["flags false", WS.off]] as const) {
    it(`${label}: flights and hotels carry no display, and match the ON response without it`, async () => {
      const [f, h] = [await searchFlights(id), await searchHotels(id)];
      expect([f.status, h.status]).toEqual([200, 200]);
      expect(displayPaths(f.body)).toEqual([]);
      expect(displayPaths(h.body)).toEqual([]);
      expect(priceKeyPaths(f.body)).toEqual([]);
      expect(priceKeyPaths(h.body)).toEqual([]);

      const [fOn, hOn] = [await searchFlights(WS.plain), await searchHotels(WS.plain)];
      expect(displayPaths(fOn.body).length).toBeGreaterThan(0);
      expect(normalise(f.body)).toEqual(normalise(withoutDisplay(fOn.body)));
      expect(normalise(h.body)).toEqual(normalise(withoutDisplay(hOn.body)));
    });
  }
});

describe("price switch ON", () => {
  it("flights ON, hotels OFF: display on every fare only", async () => {
    const f = await searchFlights(WS.flight);
    expect(f.body.outbound.map((o: any) => o.display?.amount)).toEqual([SELL.default[5432], SELL.default[6250], SELL.default[4980]]);
    expect(displayPaths(await searchHotels(WS.flight).then((r) => r.body))).toEqual([]);
  });

  it("hotels ON, flights OFF: display on every room only", async () => {
    const h = await searchHotels(WS.hotel);
    // Rooms stay in name order; each display belongs to its own room.
    expect(h.body.hotels[0].rooms.map((r: any) => [r.roomName, r.display?.amount])).toEqual([["Deluxe", 10800], ["Suite", 16200]]);
    expect(displayPaths(await searchFlights(WS.hotel).then((r) => r.body))).toEqual([]);
  });

  it("an override workspace sells on the override percent; others on the default", async () => {
    const fo = await searchFlights(WS.override);
    expect(fo.body.outbound.map((o: any) => o.display.amount)).toEqual([SELL.override[5432], SELL.override[6250], SELL.override[4980]]);
    const ho = await searchHotels(WS.override);
    expect(ho.body.hotels[0].rooms.map((r: any) => r.display.amount)).toEqual([12000, 18000]);

    const fp = await searchFlights(WS.plain);
    expect(fp.body.outbound.map((o: any) => o.display.amount)).toEqual([SELL.default[5432], SELL.default[6250], SELL.default[4980]]);
  });

  it("display is exactly {amount, currency, basis, searchedAt}; nothing else priced at any depth", async () => {
    for (const body of [(await searchFlights(WS.override)).body, (await searchHotels(WS.override)).body]) {
      const displays = displayPaths(body);
      expect(displays.length).toBeGreaterThan(0);
      for (const p of displays) {
        const d = p.slice(2).split(/\.|\[|\]\.?/).filter(Boolean).reduce((o: any, k) => o[k], body);
        expect(Object.keys(d).sort()).toEqual(["amount", "basis", "currency", "searchedAt"]);
        expect(d).toMatchObject({ currency: "INR", basis: "total_all_travellers", searchedAt: body.searchedAt });
        expect(Number.isInteger(d.amount)).toBe(true);
      }
      expect(priceKeyPaths(body).every((p) => p.endsWith(".display.amount"))).toBe(true);
      expect(JSON.stringify(withoutDisplay(body))).not.toMatch(/"amount"/);
      expect(JSON.stringify(body)).not.toMatch(COST);
    }
  });

  it("order is the same with or without prices", async () => {
    const order = (b: any) => b.outbound.map((o: any) => `${o.legs[0].segments[0].flightNumber}/${o.legs[0].productLabel}`);
    expect(order((await searchFlights(WS.plain)).body)).toEqual(order((await searchFlights(WS.off)).body));
  });
});

describe("fail closed: margins not live on this server", () => {
  it("flags ON but margins off here: no display at all (never net as selling), logged once", async () => {
    const { travelRequestLogger } = await import("../utils/logger.js");
    const info = vi.spyOn(travelRequestLogger, "info");
    delete process.env.SBT_MARGINS_LOCAL;
    try {
      for (let i = 0; i < 2; i++) {
        const [f, h] = [await searchFlights(WS.plain, REQ_FC), await searchHotels(WS.plain, REQ_FC)];
        expect([f.status, h.status]).toEqual([200, 200]);
        expect([...displayPaths(f.body), ...displayPaths(h.body)]).toEqual([]);
        expect(priceKeyPaths(f.body)).toEqual([]);
        expect(priceKeyPaths(h.body)).toEqual([]);
      }
      const withheld = info.mock.calls.filter(([m]) => String(m).includes("price display withheld"));
      expect(withheld).toHaveLength(1);
    } finally {
      process.env.SBT_MARGINS_LOCAL = "1";
      info.mockRestore();
    }
  });

  it("the same workspace with SBT_MARGINS_LOCAL=1: display is back", async () => {
    const [f, h] = [await searchFlights(WS.plain, REQ_FC), await searchHotels(WS.plain, REQ_FC)];
    expect([f.status, h.status]).toEqual([200, 200]);
    expect(displayPaths(f.body).length).toBeGreaterThan(0);
    expect(displayPaths(h.body).length).toBeGreaterThan(0);
  });
});

describe("fail closed: margin master switch off", () => {
  it("margins live here but SBTConfig margins.enabled false: no display (it would be net), logged once", async () => {
    const { travelRequestLogger } = await import("../utils/logger.js");
    const info = vi.spyOn(travelRequestLogger, "info");
    await col("sbtconfigs").updateOne({ key: "margins" }, { $set: { "value.enabled": false } });
    invalidateMarginCache();
    try {
      for (let i = 0; i < 2; i++) {
        const [f, h] = [await searchFlights(WS.plain, REQ_MS), await searchHotels(WS.plain, REQ_MS)];
        expect([f.status, h.status]).toEqual([200, 200]);
        expect([...displayPaths(f.body), ...displayPaths(h.body)]).toEqual([]);
        expect(priceKeyPaths(f.body)).toEqual([]);
        expect(priceKeyPaths(h.body)).toEqual([]);
        expect(JSON.stringify([f.body, h.body])).not.toMatch(COST);
      }
      const withheld = info.mock.calls.filter(([m]) => String(m).includes("margin master switch is off"));
      expect(withheld).toHaveLength(1);
    } finally {
      await col("sbtconfigs").updateOne({ key: "margins" }, { $set: { "value.enabled": true } });
      invalidateMarginCache();
      info.mockRestore();
    }
  });

  it("switched back on: display is back", async () => {
    const [f, h] = [await searchFlights(WS.plain, REQ_MS), await searchHotels(WS.plain, REQ_MS)];
    expect(displayPaths(f.body).length).toBeGreaterThan(0);
    expect(displayPaths(h.body).length).toBeGreaterThan(0);
  });
});

describe("no bypass", () => {
  it("SUPERADMIN on a workspace with prices OFF: no display", async () => {
    const f = await searchFlights(WS.off, SA, ["SUPERADMIN"]);
    const h = await searchHotels(WS.off, SA, ["SUPERADMIN"]);
    expect([f.status, h.status]).toEqual([200, 200]);
    expect([...displayPaths(f.body), ...displayPaths(h.body)]).toEqual([]);
  });

  it("HOUSE staff on the HOUSE workspace (prices OFF): no display", async () => {
    const f = await searchFlights(HOUSE, STAFF, ["ADMIN"]);
    const h = await searchHotels(HOUSE, STAFF, ["ADMIN"]);
    expect([f.status, h.status]).toEqual([200, 200]);
    expect([...displayPaths(f.body), ...displayPaths(h.body)]).toEqual([]);
  });
});

describe("saving a request: display is shown, never stored", () => {
  it("a client-sent display, top level or inside selection, reaches neither meta nor the snapshot", async () => {
    const f = await searchFlights(WS.plain);
    const opt = f.body.outbound[0];
    expect(opt.display).toBeDefined();
    const fake = { amount: 1, currency: "INR", basis: "total_all_travellers", searchedAt: opt.display.searchedAt };
    const created = await as(request(app).post("/api/approvals/requests"), WS.plain).send({
      customerId: "C6",
      cartItems: [{
        type: "flight", title: "BLR → BOM", qty: 1, price: 0,
        meta: {
          origin: "BLR", destination: "BOM", departDate: "2027-03-12",
          travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }],
          optionRef: opt.optionRef, display: fake, selection: { ...opt, display: fake },
        },
      }],
    });
    expect(created.status).toBe(200);
    const doc: any = await col("approvalrequests").findOne({});
    expect(doc.cartItems[0].meta.display).toBeUndefined();
    expect(doc.cartItems[0].meta.selection.display).toBeUndefined();
    expect(doc.cartItems[0].meta.selection.optionRef).toBe(opt.optionRef);
    const snap: any = await col("approvalselectionsnapshots").findOne({});
    expect(snap.selection.display).toBeUndefined();
    expect(JSON.stringify(doc.cartItems)).not.toMatch(/"display"/);
  });
});

describe("end to end: the Workspace Manager switch", () => {
  const set = (feature: string, enabled: boolean) =>
    request(app).put(`/api/superadmin/workspaces/${WS.switched}/features`).set("x-test-user", user(SA, ["SUPERADMIN"])).send({ feature, enabled });
  const shown = async () => ({
    flight: displayPaths((await searchFlights(WS.switched, REQ_E2E)).body).length > 0,
    hotel: displayPaths((await searchHotels(WS.switched, REQ_E2E)).body).length > 0,
  });

  it("flight / hotel switched ON through the superadmin route shows prices; OFF hides them", async () => {
    expect(await shown()).toEqual({ flight: false, hotel: false });

    expect((await set("approvalFlightPricesEnabled", true)).status).toBe(200);
    expect(await shown()).toEqual({ flight: true, hotel: false });
    const f = await searchFlights(WS.switched, REQ_E2E);
    expect(f.body.outbound.map((o: any) => o.display.amount)).toEqual([SELL.default[5432], SELL.default[6250], SELL.default[4980]]);

    expect((await set("approvalHotelPricesEnabled", true)).status).toBe(200);
    expect(await shown()).toEqual({ flight: true, hotel: true });

    expect((await set("approvalFlightPricesEnabled", false)).status).toBe(200);
    expect(await shown()).toEqual({ flight: false, hotel: true });

    expect((await set("approvalHotelPricesEnabled", false)).status).toBe(200);
    expect(await shown()).toEqual({ flight: false, hotel: false });
  });
});
