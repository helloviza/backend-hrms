// apps/backend/src/routes/cstep.citySearch.test.ts
//
// GET /api/cstep/cities — the hybrid city resolver (services/cstepCitySearch.ts):
//   Mongo first (the shared TBO city catalogue + the CSTEP city cache), from
//   the first character, no Google; Google Places Autocomplete only when that
//   is thin (< 5), 2+ characters are typed and no Mongo city is an exact match;
//   a successful empty Google answer negative-cached for 7 days (TTL), never
//   an error / timeout / missing key / bad reply; Google's cities cached into the
//   CSTEP cache only (never the shared catalogue), so the same lookup is free
//   next time; a Google error / timeout / missing key answers the Mongo
//   cities, never throws; deduped, India first, at most 10; one session token
//   per typing session; the fields stay free text.
//
// Real: the cstep router, models, in-memory Mongo REPLICA SET on a fresh
//   database, cstep_qc_city_search.
// Faked: Google — global fetch is replaced in every test, so the real API is
//   never reached. Stubbed: mail, S3, auth (x-test-user), the workspace.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_city_search";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
const FAKE_KEY = "qc-fake-places-key";
process.env.GOOGLE_PLACES_API_KEY = FAKE_KEY;
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;
vi.setConfig({ testTimeout: 60_000 });

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {},
  GetObjectCommand: class {},
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: vi.fn(async () => ({ key: "qc" })), getObjectBuffer: vi.fn(async () => Buffer.from("")) }));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));

const { default: cstepRouter } = await import("./cstep.js");
const { searchHotelCatalog } = await import("../services/hotelCatalogSearch.js");
const { TBOCity, TBOCountry, normalizeSearch } = await import("../jobs/static-data-refresh.js");
const { default: CstepCityCache } = await import("../models/cstep/CstepCityCache.js");
const { CSTEP_CITY_MISS_TTL_MS } = await import("../models/cstep/CstepCityMiss.js");
const { cstepCitySessionToken, GOOGLE_AUTOCOMPLETE_URL, CSTEP_CITY_GOOGLE_TIMEOUT_MS } = await import("../services/cstepCitySearch.js");

const DB = "cstep_qc_city_search";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), manager: oid(), other: oid() };

const app = express();
app.use(express.json());
app.use(
  "/api/cstep",
  (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspaceObjectId = WS;
    next();
  },
  cstepRouter,
);
const who = (id: mongoose.Types.ObjectId) => ({ _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles: ["REQUESTER"], workspaceId: String(WS) });
const ACT = { traveller: who(U.traveller), manager: who(U.manager), other: who(U.other) };
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const cities = async (q: string, as = ACT.traveller) =>
  ok(await request(app).get(`/api/cstep/cities?q=${encodeURIComponent(q)}`).set("x-test-user", JSON.stringify(as))).body.results as Array<{
    name: string;
    countryCode: string;
    countryName: string;
  }>;
const names = (r: Array<{ name: string }>) => r.map((c) => c.name);

