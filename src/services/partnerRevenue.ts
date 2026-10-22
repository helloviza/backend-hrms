// Partner revenue share — the one place the numbers are decided.
//
//   bakedIn = ManualBooking.pricing.basePrice × visiblePct / 100
//   share   = bakedIn × sharePct / 100
//
// basePrice is the GST-free margin in both GST modes (models/ManualBooking.ts
// pre-save hook), so nothing here touches GST. Credit notes reduce the share
// by the credited fraction of what was invoiced for the booking
// (creditRatioForBooking below), so their GST never matters.
//
// SNAPSHOT, NEVER LIVE: the percents and amounts are frozen onto the booking
// (ManualBooking.partnerShare) at the moment it is invoiced and cleared when it
// is un-invoiced. Readers sum the snapshot; the current PartnerRevenueConfig is
// only ever read here, at invoicing time.
//
// TWO ID SPACES: ManualBooking.workspaceId is a Customer._id; the config is
// keyed on CustomerWorkspace._id. configsByCustomerId() is the only bridge
// (CustomerWorkspace.customerId, unique). Never match one against the other.
import mongoose, { type ClientSession } from "mongoose";
import ManualBooking from "../models/ManualBooking.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import PartnerRevenueConfig from "../models/PartnerRevenueConfig.js";
import CreditNote from "../models/CreditNote.js";
import logger from "../utils/logger.js";

type AnyObj = Record<string, any>;

export const PARTNER_PCT_MIN = 0;
export const PARTNER_PCT_MAX = 100;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function isValidPartnerPct(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= PARTNER_PCT_MIN && v <= PARTNER_PCT_MAX;
}

/** True when the booking carries a usable cost price (the snapshot needs one). */
export function hasCostPrice(booking: AnyObj | null | undefined): boolean {
  const cost = Number(booking?.pricing?.actualPrice);
  return Number.isFinite(cost) && cost > 0;
}

export interface PartnerShareSnapshot {
  visiblePct: number;
  sharePct: number;
  configVersion: number;
  marginBase: number;
  bakedIn: number;
  share: number;
  at: Date;
}

/**
 * The snapshot for one booking under one config, or null when the booking
 * cannot earn: config off, or no cost price (a 0 cost makes basePrice the
 * whole selling price, which is not a margin). A loss booking (basePrice ≤ 0)
 * earns 0 — a partner is never charged for one.
 */
export function computePartnerShare(
  booking: AnyObj,
  config: AnyObj | null | undefined,
  at: Date = new Date(),
): PartnerShareSnapshot | null {
  if (!config?.enabled) return null;
  if (!hasCostPrice(booking)) return null;
  const visiblePct = Number(config.visiblePct);
  const sharePct = Number(config.sharePct);
  if (!isValidPartnerPct(visiblePct) || !isValidPartnerPct(sharePct)) return null;

  const raw = Number(booking?.pricing?.basePrice);
  const marginBase = Number.isFinite(raw) ? round2(raw) : 0;
  const positive = Math.max(0, marginBase);
  const bakedIn = round2((positive * visiblePct) / 100);
  const share = round2((bakedIn * sharePct) / 100);
  return { visiblePct, sharePct, configVersion: Number(config.version) || 1, marginBase, bakedIn, share, at };
}

/** Enabled configs by the Customer._id a ManualBooking.workspaceId holds. */
export async function configsByCustomerId(
  customerIds: string[],
  session?: ClientSession | null,
): Promise<Map<string, AnyObj>> {
  const ids = [...new Set(customerIds.filter(Boolean).map(String))];
  const out = new Map<string, AnyObj>();
  if (!ids.length) return out;
  const workspaces = (await CustomerWorkspace.find({ customerId: { $in: ids } })
    .select("_id customerId")
    .session(session ?? null)
    .lean()) as AnyObj[];
  if (!workspaces.length) return out;
  const configs = (await PartnerRevenueConfig.find({
    workspaceId: { $in: workspaces.map((w) => w._id) },
    enabled: true,
  })
    .session(session ?? null)
    .lean()) as AnyObj[];
  const byWs = new Map(configs.map((c) => [String(c.workspaceId), c]));
  for (const w of workspaces) {
    const c = byWs.get(String(w._id));
    if (c) out.set(String(w.customerId), c);
  }
  return out;
}

/**
 * Freeze the partner share onto bookings that have just become INVOICED.
 * Bookings whose workspace has no enabled config, or no cost price, are left
 * without a snapshot (and any stale one removed).
 */
