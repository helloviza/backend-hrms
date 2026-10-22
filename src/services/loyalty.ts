// apps/backend/src/services/loyalty.ts
//
// Loyalty Points — Phase 1 engine (PRD v1.1; docs/audits/loyalty-points-audit.md §6).
//
// RECONCILE, DON'T REACT. Nothing here listens to invoice transitions. Each
// account's points are a pure function of the CURRENT invoices + ISSUED credit
// notes of its member customers; reconcileAccount() recomputes that target and
// appends only the difference to LoyaltyLedger. Finance code calls
// loyaltyTouch() after a write (one line, never throws, never awaited), and a
// daily sweep (jobs/loyaltySweepCron.ts) heals anything a touch missed.
//
// THE RULES (PRD v1.1 — final):
//   counted invoice   status SENT | PAYMENT_DECLARED | PAID, not isDemo, not D2C
//                     (D2C = HOUSE customer, or the invoice is a
//                     VisaApplication.d2cInvoiceId). DRAFT / CANCELLED = 0.
//   earn base         (grandTotal − totalGST)
//                     − Σ (cn.grandTotal − cn.totalGST) over ISSUED CNs of the invoice,
//                     floored at 0. Invoice level only.
//   points            floor(earn base × rate / 100), rate = the rateHistory entry in
//                     force at the invoice's createdAt (a later rate never re-prices
//                     an earlier invoice — its credit notes included)
//   earns             counted AND member enrolled AND account enabled AND
//                     invoiceDate ≥ start AND createdAt ≥ start
//                     (start = account.startDateOverride ?? settings.launchDate)
//   cumulative        Σ earn base over ALL counted invoices of the account,
//                     whatever the start date or enrolment
//   eligible          cumulative ≥ thresholdInr; eligibleAt is sticky
//   bucket            SENT / PAYMENT_DECLARED → ON_THE_WAY;
//                     PAID → READY if eligible, else LOCKED
//   company key       Invoice.workspaceId → CustomerWorkspace.customerId, else
//                     the id itself (it already is a Customer._id); keyed on
//                     Invoice._id, never invoiceNo.
//   enrolment         enrolBusinessesOnly → the customer has a GSTIN on file
//                     (Customer.gstNumber, legacy Customer.gstin) AND its
//                     gstStatus is not UNREGISTERED.
//
// Loyalty must never block, slow or fail a finance action: loyaltyTouch defers
// to the next tick, swallows every error, and the finance write it follows has
// already committed.
import crypto from "node:crypto";
import os from "node:os";
import mongoose from "mongoose";
import Invoice from "../models/Invoice.js";
import CreditNote from "../models/CreditNote.js";
import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import VisaApplication from "../models/VisaApplication.js";
import LoyaltySettings, {
  LOYALTY_SETTINGS_DEFAULTS, DEFAULT_POINTS_PER_100, type LoyaltyRate,
} from "../models/LoyaltySettings.js";
import LoyaltyAccount, { type ILoyaltyAccount, type LoyaltyBalances } from "../models/LoyaltyAccount.js";
import LoyaltyLedger, {
  LOYALTY_BUCKETS, type LoyaltyBucket, type LoyaltyReason, type LoyaltySnapshot,
} from "../models/LoyaltyLedger.js";
import LoyaltySweepRun from "../models/LoyaltySweepRun.js";
import { normalizeGstStatus } from "../utils/customerGst.js";
import { todayIST } from "../utils/dateIST.js";
import logger from "../utils/logger.js";

/** Plumtrips HOUSE CustomerWorkspace._id (repo convention: a per-file literal). */
const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

export const COUNTED_STATUSES = ["SENT", "PAYMENT_DECLARED", "PAID"] as const;
const LEASE_MS = 120_000;
const MAX_PASSES = 3;
const SYSTEM = "system";

export interface LoyaltySettingsValues {
  programmeEnabled: boolean;
  launchDate: Date;
  rateHistory: LoyaltyRate[];
  thresholdInr: number;
  minRedemption: number;
  defaultCapPct: number;
  validityMonths: number;
  enrolBusinessesOnly: boolean;
}

const BALANCE_FIELD: Record<LoyaltyBucket, keyof LoyaltyBalances> = {
  ON_THE_WAY: "onTheWay",
  LOCKED: "locked",
  READY: "ready",
};

/* ── Small helpers ─────────────────────────────────────────────────── */

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const isOid = (v: unknown) => mongoose.Types.ObjectId.isValid(String(v ?? "")) && String(v).length === 24;
const isDupKey = (e: any) => e?.code === 11000 || /E11000/.test(String(e?.message ?? ""));

/** Both stored forms of an id (ObjectId and string) for a raw `$in`. */
function idForms(ids: Iterable<unknown>): unknown[] {
  const out: unknown[] = [];
  for (const raw of ids) {
    const s = String(raw ?? "");
    if (!s) continue;
    out.push(s);
    if (isOid(s)) out.push(new mongoose.Types.ObjectId(s));
  }
  return out;
}

/**
 * The singleton settings row, created with the PRD defaults on first read.
 * `create: false` (the dry-run script) reads without writing: a missing row
 * reads as the defaults.
 */
