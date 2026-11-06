// Invoice "Cancel for reissue" and "Delete invoice".
//
// Replaces the manual Compass routine (delete the invoice, regenerate, rename
// the new invoice to the old number, reset the Counter — see
// scripts/rename-inv-20260042-to-40.ts). The Counter is NEVER written here:
//
//   Cancel for reissue — the invoice is snapshotted into archived_invoices,
//     removed from invoices, its bookings are released for editing, and its
//     number is RESERVED against those bookings and its own series.
//   Generate — when the bookings hold a reservation the operator must choose
//     (decision D5): reuse the number (the new invoice is created with it,
//     Invoice.ts's pre-save hook then skips the Counter), keep it reserved, or
//     release it with a reason. Consumption happens inside the generation
//     transaction (services/invoiceGeneration.service.ts).
//   Delete invoice — archived and removed the same way; the number is not
//     reserved and becomes a gap.
//
// Audit and decisions: docs/audits/invoice-reissue-audit.md.

import mongoose from "mongoose";
import Invoice from "../models/Invoice.js";
import ManualBooking from "../models/ManualBooking.js";
import CreditNote from "../models/CreditNote.js";
import PaymentRequest from "../models/PaymentRequest.js";
import ArchivedInvoice, { type ArchiveMode } from "../models/ArchivedInvoice.js";
import InvoiceNumberReservation from "../models/InvoiceNumberReservation.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { istDateString } from "../utils/dateIST.js";
import { archiveInvoicePdf } from "../utils/invoicePdfStore.js";
import { cancelOpenLinksForSubject, type CancelOpenLinksReport } from "./paymentRequests.js";
import { clearPartnerShare } from "./partnerRevenue.js";
import { touchNow } from "./loyalty.js";
import { reservedIndexAvailable, RESERVED_INDEX_UNAVAILABLE_MESSAGE } from "../bootstrap/ensureInvoiceReissueIndexes.js";

export class ReissueError extends Error {
  constructor(public httpStatus: number, message: string, public code?: string, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "ReissueError";
  }
}

export const MIN_REASON_LENGTH = 10;

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));

/* ── Series ─────────────────────────────────────────────────────────────
 * Mirrors the numbering in models/Invoice.ts's pre-save hook: the issuer
 * GSTIN picks a gstProfiles entry, whose invoiceSeriesPrefix ("" = default)
 * picks the series; prefixed series follow the global cadence, the default
 * series is always annual. The PERIOD is read back out of the number itself
 * (decision D1: the reserved number's own period, never the server clock).
 */
export interface InvoiceSeries {
  issuerGstin: string;
  seriesPrefix: string;
  cadence: "annual" | "monthly";
  period: string;
  counterKey: string;
}

function profilePrefix(gstin: string, companySettings: any): string {
  if (!gstin) return "";
  const profile = (companySettings?.gstProfiles || []).find(
    (p: any) => (p.gstin || "").toUpperCase().trim() === gstin,
  );
  return (profile?.invoiceSeriesPrefix || "").trim().toUpperCase();
}

function cadenceFor(prefix: string, companySettings: any): "annual" | "monthly" {
  if (!prefix) return "annual";
  return companySettings?.invoiceSeriesCadence === "monthly" ? "monthly" : "annual";
}

/** The series an existing invoice's number belongs to, or null when the
 *  number does not parse under today's registry (e.g. the profile's prefix
 *  was changed after the invoice was issued). */
export function seriesOfInvoice(invoice: { invoiceNo?: string; issuerDetails?: any }, companySettings: any): InvoiceSeries | null {
  const issuerGstin = String(invoice.issuerDetails?.gstin || "").toUpperCase().trim();
  const seriesPrefix = profilePrefix(issuerGstin, companySettings);
  const cadence = cadenceFor(seriesPrefix, companySettings);
  const head = `INV-${seriesPrefix}`;
  const no = String(invoice.invoiceNo || "");
  if (!no.startsWith(head)) return null;
  const rest = no.slice(head.length);
  const periodLen = cadence === "monthly" ? 6 : 4;
  if (!/^\d+$/.test(rest) || rest.length < periodLen + 4) return null;
  const period = rest.slice(0, periodLen);
  if (cadence === "monthly" && !/^\d{4}(0[1-9]|1[0-2])$/.test(period)) return null;
  const counterKey = !seriesPrefix
    ? `invoice:FY${period}`
    : cadence === "monthly"
      ? `invoice:${period}:${issuerGstin}`
      : `invoice:FY${period}:${issuerGstin}`;
  return { issuerGstin, seriesPrefix, cadence, period, counterKey };
}

