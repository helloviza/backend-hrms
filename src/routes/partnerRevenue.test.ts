// Partner revenue share, end to end on a real (in-memory, replica-set) database:
//   - admin config endpoints: SUPERADMIN only, 0–100 validation, reason, version,
//     append-only change log — and they never touch the view flag;
//   - the view flag (config.features.revenueShareEnabled) is written only by
//     Workspace Manager's toggle (PUT /api/superadmin/workspaces/:id/features);
//   - snapshot written when a booking becomes INVOICED (generation service,
//     POST /:id/add-bookings, PATCH add) and cleared when it is un-invoiced
//     (POST /:id/cancel, PATCH remove); frozen against later config changes;
//   - the ID-space bridge (ManualBooking.workspaceId = Customer._id, config on
//     CustomerWorkspace._id) — a decoy config whose workspace _id EQUALS a
//     customer id must never match that customer's bookings;
//   - partner endpoints: 403 when the flag is off (no SuperAdmin / HOUSE
//     bypass) / caller has no billing access, CANCELLED / deleted / cost-0
//     excluded, credit notes reduce the share — only the company's own credit
//     notes, invoices and combined-line bookings count — and no cost field ever
//     appears in a response.
//
// Real: the four routers, every model, mongodb-memory-server (replica set, for
// the PATCH transaction). Stubbed: requireAuth / requireWorkspace (user and
// workspace from headers), requirePermission (always allows), outbound I/O.
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
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: async (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    if (id) {
      const ws = await mongoose.connection.db!.collection("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(id) });
      req.workspace = ws;
      req.workspaceObjectId = ws?._id;
      req.workspaceId = String(ws?._id ?? "");
    }
    next();
  },
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: vi.fn(async () => undefined) }));

const { default: adminRouter } = await import("./admin.partnerRevenue.js");
const { default: invoicesRouter } = await import("./invoices.js");
const { default: revenueRouter } = await import("./myBookings.revenue.js");
const { default: workspaceRouter } = await import("./workspace.js");
const { default: superadminRouter } = await import("./superadmin.workspaces.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireAuth } = await import("../middleware/auth.js");
const { createInvoiceFromBookings } = await import("../services/invoiceGeneration.service.js");
const { snapshotPartnerShare } = await import("../services/partnerRevenue.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: PartnerRevenueChange } = await import("../models/PartnerRevenueChange.js");
const { default: PartnerRevenueConfig } = await import("../models/PartnerRevenueConfig.js");
const { default: logger } = await import("../utils/logger.js");

const app = express();
app.use(express.json());
app.use("/api/admin/partner-revenue", requireAuth, requireWorkspace, adminRouter);
app.use("/api/admin/invoices", requireAuth, requireWorkspace, invoicesRouter);
app.use("/api/my-bookings/revenue", requireAuth, requireWorkspace, revenueRouter);
app.use("/api/v1/workspace", requireAuth, workspaceRouter);
app.use("/api/superadmin", requireAuth, superadminRouter);

let mongod: MongoMemoryReplSet;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

// Partner: Customer CUST_P ↔ CustomerWorkspace WS_P. Non-partner: CUST_N ↔ WS_N.
// DECOY: a CustomerWorkspace whose _id IS CUST_N (pointing at an unrelated
// customer) with an ENABLED config — the trap for anything that matches a
// booking's Customer._id against a config's CustomerWorkspace._id.
const CUST_P = oid();
const WS_P = oid();
const CUST_N = oid();
const WS_N = oid();
const CUST_DECOY_TARGET = oid();
const SA_ID = oid();
const WL_ID = oid();
const MEMBER_ID = oid();
const BILLING_ID = oid();

const user = (id: mongoose.Types.ObjectId, roles: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ _id: String(id), id: String(id), sub: String(id), email: `${id}@test`, roles, ...extra });
const SA = user(SA_ID, ["SUPERADMIN"]);
const WL = user(WL_ID, ["WORKSPACE_LEADER"]);
const MEMBER = user(MEMBER_ID, ["REQUESTER"]);
const BILLING = user(BILLING_ID, ["REQUESTER"]);

const FORBIDDEN = ["actualPrice", "supplierCost", "basePrice", "diff", "markupAmount", "profitMargin", "visiblePct", "sharePct", "marginBase", "partnerShare", "actualRate", "actualAmount", "_hasCost"];
function keysDeep(v: any, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysDeep(x, out));
  return out;
}

async function seedTenants() {
  const ws = (id: any, customerId: any, name: string) => ({
    _id: id, customerId: String(customerId), companyName: name, status: "ACTIVE",
    config: { features: { invoicesEnabled: true, revenueShareEnabled: false } },
  });
  await col("customerworkspaces").insertMany([
    ws(WS_P, CUST_P, "Partner Co"),
    ws(WS_N, CUST_N, "Plain Co"),
    ws(CUST_N, CUST_DECOY_TARGET, "Decoy Co"),
  ] as any);
  const cust = (id: any, name: string) => ({
    _id: id, name, companyName: name, legalName: name,
    gstRegisteredState: "Karnataka", gstRegisteredStateCode: "29", address: { state: "Karnataka", country: "India" },
  });
  await col("customers").insertMany([cust(CUST_P, "Partner Co"), cust(CUST_N, "Plain Co")] as any);
  await col("users").insertMany([
    { _id: BILLING_ID, email: `${BILLING_ID}@test`, customerId: String(CUST_P), canViewBilling: true },
    { _id: MEMBER_ID, email: `${MEMBER_ID}@test`, customerId: String(CUST_P), canViewBilling: false },
  ] as any);
  await col("companysettings").insertOne({
    companyName: "Plumtrips", gstin: "29ABCDE1234F1Z5", state: "Karnataka", stateCode: "29",
  } as any);
}

async function makeBooking(customerId: any, opts: { actual?: number; quoted?: number; status?: string; isActive?: boolean; email?: string } = {}) {
  const b: any = await ManualBooking.create({
    workspaceId: customerId,
    type: "FLIGHT",
    travelDate: new Date(Date.now() + 7 * 86400000),
    bookedBy: SA_ID,
    status: opts.status ?? "CONFIRMED",
    isActive: opts.isActive ?? true,
    passengers: [{ name: "Asha Rao", email: opts.email ?? "asha@partner.test" }],
    pricing: { actualPrice: opts.actual ?? 10_000, quotedPrice: opts.quoted ?? 11_180, gstMode: "ON_MARKUP", gstPercent: 18 },
    itinerary: { origin: "BLR", destination: "DEL" },
  });
  return b;
}
const fresh = async (id: any) => (await col("manualbookings").findOne({ _id: id })) as any;