export async function getLoyaltySettings(opts: { create?: boolean } = {}): Promise<LoyaltySettingsValues & { changeLog: any[] }> {
  if (opts.create === false) {
    const doc: any = await LoyaltySettings.findOne({ key: "global" }).lean();
    const merged: any = { ...LOYALTY_SETTINGS_DEFAULTS, changeLog: [], ...(doc ?? {}) };
    if (!merged.rateHistory?.length) merged.rateHistory = [seedRate(merged.launchDate)];
    return merged;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      let doc: any = await LoyaltySettings.findOneAndUpdate(
        { key: "global" },
        { $setOnInsert: { key: "global" } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      if (!doc.rateHistory?.length) {
        // Seed the one starting rate: 1 point per ₹100 from the launch date.
        // Filtered on "still empty", so racing first reads seed it once.
        await LoyaltySettings.updateOne(
          { key: "global", $or: [{ rateHistory: { $exists: false } }, { rateHistory: { $size: 0 } }] },
          { $set: { rateHistory: [seedRate(doc.launchDate)] } },
        );
        doc = await LoyaltySettings.findOne({ key: "global" }).lean();
      }
      return { ...LOYALTY_SETTINGS_DEFAULTS, ...doc };
    } catch (e) {
      // Two first reads racing: one upsert loses on the unique key. Re-read.
      if (isDupKey(e) && attempt < 2) continue;
      throw e;
    }
  }
}

function seedRate(launchDate: Date): LoyaltyRate {
  return { pointsPer100: DEFAULT_POINTS_PER_100, effectiveFrom: new Date(launchDate), setBy: SYSTEM, setAt: new Date(), reason: "Programme launch rate" };
}

/* ── Pure rules ────────────────────────────────────────────────────── */

/**
 * The rate in force at `at`: the latest entry with effectiveFrom <= at. An
 * instant before every entry (a start date set earlier than the first rate)
 * takes the earliest entry.
 */
export function rateAt(rateHistory: Pick<LoyaltyRate, "pointsPer100" | "effectiveFrom">[], at: Date): number {
  const rates = [...(rateHistory || [])].sort((a, b) => new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime());
  if (!rates.length) return DEFAULT_POINTS_PER_100;
  let rate = rates[0].pointsPer100;
  for (const r of rates) if (new Date(r.effectiveFrom).getTime() <= at.getTime()) rate = r.pointsPer100;
  return rate;
}

export interface Money { grandTotal?: number | null; totalGST?: number | null }

/** Earn base of one invoice: taxable value less the taxable value of its ISSUED credit notes, floored at 0. */
export function earnBaseOf(invoice: Money, issuedCreditNotes: Money[]): { gross: number; credited: number; base: number } {
  const gross = r2((Number(invoice.grandTotal) || 0) - (Number(invoice.totalGST) || 0));
  const credited = r2(issuedCreditNotes.reduce((s, cn) => s + (Number(cn.grandTotal) || 0) - (Number(cn.totalGST) || 0), 0));
  return { gross, credited, base: Math.max(0, r2(gross - credited)) };
}

/** floor(base × pointsPer100 / 100). The epsilon absorbs binary-float noise (e.g. 0.29 × 100). */
export function pointsFor(base: number, pointsPer100: number): number {
  if (!(base > 0) || !(pointsPer100 > 0)) return 0;
  return Math.floor((base * pointsPer100) / 100 + 1e-9);
}

export function isCountedStatus(status: unknown): boolean {
  return (COUNTED_STATUSES as readonly string[]).includes(String(status));
}

/** Rule 7. A registered business = GSTIN on file and gstStatus not UNREGISTERED. */
export function isEnrolled(customer: any, settings: Pick<LoyaltySettingsValues, "enrolBusinessesOnly">): boolean {
  if (!customer) return false;
  if (!settings.enrolBusinessesOnly) return true;
  if (normalizeGstStatus(customer.gstStatus) === "UNREGISTERED") return false;
  return String(customer.gstNumber || customer.gstin || "").trim().length > 0;
}

export function effectiveStartDate(account: { startDateOverride?: Date | null }, settings: { launchDate: Date }): Date {
  return new Date(account.startDateOverride ?? settings.launchDate);
}

/** Invoice.createdAt, or — for a raw-inserted row without one — the ObjectId's own time. */
export function invoiceCreatedAt(inv: { _id: unknown; createdAt?: Date | null }): Date {
  if (inv.createdAt) return new Date(inv.createdAt);
  return isOid(inv._id) ? new mongoose.Types.ObjectId(String(inv._id)).getTimestamp() : new Date(0);
}

/** Bucket a counted, earning invoice's points belong in. */
export function bucketFor(status: string, eligible: boolean): LoyaltyBucket {
  if (status === "PAID") return eligible ? "READY" : "LOCKED";
  return "ON_THE_WAY";
}

/* ── Company key ───────────────────────────────────────────────────── */

let houseCustomerIdCache: string | null | undefined;

/** The HOUSE Customer._id (the customer behind the HOUSE workspace) — never earns. */
export async function houseCustomerId(): Promise<string | null> {
  if (houseCustomerIdCache !== undefined) return houseCustomerIdCache;
  const ws: any = await CustomerWorkspace.collection.findOne(
    { _id: new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID) },
    { projection: { customerId: 1 } },
  );
  houseCustomerIdCache = ws?.customerId ? String(ws.customerId) : null;
  return houseCustomerIdCache;
}

/** Test seam: forget the cached HOUSE customer id. */
export function __resetLoyaltyCaches(): void {
  houseCustomerIdCache = undefined;
}

async function isHouseCustomer(customerId: string): Promise<boolean> {
  if (customerId === HOUSE_WORKSPACE_ID) return true;
  return customerId === (await houseCustomerId());
}

/** Invoice.workspaceId / CreditNote.workspaceId → Customer._id (string). */
export async function customerIdForWorkspace(workspaceId: unknown): Promise<string | null> {
  const id = String(workspaceId ?? "");
  if (!id) return null;
  if (isOid(id)) {
    const ws: any = await CustomerWorkspace.collection.findOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { projection: { customerId: 1 } },
    );
    if (ws?.customerId) return String(ws.customerId);
  }
  return id;
}

/* ── Accounts ──────────────────────────────────────────────────────── */

function customerDisplayName(c: any, fallback: string): string {
  return String(c?.legalName || c?.companyName || c?.name || fallback).trim() || fallback;
}

