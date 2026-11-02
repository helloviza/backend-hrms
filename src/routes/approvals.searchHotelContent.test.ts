// apps/backend/src/routes/approvals.searchHotelContent.test.ts
//
// GET /api/approvals/search/hotel-content (slice S4): static hotel content for
// the request form's hotel cards.
//   - only hotels the caller's OWN unexpired hotel search returned; any other
//     code is dropped silently; at most 20 codes per call
//   - allow-listed fields only, every text through stripPriceText, no price key
//   - an approvals-only workspace (hotelBookingEnabled false) is served
//   - a TBO failure gives those hotels empty content, never a 500
//
// Real: approvals router and its search gates, hotel details service (cache
// included), session model, on an in-memory Mongo. Stubbed: requireAuth /
// requireWorkspace (headers), TBO HotelDetails HTTP (global fetch), mail.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
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
// Like the real one: the workspace is a LEAN document.
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
vi.mock("../services/tbo.hotel.shared.js", async (orig) => ({ ...(await orig<any>()), hotelStaticAuthHeader: () => "Basic static" }));

const { default: approvalsRouter } = await import("./approvals.js");
const { isPriceKey } = await import("./approvals.security.js");
const { sectionLine } = await import("../services/approvalSearch/hotelContent.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS = oid(); // approvals only: hotelBookingEnabled is OFF
const OTHER_WS = oid();
const REQ = oid();
const SOMEONE_ELSE = oid();

const ws = (_id: any, customerId: string) => ({
  _id, customerId, name: `WS ${customerId}`, status: "ACTIVE", tenantType: "CORPORATE",
  defaultApproverEmails: ["approver@cust.test"],
  config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true, hotelBookingEnabled: false, sbtEnabled: false } },
});

const user = (sub: any, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ sub: String(sub), email: `${String(sub)}@cust.test`, name: "Test User", roles: ["EMPLOYEE"], ...extra });
const content = (codes: string, opts: { sub?: any; ws?: any; extra?: Record<string, unknown> } = {}) =>
  request(app)
    .get(`/api/approvals/search/hotel-content?hotelCodes=${codes}`)
    .set("x-test-user", user(opts.sub ?? REQ, opts.extra))
    .set("x-test-ws", String(opts.ws ?? WS));

/** A stored hotel search, the way searchHotelsForApproval writes one (raw TBO results, prices included). */
async function seedSession(codes: string[], o: { userId?: any; workspaceId?: any; expired?: boolean; kind?: string } = {}) {
  const now = Date.now();
  await col("approvalsearchsessions").insertOne({
    sid: oid().toHexString().slice(0, 22),
    workspaceId: o.workspaceId ?? WS,
    userId: String(o.userId ?? REQ),
    kind: o.kind ?? "hotel",
    params: {},
    results: codes.map((c) => ({ HotelCode: c, Rooms: [{ TotalFare: 9999, Name: ["Deluxe"] }] })),
    createdAt: new Date(now),
    expiresAt: new Date(o.expired ? now - 1000 : now + 30 * 60 * 1000),
  } as any);
}

/* TBO HotelDetails, scripted per test; price-like fields thrown in on purpose. */
const tbo = { calls: [] as any[], fail: false };
const tboHotel = (code: string) => ({
  HotelCode: code,
  HotelName: `Hotel ${code}`,
  Description: `<p><b>Location</b>: Near the sea.</p><p>Rooms from INR 4,500 per night &amp; free WiFi.</p>`,
  HotelFacilities: ["Pool", "Gym", "Airport transfer INR 1,500", "Pool", ...Array.from({ length: 30 }, (_, i) => `Facility ${i}`)],
  Attractions: { "1) ": "Beach - 0.4 km" },
  Images: [{ Url: "https://img/a.jpg" }, "https://img/b.jpg", "javascript:alert(1)", ...Array.from({ length: 10 }, (_, i) => `https://img/${code}-${i}.jpg`)],
  Address: "Bandstand",
  PhoneNumber: "+91 22 0000 0000",
  Map: "19.0760|72.8777",
  CheckInTime: "2:00 PM",
  CheckOutTime: "12:00 PM",
  Price: 4500, TotalFare: 9000, MinimumRate: 4200,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-hotel-content-test"));
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([ws(WS, "C1"), ws(OTHER_WS, "C2")] as any[]);

  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    // The hotel module's own startup preloads also fetch; only HotelDetails is scripted.
    if (!/\/HotelDetails$/.test(String(url))) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body || "{}"));
    tbo.calls.push(body);
    if (tbo.fail) throw new Error("socket hang up");
    return new Response(JSON.stringify({ Status: { Code: 200 }, HotelDetails: String(body.Hotelcodes).split(",").map(tboHotel) }), { status: 200 });
  });
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  tbo.calls = [];
  tbo.fail = false;
  await col("approvalsearchsessions").deleteMany({});
});

function keyPaths(v: any, path = "$"): string[] {
  if (!v || typeof v !== "object") return [];
  return Object.keys(v).flatMap((k) => {
    const p = Array.isArray(v) ? `${path}[]` : `${path}.${k}`;
    return [...(Array.isArray(v) ? [] : [p]), ...keyPaths(v[k], p)];
  });
}

