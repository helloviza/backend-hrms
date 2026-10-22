// apps/backend/src/routes/myRewards.test.ts
//
// Loyalty Points — Phase 2 (client view + per-workspace switch):
//   1. the loyaltyRewardsEnabled switch: off → every /api/my-rewards route refuses;
//      on → served (visibility only — earning is unchanged either way)
//   2. the access rule (middleware/requireInvoiceAccess.ts): leader and
//      billing user see it, a plain traveller does not
//   3. cross-tenant: scoped to the caller's own account only — a linked
//      account is visible to its members and to nobody else
//   4. summary maths per state (before start, not enrolled, locked, eligible)
//   5. pending invoices list ON_THE_WAY only (overdue, valid until, canOpen)
//   6. history: client labels, no internal fields
//   7. the unlock email: once when the switch is on, never when off (not even
//      after it is switched on later), never twice; recipients follow the rule
//
// Real: myRewards router, requireFeature, requireInvoiceAccess, the loyalty
//   engine + client service + unlock email service, models, an in-memory
//   REPLICA SET (the engine writes in transactions).
// Stubbed: requireAuth (x-test-user), requireWorkspace (x-test-ws → the real
//   CustomerWorkspace row), enqueueEmail (captured).
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
vi.mock("../middleware/requireWorkspace.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  const requireWorkspace = async (req: any, _res: any, next: any) => {
    const m = require("mongoose");
    const id = String(req.headers["x-test-ws"] || "");
    const ws = await m.connection.collection("customerworkspaces").findOne({ _id: new m.Types.ObjectId(id) });
    req.workspace = ws;
    req.workspaceObjectId = ws?._id;
    req.workspaceId = id;
    next();
  };
  return { ...actual, requireWorkspace, default: requireWorkspace };
});
vi.mock("../services/emailOutbox.js", () => ({
  enqueueEmail: vi.fn(async () => ({ ok: true, id: "x", status: "SENT" })),
}));

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature } = await import("../middleware/requireFeature.js");
const { requireInvoiceAccess } = await import("../middleware/requireInvoiceAccess.js");
const { default: myRewardsRouter } = await import("./myRewards.js");
const { enqueueEmail } = await import("../services/emailOutbox.js");
const { default: LoyaltyAccount } = await import("../models/LoyaltyAccount.js");
const { default: LoyaltyLedger } = await import("../models/LoyaltyLedger.js");
const { default: LoyaltySettings } = await import("../models/LoyaltySettings.js");
const L = await import("../services/loyalty.js");
const { notifyLoyaltyUnlock, UNLOCK_SUBJECT } = await import("../services/loyaltyUnlockEmail.js");
const { historyLabel, addMonths } = await import("../services/loyaltyClient.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = "69679a7628330a58d29f2254";
const DAY = 86_400_000;

const app = express();
app.use(express.json());
app.use("/api/my-rewards", requireAuth, requireWorkspace, requireFeature("loyaltyRewardsEnabled"), requireInvoiceAccess, myRewardsRouter);

// Three client companies. A and B are linked into one account; C stands alone.
const CUST_A = oid(); const WS_A = oid();
const CUST_B = oid(); const WS_B = oid();
const CUST_C = oid(); const WS_C = oid();
const HOUSE_CUST = oid();

const mkUser = (roles: string[], extra: Record<string, unknown> = {}) => {
  const id = oid();
  return { doc: { _id: id, email: `${String(id).slice(-6)}@client.test`, roles, status: "ACTIVE", ...extra }, token: { _id: String(id), id: String(id), sub: String(id), roles } };
};
const LEADER_A = mkUser(["WORKSPACE_LEADER"], { workspaceId: WS_A, customerId: String(CUST_A) });
const BILLING_A = mkUser(["EMPLOYEE"], { workspaceId: WS_A, customerId: String(CUST_A), canViewBilling: true });
const TRAVELLER_A = mkUser(["EMPLOYEE"], { workspaceId: WS_A, customerId: String(CUST_A), canViewBilling: false });
const INACTIVE_A = mkUser(["EMPLOYEE"], { workspaceId: WS_A, customerId: String(CUST_A), canViewBilling: true, status: "INACTIVE" });
const STAFF_A = mkUser(["ADMIN"], { workspaceId: WS_A, customerId: String(CUST_A), canViewBilling: true });
const BILLING_B = mkUser(["EMPLOYEE"], { workspaceId: WS_B, customerId: String(CUST_B), canViewBilling: true });
const BILLING_C = mkUser(["EMPLOYEE"], { workspaceId: WS_C, customerId: String(CUST_C), canViewBilling: true });

const get = (u: { token: any }, ws: mongoose.Types.ObjectId, path: string) =>
  request(app).get(`/api/my-rewards${path}`).set("x-test-user", JSON.stringify(u.token)).set("x-test-ws", String(ws));

async function setSwitch(ws: mongoose.Types.ObjectId, on: boolean) {
  await col("customerworkspaces").updateOne({ _id: ws }, { $set: { "config.features.loyaltyRewardsEnabled": on } });
}

async function setSettings(x: { launchDate: Date; thresholdInr?: number }) {
  await L.getLoyaltySettings();
  await LoyaltySettings.updateOne({ key: "global" }, {
    $set: {
      launchDate: x.launchDate, thresholdInr: x.thresholdInr ?? 2_000_000,
      rateHistory: [{ pointsPer100: 1, effectiveFrom: x.launchDate, setBy: "test", reason: "test" }],
    },
  });
}

/** A raw invoice: base = grandTotal − totalGST. */
async function invoice(ws: mongoose.Types.ObjectId, status: string, base: number, extra: Record<string, unknown> = {}) {
  const _id = oid();
  const gst = Math.round(base * 0.18);
  const at = new Date(Date.now() - 10 * DAY);
  await col("invoices").insertOne({
    _id, invoiceNo: `INV-${String(_id).slice(-6)}`, workspaceId: ws, status,
    subtotal: base, totalGST: gst, grandTotal: base + gst, invoiceDate: at, createdAt: at, generatedAt: at, ...extra,
  } as any);
  return _id;
}

async function accountOf(cust: mongoose.Types.ObjectId) {
  await L.loyaltyIdle();
  return LoyaltyAccount.findOne({ memberCustomerIds: String(cust) }).lean() as any;
}
async function reconcile(cust: mongoose.Types.ObjectId) {
  const a = await L.ensureAccountForCustomer(String(cust));
  const r = await L.reconcileAccount(a!._id);
  await L.loyaltyIdle();
  return r;
}

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("my-rewards-test"));
  await Promise.all([LoyaltyAccount.syncIndexes(), LoyaltyLedger.syncIndexes(), LoyaltySettings.syncIndexes()]);
}, 120_000);
afterAll(async () => { await L.loyaltyIdle(); await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  await L.loyaltyIdle();
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  L.__resetLoyaltyCaches();
  vi.mocked(enqueueEmail).mockClear();
  const gst = (n: string) => ({ gstNumber: n, gstStatus: "REGISTERED" });
  await col("customers").insertMany([
    { _id: CUST_A, legalName: "Alpha Pvt Ltd", ...gst("29AAACA1234A1Z5") },
    { _id: CUST_B, legalName: "Alpha Exports LLP", ...gst("27AAACA1234A1Z1") },
    { _id: CUST_C, legalName: "Charlie Ltd", ...gst("07AAACC9999C1Z9") },
    { _id: HOUSE_CUST, legalName: "Plumtrips" },
  ] as any);
  const ws = (_id: mongoose.Types.ObjectId, customerId: mongoose.Types.ObjectId, name: string, on: boolean) =>
    ({ _id, customerId: String(customerId), companyName: name, status: "ACTIVE", config: { features: { loyaltyRewardsEnabled: on } } });
  await col("customerworkspaces").insertMany([
    ws(WS_A, CUST_A, "Alpha", true), ws(WS_B, CUST_B, "Alpha Exports", true), ws(WS_C, CUST_C, "Charlie", true),
    ws(oid(HOUSE), HOUSE_CUST, "Plumtrips", false),
  ] as any);
  await col("users").insertMany([LEADER_A, BILLING_A, TRAVELLER_A, INACTIVE_A, STAFF_A, BILLING_B, BILLING_C].map((u) => u.doc) as any);
  await col("customermembers").insertOne({ customerId: String(CUST_A), email: "lead.member@client.test", role: "WORKSPACE_LEADER", isActive: true } as any);
  await setSettings({ launchDate: new Date(Date.now() - 365 * DAY) });
});