/**
 * The customer's account, creating a one-member account the first time. Never
 * for the HOUSE customer. Two first touches racing: the loser's insert hits
 * the unique member index and it re-reads the winner's account.
 */
export async function ensureAccountForCustomer(customerId: string, actor = SYSTEM): Promise<ILoyaltyAccount | null> {
  const cid = String(customerId || "");
  if (!cid || (await isHouseCustomer(cid))) return null;
  const existing = await LoyaltyAccount.findOne({ memberCustomerIds: cid });
  if (existing) return existing;
  const cust: any = isOid(cid)
    ? await Customer.collection.findOne({ _id: new mongoose.Types.ObjectId(cid) }, { projection: { legalName: 1, companyName: 1, name: 1 } })
    : null;
  try {
    return await LoyaltyAccount.create({
      name: customerDisplayName(cust, `Customer ${cid}`),
      memberCustomerIds: [cid],
      changeLog: [{ at: new Date(), by: actor, field: "created", old: null, new: { memberCustomerIds: [cid] } }],
    });
  } catch (e) {
    if (!isDupKey(e)) throw e;
    return LoyaltyAccount.findOne({ memberCustomerIds: cid });
  }
}

/* ── Planning ──────────────────────────────────────────────────────── */

export interface InvoiceState {
  invoiceId: string;
  invoiceNo: string | null;
  customerId: string | null;
  status: string;
  counted: boolean;
  earns: boolean;
  gross: number;
  credited: number;
  base: number;
  points: number;
  target: Record<LoyaltyBucket, number>;
  /** Why it does not earn, when counted but not earning. */
  why?: string;
}

export interface LedgerDelta {
  /** null = the account's manual points (the eligibility unlock of LOCKED manual adjustments). */
  invoiceId: string | null;
  invoiceNo: string | null;
  customerId: string | null;
  bucket: LoyaltyBucket;
  points: number;
  reason: LoyaltyReason;
  snapshot?: LoyaltySnapshot;
  idempotencyKey: string;
}

export interface AccountPlan {
  accountId: string;
  cumulativeInr: number;
  eligibleAt: Date | null;
  becameEligible: boolean;
  invoices: InvoiceState[];
  deltas: LedgerDelta[];
}

export interface PlanAccountInput {
  _id: unknown;
  memberCustomerIds: string[];
  enabled?: boolean;
  startDateOverride?: Date | null;
  eligibleAt?: Date | null;
}

interface LedgerGroup { points: number; n: number }

const zeroTarget = (): Record<LoyaltyBucket, number> => ({ ON_THE_WAY: 0, LOCKED: 0, READY: 0 });

/**
 * Computes the account's target state and the ledger rows that would move the
 * current ledger to it. Reads only — writes nothing.
 */
