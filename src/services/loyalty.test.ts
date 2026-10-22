// apps/backend/src/services/loyalty.test.ts
//
// Loyalty Points — Phase 1 engine (services/loyalty.ts): the PRD v1.1 earn
// rules, the reconciler's properties (idempotent, A→B→A, concurrency-safe,
// eligibility unlock), account linking, the touch that never throws, and the
// once-per-day sweep claim.
//
// Real: every model, the reconciler, an in-memory REPLICA SET (the ledger
//   insert + balance move are one transaction). Fixtures are raw inserts
//   shaped like prod rows (mixed workspaceId forms, no createdAt on some).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const L = await import("./loyalty.js");
const { default: LoyaltySettings } = await import("../models/LoyaltySettings.js");
const { default: LoyaltyAccount } = await import("../models/LoyaltyAccount.js");
const { default: LoyaltyLedger } = await import("../models/LoyaltyLedger.js");
const { default: LoyaltySweepRun } = await import("../models/LoyaltySweepRun.js");
const { default: logger } = await import("../utils/logger.js");

const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const HOUSE_CUST = oid();
const LAUNCH = new Date("2026-01-01T00:00:00+05:30");
const AFTER = new Date("2026-03-01T10:00:00+05:30");
const BEFORE = new Date("2025-12-15T10:00:00+05:30");

async function setSettings(p: Record<string, unknown>) {
  await L.getLoyaltySettings();
  await LoyaltySettings.updateOne({ key: "global" }, { $set: p });
}

async function customer(o: Record<string, unknown> = {}) {
  const _id = oid();
  await col("customers").insertOne({ _id, name: `Co ${String(_id).slice(-4)}`, gstNumber: "29AAACA1234A1Z5", gstStatus: "REGISTERED", ...o } as any);
  return _id;
}
async function workspace(customerId: mongoose.Types.ObjectId) {
  const _id = oid();
  await col("customerworkspaces").insertOne({ _id, customerId: String(customerId), companyName: "x" } as any);
  return _id;
}

let seq = 0;
async function invoice(workspaceId: unknown, status: string, o: { taxable?: number; gst?: number; invoiceDate?: Date; createdAt?: Date | null; isDemo?: boolean } = {}) {
  const _id = oid();
  const taxable = o.taxable ?? 10000;
  const gst = o.gst ?? 1800;
  seq += 1;
  await col("invoices").insertOne({
    _id, invoiceNo: `INV-L-${seq}`, workspaceId, status, isDemo: o.isDemo ?? false,
    subtotal: taxable, totalGST: gst, grandTotal: taxable + gst, lineItems: [],
    invoiceDate: o.invoiceDate ?? AFTER,
    ...(o.createdAt === null ? {} : { createdAt: o.createdAt ?? AFTER }),
  } as any);
  return _id;
}
async function creditNote(invoiceId: mongoose.Types.ObjectId, workspaceId: unknown, status: string, taxable: number, gst = +(taxable * 0.18).toFixed(2)) {
  const _id = oid();
  await col("creditnotes").insertOne({ _id, creditNoteNo: `CN-L-${String(_id).slice(-8)}`, workspaceId, originalInvoiceId: invoiceId, status, grandTotal: taxable + gst, totalGST: gst, subtotal: taxable } as any);
  return _id;
}
const setInvoice = (id: mongoose.Types.ObjectId, set: Record<string, unknown>) => col("invoices").updateOne({ _id: id }, { $set: set });
const setCn = (id: mongoose.Types.ObjectId, status: string) => col("creditnotes").updateOne({ _id: id }, { $set: { status } });

async function accountOf(customerId: mongoose.Types.ObjectId) {
  return (await L.ensureAccountForCustomer(String(customerId)))!;
}

/** Σ ledger points per bucket — for the whole account, or one invoice. */
async function holding(accountId: unknown, invoiceId?: unknown) {
  const rows: any[] = await LoyaltyLedger.find({ accountId: String(accountId), ...(invoiceId ? { invoiceId: String(invoiceId) } : {}) }).lean();
  const h = { ON_THE_WAY: 0, LOCKED: 0, READY: 0 } as Record<string, number>;
  for (const r of rows) h[r.bucket] += r.points;
  return h;
}

/** The cached balances must equal the ledger, always. */
async function expectCacheMatchesLedger(accountId: unknown) {
  const h = await holding(accountId);
  const a: any = await LoyaltyAccount.findById(accountId).lean();
  expect(a.balances).toEqual({ onTheWay: h.ON_THE_WAY, locked: h.LOCKED, ready: h.READY });
}

const rowCount = (accountId: unknown) => LoyaltyLedger.countDocuments({ accountId: String(accountId) });

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("loyalty-engine-test"));
  await Promise.all([LoyaltyAccount.syncIndexes(), LoyaltyLedger.syncIndexes(), LoyaltySweepRun.syncIndexes(), LoyaltySettings.syncIndexes()]);
}, 120_000);
afterAll(async () => { await L.loyaltyIdle(); await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  await L.loyaltyIdle();
  for (const c of ["customers", "customerworkspaces", "invoices", "creditnotes", "visaapplications", "loyaltysettings", "loyaltyaccounts", "loyaltyledgers", "loyaltysweepruns"]) {
    await col(c).deleteMany({});
  }
  L.__resetLoyaltyCaches();
  await col("customerworkspaces").insertOne({ _id: HOUSE, customerId: String(HOUSE_CUST), companyName: "Plumtrips" } as any);
  await setSettings({ launchDate: LAUNCH });
});

