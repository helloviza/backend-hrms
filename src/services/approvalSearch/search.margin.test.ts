// apps/backend/src/services/approvalSearch/search.margin.test.ts
//
// The approval hotel search prices on the caller's workspace margin (F1):
// the REAL searchHotels runs, so the margin engine (SBTConfig defaults +
// SBTMarginOverride) decides the stored _displayTotalFare exactly as it does
// for SBT. The customer response stays price-free either way.
//
// Real: searchHotels, resolveMargin, hotel/city masters, session + snapshot
// models, on an in-memory Mongo. Stubbed: TBO hotel HTTP (global fetch), the
// TBO file logger.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.SBT_MARGINS_LOCAL = "1";
delete process.env.TBO_ENV;

vi.mock("../../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
vi.mock("../tbo.hotel.shared.js", async (orig) => ({ ...(await orig<any>()), hotelAuthHeader: () => "Basic test" }));

const { searchHotelsForApproval } = await import("./search.js");
const { prepareCartSelections, writeSelectionSnapshots } = await import("./cartSelections.js");
const { invalidateMarginCache } = await import("../../utils/margin.js");
const { invalidateOverrideCache } = await import("../sbtMargin.js");
const { isPriceKey } = await import("../../routes/approvals.security.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const CITY = "144306";
const WS_OVERRIDE = oid();
const WS_DEFAULT = oid();
const USER = String(oid());

// Net 10000, no RSP floor: default 8% → 10800, override 20% → 12000.
const NET = 10000;
const DEFAULTS = { enabled: true, flight: { domestic: 10, international: 12 }, hotel: { domestic: 8, international: 15 }, version: 1 };

const tboRoom = { Name: ["Deluxe"], BookingCode: "H1!TB!1", TotalFare: NET, TotalTax: 1200, NetAmount: NET,
  DayRates: [[{ BasePrice: 4400 }, { BasePrice: 4400 }]], MealType: "Room_Only", IsRefundable: true, CancelPolicies: [] };

function priceKeyPaths(v: any, path = "$"): string[] {
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  for (const k of Object.keys(v)) {
    const p = Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`;
    if (!Array.isArray(v) && isPriceKey(k)) out.push(p);
    out.push(...priceKeyPaths(v[k], p));
  }
  return out;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-search-margin-test"));
  await mongoose.connection.db!.dropDatabase();
  await col("tbocities").insertOne({ code: CITY, name: "Mumbai", searchName: "mumbai", countryCode: "IN" });
  await col("tbohotelmasters").insertOne({ hotelCode: "H1", hotelName: "Hotel One", cityCode: CITY, countryCode: "IN", rating: "FiveStar", address: "Bandra" });
  await col("sbtconfigs").insertOne({ key: "margins", value: DEFAULTS } as any);
  await col("sbtmarginoverrides").insertOne({
    workspaceId: WS_OVERRIDE, flight: { domestic: null, international: null }, hotel: { domestic: 20, international: null },
  } as any);

  // Only TBO's HotelSearch is ever called; nothing leaves the process.
  vi.stubGlobal("fetch", async (_url: any, init?: any) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const codes = String(body.HotelCodes || "").split(",").filter(Boolean);
    return new Response(JSON.stringify({ Status: { Code: 200 }, HotelResult: codes.map((c) => ({ HotelCode: c, Currency: "INR", Rooms: [{ ...tboRoom }] })) }), { status: 200 });
  });
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await col("approvalsearchsessions").deleteMany({});
  await col("approvalselectionsnapshots").deleteMany({});
  invalidateMarginCache();
  invalidateOverrideCache();
});

const body = { city: "mumbai", checkIn: "2027-03-12", checkOut: "2027-03-14", adults: 1, rooms: 1 };

async function searchAndSnapshot(workspaceId: mongoose.Types.ObjectId) {
  const r = await searchHotelsForApproval(body, { userId: USER, workspaceId });
  expect(r.status).toBe(200);
  const session: any = await col("approvalsearchsessions").findOne({ workspaceId });
  const optionRef = r.body.hotels[0].rooms[0].optionRef;
  const { snapshots } = await prepareCartSelections({
    cartItems: [{ type: "hotel", title: "Mumbai", qty: 1, meta: { optionRef } }],
    userId: USER,
    workspaceId,
  });
  const requestId = oid();
  await writeSelectionSnapshots({ requestId, workspaceId, userId: USER, snapshots, prune: false });
  const snap: any = await col("approvalselectionsnapshots").findOne({ requestId });
  return { r, session, snap };
}

describe("approval hotel search margin (F1)", () => {
  it("a workspace with an override: session and snapshot carry the override percent", async () => {
    const { session, snap } = await searchAndSnapshot(WS_OVERRIDE);
    expect(session.results[0]._marginPercent).toBe(20);
    expect(session.results[0].Rooms[0]._displayTotalFare).toBe(12000);
    expect(snap.rawOption.room._displayTotalFare).toBe(12000);
    expect(snap.rawOption.room.TotalFare).toBe(NET);
  });

  it("a workspace without an override: the default percent", async () => {
    const { session, snap } = await searchAndSnapshot(WS_DEFAULT);
    expect(session.results[0]._marginPercent).toBe(8);
    expect(session.results[0].Rooms[0]._displayTotalFare).toBe(10800);
    expect(snap.rawOption.room._displayTotalFare).toBe(10800);
  });

  it("the customer response is price-free either way", async () => {
    for (const ws of [WS_OVERRIDE, WS_DEFAULT]) {
      const { r } = await searchAndSnapshot(ws);
      expect(priceKeyPaths(r.body)).toEqual([]);
      expect(JSON.stringify(r.body)).not.toMatch(/10000|10800|12000|_display|_margin|TotalFare|DayRates|INR/);
    }
  });
});