export async function planAccount(
  account: PlanAccountInput,
  settings: LoyaltySettingsValues,
  opts: { now?: Date; reasonHint?: LoyaltyReason } = {},
): Promise<AccountPlan> {
  const now = opts.now ?? new Date();
  const accountId = String(account._id);
  const house = await houseCustomerId();
  const members = [...new Set((account.memberCustomerIds || []).map(String))].filter((c) => c !== house);

  // Member customers and every workspace id that names one of them.
  const customers: any[] = members.length
    ? await Customer.collection
        .find({ _id: { $in: members.filter(isOid).map((c) => new mongoose.Types.ObjectId(c)) } },
          { projection: { gstStatus: 1, gstNumber: 1, gstin: 1 } })
        .toArray()
    : [];
  const customerById = new Map(customers.map((c) => [String(c._id), c]));
  const wsRows: any[] = members.length
    ? await CustomerWorkspace.collection.find({ customerId: { $in: members } }, { projection: { customerId: 1 } }).toArray()
    : [];
  const keyToCustomer = new Map<string, string>(members.map((c) => [c, c]));
  for (const w of wsRows) if (String(w._id) !== HOUSE_WORKSPACE_ID) keyToCustomer.set(String(w._id), String(w.customerId));

  const invoices: any[] = keyToCustomer.size
    ? await Invoice.collection
        .find({ workspaceId: { $in: idForms(keyToCustomer.keys()) } as any },
          { projection: { invoiceNo: 1, workspaceId: 1, status: 1, isDemo: 1, grandTotal: 1, totalGST: 1, invoiceDate: 1, createdAt: 1 } })
        .toArray()
    : [];
  const invoiceIds = invoices.map((i) => i._id);

  const [cns, d2cRows] = invoiceIds.length
    ? await Promise.all([
        CreditNote.collection
          .find({ originalInvoiceId: { $in: idForms(invoiceIds) } as any, status: "ISSUED" },
            { projection: { originalInvoiceId: 1, grandTotal: 1, totalGST: 1 } })
          .toArray(),
        VisaApplication.collection
          .find({ d2cInvoiceId: { $in: invoiceIds } }, { projection: { d2cInvoiceId: 1 } })
          .toArray(),
      ])
    : [[], []];
  const cnsByInvoice = new Map<string, any[]>();
  for (const cn of cns as any[]) {
    const k = String(cn.originalInvoiceId);
    if (!cnsByInvoice.has(k)) cnsByInvoice.set(k, []);
    cnsByInvoice.get(k)!.push(cn);
  }
  const d2c = new Set((d2cRows as any[]).map((v) => String(v.d2cInvoiceId)));

  // Current ledger, per invoice per bucket, plus the latest snapshot per invoice.
  const groups: any[] = await LoyaltyLedger.aggregate([
    { $match: { accountId, invoiceId: { $ne: null } } },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: { inv: "$invoiceId", b: "$bucket" },
        points: { $sum: "$points" },
        n: { $sum: 1 },
        lastAt: { $last: "$createdAt" },
        lastId: { $last: "$_id" },
        snapshot: { $last: "$snapshot" },
        invoiceNo: { $last: "$invoiceNo" },
        customerId: { $last: "$customerId" },
      },
    },
  ]);
  const ledger = new Map<string, Map<LoyaltyBucket, LedgerGroup>>();
  const lastSnap = new Map<string, { at: number; id: string; snapshot: LoyaltySnapshot | undefined; invoiceNo: string | null; customerId: string | null }>();
  for (const g of groups) {
    const inv = String(g._id.inv);
    if (!ledger.has(inv)) ledger.set(inv, new Map());
    ledger.get(inv)!.set(g._id.b, { points: g.points, n: g.n });
    const at = new Date(g.lastAt).getTime();
    const prev = lastSnap.get(inv);
    if (!prev || at > prev.at || (at === prev.at && String(g.lastId) > prev.id)) {
      lastSnap.set(inv, { at, id: String(g.lastId), snapshot: g.snapshot, invoiceNo: g.invoiceNo ?? null, customerId: g.customerId ?? null });
    }
  }

  // Pass 1 — cumulative business and eligibility.
  const states: InvoiceState[] = [];
  let cumulative = 0;
  for (const inv of invoices) {
    const id = String(inv._id);
    const customerId = keyToCustomer.get(String(inv.workspaceId)) ?? null;
    const { gross, credited, base } = earnBaseOf(inv, cnsByInvoice.get(id) ?? []);
    const counted = isCountedStatus(inv.status) && inv.isDemo !== true && !d2c.has(id) && !!customerId;
    if (counted) cumulative += base;
    states.push({
      invoiceId: id, invoiceNo: inv.invoiceNo ?? null, customerId, status: String(inv.status),
      counted, earns: false, gross, credited, base, points: 0, target: zeroTarget(),
    });
  }
  cumulative = r2(cumulative);
  const becameEligible = !account.eligibleAt && cumulative >= settings.thresholdInr;
  const eligibleAt = account.eligibleAt ? new Date(account.eligibleAt) : becameEligible ? now : null;
  const eligible = !!eligibleAt;

  // Pass 2 — what each invoice should hold.
  const start = effectiveStartDate(account, settings);
  const invById = new Map(invoices.map((i) => [String(i._id), i]));
  for (const s of states) {
    if (!s.counted) continue;
    const inv = invById.get(s.invoiceId);
    if (account.enabled === false) { s.why = "account disabled"; continue; }
    if (!isEnrolled(customerById.get(String(s.customerId)), settings)) { s.why = "customer not enrolled"; continue; }
    if (!(new Date(inv.invoiceDate) >= start)) { s.why = "invoice dated before start"; continue; }
    if (!(invoiceCreatedAt(inv) >= start)) { s.why = "invoice created before start"; continue; }
    s.earns = true;
    s.points = pointsFor(s.base, rateAt(settings.rateHistory, invoiceCreatedAt(inv)));
    s.target[bucketFor(s.status, eligible)] = s.points;
  }

  // Pass 3 — the difference, for every invoice in the target OR in the ledger.
  const stateById = new Map(states.map((s) => [s.invoiceId, s]));
  const allIds = new Set<string>([...stateById.keys(), ...ledger.keys()]);
  const deltas: LedgerDelta[] = [];
  for (const invId of allIds) {
    const s = stateById.get(invId);
    const cur = ledger.get(invId) ?? new Map<LoyaltyBucket, LedgerGroup>();
    const target = s?.target ?? zeroTarget();
    const moves: Array<{ bucket: LoyaltyBucket; points: number; n: number }> = [];
    for (const b of LOYALTY_BUCKETS) {
      const have = cur.get(b)?.points ?? 0;
      if (target[b] !== have) moves.push({ bucket: b, points: target[b] - have, n: cur.get(b)?.n ?? 0 });
    }
    if (!moves.length) continue;

    const last = lastSnap.get(invId);
    const snapshot: LoyaltySnapshot = s
      ? { status: s.status, earnBase: s.base, creditedBase: s.credited }
      : { status: "NOT_IN_ACCOUNT", earnBase: 0, creditedBase: 0 };
    const reason = deltaReason({ inAccount: !!s, hadRows: cur.size > 0, last: last?.snapshot, snapshot, moves, hint: opts.reasonHint });
    for (const m of moves) {
      deltas.push({
        invoiceId: invId,
        invoiceNo: s?.invoiceNo ?? last?.invoiceNo ?? null,
        customerId: s?.customerId ?? last?.customerId ?? null,
        bucket: m.bucket,
        points: m.points,
        reason,
        snapshot,
        idempotencyKey: `acct:${accountId}:inv:${invId}:${m.bucket}:n${m.n + 1}`,
      });
    }
  }

  // Manual adjustments follow eligibility: once the account is eligible, its
  // LOCKED manual points move to READY in the same unlock step as invoice points.
  if (eligible) {
    const [manual]: any[] = await LoyaltyLedger.aggregate([
      { $match: { accountId, invoiceId: null, bucket: "LOCKED" } },
      { $group: { _id: null, points: { $sum: "$points" }, n: { $sum: 1 } } },
    ]);
    if (manual && manual.points !== 0) {
      const base = { invoiceId: null, invoiceNo: null, customerId: null, reason: "ELIGIBILITY_UNLOCK" as const };
      deltas.push(
        { ...base, bucket: "LOCKED", points: -manual.points, idempotencyKey: `acct:${accountId}:manual:LOCKED:n${manual.n + 1}` },
        { ...base, bucket: "READY", points: manual.points, idempotencyKey: `acct:${accountId}:manual:READY:n${manual.n + 1}` },
      );
    }
  }

  return { accountId, cumulativeInr: cumulative, eligibleAt, becameEligible, invoices: states, deltas };
}