/* ───────────────────────────── pure rules ───────────────────────────── */

describe("earn base and points (pure)", () => {
  it("earn base = grandTotal − totalGST with no credit notes", () => {
    expect(L.earnBaseOf({ grandTotal: 11800, totalGST: 1800 }, [])).toEqual({ gross: 10000, credited: 0, base: 10000 });
  });
  it("subtracts the taxable value of each issued credit note", () => {
    const r = L.earnBaseOf({ grandTotal: 11800, totalGST: 1800 }, [{ grandTotal: 2360, totalGST: 360 }, { grandTotal: 1180, totalGST: 180 }]);
    expect(r).toEqual({ gross: 10000, credited: 3000, base: 7000 });
  });
  it("floors the earn base at 0 when credit notes exceed it", () => {
    expect(L.earnBaseOf({ grandTotal: 11800, totalGST: 1800 }, [{ grandTotal: 14160, totalGST: 2160 }]).base).toBe(0);
  });
  it("points = floor(base / 100)", () => {
    expect(L.pointsFor(10000, 1)).toBe(100);
    expect(L.pointsFor(10099.99, 1)).toBe(100);
    expect(L.pointsFor(99.99, 1)).toBe(0);
    expect(L.pointsFor(0, 1)).toBe(0);
    expect(L.pointsFor(-50, 1)).toBe(0);
    expect(L.pointsFor(1029, 2)).toBe(20);
  });
  it("enrolment: GSTIN on file and not UNREGISTERED", () => {
    const s = { enrolBusinessesOnly: true };
    expect(L.isEnrolled({ gstNumber: "29AAACA1234A1Z5", gstStatus: "REGISTERED" }, s)).toBe(true);
    expect(L.isEnrolled({ gstNumber: "29AAACA1234A1Z5" }, s)).toBe(true); // NOT_SET with a GSTIN
    expect(L.isEnrolled({ gstin: "29AAACA1234A1Z5", gstStatus: "NOT_SET" }, s)).toBe(true); // legacy field
    expect(L.isEnrolled({ gstNumber: "29AAACA1234A1Z5", gstStatus: "UNREGISTERED" }, s)).toBe(false);
    expect(L.isEnrolled({ gstNumber: "", gstStatus: "REGISTERED" }, s)).toBe(false);
    expect(L.isEnrolled(null, s)).toBe(false);
    expect(L.isEnrolled({ gstStatus: "UNREGISTERED" }, { enrolBusinessesOnly: false })).toBe(true);
  });
  it("buckets: SENT / PAYMENT_DECLARED on the way; PAID locked until eligible", () => {
    expect(L.bucketFor("SENT", false)).toBe("ON_THE_WAY");
    expect(L.bucketFor("PAYMENT_DECLARED", true)).toBe("ON_THE_WAY");
    expect(L.bucketFor("PAID", false)).toBe("LOCKED");
    expect(L.bucketFor("PAID", true)).toBe("READY");
  });
});

/* ───────────────────────────── reconcile ───────────────────────────── */