/* ───────────────────────── 1. the switch ───────────────────────── */

describe("the loyaltyRewardsEnabled switch", () => {
  it("off → every route is refused; on → served", async () => {
    await setSwitch(WS_A, false);
    for (const p of ["/summary", "/pending-invoices", "/history"]) {
      const r = await get(LEADER_A, WS_A, p);
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).toContain("loyaltyRewardsEnabled");
    }
    await setSwitch(WS_A, true);
    for (const p of ["/summary", "/pending-invoices", "/history"]) expect((await get(LEADER_A, WS_A, p)).status).toBe(200);
  });

  it("is visibility only: points are earned with the switch off", async () => {
    await setSwitch(WS_A, false);
    await invoice(WS_A, "SENT", 10_000);
    await reconcile(CUST_A);
    expect((await accountOf(CUST_A)).balances.onTheWay).toBe(100);
  });

  it("defaults to off on a new workspace", async () => {
    const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
    const doc: any = new CustomerWorkspace({ customerId: String(oid()) });
    expect(doc.config.features.loyaltyRewardsEnabled).toBe(false);
  });
});

/* ───────────────────────── 2. access rule ───────────────────────── */

describe("access follows the client invoice pages' rule", () => {
  it("leader and billing user see it; a plain traveller does not", async () => {
    expect((await get(LEADER_A, WS_A, "/summary")).status).toBe(200);
    expect((await get(BILLING_A, WS_A, "/summary")).status).toBe(200);
    const t = await get(TRAVELLER_A, WS_A, "/summary");
    expect(t.status).toBe(403);
    expect(t.body.code).toBe("BILLING_ACCESS_DENIED");
    expect((await get(TRAVELLER_A, WS_A, "/history")).status).toBe(403);
  });
});