export async function snapshotPartnerShare(
  bookingIds: unknown[],
  opts: { session?: ClientSession | null; at?: Date } = {},
): Promise<{ written: number; skipped: number }> {
  const ids = bookingIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return { written: 0, skipped: 0 };
  const session = opts.session ?? null;
  const at = opts.at ?? new Date();

  const bookings = (await ManualBooking.find({ _id: { $in: ids } })
    .select("_id workspaceId pricing.actualPrice pricing.basePrice")
    .session(session)
    .lean()) as AnyObj[];
  const configs = await configsByCustomerId(bookings.map((b) => String(b.workspaceId)), session);

  const ops: AnyObj[] = [];
  let written = 0;
  for (const b of bookings) {
    const snap = computePartnerShare(b, configs.get(String(b.workspaceId)), at);
    if (snap) {
      written++;
      ops.push({ updateOne: { filter: { _id: b._id }, update: { $set: { partnerShare: snap } } } });
    } else {
      ops.push({ updateOne: { filter: { _id: b._id }, update: { $unset: { partnerShare: 1 } } } });
    }
  }
  if (ops.length) await ManualBooking.bulkWrite(ops as any, { session: session ?? undefined });
  return { written, skipped: bookings.length - written };
}

/** Remove the snapshot from bookings that are no longer invoiced. */
export async function clearPartnerShare(
  bookingIds: unknown[],
  opts: { session?: ClientSession | null } = {},
): Promise<void> {
  const ids = bookingIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return;
  await ManualBooking.updateMany(
    { _id: { $in: ids } },
    { $unset: { partnerShare: 1 } },
    { session: opts.session ?? undefined },
  );
}

/**
 * Never let the snapshot block or fail invoicing — the invoice is the legal
 * document, the snapshot is reporting. Callers run this AFTER the invoicing
 * transaction has committed, so a failure leaves the booking INVOICED with no
 * partnerShare — exactly what the backfill
 * (POST /api/admin/partner-revenue/:workspaceId/backfill) looks for, so that
 * is the repair. One log line per booking says so.
 */
export async function snapshotPartnerShareSafe(bookingIds: unknown[], context: string): Promise<void> {
  try {
    await snapshotPartnerShare(bookingIds);
  } catch (err: any) {
    // Name the bookings if the database still answers; otherwise their ids.
    let rows: AnyObj[] = [];
    try {
      rows = (await ManualBooking.find({ _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(String(id))) } })
        .select("_id bookingRef workspaceId")
        .lean()) as AnyObj[];
    } catch {
      /* fall back to the ids below */
    }
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    for (const id of bookingIds) {
      const r = byId.get(String(id));
      const ref = r?.bookingRef || String(id);
      logger.warn(`[partner-revenue] partnerShare snapshot failed for ${ref} — run backfill for this workspace to repair`, {
        context,
        bookingId: String(id),
        bookingRef: r?.bookingRef ?? null,
        customerId: r?.workspaceId ? String(r.workspaceId) : null,
        err: err?.message,
      });
    }
  }
}

/**
 * Same contract as snapshotPartnerShareSafe, for the un-invoice paths. A
 * failed clear leaves a stale snapshot on an UN-invoiced booking: the readers
 * count it as 0 (it has no invoice) and invoicing it again overwrites it.
 */
export async function clearPartnerShareSafe(bookingIds: unknown[], context: string): Promise<void> {
  try {
    await clearPartnerShare(bookingIds);
  } catch (err: any) {
    logger.warn("[partner-revenue] partnerShare clear failed — harmless: the booking is no longer invoiced, so it earns 0 until re-invoiced", {
      context,
      bookingIds: bookingIds.map(String),
      err: err?.message,
    });
  }
}

/* ───────────────────────── credit notes ───────────────────────── */

/**
 * Weighted rule — one credited ratio per BOOKING, from its CURRENT invoice and
 * the ISSUED credit notes against that invoice:
 *
 *   for every invoice line naming the booking (refs split on commas, trimmed):
 *     bookingPortion = line.originalAmount                        single-ref line
 *                    = line.originalAmount × booking.grandTotal    combined line
 *                      / Σ grandTotal of every booking on the line
 *     lineRatio      = creditedAmount / originalAmount, capped at 1
 *     credited      += lineRatio × bookingPortion
 *     invoiced      += bookingPortion
 *   bookingRatio = min(1, credited / invoiced)
 *   share   = snapshot.share   × (1 − bookingRatio)
 *   bakedIn = snapshot.bakedIn × (1 − bookingRatio)
 *
 * originalAmount is the invoice line's own amount; creditedAmount is the sum
 * over every ISSUED credit-note line paired with it by the key
 * routes/creditNotes.ts uses to pair them (bookingRef|rowType|description),
 * so several credit notes on one line add up and are capped at that line.
 * A booking on no line of its invoice (invoiced 0) is skipped and logged —
 * it is not reduced. Credit notes on any other invoice never count.
 */