describe("reconcileAccount — earning and statuses", () => {
  it("a SENT invoice earns ON_THE_WAY; running twice writes nothing the second time", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "SENT");
    const a = await accountOf(c);
    const r1: any = await L.reconcileAccount(a._id);
    expect(r1.rowsWritten).toBe(1);
    expect(await holding(a._id, inv)).toEqual({ ON_THE_WAY: 100, LOCKED: 0, READY: 0 });
    const r2: any = await L.reconcileAccount(a._id);
    expect(r2.rowsWritten).toBe(0);
    expect(await rowCount(a._id)).toBe(1);
    const row: any = await LoyaltyLedger.findOne({ invoiceId: String(inv) }).lean();
    expect(row).toMatchObject({ reason: "EARN", invoiceNo: expect.stringMatching(/^INV-L-/), customerId: String(c), createdBy: "system" });
    await expectCacheMatchesLedger(a._id);
  });

  it("DRAFT and CANCELLED count as zero", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "DRAFT"); await invoice(ws, "CANCELLED");
    const a = await accountOf(c);
    const r: any = await L.reconcileAccount(a._id);
    expect(r.rowsWritten).toBe(0);
    expect(r.cumulativeInr).toBe(0);
  });

  it("PAID → SENT → PAID is fully recorded (A → B → A)", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "PAID");
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    expect(await holding(a._id, inv)).toEqual({ ON_THE_WAY: 0, LOCKED: 100, READY: 0 });

    await setInvoice(inv, { status: "SENT" });
    await L.reconcileAccount(a._id);
    expect(await holding(a._id, inv)).toEqual({ ON_THE_WAY: 100, LOCKED: 0, READY: 0 });

    await setInvoice(inv, { status: "PAID" });
    await L.reconcileAccount(a._id);
    expect(await holding(a._id, inv)).toEqual({ ON_THE_WAY: 0, LOCKED: 100, READY: 0 });

    const rows: any[] = await LoyaltyLedger.find({ invoiceId: String(inv) }).sort({ createdAt: 1, _id: 1 }).lean();
    expect(rows.map((r) => [r.bucket, r.points, r.reason])).toEqual([
      ["LOCKED", 100, "EARN"],
      ["ON_THE_WAY", 100, "STATUS_CHANGE"], ["LOCKED", -100, "STATUS_CHANGE"],
      ["ON_THE_WAY", -100, "STATUS_CHANGE"], ["LOCKED", 100, "STATUS_CHANGE"],
    ]);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(rows.length);
    await expectCacheMatchesLedger(a._id);
  });

  it("every status move: DRAFT → SENT → PAYMENT_DECLARED → PAID → SENT → DRAFT → SENT → CANCELLED", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "DRAFT");
    const a = await accountOf(c);
    const seen: Array<[string, Record<string, number>]> = [];
    for (const s of ["DRAFT", "SENT", "PAYMENT_DECLARED", "PAID", "SENT", "DRAFT", "SENT", "CANCELLED"]) {
      await setInvoice(inv, { status: s });
      await L.reconcileAccount(a._id);
      seen.push([s, await holding(a._id, inv)]);
    }
    expect(seen).toEqual([
      ["DRAFT", { ON_THE_WAY: 0, LOCKED: 0, READY: 0 }],
      ["SENT", { ON_THE_WAY: 100, LOCKED: 0, READY: 0 }],
      ["PAYMENT_DECLARED", { ON_THE_WAY: 100, LOCKED: 0, READY: 0 }],
      ["PAID", { ON_THE_WAY: 0, LOCKED: 100, READY: 0 }],
      ["SENT", { ON_THE_WAY: 100, LOCKED: 0, READY: 0 }],
      ["DRAFT", { ON_THE_WAY: 0, LOCKED: 0, READY: 0 }],
      ["SENT", { ON_THE_WAY: 100, LOCKED: 0, READY: 0 }],
      ["CANCELLED", { ON_THE_WAY: 0, LOCKED: 0, READY: 0 }],
    ]);
    await expectCacheMatchesLedger(a._id);
  });

  it("an amount change while DRAFT (re-edit) re-earns on the new value", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "SENT");
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    await setInvoice(inv, { status: "DRAFT" });
    await L.reconcileAccount(a._id);
    await setInvoice(inv, { status: "SENT", grandTotal: 29500, totalGST: 4500 });
    await L.reconcileAccount(a._id);
    expect(await holding(a._id, inv)).toEqual({ ON_THE_WAY: 250, LOCKED: 0, READY: 0 });
  });
});

describe("reconcileAccount — credit notes", () => {
  it("an ISSUED CN reduces points; DRAFT CNs are ignored; cancelling the CN restores them", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "PAID", { taxable: 10000 });
    await creditNote(inv, ws, "DRAFT", 9000);
    const cn = await creditNote(inv, ws, "ISSUED", 2550);
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    expect(await holding(a._id, inv)).toEqual({ ON_THE_WAY: 0, LOCKED: 74, READY: 0 }); // floor(7450/100)

    await setCn(cn, "CANCELLED");
    await L.reconcileAccount(a._id);
    expect(await holding(a._id, inv)).toEqual({ ON_THE_WAY: 0, LOCKED: 100, READY: 0 });
    const last: any = await LoyaltyLedger.findOne({ invoiceId: String(inv) }).sort({ createdAt: -1, _id: -1 }).lean();
    expect(last.reason).toBe("CREDIT_NOTE");
  });

  it("CNs larger than the invoice floor it at 0 (no negative points)", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "SENT", { taxable: 10000 });
    await creditNote(inv, ws, "ISSUED", 6000); await creditNote(inv, ws, "ISSUED", 6000);
    const a = await accountOf(c);
    const r: any = await L.reconcileAccount(a._id);
    expect(await holding(a._id, inv)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 0 });
    expect(r.cumulativeInr).toBe(0);
  });
});

describe("reconcileAccount — start date", () => {
  it("dated after start but CREATED before start → no points, but counts toward the ₹20L", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "PAID", { invoiceDate: AFTER, createdAt: BEFORE, taxable: 500000 });
    const a = await accountOf(c);
    const r: any = await L.reconcileAccount(a._id);
    expect(await holding(a._id, inv)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 0 });
    expect(r.cumulativeInr).toBe(500000);
  });

  it("created after start but DATED before start → no points, still counted", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "SENT", { invoiceDate: BEFORE, createdAt: AFTER, taxable: 30000 });
    const a = await accountOf(c);
    const r: any = await L.reconcileAccount(a._id);
    expect(r.rowsWritten).toBe(0);
    expect(r.cumulativeInr).toBe(30000);
  });

  it("an invoice with no createdAt falls back to its ObjectId time", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "SENT", { createdAt: null }); // _id minted now (after LAUNCH)
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, inv)).ON_THE_WAY).toBe(100);
  });

  it("the account's startDateOverride wins over the launch date (both conditions)", async () => {
    const c = await customer(); const ws = await workspace(c);
    const early = await invoice(ws, "SENT", { invoiceDate: BEFORE, createdAt: BEFORE });
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, early)).ON_THE_WAY).toBe(0);
    await LoyaltyAccount.updateOne({ _id: a._id }, { $set: { startDateOverride: new Date("2025-12-01T00:00:00+05:30") } });
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, early)).ON_THE_WAY).toBe(100);
  });
});

