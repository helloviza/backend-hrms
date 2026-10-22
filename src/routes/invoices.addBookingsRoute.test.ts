// POST /api/admin/invoices/:id/add-bookings — the client check bridges the two
// id spaces. ManualBooking.workspaceId is a Customer._id; generation stamps
// invoice.workspaceId with the client's CustomerWorkspace._id. The route used
// to compare the two directly and so refused every add for a client with a
// workspace (400 "same workspace"). Older invoices whose workspaceId IS the
// Customer._id must keep working, another client's booking must still be
// refused, and the partner revenue snapshot is written through this path.
//
// Real: invoices router, every model, mongodb-memory-server (replica set —
// the route claims bookings in a transaction). Stubbed:
// requireAuth (user from a header), requirePermission (always allows).
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

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", invoicesRouter);

let mongod: MongoMemoryReplSet;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const CUST = oid();
const WS = oid();
const OTHER_CUST = oid();
const SA_ID = oid();
const SA = JSON.stringify({ _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"] });

async function booking(customerId: any) {
  return (await ManualBooking.create({
    workspaceId: customerId,
    type: "FLIGHT",
    travelDate: new Date(Date.now() + 7 * 86400000),
    bookedBy: SA_ID,
    status: "CONFIRMED",
    passengers: [{ name: "Asha Rao" }],
    pricing: { actualPrice: 10_000, quotedPrice: 11_180, gstMode: "ON_MARKUP", gstPercent: 18 },
  })) as any;
}

async function draftInvoice(workspaceId: any, first: any) {
  const _id = oid();
  await col("invoices").insertOne({
    _id, invoiceNo: `INV-${_id}`, workspaceId, status: "DRAFT",
    bookingIds: [first._id], lineItems: [], subtotal: 0, totalGST: 0, grandTotal: 0, supplyType: "IGST",
  } as any);
  await col("manualbookings").updateOne({ _id: first._id }, { $set: { status: "INVOICED", invoiceId: _id } });
  return _id;
}

const add = (invoiceId: any, ids: any[]) =>
  request(app).post(`/api/admin/invoices/${invoiceId}/add-bookings`).set("x-test-user", SA).send({ bookingIds: ids.map(String) });
const fresh = async (id: any) => (await col("manualbookings").findOne({ _id: id })) as any;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); // add-bookings claims in a transaction
  await mongoose.connect(mongod.getUri("invoices-add-bookings-route"));
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  for (const c of ["customerworkspaces", "manualbookings", "travelbookings", "invoices", "partnerrevenueconfigs"]) await col(c).deleteMany({});
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUST), companyName: "Client Co", status: "ACTIVE" } as any);
});

describe("POST /:id/add-bookings — client check across the two id spaces", () => {
  it("invoice keyed on the client's CustomerWorkspace._id (the normal shape) accepts the client's booking", async () => {
    const inv = await draftInvoice(WS, await booking(CUST));
    const b = await booking(CUST);
    const res = await add(inv, [b._id]);
    expect(res.status).toBe(200);
    expect((await fresh(b._id))).toMatchObject({ status: "INVOICED", invoiceId: inv });
    expect(((await col("invoices").findOne({ _id: inv })) as any).bookingIds.map(String)).toContain(String(b._id));
  });

  it("older invoice keyed on the Customer._id still works", async () => {
    const inv = await draftInvoice(CUST, await booking(CUST));
    const b = await booking(CUST);
    expect((await add(inv, [b._id])).status).toBe(200);
    expect((await fresh(b._id)).status).toBe("INVOICED");
  });

  it.each([
    ["workspace-keyed", () => WS],
    ["customer-keyed", () => CUST],
  ])("%s invoice refuses another client's booking", async (_l, wsOf) => {
    const inv = await draftInvoice(wsOf(), await booking(CUST));
    const foreign = await booking(OTHER_CUST);
    const res = await add(inv, [foreign._id]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same workspace/);
    expect((await fresh(foreign._id)).status).toBe("CONFIRMED");
  });

  it("writes the partner revenue snapshot when the client is an enabled partner", async () => {
    await col("partnerrevenueconfigs").insertOne({ workspaceId: WS, enabled: true, visiblePct: 50, sharePct: 40, reason: "r", version: 1 } as any);
    const inv = await draftInvoice(WS, await booking(CUST));
    const b = await booking(CUST);
    expect((await add(inv, [b._id])).status).toBe(200);
    expect((await fresh(b._id)).partnerShare).toMatchObject({ marginBase: 1000, bakedIn: 500, share: 200, configVersion: 1 });
  });
});
