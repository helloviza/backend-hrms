// apps/backend/src/services/loyaltyClient.ts
//
// Plumtrips Rewards — the client's read-only view of its loyalty account
// (loyalty Phase 2, PRD v1.1 §13). Served by routes/myRewards.ts.
//
// SCOPE. Every function takes the caller's OWN customerId (the resolved
// workspace's customerId — never a request parameter) and reads only the one
// LoyaltyAccount that lists it as a member. A multi-member account is shown
// whole, with its member names; nothing else is ever reachable.
//
// READ-ONLY. Nothing here creates an account or writes a row: a customer with
// no account yet (no counted invoice so far) reads as zeros.
//
// WHAT A CLIENT NEVER SEES: reason codes, staff notes, who made a change,
// idempotency keys, snapshots, internal account settings. History rows are
// grouped into client events and labelled from the movement itself.
import mongoose from "mongoose";
import Customer from "../models/Customer.js";
import Invoice from "../models/Invoice.js";
import LoyaltyAccount from "../models/LoyaltyAccount.js";
import LoyaltyLedger, { type LoyaltyBucket } from "../models/LoyaltyLedger.js";
import { normalizeGstStatus } from "../utils/customerGst.js";
import { getLoyaltySettings, effectiveStartDate, isEnrolled, houseCustomerId } from "./loyalty.js";

export const PROGRAMME_NAME = "Plumtrips Rewards";

const isOid = (v: unknown) => mongoose.Types.ObjectId.isValid(String(v ?? "")) && String(v).length === 24;
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export type NotEnrolledReason = "NO_GSTIN" | "UNREGISTERED" | "ACCOUNT_PAUSED" | "NOT_A_CLIENT";

export interface RewardsSummary {
  programmeName: string;
  programmeActive: boolean;
  startDate: Date;
  started: boolean;
  enrolled: boolean;
  notEnrolledReason: NotEnrolledReason | null;
  balances: { ready: number; onTheWay: number; locked: number; total: number };
  eligible: boolean;
  eligibleAt: Date | null;
  cumulativeInr: number;
  thresholdInr: number;
  remainingToThresholdInr: number;
  /** False = clients are told "Using points opens soon" instead of the usage cap. */
  redemptionOpen: boolean;
  usageCapPct: number;
  minRedemption: number;
  validityMonths: number;
  pointsPer100: number;
  linkedEntities: Array<{ name: string; isYou: boolean }>;
}

async function accountFor(customerId: string): Promise<any | null> {
  if (!customerId) return null;
  return LoyaltyAccount.findOne({ memberCustomerIds: customerId })
    .select("memberCustomerIds enabled startDateOverride capPctOverride eligibleAt cumulativeInr balances")
    .lean();
}

async function names(customerIds: string[]): Promise<Map<string, string>> {
  const oids = customerIds.filter(isOid).map((c) => new mongoose.Types.ObjectId(c));
  const rows: any[] = oids.length
    ? await Customer.collection.find({ _id: { $in: oids } }, { projection: { legalName: 1, companyName: 1, name: 1 } }).toArray()
    : [];
  return new Map(rows.map((c) => [String(c._id), String(c.legalName || c.companyName || c.name || "").trim()]));
}

export async function rewardsSummary(customerId: string, now = new Date()): Promise<RewardsSummary> {
  const cid = String(customerId || "");
  const settings = await getLoyaltySettings();
  const house = await houseCustomerId();
  const acct = cid && cid !== house ? await accountFor(cid) : null;
  const customer: any = isOid(cid)
    ? await Customer.collection.findOne({ _id: new mongoose.Types.ObjectId(cid) }, { projection: { gstStatus: 1, gstNumber: 1, gstin: 1 } })
    : null;

  let notEnrolledReason: NotEnrolledReason | null = null;
  if (!customer || cid === house) notEnrolledReason = "NOT_A_CLIENT";
  else if (acct && acct.enabled === false) notEnrolledReason = "ACCOUNT_PAUSED";
  else if (!isEnrolled(customer, settings)) {
    notEnrolledReason = normalizeGstStatus(customer.gstStatus) === "UNREGISTERED" ? "UNREGISTERED" : "NO_GSTIN";
  }

  const b = acct?.balances ?? { ready: 0, onTheWay: 0, locked: 0 };
  const balances = { ready: b.ready || 0, onTheWay: b.onTheWay || 0, locked: b.locked || 0, total: 0 };
  balances.total = balances.ready + balances.onTheWay + balances.locked;
  const cumulativeInr = r2(acct?.cumulativeInr ?? 0);
  const startDate = effectiveStartDate(acct ?? {}, settings);
  const members: string[] = (acct?.memberCustomerIds ?? (cid ? [cid] : [])).map(String);
  const nameOf = await names(members);
  const rates = [...(settings.rateHistory || [])].sort((x, y) => +new Date(x.effectiveFrom) - +new Date(y.effectiveFrom));
  const current = rates.filter((r) => +new Date(r.effectiveFrom) <= +now).pop() ?? rates[0];

  return {
    programmeName: PROGRAMME_NAME,
    programmeActive: settings.programmeEnabled !== false,
    startDate,
    started: now.getTime() >= startDate.getTime(),
    enrolled: !notEnrolledReason,
    notEnrolledReason,
    balances,
    eligible: !!acct?.eligibleAt,
    eligibleAt: acct?.eligibleAt ?? null,
    cumulativeInr,
    thresholdInr: settings.thresholdInr,
    remainingToThresholdInr: Math.max(0, r2(settings.thresholdInr - cumulativeInr)),
    redemptionOpen: settings.redemptionOpen === true,
    usageCapPct: acct?.capPctOverride ?? settings.defaultCapPct,
    minRedemption: settings.minRedemption,
    validityMonths: settings.validityMonths,
    pointsPer100: current?.pointsPer100 ?? 1,
    linkedEntities: members.map((m) => ({ name: nameOf.get(m) || "Your company", isYou: m === cid })),
  };
}

