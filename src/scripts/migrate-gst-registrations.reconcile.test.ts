// apps/backend/src/scripts/migrate-gst-registrations.reconcile.test.ts
//
// P2 safety: a company the migration does NOT migrate (BAD_GSTIN,
// CROSS_COMPANY_DUP, TAX_STATE_DIFFERS, HELD via --hold) behaves after
// `--apply` exactly as it did before:
//   - its Customer and CustomerWorkspace documents are byte-identical
//     (the mirrors invoices, the GST preview and TBO read are untouched);
//   - GET /admin/invoices/gst-preview answers the same;
//   - POST /admin/invoices/generate produces the same tax treatment;
//   - GET /workspace/settings (what SBT puts into the TBO GST block) is the same.
// A CREATE_DEFAULT control company in the same run IS migrated, so the run
// really applied.
//
// Real: migration runMigration(), registration service, invoices router +
// generation service, workspace settings router, models, in-memory replica set.
// Stubbed: requireAuth, requirePermission, requireWorkspace (header-driven), mailer.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: vi.fn(async () => ({ messageId: "test" })) }));
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
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    req.workspace = { _id: req.workspaceObjectId, status: "ACTIVE" };
    next();
  },
}));

const { runMigration } = await import("./migrate-gst-registrations.js");
const { default: invoicesRouter } = await import("../routes/invoices.js");
const { default: workspaceSettingsRouter } = await import("../routes/workspace.settings.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");

const HOUSE_WS = "69679a7628330a58d29f2254";
const app = express();
app.use(express.json());
// The server resolves the HOUSE workspace before this router (its tenant gate fails closed without it).
app.use("/api/admin/invoices", (req: any, _res: any, next: any) => {
  req.workspaceId = HOUSE_WS;
  req.workspaceObjectId = new mongoose.Types.ObjectId(HOUSE_WS);
  next();
}, invoicesRouter);
app.use("/api/workspace/settings", workspaceSettingsRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function gstin(state: string, pan: string): string {
  const body = `${state}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return body + CHARS[(36 - (sum % 36)) % 36];
}
const badCheckDigit = (g: string) => g.slice(0, 14) + (g[14] === "A" ? "B" : "A");

const SELLER_HR = gstin("06", "AAACP5555P");
let mongod: MongoMemoryReplSet;
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const STAFF_ID = oid();
const STAFF = { _id: String(STAFF_ID), id: String(STAFF_ID), sub: String(STAFF_ID), roles: ["ADMIN"], workspaceId: HOUSE_WS, email: "finance@plumtrips.test" };

type Co = { id: string; ws: string; kind: string };
async function company(kind: string, gst: string, pan: string, extra: Record<string, unknown> = {}): Promise<Co> {
  const c: any = await Customer.create({ name: kind, legalName: `${kind} Pvt Ltd`, status: "ACTIVE", gstStatus: "REGISTERED", gstNumber: gst, panNumber: pan, ...extra } as any);
  const ws: any = await CustomerWorkspace.create({ customerId: String(c._id), slug: `ws-${c._id}`, companyName: kind, status: "ACTIVE", gstNumber: gst, address: { line1: "1 Road", city: "City", state: (extra as any).gstRegisteredState || "" } } as any);
  await Customer.updateOne({ _id: c._id }, { $set: { workspaceId: ws._id } });
  return { id: String(c._id), ws: String(ws._id), kind };
}

let seq = 0;
async function booking(customerId: string) {
  seq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: customerId, bookedBy: STAFF_ID, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-RC-${seq}`,
    travelDate: new Date("2026-12-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
  });
  return String(b._id);
}

const asStaff = (r: request.Test) => r.set("x-test-user", JSON.stringify(STAFF)).set("x-test-ws", HOUSE_WS);
const asLeader = (co: Co) => (r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ _id: String(oid()), roles: ["CUSTOMER", "WORKSPACE_LEADER"], customerId: co.id, workspaceId: co.ws })).set("x-test-ws", co.ws);