async function putConfig(wsId: any, body: Record<string, unknown>, as = SA) {
  return request(app).put(`/api/admin/partner-revenue/${wsId}`).set("x-test-user", as).set("x-test-ws", String(WS_P)).send(body);
}

/** Workspace Manager's feature toggle — the one writer of the partner's view. */
async function setView(wsId: any, enabled: boolean, as = SA) {
  return request(app).put(`/api/superadmin/workspaces/${wsId}/features`).set("x-test-user", as).send({ feature: "revenueShareEnabled", enabled });
}
const viewFlag = async (wsId: any) => ((await col("customerworkspaces").findOne({ _id: wsId })) as any).config.features.revenueShareEnabled;

async function generate(ids: any[], lineItemStyle: "SEPARATE" | "COMBINED" = "SEPARATE") {
  const [inv] = await createInvoiceFromBookings(ids.map(String), { format: "COMBINED", lineItemStyle, createdBy: SA_ID } as any);
  return inv;
}

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("partner-revenue-test"));
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  for (const c of ["customerworkspaces", "customers", "users", "companysettings", "manualbookings", "travelbookings", "invoices", "creditnotes", "partnerrevenueconfigs", "partnerrevenuechanges", "counters"]) {
    await col(c).deleteMany({});
  }
  await seedTenants();
});

/* ───────────────────────── admin config ───────────────────────── */

describe("admin config — SUPERADMIN only", () => {
  it.each([
    ["workspace leader", WL],
    ["tenant admin", user(oid(), ["TENANT_ADMIN"])],
    ["platform admin", user(oid(), ["ADMIN"])],
  ])("%s gets 403 on every endpoint", async (_l, who) => {
    const h = (r: request.Test) => r.set("x-test-user", who).set("x-test-ws", String(WS_P));
    expect((await h(request(app).get("/api/admin/partner-revenue"))).status).toBe(403);
    expect((await h(request(app).get("/api/admin/partner-revenue/companies"))).status).toBe(403);
    expect((await h(request(app).get("/api/admin/partner-revenue/history"))).status).toBe(403);
    expect((await h(request(app).put(`/api/admin/partner-revenue/${WS_P}`).send({ visiblePct: 50, sharePct: 50, reason: "x" }))).status).toBe(403);
    expect((await h(request(app).delete(`/api/admin/partner-revenue/${WS_P}`).send({ reason: "x" }))).status).toBe(403);
    expect(await col("partnerrevenueconfigs").countDocuments()).toBe(0);
  });

  it.each([
    [{ visiblePct: 101, sharePct: 10, reason: "r" }],
    [{ visiblePct: -1, sharePct: 10, reason: "r" }],
    [{ visiblePct: "50", sharePct: 10, reason: "r" }],
    [{ visiblePct: 50, reason: "r" }],
    [{ visiblePct: 50, sharePct: 10 }],
    [{ visiblePct: 50, sharePct: 10, reason: "   " }],
    [{ visiblePct: 50, sharePct: 10, reason: "r", enabled: "yes" }],
  ])("rejects %j with 400 and writes nothing", async (body) => {
    const res = await putConfig(WS_P, body);
    expect(res.status).toBe(400);
    expect(await col("partnerrevenueconfigs").countDocuments()).toBe(0);
    expect(await col("partnerrevenuechanges").countDocuments()).toBe(0);
  });

  it("create → update → disable → delete: version and log follow; the view flag is never touched", async () => {
    let res = await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "Signed partner agreement" });
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({ enabled: true, visiblePct: 50, sharePct: 40, version: 1 });
    expect(await viewFlag(WS_P)).toBe(false);

    res = await putConfig(WS_P, { visiblePct: 60, sharePct: 40, reason: "Renegotiated" });
    expect(res.body.config.version).toBe(2);

    res = await putConfig(WS_P, { visiblePct: 60, sharePct: 40, enabled: false, reason: "Paused" });
    expect(res.body.config).toMatchObject({ enabled: false, version: 3 });
    expect(await viewFlag(WS_P)).toBe(false);

    const list = await request(app).get("/api/admin/partner-revenue").set("x-test-user", SA).set("x-test-ws", String(WS_P));
    expect(list.body.configs).toHaveLength(1);
    expect(list.body.configs[0]).toMatchObject({ workspaceId: String(WS_P), companyName: "Partner Co", visiblePct: 60, enabled: false });

    const companies = await request(app).get("/api/admin/partner-revenue/companies?q=partner").set("x-test-user", SA).set("x-test-ws", String(WS_P));
    expect(companies.body.companies).toEqual([expect.objectContaining({ workspaceId: String(WS_P), hasConfig: true })]);

    expect((await request(app).delete(`/api/admin/partner-revenue/${WS_P}`).set("x-test-user", SA).set("x-test-ws", String(WS_P)).send({})).status).toBe(400);
    const del = await request(app).delete(`/api/admin/partner-revenue/${WS_P}`).set("x-test-user", SA).set("x-test-ws", String(WS_P)).send({ reason: "Agreement ended" });
    expect(del.status).toBe(200);
    expect(await col("partnerrevenueconfigs").countDocuments()).toBe(0);
    expect(await viewFlag(WS_P)).toBe(false);

    const hist = await request(app).get(`/api/admin/partner-revenue/history?workspaceId=${WS_P}`).set("x-test-user", SA).set("x-test-ws", String(WS_P));
    expect(hist.body.changes.map((c: any) => c.action)).toEqual(["REMOVE", "UPDATE", "UPDATE", "CREATE"]);
    const update = hist.body.changes[2];
    expect(update.before).toMatchObject({ visiblePct: 50, version: 1 });
    expect(update.after).toMatchObject({ visiblePct: 60, version: 2 });
    expect(update.reason).toBe("Renegotiated");
  });

  it("a view switched on in Workspace Manager survives pausing, re-enabling and removing the config", async () => {
    expect((await setView(WS_P, true)).status).toBe(200);
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "on" });
    expect(await viewFlag(WS_P)).toBe(true);
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, enabled: false, reason: "paused" });
    expect(await viewFlag(WS_P)).toBe(true);
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, enabled: true, reason: "on again" });
    expect(await viewFlag(WS_P)).toBe(true);
    await request(app).delete(`/api/admin/partner-revenue/${WS_P}`).set("x-test-user", SA).set("x-test-ws", String(WS_P)).send({ reason: "ended" });
    expect(await viewFlag(WS_P)).toBe(true);
    // Only Workspace Manager turns it off again.
    expect((await setView(WS_P, false)).status).toBe(200);
    expect(await viewFlag(WS_P)).toBe(false);
  });

  it("Workspace Manager's toggle is SUPERADMIN only", async () => {
    expect((await setView(WS_P, true, WL)).status).toBe(403);
    expect((await setView(WS_P, true, user(oid(), ["ADMIN"]))).status).toBe(403);
    expect(await viewFlag(WS_P)).toBe(false);
  });

  it("the change log is append-only", async () => {
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "r" });
    await expect(PartnerRevenueChange.updateOne({}, { $set: { reason: "rewritten" } })).rejects.toThrow(/append-only/);
    await expect(PartnerRevenueChange.deleteMany({})).rejects.toThrow(/append-only/);
    expect(await col("partnerrevenuechanges").countDocuments()).toBe(1);
  });
});