/** The IST period ("2026" FY start year, or "202607") a date falls in. */
export function periodOfDate(date: Date, cadence: "annual" | "monthly"): string {
  const [y, m] = istDateString(date).split("-").map(Number);
  if (cadence === "monthly") return `${y}${String(m).padStart(2, "0")}`;
  return String(m >= 4 ? y : y - 1);
}

function describePeriod(period: string, cadence: "annual" | "monthly"): string {
  if (cadence === "monthly") {
    const d = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(4)) - 1, 15));
    return d.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  const y = Number(period);
  return `FY ${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/** Why a reservation may NOT be reused by an invoice issued under
 *  `issuerGstin` and dated `invoiceDate` — null when it may. Decision D1. */
export function reuseRefusal(
  reservation: { number: string; issuerGstin: string; seriesPrefix: string; cadence: "annual" | "monthly"; period: string },
  issuerGstin: string,
  invoiceDate: Date,
  companySettings: any,
): { code: string; message: string } | null {
  const gstin = String(issuerGstin || "").toUpperCase().trim();
  const reservedGstin = String(reservation.issuerGstin || "").toUpperCase().trim();
  if (gstin !== reservedGstin || profilePrefix(gstin, companySettings) !== reservation.seriesPrefix) {
    return {
      code: "RESERVATION_SERIES_MISMATCH",
      message: `${reservation.number} belongs to the series of GSTIN ${reservedGstin || "(default)"}; this invoice is being issued under ${gstin || "(default)"}. A number can only be reused in its own GSTIN series.`,
    };
  }
  if (periodOfDate(invoiceDate, reservation.cadence) !== reservation.period) {
    return {
      code: "RESERVATION_PERIOD_MISMATCH",
      message: `${reservation.number} belongs to ${describePeriod(reservation.period, reservation.cadence)}; the invoice date ${istDateString(invoiceDate)} is outside it. Use a date inside that period to reuse the number.`,
    };
  }
  return null;
}

/* ── Preview: blockers + warnings ───────────────────────────────────── */

export interface ArchivePreview {
  invoice: {
    _id: string; invoiceNo: string; status: string; invoiceDate: Date | null;
    grandTotal: number; clientName: string; issuerGstin: string; bookingRefs: string[]; bookingCount: number;
  };
  mode: ArchiveMode;
  blockers: string[];
  warnings: string[];
  series: InvoiceSeries | null;
  openPaymentLinks: number;
}

export async function archivePreview(invoice: any, mode: ArchiveMode, session?: mongoose.ClientSession): Promise<ArchivePreview> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const status = String(invoice.status);

  if (status === "CANCELLED") {
    blockers.push("A cancelled invoice cannot be reissued or deleted.");
  } else if (status === "PAID") {
    blockers.push("This invoice is marked PAID. A paid invoice cannot be archived; raise a credit note instead.");
  } else if (status === "PAYMENT_DECLARED") {
    blockers.push("The customer has declared payment on this invoice. Resolve the payment first (confirm it or revert it to SENT).");
  } else if (status !== "DRAFT" && status !== "SENT") {
    blockers.push(`Invoices in status ${status} cannot be archived.`);
  }

  const cns: any[] = await CreditNote.find(
    { originalInvoiceId: invoice._id, status: { $ne: "CANCELLED" } },
    { creditNoteNo: 1, status: 1 },
  ).session(session ?? null).lean();
  for (const cn of cns) {
    blockers.push(cn.status === "DRAFT"
      ? `Draft credit note ${cn.creditNoteNo || cn._id} is attached to this invoice. Delete the draft credit note first.`
      : `Credit note ${cn.creditNoteNo || cn._id} (${cn.status}) has been raised against this invoice.`);
  }

  const paid: any[] = await PaymentRequest.find(
    { subject: "INVOICE", subjectId: invoice._id, status: { $in: ["PAID", "PARTLY_PAID"] } },
    { status: 1, subjectRef: 1 },
  ).session(session ?? null).lean();
  if (paid.length) {
    blockers.push(`A payment link on this invoice has received money (${paid.map((p) => p.status).join(", ")}). It cannot be archived.`);
  }
  const openPaymentLinks = await PaymentRequest.countDocuments({ subject: "INVOICE", subjectId: invoice._id, status: "OPEN" }).session(session ?? null);
  if (openPaymentLinks) warnings.push(`${openPaymentLinks} open payment link(s) on this invoice will be cancelled.`);

  const companySettings = await getCompanySettings();
  const series = seriesOfInvoice(invoice, companySettings);
  if (mode === "REISSUE") {
    if (!series) {
      blockers.push(`The number ${invoice.invoiceNo} does not match its GSTIN's numbering series as configured today, so it cannot be reserved. Use Delete instead, or check the GST profile's series prefix.`);
    }
    if (!(invoice.bookingIds ?? []).length) {
      blockers.push("This invoice has no bookings, so there is nothing to regenerate it from.");
    }
    if (series) {
      const held = await InvoiceNumberReservation.exists({ number: invoice.invoiceNo, status: "RESERVED" }).session(session ?? null);
      if (held) blockers.push(`${invoice.invoiceNo} is already reserved.`);
    }
  }

  // Decision D10: a SENT invoice from an earlier IST month may already sit in
  // a filed GSTR-1. A DRAFT was never issued, so it cannot.
  if (status === "SENT" && invoice.invoiceDate && istDateString(new Date(invoice.invoiceDate)).slice(0, 7) < istDateString().slice(0, 7)) {
    warnings.push("This invoice is from a previous month and may already be reported in a filed GSTR-1. Check with your CA before continuing.");
  }
  if (mode === "DELETE") {
    warnings.push(`${invoice.invoiceNo} will NOT be reused. It becomes a gap in the numbering series.`);
  }

  const bookings: any[] = (invoice.bookingIds ?? []).length
    ? await ManualBooking.find({ _id: { $in: invoice.bookingIds } }, { bookingRef: 1 }).session(session ?? null).lean()
    : [];

  return {
    invoice: {
      _id: String(invoice._id),
      invoiceNo: invoice.invoiceNo,
      status,
      invoiceDate: invoice.invoiceDate ?? null,
      grandTotal: invoice.grandTotal ?? 0,
      clientName: invoice.clientDetails?.companyName ?? "",
      issuerGstin: invoice.issuerDetails?.gstin ?? "",
      bookingRefs: bookings.map((b) => b.bookingRef).filter(Boolean),
      bookingCount: (invoice.bookingIds ?? []).length,
    },
    mode,
    blockers,
    warnings,
    series,
    openPaymentLinks,
  };
}

/* ── Archive (reissue / delete) ─────────────────────────────────────── */

export interface Actor { id: string; email?: string }

export interface ArchiveResult {
  archivedInvoiceId: string;
  reservationId: string | null;
  invoiceNo: string;
  pdfArchiveKey: string | null;
  warnings: string[];
  paymentLinks: CancelOpenLinksReport | null;
  /** Post-commit steps that failed (empty = all done). Also stored on the
   *  archived_invoices row and retryable from Reissue history. */
  sideEffectFailures: SideEffectFailure[];
}

/* ── Post-commit side effects ───────────────────────────────────────────
 * Run AFTER the archive transaction commits — none of them may roll an
 * archive back, but none may fail silently either. Each step's outcome is
 * appended to archived_invoices.sideEffectLog; the ones that failed are kept
 * in sideEffectFailures, returned to the modal, and retried (platform
 * SuperAdmin) from Reissue history. Every step is idempotent, so a retry
 * simply runs it again.
 */
export type SideEffectStep = "paymentLinks" | "partnerShare" | "loyalty";
export const SIDE_EFFECT_STEPS: SideEffectStep[] = ["paymentLinks", "partnerShare", "loyalty"];
export const SIDE_EFFECT_LABELS: Record<SideEffectStep, string> = {
  paymentLinks: "Cancel open payment links",
  partnerShare: "Clear partner revenue share on the bookings",
  loyalty: "Update loyalty points",
};
export interface SideEffectFailure { step: SideEffectStep; label: string; error: string; at: Date }

/** The steps themselves — an object so tests can make one fail. */
export const archiveSideEffectSteps = {
  async paymentLinks(archived: { invoiceId: unknown }, actor: Actor): Promise<CancelOpenLinksReport | null> {
    if (!(await PaymentRequest.exists({ subject: "INVOICE", subjectId: oid(archived.invoiceId) }))) return null;
    const report = await cancelOpenLinksForSubject("INVOICE", archived.invoiceId, { id: actor.id, email: actor.email } as any);
    if (report.failed.length) {
      throw new Error(`${report.failed.length} payment link(s) could not be cancelled: ${report.failed.map((f) => f.error).join("; ")}`);
    }
    return report;
  },
  async partnerShare(archived: { bookingIds?: unknown[] }): Promise<void> {
    if ((archived.bookingIds ?? []).length) await clearPartnerShare(archived.bookingIds ?? []);
  },
  async loyalty(archived: { invoiceId: unknown }): Promise<void> {
    // Reverses any points the invoice held (the reconciler sees it gone).
    await touchNow({ invoiceId: archived.invoiceId });
  },
};

export async function runArchiveSideEffects(
  archived: { _id: unknown; invoiceId: unknown; bookingIds?: unknown[] },
  steps: SideEffectStep[],
  actor: Actor,
): Promise<{ failures: SideEffectFailure[]; paymentLinks: CancelOpenLinksReport | null }> {
  const failures: SideEffectFailure[] = [];
  const log: Record<string, unknown>[] = [];
  let paymentLinks: CancelOpenLinksReport | null = null;
  for (const step of steps) {
    const at = new Date();
    try {
      const out = await archiveSideEffectSteps[step](archived as any, actor);
      if (step === "paymentLinks") paymentLinks = (out as CancelOpenLinksReport | null) ?? null;
      log.push({ step, ok: true, at, by: actor.id });
    } catch (err: any) {
      const error = String(err?.message || err || "failed");
      console.error(`[invoice-archive] ${step} failed for archived ${archived._id}:`, error);
      failures.push({ step, label: SIDE_EFFECT_LABELS[step], error, at });
      log.push({ step, ok: false, error, at, by: actor.id });
    }
  }
  await ArchivedInvoice.updateOne(
    { _id: archived._id },
    { $set: { sideEffectFailures: failures }, $push: { sideEffectLog: { $each: log } } },
  );
  return { failures, paymentLinks };
}

/** Reissue history "Retry": re-runs only the steps still failing. */
export async function retryArchiveSideEffects(archivedId: string, actor: Actor): Promise<SideEffectFailure[]> {
  if (!mongoose.Types.ObjectId.isValid(archivedId)) throw new ReissueError(404, "Archived invoice not found");
  const archived: any = await ArchivedInvoice.findById(archivedId, { snapshot: 0 }).lean();
  if (!archived) throw new ReissueError(404, "Archived invoice not found");
  const pending = [...new Set((archived.sideEffectFailures ?? []).map((f: any) => f.step))] as SideEffectStep[];
  if (!pending.length) throw new ReissueError(400, "Nothing to retry: every follow-up step has completed.", "NOTHING_TO_RETRY");
  const { failures } = await runArchiveSideEffects(archived, SIDE_EFFECT_STEPS.filter((s) => pending.includes(s)), actor);
  return failures;
}

/** Validates, copies the PDF away, then in ONE transaction: snapshot →
 *  remove → release bookings → (REISSUE) reserve. Side effects that must not
 *  roll an archive back (payment links, partner share, loyalty) run after. */
export async function archiveInvoice(opts: {
  invoiceId: string;
  mode: ArchiveMode;
  reason: unknown;
  confirmText: unknown;
  actor: Actor;
  /** The route's tenant / own-scope check on the loaded invoice. */
  inScope: (invoice: any) => Promise<boolean>;
}): Promise<ArchiveResult> {
  if (opts.mode === "REISSUE" && !(await reservedIndexAvailable())) {
    throw new ReissueError(503, RESERVED_INDEX_UNAVAILABLE_MESSAGE, "RESERVATION_INDEX_MISSING");
  }
  const reason = String(opts.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new ReissueError(400, `A reason of at least ${MIN_REASON_LENGTH} characters is required.`, "REASON_TOO_SHORT");
  }
  if (!mongoose.Types.ObjectId.isValid(opts.invoiceId)) throw new ReissueError(404, "Invoice not found");

  const invoice: any = await Invoice.collection.findOne({ _id: oid(opts.invoiceId) });
  if (!invoice || !(await opts.inScope(invoice))) throw new ReissueError(404, "Invoice not found");

  if (String(opts.confirmText ?? "").trim() !== invoice.invoiceNo) {
    throw new ReissueError(400, `Type the invoice number ${invoice.invoiceNo} exactly to confirm.`, "CONFIRM_TEXT_MISMATCH");
  }

  const preview = await archivePreview(invoice, opts.mode);
  if (preview.blockers.length) {
    throw new ReissueError(400, preview.blockers[0], "ARCHIVE_BLOCKED", { blockers: preview.blockers });
  }

  const archivedId = new mongoose.Types.ObjectId();
  const reservationId = opts.mode === "REISSUE" ? new mongoose.Types.ObjectId() : null;

  // The reissue will render a fresh PDF at invoices/<invoiceNo>.pdf, so the
  // old one is copied away first. Any S3 failure other than "no PDF yet"
  // refuses the archive (the document must not be lost).
  let pdfArchiveKey: string | null;
  try {
    pdfArchiveKey = await archiveInvoicePdf(invoice.invoiceNo, String(archivedId));
  } catch (err: any) {
    throw new ReissueError(502, `Could not copy the invoice PDF to the archive (${err?.message || "S3 error"}). Nothing was changed; try again.`, "PDF_ARCHIVE_FAILED");
  }

  const now = new Date();
  const actorId = oid(opts.actor.id);
  const bookingIds: mongoose.Types.ObjectId[] = (invoice.bookingIds ?? []).map((b: any) => oid(b));

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Re-check the money-side blockers on the transaction's snapshot.
      const again = await archivePreview(invoice, opts.mode, session);
      if (again.blockers.length) throw new ReissueError(400, again.blockers[0], "ARCHIVE_BLOCKED", { blockers: again.blockers });

      await ArchivedInvoice.create([{
        _id: archivedId,
        invoiceId: invoice._id,
        invoiceNo: invoice.invoiceNo,
        workspaceId: invoice.workspaceId,
        bookingIds,
        status: invoice.status,
        invoiceDate: invoice.invoiceDate,
        grandTotal: invoice.grandTotal,
        issuerGstin: invoice.issuerDetails?.gstin ?? "",
        clientName: invoice.clientDetails?.companyName ?? "",
        snapshot: invoice,
        mode: opts.mode,
        reason,
        archivedAt: now,
        archivedBy: actorId,
        archivedByEmail: opts.actor.email,
        pdfArchiveKey,
        reservationId,
      }], { session });

      // Only the exact document we read (same status, same last update) —
      // a concurrent edit or status change makes this a 409, not a silent loss.
      const guard: Record<string, unknown> = { _id: invoice._id, status: invoice.status };
      if (invoice.updatedAt) guard.updatedAt = invoice.updatedAt;
      const removed = await Invoice.collection.deleteOne(guard, { session });
      if (removed.deletedCount !== 1) {
        throw new ReissueError(409, "The invoice changed while you were confirming. Refresh and try again.", "INVOICE_CHANGED");
      }

      if (bookingIds.length) {
        await ManualBooking.updateMany(
          { _id: { $in: bookingIds }, invoiceId: invoice._id },
          { $set: { status: "CONFIRMED", invoiceId: null, invoiceRaisedDate: null } },
          { session },
        );
      }

      if (reservationId) {
        const series = preview.series!;
        await InvoiceNumberReservation.create([{
          _id: reservationId,
          number: invoice.invoiceNo,
          counterKey: series.counterKey,
          issuerGstin: series.issuerGstin,
          seriesPrefix: series.seriesPrefix,
          cadence: series.cadence,
          period: series.period,
          workspaceId: invoice.workspaceId,
          bookingIds,
          archivedInvoiceId: archivedId,
          archivedInvoiceDate: invoice.invoiceDate,
          status: "RESERVED",
          createdAt: now,
          createdBy: actorId,
        }], { session });
      }
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      throw new ReissueError(409, `${invoice.invoiceNo} is already reserved.`, "ALREADY_RESERVED");
    }
    throw err;
  } finally {
    await session.endSession();
  }

  const { failures, paymentLinks } = await runArchiveSideEffects(
    { _id: archivedId, invoiceId: invoice._id, bookingIds },
    SIDE_EFFECT_STEPS,
    opts.actor,
  );

  return {
    archivedInvoiceId: String(archivedId),
    reservationId: reservationId ? String(reservationId) : null,
    invoiceNo: invoice.invoiceNo,
    pdfArchiveKey,
    warnings: preview.warnings,
    paymentLinks,
    sideEffectFailures: failures,
  };
}

/* ── Reservations ───────────────────────────────────────────────────── */

/** RESERVED reservations holding any of these bookings. `tenantGate` is the
 *  route's invoiceTenantClause (null = unrestricted); reservations carry the
 *  archived invoice's workspaceId, the same id-space. */
export async function reservationsForBookings(bookingIds: unknown[], tenantGate: Record<string, any> | null): Promise<any[]> {
  const ids = [...new Set(bookingIds.map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id)).map(oid);
  if (!ids.length) return [];
  const filter: Record<string, any> = { bookingIds: { $in: ids }, status: "RESERVED" };
  if (tenantGate) filter.$and = [tenantGate];
  return InvoiceNumberReservation.find(filter).lean();
}

export async function releaseReservation(opts: {
  reservationId: string;
  reason: unknown;
  actor: Actor;
  tenantGate: Record<string, any> | null;
}): Promise<any> {
  const reason = String(opts.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new ReissueError(400, `A reason of at least ${MIN_REASON_LENGTH} characters is required.`, "REASON_TOO_SHORT");
  }
  if (!mongoose.Types.ObjectId.isValid(opts.reservationId)) throw new ReissueError(404, "Reservation not found");
  const filter: Record<string, any> = { _id: oid(opts.reservationId) };
  if (opts.tenantGate) filter.$and = [opts.tenantGate];
  const existing: any = await InvoiceNumberReservation.findOne(filter).lean();
  if (!existing) throw new ReissueError(404, "Reservation not found");
  const released = await InvoiceNumberReservation.findOneAndUpdate(
    { _id: existing._id, status: "RESERVED" },
    { $set: { status: "RELEASED", releasedAt: new Date(), releasedBy: oid(opts.actor.id), releaseReason: reason } },
    { new: true },
  ).lean();
  if (!released) {
    throw new ReissueError(409, `${existing.number} is no longer reserved (${existing.status}).`, "RESERVATION_NOT_RESERVED");
  }
  return released;
}

/** Inside the generation transaction: marks the reservation CONSUMED by
 *  `invoiceId`. False when someone else got there first (or it was
 *  released), in which case the caller must abort. */
export async function consumeReservation(
  reservationId: mongoose.Types.ObjectId,
  invoiceId: mongoose.Types.ObjectId,
  actorId: unknown,
  session: mongoose.ClientSession,
): Promise<any | null> {
  const now = new Date();
  const r: any = await InvoiceNumberReservation.findOneAndUpdate(
    { _id: reservationId, status: "RESERVED" },
    { $set: { status: "CONSUMED", consumedAt: now, consumedBy: actorId ? oid(actorId) : null, consumedInvoiceId: invoiceId } },
    { new: true, session },
  ).lean();
  if (!r) return null;
  await ArchivedInvoice.updateOne(
    { _id: r.archivedInvoiceId },
    { $set: { reissuedAsInvoiceId: invoiceId, reissuedAt: now } },
    { session },
  );
  return r;
}