/* ───────────────────────── 3. cross-tenant ───────────────────────── */

describe("cross-tenant scoping", () => {
  beforeEach(async () => {
    // A + B pooled into one account; C on its own.
    await invoice(WS_A, "SENT", 100_000);
    await invoice(WS_B, "SENT", 50_000);
    await invoice(WS_C, "SENT", 70_000);
    await reconcile(CUST_A); await reconcile(CUST_B); await reconcile(CUST_C);
    const a = await accountOf(CUST_A);
    await L.linkCustomer(String(a._id), String(CUST_B), "staff");
    await L.loyaltyIdle();
  });

  it("a member sees the whole linked account, named", async () => {
    const r = await get(BILLING_B, WS_B, "/summary");
    expect(r.status).toBe(200);
    expect(r.body.balances.onTheWay).toBe(1500);
    expect(r.body.linkedEntities.map((e: any) => e.name).sort()).toEqual(["Alpha Exports LLP", "Alpha Pvt Ltd"]);
    expect(r.body.linkedEntities.find((e: any) => e.isYou).name).toBe("Alpha Exports LLP");
    const p = await get(BILLING_B, WS_B, "/pending-invoices");
    expect(p.body.invoices).toHaveLength(2);
    // B can open its own invoice in the portal, not A's.
    expect(p.body.invoices.filter((i: any) => i.canOpen)).toHaveLength(1);
  });

  it("a non-member never sees the linked account — only its own", async () => {
    const r = await get(BILLING_C, WS_C, "/summary");
    expect(r.body.balances.onTheWay).toBe(700);
    expect(r.body.linkedEntities.map((e: any) => e.name)).toEqual(["Charlie Ltd"]);
    const p = await get(BILLING_C, WS_C, "/pending-invoices");
    expect(p.body.invoices).toHaveLength(1);
    const h = await get(BILLING_C, WS_C, "/history");
    expect(JSON.stringify(h.body)).not.toMatch(/Alpha/);
    expect(h.body.events.every((e: any) => e.points === 700)).toBe(true);
  });

  it("a billing user presenting another company's workspace is refused", async () => {
    expect((await get(BILLING_C, WS_A, "/summary")).status).toBe(403);
    expect((await get(BILLING_A, WS_C, "/pending-invoices")).status).toBe(403);
  });

  it("ignores any id passed in the query", async () => {
    const a = await accountOf(CUST_A);
    const r = await get(BILLING_C, WS_C, `/history?accountId=${a._id}&customerId=${CUST_A}`);
    expect(JSON.stringify(r.body)).not.toMatch(/Alpha/);
  });
});

/* ───────────────────────── 4. summary states ───────────────────────── */