describe("reconcileAccount — eligibility", () => {
  it("crossing ₹20L moves every LOCKED point on paid invoices to READY; eligibleAt is sticky", async () => {
    const c = await customer(); const ws = await workspace(c);
    const paid = await invoice(ws, "PAID", { taxable: 1_500_000, gst: 270_000 });
    const sent = await invoice(ws, "SENT", { taxable: 400_000, gst: 72_000 });
    const a = await accountOf(c);
    const r1: any = await L.reconcileAccount(a._id);
    expect(r1.cumulativeInr).toBe(1_900_000);
    expect(r1.eligibleAt).toBeNull();
    expect(await holding(a._id, paid)).toEqual({ ON_THE_WAY: 0, LOCKED: 15000, READY: 0 });

    // A further ₹1L invoice is SENT: the account crosses ₹20L on cumulative business.
    await invoice(ws, "SENT", { taxable: 100_000, gst: 18_000 });
    const r2: any = await L.reconcileAccount(a._id);
    expect(r2.cumulativeInr).toBe(2_000_000);
    expect(r2.eligibleAt).toBeInstanceOf(Date);
    expect(await holding(a._id, paid)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 15000 });
    expect(await holding(a._id, sent)).toEqual({ ON_THE_WAY: 4000, LOCKED: 0, READY: 0 });
    const unlock: any[] = await LoyaltyLedger.find({ invoiceId: String(paid), reason: "ELIGIBILITY_UNLOCK" }).lean();
    expect(unlock.map((u) => [u.bucket, u.points]).sort()).toEqual([["LOCKED", -15000], ["READY", 15000]]);

    // Sticky: a credit note drops cumulative below ₹20L — eligibility and READY stay.
    await creditNote(sent, ws, "ISSUED", 200_000);
    const r3: any = await L.reconcileAccount(a._id);
    expect(r3.cumulativeInr).toBe(1_800_000);
    expect(new Date(r3.eligibleAt).getTime()).toBe(new Date(r2.eligibleAt).getTime());
    expect(await holding(a._id, paid)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 15000 });

    // Later paid invoices go straight to READY.
    await setInvoice(sent, { status: "PAID" });
    await L.reconcileAccount(a._id);
    expect(await holding(a._id, sent)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 2000 });
    await expectCacheMatchesLedger(a._id);
  });
});

describe("reconcileAccount — exclusions", () => {
  it("isDemo and D2C invoices count for nothing", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "PAID", { isDemo: true, taxable: 5_000_000 });
    const d2c = await invoice(ws, "PAID", { taxable: 5_000_000 });
    await col("visaapplications").insertOne({ _id: oid(), d2cInvoiceId: d2c } as any);
    const a = await accountOf(c);
    const r: any = await L.reconcileAccount(a._id);
    expect(r.rowsWritten).toBe(0);
    expect(r.cumulativeInr).toBe(0);
  });

  it("the HOUSE customer never gets an account; a touch on a HOUSE invoice creates nothing", async () => {
    const inv = await invoice(HOUSE, "PAID");
    expect(await L.ensureAccountForCustomer(String(HOUSE_CUST))).toBeNull();
    const r = await L.touchNow({ invoiceId: inv });
    expect(r).toEqual([]);
    expect(await LoyaltyAccount.countDocuments()).toBe(0);
  });

  it("an unregistered member earns nothing, but its business counts toward the account's ₹20L", async () => {
    const reg = await customer(); const unreg = await customer({ gstNumber: "", gstStatus: "UNREGISTERED" });
    const wsReg = await workspace(reg); const wsUnreg = await workspace(unreg);
    const regPaid = await invoice(wsReg, "PAID", { taxable: 100_000 });
    const unregPaid = await invoice(wsUnreg, "PAID", { taxable: 1_950_000 });
    const a = await accountOf(reg);
    await LoyaltyAccount.updateOne({ _id: a._id }, { $addToSet: { memberCustomerIds: String(unreg) } });
    const r: any = await L.reconcileAccount(a._id);
    expect(r.cumulativeInr).toBe(2_050_000);
    expect(r.eligibleAt).toBeInstanceOf(Date);
    expect(await holding(a._id, regPaid)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 1000 });
    expect(await holding(a._id, unregPaid)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 0 });
  });

  it("a GSTIN-less NOT_SET customer is not enrolled; enrolBusinessesOnly=false enrols it", async () => {
    const c = await customer({ gstNumber: "", gstStatus: undefined }); const ws = await workspace(c);
    const inv = await invoice(ws, "SENT");
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, inv)).ON_THE_WAY).toBe(0);
    await setSettings({ enrolBusinessesOnly: false });
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, inv)).ON_THE_WAY).toBe(100);
  });

  it("a disabled account earns nothing (holdings zeroed); re-enabling restores them", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "SENT");
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    await LoyaltyAccount.updateOne({ _id: a._id }, { $set: { enabled: false } });
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, inv)).ON_THE_WAY).toBe(0);
    await LoyaltyAccount.updateOne({ _id: a._id }, { $set: { enabled: true } });
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, inv)).ON_THE_WAY).toBe(100);
  });

  it("the programme kill switch freezes everything — no rows written", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "SENT");
    const a = await accountOf(c);
    await setSettings({ programmeEnabled: false });
    expect(await L.reconcileAccount(a._id)).toMatchObject({ skipped: "programme-disabled" });
    expect(await L.touchNow({ invoiceId: oid() })).toEqual([]);
    expect(await rowCount(a._id)).toBe(0);
  });
});

