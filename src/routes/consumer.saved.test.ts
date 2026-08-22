// apps/backend/src/routes/consumer.saved.test.ts
//
// ══════════════════════════════════════════════════════════════════════
// SAVED COUNTRIES — IDEMPOTENCE AND OWN-SCOPING.
//
// Two properties carry this feature, and both are the kind that look
// fine by hand and break under a second click or a second consumer:
//
//   IDEMPOTENCE  a heart can be double-clicked, and the same country can
//                arrive from BOTH sources. One row, always, and never an
//                error for asking for a state that already holds.
//   OWN-SCOPE    A cannot see, add to, or delete from B's list.
// ══════════════════════════════════════════════════════════════════════
//
// Real router, real requireConsumer, real tokens, real Mongo
// (mongodb-memory-server) — the same shape as consumer.profile.test.ts.
// No mocks: the guard IS the thing under test.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Secrets must exist BEFORE any import that reads them.
const B2B_SECRET = "b2b-jwt-secret-for-tests";
const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;
process.env.NODE_ENV = "test";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-saved-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

const { default: Consumer } = await import("../models/Consumer.js");
const { default: SavedCountry } = await import("../models/SavedCountry.js");
const { default: consumerSavedRouter } = await import("./consumer.saved.js");
const { signConsumerAccessToken } = await import("../utils/consumerJwt.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/consumer/saved", consumerSavedRouter);

let mongod: MongoMemoryServer;

/** A real consumer plus a real token for them. */
async function makeConsumer(email: string, name: string) {
  const consumer = await Consumer.create({
    email,
    name,
    passwordHash: "not-used-in-these-tests",
  });
  const token = signConsumerAccessToken({
    consumerId: String(consumer._id),
    tokenVersion: (consumer as any).tokenVersion,
  });
  return { consumer, token, auth: `Bearer ${token}` };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // The unique {consumerId, iso2} index is the mechanism idempotence is
  // built on, and Mongoose only creates it lazily. Without this the
  // race-condition test would pass for the wrong reason.
  await SavedCountry.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([Consumer.deleteMany({}), SavedCountry.deleteMany({})]);
});

/* ══════════════════════════════════════════════════════════════════════
 * THE GUARD
 * ══════════════════════════════════════════════════════════════════════ */