/* ───────────────────────── snapshot on invoicing ───────────────────────── */

describe("snapshot — written at INVOICED, cleared on un-invoice, frozen", () => {
  beforeEach(async () => {
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "r" });
  });

  it("invoice generation snapshots basePrice × 50% × 40%", async () => {
    const b = await makeBooking(CUST_P); // markup 1180 incl. GST → basePrice 1000
    expect(b.pricing.basePrice).toBe(1000);
    await generate([b._id]);
    const after = await fresh(b._id);
    expect(after.status).toBe("INVOICED");
    expect(after.partnerShare).toMatchObject({ visiblePct: 50, sharePct: 40, configVersion: 1, marginBase: 1000, bakedIn: 500, share: 200 });
  });

  it("cost 0 → no snapshot", async () => {
    const b = await makeBooking(CUST_P, { actual: 0, quoted: 1180 });
    await generate([b._id]);
    const after = await fresh(b._id);
    expect(after.status).toBe("INVOICED");
    expect(after.partnerShare).toBeUndefined();
  });

  it("a later config change never rewrites the snapshot", async () => {
    const b = await makeBooking(CUST_P);
    await generate([b._id]);
    await putConfig(WS_P, { visiblePct: 100, sharePct: 100, reason: "changed" });
    expect((await fresh(b._id)).partnerShare).toMatchObject({ bakedIn: 500, share: 200, configVersion: 1 });
  });

  it("ID SPACES: a non-partner's bookings never match a config keyed on a workspace whose _id equals their Customer._id", async () => {
    // The decoy workspace's _id is CUST_N — the exact value CUST_N's bookings
    // carry in workspaceId. Give it an enabled config.
    expect((await putConfig(CUST_N, { visiblePct: 100, sharePct: 100, reason: "decoy" })).status).toBe(200);
    const nb = await makeBooking(CUST_N);
    await generate([nb._id]);
    expect((await fresh(nb._id)).status).toBe("INVOICED");
    expect((await fresh(nb._id)).partnerShare).toBeUndefined();
    // And the real partner is still found through CustomerWorkspace.customerId.
    const pb = await makeBooking(CUST_P);
    await snapshotPartnerShare([pb._id]);
    expect((await fresh(pb._id)).partnerShare).toMatchObject({ share: 200 });
  });

  it("disabled config → no snapshot", async () => {
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, enabled: false, reason: "paused" });
    const b = await makeBooking(CUST_P);
    await generate([b._id]);
    expect((await fresh(b._id)).partnerShare).toBeUndefined();
  });

  it("POST /:id/cancel clears it; POST /:id/add-bookings writes it", async () => {
    const a = await makeBooking(CUST_P);
    const inv = await generate([a._id]);
    const b = await makeBooking(CUST_P);
    const add = await request(app).post(`/api/admin/invoices/${inv._id}/add-bookings`).set("x-test-user", SA).set("x-test-ws", String(WS_P)).send({ bookingIds: [String(b._id)] });
    expect(add.status).toBe(200);
    expect((await fresh(b._id)).partnerShare).toMatchObject({ share: 200 });

    const cancel = await request(app).post(`/api/admin/invoices/${inv._id}/cancel`).set("x-test-user", SA).set("x-test-ws", String(WS_P)).send({ reason: "wrong client" });
    expect(cancel.status).toBe(200);
    for (const id of [a._id, b._id]) {
      const d = await fresh(id);
      expect(d.status).toBe("CONFIRMED");
      expect(d.partnerShare).toBeUndefined();
    }
  });

  it("PATCH remove clears it; PATCH add writes it (after the transaction)", async () => {
    const a = await makeBooking(CUST_P);
    const b = await makeBooking(CUST_P);
    const inv = await generate([a._id, b._id]);
    const c = await makeBooking(CUST_P);
    const lines = ((await col("invoices").findOne({ _id: inv._id })) as any).lineItems.filter((l: any) => l.bookingRef !== (b as any).bookingRef);
    const res = await request(app)
      .patch(`/api/admin/invoices/${inv._id}`)
      .set("x-test-user", SA).set("x-test-ws", String(WS_P))
      .send({ lineItems: lines, bookingsToRemove: [String(b._id)], bookingsToAdd: [String(c._id)] });
    expect(res.status).toBe(200);
    expect((await fresh(b._id)).status).toBe("CONFIRMED");
    expect((await fresh(b._id)).partnerShare).toBeUndefined();
    expect((await fresh(c._id)).status).toBe("INVOICED");
    expect((await fresh(c._id)).partnerShare).toMatchObject({ share: 200 });
    expect((await fresh(a._id)).partnerShare).toMatchObject({ share: 200 });
  });
});

/* ───────────────────────── partner endpoints ───────────────────────── */

