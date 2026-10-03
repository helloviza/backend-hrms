// apps/backend/src/routes/sbt.hotels.cities.test.ts
//
// GET /api/sbt/hotels/cities — the SBT hotel city / hotel typeahead. Its
// local-catalogue search moved to services/hotelCatalogSearch.ts (shared with
// the approval request form); these expectations were recorded against the
// pre-move route and pin its response shape, ranking and caps. A query with
// zero catalogue hits still takes SBT's live fallback.
//
// Real: sbt.hotels router, static-data catalogue models, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers), the live TBO city list.
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
      config: { features: { sbtEnabled: true, hotelBookingEnabled: true } },
    };
    next();
  },
}));
vi.mock("../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
const live = vi.hoisted(() => ({ fetchCityList: null as any, getCachedCountryList: null as any }));
vi.mock("../services/tbo.hotel.shared.js", async (orig) => {
  const { vi: v } = await import("vitest");
  live.fetchCityList = v.fn(async () => [{ CityId: "L1", CityName: "Live City", CountryCode: "IN", CountryName: "India" }]);
  live.getCachedCountryList = v.fn(async () => []);
  return { ...(await orig<any>()), fetchCityList: live.fetchCityList, getCachedCountryList: live.getCachedCountryList };
});

const { default: hotelsRouter } = await import("./sbt.hotels.js");
const { TBOCity, TBOHotelMaster, TBOCountry } = await import("../jobs/static-data-refresh.js");

const app = express();
app.use(express.json());
app.use("/api/sbt/hotels", hotelsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const cities = (q: string) => request(app).get(`/api/sbt/hotels/cities?q=${encodeURIComponent(q)}`);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-hotel-cities-test"));
  await Promise.all([(TBOCity as any).init(), (TBOHotelMaster as any).init(), (TBOCountry as any).init()]);
  await col("tbocountries").insertMany([
    { code: "IN", name: "India", searchName: "india" },
    { code: "AE", name: "United Arab Emirates", searchName: "united arab emirates" },
  ]);
  await col("tbocities").insertMany([
    { code: "144306", name: "Mumbai", searchName: "mumbai", countryCode: "IN" },
    { code: "115936", name: "Dubai", searchName: "dubai", countryCode: "AE" },
    { code: "115999", name: "Dubai Marina", searchName: "dubai marina", countryCode: "AE" },
  ]);
  await col("tbohotelmasters").insertMany([
    { hotelCode: "H1", hotelName: "Mumbai House Hotel", searchName: "mumbai house hotel", cityCode: "144306", countryCode: "IN", rating: "ThreeStar" },
    { hotelCode: "H2", hotelName: "Taj Dubai", searchName: "taj dubai", cityCode: "115936", countryCode: "AE", rating: "FiveStar" },
    // No countryCode on the catalogue row: SBT has always reported "IN" here.
    { hotelCode: "H3", hotelName: "Dubai Creek Inn", searchName: "dubai creek inn", cityCode: "115936", countryCode: "", rating: "" },
    ...Array.from({ length: 12 }, (_, i) => ({
      hotelCode: `R${i}`, hotelName: `Resort ${String(i).padStart(2, "0")}`, searchName: `resort ${String(i).padStart(2, "0")}`,
      cityCode: "144306", countryCode: "IN", rating: "FourStar",
    })),
  ]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(() => live.fetchCityList.mockClear());

describe("GET /api/sbt/hotels/cities (local catalogue)", () => {
  it("returns cities then hotels in the SBT shape", async () => {
    const r = await cities("mumbai");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { type: "city", CityId: "144306", CityName: "Mumbai", CountryCode: "IN", CountryName: "India" },
      { type: "hotel", HotelCode: "H1", HotelName: "Mumbai House Hotel", CityName: "Mumbai", CityCode: "144306", CountryCode: "IN", CountryName: "India" },
    ]);
    expect(live.fetchCityList).not.toHaveBeenCalled();
  });

  it("ranks exact → prefix → contains; a hotel row with no country still reads IN", async () => {
    const r = await cities("dubai");
    expect(r.body).toEqual([
      { type: "city", CityId: "115936", CityName: "Dubai", CountryCode: "AE", CountryName: "United Arab Emirates" },
      { type: "city", CityId: "115999", CityName: "Dubai Marina", CountryCode: "AE", CountryName: "United Arab Emirates" },
      { type: "hotel", HotelCode: "H3", HotelName: "Dubai Creek Inn", CityName: "Dubai", CityCode: "115936", CountryCode: "IN", CountryName: "" },
      { type: "hotel", HotelCode: "H2", HotelName: "Taj Dubai", CityName: "Dubai", CityCode: "115936", CountryCode: "AE", CountryName: "United Arab Emirates" },
    ]);
  });

  it("caps hotels at 8", async () => {
    const r = await cities("resort");
    expect(r.body.map((x: any) => x.HotelCode)).toEqual(["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
  });

  it("under 2 characters returns nothing; zero catalogue hits still use SBT's live fallback", async () => {
    expect((await cities("m")).body).toEqual([]);
    const r = await cities("zzqx");
    expect(live.fetchCityList).toHaveBeenCalledWith("IN");
    expect(r.body).toEqual([]);
  });
});
