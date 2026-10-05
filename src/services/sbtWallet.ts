// SBT Business Wallet — a CREDIT LINE per company.
//
//   creditLimit   set by Plumtrips (Super Admin), changes logged with a reason
//   used          outstanding: bookings in, cancellation refunds / payments /
//                 credit adjustments out — the exact sum of the ledger
//   available     creditLimit − used; a wallet booking needs amount ≤ available
//
// Bookings and refunds move `used` in services/sbtPaymentGate.ts
// (reserveOfficial — one conditional update, so concurrent bookings can never
// overspend — and creditOfficial). This file holds the Super Admin actions
// (payment received, adjustment, limit change), the ≥80% usage email, and the
// statement: ledger rows with booking / traveller / trip / booked-by read at
// display time from the payment row and the booking — selling amounts only,
// never our net, margin or commission.
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import SBTWalletLedger, {
  WALLET_ENTRY_TYPES,
  WALLET_PAYMENT_MODES,
  type WalletEntryType,
  type WalletPaymentMode,
} from "../models/SBTWalletLedger.js";
import SBTPayment from "../models/SBTPayment.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import { userNames, nameOrUnknown, DESK_EMAIL } from "./actorNames.js";
import { activeLeaderEmails, inactiveEmails } from "./approvalDeciders.js";
import { enqueueEmail } from "./emailOutbox.js";
import { buildEmailShell } from "../routes/approvals.email.js";
import { istDayStart, addDays } from "../utils/dateRange.js";
import { sbtLogger } from "../utils/logger.js";
import { companyNameFor } from "./companyNames.js";

type AnyObj = Record<string, any>;