describe("partner endpoints — /api/my-bookings/revenue", () => {
  const get = (path: string, who = WL, ws = WS_P) =>
    request(app).get(`/api/my-bookings/revenue${path}`).set("x-test-user", who).set("x-test-ws", String(ws));

  it("403 when the workspace's flag is off", async () => {
    expect((await get("/stats")).status).toBe(403);
    expect((await get("/bookings")).status).toBe(403);
  });

  it("403 with the flag off even while the partner is EARNING (config on) — the view is Workspace Manager's", async () => {
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "earning" });
    for (const path of ["/stats", "/bookings", "/bookings/export"]) expect((await get(path)).status).toBe(403);
    await setView(WS_P, true);
    expect((await get("/stats")).status).toBe(200);
  });

  it("no SuperAdmin or HOUSE bypass: both get 403 when their workspace's flag is off", async () => {
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "earning" });
    for (const path of ["/stats", "/bookings", "/bookings/export"]) {
      expect((await get(path, SA)).status).toBe(403);
      // A SuperAdmin with no resolved workspace (requireWorkspace's bypass) too.
      expect((await request(app).get(`/api/my-bookings/revenue${path}?workspaceId=${WS_P}`).set("x-test-user", SA).set("x-workspace-id", String(WS_P))).status).toBe(403);
    }
    const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
    await col("customerworkspaces").insertOne({ _id: HOUSE, customerId: String(oid()), companyName: "Plumtrips", status: "ACTIVE", config: { features: { revenueShareEnabled: false } } } as any);
    for (const who of [user(oid(), ["ADMIN"]), user(oid(), ["EMPLOYEE"]), SA]) {
      for (const path of ["/stats", "/bookings", "/bookings/export"]) expect((await get(path, who, HOUSE as any)).status).toBe(403);
    }
  });

  describe("with an enabled partner", () => {
    beforeEach(async () => {
      await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "r" });
      await setView(WS_P, true);
    });

    it("403 for a member without billing access; 200 for canViewBilling and the leader", async () => {
      expect((await get("/stats", MEMBER)).status).toBe(403);
      expect((await get("/stats", BILLING)).status).toBe(200);
      expect((await get("/stats", WL)).status).toBe(200);
    });

    it("stats: cancelled / deleted / other-tenant / wrong-id-space rows excluded; credit notes reduce the share", async () => {
      const invoiced = await makeBooking(CUST_P);
      const credited = await makeBooking(CUST_P);
      await generate([invoiced._id, credited._id]);
      await makeBooking(CUST_P, { status: "CONFIRMED" }); // not invoiced yet → counts as a trip, earns nothing yet
      await makeBooking(CUST_P, { status: "CANCELLED" });
      await makeBooking(CUST_P, { isActive: false });
      await makeBooking(CUST_N);
      // Same pricing, but keyed on the partner's CustomerWorkspace._id (the wrong space).
      const wrongSpace = await makeBooking(CUST_P);
      await col("manualbookings").updateOne({ _id: wrongSpace._id }, { $set: { workspaceId: WS_P } });

      const inv: any = await col("invoices").findOne({ bookingIds: invoiced._id });
      // Half of the credited booking's 1180 Transaction Fees line, paired with
      // the real invoice line the way routes/creditNotes.ts pairs them.
      const feeLine = inv.lineItems.find((l: any) => l.rowType === "SERVICE_FEE" && l.bookingRef === (credited as any).bookingRef);
      await col("creditnotes").insertOne({
        creditNoteNo: "CN-1", workspaceId: WS_P, originalInvoiceId: inv._id, status: "ISSUED", isFullCredit: false,
        lineItems: [{ ...feeLine, originalAmount: feeLine.amount, creditedAmount: 590, amount: 590, igst: 90 }],
      } as any);

      const res = await get("/stats");
      expect(res.status).toBe(200);
      const p = res.body.primary;
      expect(p.totalTrips).toBe(3);
      expect(p.totalSpend).toBe(3 * 11_180);
      expect(p.activeTravellers).toBe(1);
      expect(p.breakdown.find((x: any) => x.service === "FLIGHT")).toMatchObject({ count: 3 });
      // invoiced: 500 / 200. credited: 590 of its 11180 invoiced → × (1 − 590/11180) → 473.61 / 189.45.
      expect(p.totalBakedIn).toBe(973.61);
      expect(p.totalShare).toBe(389.45);
      for (const k of FORBIDDEN) expect(keysDeep(res.body).has(k)).toBe(false);
    });

    it("stats cards count CONFIRMED + INVOICED only — PENDING / WIP / demo rows are not trips; Revenue Earned unchanged", async () => {
      const invoiced = await makeBooking(CUST_P);
      await generate([invoiced._id]);
      await makeBooking(CUST_P, { status: "CONFIRMED" });
      await makeBooking(CUST_P, { status: "PENDING" });
      await makeBooking(CUST_P, { status: "WIP" });
      const demo = await makeBooking(CUST_P);
      await col("manualbookings").updateOne({ _id: demo._id }, { $set: { isDemo: true } });
      // A row with no isActive / isDemo keys at all (as most prod rows are) still counts.
      const bare = await makeBooking(CUST_P);
      await col("manualbookings").updateOne({ _id: bare._id }, { $unset: { isActive: "", isDemo: "" } });

      const p = (await get("/stats")).body.primary;
      expect(p.totalTrips).toBe(3);
      expect(p.totalSpend).toBe(3 * 11_180);
      expect(p.breakdown.find((x: any) => x.service === "FLIGHT")).toMatchObject({ count: 3 });
      expect(p.totalBakedIn).toBe(500);
      expect(p.totalShare).toBe(200);
    });

    it("bookings: /manual row shape + revenueEarned (number / PENDING / null); never a cost field", async () => {
      const invoiced = await makeBooking(CUST_P);
      const full = await makeBooking(CUST_P);
      await generate([invoiced._id]);
      await generate([full._id]);
      const pending = await makeBooking(CUST_P);
      const noCost = await makeBooking(CUST_P, { actual: 0, quoted: 5000 });
      await makeBooking(CUST_P, { status: "CANCELLED" });
      const fullInv = await col("invoices").findOne({ bookingIds: full._id });
      // A full credit mirrors every invoice line, credited in full (routes/creditNotes.ts).
      const fullLines = ((fullInv as any).lineItems as any[]).map((l) => ({ ...l, originalAmount: l.amount, creditedAmount: l.amount }));
      await col("creditnotes").insertOne({ creditNoteNo: "CN-2", workspaceId: WS_P, originalInvoiceId: fullInv!._id, status: "ISSUED", isFullCredit: true, lineItems: fullLines } as any);

      const res = await get("/bookings");
      expect(res.status).toBe(200);
      const byRef = new Map(res.body.bookings.map((r: any) => [r.refNo, r]));
      expect(res.body.bookings).toHaveLength(4);
      expect((byRef.get((invoiced as any).bookingRef) as any).revenueEarned).toBe(200);
      expect((byRef.get((full as any).bookingRef) as any).revenueEarned).toBe(0);
      expect((byRef.get((pending as any).bookingRef) as any).revenueEarned).toBe("PENDING");
      expect((byRef.get((noCost as any).bookingRef) as any).revenueEarned).toBeNull();

      const row: any = byRef.get((invoiced as any).bookingRef);
      expect(row).toMatchObject({ grandTotal: 11_180, type: "FLIGHT", paxName: "Asha Rao", businessName: "Partner Co" });
      expect(row.invoiceNumber).toMatch(/^INV-/);
      for (const k of FORBIDDEN) expect(keysDeep(res.body).has(k)).toBe(false);
    });

    it('a credit on a real COMBINED-format line ("MB-1, MB-2", unequal totals) reduces each booking by its weight', async () => {
      const x = await makeBooking(CUST_P); // 11180 total, share 200
      const y = await makeBooking(CUST_P, { actual: 20_000, quoted: 22_360 }); // 22360 total, share 400
      const inv = await generate([x._id, y._id], "COMBINED");
      const lines = ((await col("invoices").findOne({ _id: inv._id })) as any).lineItems as any[];
      expect(lines).toHaveLength(2); // one combined COST line + one combined Transaction Fees line
      const fee = lines.find((l) => l.rowType === "SERVICE_FEE");
      expect(fee.amount).toBe(3540);
      expect(fee.bookingRef.split(",").map((r: string) => r.trim()).sort()).toEqual([(x as any).bookingRef, (y as any).bookingRef].sort());
      // Credit a quarter of the combined fee (885): x's portion 1180 (1/3) → 295
      // credited of 11180; y's portion 2360 (2/3) → 590 credited of 22360.
      await col("creditnotes").insertOne({
        creditNoteNo: "CN-3", workspaceId: WS_P, originalInvoiceId: inv._id, status: "ISSUED", isFullCredit: false,
        lineItems: [{ ...fee, originalAmount: fee.amount, creditedAmount: 885, amount: 885 }],
      } as any);
      const byRef = new Map((await get("/bookings")).body.bookings.map((r: any) => [r.refNo, r.revenueEarned]));
      expect(byRef.get((x as any).bookingRef)).toBe(194.72); // 200 × (1 − 295/11180)
      expect(byRef.get((y as any).bookingRef)).toBe(389.45); // 400 × (1 − 590/22360)
      expect((await get("/stats")).body.primary).toMatchObject({ totalBakedIn: 1460.42, totalShare: 584.17 });
    });

    it("CROSS-COMPANY: another company's credit note on the partner's invoice never reduces the share", async () => {
      const b = await makeBooking(CUST_P);
      const inv = await generate([b._id]);
      const lines = ((await col("invoices").findOne({ _id: inv._id })) as any).lineItems as any[];
      // Same invoice, same lines, fully credited — but filed under the other company.
      await col("creditnotes").insertOne({
        creditNoteNo: "CN-X", workspaceId: WS_N, originalInvoiceId: inv._id, status: "ISSUED", isFullCredit: true,
        lineItems: lines.map((l) => ({ ...l, originalAmount: l.amount, creditedAmount: l.amount })),
      } as any);
      expect((await get("/stats")).body.primary.totalShare).toBe(200);
      expect((await get("/bookings")).body.bookings[0].revenueEarned).toBe(200);
      // The same note under the partner's own Customer._id (the invoice-fallback form) does count.
      await col("creditnotes").updateOne({ creditNoteNo: "CN-X" }, { $set: { workspaceId: CUST_P } });
      expect((await get("/stats")).body.primary.totalShare).toBe(0);
    });

    it("CROSS-COMPANY: a combined line naming another company's booking weighs only the partner's own bookings", async () => {
      const x = await makeBooking(CUST_P); // 11180 total, share 200
      const z = await makeBooking(CUST_N); // another company, also 11180
      const inv = await generate([x._id]);
      const doc: any = await col("invoices").findOne({ _id: inv._id });
      const fee = doc.lineItems.find((l: any) => l.rowType === "SERVICE_FEE");
      // Staff typed z's ref onto x's fee line (invoice PATCH accepts free-text refs).
      const combinedRef = `${(x as any).bookingRef}, ${(z as any).bookingRef}`;
      await col("invoices").updateOne({ _id: inv._id, "lineItems.rowType": "SERVICE_FEE" }, { $set: { "lineItems.$.bookingRef": combinedRef } });
      await col("creditnotes").insertOne({
        creditNoteNo: "CN-Y", workspaceId: WS_P, originalInvoiceId: inv._id, status: "ISSUED", isFullCredit: false,
        lineItems: [{ ...fee, bookingRef: combinedRef, originalAmount: fee.amount, creditedAmount: 590, amount: 590 }],
      } as any);
      // z's total is not read, so x carries the whole line: 590 of 11180 credited.
      // (Reading z's 11180 would halve x's portion: 200 × (1 − 295/10590) = 194.43.)
      expect((await get("/bookings")).body.bookings.find((r: any) => r.refNo === (x as any).bookingRef).revenueEarned).toBe(189.45);
    });

    it("CROSS-COMPANY: a booking whose invoiceId points at another company's invoice shows no invoice and earns 0", async () => {
      const other = await makeBooking(CUST_N);
      const otherInv: any = await generate([other._id]);
      const b = await makeBooking(CUST_P);
      await col("manualbookings").updateOne({ _id: b._id }, {
        $set: { status: "INVOICED", invoiceId: otherInv._id, partnerShare: { visiblePct: 50, sharePct: 40, configVersion: 1, marginBase: 1000, bakedIn: 500, share: 200, at: new Date() } },
      });
      const res = await get("/bookings");
      const row = res.body.bookings.find((r: any) => r.refNo === (b as any).bookingRef);
      expect(row.revenueEarned).toBe(0);
      expect(JSON.stringify(res.body)).not.toContain(otherInv.invoiceNo);
      expect((await get("/stats")).body.primary.totalShare).toBe(0);
    });

    it("a snapshot on an invoice cancelled WITHOUT unlinking earns nothing", async () => {
      const b = await makeBooking(CUST_P);
      const inv = await generate([b._id]);
      // The route that used to do this is closed on main (the invoice state
      // machine refuses status → CANCELLED outside POST /:id/cancel)…
      const put = await request(app).put(`/api/admin/invoices/${inv._id}/status`).set("x-test-user", SA).set("x-test-ws", String(WS_P)).send({ status: "CANCELLED" });
      expect(put.status).toBe(400);
      // …but invoices cancelled that way before the fix still exist: the booking
      // stays INVOICED, linked, with its snapshot. Recreate that row directly.
      await col("invoices").updateOne({ _id: inv._id }, { $set: { status: "CANCELLED" } });
      expect((await fresh(b._id))).toMatchObject({ status: "INVOICED", partnerShare: expect.any(Object) });
      const res = await get("/stats");
      expect(res.body.primary.totalShare).toBe(0);
      const rows = (await get("/bookings")).body.bookings;
      expect(rows[0].revenueEarned).toBe(0);
    });
  });
});

