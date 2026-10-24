// apps/backend/src/routes/invoices.partnerLead.test.ts
//
// A partner lead booking (Book Now on a PARTNER_LINK case) can't be invoiced
// until it is CONFIRMED: refused by add-bookings and by COMBINED generation,
// skipped by SEPARATE (bulk) generation. An ordinary booking is invoiced
// exactly as before — including the pre-existing gap that a PENDING one is
// accepted (logged in the tracker, out of scope here).
//
// Real: invoices router, invoice generation service, models, in-memory Mongo
// (replica set: invoicing claims bookings in a transaction), raw-insert cases.
// Stubbed: requireAuth (user from a header), requirePermission.
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
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));

const { default: invoicesRouter } = await import("./invoices.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { createInvoiceFromBookings, InvoiceGenerationError } = await import("../services/invoiceGeneration.service.js");

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", invoicesRouter);

let mongod: MongoMemoryReplSet;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const CUST = oid();
const WS = oid();
const SA_ID = oid();
const SA = JSON.stringify({ _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"] });
let PARTNER_CASE: any;
let ORDINARY_CASE: any;

async function booking(status: string, caseId: any) {
  return (await ManualBooking.create({
    workspaceId: CUST, type: "VISA", travelDate: new Date(Date.now() + 7 * 86400000), bookedBy: SA_ID, status,
    source: "ADMIN_QUEUE", sourceBookingId: caseId, supplierName: "VFS", givenBy: "Rita",
    passengers: [{ name: "Riya Sen" }], pricing: { actualPrice: 4000, quotedPrice: 4800, gstMode: "ON_MARKUP", gstPercent: 18 },
  })) as any;
}
async function draftInvoice() {
  const first = await booking("CONFIRMED", ORDINARY_CASE);
  const _id = oid();
  await col("invoices").insertOne({ _id, invoiceNo: `INV-${_id}`, workspaceId: WS, status: "DRAFT", bookingIds: [first._id], lineItems: [], subtotal: 0, totalGST: 0, grandTotal: 0, supplyType: "IGST" } as any);
  await col("manualbookings").updateOne({ _id: first._id }, { $set: { status: "INVOICED", invoiceId: _id } });
  return _id;
}
const add = (invoiceId: any, ids: any[]) =>
  request(app).post(`/api/admin/invoices/${invoiceId}/add-bookings`).set("x-test-user", SA).send({ bookingIds: ids.map(String) });
const fresh = async (id: any) => (await col("manualbookings").findOne({ _id: id })) as any;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("invoices-partner-lead"));
}, 180_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  for (const c of ["customerworkspaces", "manualbookings", "travelbookings", "invoices", "approvalrequests"]) await col(c).deleteMany({});
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUST), companyName: "Amber Student", status: "ACTIVE" } as any);
  const base = { workspaceId: WS, customerId: String(CUST), frontlinerId: "f", frontlinerEmail: "f@x.test", managerEmail: "m@x.test", status: "approved", cartItems: [], history: [] };
  const ins = await col("approvalrequests").insertMany([
    { ...base, meta: { source: "PARTNER_LINK", partnerLead: { caseNumber: "PL-AAAAAA" } } },
    { ...base, meta: {} },
  ] as any[]);
  [PARTNER_CASE, ORDINARY_CASE] = Object.values(ins.insertedIds);
});

describe("add-bookings", () => {
  it("refuses a partner booking that is not Confirmed; takes it once Confirmed", async () => {
    const inv = await draftInvoice();
    for (const status of ["PENDING", "WIP", "CANCELLED"]) {
      const b = await booking(status, PARTNER_CASE);
      const res = await add(inv, [b._id]);
      expect([res.status, res.body.code]).toEqual([400, "PARTNER_BOOKING_NOT_CONFIRMED"]);
      expect(res.body.refs).toEqual([b.bookingRef]);
      expect((await fresh(b._id)).status).toBe(status);
    }
    const ok = await booking("CONFIRMED", PARTNER_CASE);
    expect((await add(inv, [ok._id])).status).toBe(200);
    expect((await fresh(ok._id)).status).toBe("INVOICED");
  });

  it("an ordinary booking is added as before (a Pending one too — the existing, separately logged gap)", async () => {
    const inv = await draftInvoice();
    const b = await booking("PENDING", ORDINARY_CASE);
    expect((await add(inv, [b._id])).status).toBe(200);
    expect((await fresh(b._id)).status).toBe("INVOICED");
  });
});

describe("generation", () => {
  it("COMBINED refuses a partner booking that is not Confirmed, before anything is written", async () => {
    const b = await booking("WIP", PARTNER_CASE);
    const err: any = await createInvoiceFromBookings([String(b._id)], { format: "COMBINED" } as any).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceGenerationError);
    expect(err.body).toMatchObject({ code: "PARTNER_BOOKING_NOT_CONFIRMED", refs: [b.bookingRef] });
    expect(await col("invoices").countDocuments({})).toBe(0);
    expect((await fresh(b._id)).status).toBe("WIP");
  });

  it("SEPARATE (bulk) skips it, and still invoices the ordinary booking beside it", async () => {
    const p = await booking("PENDING", PARTNER_CASE);
    const o = await booking("CONFIRMED", ORDINARY_CASE);
    const created = await createInvoiceFromBookings([String(p._id), String(o._id)], { format: "SEPARATE", gstBypass: true, gstBypassReason: "test" } as any);
    expect(created.map((i: any) => (i.bookingIds || []).map(String))).toEqual([[String(o._id)]]);
    expect((await fresh(p._id)).status).toBe("PENDING");
    expect((await fresh(o._id)).status).toBe("INVOICED");
  });

  it("an ordinary booking never meets the partner rule", async () => {
    const b = await booking("WIP", ORDINARY_CASE);
    const err: any = await createInvoiceFromBookings([String(b._id)], { format: "COMBINED" } as any).catch((e) => e);
    expect(err?.body?.code).not.toBe("PARTNER_BOOKING_NOT_CONFIRMED");
  });
});