export const USAGE_ALERT_RATIO = 0.8;
/** Adjustment wording for Plumtrips staff: the House panel, the staff statement and staff downloads. */
export const ADJUSTMENT_LABEL = { CREDIT: "Reduce what they owe (credit)", DEBIT: "Add to what they owe (debit)" } as const;
/** The same adjustments as the company sees them: their statement, downloads and emails. */
export const CUSTOMER_ADJUSTMENT_LABEL = { CREDIT: "Credit — reduces what you owe", DEBIT: "Charge — adds to what you owe" } as const;
export const adjustmentLabel = (direction: "CREDIT" | "DEBIT", staff: boolean) =>
  (staff ? ADJUSTMENT_LABEL : CUSTOMER_ADJUSTMENT_LABEL)[direction];
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v) || 0;
const monthKeyNow = () => new Date().toISOString().slice(0, 7);
const inr = (n: number) => `₹${round2(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/* ───────────────────────── balance ───────────────────────── */

export interface WalletState {
  enabled: boolean;
  creditLimit: number;
  used: number;
  available: number;
  usagePct: number;
  lastPaymentAt: Date | null;
}

export function walletState(ws: AnyObj | null | undefined): WalletState {
  const ob = ws?.sbtOfficialBooking || {};
  const creditLimit = round2(num(ob.creditLimit));
  const used = round2(num(ob.used));
  return {
    enabled: ob.enabled === true,
    creditLimit,
    used,
    available: round2(creditLimit - used),
    usagePct: creditLimit > 0 ? Math.round((used / creditLimit) * 1000) / 10 : used > 0 ? 100 : 0,
    lastPaymentAt: ob.lastPaymentAt || null,
  };
}

export async function walletStateOf(workspaceId: unknown): Promise<WalletState> {
  const ws = (await CustomerWorkspace.findById(String(workspaceId)).select("sbtOfficialBooking").lean()) as AnyObj | null;
  return walletState(ws);
}

/** Move `used` by `delta` and return the new value (no limit check — callers decide). */
async function moveUsed(workspaceId: unknown, delta: number): Promise<number> {
  const ws = (await CustomerWorkspace.findOneAndUpdate(
    { _id: String(workspaceId) },
    { $inc: { "sbtOfficialBooking.used": round2(delta) } },
    { new: true, runValidators: false },
  ).select("sbtOfficialBooking.used").lean()) as AnyObj | null;
  return round2(num(ws?.sbtOfficialBooking?.used));
}

/* ───────────────────────── migration from the monthly model ───────────────────────── */

/** `used` recomputed from the ledger: Σ DEBIT − Σ CREDIT, test-flagged rows excluded. */
export async function ledgerUsed(workspaceId: unknown): Promise<{ used: number; debits: number; credits: number; testRows: number }> {
  const agg = (await SBTWalletLedger.aggregate([
    { $match: { workspaceId: String(workspaceId) } },
    { $group: {
      _id: { test: { $eq: ["$isTest", true] }, type: "$type" },
      sum: { $sum: "$amount" },
      n: { $sum: 1 },
    } },
  ])) as AnyObj[];
  let debits = 0, credits = 0, testRows = 0;
  for (const g of agg) {
    if (g._id.test) { testRows += g.n; continue; }
    if (g._id.type === "DEBIT") debits += num(g.sum);
    if (g._id.type === "CREDIT") credits += num(g.sum);
  }
  return { used: round2(debits - credits), debits: round2(debits), credits: round2(credits), testRows };
}

/**
 * The credit line a company starts with: creditLimit = its old monthlyLimit
 * (0 stays 0 — the old "0 = unlimited" ends, a limit must be set), used = the
 * ledger's outstanding. Already ≥80% used → the alert flag starts set (no email
 * for a crossing that happened before the credit line existed).
 */
export function creditLineFromLegacy(ob: AnyObj | null | undefined, used: number) {
  const creditLimit = Math.max(0, round2(num(ob?.monthlyLimit)));
  return {
    creditLimit,
    used: round2(used),
    usageAlertSent: creditLimit > 0 && used >= creditLimit * USAGE_ALERT_RATIO,
    wasUnlimited: ob?.enabled === true && !(num(ob?.monthlyLimit) > 0),
  };
}

/* ───────────────────────── the 80% email ───────────────────────── */

/**
 * After any move of `used`: once usage reaches 80% of the limit, email the
 * company's Workspace Leaders — exactly once (the flag is claimed with a
 * conditional update); the flag clears when usage drops below 80% again.
 * Best effort: never fails the booking or payment that called it.
 */
export async function checkUsageAlert(workspaceId: unknown): Promise<void> {
  try {
    const ws = (await CustomerWorkspace.findById(String(workspaceId)).select("sbtOfficialBooking customerId companyName slug").lean()) as AnyObj | null;
    if (!ws) return;
    const s = walletState(ws);
    const over = s.creditLimit > 0 && s.used >= s.creditLimit * USAGE_ALERT_RATIO;
    if (!over) {
      if (ws.sbtOfficialBooking?.usageAlertSent) {
        await CustomerWorkspace.updateOne({ _id: ws._id }, { $set: { "sbtOfficialBooking.usageAlertSent": false } }, { runValidators: false });
      }
      return;
    }
    const claimed = await CustomerWorkspace.updateOne(
      { _id: ws._id, "sbtOfficialBooking.usageAlertSent": { $ne: true } },
      { $set: { "sbtOfficialBooking.usageAlertSent": true } },
      { runValidators: false },
    );
    if (claimed.modifiedCount !== 1) return;
    await mailLeaders(ws, {
      event: "wallet_usage_80",
      subject: `Business Wallet: ${Math.floor(s.usagePct)}% of your travel credit is used`,
      title: "Travel credit running low",
      body: `
        <p>Your company has used <strong>${inr(s.used)}</strong> of its <strong>${inr(s.creditLimit)}</strong> travel credit
        (${Math.floor(s.usagePct)}%). Available now: <strong>${inr(Math.max(0, s.available))}</strong>.</p>
        <p>Bookings that would go over the available credit can't be paid from the Business Wallet. To keep booking
        without interruption, please arrange a payment to Plumtrips.</p>`,
    });
  } catch (err: any) {
    sbtLogger.error("[sbt-wallet] usage alert failed", { workspaceId: String(workspaceId), err: err?.message });
  }
}

async function mailLeaders(ws: AnyObj, m: { event: string; subject: string; title: string; body: string }) {
  const leaders = await activeLeaderEmails(ws);
  const skip = await inactiveEmails(leaders);
  const to = leaders.filter((e) => !skip.has(e));
  if (!to.length) {
    sbtLogger.warn("[sbt-wallet] no active Workspace Leader to email", { workspaceId: String(ws._id), event: m.event });
    return;
  }
  const name = await companyNameFor(ws);
  const html = buildEmailShell(`<div style="font-size:14px;line-height:1.6;color:#1f2937">${m.body}</div>`, {
    title: m.title,
    subtitle: name,
    badgeText: "Business Wallet",
  });
  for (const r of to) {
    await enqueueEmail({ event: m.event, kind: "NOTIFICATIONS", to: [r], replyTo: DESK_EMAIL, subject: m.subject, html, customerName: name });
  }
}

/* ───────────────────────── Super Admin actions ───────────────────────── */

export type ActionResult = { ok: true; entryId: string; state: WalletState } | { ok: false; status: number; error: string };
const fail = (status: number, error: string): ActionResult => ({ ok: false, status, error });
const MAX_TEXT = 500;
const cleanText = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "");
const validAmount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1e9;

async function companyOrNull(workspaceId: unknown) {
  if (!mongoose.Types.ObjectId.isValid(String(workspaceId))) return null;
  return (await CustomerWorkspace.findById(String(workspaceId)).select("sbtOfficialBooking customerId companyName slug").lean()) as AnyObj | null;
}

/**
 * Write the ledger row FIRST (unique key: a double submit moves nothing the
 * second time), then move `used`, then stamp usedAfter on the row.
 */
async function ledgerThenMove(row: AnyObj, delta: number): Promise<{ id: string; usedAfter: number } | null> {
  let created: AnyObj;
  try {
    created = (await SBTWalletLedger.create(row)).toObject();
  } catch (err: any) {
    if (err?.code === 11000) return null;
    throw err;
  }
  const usedAfter = delta ? await moveUsed(row.workspaceId, delta) : walletState(await companyOrNull(row.workspaceId)).used;
  await SBTWalletLedger.collection.updateOne({ _id: created._id }, { $set: { usedAfter } });
  return { id: String(created._id), usedAfter };
}

export async function recordPayment(
  workspaceId: unknown,
  input: { amount: unknown; paymentDate: unknown; mode: unknown; reference?: unknown; note?: unknown; internalNote?: unknown; clientKey?: unknown },
  actorUserId: string,
): Promise<ActionResult> {
  const ws = await companyOrNull(workspaceId);
  if (!ws) return fail(404, "Unknown company");
  if (!validAmount(input.amount)) return fail(400, "Enter the amount received");
  const mode = String(input.mode || "").toUpperCase() as WalletPaymentMode;
  if (!WALLET_PAYMENT_MODES.includes(mode)) return fail(400, "Choose how it was paid: NEFT, UPI, cheque or other");
  const paymentDate = typeof input.paymentDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)
    ? istDayStart(input.paymentDate) : null;
  if (!paymentDate) return fail(400, "Enter the payment date");
  if (paymentDate.getTime() > Date.now()) return fail(400, "The payment date can't be in the future");
  const amount = round2(input.amount);
  const r = await ledgerThenMove({
    workspaceId: String(ws._id), type: "CREDIT", entryType: "PAYMENT_RECEIVED", amount, monthKey: monthKeyNow(),
    reason: "PAYMENT", remark: cleanText(input.note), internalNote: cleanText(input.internalNote),
    payment: { mode, reference: cleanText(input.reference), paymentDate },
    actorUserId, idempotencyKey: `payment:${cleanText(input.clientKey) || new mongoose.Types.ObjectId()}`,
  }, -amount);
  if (!r) return fail(409, "This payment was already recorded");
  await CustomerWorkspace.updateOne({ _id: ws._id }, { $set: { "sbtOfficialBooking.lastPaymentAt": paymentDate } }, { runValidators: false });
  const state = await walletStateOf(ws._id);
  await checkUsageAlert(ws._id);
  try {
    await mailLeaders(ws, {
      event: "wallet_payment_received",
      subject: `Payment received: ${inr(amount)} — Business Wallet`,
      title: "Payment received",
      body: `
        <p>We've recorded your payment of <strong>${inr(amount)}</strong>
        (${mode === "CHEQUE" ? "cheque" : mode}${cleanText(input.reference) ? `, ref ${escapeHtml(cleanText(input.reference))}` : ""},
        ${paymentDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}). Thank you.</p>
        <p>Available travel credit is now <strong>${inr(Math.max(0, state.available))}</strong>
        of <strong>${inr(state.creditLimit)}</strong>.</p>`,
    });
  } catch (err: any) {
    sbtLogger.error("[sbt-wallet] payment email failed", { workspaceId: String(ws._id), err: err?.message });
  }
  return { ok: true, entryId: r.id, state };
}

export async function adjust(
  workspaceId: unknown,
  input: { direction: unknown; amount: unknown; reason: unknown; internalNote?: unknown; clientKey?: unknown },
  actorUserId: string,
): Promise<ActionResult> {
  const ws = await companyOrNull(workspaceId);
  if (!ws) return fail(404, "Unknown company");
  const direction = String(input.direction || "").toUpperCase();
  if (direction !== "CREDIT" && direction !== "DEBIT") return fail(400, `Choose "${ADJUSTMENT_LABEL.CREDIT}" or "${ADJUSTMENT_LABEL.DEBIT}"`);
  if (!validAmount(input.amount)) return fail(400, "Enter the amount");
  const reason = cleanText(input.reason);
  if (!reason) return fail(400, "A reason is required");
  const amount = round2(input.amount);
  const r = await ledgerThenMove({
    workspaceId: String(ws._id), type: direction, entryType: "ADJUSTMENT", amount, monthKey: monthKeyNow(),
    reason: `ADJUSTMENT_${direction}`, remark: reason, internalNote: cleanText(input.internalNote),
    actorUserId, idempotencyKey: `adjust:${cleanText(input.clientKey) || new mongoose.Types.ObjectId()}`,
  }, direction === "DEBIT" ? amount : -amount);
  if (!r) return fail(409, "This adjustment was already recorded");
  await checkUsageAlert(ws._id);
  return { ok: true, entryId: r.id, state: await walletStateOf(ws._id) };
}

export async function changeLimit(
  workspaceId: unknown,
  input: { creditLimit: unknown; reason: unknown; internalNote?: unknown },
  actorUserId: string,
): Promise<ActionResult> {
  const ws = await companyOrNull(workspaceId);
  if (!ws) return fail(404, "Unknown company");
  const limit = input.creditLimit;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0 || limit > 1e10) return fail(400, "Enter a credit limit of 0 or more");
  const reason = cleanText(input.reason);
  if (!reason) return fail(400, "A reason is required");
  const before = walletState(ws).creditLimit;
  const after = round2(limit);
  if (before === after) return fail(400, "That is already the credit limit");
  await CustomerWorkspace.updateOne({ _id: ws._id }, { $set: { "sbtOfficialBooking.creditLimit": after } }, { runValidators: false });
  const r = await ledgerThenMove({
    workspaceId: String(ws._id), type: "NONE", entryType: "LIMIT_CHANGE", amount: Math.abs(after - before), monthKey: monthKeyNow(),
    reason: "LIMIT_CHANGE", remark: reason, internalNote: cleanText(input.internalNote), limitBefore: before, limitAfter: after,
    actorUserId, idempotencyKey: `limit:${new mongoose.Types.ObjectId()}`,
  }, 0);
  await checkUsageAlert(ws._id);
  return { ok: true, entryId: r?.id || "", state: await walletStateOf(ws._id) };
}

/* ───────────────────────── statement ───────────────────────── */

export interface StatementRow {
  id: string;
  at: Date;
  type: WalletEntryType;
  direction: "DEBIT" | "CREDIT" | "NONE";
  amount: number;
  usedAfter: number | null;
  bookingRef: string;
  product: "FLIGHT" | "HOTEL" | "";
  travellers: string;
  trip: string;
  bookedBy: string;
  description: string;
  payment: { mode: string; reference: string; paymentDate: Date | null } | null;
  limitBefore?: number;
  limitAfter?: number;
  // staff only
  enteredBy?: string;
  internalNote?: string;
  /** For scoping (not sent). */
  _ownerIds?: string[];
}

export function entryTypeOf(e: AnyObj): WalletEntryType {
  if (e.entryType && (WALLET_ENTRY_TYPES as string[]).includes(e.entryType)) return e.entryType;
  return e.type === "DEBIT" ? "BOOKING" : "CANCELLATION_REFUND";
}

const DESCRIPTIONS: Record<string, string> = {
  BOOKING: "Booking",
  CANCELLATION: "Cancellation refund",
  PAYMENT: "Payment received",
  LIMIT_CHANGE: "Credit limit changed",
};
function describe(e: AnyObj, type: WalletEntryType, staff: boolean): string {
  const r = String(e.reason || "");
  if (r === "ADJUSTMENT_CREDIT" || r === "ADJUSTMENT_DEBIT") return adjustmentLabel(r === "ADJUSTMENT_CREDIT" ? "CREDIT" : "DEBIT", staff);
  if (DESCRIPTIONS[r]) return DESCRIPTIONS[r];
  if (type === "CANCELLATION_REFUND") return "Booking not completed — amount released";
  return r;
}

const fmtDay = (v: unknown) => {
  if (!v) return "";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10)
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};
const paxName = (p: AnyObj) => [p?.firstName ?? p?.FirstName, p?.lastName ?? p?.LastName].filter(Boolean).join(" ").trim();

function flightTrip(b: AnyObj): string {
  const o = b?.origin?.code || b?.origin?.city || b?.origin || "";
  const d = b?.destination?.code || b?.destination?.city || b?.destination || "";
  const route = [o, d].filter((x) => typeof x === "string" && x).join(" → ");
  return [route, fmtDay(b?.departureTime)].filter(Boolean).join(" · ");
}
function hotelTrip(h: AnyObj): string {
  const where = [h?.hotelName, h?.cityName].filter(Boolean).join(", ");
  const dates = h?.checkIn ? `${fmtDay(h.checkIn)}${h?.checkOut ? ` – ${fmtDay(h.checkOut)}` : ""}` : "";
  return [where, dates].filter(Boolean).join(" · ");
}

export interface StatementQuery {
  from?: string; // YYYY-MM-DD (IST), inclusive
  to?: string;
  types?: WalletEntryType[];
  q?: string;
  /** Only entries for bookings this user made or travels on (non-leaders). */
  ownerUserId?: string | null;
  staff?: boolean;
  includeTest?: boolean;
}

export async function statement(workspaceId: unknown, opts: StatementQuery = {}): Promise<StatementRow[]> {
  const filter: AnyObj = { workspaceId: String(workspaceId) };
  if (!opts.includeTest) filter.isTest = { $ne: true };
  if (opts.from || opts.to) {
    filter.createdAt = {};
    if (opts.from) filter.createdAt.$gte = istDayStart(opts.from);
    if (opts.to) filter.createdAt.$lt = istDayStart(addDays(opts.to, 1));
  }
  const entries = (await SBTWalletLedger.find(filter).sort({ createdAt: -1, _id: -1 }).limit(5000).lean()) as AnyObj[];

  // Payment rows → bookings, in a few batched reads.
  const payIds = [...new Set(entries.map((e) => String(e.paymentId || "")).filter((i) => mongoose.Types.ObjectId.isValid(i)))];
  const rows = payIds.length
    ? ((await SBTPayment.find({ _id: { $in: payIds } })
        .select("userId product bookingDocIds heldBookingId reissueOfBookingId tboBookingId fulfilment.save fulfilment.kind")
        .lean()) as AnyObj[])
    : [];
  const rowById = new Map(rows.map((r) => [String(r._id), r]));
  const bookingIds = new Set<string>();
  for (const e of entries) if (e.bookingDocId) bookingIds.add(String(e.bookingDocId));
  for (const r of rows) {
    for (const id of r.bookingDocIds || []) bookingIds.add(String(id));
    if (r.heldBookingId) bookingIds.add(String(r.heldBookingId));
    if (r.reissueOfBookingId) bookingIds.add(String(r.reissueOfBookingId));
  }
  const ids = [...bookingIds].filter((i) => mongoose.Types.ObjectId.isValid(i));
  const [flights, hotels] = ids.length
    ? await Promise.all([
        SBTBooking.find({ _id: { $in: ids } }).select("pnr bookingId passengers origin destination departureTime userId").lean(),
        SBTHotelBooking.find({ _id: { $in: ids } }).select("confirmationNo bookingRefNo bookingId guests hotelName cityName checkIn checkOut userId").lean(),
      ])
    : [[], []];
  const flightById = new Map((flights as AnyObj[]).map((b) => [String(b._id), b]));
  const hotelById = new Map((hotels as AnyObj[]).map((b) => [String(b._id), b]));
  const names = await userNames([
    ...rows.map((r) => r.userId),
    ...(opts.staff ? entries.map((e) => e.actorUserId) : []),
  ].filter(Boolean));

  const out: StatementRow[] = entries.map((e) => {
    const type = entryTypeOf(e);
    const row = e.paymentId ? rowById.get(String(e.paymentId)) : undefined;
    // The same booking can be named by the entry and by its payment row — once each.
    const docIds: string[] = [...new Set([
      ...(e.bookingDocId ? [String(e.bookingDocId)] : []),
      ...((row?.bookingDocIds || []) as unknown[]).map(String),
      ...(row?.heldBookingId ? [String(row.heldBookingId)] : []),
      ...(row?.reissueOfBookingId ? [String(row.reissueOfBookingId)] : []),
    ])];
    const fl = docIds.map((i) => flightById.get(i)).filter(Boolean) as AnyObj[];
    const ht = docIds.map((i) => hotelById.get(i)).filter(Boolean) as AnyObj[];
    const save: AnyObj = row?.fulfilment?.save || {};
    const product = (row?.product || e.product || (fl.length ? "FLIGHT" : ht.length ? "HOTEL" : "")) as StatementRow["product"];
    let bookingRef = "";
    let travellers = "";
    let trip = "";
    if (fl.length) {
      bookingRef = [...new Set(fl.map((b) => b.pnr || String(b.bookingId || "")).filter(Boolean))].join(", ");
      travellers = [...new Set(fl.flatMap((b) => (b.passengers || []).map(paxName)).filter(Boolean))].join(", ");
      trip = fl.map(flightTrip).filter(Boolean).join(" | ");
    } else if (ht.length) {
      bookingRef = [...new Set(ht.map((h) => h.confirmationNo || h.bookingRefNo || String(h.bookingId || "")).filter(Boolean))].join(", ");
      travellers = [...new Set(ht.flatMap((h) => (h.guests || []).map(paxName)).filter(Boolean))].join(", ");
      trip = ht.map(hotelTrip).filter(Boolean).join(" | ");
    } else if (row) {
      // Not booked (failed / released): what the checkout was for.
      bookingRef = row.tboBookingId ? String(row.tboBookingId) : "";
      travellers = [...new Set(((save.passengers || save.guests || []) as AnyObj[]).map(paxName).filter(Boolean))].join(", ");
      trip = product === "HOTEL" ? hotelTrip(save) : flightTrip(save);
    }
    if (row?.reissueOfBookingId && type === "BOOKING") bookingRef = bookingRef ? `${bookingRef} (date change)` : "Date change";
    const owners = new Set<string>();
    if (row?.userId) owners.add(String(row.userId));
    for (const b of [...fl, ...ht]) if (b.userId) owners.add(String(b.userId));
    const r: StatementRow = {
      id: String(e._id),
      at: e.createdAt,
      type,
      direction: e.type,
      amount: round2(num(e.amount)),
      usedAfter: typeof e.usedAfter === "number" ? round2(e.usedAfter) : null,
      bookingRef,
      product,
      travellers,
      trip,
      bookedBy: row?.userId ? nameOrUnknown(names.get(String(row.userId))) : "",
      description: type === "ADJUSTMENT" || type === "LIMIT_CHANGE" || type === "PAYMENT_RECEIVED"
        ? [describe(e, type, opts.staff === true), e.remark].filter(Boolean).join(" — ")
        : describe(e, type, opts.staff === true),
      payment: e.payment?.mode
        ? { mode: e.payment.mode, reference: e.payment.reference || "", paymentDate: e.payment.paymentDate || null }
        : null,
      ...(type === "LIMIT_CHANGE" ? { limitBefore: num(e.limitBefore), limitAfter: num(e.limitAfter) } : {}),
      _ownerIds: [...owners],
    };
    if (opts.staff) {
      r.enteredBy = e.actorUserId ? nameOrUnknown(names.get(String(e.actorUserId))) : "System";
      r.internalNote = e.internalNote || "";
    }
    return r;
  });

  let shown = out;
  if (opts.ownerUserId) {
    const me = String(opts.ownerUserId);
    shown = shown.filter((r) => (r.type === "BOOKING" || r.type === "CANCELLATION_REFUND") && (r._ownerIds || []).includes(me));
  }
  if (opts.types?.length) shown = shown.filter((r) => opts.types!.includes(r.type));
  const q = String(opts.q || "").trim().toLowerCase();
  if (q) shown = shown.filter((r) => `${r.bookingRef} ${r.travellers} ${r.trip}`.toLowerCase().includes(q));
  return shown.map(({ _ownerIds: _o, ...rest }) => rest);
}

/* ───────────────────────── downloads ───────────────────────── */

const TYPE_LABEL: Record<WalletEntryType, string> = {
  BOOKING: "Booking",
  CANCELLATION_REFUND: "Cancellation refund",
  PAYMENT_RECEIVED: "Payment received",
  ADJUSTMENT: "Adjustment",
  LIMIT_CHANGE: "Limit change",
};
export const typeLabel = (t: WalletEntryType) => TYPE_LABEL[t] || t;
/** A row's type as the statement and downloads print it (adjustments say which way). */
export const rowTypeLabel = (r: Pick<StatementRow, "type" | "direction">, staff: boolean) =>
  r.type === "ADJUSTMENT" && (r.direction === "CREDIT" || r.direction === "DEBIT") ? adjustmentLabel(r.direction, staff) : typeLabel(r.type);

/** Signed effect on `used`: + raises it, − lowers it. */
export const signedAmount = (r: StatementRow) => (r.direction === "DEBIT" ? r.amount : r.direction === "CREDIT" ? -r.amount : 0);

function columns(staff: boolean): Array<[string, (r: StatementRow) => string | number]> {
  const cols: Array<[string, (r: StatementRow) => string | number]> = [
    ["Date", (r) => new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })],
    ["Type", (r) => rowTypeLabel(r, staff)],
    ["Description", (r) => r.description],
    ["Booking no.", (r) => r.bookingRef],
    ["Travellers", (r) => r.travellers],
    ["Trip", (r) => r.trip],
    ["Booked by", (r) => r.bookedBy],
    ["Amount (₹)", (r) => (r.type === "LIMIT_CHANGE" ? "" : signedAmount(r))],
    ["Used after (₹)", (r) => (r.usedAfter == null ? "" : r.usedAfter)],
    ["Payment mode", (r) => r.payment?.mode || ""],
    ["Reference", (r) => r.payment?.reference || ""],
    ["Payment date", (r) => (r.payment?.paymentDate ? fmtDay(r.payment.paymentDate) : "")],
  ];
  if (staff) cols.push(["Entered by", (r) => r.enteredBy || ""], ["Internal note", (r) => r.internalNote || ""]);
  return cols;
}

/** One CSV cell: quoted when needed; text a spreadsheet would run as a formula
 *  (starts with = + @ or a non-numeric -) is prefixed with '. */
const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (typeof v !== "number" && /^[=+@]|^-(?!\d)/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function statementCsv(rows: StatementRow[], staff = false): string {
  const cols = columns(staff);
  const lines = [cols.map(([h]) => csvCell(h)).join(",")];
  for (const r of rows) lines.push(cols.map(([, f]) => csvCell(f(r))).join(","));
  return "﻿" + lines.join("\r\n");
}

export async function statementXlsx(rows: StatementRow[], title: string, staff = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sh = wb.addWorksheet("Statement");
  const cols = columns(staff);
  sh.addRow([title]).font = { bold: true, size: 13 };
  sh.addRow([]);
  const head = sh.addRow(cols.map(([h]) => h));
  head.font = { bold: true };
  for (const r of rows) sh.addRow(cols.map(([, f]) => f(r)));
  sh.columns.forEach((c, i) => { c.width = [22, 18, 34, 16, 28, 34, 18, 14, 14, 12, 18, 14, 18, 30][i] || 16; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