/* ── Invoices whose points are on the way ──────────────────────────── */

export interface PendingInvoice {
  invoiceId: string;
  invoiceNo: string;
  invoiceDate: Date | null;
  amountBeforeGstInr: number;
  points: number;
  status: "AWAITING_PAYMENT" | "PAYMENT_BEING_CONFIRMED";
  dueDate: Date | null;
  overdue: boolean;
  validUntil: Date | null;
  /** The portal's Invoices tab lists only invoices keyed on THIS workspace's _id (audit L4). */
  canOpen: boolean;
}

/** `months` calendar months after `d`, clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/** The first time each invoice's points were recorded (any account), for "valid until". */
async function firstRecorded(invoiceIds: string[]): Promise<Map<string, Date>> {
  if (!invoiceIds.length) return new Map();
  const rows: any[] = await LoyaltyLedger.aggregate([
    { $match: { invoiceId: { $in: invoiceIds }, points: { $gt: 0 } } },
    { $group: { _id: "$invoiceId", at: { $min: "$createdAt" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), new Date(r.at)]));
}

export async function pendingInvoices(customerId: string, workspaceId: string, now = new Date()): Promise<PendingInvoice[]> {
  const acct = await accountFor(String(customerId || ""));
  if (!acct) return [];
  const settings = await getLoyaltySettings();
  const holdings: any[] = await LoyaltyLedger.aggregate([
    { $match: { accountId: String(acct._id), invoiceId: { $ne: null }, bucket: "ON_THE_WAY" } },
    { $group: { _id: "$invoiceId", points: { $sum: "$points" } } },
    { $match: { points: { $gt: 0 } } },
  ]);
  const ids = holdings.map((h) => String(h._id)).filter(isOid);
  if (!ids.length) return [];
  const [invoices, first] = await Promise.all([
    Invoice.collection
      .find({ _id: { $in: ids.map((i) => new mongoose.Types.ObjectId(i)) } },
        { projection: { invoiceNo: 1, invoiceDate: 1, dueDate: 1, status: 1, grandTotal: 1, totalGST: 1, workspaceId: 1 } })
      .toArray(),
    firstRecorded(ids),
  ]);
  const invById = new Map(invoices.map((i: any) => [String(i._id), i]));
  const ws = String(workspaceId || "");
  return holdings
    .map((h): PendingInvoice | null => {
      const inv: any = invById.get(String(h._id));
      if (!inv) return null;
      const due = inv.dueDate ? new Date(inv.dueDate) : null;
      const recorded = first.get(String(h._id));
      return {
        invoiceId: String(inv._id),
        invoiceNo: String(inv.invoiceNo || ""),
        invoiceDate: inv.invoiceDate ? new Date(inv.invoiceDate) : null,
        amountBeforeGstInr: r2((Number(inv.grandTotal) || 0) - (Number(inv.totalGST) || 0)),
        points: h.points,
        status: inv.status === "PAYMENT_DECLARED" ? "PAYMENT_BEING_CONFIRMED" : "AWAITING_PAYMENT",
        dueDate: due,
        overdue: !!due && due.getTime() < now.getTime(),
        validUntil: recorded ? addMonths(recorded, settings.validityMonths) : null,
        // /api/invoices/workspace/mine matches workspaceId === req.workspaceObjectId exactly.
        canOpen: inv.workspaceId instanceof mongoose.Types.ObjectId && String(inv.workspaceId) === ws,
      };
    })
    .filter((x): x is PendingInvoice => !!x)
    .sort((a, b) => (b.invoiceDate?.getTime() ?? 0) - (a.invoiceDate?.getTime() ?? 0));
}

/* ── History ───────────────────────────────────────────────────────── */

export type HistoryLabel =
  | "Earned"
  | "Invoice paid"
  | "Unlocked"
  | "Reduced by credit note"
  | "Restored (credit note cancelled)"
  | "Reversed (invoice cancelled or reverted)"
  | "Moved back to on the way"
  | "Adjustment by Plumtrips";

export interface HistoryEvent {
  at: Date;
  label: HistoryLabel;
  /** Net change to the account's total (0 when points only moved between buckets). */
  points: number;
  /** Points that changed bucket inside the account (paid, unlocked, moved back); 0 otherwise. */
  moved: number;
  /** Per bucket: what this event added (+) or took away (−). */
  change: { ready: number; onTheWay: number; locked: number };
  invoiceNo: string | null;
}

type Change = HistoryEvent["change"];

/**
 * The client label for one event, from its reason and its movement alone.
 * A movement inside the account (net 0) is described by where the points went.
 */
export function historyLabel(reason: string, c: Change): HistoryLabel {
  const net = c.ready + c.onTheWay + c.locked;
  if (reason === "MANUAL" || reason === "ACCOUNT_LINK") return "Adjustment by Plumtrips";
  if (reason === "ELIGIBILITY_UNLOCK") return "Unlocked";
  if (reason === "EARN") return net < 0 ? "Reversed (invoice cancelled or reverted)" : "Earned";
  if (reason === "CREDIT_NOTE") return net < 0 ? "Reduced by credit note" : "Restored (credit note cancelled)";
  // STATUS_CHANGE / RECONCILE: read the movement.
  if (net < 0) return "Reversed (invoice cancelled or reverted)";
  if (net > 0) return "Earned";
  if (c.onTheWay > 0) return "Moved back to on the way";
  if (c.locked < 0 && c.ready > 0) return "Unlocked";
  return "Invoice paid";
}

const FIELD: Record<LoyaltyBucket, keyof Change> = { ON_THE_WAY: "onTheWay", LOCKED: "locked", READY: "ready" };

/**
 * Paged events, newest first. Rows one write produced (an invoice's bucket
 * moves in one transaction, a manual adjustment split over two buckets) share
 * invoice, reason, snapshot (or staff note) and second, and are shown as ONE
 * event. The snapshot keeps two writes in the same second apart (paid, then
 * reverted) — merged, they would net to nothing. Grouped on, never returned.
 */
export async function rewardsHistory(
  customerId: string,
  opts: { page?: number; limit?: number } = {},
): Promise<{ events: HistoryEvent[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, Math.floor(Number(opts.page) || 1));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(opts.limit) || 20)));
  const acct = await accountFor(String(customerId || ""));
  if (!acct) return { events: [], total: 0, page, totalPages: 0 };

  const sec = { $subtract: [{ $toLong: "$createdAt" }, { $mod: [{ $toLong: "$createdAt" }, 1000] }] };
  const [res]: any[] = await LoyaltyLedger.aggregate([
    { $match: { accountId: String(acct._id) } },
    {
      $group: {
        _id: { inv: "$invoiceId", reason: "$reason", snap: "$snapshot", note: "$note", by: "$createdBy", sec },
        at: { $max: "$createdAt" },
        invoiceNo: { $last: "$invoiceNo" },
        moves: { $push: { b: "$bucket", p: "$points" } },
      },
    },
    { $sort: { at: -1, "_id.inv": 1 } },
    {
      $facet: {
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ]);
  const rows: any[] = res?.rows ?? [];
  const total = res?.total?.[0]?.n ?? 0;

  // Current invoice numbers (a row's invoiceNo is a snapshot; scripts renumber).
  const invIds = [...new Set(rows.map((r) => r._id.inv).filter(isOid))] as string[];
  const invs: any[] = invIds.length
    ? await Invoice.collection.find({ _id: { $in: invIds.map((i) => new mongoose.Types.ObjectId(i)) } }, { projection: { invoiceNo: 1 } }).toArray()
    : [];
  const noById = new Map(invs.map((i) => [String(i._id), String(i.invoiceNo || "")]));

  const events: HistoryEvent[] = rows
    .map((r) => {
      const change: Change = { ready: 0, onTheWay: 0, locked: 0 };
      for (const m of r.moves) change[FIELD[m.b as LoyaltyBucket]] += Number(m.p) || 0;
      const net = change.ready + change.onTheWay + change.locked;
      return {
        at: new Date(r.at),
        label: historyLabel(String(r._id.reason), change),
        points: net,
        moved: net === 0 ? Math.max(0, ...Object.values(change)) : 0,
        change,
        invoiceNo: r._id.inv ? noById.get(String(r._id.inv)) || r.invoiceNo || null : null,
      };
    })
    .filter((e) => e.change.ready || e.change.onTheWay || e.change.locked);
  return { events, total, page, totalPages: Math.ceil(total / limit) };
}