describe("company key — mixed workspaceId forms", () => {
  it("CustomerWorkspace._id, Customer._id (ObjectId) and Customer._id (string) all land in one account", async () => {
    const c = await customer(); const ws = await workspace(c);
    const viaWs = await invoice(ws, "SENT");
    const viaCustOid = await invoice(c, "SENT");
    const viaCustStr = await invoice(String(c), "SENT");
    for (const id of [viaWs, viaCustOid, viaCustStr]) {
      const r = await L.touchNow({ invoiceId: id });
      expect(r).toHaveLength(1);
    }
    expect(await LoyaltyAccount.countDocuments()).toBe(1);
    const a: any = await LoyaltyAccount.findOne({ memberCustomerIds: String(c) }).lean();
    expect(await holding(a._id)).toEqual({ ON_THE_WAY: 300, LOCKED: 0, READY: 0 });
    expect((await LoyaltyLedger.distinct("invoiceId")).sort()).toEqual([viaWs, viaCustOid, viaCustStr].map(String).sort());
  });

  it("a touch by credit-note id reaches the invoice's account", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "SENT");
    await L.touchNow({ invoiceId: inv });
    const cn = await creditNote(inv, ws, "ISSUED", 5000);
    const r: any[] = await L.touchNow({ creditNoteId: cn });
    expect(r).toHaveLength(1);
    expect(r[0].balances.onTheWay).toBe(50);
  });
});

describe("accounts — membership, linking, unlinking", () => {
  it("a customer can belong to at most one account; empty accounts don't collide", async () => {
    const c = await customer();
    await LoyaltyAccount.create({ name: "A", memberCustomerIds: [String(c)] });
    await expect(LoyaltyAccount.create({ name: "B", memberCustomerIds: [String(c)] })).rejects.toThrow(/E11000/);
    await LoyaltyAccount.create({ name: "E1", memberCustomerIds: [] });
    await LoyaltyAccount.create({ name: "E2", memberCustomerIds: [] });
    expect(await LoyaltyAccount.countDocuments()).toBe(3);
  });

  it("two first touches racing create one account", async () => {
    const c = await customer();
    const [a, b] = await Promise.all([L.ensureAccountForCustomer(String(c)), L.ensureAccountForCustomer(String(c))]);
    expect(String(a!._id)).toBe(String(b!._id));
    expect(await LoyaltyAccount.countDocuments()).toBe(1);
  });

  it("linking moves the customer's holdings into the target account; unlinking moves them back", async () => {
    const parent = await customer(); const sub = await customer();
    const wsP = await workspace(parent); const wsS = await workspace(sub);
    const invP = await invoice(wsP, "SENT", { taxable: 20000 });
    const invS = await invoice(wsS, "PAID", { taxable: 30000 });
    const aP = await accountOf(parent); const aS = await accountOf(sub);
    await L.reconcileAccount(aP._id); await L.reconcileAccount(aS._id);
    expect(await holding(aS._id)).toEqual({ ON_THE_WAY: 0, LOCKED: 300, READY: 0 });

    const { fromAccountId } = await L.linkCustomer(String(aP._id), String(sub), "u1");
    expect(fromAccountId).toBe(String(aS._id));
    expect(await holding(aS._id)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 0 });
    expect(await holding(aP._id, invS)).toEqual({ ON_THE_WAY: 0, LOCKED: 300, READY: 0 });
    expect(await holding(aP._id, invP)).toEqual({ ON_THE_WAY: 200, LOCKED: 0, READY: 0 });
    const moved: any[] = await LoyaltyLedger.find({ invoiceId: String(invS) }).lean();
    expect(moved.filter((m) => m.accountId === String(aS._id)).map((m) => m.reason)).toEqual(["EARN", "ACCOUNT_LINK"]);
    expect(moved.filter((m) => m.accountId === String(aP._id)).map((m) => m.reason)).toEqual(["ACCOUNT_LINK"]);
    expect((await LoyaltyAccount.findById(aP._id).lean())!.memberCustomerIds).toEqual([String(parent), String(sub)]);
    expect((await LoyaltyAccount.findById(aS._id).lean())!.memberCustomerIds).toEqual([]);

    const { newAccountId } = await L.unlinkCustomer(String(aP._id), String(sub), "u1");
    expect(await holding(aP._id, invS)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 0 });
    expect(await holding(newAccountId, invS)).toEqual({ ON_THE_WAY: 0, LOCKED: 300, READY: 0 });
    for (const id of [aP._id, aS._id, newAccountId]) await expectCacheMatchesLedger(id);
  });

  it("linked accounts pool cumulative business toward eligibility", async () => {
    const x = await customer(); const y = await customer();
    const invX = await invoice(await workspace(x), "PAID", { taxable: 1_200_000 });
    await invoice(await workspace(y), "PAID", { taxable: 900_000 });
    const aX = await accountOf(x); await accountOf(y);
    await L.reconcileAccount(aX._id);
    expect(await holding(aX._id, invX)).toEqual({ ON_THE_WAY: 0, LOCKED: 12000, READY: 0 });
    await L.linkCustomer(String(aX._id), String(y), "u1");
    const a: any = await LoyaltyAccount.findById(aX._id).lean();
    expect(a.cumulativeInr).toBe(2_100_000);
    expect(a.eligibleAt).toBeInstanceOf(Date);
    expect(await holding(aX._id)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 21000 });
  });

  it("refuses to link the HOUSE customer or a customer already in the account", async () => {
    const c = await customer(); const a = await accountOf(c);
    await col("customers").insertOne({ _id: HOUSE_CUST, name: "Plumtrips" } as any);
    await expect(L.linkCustomer(String(a._id), String(HOUSE_CUST), "u1")).rejects.toThrow(/HOUSE/);
    await expect(L.linkCustomer(String(a._id), String(c), "u1")).rejects.toThrow(/already/);
  });
});