describe("summary maths", () => {
  it("before the start date: started false, nothing earned, progress still counts", async () => {
    const start = new Date(Date.now() + 30 * DAY);
    await setSettings({ launchDate: start });
    await invoice(WS_C, "PAID", 300_000);
    await reconcile(CUST_C);
    const s = (await get(BILLING_C, WS_C, "/summary")).body;
    expect(s.programmeName).toBe("Plumtrips Rewards");
    expect(s.started).toBe(false);
    expect(new Date(s.startDate).getTime()).toBe(start.getTime());
    expect(s.balances).toEqual({ ready: 0, onTheWay: 0, locked: 0, total: 0 });
    expect(s.cumulativeInr).toBe(300_000);
    expect(s.remainingToThresholdInr).toBe(1_700_000);
    expect(s.eligible).toBe(false);
  });

  it("not enrolled: no GSTIN, or registered as UNREGISTERED", async () => {
    await col("customers").updateOne({ _id: CUST_C }, { $set: { gstNumber: "" } });
    let s = (await get(BILLING_C, WS_C, "/summary")).body;
    expect(s.enrolled).toBe(false);
    expect(s.notEnrolledReason).toBe("NO_GSTIN");
    await col("customers").updateOne({ _id: CUST_C }, { $set: { gstNumber: "07AAACC9999C1Z9", gstStatus: "UNREGISTERED" } });
    s = (await get(BILLING_C, WS_C, "/summary")).body;
    expect(s.notEnrolledReason).toBe("UNREGISTERED");
  });

  it("locked: paid points wait for the threshold; remaining = threshold − cumulative", async () => {
    await invoice(WS_C, "PAID", 250_000);
    await invoice(WS_C, "SENT", 50_000);
    await reconcile(CUST_C);
    const s = (await get(BILLING_C, WS_C, "/summary")).body;
    expect(s).toMatchObject({
      started: true, enrolled: true, notEnrolledReason: null, eligible: false, eligibleAt: null,
      cumulativeInr: 300_000, thresholdInr: 2_000_000, remainingToThresholdInr: 1_700_000,
      redemptionOpen: false, usageCapPct: 25, minRedemption: 1000, pointsPer100: 1,
    });
    expect(s.balances).toEqual({ ready: 0, onTheWay: 500, locked: 2500, total: 3000 });
  });

  it("eligible: ready + on the way, cap from the account override", async () => {
    await invoice(WS_C, "PAID", 1_900_000);
    await invoice(WS_C, "SENT", 200_000);
    await reconcile(CUST_C);
    await LoyaltyAccount.updateOne({ memberCustomerIds: String(CUST_C) }, { $set: { capPctOverride: 40 } });
    const s = (await get(BILLING_C, WS_C, "/summary")).body;
    expect(s.eligible).toBe(true);
    expect(s.eligibleAt).toBeTruthy();
    expect(s.remainingToThresholdInr).toBe(0);
    expect(s.balances).toEqual({ ready: 19_000, onTheWay: 2000, locked: 0, total: 21_000 });
    expect(s.usageCapPct).toBe(40);
  });

  it("redemptionOpen follows the programme setting", async () => {
    expect((await get(BILLING_C, WS_C, "/summary")).body.redemptionOpen).toBe(false);
    await LoyaltySettings.updateOne({ key: "global" }, { $set: { redemptionOpen: true } });
    try {
      expect((await get(BILLING_C, WS_C, "/summary")).body.redemptionOpen).toBe(true);
    } finally {
      await LoyaltySettings.updateOne({ key: "global" }, { $set: { redemptionOpen: false } });
    }
  });

  it("a customer with no account yet reads as zeros and creates nothing", async () => {
    const s = (await get(BILLING_C, WS_C, "/summary")).body;
    expect(s.balances.total).toBe(0);
    expect(s.cumulativeInr).toBe(0);
    expect(await LoyaltyAccount.countDocuments({})).toBe(0);
  });
});

/* ───────────────────────── 5. pending invoices ───────────────────────── */

