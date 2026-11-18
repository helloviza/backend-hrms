// apps/backend/src/models/ManualBooking.mirrorResync.test.ts
//
// Travel Spend audit 2026-11, N1: ManualBooking synced its TravelBooking
// mirror only in post("save"), so the invoice claim (updateMany inside a
// transaction), invoice cancel / edit / reissue (updateMany) and the
// House → client move (updateOne) left the mirror stale — e.g. a booking
// invoiced straight from PENDING stayed PENDING on the dashboard.
// utils/mirrorResyncHooks.ts re-syncs by _id after those writes.
//
// Real: ManualBooking + TravelBooking models, the generation service, the
//   invoices router (cancel), an in-memory REPLICA SET (transactions).
// Stubbed: requireAuth (x-test-user), workspace resolver, PDF, S3, tasks.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../utils/invoicePdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => Buffer.from("%PDF")),
  prefetchInvoiceAssets: vi.fn(async () => ({})),
}));
vi.mock("../utils/creditNotePdf.js", () => ({ generateCreditNotePdf: vi.fn(async () => Buffer.from("%PDF")) }));
vi.mock("../utils/s3Upload.js", () => ({ uploadAndPresign: vi.fn(async (k: string) => `https://s3.test/${k}`) }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: vi.fn(async () => undefined) }));

