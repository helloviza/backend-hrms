// apps/backend/src/bootstrap/ensureSbtManualLinkIndexes.test.ts
//
// The SBT link index boot step: builds the unique partial index, verifies it
// from the live collection, fails closed while it is missing, and accepts a
// hand-built index of the same shape under another name.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const idx = await import("./ensureSbtManualLinkIndexes.js");
const quiet = { log: () => {}, error: () => {} } as any;

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-link-index-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  idx.resetSbtLinkIndexCheck();
});

describe("ensureSbtManualLinkIndexes", () => {
  it("builds and verifies the unique partial index; two links of one SBT booking can't both insert", async () => {
    expect(await idx.ensureSbtManualLinkIndexes(quiet)).toEqual({ built: true, present: true });
    expect(await idx.sbtLinkIndexAvailable()).toBe(true);
    const c = mongoose.connection.db!.collection("manualbookings");
    const sbtId = new mongoose.Types.ObjectId();
    await c.insertOne({ bookingRef: "A", sbtLink: { bookingId: sbtId } });
    await expect(c.insertOne({ bookingRef: "B", sbtLink: { bookingId: sbtId } })).rejects.toMatchObject({ code: 11000 });
    // Unlinked bookings are not in the index at all.
    await c.insertMany([{ bookingRef: "C" }, { bookingRef: "D" }]);
  });

  it("missing → unavailable (fails closed); a hand-built index of the same shape counts", async () => {
    await mongoose.connection.db!.createCollection("manualbookings");
    expect(await idx.sbtLinkIndexAvailable()).toBe(false);
    await mongoose.connection.db!.collection("manualbookings").createIndex(
      { "sbtLink.bookingId": 1 },
      { unique: true, partialFilterExpression: { "sbtLink.bookingId": { $exists: true } }, name: "by_hand" },
    );
    idx.resetSbtLinkIndexCheck();
    expect(await idx.sbtLinkIndexAvailable()).toBe(true);
  });

  it("a non-unique index of the same key does not count", () => {
    expect(idx.isSbtLinkUniqueIndex({ key: { "sbtLink.bookingId": 1 }, partialFilterExpression: { "sbtLink.bookingId": { $exists: true } } })).toBe(false);
    expect(idx.isSbtLinkUniqueIndex({ key: { "sbtLink.bookingId": 1 }, unique: true })).toBe(false);
  });
});