/* ───────────────────────── backfill ───────────────────────── */

describe("backfill — POST /api/admin/partner-revenue/:workspaceId/backfill", () => {
  const backfill = (body: Record<string, unknown>, as = SA, ws: any = WS_P) =>
    request(app).post(`/api/admin/partner-revenue/${ws}/backfill`).set("x-test-user", as).set("x-test-ws", String(WS_P)).send(body);
  const backfillLog = () => col("partnerrevenuechanges").find({ action: "BACKFILL" }).toArray();

  /** Two bookings invoiced while the client was NOT a partner (so no snapshot), then the config is enabled. */
  async function invoicedBeforePartner() {
    const a = await makeBooking(CUST_P);
    const b = await makeBooking(CUST_P);
    await generate([a._id, b._id]);
    expect((await fresh(a._id)).partnerShare).toBeUndefined();
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "Signed" });
    return { a, b };
  }

  it("is SUPERADMIN only", async () => {
    await invoicedBeforePartner();
    expect((await backfill({ fromDate: "2020-01-01" }, WL)).status).toBe(403);
  });

  it("refuses a company with NO partner config (400), and a bad fromDate / dryRun", async () => {
    const none = await backfill({ fromDate: "2020-01-01" });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/not set up as a partner/);
    expect((await backfill({ fromDate: "2020-01-01", dryRun: false, reason: "r" })).status).toBe(400);
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "on" });
    expect((await backfill({ fromDate: "01/01/2020" })).status).toBe(400);
    expect((await backfill({})).status).toBe(400);
    expect((await backfill({ fromDate: "2020-01-01", dryRun: "no" })).status).toBe(400);
  });

  it("works on a PAUSED partner — dry run and apply — while live invoicing still snapshots nothing", async () => {
    // Post-deploy order: add (paused) → dry run → compare → apply → switch
    // earning on → enable the view in Workspace Manager.
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, enabled: false, reason: "added paused for checking" });
    const a = await makeBooking(CUST_P);
    const b = await makeBooking(CUST_P);
    await generate([a._id, b._id]);
    // Paused: the live path at invoicing writes nothing…
    expect((await fresh(a._id)).partnerShare).toBeUndefined();

    // …but the dry run sees both bookings with the paused terms, and writes nothing.
    const dry = await backfill({ fromDate: "2020-01-01" });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, count: 2, totalBakedIn: 1000, totalShare: 400, partnerEnabled: false });
    expect(dry.body.skipped).toEqual({ noCost: 0, cancelledOrMissingInvoice: 0 });
    expect((await fresh(a._id)).partnerShare).toBeUndefined();

    const apply = await backfill({ fromDate: "2020-01-01", dryRun: false, reason: "matches the manual sheet" });
    expect(apply.status).toBe(200);
    expect(apply.body).toMatchObject({ dryRun: false, count: 2, totalShare: 400, partnerEnabled: false });
    for (const id of [a._id, b._id]) {
      expect((await fresh(id)).partnerShare).toMatchObject({ visiblePct: 50, sharePct: 40, bakedIn: 500, share: 200, configVersion: 1 });
    }
    const log = await backfillLog();
    expect(log).toHaveLength(1);
    expect(log[0].after).toMatchObject({ count: 2, totalShare: 400, partnerEnabled: false });

    // Switching earning on does not open the partner's view — Workspace Manager does.
    expect((await request(app).get("/api/my-bookings/revenue/stats").set("x-test-user", WL).set("x-test-ws", String(WS_P))).status).toBe(403);
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, enabled: true, reason: "switched on" });
    expect((await request(app).get("/api/my-bookings/revenue/stats").set("x-test-user", WL).set("x-test-ws", String(WS_P))).status).toBe(403);
    await setView(WS_P, true);
    const stats = await request(app).get("/api/my-bookings/revenue/stats").set("x-test-user", WL).set("x-test-ws", String(WS_P));
    expect(stats.status).toBe(200);
    expect(stats.body.primary.totalShare).toBe(400);
  }, 30_000);

  it("dry run (the default) reports count, totals and rows — and writes nothing", async () => {
    const { a, b } = await invoicedBeforePartner();
    const res = await backfill({ fromDate: "2020-01-01" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, count: 2, totalBakedIn: 1000, totalShare: 400, visiblePct: 50, sharePct: 40, configVersion: 1 });
    expect(res.body.rows.map((r: any) => r.bookingRef).sort()).toEqual([(a as any).bookingRef, (b as any).bookingRef].sort());
    expect(res.body.rows[0]).toMatchObject({ marginBase: 1000, bakedIn: 500, share: 200 });
    expect((await fresh(a._id)).partnerShare).toBeUndefined();
    expect((await fresh(b._id)).partnerShare).toBeUndefined();
    expect(await backfillLog()).toHaveLength(0);
  });

  it("apply needs a reason, writes the snapshots, logs one BACKFILL entry; a re-run is a no-op", async () => {
    const { a, b } = await invoicedBeforePartner();
    expect((await backfill({ fromDate: "2020-01-01", dryRun: false })).status).toBe(400);
    expect((await fresh(a._id)).partnerShare).toBeUndefined();

    const res = await backfill({ fromDate: "2020-01-01", dryRun: false, reason: "Partner since July" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, count: 2, totalBakedIn: 1000, totalShare: 400 });
    for (const id of [a._id, b._id]) {
      expect((await fresh(id)).partnerShare).toMatchObject({ visiblePct: 50, sharePct: 40, configVersion: 1, marginBase: 1000, bakedIn: 500, share: 200 });
    }
    const log = await backfillLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      workspaceId: WS_P, reason: "Partner since July", actorId: String(SA_ID),
      after: { fromDate: "2020-01-01", count: 2, totalBakedIn: 1000, totalShare: 400, configVersion: 1 },
    });

    const again = await backfill({ fromDate: "2020-01-01", dryRun: false, reason: "again" });
    expect(again.body).toMatchObject({ count: 0, totalShare: 0 });
    expect(await backfillLog()).toHaveLength(1);
    expect((await backfill({ fromDate: "2020-01-01" })).body.count).toBe(0);
  });

  it("never overwrites an existing snapshot, even under a newer config", async () => {
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "v1" });
    const live = await makeBooking(CUST_P);
    await generate([live._id]); // snapshotted live under v1
    await putConfig(WS_P, { visiblePct: 100, sharePct: 100, reason: "v2" });
    const res = await backfill({ fromDate: "2020-01-01", dryRun: false, reason: "r" });
    expect(res.body.count).toBe(0);
    expect((await fresh(live._id)).partnerShare).toMatchObject({ configVersion: 1, share: 200 });
  });

  it("skips cancelled invoices, cost-0 bookings, uninvoiced and cancelled bookings, and bookings before fromDate", async () => {
    // An invoice cancelled before main's lifecycle fix by a status change —
    // bookings stay INVOICED and linked. Recreated directly (the route is closed now).
    const onCancelled = await makeBooking(CUST_P);
    const cancelledInv = await generate([onCancelled._id]);
    await col("invoices").updateOne({ _id: cancelledInv._id }, { $set: { status: "CANCELLED" } });
    expect((await fresh(onCancelled._id)).status).toBe("INVOICED");

    const noCost = await makeBooking(CUST_P, { actual: 0, quoted: 1180 });
    await generate([noCost._id]);
    const old = await makeBooking(CUST_P);
    await generate([old._id]);
    await col("manualbookings").updateOne({ _id: old._id }, { $set: { bookingDate: new Date("2026-01-15T06:00:00Z") } });
    await makeBooking(CUST_P); // CONFIRMED, never invoiced
    await makeBooking(CUST_P, { status: "CANCELLED" });
    const good = await makeBooking(CUST_P);
    await generate([good._id]);
    // The non-partner's invoiced booking must never be swept in.
    const other = await makeBooking(CUST_N);
    await generate([other._id]);

    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "on" });
    const res = await backfill({ fromDate: "2026-02-01", dryRun: false, reason: "r" });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: any) => r.bookingRef)).toEqual([(good as any).bookingRef]);
    expect(res.body.skipped).toEqual({ noCost: 1, cancelledOrMissingInvoice: 1 });
    for (const id of [onCancelled._id, noCost._id, old._id, other._id]) expect((await fresh(id)).partnerShare).toBeUndefined();
    expect((await fresh(good._id)).partnerShare).toMatchObject({ share: 200 });
  }, 30_000); // six real invoice generations — the 5 s default is too tight on a loaded machine
});