describe("pending invoices", () => {
  it("lists only invoices whose points are ON_THE_WAY, with due, overdue and valid-until", async () => {
    const overdue = await invoice(WS_C, "SENT", 10_000, { dueDate: new Date(Date.now() - 2 * DAY) });
    const notDue = await invoice(WS_C, "PAYMENT_DECLARED", 20_000, { dueDate: new Date(Date.now() + 5 * DAY) });
    await invoice(WS_C, "PAID", 30_000);
    await invoice(WS_C, "DRAFT", 40_000);
    await invoice(WS_C, "CANCELLED", 50_000);
    await reconcile(CUST_C);
    const rows = (await get(BILLING_C, WS_C, "/pending-invoices")).body.invoices;
    expect(rows.map((r: any) => r.invoiceId).sort()).toEqual([String(overdue), String(notDue)].sort());
    const o = rows.find((r: any) => r.invoiceId === String(overdue));
    expect(o).toMatchObject({ amountBeforeGstInr: 10_000, points: 100, status: "AWAITING_PAYMENT", overdue: true, canOpen: true });
    const n = rows.find((r: any) => r.invoiceId === String(notDue));
    expect(n).toMatchObject({ points: 200, status: "PAYMENT_BEING_CONFIRMED", overdue: false });
    const first: any = await LoyaltyLedger.findOne({ invoiceId: String(overdue) }).sort({ createdAt: 1 }).lean();
    expect(new Date(o.validUntil).getTime()).toBe(addMonths(new Date(first.createdAt), 24).getTime());
  });

  it("canOpen is false for an invoice keyed on the legacy Customer._id", async () => {
    await invoice(CUST_C, "SENT", 10_000);
    await reconcile(CUST_C);
    const rows = (await get(BILLING_C, WS_C, "/pending-invoices")).body.invoices;
    expect(rows).toHaveLength(1);
    expect(rows[0].canOpen).toBe(false);
  });
});

/* ───────────────────────── 6. history ───────────────────────── */