const { default: invoicesRouter } = await import("../routes/invoices.js");
const { createInvoiceFromBookings, claimBookingsForInvoice } = await import("../services/invoiceGeneration.service.js");
const { default: Customer } = await import("./Customer.js");
const { default: CustomerWorkspace } = await import("./CustomerWorkspace.js");
const { default: ManualBooking, resyncManualBookingMirrors } = await import("./ManualBooking.js");
const { default: TravelBooking } = await import("./TravelBooking.js");
const { flushMirrorResync, touchesMirrorPaths } = await import("../utils/mirrorResyncHooks.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = "69679a7628330a58d29f2254";
const SA_ID = oid();
const SA_USER = { _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"], workspaceId: HOUSE };

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", (req: any, _res: any, next: any) => { req.workspaceObjectId = oid(HOUSE); next(); }, invoicesRouter);
const post = (path: string, body: any = {}) =>
  request(app).post(`/api/admin/invoices${path}`).set("x-test-user", JSON.stringify(SA_USER)).send(body);

let seq = 0;
async function company(name = "Mirror Co") {
  const c: any = await Customer.create({ name, legalName: name, gstRegisteredState: "Karnataka" });
  await CustomerWorkspace.create({ customerId: String(c._id), companyName: name });
  return c._id as mongoose.Types.ObjectId;
}
async function booking(customerId: mongoose.Types.ObjectId | string, extra: Record<string, unknown> = {}) {
  seq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: customerId, bookedBy: SA_ID, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-MR-${seq}`,
    travelDate: new Date("2026-11-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
    ...extra,
  });
  return b;
}
const mirror = (id: unknown) => col("travelbookings").findOne({ reference: id });

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("manual-mirror-resync-test"));
  await TravelBooking.init(); // unique { reference } index before concurrent upserts
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  vi.restoreAllMocks();
});

describe("touchesMirrorPaths", () => {
  const paths = new Set(["status", "workspaceId", "pricing"]);
  it("matches operator paths by top-level segment", () => {
    expect(touchesMirrorPaths({ $set: { status: "INVOICED", invoiceId: 1 } }, paths)).toBe(true);
    expect(touchesMirrorPaths({ $set: { "pricing.grandTotal": 5 } }, paths)).toBe(true);
    expect(touchesMirrorPaths({ $set: { workspaceId: 1 }, $push: { clientMoves: {} } }, paths)).toBe(true);
  });
  it("ignores writes to unmirrored fields", () => {
    expect(touchesMirrorPaths({ $set: { partnerShare: {} } }, paths)).toBe(false);
    expect(touchesMirrorPaths({ $set: { createdByEmail: "x" } }, paths)).toBe(false);
  });
  it("treats bare fields as $set and pipelines as touching everything", () => {
    expect(touchesMirrorPaths({ status: "X" }, paths)).toBe(true);
    expect(touchesMirrorPaths([{ $set: { foo: 1 } }], paths)).toBe(true);
  });
});

describe("invoice from PENDING (claim updateMany in a transaction)", () => {
  it("moves the mirror PENDING → CONFIRMED once the invoice is generated", async () => {
    const cust = await company();
    const b = await booking(cust, { status: "PENDING" });
    expect((await mirror(b._id))!.status).toBe("PENDING");

    await createInvoiceFromBookings([String(b._id)], { format: "COMBINED", createdBy: String(SA_ID) });

    expect((await col("manualbookings").findOne({ _id: b._id }))!.status).toBe("INVOICED");
    const m = (await mirror(b._id))!;
    expect(m.status).toBe("CONFIRMED");
    expect(m.amount).toBe(b.pricing.grandTotal);
  });

  it("from CANCELLED too — the ₹38 L case (mirror CANCELLED, source INVOICED)", async () => {
    const cust = await company();
    const b = await booking(cust, { status: "PENDING" });
    // Simulate the stale state, then invoice it.
    await col("travelbookings").updateOne({ reference: b._id }, { $set: { status: "CANCELLED" } });
    await createInvoiceFromBookings([String(b._id)], { format: "COMBINED", createdBy: String(SA_ID) });
    expect((await mirror(b._id))!.status).toBe("CONFIRMED");
  });

  it("defers inside the transaction and syncs on flush; an aborted claim leaves the mirror on committed truth", async () => {
    const cust = await company();
    const b = await booking(cust, { status: "PENDING" });

    // Committed claim: the mirror only changes when the owner flushes.
    const s1 = await mongoose.startSession();
    try {
      await s1.withTransaction(async () => {
        expect(await claimBookingsForInvoice([b], oid(), s1)).toBe(true);
        expect((await mirror(b._id))!.status).toBe("PENDING"); // not synced mid-transaction
      });
      expect((await mirror(b._id))!.status).toBe("PENDING"); // committed, not yet flushed
      await flushMirrorResync(s1);
      expect((await mirror(b._id))!.status).toBe("CONFIRMED");
    } finally {
      await s1.endSession();
    }

    // Aborted claim on another booking: flush rewrites from committed state (still PENDING).
    const b2 = await booking(cust, { status: "PENDING" });
    const s2 = await mongoose.startSession();
    try {
      await expect(s2.withTransaction(async () => {
        await claimBookingsForInvoice([b2], oid(), s2);
        throw new Error("abort");
      })).rejects.toThrow("abort");
      await flushMirrorResync(s2);
      expect((await col("manualbookings").findOne({ _id: b2._id }))!.status).toBe("PENDING");
      expect((await mirror(b2._id))!.status).toBe("PENDING");
    } finally {
      await s2.endSession();
    }
  });

  it("session end flushes anything an owner forgot to", async () => {
    const cust = await company();
    const b = await booking(cust, { status: "PENDING" });
    const s = await mongoose.startSession();
    await s.withTransaction(async () => {
      await claimBookingsForInvoice([b], oid(), s);
    });
    await s.endSession();
    await vi.waitFor(async () => expect((await mirror(b._id))!.status).toBe("CONFIRMED"));
  });
});

describe("invoice cancel (updateMany, no transaction)", () => {
  it("re-syncs the released bookings", async () => {
    const cust = await company();
    const b = await booking(cust, { status: "PENDING" });
    await createInvoiceFromBookings([String(b._id)], { format: "COMBINED", createdBy: String(SA_ID) });
    const inv = (await col("invoices").findOne({ bookingIds: b._id }))!;
    // Make the mirror visibly stale so the cancel's resync is observable.
    await col("travelbookings").updateOne({ reference: b._id }, { $set: { status: "PENDING", amount: 1 } });

    const r = await post(`/${inv._id}/cancel`, { reason: "Duplicate" });
    expect(r.status).toBe(200);

    expect((await col("manualbookings").findOne({ _id: b._id }))!.status).toBe("CONFIRMED");
    const m = (await mirror(b._id))!;
    expect(m.status).toBe("CONFIRMED");
    expect(m.amount).toBe(b.pricing.grandTotal);
  });
});

describe("House → client move (updateOne on workspaceId)", () => {
  it("moves the mirror tenantId + workspaceId to the client", async () => {
    const house = await company("Plumtrips House");
    const client = await company("Client Co");
    const b = await booking(house, { status: "PENDING" });
    expect((await mirror(b._id))!.tenantId).toBe(String(house));

    // Same write as routes/manualBookings.ts POST /:id/move-client.
    const r = await ManualBooking.updateOne(
      { _id: b._id, workspaceId: house, status: { $in: ["PENDING", "WIP"] } },
      { $set: { workspaceId: client }, $push: { clientMoves: { at: new Date(), to: client } } },
    );
    expect(r.modifiedCount).toBe(1);

    const m = (await mirror(b._id))!;
    expect(m.tenantId).toBe(String(client));
    const ws: any = await CustomerWorkspace.findOne({ customerId: String(client) }).lean();
    expect(String(m.workspaceId)).toBe(String(ws._id));
  });
});

describe("scope of the hook", () => {
  it("does not touch the mirror for writes to unmirrored fields", async () => {
    const cust = await company();
    const b = await booking(cust);
    const spy = vi.spyOn(TravelBooking, "findOneAndUpdate");
    await ManualBooking.updateOne({ _id: b._id }, { $set: { partnerShare: { amount: 1 } } as any });
    await ManualBooking.updateMany({ _id: b._id }, { $set: { createdByEmail: "x@y.z" } });
    expect(spy).not.toHaveBeenCalled();
  });

  it("findOneAndUpdate / findByIdAndUpdate re-sync too", async () => {
    const cust = await company();
    const b = await booking(cust);
    await ManualBooking.findByIdAndUpdate(b._id, { $set: { status: "CANCELLED" } });
    expect((await mirror(b._id))!.status).toBe("CANCELLED");
  });

  it("resyncManualBookingMirrors creates a missing mirror row and reports missing ids", async () => {
    const cust = await company();
    const b = await booking(cust, { status: "INVOICED" });
    await col("travelbookings").deleteOne({ reference: b._id });
    const out = await resyncManualBookingMirrors([b._id, oid()]);
    expect(out).toEqual({ synced: 1, failed: 0, missing: 1 });
    expect((await mirror(b._id))!.status).toBe("CONFIRMED");
  });
});