/** Everything a reader of the mirrors sees for this company, minus per-run noise. */
async function observe(co: Co) {
  const p = await asStaff(request(app).get("/api/admin/invoices/gst-preview").query({ customerId: co.id }));
  const g = await asStaff(request(app).post("/api/admin/invoices/generate")).send({
    bookingIds: [await booking(co.id)], invoiceDate: "2026-12-01", billingPeriod: "December 2026",
  });
  const inv = g.body?.invoice;
  const generated = g.status === 201
    ? {
        supplyType: inv.supplyType, placeOfSupply: inv.placeOfSupply, clientState: inv.clientState, issuerState: inv.issuerState,
        client: { gstin: inv.clientDetails?.gstin, state: inv.clientDetails?.state, name: inv.clientDetails?.name },
        issuerGstin: inv.issuerDetails?.gstin, igst: inv.igstAmount, cgst: inv.cgstAmount, sgst: inv.sgstAmount, totalGST: inv.totalGST,
      }
    : g.body;
  const t = await asLeader(co)(request(app).get("/api/workspace/settings"));
  const tbo = { gstNumber: t.body.gstNumber, gstStatus: t.body.gstStatus, companyName: t.body.companyName, address: t.body.address, pan: t.body.pan };
  return { preview: { status: p.status, body: p.body }, generate: { status: g.status, body: generated }, tbo: { status: t.status, body: tbo } };
}
const raw = async (co: Co) => ({
  customer: await col("customers").findOne({ _id: new mongoose.Types.ObjectId(co.id) }),
  workspace: await col("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(co.ws) }),
});

let BAD: Co, DUP_A: Co, DUP_B: Co, DIFF: Co, HELD: Co, CONTROL: Co;
let result: Awaited<ReturnType<typeof runMigration>>;
const before = new Map<string, any>();
const rawBefore = new Map<string, any>();
const rawAfter = new Map<string, any>();
const after = new Map<string, any>();

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mongod.getUri("gst-migration-reconcile-test"));
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: "annual",
    gstProfiles: [{ gstin: SELLER_HR, state: "Haryana", stateCode: "06", legalName: "Plumtrips HR", addressLine1: "", addressLine2: "", city: "Gurugram", pincode: "122001", isDefault: true, active: true, invoiceSeriesPrefix: "" }],
  } as any);
  await col("customerworkspaces").insertOne({ _id: new mongoose.Types.ObjectId(HOUSE_WS), customerId: HOUSE_WS, companyName: "Plumtrips", status: "ACTIVE" } as any);
  await col("users").insertOne({ _id: STAFF_ID, email: STAFF.email, name: "Finance", roles: ["ADMIN"], workspaceId: new mongoose.Types.ObjectId(HOUSE_WS) } as any);

  // BAD_GSTIN: a check-digit typo, state on file (Baba Electromech shape).
  BAD = await company("BAD_GSTIN", badCheckDigit(gstin("09", "AAGCB6737J")), "AAGCB6737J", { gstRegisteredState: "Uttar Pradesh" });
  // CROSS_COMPANY_DUP: one GSTIN on two records (Llama Logisol shape).
  const dup = gstin("06", "AACCL8751C");
  DUP_A = await company("DUP_A", dup, "AACCL8751C", { gstRegisteredState: "Haryana" });
  DUP_B = await company("DUP_B", dup, "");
  // TAX_STATE_DIFFERS: Gujarat GSTIN, Haryana on file (Louis Dreyfus shape).
  DIFF = await company("TAX_STATE_DIFFERS", gstin("24", "AAACL7361E"), "AAACL7361E", { gstRegisteredState: "Haryana" });
  // HELD: valid West Bengal GSTIN, no state anywhere (Inteletek shape).
  HELD = await company("HELD", gstin("19", "AAACX0323Q"), "");
  // Control: same shape as HELD, not held → migrated.
  CONTROL = await company("CONTROL", gstin("29", "AAZFV4451B"), "");

  const reconcile = [BAD, DUP_A, DUP_B, DIFF, HELD];
  for (const co of reconcile) before.set(co.kind, await observe(co));
  for (const co of reconcile) rawBefore.set(co.kind, await raw(co));
  result = await runMigration({ apply: true, hold: new Set([HELD.id]) });
  for (const co of reconcile) rawAfter.set(co.kind, await raw(co));
  for (const co of reconcile) after.set(co.kind, await observe(co));
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