describe("manual adjustment — the bucket follows eligibility", () => {
  it("lands in LOCKED while not eligible; a replayed key is not applied twice; reconcile leaves it alone", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "SENT");
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    expect(await L.manualAdjust(String(a._id), { points: 500, reason: "Goodwill", idempotencyKey: "k1" }, "u1"))
      .toEqual({ duplicate: false, moves: [{ bucket: "LOCKED", points: 500 }] });
    expect((await L.manualAdjust(String(a._id), { points: 500, reason: "Goodwill", idempotencyKey: "k1" }, "u1")).duplicate).toBe(true);
    await L.reconcileAccount(a._id);
    expect(await holding(a._id)).toEqual({ ON_THE_WAY: 100, LOCKED: 500, READY: 0 });
    await expectCacheMatchesLedger(a._id);
    await expect(L.manualAdjust(String(a._id), { points: 5, reason: " " }, "u1")).rejects.toThrow(/reason/);
    await expect(L.manualAdjust(String(a._id), { points: 1.5, reason: "x" }, "u1")).rejects.toThrow(/whole/);
    await expect(L.manualAdjust(String(a._id), { bucket: "READY", points: 5, reason: "x" }, "u1")).rejects.toThrow(/not chosen/);
  });

  it("lands in READY once the account is eligible", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "PAID", { taxable: 2_000_000 });
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    const r = await L.manualAdjust(String(a._id), { points: 300, reason: "Bonus" }, "u1");
    expect(r.moves).toEqual([{ bucket: "READY", points: 300 }]);
    expect(await holding(a._id)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 20300 });
  });

  it("LOCKED manual points move to READY in the same unlock step when the account crosses ₹20L", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "PAID", { taxable: 1_900_000 });
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    await L.manualAdjust(String(a._id), { points: 700, reason: "Migration credit" }, "u1");
    expect(await holding(a._id)).toEqual({ ON_THE_WAY: 0, LOCKED: 19700, READY: 0 });
    await invoice(ws, "SENT", { taxable: 100_000 });
    await L.reconcileAccount(a._id);
    expect(await holding(a._id)).toEqual({ ON_THE_WAY: 1000, LOCKED: 0, READY: 19700 });
    const unlock: any[] = await LoyaltyLedger.find({ invoiceId: null, reason: "ELIGIBILITY_UNLOCK" }).lean();
    expect(unlock.map((u) => [u.bucket, u.points]).sort()).toEqual([["LOCKED", -700], ["READY", 700]]);
    // Idempotent: nothing more on the next run.
    expect(((await L.reconcileAccount(a._id)) as any).rowsWritten).toBe(0);
    await expectCacheMatchesLedger(a._id);
  });

  it("a negative adjustment takes from READY first, then LOCKED, and never more than both hold", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "PAID", { taxable: 2_000_000 }); // eligible: 20000 READY
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    // Put 400 into LOCKED by hand (as if it were a pre-eligibility manual row awaiting the next unlock).
    await LoyaltyLedger.create({ accountId: String(a._id), bucket: "LOCKED", points: 400, reason: "MANUAL", idempotencyKey: "seed-locked", createdBy: "t" });
    await LoyaltyAccount.updateOne({ _id: a._id }, { $inc: { "balances.locked": 400 } });

    const r1 = await L.manualAdjust(String(a._id), { points: -150, reason: "Correction" }, "u1");
    expect(r1.moves).toEqual([{ bucket: "READY", points: -150 }]);
    const r2 = await L.manualAdjust(String(a._id), { points: -20000, reason: "Correction" }, "u1");
    expect(r2.moves).toEqual([{ bucket: "READY", points: -19850 }, { bucket: "LOCKED", points: -150 }]);
    expect(await holding(a._id)).toEqual({ ON_THE_WAY: 0, LOCKED: 250, READY: 0 });
    await expect(L.manualAdjust(String(a._id), { points: -251, reason: "Too much" }, "u1")).rejects.toThrow(/holds 0 ready and 250 locked/);
    await expectCacheMatchesLedger(a._id);
  });

  it("a negative adjustment while not eligible comes out of LOCKED", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "PAID", { taxable: 50_000 });
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    const r = await L.manualAdjust(String(a._id), { points: -200, reason: "Correction" }, "u1");
    expect(r.moves).toEqual([{ bucket: "LOCKED", points: -200 }]);
    expect(await holding(a._id)).toEqual({ ON_THE_WAY: 0, LOCKED: 300, READY: 0 });
  });
});