/* ───────────────────────── export + the flag reaching the frontend ───────────────────────── */

describe("partner export — GET /api/my-bookings/revenue/bookings/export", () => {
  const exportReq = (q: string, who = WL) =>
    request(app).get(`/api/my-bookings/revenue/bookings/export${q}`).set("x-test-user", who).set("x-test-ws", String(WS_P));
  // Words no partner-facing column may carry: cost, margin, the two percents.
  const LEAKY_HEADER = /cost|margin|actual|basePrice|base price|diff|markup|profit|visible|share ?%|percent|quoted/i;

  it("403 when the flag is off, and for a member without billing access", async () => {
    expect((await exportReq("?format=csv")).status).toBe(403);
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "r" });
    await setView(WS_P, true);
    expect((await exportReq("?format=csv", MEMBER)).status).toBe(403);
  });

  describe("with an enabled partner", () => {
    let refs: Record<string, string> = {};
    beforeEach(async () => {
      await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "r" });
      await setView(WS_P, true);
      const invoiced = await makeBooking(CUST_P);
      await generate([invoiced._id]);
      const pending = await makeBooking(CUST_P);
      const noCost = await makeBooking(CUST_P, { actual: 0, quoted: 5000 });
      await makeBooking(CUST_P, { status: "CANCELLED" });
      refs = { invoiced: (invoiced as any).bookingRef, pending: (pending as any).bookingRef, noCost: (noCost as any).bookingRef };
    });

    it("CSV: Revenue Earned right after Grand Total; amount / Pending / blank; no cost, margin or percent anywhere", async () => {
      const res = await exportReq("?format=csv");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      const lines = String(res.text).trim().split(/\r?\n/);
      const header = lines[0].split(",");
      const gt = header.indexOf("Grand Total");
      expect(gt).toBeGreaterThan(0);
      expect(header[gt + 1]).toBe("Revenue Earned");
      for (const h of header) expect(h).not.toMatch(LEAKY_HEADER);
      expect(lines).toHaveLength(4); // header + 3 (the cancelled booking is excluded)

      const refCol = header.indexOf("Ref No.");
      const rows = new Map(lines.slice(1).map((l) => { const c = l.split(","); return [c[refCol], c]; }));
      expect(rows.get(refs.invoiced)![gt]).toBe("11180");
      expect(rows.get(refs.invoiced)![gt + 1]).toBe("200");
      expect(rows.get(refs.pending)![gt + 1]).toBe("Pending");
      expect(rows.get(refs.noCost)![gt + 1]).toBe("");
      // The cost (10000), margin (1000), baked-in (500) and the percents never appear as a value.
      for (const cells of rows.values()) for (const v of ["10000", "1000", "500", "50", "40", "0.5", "0.4"]) expect(cells).not.toContain(v);
    });

    it("XLSX: same columns and values", async () => {
      const res = await exportReq("?format=xlsx").buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/spreadsheetml/);
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as any);
      const ws = wb.getWorksheet("Partner Bookings")!;
      const header = (ws.getRow(1).values as any[]).slice(1).map(String);
      const gt = header.indexOf("Grand Total");
      expect(header[gt + 1]).toBe("Revenue Earned");
      for (const h of header) expect(h).not.toMatch(LEAKY_HEADER);
      const refCol = header.indexOf("Ref No.");
      const byRef = new Map<string, any[]>();
      ws.eachRow((row, n) => { if (n > 1) { const v = (row.values as any[]).slice(1); byRef.set(String(v[refCol]), v); } });
      expect(byRef.size).toBe(3);
      expect(byRef.get(refs.invoiced)![gt + 1]).toBe(200);
      expect(byRef.get(refs.pending)![gt + 1]).toBe("Pending");
    });
  });
});