const actionOf = (co: Co) => result.rows.find((r) => r.customerId === co.id)?.action;

describe("migration --apply --hold: classification", () => {
  it("classifies each reconcile shape and applies only the control company", () => {
    expect(actionOf(BAD)).toBe("BAD_GSTIN");
    expect(actionOf(DUP_A)).toBe("CROSS_COMPANY_DUP");
    expect(actionOf(DUP_B)).toBe("CROSS_COMPANY_DUP");
    expect(actionOf(DIFF)).toBe("TAX_STATE_DIFFERS");
    expect(actionOf(HELD)).toBe("HELD");
    expect(actionOf(CONTROL)).toBe("CREATE_DEFAULT");
    expect(result).toMatchObject({ applied: 1, applyErrors: 0 });
  });

  it("the control company really was migrated (registration + filled state)", async () => {
    const c: any = await Customer.findById(CONTROL.id).lean();
    expect(c.gstRegistrations).toHaveLength(1);
    expect(c.gstRegisteredState).toBe("Karnataka");
  });

  it("no audit row for any company left alone", async () => {
    const ids = [BAD, DUP_A, DUP_B, DIFF, HELD].map((c) => new mongoose.Types.ObjectId(c.id));
    expect(await col("gstregistrationaudits").countDocuments({ customerId: { $in: ids } })).toBe(0);
    expect(await col("gstregistrationaudits").countDocuments({ action: "MIGRATED" })).toBe(1);
  });

  it("the readers really answered (the comparisons below are not vacuous)", () => {
    for (const kind of ["BAD_GSTIN", "DUP_A", "DUP_B", "TAX_STATE_DIFFERS", "HELD"]) {
      const o = before.get(kind);
      expect(o.preview.status, kind).toBe(200);
      expect(o.tbo.status, kind).toBe(200);
      expect(o.tbo.body.gstNumber, kind).toMatch(/^[0-9A-Z]{15}$/);
    }
    // A state on file → a real invoice with a tax type; Haryana seller.
    expect(before.get("BAD_GSTIN").generate).toMatchObject({ status: 201, body: { supplyType: "IGST" } });
    expect(before.get("DUP_A").generate).toMatchObject({ status: 201, body: { supplyType: "CGST_SGST" } });
    expect(before.get("TAX_STATE_DIFFERS").generate).toMatchObject({ status: 201, body: { supplyType: "CGST_SGST", placeOfSupply: "Haryana" } });
  });

  it("an unknown --hold id refuses the whole run before any write", async () => {
    await expect(runMigration({ apply: true, hold: new Set([String(oid())]) })).rejects.toThrow(/REFUSING: --hold/);
  });
});

describe.each(["BAD_GSTIN", "DUP_A", "DUP_B", "TAX_STATE_DIFFERS", "HELD"])("%s after --apply behaves exactly as today", (kind) => {
  it("Customer and CustomerWorkspace documents are byte-identical (mirrors unchanged)", () => {
    const b = rawBefore.get(kind), a = rawAfter.get(kind);
    expect(a.customer.gstRegistrations).toBeUndefined();
    expect(JSON.stringify(a.customer)).toBe(JSON.stringify(b.customer));
    expect(JSON.stringify(a.workspace)).toBe(JSON.stringify(b.workspace));
  });
  it("GST preview answers the same", () => {
    expect(after.get(kind).preview).toEqual(before.get(kind).preview);
  });
  it("Generate gives the same tax treatment", () => {
    expect(after.get(kind).generate).toEqual(before.get(kind).generate);
  });
  it("the TBO GST block (GET /workspace/settings) is the same", () => {
    expect(after.get(kind).tbo).toEqual(before.get(kind).tbo);
  });
});
