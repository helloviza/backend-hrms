// apps/backend/src/routes/gstP0SideFixes.test.ts
//
// Client multi-GST P0 side fixes (docs/audits/client-multi-gst-audit.md §9.4):
//   • N1: Business Profiles' "Default GST Registration (Bill From)" reaches the
//     Customer for ONBOARDED companies (PATCH /master-data/:id) — validated
//     against our active GST profiles, staff only — and is shown back from the
//     Customer (GET /customers list row).
//   • N4: the client portal invoice list (and its PDF / declare-payment) finds
//     the company's invoices stored under the Customer._id fallback — and never
//     another company's.
//   • N6: the duplicate-company report counts those invoices / credit notes.
//
// Real: masterData / customers / invoices workspace routers, the duplicate
//   report service, models, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    const cid = req.headers["x-test-ws-customer"];
    req.workspace = { _id: req.workspaceObjectId, status: "ACTIVE", ...(cid ? { customerId: String(cid) } : {}) };
    next();
  },
}));

const { default: masterDataRouter } = await import("./masterData.js");
const { default: customersRouter } = await import("./customers.js");
const { workspaceRouter: invoicesWorkspaceRouter } = await import("./invoices.js");
const { collectDuplicateReport } = await import("../services/companyDuplicates.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: Onboarding } = await import("../models/Onboarding.js");

const app = express();
app.use(express.json());
app.use("/api/master-data", masterDataRouter);
app.use("/api/customers", customersRouter);
app.use("/api/invoices/workspace", invoicesWorkspaceRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const STAFF = oid();
const staff = (r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ _id: String(STAFF), id: String(STAFF), sub: String(STAFF), roles: ["SUPERADMIN"] })).set("x-test-ws", String(HOUSE));

// Our own GST registrations (Plumtrips, issuer side).
const OUR_HR = "06AAACP1234A1Z5";
const OUR_KA = "29AAACP1234A1Z1";
const OUR_OFF = "07AAACP1234A1Z3"; // inactive

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("gst-p0-side-fixes-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await col("companysettings").insertOne({
    gstProfiles: [
      { state: "Haryana", stateCode: "06", gstin: OUR_HR, isDefault: true, active: true },
      { state: "Karnataka", stateCode: "29", gstin: OUR_KA, isDefault: false, active: true },
      { state: "Delhi", stateCode: "07", gstin: OUR_OFF, isDefault: false, active: false },
    ],
  });
});

async function onboardedCompany(extra: Record<string, unknown> = {}) {
  const ob: any = await Onboarding.create({
    workspaceId: HOUSE, type: "business", email: `c${Math.random()}@example.test`, token: `tok-${Math.random()}`,
    expiresAt: new Date(Date.now() + 86_400_000), status: "approved", formPayload: { legalName: "Acme Onboarded" },
  });
  const c: any = await Customer.create({ name: "Acme Onboarded", legalName: "Acme Onboarded", onboardingId: ob._id, ...extra });
  return { ob, c };
}