// ── Fake Google ─────────────────────────────────────────────────────────────
type Call = { url: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let google: (body: any, signal: AbortSignal) => Promise<{ status: number; json: any }>;
const suggest = (...cs: Array<[string, string]>) => ({
  suggestions: cs.map(([main, secondary], i) => ({
    placePrediction: {
      placeId: `place-${main}-${i}`,
      text: { text: secondary ? `${main}, ${secondary}` : main },
      structuredFormat: { mainText: { text: main }, ...(secondary ? { secondaryText: { text: secondary } } : {}) },
    },
  })),
});
const answers = (json: any) => async () => ({ status: 200, json });

beforeEach(() => {
  calls = [];
  google = answers({ suggestions: [] });
  process.env.GOOGLE_PLACES_API_KEY = FAKE_KEY;
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    if (String(url) !== GOOGLE_AUTOCOMPLETE_URL) throw new Error(`unexpected fetch ${url}`);
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const r = await google(JSON.parse(init.body), init.signal);
    return { ok: r.status < 300, status: r.status, json: async () => r.json } as any;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const M_CITIES = ["Mumbai", "Madurai", "Mangaluru", "Mysuru", "Meerut", "Mathura", "Manali", "Mohali", "Moradabad", "Malappuram", "Muzaffarpur", "Mirzapur"];

let replSet: MongoMemoryReplSet;
beforeAll(async () => {
  // The TTL monitor sweeps every second here (default 60), so expiry is observable.
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ args: ["--setParameter", "ttlMonitorSleepSecs=1"] }] });
  const uri = replSet.getUri(DB);
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  if ((await mongoose.connection.db!.listCollections().toArray()).length) throw new Error(`Step 0: ${DB} is not empty`);
  await mongoose.connection.syncIndexes();
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, firstName: k, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertOne({
    _id: oid(), workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
    email: `${U.traveller}@qc.local`, claimedBy: U.traveller, tourApproverId: U.manager, officialUserId: U.manager, financeUserId: U.manager,
  } as any);
  await (TBOCountry as any).insertMany([
    { code: "IN", name: "India" },
    { code: "GB", name: "United Kingdom" },
    { code: "FR", name: "France" },
    { code: "AE", name: "United Arab Emirates" },
  ]);
  await (TBOCity as any).insertMany([
    ...M_CITIES.map((name, i) => ({ code: `IN${100 + i}`, name, countryCode: "IN", searchName: normalizeSearch(name) })),
    { code: "GB001", name: "Manchester", countryCode: "GB", searchName: normalizeSearch("Manchester") },
  ]);
}, 240_000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("Mongo first — no Google", () => {
  it("one letter: up to 10 catalogue cities, India first, and Google is not called", async () => {
    const r = await cities("m");
    expect(r).toHaveLength(10);
    expect(r.every((c) => /^m/i.test(c.name))).toBe(true);
    expect(r[0]).toMatchObject({ countryCode: "IN", countryName: "India" });
    expect(calls).toHaveLength(0);
  });

  it("one letter with no match: still no Google (it starts at 2 characters)", async () => {
    expect(await cities("z")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("2+ letters with 5 or more Mongo matches: no Google", async () => {
    const r = await cities("ma"); // Madurai, Mangaluru, Mathura, Manali, Malappuram, Manchester
    expect(r.length).toBeGreaterThanOrEqual(5);
    expect(calls).toHaveLength(0);
  });
});

describe("Google when Mongo is thin", () => {
  it("a city Mongo doesn't know, 2+ letters: Google is asked for cities, India-biased not restricted, key server-side", async () => {
    google = answers(suggest(["Paris", "France"], ["Parbhani", "Maharashtra, India"], ["Paro", "Bhutan"]));
    const r = await cities("par");
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.headers["X-Goog-Api-Key"]).toBe(FAKE_KEY);
    expect(c.body).toMatchObject({ input: "par", includedPrimaryTypes: ["(cities)"], regionCode: "in" });
    expect(c.body.locationBias.rectangle).toBeTruthy(); // a bias over India…
    expect(c.body.includedRegionCodes).toBeUndefined(); // …not a restriction
    expect(typeof c.body.sessionToken).toBe("string");
    // The clean city name (mainText), never "City, State, Country"; India first.
    expect(r).toEqual([
      { name: "Parbhani", countryCode: "IN", countryName: "India" },
      { name: "Paro", countryCode: "", countryName: "Bhutan" }, // no catalogue code for Bhutan here
      { name: "Paris", countryCode: "FR", countryName: "France" },
    ]);
    // The key never reaches the response.
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });

  it("…its cities are cached in the CSTEP cache, so the same lookup again skips Google", async () => {
    const cached = await col("cstepcitycache").find({}).toArray();
    expect(cached.map((c) => c.name).sort()).toEqual(["Parbhani", "Paris", "Paro"]);
    expect(cached.every((c) => c.queries.includes("par"))).toBe(true);
    const before = await cities("par");
    expect(calls).toHaveLength(0);
    expect(names(before)).toEqual(["Parbhani", "Paro", "Paris"]);
    // A cached city also turns up for another query that matches it.
    expect(names(await cities("p"))).toEqual(["Parbhani", "Paro", "Paris"]);
    expect(calls).toHaveLength(0);
  });

  it("the shared SBT catalogue is never written: tbocities unchanged, SBT's search still doesn't know Paris", async () => {
    expect(await col("tbocities").countDocuments()).toBe(M_CITIES.length + 1);
    expect(await col("tbocities").findOne({ name: /paris/i })).toBeNull();
    expect((await searchHotelCatalog("par", { priorityCode: "IN", cityCap: 10, hotelCap: 8 })).cities).toEqual([]);
  });

  it("Google results merge with Mongo, deduped case-insensitively, India first", async () => {
    google = answers(suggest(["MUMBAI", "Maharashtra, India"], ["Mumbles", "Swansea, United Kingdom"], ["Muscat", "Oman"]));
    const r = await cities("mu"); // Mongo: Mumbai, Muzaffarpur (thin)
    expect(calls).toHaveLength(1);
    expect(names(r)).toEqual(["Mumbai", "Muzaffarpur", "Muscat", "Mumbles"]); // India first, then shorter first
  });

  it("at most 10 even when Google returns more", async () => {
    google = answers(suggest(...Array.from({ length: 12 }, (_, i) => [`Qcity ${String.fromCharCode(97 + i)}`, "India"] as [string, string])));
    const r = await cities("qc");
    expect(calls).toHaveLength(1);
    expect(r).toHaveLength(10);
  });

  it("Dubai's 'Dubai - United Arab Emirates' reads as country United Arab Emirates", async () => {
    google = answers(suggest(["Dubai", "Dubai - United Arab Emirates"]));
    expect(await cities("dub")).toEqual([{ name: "Dubai", countryCode: "AE", countryName: "United Arab Emirates" }]);
  });
});

describe("fail soft: Google trouble answers the Mongo cities", () => {
  const MONGO_MU = ["Mumbai", "Muzaffarpur", "Muscat", "Mumbles"]; // catalogue + what the cache learnt above
  it("an error status", async () => {
    google = async () => ({ status: 500, json: { error: { message: "boom" } } });
    expect(names(await cities("muz"))).toEqual(["Muzaffarpur"]);
    expect(calls).toHaveLength(1);
  });

  it("a network failure (fetch throws)", async () => {
    google = async () => {
      throw new Error("ECONNRESET");
    };
    expect(names(await cities("muz"))).toEqual(["Muzaffarpur"]);
  });

  it("a timeout: abandoned after ~2.5 s", async () => {
    google = (_b, signal) =>
      new Promise((_res, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const t0 = Date.now();
    expect(names(await cities("muz"))).toEqual(["Muzaffarpur"]);
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(CSTEP_CITY_GOOGLE_TIMEOUT_MS - 50);
    expect(ms).toBeLessThan(CSTEP_CITY_GOOGLE_TIMEOUT_MS + 2000);
  });

  it("a missing key: Google isn't called at all", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "";
    expect(names(await cities("muz"))).toEqual(["Muzaffarpur"]);
    expect(calls).toHaveLength(0);
  });

  it("a garbled reply", async () => {
    google = async () => ({ status: 200, json: { suggestions: [{}, { placePrediction: null }, "x"] } });
    expect(names(await cities("muz"))).toEqual(["Muzaffarpur"]);
  });

  it("a failed cache write still answers Google's cities", async () => {
    google = answers(suggest(["Mussoorie", "Uttarakhand, India"]));
    const spy = vi.spyOn(CstepCityCache, "bulkWrite").mockRejectedValueOnce(new Error("write refused"));
    expect(names(await cities("muss"))).toEqual(["Mussoorie"]);
    spy.mockRestore();
  });

  it("a failed catalogue read still answers the cached cities", async () => {
    const spy = vi.spyOn(TBOCity as any, "find").mockImplementationOnce(() => {
      throw new Error("catalogue down");
    });
    expect(names(await cities("par"))).toEqual(["Parbhani", "Paro", "Paris"]);
    spy.mockRestore();
  });

  it("a failed cache read still answers the catalogue cities", async () => {
    const spy = vi.spyOn(CstepCityCache, "find").mockImplementationOnce((() => ({ limit: () => ({ lean: () => Promise.reject(new Error("cache down")) }) })) as any);
    expect(await cities("m")).toHaveLength(10);
    spy.mockRestore();
  });

  it("(sanity) the Mongo cities for 'mu' are all still there", async () => {
    google = answers({ suggestions: [] });
    expect(names(await cities("mu"))).toEqual(expect.arrayContaining(MONGO_MU));
  });
});

describe("session tokens", () => {
  it("one token per typing session: reused while typing, new for another user or after a pause", () => {
    const t0 = 1_000_000;
    const a = cstepCitySessionToken("user-a", t0);
    expect(cstepCitySessionToken("user-a", t0 + 5_000)).toBe(a);
    expect(cstepCitySessionToken("user-a", t0 + 30_000)).toBe(a);
    expect(cstepCitySessionToken("user-b", t0 + 30_000)).not.toBe(a);
    expect(cstepCitySessionToken("user-a", t0 + 30_000 + 61_000)).not.toBe(a); // a pause
    const b = cstepCitySessionToken("user-c", t0);
    let t = t0;
    for (let i = 0; i < 4; i++) cstepCitySessionToken("user-c", (t += 50_000)); // typing on and on
    expect(cstepCitySessionToken("user-c", (t += 50_000))).not.toBe(b); // capped at 3 minutes
  });

  it("the route sends one token across a user's keystrokes, a different one for another user", async () => {
    google = answers({ suggestions: [] });
    await cities("xa");
    await cities("xab");
    await cities("xac", ACT.other); // not "xa" again: Google's empty answer to that is now remembered
    expect(calls).toHaveLength(3);
    expect(calls[1].body.sessionToken).toBe(calls[0].body.sessionToken);
    expect(calls[2].body.sessionToken).not.toBe(calls[0].body.sessionToken);
  });
});

describe("free text stays", () => {
  it("a tour leg keeps a city nobody knows (Google knows nothing either)", async () => {
    google = answers({ suggestions: [] });
    expect(await cities("zzyzx springs")).toEqual([]);
    const created = ok(
      await request(app)
        .post("/api/cstep/requests")
        .set("x-test-user", JSON.stringify(ACT.traveller))
        .send({
          projectId: String(QC_PROJECT), type: "DOMESTIC", purpose: "QC free text", departureDate: "2026-11-02", returnDate: "2026-11-04",
          stations: [{ from: "Zzyzx Springs", to: "Nowhere Junction", durationOfStay: "1 day" }],
          modesRequested: ["AIR"], transportRequired: false, accommodationRequired: false, sponsored: false, perDiemEligible: false,
        }),
    ).body.request;
    expect(created.stations[0]).toMatchObject({ from: "Zzyzx Springs", to: "Nowhere Junction" });
    expect(await col("cstepcitycache").findOne({ name: /zzyzx/i })).toBeNull();
  });

  it("nothing typed → nothing, no Google", async () => {
    expect(await cities("")).toEqual([]);
    expect(await cities("   ")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("cost: an exact Mongo match skips Google", () => {
  it("'Mumbai' is one catalogue city (thin, < 5) but an exact hit: no Google, in any case", async () => {
    google = answers(suggest(["Mumbai", "Maharashtra, India"]));
    expect(names(await cities("Mumbai"))).toEqual(["Mumbai"]);
    expect(names(await cities("MUMBAI"))).toEqual(["Mumbai"]);
    expect(names(await cities("mumbai "))).toEqual(["Mumbai"]);
    expect(calls).toHaveLength(0);
  });

  it("an exact hit in the CSTEP cache counts too ('Parbhani', learnt from Google earlier)", async () => {
    expect(names(await cities("parbhani"))).toEqual(["Parbhani"]);
    expect(calls).toHaveLength(0);
  });

  it("a prefix that is not yet a whole city still asks Google ('mumb')", async () => {
    google = answers(suggest(["Mumbai", "Maharashtra, India"]));
    expect(names(await cities("mumb"))).toEqual(["Mumbai", "Mumbles"]); // Mumbles: cached by an earlier test
    expect(calls).toHaveLength(1);
  });
});

describe("cost: Google's empty answer is negative-cached", () => {
  const misses = () => col("cstepcitymisses");

  it("a successful empty answer is remembered for 7 days, and the same query skips Google", async () => {
    google = answers({ suggestions: [] });
    const t0 = Date.now();
    expect(await cities("qzv")).toEqual([]);
    expect(calls).toHaveLength(1);
    const miss = await misses().findOne({ query: "qzv" });
    expect(miss).toBeTruthy();
    const ttl = miss!.expiresAt.getTime() - t0;
    expect(ttl).toBeGreaterThanOrEqual(CSTEP_CITY_MISS_TTL_MS - 1000);
    expect(ttl).toBeLessThanOrEqual(CSTEP_CITY_MISS_TTL_MS + 60_000);
    expect(await cities("qzv")).toEqual([]);
    expect(await cities("QZV")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("Google's {} (it omits suggestions when nothing matches) is an empty answer too", async () => {
    google = answers({});
    await cities("qzw");
    await cities("qzw");
    expect(calls).toHaveLength(1);
    expect(await misses().countDocuments({ query: "qzw" })).toBe(1);
  });

  it("keyed on the exact query: typing further still asks Google", async () => {
    google = answers(suggest(["Qzvtown", "India"]));
    expect(names(await cities("qzvt"))).toEqual(["Qzvtown"]);
    expect(calls).toHaveLength(1);
  });

  describe("a non-answer is never negative-cached — the identical query asks Google again", () => {
    const retried = async (q: string) => {
      google = answers({ suggestions: [] });
      const before = calls.length;
      await cities(q);
      expect(calls.length).toBe(before + 1);
    };

    it("an error status", async () => {
      google = async () => ({ status: 500, json: { error: { message: "boom" } } });
      await cities("qne1");
      expect(calls).toHaveLength(1);
      expect(await misses().findOne({ query: "qne1" })).toBeNull();
      await retried("qne1");
    });

    it("a network failure", async () => {
      google = async () => {
        throw new Error("ECONNRESET");
      };
      await cities("qne2");
      expect(await misses().findOne({ query: "qne2" })).toBeNull();
      await retried("qne2");
    });

    it("a timeout", async () => {
      google = (_b, signal) =>
        new Promise((_res, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      await cities("qne3");
      expect(await misses().findOne({ query: "qne3" })).toBeNull();
      await retried("qne3");
    });

    it("a missing key", async () => {
      process.env.GOOGLE_PLACES_API_KEY = "";
      await cities("qne4");
      expect(calls).toHaveLength(0);
      expect(await misses().findOne({ query: "qne4" })).toBeNull();
      process.env.GOOGLE_PLACES_API_KEY = FAKE_KEY;
      await retried("qne4");
    });

    it("an unreadable 200 reply: not JSON, or suggestions not a list", async () => {
      const replyWith = (json: () => any) =>
        vi.stubGlobal("fetch", async (url: any, init: any) => {
          calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
          return { ok: true, status: 200, json: async () => json() } as any;
        });
      replyWith(() => JSON.parse("<html>"));
      await cities("qne5");
      replyWith(() => ({ suggestions: "nope" }));
      await cities("qne5");
      expect(calls).toHaveLength(2);
      expect(await misses().findOne({ query: "qne5" })).toBeNull();
    });

    it("predictions that carry no usable city are not 'zero predictions'", async () => {
      google = async () => ({ status: 200, json: { suggestions: [{}, { placePrediction: null }] } });
      await cities("qne6");
      expect(await misses().findOne({ query: "qne6" })).toBeNull();
      await retried("qne6");
    });
  });

  it("a negative entry past its TTL is removed by Mongo's TTL index, and the query asks Google again", async () => {
    const idx = (await misses().indexes()).find((i: any) => i.key?.expiresAt === 1);
    expect(idx?.expireAfterSeconds).toBe(0);
    await misses().insertOne({ query: "qzexp", expiresAt: new Date(Date.now() - 60_000), createdAt: new Date(), updatedAt: new Date() });
    // Gone once the TTL monitor sweeps (every second in this suite).
    const deadline = Date.now() + 15_000;
    while ((await misses().countDocuments({ query: "qzexp" })) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    expect(await misses().countDocuments({ query: "qzexp" })).toBe(0);
    google = answers(suggest(["Qzexpur", "India"]));
    expect(names(await cities("qzexp"))).toEqual(["Qzexpur"]);
    expect(calls).toHaveLength(1);
  });

  it("an expired entry the monitor hasn't swept yet is already ignored, and a new empty answer renews it", async () => {
    await misses().insertOne({ query: "qzstale", expiresAt: new Date(Date.now() - 1), createdAt: new Date(), updatedAt: new Date() });
    google = answers({ suggestions: [] });
    await cities("qzstale");
    expect(calls).toHaveLength(1);
    // Renewed by the upsert (or swept and re-inserted): a live entry ~7 days out.
    const renewed = await misses().findOne({ query: "qzstale" });
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(Date.now() + CSTEP_CITY_MISS_TTL_MS - 60_000);
    await cities("qzstale");
    expect(calls).toHaveLength(1);
  });
});