describe("rate history — no retroactive rate changes", () => {
  const T = new Date("2026-06-01T00:00:00+05:30");
  const setRates = (rates: Array<[number, Date]>) =>
    setSettings({ rateHistory: rates.map(([pointsPer100, effectiveFrom]) => ({ pointsPer100, effectiveFrom, setBy: "t", reason: "t" })) });

  it("is seeded with 1 point per ₹100 from the launch date", async () => {
    await LoyaltySettings.deleteMany({});
    const s = await L.getLoyaltySettings();
    expect(s.rateHistory).toHaveLength(1);
    expect(s.rateHistory[0]).toMatchObject({ pointsPer100: 1, setBy: "system" });
    expect(new Date(s.rateHistory[0].effectiveFrom).toISOString()).toBe(new Date(s.launchDate).toISOString());
    // Seeded once: a second read does not add another.
    expect((await L.getLoyaltySettings()).rateHistory).toHaveLength(1);
  });

  it("rateAt picks the entry in force; before every entry takes the earliest", () => {
    const h = [{ pointsPer100: 1, effectiveFrom: LAUNCH }, { pointsPer100: 3, effectiveFrom: T }];
    expect(L.rateAt(h, new Date("2026-05-31T23:59:59+05:30"))).toBe(1);
    expect(L.rateAt(h, T)).toBe(3);
    expect(L.rateAt(h, BEFORE)).toBe(1);
  });

  it("an invoice created before a rate change keeps its points; one created after uses the new rate", async () => {
    await setRates([[1, LAUNCH]]);
    const c = await customer(); const ws = await workspace(c);
    const old = await invoice(ws, "SENT", { createdAt: new Date("2026-05-10T10:00:00+05:30"), invoiceDate: new Date("2026-05-10T10:00:00+05:30") });
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, old)).ON_THE_WAY).toBe(100);

    await setRates([[1, LAUNCH], [3, T]]);
    const fresh = await invoice(ws, "SENT", { createdAt: new Date("2026-06-02T10:00:00+05:30"), invoiceDate: new Date("2026-06-02T10:00:00+05:30") });
    const r: any = await L.reconcileAccount(a._id);
    expect(r.rowsWritten).toBe(1); // only the new invoice
    expect((await holding(a._id, old)).ON_THE_WAY).toBe(100);
    expect((await holding(a._id, fresh)).ON_THE_WAY).toBe(300);
  });

  it("a partial credit note on an old invoice still uses the old rate", async () => {
    await setRates([[1, LAUNCH], [3, T]]);
    const c = await customer(); const ws = await workspace(c);
    const old = await invoice(ws, "SENT", { createdAt: new Date("2026-05-10T10:00:00+05:30"), invoiceDate: new Date("2026-05-10T10:00:00+05:30") });
    const a = await accountOf(c);
    await L.reconcileAccount(a._id);
    // The CN is issued after the rate change — the invoice's own rate (1) applies.
    await creditNote(old, ws, "ISSUED", 4000);
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, old)).ON_THE_WAY).toBe(60); // floor(6000 × 1 / 100), not × 3
  });
});

/* ───────────────────────────── concurrency ───────────────────────────── */