describe("N1: Bill From GSTIN on an onboarded company", () => {
  it("a chosen active GST profile reaches Customer.defaultSellerGstin and comes back on the list row", async () => {
    const { ob, c } = await onboardedCompany();
    const res = await staff(request(app).patch(`/api/master-data/${ob._id}`))
      .send({ legalName: "Acme Onboarded", defaultSellerGstin: OUR_KA.toLowerCase() });
    expect(res.status).toBe(200);
    expect(((await Customer.findById(c._id).lean()) as any).defaultSellerGstin).toBe(OUR_KA);
    // Never copied into the onboarding form (one copy: the Customer's).
    expect(((await Onboarding.findById(ob._id).lean()) as any).formPayload.defaultSellerGstin).toBeUndefined();

    const list = await staff(request(app).get("/api/customers"));
    expect(list.body.items.find((i: any) => i.id === String(c._id)).defaultSellerGstin).toBe(OUR_KA);
  });

  it("an unknown or inactive GSTIN is refused before anything is written", async () => {
    const { ob, c } = await onboardedCompany({ defaultSellerGstin: OUR_KA });
    for (const bad of ["29ZZZZZ9999Z1Z9", OUR_OFF]) {
      const res = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ legalName: "Renamed Co", defaultSellerGstin: bad });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("DEFAULT_SELLER_GSTIN_NOT_FOUND");
    }
    const after: any = await Customer.findById(c._id).lean();
    expect(after.defaultSellerGstin).toBe(OUR_KA);
    expect(after.legalName).toBe("Acme Onboarded");
  });

  it("\"\" = use our default profile: clears the choice", async () => {
    const { ob, c } = await onboardedCompany({ defaultSellerGstin: OUR_KA });
    const res = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ defaultSellerGstin: "" });
    expect(res.status).toBe(200);
    expect(((await Customer.findById(c._id).lean()) as any).defaultSellerGstin).toBe("");
  });

  it("a save that doesn't send it leaves the choice alone", async () => {
    const { ob, c } = await onboardedCompany({ defaultSellerGstin: OUR_KA });
    const res = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ phone: "9999999999" });
    expect(res.status).toBe(200);
    expect(((await Customer.findById(c._id).lean()) as any).defaultSellerGstin).toBe(OUR_KA);
  });

  it("a not-yet-promoted business can't take one (refused, not silently dropped)", async () => {
    const ob: any = await Onboarding.create({
      workspaceId: HOUSE, type: "business", email: "pending@example.test", token: "tok-pending",
      expiresAt: new Date(Date.now() + 86_400_000), status: "submitted", formPayload: { legalName: "Pending Co" },
    });
    const res = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ defaultSellerGstin: OUR_KA });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEFAULT_SELLER_GSTIN_NOT_PROMOTED");
  });

  it("a customer company's own HR admin can't choose our GSTIN", async () => {
    const TENANT = oid();
    const ob: any = await Onboarding.create({
      workspaceId: TENANT, type: "business", email: "t@example.test", token: "tok-t",
      expiresAt: new Date(Date.now() + 86_400_000), status: "approved", formPayload: { legalName: "Tenant Client" },
    });
    const c: any = await Customer.create({ name: "Tenant Client", legalName: "Tenant Client", onboardingId: ob._id });
    const res = await request(app).patch(`/api/master-data/${ob._id}`)
      .set("x-test-user", JSON.stringify({ _id: String(oid()), roles: ["HR"], workspaceId: String(TENANT) }))
      .set("x-test-ws", String(TENANT))
      .send({ defaultSellerGstin: OUR_KA });
    expect(res.status).toBe(403);
    expect(((await Customer.findById(c._id).lean()) as any).defaultSellerGstin).toBeUndefined();
  });
});

/* ── N4 + N6 fixtures ── */
async function company(name: string) {
  const c: any = await Customer.create({ name, legalName: name });
  const ws: any = await CustomerWorkspace.create({ customerId: String(c._id), companyName: name });
  return { c, ws };
}
let invSeq = 0;
async function invoice(workspaceId: mongoose.Types.ObjectId, status = "SENT") {
  invSeq += 1;
  const _id = oid();
  await col("invoices").insertOne({
    _id, invoiceNo: `INV-P0-${invSeq}`, workspaceId, status, generatedAt: new Date(), invoiceDate: new Date(),
    grandTotal: 1000, totalGST: 0, clientDetails: { companyName: "x", gstin: "" }, bookingIds: [],
  });
  return _id;
}
const leader = (ws: any, customerId?: unknown) => (r: request.Test) => {
  r.set("x-test-user", JSON.stringify({ _id: String(oid()), roles: ["WORKSPACE_LEADER"] })).set("x-test-ws", String(ws));
  if (customerId) r.set("x-test-ws-customer", String(customerId));
  return r;
};