describe("auth", () => {
  it("401s every route without a consumer token", async () => {
    await request(app).get("/api/consumer/saved").expect(401);
    await request(app).post("/api/consumer/saved").send({ iso2: "TH" }).expect(401);
    await request(app).delete("/api/consumer/saved/TH").expect(401);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * IDEMPOTENCE
 * ══════════════════════════════════════════════════════════════════════ */

describe("saving is idempotent", () => {
  it("saves a country once, and saving it again is a no-op success", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH", source: "manual" })
      .expect(201);

    // Again — must NOT 409, must NOT duplicate.
    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH", source: "manual" })
      .expect(201);

    expect(await SavedCountry.countDocuments({})).toBe(1);
  });

  it("THE CROSS-SOURCE CASE — the same country from both paths is ONE row", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    // Bookmarked by hand…
    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH", source: "manual" })
      .expect(201);

    // …then the apply flow saves it again.
    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH", source: "get-started" })
      .expect(201);

    expect(await SavedCountry.countDocuments({})).toBe(1);

    /* AND THE DELIBERATE SIGNAL SURVIVES. `source` records how a country
     * FIRST came to be saved; a later automatic save must not overwrite
     * a reader's explicit bookmark with "get-started". */
    const row: any = await SavedCountry.findOne({}).lean();
    expect(row.source).toBe("manual");
  });

  it("normalises case, so 'th' and 'TH' are the same save", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "th" })
      .expect(201);
    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH" })
      .expect(201);

    expect(await SavedCountry.countDocuments({})).toBe(1);
    const row: any = await SavedCountry.findOne({}).lean();
    expect(row.iso2).toBe("TH");
  });

  it("survives concurrent saves of the same country — the index, not a check", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    // Six at once. find-then-insert would let several through.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app)
          .post("/api/consumer/saved")
          .set("Authorization", a.auth)
          .send({ iso2: "TH", source: "manual" }),
      ),
    );

    for (const res of results) expect(res.status).toBe(201);
    expect(await SavedCountry.countDocuments({})).toBe(1);
  });

  it("rejects a code the catalogue does not carry", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    // Well-formed but not a real country — a regex check would accept it.
    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "ZZ" })
      .expect(400);

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "NOTACODE" })
      .expect(400);

    expect(await SavedCountry.countDocuments({})).toBe(0);
  });

  it("falls back to 'manual' for an unknown source rather than storing it", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH", source: "whatever-i-like" })
      .expect(201);

    const row: any = await SavedCountry.findOne({}).lean();
    expect(row.source).toBe("manual");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * LIST + ENRICHMENT
 * ══════════════════════════════════════════════════════════════════════ */

describe("the list", () => {
  it("enriches each save with catalogue data the client never has to join", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH" })
      .expect(201);

    const res = await request(app)
      .get("/api/consumer/saved")
      .set("Authorization", a.auth)
      .expect(200);

    expect(res.body.countries).toHaveLength(1);
    const th = res.body.countries[0];

    expect(th.iso2).toBe("TH");
    // The NAME comes from the seed, not from the request that saved it.
    expect(th.countryName).toBeTruthy();
    expect(typeof th.countryName).toBe("string");
    expect(th.visaCategory).toBeTruthy();
    expect(["Easy", "Moderate", "Hard", "Very Hard"]).toContain(th.difficulty);
    expect(typeof th.serviced).toBe("boolean");
    expect(th.savedAt).toBeTruthy();
  });

  it("returns an empty list — not an error — for a consumer with no saves", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    const res = await request(app)
      .get("/api/consumer/saved")
      .set("Authorization", a.auth)
      .expect(200);

    expect(res.body.countries).toEqual([]);
  });

  it("drops a stored code the catalogue no longer carries, rather than rendering it blank", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    // Written straight to the collection, bypassing the route's
    // validation — this is the shape a row takes when a country LEAVES
    // the seed after it was legitimately saved.
    await SavedCountry.create({
      consumerId: a.consumer._id,
      workspaceId: new mongoose.Types.ObjectId(),
      iso2: "ZZ",
      source: "manual",
    });
    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH" })
      .expect(201);

    const res = await request(app)
      .get("/api/consumer/saved")
      .set("Authorization", a.auth)
      .expect(200);

    // The orphan is absent from the response…
    expect(res.body.countries.map((c: any) => c.iso2)).toEqual(["TH"]);
    // …but its row is untouched, so it returns if the country does.
    expect(await SavedCountry.countDocuments({ iso2: "ZZ" })).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * REMOVAL
 * ══════════════════════════════════════════════════════════════════════ */

describe("removing", () => {
  it("removes a save", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH" })
      .expect(201);

    await request(app)
      .delete("/api/consumer/saved/TH")
      .set("Authorization", a.auth)
      .expect(200);

    expect(await SavedCountry.countDocuments({})).toBe(0);

    const res = await request(app)
      .get("/api/consumer/saved")
      .set("Authorization", a.auth)
      .expect(200);
    expect(res.body.countries).toEqual([]);
  });

  it("removing something that was never saved is a success, not a 404", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");

    await request(app)
      .delete("/api/consumer/saved/TH")
      .set("Authorization", a.auth)
      .expect(200);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * OWN-SCOPE — the security gate
 * ══════════════════════════════════════════════════════════════════════ */

describe("OWN-scope isolation — consumer A must never reach consumer B's saves", () => {
  it("each consumer's list contains ONLY their own saves", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH" })
      .expect(201);
    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", b.auth)
      .send({ iso2: "VN" })
      .expect(201);

    const aList = await request(app)
      .get("/api/consumer/saved")
      .set("Authorization", a.auth)
      .expect(200);
    const bList = await request(app)
      .get("/api/consumer/saved")
      .set("Authorization", b.auth)
      .expect(200);

    expect(aList.body.countries.map((c: any) => c.iso2)).toEqual(["TH"]);
    expect(bList.body.countries.map((c: any) => c.iso2)).toEqual(["VN"]);
  });

  it("the SAME country saved by both is two independent rows", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH" })
      .expect(201);
    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", b.auth)
      .send({ iso2: "TH" })
      .expect(201);

    // The unique index is {consumerId, iso2} — per consumer, NOT global.
    expect(await SavedCountry.countDocuments({ iso2: "TH" })).toBe(2);
  });

  it("A deleting 'their' TH does NOT remove B's TH", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", b.auth)
      .send({ iso2: "TH" })
      .expect(201);

    // A has no TH. The delete succeeds (idempotent) and must touch nothing.
    await request(app)
      .delete("/api/consumer/saved/TH")
      .set("Authorization", a.auth)
      .expect(200);

    const bList = await request(app)
      .get("/api/consumer/saved")
      .set("Authorization", b.auth)
      .expect(200);
    expect(bList.body.countries.map((c: any) => c.iso2)).toEqual(["TH"]);
    expect(await SavedCountry.countDocuments({ consumerId: b.consumer._id })).toBe(1);
  });

  it("a body carrying someone else's consumerId is ignored — the id comes from the token", async () => {
    const a = await makeConsumer("a@helloviza.test", "Consumer A");
    const b = await makeConsumer("b@helloviza.test", "Consumer B");

    await request(app)
      .post("/api/consumer/saved")
      .set("Authorization", a.auth)
      .send({ iso2: "TH", consumerId: String(b.consumer._id) })
      .expect(201);

    // The row belongs to A, whose token it was — not to B, whose id was
    // in the body.
    expect(await SavedCountry.countDocuments({ consumerId: a.consumer._id })).toBe(1);
    expect(await SavedCountry.countDocuments({ consumerId: b.consumer._id })).toBe(0);
  });
});