// Each test uses its own hotel codes: the content cache lives for the process.
describe("GET /approvals/search/hotel-content", () => {
  it("serves only hotels from the caller's own unexpired hotel search; others are dropped silently", async () => {
    await seedSession(["A1", "A2"]);
    await seedSession(["A3"], { userId: SOMEONE_ELSE }); // another user, same workspace
    await seedSession(["A4"], { workspaceId: OTHER_WS }); // same user, another workspace
    await seedSession(["A5"], { expired: true });
    await seedSession(["A6"], { kind: "flight" });

    const r = await content("A1,A3,A4,A5,A6,A9,A2");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.hotels).sort()).toEqual(["A1", "A2"]);
    expect(tbo.calls.map((c) => c.Hotelcodes)).toEqual(["A1,A2"]);
    expect(tbo.calls[0]).toEqual({ Hotelcodes: "A1,A2", Language: "en", IsRoomDetailRequired: false });

    // Nothing searched at all: an empty answer, no TBO call.
    tbo.calls = [];
    const none = await content("A3,A4");
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ ok: true, hotels: {} });
    expect(tbo.calls).toHaveLength(0);
  });

  it("caps a call at 20 hotel codes", async () => {
    const codes = Array.from({ length: 25 }, (_, i) => `B${i}`);
    await seedSession(codes);
    const r = await content([...codes, "B0"].join(","));
    expect(Object.keys(r.body.hotels)).toEqual(codes.slice(0, 20));
    expect(tbo.calls[0].Hotelcodes.split(",")).toHaveLength(20);
  });

  it("allow-listed content only: no price-like key at any depth, prices out of the text, capped lists", async () => {
    await seedSession(["C1"]);
    const r = await content("C1");
    expect(r.headers["cache-control"]).toBe("no-store");
    const h = r.body.hotels.C1;
    expect(Object.keys(h).sort()).toEqual(["checkInTime", "checkOutTime", "description", "facilities", "images", "latitude", "longitude"]);
    expect(keyPaths(r.body).filter((p) => isPriceKey(p.split(".").pop()!.replace("[]", "")))).toEqual([]);
    expect(JSON.stringify(r.body)).not.toMatch(/INR|4,500|1,500|4500|9000|4200|9999|Price|TotalFare|MinimumRate|PhoneNumber|Attractions|<p>|&amp;/);

    expect(h.images).toEqual(["https://img/a.jpg", "https://img/b.jpg", ...Array.from({ length: 6 }, (_, i) => `https://img/C1-${i}.jpg`)]);
    expect(h.facilities).toHaveLength(20);
    expect(h.facilities.slice(0, 3)).toEqual(["Pool", "Gym", "Airport transfer"]);
    expect(h.description).toBe("Location: Near the sea.\nRooms from per night & free WiFi.");
    expect(h).toMatchObject({ checkInTime: "2:00 PM", checkOutTime: "12:00 PM", latitude: 19.076, longitude: 72.8777 });
  });

  it("an approvals-only workspace (hotelBookingEnabled false) gets 200", async () => {
    const w: any = await col("customerworkspaces").findOne({ _id: WS });
    expect(w.config.features.hotelBookingEnabled).toBe(false);
    await seedSession(["D1"]);
    const r = await content("D1");
    expect(r.status).toBe(200);
    expect(r.body.hotels.D1.images.length).toBeGreaterThan(0);
  });

  it("TBO failure (after one retry) → empty content per hotel, not a 500; nothing cached", async () => {
    await seedSession(["E1", "E2"]);
    tbo.fail = true;
    const r = await content("E1,E2");
    expect(r.status).toBe(200);
    const empty = { images: [], facilities: [], description: "", checkInTime: null, checkOutTime: null, latitude: null, longitude: null };
    expect(r.body).toEqual({ ok: true, hotels: { E1: empty, E2: empty } });
    expect(tbo.calls).toHaveLength(2);

    tbo.fail = false;
    expect((await content("E1")).body.hotels.E1.images.length).toBeGreaterThan(0);
  });

  it("served from the server cache on a repeat", async () => {
    await seedSession(["F1"]);
    await content("F1");
    tbo.calls = [];
    expect((await content("F1")).body.hotels.F1.latitude).toBe(19.076);
    expect(tbo.calls).toHaveLength(0);
  });

  it("the search gates apply: hotelCodes required; demo sessions refused", async () => {
    expect((await content("")).status).toBe(400);
    const demo = await content("A1", { extra: { isDemoUser: true } });
    expect(demo.status).toBe(403);
    expect(demo.body.code).toBe("DEMO_SEARCH_BLOCKED");
  });
});

describe("description section labels", () => {
  it("'Location : …' → 'Location: …'; TBO's HeadLine label is dropped, its text kept", () => {
    expect(sectionLine("HeadLine : Near Nubian Museum")).toBe("Near Nubian Museum");
    expect(sectionLine("Location : Set in the heart of Aswan")).toBe("Location: Set in the heart of Aswan");
    expect(sectionLine("CheckIn Instructions : Photo ID required")).toBe("CheckIn Instructions: Photo ID required");
    expect(sectionLine("Dining :")).toBe("");
  });

  it("lines that aren't sections are left alone", () => {
    expect(sectionLine("Check-in from 2:00 PM")).toBe("Check-in from 2:00 PM");
    expect(sectionLine("Rooms have free WiFi.")).toBe("Rooms have free WiFi.");
  });
});
