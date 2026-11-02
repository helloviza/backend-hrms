// apps/backend/src/routes/sbt.hotels.details.test.ts
//
// GET /api/sbt/hotels/images and /details — the SBT hotel content calls. The
// TBO HotelDetails fetch and its caches moved to
// services/tbo.hotel.details.service.ts (shared with the approval hotel-content
// endpoint); these expectations were recorded against the pre-move route and
// pin its responses, its caching and its hotelBookingEnabled gate.
//
// Real: sbt.hotels router, requireFeature, in-memory Mongo. Stubbed:
// requireAuth / requireWorkspace (headers), TBO HotelDetails HTTP (global fetch).
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
    req.user = { sub: "u1", email: "u1@test", roles: ["CUSTOMER"] };
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    req.workspaceObjectId = new mongoose.Types.ObjectId();
    req.workspaceId = String(req.workspaceObjectId);
    req.workspace = {
      _id: req.workspaceObjectId, status: "ACTIVE", tenantType: "CORPORATE",
      config: { features: { sbtEnabled: true, hotelBookingEnabled: req.headers["x-test-hotels"] !== "off" } },
    };
    next();
  },
}));
vi.mock("../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
vi.mock("../services/tbo.hotel.shared.js", async (orig) => ({ ...(await orig<any>()), hotelStaticAuthHeader: () => "Basic static" }));

const { default: hotelsRouter } = await import("./sbt.hotels.js");

const app = express();
app.use(express.json());
app.use("/api/sbt/hotels", hotelsRouter);

let mongod: MongoMemoryServer;

/* TBO HotelDetails, scripted per test. Every call is recorded. */
const tbo = { calls: [] as any[], reply: (_body: any): any => ({ HotelDetails: [] }) };
const tboHotel = (code: string, images: any[]) => ({
  HotelCode: code, HotelName: `Hotel ${code}`, Description: `About ${code}`, HotelFacilities: ["Pool", "Gym"],
  Images: images, Map: "19.07|72.87", CheckInTime: "2:00 PM", CheckOutTime: "12:00 PM",
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-hotel-details-test"));
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    // The hotel module's own startup preloads also fetch; only HotelDetails is scripted.
    if (!/\/HotelDetails$/.test(String(url))) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body || "{}"));
    tbo.calls.push({ url: String(url), auth: init?.headers?.Authorization, body });
    const r = tbo.reply(body);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), { status: 200 });
  });
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(() => {
  tbo.calls = [];
});

// Each test uses its own hotel codes: the route caches live for the process.
const images = (codes: string, h: Record<string, string> = {}) => request(app).get(`/api/sbt/hotels/images?hotelCodes=${codes}`).set(h);
const details = (codes: string, h: Record<string, string> = {}) => request(app).get(`/api/sbt/hotels/details?hotelCodes=${codes}`).set(h);

describe("GET /images", () => {
  it("first image per hotel (string or {Url}); hotels without one are left out", async () => {
    tbo.reply = () => ({
      HotelDetails: [
        tboHotel("I1", ["https://img/i1-a.jpg", "https://img/i1-b.jpg"]),
        tboHotel("I2", [{ Url: "https://img/i2.jpg" }]),
        tboHotel("I3", []),
      ],
    });
    const r = await images("I1,I2,I3");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, images: { I1: "https://img/i1-a.jpg", I2: "https://img/i2.jpg" } });
    expect(tbo.calls).toHaveLength(1);
    expect(tbo.calls[0].url).toMatch(/\/HotelDetails$/);
    expect(tbo.calls[0].auth).toBe("Basic static");
    expect(tbo.calls[0].body).toEqual({ Hotelcodes: "I1,I2,I3", Language: "en", IsRoomDetailRequired: false });
  });

  it("dedupes, caps at 20 codes, and fetches only the cache misses", async () => {
    tbo.reply = (b) => ({ HotelDetails: String(b.Hotelcodes).split(",").map((c) => tboHotel(c, [`https://img/${c}.jpg`])) });
    const codes = Array.from({ length: 25 }, (_, i) => `D${i}`);
    const r = await images([...codes, "D0", "D1"].join(","));
    expect(Object.keys(r.body.images)).toHaveLength(20);
    expect(tbo.calls[0].body.Hotelcodes.split(",")).toEqual(codes.slice(0, 20));

    tbo.calls = [];
    const again = await images("D0,D1,D24");
    expect(again.body.images).toEqual({ D0: "https://img/D0.jpg", D1: "https://img/D1.jpg", D24: "https://img/D24.jpg" });
    expect(tbo.calls.map((c) => c.body.Hotelcodes)).toEqual(["D24"]);
  });

  it("retries once, then answers an empty map (never an error); empties are not cached", async () => {
    tbo.reply = () => new Error("timeout");
    const r = await images("E1");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, images: {} });
    expect(tbo.calls).toHaveLength(2);

    tbo.reply = () => ({ HotelDetails: [tboHotel("E1", ["https://img/e1.jpg"])] });
    expect((await images("E1")).body.images).toEqual({ E1: "https://img/e1.jpg" });
  });

  it("hotelCodes missing → 400", async () => {
    const r = await images("");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "hotelCodes required" });
  });

  it("hotelBookingEnabled off → refused before any TBO call", async () => {
    const r = await images("G1", { "x-test-hotels": "off" });
    expect(r.status).toBe(403);
    expect(tbo.calls).toHaveLength(0);
  });
});

describe("GET /details", () => {
  it("TBO's body as is, Images flattened to URLs; cached per hotelCodes string", async () => {
    tbo.reply = () => ({ Status: { Code: 200 }, HotelDetails: [tboHotel("T1", [{ Url: "https://img/t1.jpg" }, "https://img/t1-b.jpg", { url: "" }])] });
    const r = await details("T1");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ Status: { Code: 200 }, HotelDetails: [tboHotel("T1", ["https://img/t1.jpg", "https://img/t1-b.jpg"])] });
    expect(tbo.calls[0].body).toEqual({ Hotelcodes: "T1", Language: "en", IsRoomDetailRequired: true });

    tbo.calls = [];
    expect((await details("T1")).body).toEqual(r.body);
    expect(tbo.calls).toHaveLength(0);
  });

  it("TBO failure → 500 with the error message, nothing cached", async () => {
    tbo.reply = () => new Error("socket hang up");
    const r = await details("T2");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "socket hang up" });

    tbo.reply = () => ({ HotelDetails: [] });
    expect((await details("T2")).body).toEqual({ HotelDetails: [] });
  });

  it("hotelCodes missing → 400; hotelBookingEnabled off → 403", async () => {
    expect((await details("")).status).toBe(400);
    expect((await details("T3", { "x-test-hotels": "off" })).status).toBe(403);
    expect(tbo.calls).toHaveLength(0);
  });
});