function deltaReason(x: {
  inAccount: boolean;
  hadRows: boolean;
  last: LoyaltySnapshot | undefined;
  snapshot: LoyaltySnapshot;
  moves: Array<{ bucket: LoyaltyBucket; points: number }>;
  hint?: LoyaltyReason;
}): LoyaltyReason {
  if (!x.inAccount) return x.hint === "ACCOUNT_LINK" || x.hadRows ? "ACCOUNT_LINK" : "RECONCILE";
  if (!x.hadRows) return x.hint === "ACCOUNT_LINK" ? "ACCOUNT_LINK" : "EARN";
  // LOCKED → READY of the same points, nothing else moved: the account crossed the threshold.
  const byBucket = Object.fromEntries(x.moves.map((m) => [m.bucket, m.points]));
  if (x.moves.length === 2 && byBucket.LOCKED < 0 && byBucket.READY === -byBucket.LOCKED) return "ELIGIBILITY_UNLOCK";
  if (x.last && x.last.status !== x.snapshot.status) return "STATUS_CHANGE";
  if (x.last && x.last.creditedBase !== x.snapshot.creditedBase) return "CREDIT_NOTE";
  if (x.hint) return x.hint;
  return "RECONCILE";
}

/* ── Applying ──────────────────────────────────────────────────────── */

export interface ApplyResult { rowsWritten: number; conflicts: number }

/**
 * Writes a plan: per invoice, its delta rows and the cached balance move in
 * ONE transaction. A duplicate idempotency key means another run already
 * wrote that state — the whole invoice's transaction is dropped, nothing is
 * double-counted, and the next reconcile re-plans from the real ledger.
 */
export async function applyPlan(plan: AccountPlan, actor = SYSTEM): Promise<ApplyResult> {
  const accountOid = new mongoose.Types.ObjectId(plan.accountId);
  if (plan.becameEligible && plan.eligibleAt) {
    // Sticky: only ever set when it is still empty.
    await LoyaltyAccount.updateOne({ _id: accountOid, eligibleAt: null }, { $set: { eligibleAt: plan.eligibleAt } });
  }

  const byInvoice = new Map<string, LedgerDelta[]>();
  for (const d of plan.deltas) {
    const k = d.invoiceId ?? "manual";
    if (!byInvoice.has(k)) byInvoice.set(k, []);
    byInvoice.get(k)!.push(d);
  }

  let rowsWritten = 0;
  let conflicts = 0;
  for (const rows of byInvoice.values()) {
    const inc: Record<string, number> = {};
    for (const r of rows) {
      const f = `balances.${BALANCE_FIELD[r.bucket]}`;
      inc[f] = (inc[f] ?? 0) + r.points;
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await LoyaltyLedger.insertMany(
          rows.map((r) => ({
            accountId: plan.accountId, customerId: r.customerId, invoiceId: r.invoiceId, invoiceNo: r.invoiceNo,
            bucket: r.bucket, points: r.points, reason: r.reason, snapshot: r.snapshot,
            idempotencyKey: r.idempotencyKey, createdBy: actor,
          })),
          { session, ordered: true },
        );
        await LoyaltyAccount.updateOne({ _id: accountOid }, { $inc: inc }, { session });
      });
      rowsWritten += rows.length;
    } catch (e) {
      if (!isDupKey(e)) throw e;
      conflicts += 1;
    } finally {
      await session.endSession();
    }
  }

  await LoyaltyAccount.updateOne(
    { _id: accountOid },
    { $set: { cumulativeInr: plan.cumulativeInr, lastReconciledAt: new Date() } },
  );
  return { rowsWritten, conflicts };
}

/* ── Reconcile (lease-guarded) ─────────────────────────────────────── */

export type ReconcileResult =
  | { accountId: string; skipped: "programme-disabled" | "locked" | "not-found" }
  | {
      accountId: string;
      skipped?: undefined;
      passes: number;
      rowsWritten: number;
      conflicts: number;
      cumulativeInr: number;
      eligibleAt: Date | null;
      balances: LoyaltyBalances;
    };

/**
 * Brings one account's ledger to its target state. One reconcile per account
 * at a time: a lease (lockedUntil/lockOwner, claimed with findOneAndUpdate)
 * guards the run, and the unique idempotency key is the second guard. A caller
 * that finds the lease taken asks the holder for one more pass
 * (rerunRequested) instead of waiting, so its change is never lost.
 */
export async function reconcileAccount(
  accountId: unknown,
  opts: { actor?: string; reasonHint?: LoyaltyReason; settings?: LoyaltySettingsValues } = {},
): Promise<ReconcileResult> {
  const id = String(accountId ?? "");
  if (!isOid(id)) return { accountId: id, skipped: "not-found" };
  const settings = opts.settings ?? (await getLoyaltySettings());
  if (!settings.programmeEnabled) return { accountId: id, skipped: "programme-disabled" };

  const oid = new mongoose.Types.ObjectId(id);
  const owner = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
  const now = new Date();
  const claimed = await LoyaltyAccount.findOneAndUpdate(
    { _id: oid, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS), lockOwner: owner, rerunRequested: false } },
    { new: true },
  ).lean();
  if (!claimed) {
    const r = await LoyaltyAccount.updateOne({ _id: oid }, { $set: { rerunRequested: true } });
    return { accountId: id, skipped: r.matchedCount ? "locked" : "not-found" };
  }

  let passes = 0;
  let rowsWritten = 0;
  let conflicts = 0;
  let plan: AccountPlan | null = null;
  try {
    for (;;) {
      passes += 1;
      const account: any = await LoyaltyAccount.findById(oid).lean();
      if (!account) return { accountId: id, skipped: "not-found" };
      plan = await planAccount(account, settings, { reasonHint: opts.reasonHint });
      const r = await applyPlan(plan, opts.actor ?? SYSTEM);
      rowsWritten += r.rowsWritten;
      conflicts += r.conflicts;
      // Someone touched the account mid-run, or a pass lost a race: go again.
      const again = await LoyaltyAccount.findOneAndUpdate(
        { _id: oid, lockOwner: owner, rerunRequested: true },
        { $set: { rerunRequested: false, lockedUntil: new Date(Date.now() + LEASE_MS) } },
      ).lean();
      if ((!again && !r.conflicts) || passes >= MAX_PASSES) break;
    }
  } finally {
    await LoyaltyAccount.updateOne({ _id: oid, lockOwner: owner }, { $set: { lockedUntil: null, lockOwner: null } });
  }

  const after: any = await LoyaltyAccount.findById(oid).select("balances eligibleAt cumulativeInr").lean();
  return {
    accountId: id, passes, rowsWritten, conflicts,
    cumulativeInr: after?.cumulativeInr ?? plan?.cumulativeInr ?? 0,
    eligibleAt: after?.eligibleAt ?? null,
    balances: after?.balances ?? { onTheWay: 0, locked: 0, ready: 0 },
  };
}