describe("GET /api/v1/workspace/config carries revenueShareEnabled", () => {
  const cfg = () =>
    request(app).get("/api/v1/workspace/config").set("x-test-user", user(WL_ID, ["WORKSPACE_LEADER"], { customerId: String(CUST_P) }));

  it("for a workspace without config.travelFlow (the legacy-derived path) — a partner config alone leaves it off; Workspace Manager turns it on and off", async () => {
    const before = await cfg();
    expect(before.status).toBe(200);
    expect(before.body.config.features.revenueShareEnabled).toBe(false);
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "r" });
    expect((await cfg()).body.config.features.revenueShareEnabled).toBe(false);
    await setView(WS_P, true);
    expect((await cfg()).body.config.features.revenueShareEnabled).toBe(true);
    await setView(WS_P, false);
    expect((await cfg()).body.config.features.revenueShareEnabled).toBe(false);
  });

  it("for a workspace with config.travelFlow", async () => {
    await col("customerworkspaces").updateOne({ _id: WS_P }, { $set: { "config.travelFlow": "APPROVAL_FLOW" } });
    await setView(WS_P, true);
    expect((await cfg()).body.config.features.revenueShareEnabled).toBe(true);
  });
});

describe("partnerCasesEnabled — Workspace Manager's Partner Cases toggle", () => {
  const cfg = () =>
    request(app).get("/api/v1/workspace/config").set("x-test-user", user(WL_ID, ["WORKSPACE_LEADER"], { customerId: String(CUST_P) }));
  const toggle = (enabled: boolean) =>
    request(app).put(`/api/superadmin/workspaces/${WS_P}/features`).set("x-test-user", SA).send({ feature: "partnerCasesEnabled", enabled });
  const stored = async () => ((await col("customerworkspaces").findOne({ _id: WS_P })) as any).config.features.partnerCasesEnabled;

  it("is off by default, saved by the toggle, and returned by the workspace config (legacy and travelFlow workspaces)", async () => {
    expect((await cfg()).body.config.features.partnerCasesEnabled).toBeFalsy();
    expect((await toggle(true)).status).toBe(200);
    expect(await stored()).toBe(true);
    expect((await cfg()).body.config.features.partnerCasesEnabled).toBe(true);
    await col("customerworkspaces").updateOne({ _id: WS_P }, { $set: { "config.travelFlow": "APPROVAL_FLOW" } });
    expect((await cfg()).body.config.features.partnerCasesEnabled).toBe(true);
    expect((await toggle(false)).status).toBe(200);
    expect(await stored()).toBe(false);
    expect((await cfg()).body.config.features.partnerCasesEnabled).toBe(false);
  });
});