describe("concurrency", () => {
  it("two reconciles of one account at the same time never double-count (lease)", async () => {
    const c = await customer(); const ws = await workspace(c);
    for (let i = 0; i < 5; i++) await invoice(ws, i % 2 ? "PAID" : "SENT");
    const a = await accountOf(c);
    const results: any[] = await Promise.all([L.reconcileAccount(a._id), L.reconcileAccount(a._id), L.reconcileAccount(a._id)]);
    expect(results.filter((r) => r.skipped === "locked").length).toBeGreaterThanOrEqual(1);
    expect(await holding(a._id)).toEqual({ ON_THE_WAY: 300, LOCKED: 200, READY: 0 });
    expect(await rowCount(a._id)).toBe(5);
    await expectCacheMatchesLedger(a._id);
    const acct: any = await LoyaltyAccount.findById(a._id).lean();
    expect(acct.lockedUntil).toBeNull();
  });

  it("the idempotency key is the second guard: two runs planned from the same state apply once", async () => {
    const c = await customer(); const ws = await workspace(c);
    await invoice(ws, "SENT"); await invoice(ws, "PAID");
    const a: any = (await accountOf(c)).toObject();
    const settings = await L.getLoyaltySettings();
    const [p1, p2] = await Promise.all([L.planAccount(a, settings), L.planAccount(a, settings)]);
    const [r1, r2] = await Promise.all([L.applyPlan(p1), L.applyPlan(p2)]);
    expect(r1.rowsWritten + r2.rowsWritten).toBe(2);
    expect(r1.conflicts + r2.conflicts).toBe(2);
    expect(await holding(a._id)).toEqual({ ON_THE_WAY: 100, LOCKED: 100, READY: 0 });
    await expectCacheMatchesLedger(a._id);
  });

  it("a touch that finds the lease taken makes the holder run once more, so its change is not lost", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "SENT");
    const a = await accountOf(c);
    await LoyaltyAccount.updateOne({ _id: a._id }, { $set: { lockedUntil: new Date(Date.now() + 60_000), lockOwner: "someone" } });
    expect(await L.reconcileAccount(a._id)).toMatchObject({ skipped: "locked" });
    expect((await LoyaltyAccount.findById(a._id).lean())!.rerunRequested).toBe(true);
    // An expired lease is taken over.
    await LoyaltyAccount.updateOne({ _id: a._id }, { $set: { lockedUntil: new Date(Date.now() - 1) } });
    await L.reconcileAccount(a._id);
    expect((await holding(a._id, inv)).ON_THE_WAY).toBe(100);
  });
});

/* ───────────────────────────── touch ───────────────────────────── */

describe("loyaltyTouch never throws", () => {
  it("returns synchronously with no result, even for junk input", async () => {
    expect(loyaltyTouchSafe({ invoiceId: "not-an-id" })).toBeUndefined();
    expect(loyaltyTouchSafe({})).toBeUndefined();
    expect(loyaltyTouchSafe(undefined as any)).toBeUndefined();
    await L.loyaltyIdle();
  });

  it("swallows and logs a reconcile failure", async () => {
    const c = await customer(); const ws = await workspace(c);
    const inv = await invoice(ws, "SENT");
    const err = vi.spyOn(logger, "error").mockImplementation((() => logger) as any);
    const agg = vi.spyOn(LoyaltyLedger, "aggregate").mockImplementation((() => { throw new Error("boom"); }) as any);
    try {
      expect(L.loyaltyTouch({ invoiceId: inv })).toBeUndefined();
      await L.loyaltyIdle();
      expect(err).toHaveBeenCalledWith("[Loyalty] touch failed", expect.objectContaining({ message: "boom", invoiceId: String(inv) }));
    } finally {
      agg.mockRestore(); err.mockRestore();
    }
    // The lease was released despite the failure: the next touch heals it.
    L.loyaltyTouch({ invoiceId: inv });
    await L.loyaltyIdle();
    const a: any = await LoyaltyAccount.findOne({ memberCustomerIds: String(c) }).lean();
    expect(a.lockedUntil).toBeNull();
    expect((await holding(a._id, inv)).ON_THE_WAY).toBe(100);
  });
});

function loyaltyTouchSafe(ref: any) {
  return L.loyaltyTouch(ref);
}

/* ───────────────────────────── sweep ───────────────────────────── */

describe("daily sweep", () => {
  it("creates missing accounts, reconciles every account, and records a checkpoint", async () => {
    const c1 = await customer(); const c2 = await customer(); const draftOnly = await customer();
    await invoice(await workspace(c1), "SENT");
    await invoice(c2, "PAID"); // legacy Customer._id-keyed invoice
    await invoice(await workspace(draftOnly), "DRAFT");
    await invoice(HOUSE, "PAID");
    const r: any = await L.runLoyaltySweep({ runKey: "daily:test-1" });
    expect(r).toMatchObject({ claimed: true, accountsCreated: 2, accountsReconciled: 2, rowsWritten: 2, errorCount: 0 });
    const run: any = await LoyaltySweepRun.findOne({ runKey: "daily:test-1" }).lean();
    expect(run).toMatchObject({ status: "DONE", accountsCreated: 2, accountsReconciled: 2, rowsWritten: 2 });
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(await L.customersMissingAccounts()).toEqual([]);
  });

  it("is claimed once per run key — concurrent instances, one sweep", async () => {
    const c = await customer();
    await invoice(await workspace(c), "SENT");
    const rs: any[] = await Promise.all([1, 2, 3].map(() => L.runLoyaltySweep({ runKey: "daily:test-2" })));
    expect(rs.filter((r) => r.claimed)).toHaveLength(1);
    expect(await LoyaltySweepRun.countDocuments({ runKey: "daily:test-2" })).toBe(1);
    expect(await LoyaltyLedger.countDocuments()).toBe(1);
    // The default run key is the IST date.
    const d: any = await L.runLoyaltySweep({ now: new Date("2026-11-02T20:00:00Z") });
    expect(d.runKey).toBe("daily:2026-11-03");
  });
});
