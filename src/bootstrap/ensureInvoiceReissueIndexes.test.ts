// ensureInvoiceReissueIndexes: builds the reissue collections' indexes at boot
// and logs an error when the reserved-number partial unique index is missing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ensureInvoiceReissueIndexes, isReservedUniqueIndex } from "./ensureInvoiceReissueIndexes.js";
import InvoiceNumberReservation from "../models/InvoiceNumberReservation.js";
import ArchivedInvoice from "../models/ArchivedInvoice.js";

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // autoIndex off so the test sees only what the boot step builds.
  await mongoose.connect(mongod.getUri(), { autoIndex: false, autoCreate: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

const reservations = () => mongoose.connection.collection("invoice_number_reservations");
const log = () => ({ error: vi.fn(), log: vi.fn() });

describe("ensureInvoiceReissueIndexes", () => {
  it("builds the indexes on an empty database and reports the partial unique index present", async () => {
    const l = log();
    const res = await ensureInvoiceReissueIndexes(undefined, l);
    expect(res).toEqual({ ok: ["ArchivedInvoice", "InvoiceNumberReservation"], failed: [], reservedUniqueIndex: true });
    expect(l.error).not.toHaveBeenCalled();

    const ix: any = (await reservations().indexes()).find(isReservedUniqueIndex);
    expect(ix).toMatchObject({ name: "number_reserved_unique", unique: true, partialFilterExpression: { status: "RESERVED" } });
    // It really enforces: a second RESERVED row for the number is refused, a CONSUMED one is not.
    await reservations().insertOne({ number: "INV-1", status: "RESERVED" });
    await expect(reservations().insertOne({ number: "INV-1", status: "RESERVED" })).rejects.toThrow(/E11000/);
    await reservations().insertOne({ number: "INV-1", status: "CONSUMED" });

    // Idempotent on a second boot.
    expect((await ensureInvoiceReissueIndexes(undefined, log())).reservedUniqueIndex).toBe(true);
  });

  it("an older index with the same name and different options blocks the build: the error names the fix", async () => {
    await reservations().createIndex({ number: 1 }, { name: "number_reserved_unique" }); // plain, not unique
    const l = log();
    const res = await ensureInvoiceReissueIndexes(undefined, l);
    expect(res.failed).toEqual(["InvoiceNumberReservation"]);
    expect(res.reservedUniqueIndex).toBe(false);
    const errors = l.error.mock.calls.map((c) => String(c[0]));
    expect(errors.some((m) => m.includes("createIndexes FAILED for InvoiceNumberReservation"))).toBe(true);
    expect(errors.some((m) => m.includes("is MISSING") && m.includes("db.invoice_number_reservations.createIndex"))).toBe(true);
  });

  it("logs an error when the build reports success but the index is not there", async () => {
    const noop = { createIndexes: vi.fn(async () => {}) };
    const l = log();
    const res = await ensureInvoiceReissueIndexes([["ArchivedInvoice", ArchivedInvoice], ["InvoiceNumberReservation", noop]], l);
    expect(res.failed).toEqual([]);
    expect(res.reservedUniqueIndex).toBe(false);
    expect(l.error).toHaveBeenCalledTimes(1);
    expect(String(l.error.mock.calls[0][0])).toContain("is MISSING");
    expect(InvoiceNumberReservation.collection.collectionName).toBe("invoice_number_reservations");
  });

  it("matches on key and options, not name", () => {
    expect(isReservedUniqueIndex({ name: "hand_built", key: { number: 1 }, unique: true, partialFilterExpression: { status: "RESERVED" } })).toBe(true);
    expect(isReservedUniqueIndex({ key: { number: 1 }, unique: true })).toBe(false);
    expect(isReservedUniqueIndex({ key: { number: 1 }, partialFilterExpression: { status: "RESERVED" } })).toBe(false);
    expect(isReservedUniqueIndex({ key: { number: 1, status: 1 }, unique: true, partialFilterExpression: { status: "RESERVED" } })).toBe(false);
  });
});