/* ── Touch (the one-line call after every finance write) ───────────── */

const pending = new Set<Promise<void>>();

/** Resolves when every touch started so far has finished (tests, graceful stop). */
export async function loyaltyIdle(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * Re-reconciles the account(s) an invoice or credit note belongs to, in the
 * background. Call it AFTER the finance write has committed. Never throws,
 * never awaited by the caller, logs its own failures.
 */
export function loyaltyTouch(ref: { invoiceId?: unknown; creditNoteId?: unknown }): void {
  inBackground("touch", () => touchNow(ref), {
    invoiceId: String(ref?.invoiceId ?? ""), creditNoteId: String(ref?.creditNoteId ?? ""),
  });
}

/** Reconciles every account in the background (after a settings change). Never throws. */
export function loyaltyReconcileAllInBackground(actor = SYSTEM): void {
  inBackground("reconcile-all", () => reconcileAll(actor), { actor });
}

function inBackground(label: string, fn: () => Promise<unknown>, meta: Record<string, unknown>): void {
  try {
    const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(fn)
      .then(() => undefined)
      .catch((err: any) => { logger.error(`[Loyalty] ${label} failed`, { ...meta, message: err?.message }); })
      .finally(() => { pending.delete(p); });
    pending.add(p);
  } catch (err: any) {
    try { logger.error(`[Loyalty] ${label} could not start`, { message: err?.message }); } catch { /* never throw */ }
  }
}

/** The awaited body of loyaltyTouch. Throws on failure — loyaltyTouch catches. */
export async function touchNow(ref: { invoiceId?: unknown; creditNoteId?: unknown }): Promise<ReconcileResult[]> {
  let invoiceId = ref.invoiceId ? String(ref.invoiceId) : "";
  if (!invoiceId && ref.creditNoteId && isOid(ref.creditNoteId)) {
    const cn: any = await CreditNote.collection.findOne(
      { _id: new mongoose.Types.ObjectId(String(ref.creditNoteId)) },
      { projection: { originalInvoiceId: 1 } },
    );
    invoiceId = cn?.originalInvoiceId ? String(cn.originalInvoiceId) : "";
  }
  if (!isOid(invoiceId)) return [];

  const settings = await getLoyaltySettings();
  if (!settings.programmeEnabled) return [];

  const accountIds = new Set<string>();
  const inv: any = await Invoice.collection.findOne(
    { _id: new mongoose.Types.ObjectId(invoiceId) },
    { projection: { workspaceId: 1, isDemo: 1 } },
  );
  if (inv && inv.isDemo !== true) {
    const customerId = await customerIdForWorkspace(inv.workspaceId);
    const acct = customerId ? await ensureAccountForCustomer(customerId) : null;
    if (acct) accountIds.add(String(acct._id));
  }
  // An account still holding points for this invoice (it moved, or stopped counting).
  for (const a of await LoyaltyLedger.distinct("accountId", { invoiceId })) accountIds.add(String(a));

  const results: ReconcileResult[] = [];
  for (const a of accountIds) results.push(await reconcileAccount(a, { settings }));
  return results;
}

/* ── Accounts for customers that have counted invoices ─────────────── */

/** Customer._ids with at least one counted, non-demo invoice and no loyalty account. HOUSE excluded. */
export async function customersMissingAccounts(): Promise<string[]> {
  const wsIds = await Invoice.collection.distinct("workspaceId", {
    status: { $in: [...COUNTED_STATUSES] }, isDemo: { $ne: true },
  });
  const wsRows: any[] = await CustomerWorkspace.collection
    .find({ _id: { $in: wsIds.filter((w: any) => isOid(w)).map((w: any) => new mongoose.Types.ObjectId(String(w))) } },
      { projection: { customerId: 1 } })
    .toArray();
  const wsToCustomer = new Map(wsRows.map((w) => [String(w._id), String(w.customerId)]));
  const house = await houseCustomerId();
  const customers = new Set<string>();
  for (const w of wsIds) {
    const k = String(w);
    if (k === HOUSE_WORKSPACE_ID) continue;
    const c = wsToCustomer.get(k) ?? k;
    if (c && c !== house) customers.add(c);
  }
  const members = new Set((await LoyaltyAccount.distinct("memberCustomerIds")).map(String));
  return [...customers].filter((c) => !members.has(c)).sort();
}

export async function createMissingAccounts(actor = SYSTEM): Promise<number> {
  let created = 0;
  for (const c of await customersMissingAccounts()) {
    const before = await LoyaltyAccount.exists({ memberCustomerIds: c });
    if (before) continue;
    if (await ensureAccountForCustomer(c, actor)) created += 1;
  }
  return created;
}

/* ── Reconcile everything (sweep, settings change, script) ─────────── */

export interface ReconcileAllSummary {
  accountsCreated: number;
  accountsReconciled: number;
  accountsSkipped: number;
  rowsWritten: number;
  errorCount: number;
}

export async function reconcileAll(actor = SYSTEM): Promise<ReconcileAllSummary> {
  const sum: ReconcileAllSummary = { accountsCreated: 0, accountsReconciled: 0, accountsSkipped: 0, rowsWritten: 0, errorCount: 0 };
  const settings = await getLoyaltySettings();
  if (!settings.programmeEnabled) return sum;
  sum.accountsCreated = await createMissingAccounts(actor);
  const ids = (await LoyaltyAccount.find({}).select("_id").lean()).map((a: any) => String(a._id));
  for (const id of ids) {
    try {
      const r = await reconcileAccount(id, { actor, settings });
      if ("rowsWritten" in r) { sum.accountsReconciled += 1; sum.rowsWritten += r.rowsWritten; }
      else sum.accountsSkipped += 1;
    } catch (err: any) {
      sum.errorCount += 1;
      logger.error("[Loyalty] reconcile failed", { accountId: id, message: err?.message });
    }
  }
  return sum;
}

/* ── Daily sweep ───────────────────────────────────────────────────── */

export type SweepResult = { claimed: false; runKey: string } | ({ claimed: true; runKey: string; durationMs: number } & ReconcileAllSummary);

/**
 * The daily safety net. The run is claimed by inserting its unique runKey
 * (IST date), so with several backend instances exactly one sweeps; the
 * finished row is the checkpoint.
 */
export async function runLoyaltySweep(opts: { now?: Date; runKey?: string } = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const runKey = opts.runKey ?? `daily:${todayIST(now)}`;
  try {
    await LoyaltySweepRun.create({ runKey, host: `${os.hostname()}:${process.pid}`, startedAt: now });
  } catch (e) {
    if (isDupKey(e)) return { claimed: false, runKey };
    throw e;
  }
  const t0 = Date.now();
  try {
    const sum = await reconcileAll(SYSTEM);
    const durationMs = Date.now() - t0;
    await LoyaltySweepRun.updateOne({ runKey }, { $set: { status: "DONE", finishedAt: new Date(), durationMs, ...sum } });
    return { claimed: true, runKey, durationMs, ...sum };
  } catch (err: any) {
    await LoyaltySweepRun.updateOne(
      { runKey },
      { $set: { status: "FAILED", finishedAt: new Date(), durationMs: Date.now() - t0, error: String(err?.message ?? err) } },
    );
    throw err;
  }
}

/* ── Staff actions (admin routes) ──────────────────────────────────── */

export class LoyaltyError extends Error {
  constructor(readonly httpStatus: number, message: string) {
    super(message);
    this.name = "LoyaltyError";
  }
}

/**
 * Moves a customer into `accountId` (out of whatever account held it), then
 * reconciles both, so its invoices' points move with it as ACCOUNT_LINK rows.
 */
export async function linkCustomer(accountId: string, customerId: string, actor: string): Promise<{ fromAccountId: string | null }> {
  const cid = String(customerId || "");
  if (!isOid(accountId)) throw new LoyaltyError(404, "Account not found");
  if (!isOid(cid) || !(await Customer.exists({ _id: cid }))) throw new LoyaltyError(404, "Customer not found");
  if (await isHouseCustomer(cid)) throw new LoyaltyError(400, "The Plumtrips HOUSE customer cannot join a loyalty account.");
  const target = await LoyaltyAccount.findById(accountId);
  if (!target) throw new LoyaltyError(404, "Account not found");
  if (target.memberCustomerIds.includes(cid)) throw new LoyaltyError(400, "This customer is already a member of the account.");

  const from = await LoyaltyAccount.findOne({ memberCustomerIds: cid });
  const at = new Date();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (from) {
        await LoyaltyAccount.updateOne(
          { _id: from._id },
          { $pull: { memberCustomerIds: cid }, $push: { changeLog: { at, by: actor, field: "memberCustomerIds", old: cid, new: null, reason: `moved to account ${accountId}` } } },
          { session },
        );
      }
      await LoyaltyAccount.updateOne(
        { _id: target._id },
        { $addToSet: { memberCustomerIds: cid }, $push: { changeLog: { at, by: actor, field: "memberCustomerIds", old: null, new: cid, reason: from ? `moved from account ${from._id}` : "linked" } } },
        { session },
      );
    });
  } catch (e) {
    if (isDupKey(e)) throw new LoyaltyError(409, "The customer was linked elsewhere at the same moment. Refresh and try again.");
    throw e;
  } finally {
    await session.endSession();
  }
  if (from) await reconcileAccount(from._id, { actor, reasonHint: "ACCOUNT_LINK" });
  await reconcileAccount(target._id, { actor, reasonHint: "ACCOUNT_LINK" });
  return { fromAccountId: from ? String(from._id) : null };
}