export function refsOfLine(bookingRef: unknown): string[] {
  return String(bookingRef ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

const lineKey = (li: AnyObj) => `${String(li?.bookingRef ?? "")}|${String(li?.rowType ?? "")}|${String(li?.description ?? "")}`;

/** Customer-facing total of a booking — its weight on a combined line. */
export function bookingGrandTotal(b: AnyObj | null | undefined): number {
  const p = b?.pricing ?? {};
  const v = Number(p.grandTotal ?? p.totalWithGST ?? p.quotedPrice ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function creditRatioForBooking(
  booking: { bookingRef?: string; invoiceId?: unknown },
  invoice: AnyObj | null | undefined,
  creditNotes: AnyObj[],
  grandTotalByRef: Map<string, number>,
): number {
  const invId = booking.invoiceId != null ? String((booking.invoiceId as any)?._id ?? booking.invoiceId) : "";
  const ref = String(booking.bookingRef || "").trim();
  if (!invId || !ref || !invoice || String(invoice._id) !== invId) return 0;
  const notes = creditNotes.filter((cn) => cn?.status === "ISSUED" && String(cn.originalInvoiceId) === invId);
  const lines: AnyObj[] = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];

  // Credited amount per line key, across every note on this invoice.
  const creditedByKey = new Map<string, number>();
  for (const cn of notes) {
    for (const li of Array.isArray(cn.lineItems) ? cn.lineItems : []) {
      const k = lineKey(li);
      creditedByKey.set(k, (creditedByKey.get(k) ?? 0) + Math.max(0, Number(li?.creditedAmount) || 0));
    }
  }
  // Invoice lines sharing a key (rare) share its credit in proportion to their amounts.
  const originalByKey = new Map<string, number>();
  for (const li of lines) {
    const k = lineKey(li);
    originalByKey.set(k, (originalByKey.get(k) ?? 0) + Math.max(0, Number(li?.amount) || 0));
  }

  let credited = 0;
  let invoiced = 0;
  for (const li of lines) {
    const refs = refsOfLine(li?.bookingRef);
    if (!refs.includes(ref)) continue;
    const original = Math.max(0, Number(li?.amount) || 0);
    if (original <= 0) continue;

    let weight = 1;
    if (refs.length > 1) {
      const sum = refs.reduce((s, r) => s + (grandTotalByRef.get(r) ?? 0), 0);
      if (sum > 0) {
        weight = (grandTotalByRef.get(ref) ?? 0) / sum;
      } else {
        weight = 1 / refs.length;
        logger.warn("[partner-revenue] combined line has no grand totals — split evenly", {
          invoiceId: invId, bookingRef: li?.bookingRef, rowType: li?.rowType,
        });
      }
    }
    const portion = original * weight;
    const keyOriginal = originalByKey.get(lineKey(li)) ?? original;
    const lineRatio = keyOriginal > 0 ? Math.min(1, (creditedByKey.get(lineKey(li)) ?? 0) / keyOriginal) : 0;
    credited += lineRatio * portion;
    invoiced += portion;
  }

  if (invoiced <= 0) {
    if (notes.length) {
      logger.warn("[partner-revenue] booking on no line of its invoice — credit not applied", { invoiceId: invId, bookingRef: ref });
    }
    return 0;
  }
  return Math.min(1, credited / invoiced);
}

/** The snapshot net of credit: each amount × (1 − bookingRatio), floored at 0. */
export function netOfCredit(
  snap: Pick<PartnerShareSnapshot, "bakedIn" | "share">,
  bookingRatio: number,
): { bakedIn: number; share: number } {
  const keep = Math.max(0, 1 - Math.min(1, Math.max(0, Number(bookingRatio) || 0)));
  return {
    bakedIn: round2(Math.max(0, Number(snap.bakedIn) * keep)),
    share: round2(Math.max(0, Number(snap.share) * keep)),
  };
}

/** Grand totals of every booking named on a COMBINED line of these invoices. */
export async function combinedLineTotals(invoices: AnyObj[]): Promise<Map<string, number>> {
  const refs = new Set<string>();
  for (const inv of invoices) {
    for (const li of Array.isArray(inv?.lineItems) ? inv.lineItems : []) {
      const r = refsOfLine(li?.bookingRef);
      if (r.length > 1) r.forEach((x) => refs.add(x));
    }
  }
  if (!refs.size) return new Map();
  const rows = (await ManualBooking.find({ bookingRef: { $in: [...refs] } })
    .select("bookingRef pricing.grandTotal pricing.totalWithGST pricing.quotedPrice")
    .lean()) as AnyObj[];
  return new Map(rows.map((r) => [String(r.bookingRef), bookingGrandTotal(r)]));
}

/** ISSUED credit notes on any of these invoices (one query for a page of bookings). */
export async function issuedCreditNotesFor(invoiceIds: unknown[]): Promise<AnyObj[]> {
  const ids = [...new Set(invoiceIds.filter(Boolean).map((id) => String((id as any)?._id ?? id)))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return [];
  return (await CreditNote.find({ originalInvoiceId: { $in: ids }, status: "ISSUED" })
    .select("creditNoteNo originalInvoiceId status lineItems.bookingRef lineItems.rowType lineItems.description lineItems.creditedAmount")
    .lean()) as AnyObj[];
}
