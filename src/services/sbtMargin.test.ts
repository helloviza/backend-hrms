// apps/backend/src/services/sbtMargin.test.ts
//
// resolveMargin — the one function every SBT pricing path asks for its percent:
// defaults, a company's override per product (a value left unset falls back to
// the default), an override past its end date → defaults, master switch off →
// 0, no workspace → defaults (never 0). Plus whole-rupee round-up pricing and
// the server-side domestic / international rule (both ends in India).
//
// Real: services/sbtMargin + utils/margin, SBTConfig + SBTMarginOverride, in-memory Mongo.
// Margins are switched on with the local-dev flag (SBT_MARGINS_LOCAL=1).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.SBT_MARGINS_LOCAL = "1";

const {
  resolveMargin, flightRouteMargins, invalidateOverrideCache, isInternationalFlight, isInternationalRoute,
  pctForFlight, marginRecord,
} = await import("./sbtMargin.js");
const { invalidateMarginCache, applyMargin, applyMarginWithFloor, MARGIN_CACHE_TTL_MS, getMarginConfig } = await import("../utils/margin.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const WS_PLAIN = oid();

const DEFAULTS = { enabled: true, flight: { domestic: 10, international: 12 }, hotel: { domestic: 8, international: 15 }, version: 7 };

async function setDefaults(v: Record<string, unknown>) {
  await col("sbtconfigs").deleteMany({ key: "margins" });
  await col("sbtconfigs").insertOne({ key: "margins", value: v } as any);
  invalidateMarginCache();
}
async function setOverride(row: Record<string, unknown> | null) {
  await col("sbtmarginoverrides").deleteMany({});
  if (row) await col("sbtmarginoverrides").insertOne({ workspaceId: WS, reason: "test", validUntil: null, ...row } as any);
  invalidateOverrideCache();
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-margin-resolver-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await setDefaults(DEFAULTS);
  await setOverride({
    flight: { domestic: 5, international: null },
    hotel: { domestic: -10, international: null },
  });
});