/** Takes a customer out of `accountId` into a new account of its own, reconciling both. */
export async function unlinkCustomer(accountId: string, customerId: string, actor: string): Promise<{ newAccountId: string }> {
  const cid = String(customerId || "");
  const from = isOid(accountId) ? await LoyaltyAccount.findById(accountId) : null;
  if (!from) throw new LoyaltyError(404, "Account not found");
  if (!from.memberCustomerIds.includes(cid)) throw new LoyaltyError(400, "This customer is not a member of the account.");
  if (from.memberCustomerIds.length === 1) throw new LoyaltyError(400, "This is the account's only member; it already is the customer's own account.");

  await LoyaltyAccount.updateOne(
    { _id: from._id },
    { $pull: { memberCustomerIds: cid }, $push: { changeLog: { at: new Date(), by: actor, field: "memberCustomerIds", old: cid, new: null, reason: "unlinked" } } },
  );
  const own = await ensureAccountForCustomer(cid, actor);
  await reconcileAccount(from._id, { actor, reasonHint: "ACCOUNT_LINK" });
  if (own) await reconcileAccount(own._id, { actor, reasonHint: "ACCOUNT_LINK" });
  return { newAccountId: own ? String(own._id) : "" };
}

/**
 * A staff adjustment (MANUAL rows), moved with its balance in one transaction.
 * The bucket follows eligibility — staff do not choose it:
 *   positive  → READY if the account is eligible, else LOCKED (and LOCKED
 *               manual points unlock with the invoice points, planAccount)
 *   negative  → taken from READY first, then LOCKED; never more than the two hold
 */