describe("history", () => {
  it("labels each event for the client and hides every internal field", async () => {
    const paid = await invoice(WS_C, "SENT", 10_000);
    const cancelled = await invoice(WS_C, "SENT", 20_000);
    const credited = await invoice(WS_C, "PAID", 30_000);
    await reconcile(CUST_C);
    await col("invoices").updateOne({ _id: paid }, { $set: { status: "PAID" } });
    await col("invoices").updateOne({ _id: cancelled }, { $set: { status: "CANCELLED" } });
    await col("creditnotes").insertOne({ _id: oid(), originalInvoiceId: credited, status: "ISSUED", grandTotal: 11_800, totalGST: 1800 } as any);
    await reconcile(CUST_C);
    const acct = await accountOf(CUST_C);
    await L.manualAdjust(String(acct._id), { points: 25, reason: "SECRET-STAFF-NOTE goodwill", idempotencyKey: "k1" }, "staff-user-42");
    await col("invoices").updateOne({ _id: paid }, { $set: { status: "SENT" } });
    await reconcile(CUST_C);

    const r = await get(BILLING_C, WS_C, "/history?limit=50");
    expect(r.status).toBe(200);
    const labels = r.body.events.map((e: any) => e.label);
    expect(labels).toEqual(expect.arrayContaining([
      "Earned", "Invoice paid", "Reversed (invoice cancelled or reverted)", "Reduced by credit note",
      "Adjustment by Plumtrips", "Moved back to on the way",
    ]));
    const reduced = r.body.events.find((e: any) => e.label === "Reduced by credit note");
    expect(reduced.points).toBe(-100);
    const moved = r.body.events.find((e: any) => e.label === "Moved back to on the way");
    expect(moved).toMatchObject({ points: 0, moved: 100, change: { onTheWay: 100, locked: -100, ready: 0 } });
    const text = JSON.stringify(r.body);
    // Keys as JSON keys (the labels themselves contain words like "note"), values as text.
    for (const hidden of ['"idempotencyKey"', '"createdBy"', '"snapshot"', '"note"', '"reason"', '"accountId"', '"customerId"', "SECRET-STAFF-NOTE", "staff-user-42", "acct:", "STATUS_CHANGE", "CREDIT_NOTE", "MANUAL"]) {
      expect(text).not.toContain(hidden);
    }
    // Newest first.
    const times = r.body.events.map((e: any) => new Date(e.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("pages", async () => {
    for (let i = 0; i < 5; i++) await invoice(WS_C, "SENT", 1000 * (i + 1));
    await reconcile(CUST_C);
    const p1 = (await get(BILLING_C, WS_C, "/history?page=1&limit=2")).body;
    const p3 = (await get(BILLING_C, WS_C, "/history?page=3&limit=2")).body;
    expect(p1).toMatchObject({ total: 5, page: 1, totalPages: 3 });
    expect(p1.events).toHaveLength(2);
    expect(p3.events).toHaveLength(1);
  });

  it("historyLabel reads the movement", () => {
    expect(historyLabel("EARN", { ready: 0, onTheWay: 100, locked: 0 })).toBe("Earned");
    expect(historyLabel("STATUS_CHANGE", { ready: 0, onTheWay: -100, locked: 100 })).toBe("Invoice paid");
    expect(historyLabel("STATUS_CHANGE", { ready: 0, onTheWay: 100, locked: -100 })).toBe("Moved back to on the way");
    expect(historyLabel("STATUS_CHANGE", { ready: 0, onTheWay: -100, locked: 0 })).toBe("Reversed (invoice cancelled or reverted)");
    expect(historyLabel("ELIGIBILITY_UNLOCK", { ready: 100, onTheWay: 0, locked: -100 })).toBe("Unlocked");
    expect(historyLabel("CREDIT_NOTE", { ready: -10, onTheWay: 0, locked: 0 })).toBe("Reduced by credit note");
    expect(historyLabel("MANUAL", { ready: 5, onTheWay: 0, locked: 0 })).toBe("Adjustment by Plumtrips");
    expect(historyLabel("ACCOUNT_LINK", { ready: 0, onTheWay: 50, locked: 0 })).toBe("Adjustment by Plumtrips");
  });
});

/* ───────────────────────── 7. unlock email ───────────────────────── */

describe("unlock email", () => {
  const settings = { thresholdInr: 2_000_000, validityMonths: 24 };
  const sentTo = () => vi.mocked(enqueueEmail).mock.calls.map((c: any) => c[0].to[0]).sort();

  it("is queued once, to the client users who pass the access rule, when the switch is on", async () => {
    await invoice(WS_A, "PAID", 2_100_000);
    await reconcile(CUST_A);
    expect(vi.mocked(enqueueEmail)).toHaveBeenCalled();
    const call: any = vi.mocked(enqueueEmail).mock.calls[0][0];
    expect(call.subject).toBe(UNLOCK_SUBJECT);
    expect(call.subject).toBe("You've unlocked your Plumtrips Rewards points");
    expect(call.html).toContain("21,000");
    expect(call.html).toContain("/profile/customer?tab=rewards");
    // Leader (User + CustomerMember) and billing user; not the traveller, the
    // INACTIVE billing user or the staff admin.
    expect(sentTo()).toEqual([LEADER_A.doc.email, BILLING_A.doc.email, "lead.member@client.test"].sort());
    const acct = await accountOf(CUST_A);
    expect(acct.unlockNotice).toMatchObject({ workspaceIds: [String(WS_A)], recipients: 3 });

    // Never twice: another reconcile, and direct repeat calls, send nothing.
    vi.mocked(enqueueEmail).mockClear();
    await invoice(WS_A, "PAID", 10_000);
    await reconcile(CUST_A);
    const again = await Promise.all([notifyLoyaltyUnlock(acct._id, settings), notifyLoyaltyUnlock(acct._id, settings)]);
    expect(again.every((r) => !r.claimed)).toBe(true);
    expect(vi.mocked(enqueueEmail)).not.toHaveBeenCalled();
  });

  it("is never sent when the switch is off — not then, and not after it is switched on", async () => {
    await setSwitch(WS_A, false);
    await invoice(WS_A, "PAID", 2_100_000);
    await reconcile(CUST_A);
    expect(vi.mocked(enqueueEmail)).not.toHaveBeenCalled();
    const acct = await accountOf(CUST_A);
    expect(acct.eligibleAt).toBeTruthy();
    expect(acct.unlockNotice).toMatchObject({ workspaceIds: [], recipients: 0 });

    await setSwitch(WS_A, true);
    await invoice(WS_A, "PAID", 10_000);
    await reconcile(CUST_A);
    await L.runLoyaltySweep({ runKey: "test-sweep" });
    await L.loyaltyIdle();
    expect((await notifyLoyaltyUnlock(acct._id, settings)).claimed).toBe(false);
    expect(vi.mocked(enqueueEmail)).not.toHaveBeenCalled();
  });

  it("goes to every switched-on member workspace of a linked account, one email per address", async () => {
    await invoice(WS_A, "SENT", 10_000);
    await invoice(WS_B, "SENT", 10_000);
    await reconcile(CUST_A); await reconcile(CUST_B);
    const a = await accountOf(CUST_A);
    await L.linkCustomer(String(a._id), String(CUST_B), "staff");
    await L.loyaltyIdle();
    vi.mocked(enqueueEmail).mockClear();
    await invoice(WS_B, "PAID", 2_100_000);
    await reconcile(CUST_B);
    expect(sentTo()).toEqual([LEADER_A.doc.email, BILLING_A.doc.email, "lead.member@client.test", BILLING_B.doc.email].sort());
    expect(new Set(sentTo()).size).toBe(sentTo().length);
  });
});