describe("resolveMargin", () => {
  it("a company with no override gets the defaults, stamped with the defaults version", async () => {
    expect(await resolveMargin(WS_PLAIN, "flight", false)).toEqual({
      pct: 10, source: "DEFAULT", overrideId: null, defaultsVersion: 7, international: false,
    });
    expect((await resolveMargin(WS_PLAIN, "flight", true)).pct).toBe(12);
    expect((await resolveMargin(WS_PLAIN, "hotel", false)).pct).toBe(8);
    expect((await resolveMargin(WS_PLAIN, "hotel", true)).pct).toBe(15);
  });

  it("an override applies per product and region, and names its row", async () => {
    const row: any = await col("sbtmarginoverrides").findOne({ workspaceId: WS });
    const fd = await resolveMargin(WS, "flight", false);
    expect(fd).toMatchObject({ pct: 5, source: "OVERRIDE", overrideId: String(row._id), defaultsVersion: 7 });
    expect(await resolveMargin(String(WS), "hotel", false)).toMatchObject({ pct: -10, source: "OVERRIDE" });
  });

  it("a value the override leaves unset falls back to the default", async () => {
    expect(await resolveMargin(WS, "flight", true)).toMatchObject({ pct: 12, source: "DEFAULT", overrideId: null });
    expect(await resolveMargin(WS, "hotel", true)).toMatchObject({ pct: 15, source: "DEFAULT" });
  });

  it("0% is a real override (House prices at net), not 'unset'", async () => {
    await setOverride({ flight: { domestic: 0, international: 0 }, hotel: { domestic: 0, international: 0 } });
    expect(await resolveMargin(WS, "flight", false)).toMatchObject({ pct: 0, source: "OVERRIDE" });
    expect(await resolveMargin(WS, "hotel", true)).toMatchObject({ pct: 0, source: "OVERRIDE" });
  });

  it("an override past its end date is ignored — the company is back on the defaults, no job needed", async () => {
    await setOverride({ flight: { domestic: 5, international: 5 }, hotel: { domestic: 5, international: 5 }, validUntil: new Date(Date.now() - 1000) });
    expect(await resolveMargin(WS, "flight", false)).toMatchObject({ pct: 10, source: "DEFAULT", overrideId: null });
    // Still running until then.
    await setOverride({ flight: { domestic: 5, international: 5 }, hotel: { domestic: 5, international: 5 }, validUntil: new Date(Date.now() + 60_000) });
    expect(await resolveMargin(WS, "flight", false)).toMatchObject({ pct: 5, source: "OVERRIDE" });
    // …and the check is at pricing time.
    expect(await resolveMargin(WS, "flight", false, new Date(Date.now() + 120_000))).toMatchObject({ pct: 10, source: "DEFAULT" });
  });

  it("master switch off: every company at net — overrides ignored too", async () => {
    await setDefaults({ ...DEFAULTS, enabled: false });
    for (const ws of [WS, WS_PLAIN]) {
      for (const product of ["flight", "hotel"] as const) {
        expect(await resolveMargin(ws, product, false)).toMatchObject({ pct: 0, source: "OFF", overrideId: null });
      }
    }
  });

  it("no workspace → the defaults, never 0", async () => {
    for (const ws of [undefined, null, ""]) {
      expect(await resolveMargin(ws, "flight", false)).toMatchObject({ pct: 10, source: "DEFAULT" });
      expect(await resolveMargin(ws, "hotel", true)).toMatchObject({ pct: 15, source: "DEFAULT" });
    }
  });

  it("no margins doc at all → OFF (0), not an error", async () => {
    await col("sbtconfigs").deleteMany({});
    invalidateMarginCache();
    expect(await resolveMargin(WS_PLAIN, "flight", false)).toMatchObject({ pct: 0, source: "OFF" });
  });

  it("flightRouteMargins gives the workspace's domestic / international pair", async () => {
    expect(await flightRouteMargins(WS)).toEqual({ domestic: 5, international: 12 });
    expect(await flightRouteMargins(WS_PLAIN)).toEqual({ domestic: 10, international: 12 });
  });

  it("a saved change reaches every instance within a minute (cache TTL)", async () => {
    expect(MARGIN_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
    expect((await resolveMargin(WS_PLAIN, "flight", false)).pct).toBe(10);
    await col("sbtconfigs").updateOne({ key: "margins" }, { $set: { "value.flight.domestic": 9 } });
    // Another instance: still cached until the TTL passes (here: the cache is dropped).
    invalidateMarginCache();
    expect((await resolveMargin(WS_PLAIN, "flight", false)).pct).toBe(9);
  });

  it("outside production, margins stay off unless the local-dev flag is set", async () => {
    delete process.env.SBT_MARGINS_LOCAL;
    invalidateMarginCache();
    try {
      expect((await getMarginConfig()).enabled).toBe(false);
      expect(await resolveMargin(WS_PLAIN, "flight", false)).toMatchObject({ pct: 0, source: "OFF" });
    } finally {
      process.env.SBT_MARGINS_LOCAL = "1";
      invalidateMarginCache();
    }
  });

  it("marginRecord is what a quote stores", async () => {
    const d = await resolveMargin(WS, "flight", false);
    expect(marginRecord(d, 490.004)).toEqual({
      marginPct: 5, marginSource: "OVERRIDE", marginOverrideId: d.overrideId, marginVersion: 7,
      isInternational: false, marginAmount: 490,
    });
  });
});

describe("pricing: whole rupee, rounded up", () => {
  it("rounds up, without float noise", () => {
    expect(applyMargin(10000, 10)).toBe(11000); // 11000.000000000002 is not 11001
    expect(applyMargin(9800, 10)).toBe(10780);
    expect(applyMargin(999.5, 10)).toBe(1100); // 1099.45 → 1100
    expect(applyMargin(1000.01, 0)).toBe(1001); // 0% still a whole rupee
    expect(applyMargin(10000, 0)).toBe(10000);
  });

  it("negative percents sell below net", () => {
    expect(applyMargin(9800, -5)).toBe(9310);
    expect(applyMargin(10000, -10)).toBe(9000);
  });

  it("hotels never go below the RSP floor (rounded up), whatever the percent", () => {
    expect(applyMarginWithFloor(10000, -10, 10500)).toBe(10500);
    expect(applyMarginWithFloor(10000, -10, 10499.2)).toBe(10500);
    expect(applyMarginWithFloor(10000, 8, 10500)).toBe(10800);
    expect(applyMarginWithFloor(10000, -10, null)).toBe(9000);
  });
});

describe("domestic vs international — from airport data, never the browser", () => {
  const seg = (o: string, d: string) => ({ Origin: { Airport: { AirportCode: o } }, Destination: { Airport: { AirportCode: d } } });
  it("both ends in India = domestic, by each journey's first departure and last arrival", () => {
    expect(isInternationalFlight({ Segments: [[seg("DEL", "BOM")]] })).toBe(false);
    expect(isInternationalFlight({ Segments: [[seg("DEL", "BOM")], [seg("BOM", "DEL")]] })).toBe(false);
    expect(isInternationalFlight({ Segments: [[seg("DEL", "DXB")]] })).toBe(true);
    expect(isInternationalFlight({ Segments: [[seg("DEL", "BOM"), seg("BOM", "DXB")]] })).toBe(true);
    expect(isInternationalFlight({ Segments: [seg("BOM", "GOI")] })).toBe(false); // flat segment list
  });
  it("unknown airports and missing segments price as international", () => {
    expect(isInternationalFlight({ Segments: [[seg("DEL", "ZZZ")]] })).toBe(true);
    expect(isInternationalFlight({})).toBe(true);
    // An unknown code falls back to TBO's own CountryCode on the segment.
    expect(isInternationalFlight({ Segments: [[{ Origin: { Airport: { AirportCode: "QQQ", CountryCode: "IN" } }, Destination: { Airport: { AirportCode: "BOM" } } }]] })).toBe(false);
  });
  it("routes by IATA (calendar)", () => {
    expect(isInternationalRoute(["DEL", "BOM"])).toBe(false);
    expect(isInternationalRoute(["DEL", "LHR"])).toBe(true);
    expect(isInternationalRoute([])).toBe(true);
  });
  it("a flight picks its percent from the pair", () => {
    expect(pctForFlight({ Segments: [[seg("DEL", "BOM")]] }, { domestic: 5, international: 12 })).toBe(5);
    expect(pctForFlight({ Segments: [[seg("DEL", "DXB")]] }, { domestic: 5, international: 12 })).toBe(12);
    expect(pctForFlight({ Segments: [[seg("DEL", "DXB")]] }, 3)).toBe(3);
  });
});