export async function manualAdjust(
  accountId: string,
  input: { points: unknown; reason: unknown; idempotencyKey?: unknown; bucket?: unknown },
  actor: string,
): Promise<{ duplicate: boolean; moves: Array<{ bucket: LoyaltyBucket; points: number }> }> {
  if (input.bucket !== undefined) throw new LoyaltyError(400, "The bucket is not chosen: it follows the account's eligibility.");
  const points = Number(input.points);
  if (!Number.isInteger(points) || points === 0) throw new LoyaltyError(400, "Points must be a whole number other than 0.");
  const reason = String(input.reason ?? "").trim();
  if (!reason) throw new LoyaltyError(400, "A reason is required for a manual adjustment.");
  if (!isOid(accountId) || !(await LoyaltyAccount.exists({ _id: accountId }))) throw new LoyaltyError(404, "Account not found");
  const key = `manual:${String(input.idempotencyKey ?? "").trim() || crypto.randomUUID()}`;

  let moves: Array<{ bucket: LoyaltyBucket; points: number }> = [];
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Read inside the transaction: a concurrent balance move conflicts and retries.
      const acct: any = await LoyaltyAccount.findById(accountId).session(session).lean();
      if (points > 0) {
        moves = [{ bucket: acct.eligibleAt ? "READY" : "LOCKED", points }];
      } else {
        const need = -points;
        const ready = Math.max(0, acct.balances?.ready ?? 0);
        const locked = Math.max(0, acct.balances?.locked ?? 0);
        if (need > ready + locked) {
          throw new LoyaltyError(400, `Cannot remove ${need} points: the account holds ${ready} ready and ${locked} locked.`);
        }
        const fromReady = Math.min(need, ready);
        moves = [
          ...(fromReady ? [{ bucket: "READY" as const, points: -fromReady }] : []),
          ...(need - fromReady ? [{ bucket: "LOCKED" as const, points: -(need - fromReady) }] : []),
        ];
      }
      await LoyaltyLedger.create(
        moves.map((m, i) => ({
          accountId: String(acct._id), bucket: m.bucket, points: m.points, reason: "MANUAL", note: reason,
          idempotencyKey: i === 0 ? key : `${key}:${i + 1}`, createdBy: actor,
        })),
        { session, ordered: true },
      );
      const inc: Record<string, number> = {};
      for (const m of moves) inc[`balances.${BALANCE_FIELD[m.bucket]}`] = m.points;
      await LoyaltyAccount.updateOne({ _id: acct._id }, { $inc: inc }, { session });
    });
    return { duplicate: false, moves };
  } catch (e) {
    if (isDupKey(e)) return { duplicate: true, moves: [] };
    throw e;
  } finally {
    await session.endSession();
  }
}

/** Points that disabling the account would remove: its invoice holdings per bucket (manual rows stay). */
export async function invoiceHoldings(accountId: string): Promise<LoyaltyBalances> {
  const rows: any[] = await LoyaltyLedger.aggregate([
    { $match: { accountId: String(accountId), invoiceId: { $ne: null } } },
    { $group: { _id: "$bucket", points: { $sum: "$points" } } },
  ]);
  const out: LoyaltyBalances = { onTheWay: 0, locked: 0, ready: 0 };
  for (const r of rows) out[BALANCE_FIELD[r._id as LoyaltyBucket]] = r.points;
  return out;
}

/** Other customers sharing a member's PAN (Customer.panNumber, or GSTIN characters 3–12). */
export async function panSuggestions(memberCustomerIds: string[]): Promise<Array<{ customerId: string; name: string; pan: string; accountId: string | null }>> {
  const ids = memberCustomerIds.filter(isOid).map((c) => new mongoose.Types.ObjectId(c));
  if (!ids.length) return [];
  const members: any[] = await Customer.collection.find({ _id: { $in: ids } }, { projection: { panNumber: 1, gstNumber: 1 } }).toArray();
  const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
  const pans = new Set<string>();
  for (const m of members) {
    for (const p of [m.panNumber, String(m.gstNumber || "").slice(2, 12)]) {
      const v = String(p || "").trim().toUpperCase();
      if (PAN_RE.test(v)) pans.add(v);
    }
  }
  if (!pans.size) return [];
  const list = [...pans];
  const others: any[] = await Customer.collection
    .find(
      {
        _id: { $nin: ids },
        $or: [{ panNumber: { $in: list } }, { gstNumber: { $regex: `^.{2}(${list.join("|")})`, $options: "i" } }],
      },
      { projection: { name: 1, legalName: 1, companyName: 1, panNumber: 1, gstNumber: 1 } },
    )
    .limit(50)
    .toArray();
  const accounts: any[] = await LoyaltyAccount.find({ memberCustomerIds: { $in: others.map((o) => String(o._id)) } })
    .select("_id memberCustomerIds").lean();
  const accountOf = new Map<string, string>();
  for (const a of accounts) for (const m of a.memberCustomerIds) accountOf.set(String(m), String(a._id));
  return others.map((o) => {
    const pan = PAN_RE.test(String(o.panNumber || "").toUpperCase()) ? String(o.panNumber).toUpperCase() : String(o.gstNumber || "").slice(2, 12).toUpperCase();
    return { customerId: String(o._id), name: customerDisplayName(o, String(o._id)), pan, accountId: accountOf.get(String(o._id)) ?? null };
  });
}
