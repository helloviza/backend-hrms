// GET /gst-preview answers with what POST /generate actually does. Each case runs
// both on the same client and compares the invoice with the preview.
//
// Real: invoices router, requireWorkspace, generation service, models,
// mongodb-memory-server. Stubbed: requireAuth, requirePermission.
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
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");

const app = express();
app.use(express.json());
// The server resolves the workspace before this router; /gst-preview resolves it again.
app.use("/api/admin/invoices", (req: any, _res: any, next: any) => {
  req.workspaceId = "69679a7628330a58d29f2254";
  req.workspaceObjectId = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
  next();
}, invoicesRouter);

let mongod: MongoMemoryReplSet;
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const HOUSE_WS = "69679a7628330a58d29f2254";
const KA = "29ABCDE1234F1Z5"; // company default
const MH = "27ABCDE1234F1Z5";
const STAFF_ID = oid();
const HOUSE_STAFF = { _id: String(STAFF_ID), id: String(STAFF_ID), sub: String(STAFF_ID), roles: ["ADMIN"], workspaceId: HOUSE_WS, email: "finance@plumtrips.test" };
const SA_ID = oid();
const SA = { _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"], workspaceId: HOUSE_WS, email: "sa@plumtrips.test" };

async function client(fields: Record<string, unknown>, workspace: Record<string, unknown> = {}) {
  const c: any = await Customer.create({ name: "Acme", legalName: "Acme Pvt Ltd", ...fields });
  const ws: any = await CustomerWorkspace.create({ customerId: String(c._id), companyName: "Acme", status: "ACTIVE", ...workspace });
  await Customer.updateOne({ _id: c._id }, { $set: { workspaceId: ws._id } });
  return { id: String(c._id), ws: String(ws._id) };
}

let seq = 0;
async function booking(customerId: string) {
  seq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: customerId, bookedBy: SA_ID, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-PV-${seq}`,
    travelDate: new Date("2026-12-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
  });
  return String(b._id);
}

const preview = (customerId: string, query: Record<string, string> = {}, user: any = HOUSE_STAFF) =>
  request(app)
    .get("/api/admin/invoices/gst-preview")
    .query({ customerId, ...query })
    .set("x-test-user", JSON.stringify(user));

const generate = async (customerId: string, body: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/admin/invoices/generate")
    .set("x-test-user", JSON.stringify(HOUSE_STAFF))
    .send({ bookingIds: [await booking(customerId)], invoiceDate: "2026-12-01", billingPeriod: "December 2026", ...body });

/** The preview and the invoice from the same inputs must agree. */
async function expectMatch(customerId: string, query: Record<string, string>, body: Record<string, unknown>) {
  const p = await preview(customerId, query);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  expect(p.body.canCalculate, JSON.stringify(p.body)).toBe(true);
  const g = await generate(customerId, body);
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const inv = g.body.invoice;
  expect(p.body.detectedGstType).toBe(inv.supplyType);
  expect(p.body.placeOfSupply).toBe(inv.placeOfSupply);
  expect(p.body.supplierGstin).toBe(inv.issuerDetails.gstin);
  expect(p.body.customerState).toBe(inv.clientDetails.state);
  return { preview: p.body, invoice: inv };
}

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mongod.getUri("invoice-gst-preview-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: "annual",
    gstProfiles: [
      { gstin: KA, state: "Karnataka", stateCode: "29", legalName: "Plumtrips KA", addressLine1: "", addressLine2: "", city: "Bengaluru", pincode: "560001", isDefault: true, active: true, invoiceSeriesPrefix: "" },
      { gstin: MH, state: "Maharashtra", stateCode: "27", legalName: "Plumtrips MH", addressLine1: "", addressLine2: "", city: "Mumbai", pincode: "400001", isDefault: false, active: true, invoiceSeriesPrefix: "MH" },
    ],
  } as any);
  await col("customerworkspaces").insertOne({
    _id: new mongoose.Types.ObjectId(HOUSE_WS), customerId: HOUSE_WS, companyName: "Plumtrips", status: "ACTIVE",
  } as any);
  await col("users").insertMany([
    { _id: STAFF_ID, email: HOUSE_STAFF.email, name: "Finance", roles: ["ADMIN"], workspaceId: new mongoose.Types.ObjectId(HOUSE_WS) },
    { _id: SA_ID, email: SA.email, name: "SA", roles: ["SUPERADMIN"], hrmsAccessRole: "SuperAdmin", workspaceId: new mongoose.Types.ObjectId(HOUSE_WS) },
  ] as any);
});

describe("preview equals Generate", () => {
  it("intra-state", async () => {
    const c = await client({ gstRegisteredState: "Karnataka" });
    const { invoice } = await expectMatch(c.id, {}, {});
    expect(invoice.supplyType).toBe("CGST_SGST");
  });

  it("inter-state", async () => {
    const c = await client({ gstRegisteredState: "Maharashtra" });
    const { invoice } = await expectMatch(c.id, {}, {});
    expect(invoice.supplyType).toBe("IGST");
    expect(invoice.placeOfSupply).toBe("Maharashtra");
  });

  it("state from the workspace address when the customer has no address", async () => {
    const c = await client({}, { address: { state: "Karnataka", city: "Bengaluru" } });
    const { invoice } = await expectMatch(c.id, {}, {});
    expect(invoice.supplyType).toBe("CGST_SGST");
    expect(invoice.clientDetails.state).toBe("Karnataka");
  });

  it("the client's default seller GSTIN", async () => {
    const c = await client({ gstRegisteredState: "Maharashtra", defaultSellerGstin: MH });
    const { preview: p, invoice } = await expectMatch(c.id, {}, {});
    expect(p.supplierGstin).toBe(MH);
    expect(invoice.supplyType).toBe("CGST_SGST"); // Maharashtra to Maharashtra
  });

  it("a seller GSTIN chosen in the popup beats the client's default", async () => {
    const c = await client({ gstRegisteredState: "Maharashtra", defaultSellerGstin: MH });
    const { preview: p } = await expectMatch(c.id, { sellerGstin: KA }, { sellerGstin: KA });
    expect(p.supplierGstin).toBe(KA);
    expect(p.detectedGstType).toBe("IGST");
  });

  it("a state override", async () => {
    const c = await client({ gstRegisteredState: "Maharashtra" });
    const { invoice } = await expectMatch(c.id, { customerStateOverride: "Karnataka" }, { customerStateOverride: "Karnataka" });
    expect(invoice.supplyType).toBe("CGST_SGST");
    expect(invoice.placeOfSupply).toBe("Karnataka");
  });

  it("bypass forces the type and keeps the client's state as place of supply", async () => {
    const c = await client({ gstRegisteredState: "Maharashtra" });
    const { preview: p, invoice } = await expectMatch(
      c.id, { gstBypass: "true" }, { gstBypass: true, gstBypassReason: "State unavailable" },
    );
    expect(p.detectedGstType).toBe("CGST_SGST");
    expect(p.placeOfSupply).toBe("Maharashtra");
    expect(invoice.gstBypass).toBe(true);
  });

  it("bypass with no state falls back to the seller's state as place of supply", async () => {
    const c = await client({});
    const { preview: p } = await expectMatch(
      c.id, { gstBypass: "true" }, { gstBypass: true, gstBypassReason: "State unavailable" },
    );
    expect(p.placeOfSupply).toBe("Karnataka");
  });

  it("B2C with a state: tax by state, no GSTIN on the invoice", async () => {
    const c = await client({ gstStatus: "UNREGISTERED", gstRegisteredState: "Maharashtra", gstNumber: "27OLDGSTIN00000" });
    const { invoice } = await expectMatch(c.id, {}, {});
    expect(invoice.supplyType).toBe("IGST");
    expect(invoice.clientDetails.gstin).toBe("");
  });
});

describe("no state: preview and Generate agree it can't be calculated", () => {
  it.each([
    ["B2C", { gstStatus: "UNREGISTERED" }],
    ["status not set", {}],
  ])("%s without a state", async (_label, fields) => {
    const c = await client(fields);
    const p = await preview(c.id);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ customerFound: true, canCalculate: false, missingField: "state", customerState: null });
    const g = await generate(c.id);
    expect(g.status).toBe(400);
    expect(g.body.error).toBe("GST_DETECTION_FAILED");
    expect(p.body.reason).toBe(g.body.message);
  });

  it("B2C: picking a state in the popup works on both", async () => {
    const c = await client({ gstStatus: "UNREGISTERED" });
    const { invoice } = await expectMatch(c.id, { customerStateOverride: "Maharashtra" }, { customerStateOverride: "Maharashtra" });
    expect(invoice.supplyType).toBe("IGST");
  });

  it("still reports the seller Generate would use", async () => {
    const c = await client({ defaultSellerGstin: MH });
    const p = await preview(c.id);
    expect(p.body).toMatchObject({ canCalculate: false, supplierGstin: MH, supplierState: "Maharashtra" });
  });
});

describe("who can read which client", () => {
  async function tenantAdmin(own: { id: string; ws: string }) {
    const id = oid();
    const email = `${id}@tenant.test`;
    await col("users").insertOne({ _id: id, email, name: "Tenant Admin", roles: ["ADMIN"], workspaceId: new mongoose.Types.ObjectId(own.ws), customerId: own.id } as any);
    return { _id: String(id), id: String(id), sub: String(id), roles: ["ADMIN"], workspaceId: own.ws, customerId: own.id, email };
  }

  it("House staff and SuperAdmin resolve any client", async () => {
    const a = await client({ gstRegisteredState: "Karnataka" });
    const b = await client({ gstRegisteredState: "Maharashtra" });
    for (const user of [HOUSE_STAFF, SA]) {
      expect((await preview(a.id, {}, user)).body).toMatchObject({ customerFound: true, detectedGstType: "CGST_SGST" });
      expect((await preview(b.id, {}, user)).body).toMatchObject({ customerFound: true, detectedGstType: "IGST" });
    }
  });

  it("a tenant admin reads its own client and gets not-found for another's", async () => {
    const own = await client({ gstRegisteredState: "Karnataka" });
    const other = await client({ gstRegisteredState: "Maharashtra", defaultSellerGstin: MH });
    const ta = await tenantAdmin(own);

    const mine = await preview(own.id, {}, ta);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toMatchObject({ customerFound: true, detectedGstType: "CGST_SGST" });

    const theirs = await preview(other.id, {}, ta);
    expect(theirs.status).toBe(200);
    expect(theirs.body).toMatchObject({
      customerFound: false, canCalculate: false, customerState: null, detectedGstType: null,
      reason: "Customer not found in this workspace scope",
    });
    expect(theirs.body.supplierGstin).toBe(KA); // never the other client's default
  });

  it("another tenant's client answers exactly like an id that does not exist", async () => {
    const own = await client({ gstRegisteredState: "Karnataka" });
    const other = await client({ gstRegisteredState: "Maharashtra" });
    const ta = await tenantAdmin(own);
    const theirs = await preview(other.id, {}, ta);
    const missing = await preview(String(oid()), {}, ta);
    expect(theirs.body).toEqual(missing.body);
  });
});

describe("bad ids", () => {
  it.each(["[object Object]", "not-an-id", "null", "12345"])("%s is not found, never a 500", async (bad) => {
    const r = await preview(bad);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ customerFound: false, canCalculate: false });
  });

  it("no id is still a 400", async () => {
    const r = await request(app).get("/api/admin/invoices/gst-preview").set("x-test-user", JSON.stringify(HOUSE_STAFF));
    expect(r.status).toBe(400);
  });

  it("an inactive seller GSTIN is still a 400", async () => {
    const c = await client({ gstRegisteredState: "Karnataka" });
    const r = await preview(c.id, { sellerGstin: "07ABCDE1234F1Z5" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("SELLER_GSTIN_NOT_FOUND");
  });
});