describe("N4: portal invoices stored under the Customer._id fallback", () => {
  it("/mine lists both id spaces of the caller's company — and nothing of another company's", async () => {
    const a = await company("Alpha Ltd");
    const b = await company("Beta Ltd");
    const aByWs = await invoice(a.ws._id);
    const aByCust = await invoice(a.c._id); // generated before Alpha had a workspace
    const bByWs = await invoice(b.ws._id);
    const bByCust = await invoice(b.c._id);

    const res = await leader(a.ws._id, a.c._id)(request(app).get("/api/invoices/workspace/mine"));
    expect(res.status).toBe(200);
    const ids = res.body.invoices.map((i: any) => String(i._id)).sort();
    expect(ids).toEqual([String(aByWs), String(aByCust)].sort());
    expect(res.body.total).toBe(2);
    expect(ids).not.toContain(String(bByWs));
    expect(ids).not.toContain(String(bByCust));
  });

  it("declare-payment works on a Customer._id-keyed invoice of one's own, 404 on another company's", async () => {
    const a = await company("Alpha Ltd");
    const b = await company("Beta Ltd");
    const mine = await invoice(a.c._id);
    const theirs = await invoice(b.c._id);
    const ok = await leader(a.ws._id, a.c._id)(request(app).put(`/api/invoices/workspace/${mine}/declare-payment`)).send({});
    expect(ok.status).toBe(200);
    expect(((await col("invoices").findOne({ _id: mine })) as any).status).toBe("PAYMENT_DECLARED");
    const no = await leader(a.ws._id, a.c._id)(request(app).put(`/api/invoices/workspace/${theirs}/declare-payment`)).send({});
    expect(no.status).toBe(404);
    expect(((await col("invoices").findOne({ _id: theirs })) as any).status).toBe("SENT");
  });

  it("a workspace without a Customer id (SaaS slug) sees only its own workspace's invoices", async () => {
    const ws: any = await CustomerWorkspace.create({ customerId: "acme-saas-x1y2", companyName: "Saas Co" });
    const own = await invoice(ws._id);
    const other = await company("Other Ltd");
    await invoice(other.c._id);
    const res = await leader(ws._id, "acme-saas-x1y2")(request(app).get("/api/invoices/workspace/mine"));
    expect(res.status).toBe(200);
    expect(res.body.invoices.map((i: any) => String(i._id))).toEqual([String(own)]);
  });
});

describe("N6: duplicate report counts invoices / credit notes in both id spaces", () => {
  it("a company with no workspace, and one with a workspace, both get their Customer._id-keyed invoices counted", async () => {
    const PAN = "AAHCM5991L";
    // Delhi: has a workspace; one invoice under each id.
    const dl: any = await Customer.create({ name: "Molnlycke Delhi", legalName: "Molnlycke Health Care", gstNumber: `07${PAN}1ZS`, panNumber: PAN });
    const dlWs: any = await CustomerWorkspace.create({ customerId: String(dl._id), companyName: "Molnlycke Health Care" });
    await invoice(dlWs._id);
    const dlLegacy = await invoice(dl._id);
    await col("creditnotes").insertOne({ _id: oid(), creditNoteNo: "CN-P0-1", workspaceId: dl._id, originalInvoiceId: dlLegacy, status: "ISSUED" });
    // Haryana: no workspace; its invoice sits under its Customer._id.
    const hr: any = await Customer.create({ name: "Molnlycke Haryana", legalName: "Molnlycke Health Care India", gstNumber: `06${PAN}1ZU`, panNumber: PAN });
    await invoice(hr._id);

    const { rows } = await collectDuplicateReport();
    const dlRow = rows.find((r) => r.customerId === String(dl._id))!;
    const hrRow = rows.find((r) => r.customerId === String(hr._id))!;
    expect(dlRow.group).toBe(hrRow.group); // same PAN → one group
    expect(dlRow.counts.invoices).toBe(2);
    expect(dlRow.counts.creditNotes).toBe(1);
    expect(hrRow.counts.invoices).toBe(1);
    expect(hrRow.linkedTotal).toBeGreaterThan(0); // never "0 linked → safe to fold"
  });
});