/* ───────────────────────── a failed post-commit snapshot is repaired by the backfill ───────────────────────── */

describe("snapshot failure after the invoicing commit", () => {
  beforeEach(async () => {
    await putConfig(WS_P, { visiblePct: 50, sharePct: 40, reason: "r" });
  });

  /** Make the next snapshot attempt fail the way a database blip would. */
  function failNextSnapshot() {
    const find = vi.spyOn(PartnerRevenueConfig, "find").mockImplementationOnce(() => {
      throw new Error("db blip");
    });
    const warn = vi.spyOn(logger, "warn");
    return { restore: () => { find.mockRestore(); warn.mockRestore(); }, warn };
  }

  it.each([
    ["invoice generation (claimBookingsForInvoice in createOneInvoice)", "generate"],
    ["POST /:id/add-bookings (claimBookingsForInvoice in the route)", "add"],
  ])("%s: the invoice stands, the booking is INVOICED with no snapshot, the log names the repair, and the backfill repairs it", async (_l, path) => {
    let target: any;
    let spy: ReturnType<typeof failNextSnapshot>;
    if (path === "generate") {
      target = await makeBooking(CUST_P);
      spy = failNextSnapshot();
      await generate([target._id]);
    } else {
      const first = await makeBooking(CUST_P);
      const inv = await generate([first._id]);
      target = await makeBooking(CUST_P);
      spy = failNextSnapshot();
      const res = await request(app).post(`/api/admin/invoices/${inv._id}/add-bookings`).set("x-test-user", SA).set("x-test-ws", String(WS_P)).send({ bookingIds: [String(target._id)] });
      expect(res.status).toBe(200);
    }
    try {
      const after = await fresh(target._id);
      expect(after.status).toBe("INVOICED");
      expect(after.invoiceId).toBeTruthy();
      expect(after.partnerShare).toBeUndefined();
      expect(spy.warn).toHaveBeenCalledWith(
        `[partner-revenue] partnerShare snapshot failed for ${target.bookingRef} — run backfill for this workspace to repair`,
        expect.objectContaining({ bookingRef: target.bookingRef, customerId: String(CUST_P), err: "db blip" }),
      );
    } finally {
      spy.restore();
    }

    const dry = await request(app).post(`/api/admin/partner-revenue/${WS_P}/backfill`).set("x-test-user", SA).set("x-test-ws", String(WS_P)).send({ fromDate: "2020-01-01" });
    expect(dry.body.rows.map((r: any) => r.bookingRef)).toContain(target.bookingRef);
    const apply = await request(app).post(`/api/admin/partner-revenue/${WS_P}/backfill`).set("x-test-user", SA).set("x-test-ws", String(WS_P))
      .send({ fromDate: "2020-01-01", dryRun: false, reason: "repair after snapshot failure" });
    expect(apply.status).toBe(200);
    expect((await fresh(target._id)).partnerShare).toMatchObject({ bakedIn: 500, share: 200 });
  }, 30_000);
});
