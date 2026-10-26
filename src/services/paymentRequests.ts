// apps/backend/src/services/paymentRequests.ts
//
// Payment requests: 1–3 fixed-amount Razorpay Payment Links that collect a
// ManualBooking's grand total (before booking) or a SENT invoice's grand total.
// Model: models/PaymentRequest.ts. Audit: docs/audits/payment-links-audit.md.
//
// ══════════════════════════════════════════════════════════════════════
// STATUS ONLY. This file never writes ManualBooking, Invoice or loyalty.
// ══════════════════════════════════════════════════════════════════════
// The RM moves the booking and marks the invoice paid on the existing
// screens. Everything here reads the subject and writes PaymentRequest (and,
// when a link is paid, resolves a matching PaymentOrphan).
//
// ── CREATION IS PERSIST-FIRST ───────────────────────────────────────────
// The request and all its links are saved (links as FAILED_CREATE,
// "NOT_ATTEMPTED") BEFORE any Razorpay call, then created one by one. A link
// that fails stays FAILED_CREATE and the others are kept. A retry uses the
// SAME reference_id; whenever a create fails, the link is looked up by its
// reference and adopted if Razorpay already has it (a timeout that actually
// succeeded), so a retry can never mint a duplicate link.
//
// ── GUARDED MOVES ───────────────────────────────────────────────────────
// A link leaves CREATED only for PAID / EXPIRED / CANCELLED, and PAID never
// changes. FAILED_CREATE becomes whatever Razorpay says when the link is
// adopted. A replayed webhook or a second refresh finds the link already in
// that state and changes nothing.
import mongoose from "mongoose";
import PaymentRequest, { type IPaymentRequest, type PaymentRequestSubject } from "../models/PaymentRequest.js";
import ManualBooking from "../models/ManualBooking.js";
import Invoice from "../models/Invoice.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import PaymentOrphan from "../models/PaymentOrphan.js";
import { resolveInvoiceWorkspace } from "./invoiceGeneration.service.js";
import {
  splitBases,
  parsePgPct,
  pgChargePaise,
  clampExpiry,
  coveredBasePaise,
  deriveRequestStatus,
  rupeesToPaise,
  PaymentMathError,
  MIN_LINK_PAISE,
  type SplitInput,
} from "./paymentRequestMath.js";
import {
  createPaymentLink,
  fetchPaymentLink,
  fetchPaymentLinkByReference,
  fetchPaymentLinkByPaymentId,
  cancelPaymentLink,
  paymentLinksConfigured,
  paymentLinksCreationAllowed,
  RazorpayLinkError,
} from "./razorpayPaymentLinks.js";
import { paymentLogger } from "../utils/logger.js";

/** Every Plumbox link's reference_id starts with this — R1 uses it to tell
 *  our links from links made by hand on the Razorpay dashboard. */
export const REFERENCE_PREFIX = "PBX-";
/** notes.source on every Plumbox link. */
export const NOTES_SOURCE = "plumbox_payment_request";

export const BOOKING_STATUSES_ALLOWED = ["PENDING", "WIP", "CONFIRMED"];
export const INVOICE_STATUSES_ALLOWED = ["SENT"];

export class PaymentRequestError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export type Actor = { id: string; email?: string };
export type Recipient = { name?: string; email?: string; phone?: string };

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

export function referenceIdFor(requestId: unknown, seq: number): string {
  return `${REFERENCE_PREFIX}${String(requestId)}-${seq}`;
}

export function isPlumboxRazorpayLink(rz: any): boolean {
  return String(rz?.reference_id || "").startsWith(REFERENCE_PREFIX) || rz?.notes?.source === NOTES_SOURCE;
}

/** Razorpay wants 8–14 characters with the country code; anything else is left off. */
function razorpayContact(phone?: string): string | undefined {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  if (!digits) return undefined;
  const withCc = digits.startsWith("+") ? digits : digits.length === 10 ? `+91${digits}` : `+${digits}`;
  return withCc.length >= 8 && withCc.length <= 14 ? withCc : undefined;
}

function cleanRecipient(r: any): Recipient {
  const email = str(r?.email, 200).toLowerCase();
  return {
    name: str(r?.name, 120) || undefined,
    email: email || undefined,
    phone: str(r?.phone, 20) || undefined,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ───────────────────────── subjects ───────────────────────── */

export type ResolvedSubject = {
  subject: PaymentRequestSubject;
  subjectId: mongoose.Types.ObjectId;
  doc: any;
  targetPaise: number;
  targetRupees: number;
  customerId: mongoose.Types.ObjectId;
  invoiceWorkspaceId?: mongoose.Types.ObjectId;
  bookingIds: mongoose.Types.ObjectId[];
  invoiceId?: mongoose.Types.ObjectId;
  requestId?: mongoose.Types.ObjectId;
  subjectRef: string;
  defaultRecipient: Recipient;
  /** Why a new request can't be raised on this subject right now (null = it can). */
  blockedReason: string | null;
};

/** Default recipient for a booking: the student on a partner case, else the
 *  request's requester, else the lead passenger. The RM confirms it. */
async function bookingDefaultRecipient(booking: any, request: any | null): Promise<Recipient> {
  const contact = request?.meta?.partnerLead?.contact;
  if (request?.meta?.partnerLead) {
    const lead = (booking?.passengers || [])[0];
    return cleanRecipient({
      name: contact?.name || lead?.name,
      email: contact?.email || lead?.email,
      phone: contact?.phone || lead?.phone,
    });
  }
  if (request?.frontlinerEmail) {
    return cleanRecipient({ name: request.frontlinerName, email: request.frontlinerEmail });
  }
  const lead = (booking?.passengers || [])[0];
  return cleanRecipient({ name: lead?.name, email: lead?.email, phone: lead?.phone });
}

/** Load the subject and everything a request needs from it. Throws 404 when it
 *  doesn't exist; `blockedReason` says why it can't take a NEW request. */
export async function resolveSubject(subject: unknown, id: unknown): Promise<ResolvedSubject> {
  if (subject !== "BOOKING" && subject !== "INVOICE") {
    throw new PaymentRequestError(400, "BAD_SUBJECT", "Subject must be BOOKING or INVOICE.");
  }
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw new PaymentRequestError(404, "NOT_FOUND", "Not found.");
  }

  if (subject === "BOOKING") {
    const booking: any = await ManualBooking.findById(id).lean();
    if (!booking || booking.isDeleted) throw new PaymentRequestError(404, "NOT_FOUND", "Booking not found.");
    const targetRupees = Number(booking?.pricing?.grandTotal ?? 0);
    const targetPaise = rupeesToPaise(targetRupees);
    let blockedReason: string | null = null;
    if (!BOOKING_STATUSES_ALLOWED.includes(booking.status)) {
      blockedReason = `A payment link can't be raised on a ${String(booking.status).toLowerCase()} booking.`;
    } else if (!Number.isFinite(targetPaise) || targetPaise < MIN_LINK_PAISE) {
      blockedReason = "This booking has no grand total yet.";
    }
    const requestId =
      booking.source === "ADMIN_QUEUE" && booking.sourceBookingId && mongoose.Types.ObjectId.isValid(String(booking.sourceBookingId))
        ? oid(booking.sourceBookingId)
        : undefined;
    const request: any = requestId ? await ApprovalRequest.findById(requestId).lean() : null;
    const customerId = oid(booking.workspaceId);
    const { invoiceWorkspaceId } = await resolveInvoiceWorkspace(customerId);
    return {
      subject,
      subjectId: oid(booking._id),
      doc: booking,
      targetPaise,
      targetRupees,
      customerId,
      invoiceWorkspaceId: invoiceWorkspaceId ? oid(invoiceWorkspaceId) : undefined,
      bookingIds: [oid(booking._id)],
      requestId,
      subjectRef: String(booking.bookingRef || ""),
      defaultRecipient: await bookingDefaultRecipient(booking, request),
      blockedReason,
    };
  }

  const invoice: any = await Invoice.findById(id).lean();
  if (!invoice) throw new PaymentRequestError(404, "NOT_FOUND", "Invoice not found.");
  const targetRupees = Number(invoice.grandTotal ?? 0);
  const targetPaise = rupeesToPaise(targetRupees);
  let blockedReason: string | null = null;
  if (!INVOICE_STATUSES_ALLOWED.includes(invoice.status)) {
    blockedReason = "Payment links can only be raised on a SENT invoice.";
  } else if (!Number.isFinite(targetPaise) || targetPaise < MIN_LINK_PAISE) {
    blockedReason = "This invoice has no amount to collect.";
  }
  // Invoice.workspaceId is a CustomerWorkspace._id, or the Customer._id when
  // the client had no workspace at generation (resolveInvoiceWorkspace).
  let customerId = oid(invoice.workspaceId);
  const ws: any = await CustomerWorkspace.findById(invoice.workspaceId).select("customerId").lean();
  if (ws?.customerId && mongoose.Types.ObjectId.isValid(String(ws.customerId))) customerId = oid(ws.customerId);
  return {
    subject,
    subjectId: oid(invoice._id),
    doc: invoice,
    targetPaise,
    targetRupees,
    customerId,
    invoiceWorkspaceId: oid(invoice.workspaceId),
    bookingIds: (invoice.bookingIds || []).map(oid),
    invoiceId: oid(invoice._id),
    subjectRef: String(invoice.invoiceNo || ""),
    defaultRecipient: cleanRecipient({ name: invoice.clientDetails?.contactPerson || invoice.clientDetails?.companyName, email: invoice.clientDetails?.email }),
    blockedReason,
  };
}

/* ───────────────────────── summaries ───────────────────────── */

export type BookingPaymentSummary = {
  paidBasePaise: number;
  /** bookingRefs: the bookings' MB-… refs, for "₹X already collected by link on MB-…". */
  paidLinks: Array<{ requestId: string; linkId: string; bookingIds: string[]; bookingRefs: string[]; basePaise: number; pgChargePaise: number; paidAt?: Date }>;
  openLinks: Array<{ requestId: string; linkId: string; bookingIds: string[]; bookingRefs: string[]; basePaise: number; expireBy: Date }>;
};

/** What BOOKING-subject requests on these bookings have collected or still
 *  have open — shown on an invoice so money is never asked for twice. */
export async function paymentSummaryForBookings(bookingIds: mongoose.Types.ObjectId[]): Promise<BookingPaymentSummary> {
  const out: BookingPaymentSummary = { paidBasePaise: 0, paidLinks: [], openLinks: [] };
  if (!bookingIds.length) return out;
  const reqs: any[] = await PaymentRequest.find({ subject: "BOOKING", bookingIds: { $in: bookingIds } }).lean();
  // One lookup for every ref this summary will name.
  const ids = [...new Set(reqs.flatMap((r) => (r.bookingIds || []).map(String)))];
  const refRows: any[] = ids.length ? await ManualBooking.find({ _id: { $in: ids } }).select("bookingRef").lean() : [];
  const refOf = new Map(refRows.map((b) => [String(b._id), String(b.bookingRef || "")]));
  for (const r of reqs) {
    for (const l of r.links || []) {
      const rBookingIds: string[] = (r.bookingIds || []).map(String);
      const base = { requestId: String(r._id), linkId: String(l._id), bookingIds: rBookingIds, bookingRefs: rBookingIds.map((id) => refOf.get(id) || "").filter(Boolean) };
      if (l.status === "PAID") {
        out.paidBasePaise += l.basePaise;
        out.paidLinks.push({ ...base, basePaise: l.basePaise, pgChargePaise: l.pgChargePaise, paidAt: l.paidAt });
      } else if (l.status === "CREATED" || l.status === "FAILED_CREATE") {
        out.openLinks.push({ ...base, basePaise: l.basePaise, expireBy: l.expireBy });
      }
    }
  }
  return out;
}

/* ───────────────────────── state ───────────────────────── */

function pushHistory(doc: any, by: string, action: string, detail?: Record<string, unknown>) {
  doc.history.push({ at: new Date(), by, action, ...(detail ? { detail } : {}) });
}

/** Recompute the request's status, open flag, and check the sum rule. */
export function recompute(doc: any) {
  const links = doc.links.map((l: any) => ({ _id: l._id, basePaise: l.basePaise, status: l.status, replacesLinkId: l.replacesLinkId }));
  const covered = coveredBasePaise(links);
  if (covered !== doc.targetBasePaise) {
    // The routes can't produce this; refusing to save keeps a broken request
    // from ever being stored.
    throw new PaymentRequestError(500, "SUM_RULE", `Links cover ${covered} paise, target is ${doc.targetBasePaise}.`);
  }
  doc.status = deriveRequestStatus(links, doc.targetBasePaise);
  doc.isOpen = doc.status === "OPEN" || doc.status === "PARTLY_PAID";
}

function rzStatusToLink(s: unknown): "CREATED" | "PAID" | "EXPIRED" | "CANCELLED" | null {
  switch (String(s || "")) {
    case "created": return "CREATED";
    case "paid": return "PAID";
    case "expired": return "EXPIRED";
    case "cancelled": return "CANCELLED";
    default: return null; // partially_paid etc. — never applied
  }
}

/**
 * Apply Razorpay's view of a link to ours, through the guarded moves.
 * Returns what happened, for the caller's history entry and response.
 */
export function applyRemoteLink(
  doc: any,
  link: any,
  rz: any,
  payment: { id?: string; amount?: number; method?: string; orderId?: string } | null,
  by: string,
): "UNCHANGED" | "ADOPTED" | "PAID" | "EXPIRED" | "CANCELLED" | "MISMATCH" | "IGNORED" {
  const target = rzStatusToLink(rz?.status);
  const adopting = link.status === "FAILED_CREATE";

  if (rz?.reference_id && rz.reference_id !== link.referenceId) {
    pushHistory(doc, by, "RAZORPAY_MISMATCH", { linkId: String(link._id), reason: "reference_id", got: rz.reference_id });
    return "MISMATCH";
  }
  if (Number(rz?.amount) !== link.totalPaise) {
    pushHistory(doc, by, "RAZORPAY_MISMATCH", { linkId: String(link._id), reason: "amount", got: rz?.amount, expected: link.totalPaise });
    return "MISMATCH";
  }

  let adopted = false;
  if (adopting && rz?.id) {
    link.razorpayLinkId = String(rz.id);
    if (rz.short_url) link.shortUrl = String(rz.short_url);
    link.createError = undefined;
    link.status = "CREATED";
    adopted = true;
  }
  if (typeof rz?.order_id === "string" && rz.order_id && !link.razorpayOrderId) link.razorpayOrderId = rz.order_id;

  if (!target || target === "CREATED") return adopted ? "ADOPTED" : "UNCHANGED";
  if (link.status === target) return adopted ? "ADOPTED" : "UNCHANGED";
  if (link.status !== "CREATED") {
    // PAID never demotes; a dead link is never revived. Recorded, not applied.
    pushHistory(doc, by, "RAZORPAY_STATE_IGNORED", { linkId: String(link._id), local: link.status, remote: rz?.status });
    return "IGNORED";
  }

  if (target === "PAID") {
    const paidPaise = Number(payment?.amount ?? rz?.amount_paid);
    if (paidPaise !== link.totalPaise) {
      pushHistory(doc, by, "RAZORPAY_MISMATCH", { linkId: String(link._id), reason: "amount_paid", got: paidPaise, expected: link.totalPaise });
      return "MISMATCH";
    }
    link.status = "PAID";
    link.paidAt = new Date();
    link.paidAmountPaise = paidPaise;
    if (payment?.id) link.razorpayPaymentId = String(payment.id);
    if (payment?.method) link.method = String(payment.method);
    if (payment?.orderId && !link.razorpayOrderId) link.razorpayOrderId = payment.orderId;
    return "PAID";
  }
  if (target === "EXPIRED") {
    link.status = "EXPIRED";
    link.expiredAt = new Date();
    return "EXPIRED";
  }
  link.status = "CANCELLED";
  link.cancelledAt = new Date();
  return "CANCELLED";
}

/** First payment on a fetched link, as Razorpay's link entity lists it. */
function firstPaymentOf(rz: any): { id?: string; amount?: number; method?: string } | null {
  const p = Array.isArray(rz?.payments) ? rz.payments[0] : null;
  if (!p) return null;
  return { id: p.payment_id || p.id, amount: Number(p.amount), method: p.method };
}

/* ───────────────────────── Razorpay creation ───────────────────────── */

function linkDescription(doc: any, link: any): string {
  const what = doc.subject === "INVOICE" ? `Invoice ${doc.subjectRef}` : `Booking ${doc.subjectRef}`;
  const n = doc.links.length;
  return `Plumtrips — ${what}${n > 1 ? ` (payment ${link.seq})` : ""}`;
}

/** One Razorpay create for one link, adopting by reference on any failure. */
async function createOnRazorpay(doc: any, link: any, by: string): Promise<void> {
  link.createAttempts = (link.createAttempts || 0) + 1;
  try {
    const rz = await createPaymentLink({
      amountPaise: link.totalPaise,
      referenceId: link.referenceId,
      description: linkDescription(doc, link),
      expireBy: link.expireBy,
      customer: { name: doc.recipient?.name, email: doc.recipient?.email, contact: razorpayContact(doc.recipient?.phone) },
      notes: {
        source: NOTES_SOURCE,
        paymentRequestId: String(doc._id),
        linkId: String(link._id),
        subject: doc.subject,
        subjectRef: doc.subjectRef || "",
      },
    });
    if (Number(rz?.amount) !== link.totalPaise || !rz?.id) {
      link.status = "FAILED_CREATE";
      link.createError = "Razorpay answered with a different amount";
      pushHistory(doc, by, "LINK_CREATE_FAILED", { linkId: String(link._id), error: link.createError });
      return;
    }
    link.razorpayLinkId = String(rz.id);
    link.shortUrl = rz.short_url ? String(rz.short_url) : undefined;
    if (typeof rz.order_id === "string" && rz.order_id) link.razorpayOrderId = rz.order_id;
    link.status = "CREATED";
    link.createError = undefined;
    pushHistory(doc, by, "LINK_CREATED", { linkId: String(link._id), razorpayLinkId: link.razorpayLinkId });
  } catch (err: any) {
    // Razorpay may already have it (a timeout that succeeded, or a retry of a
    // reference that exists). Look it up; adopt rather than duplicate.
    let existing: any = null;
    try {
      existing = await fetchPaymentLinkByReference(link.referenceId);
    } catch (lookupErr: any) {
      paymentLogger.warn("[payment-links] reference lookup failed after create error", { referenceId: link.referenceId, error: lookupErr?.message });
    }
    if (existing) {
      const outcome = applyRemoteLink(doc, link, existing, firstPaymentOf(existing), by);
      if (outcome !== "MISMATCH") {
        pushHistory(doc, by, "LINK_ADOPTED", { linkId: String(link._id), razorpayLinkId: String(existing.id) });
        return;
      }
      link.status = "FAILED_CREATE";
      link.createError = "A Razorpay link with this reference exists but does not match";
      return;
    }
    link.status = "FAILED_CREATE";
    link.createError = String(err?.message || "Razorpay create failed").slice(0, 300);
    pushHistory(doc, by, "LINK_CREATE_FAILED", { linkId: String(link._id), error: link.createError });
    paymentLogger.warn("[payment-links] link create failed", { requestId: String(doc._id), linkId: String(link._id), error: link.createError });
  }
}

function assertGateway() {
  if (!paymentLinksConfigured()) {
    throw new PaymentRequestError(503, "GATEWAY_NOT_CONFIGURED", "Online payment isn't switched on.");
  }
}

function assertCreationAllowed() {
  assertGateway();
  if (!paymentLinksCreationAllowed()) {
    throw new PaymentRequestError(503, "LIVE_LINKS_DISABLED", "Payment links are not enabled on the live account yet.");
  }
}

async function saveRequest(doc: any) {
  recompute(doc);
  try {
    await doc.save();
  } catch (err: any) {
    if (err?.name === "VersionError") {
      throw new PaymentRequestError(409, "CONFLICT", "This payment request changed meanwhile — reload and try again.");
    }
    throw err;
  }
}

/* ───────────────────────── create ───────────────────────── */

export type CreateInput = {
  subject: unknown;
  subjectId: unknown;
  split: SplitInput;
  pgChargePct?: unknown;
  expireBy?: unknown;
  recipient: Recipient;
  confirm?: boolean;
  /** Validate and compute the links exactly as creation would, then stop:
   *  nothing is saved and Razorpay is not called. The confirm screen shows
   *  this server plan, not the browser's arithmetic. */
  dryRun?: boolean;
};

export type CreatePlan = {
  targetBasePaise: number;
  splitPattern: string;
  pgChargePct: number;
  expireBy: Date;
  recipient: Recipient;
  links: Array<{ seq: number; basePaise: number; pgChargePaise: number; totalPaise: number }>;
  /** What the customer pays across all links: target + every PG charge. */
  customerTotalPaise: number;
};

export type CreateResult =
  | { kind: "WARNING"; warning: { code: string; message: string; summary: BookingPaymentSummary } }
  | { kind: "DRY_RUN"; plan: CreatePlan }
  | { kind: "CREATED"; request: any };

export async function createPaymentRequest(input: CreateInput, resolved: ResolvedSubject, actor: Actor): Promise<CreateResult> {
  assertCreationAllowed();
  if (resolved.blockedReason) throw new PaymentRequestError(409, "SUBJECT_NOT_ELIGIBLE", resolved.blockedReason);

  let bases: number[];
  let pattern: string;
  let pct: number;
  let expireBy: Date;
  try {
    ({ bases, pattern } = splitBases(resolved.targetPaise, input.split));
    pct = parsePgPct(input.pgChargePct);
    expireBy = clampExpiry(input.expireBy);
  } catch (err) {
    if (err instanceof PaymentMathError) throw new PaymentRequestError(400, err.code, err.message);
    throw err;
  }

  const recipient = cleanRecipient(input.recipient);
  if (!recipient.email || !EMAIL_RE.test(recipient.email)) {
    throw new PaymentRequestError(400, "BAD_RECIPIENT", "Confirm the recipient's email address.");
  }

  const existing = await PaymentRequest.findOne({ subject: resolved.subject, subjectId: resolved.subjectId, isOpen: true }).select("_id").lean();
  if (existing) {
    throw new PaymentRequestError(409, "OPEN_REQUEST_EXISTS", "There is already an open payment request for this. Cancel its links first.", { requestId: String((existing as any)._id) });
  }

  if (resolved.subject === "INVOICE") {
    const summary = await paymentSummaryForBookings(resolved.bookingIds);
    if ((summary.paidLinks.length || summary.openLinks.length) && input.confirm !== true) {
      return {
        kind: "WARNING",
        warning: {
          code: summary.paidLinks.length ? "BOOKINGS_ALREADY_PAID_BY_LINK" : "BOOKINGS_HAVE_OPEN_LINKS",
          message: summary.paidLinks.length
            ? `₹${(summary.paidBasePaise / 100).toFixed(2)} has already been collected by payment link on this invoice's bookings. Send confirm: true to raise links anyway.`
            : "This invoice's bookings still have open payment links. Send confirm: true to raise links anyway.",
          summary,
        },
      };
    }
  }

  if (input.dryRun === true) {
    const planLinks = bases.map((base, i) => {
      const pg = pgChargePaise(base, pct);
      return { seq: i + 1, basePaise: base, pgChargePaise: pg, totalPaise: base + pg };
    });
    return {
      kind: "DRY_RUN",
      plan: {
        targetBasePaise: resolved.targetPaise,
        splitPattern: pattern,
        pgChargePct: pct,
        expireBy,
        recipient,
        links: planLinks,
        customerTotalPaise: planLinks.reduce((s, l) => s + l.totalPaise, 0),
      },
    };
  }

  const _id = new mongoose.Types.ObjectId();
  const links = bases.map((base, i) => {
    const pg = pgChargePaise(base, pct);
    return {
      _id: new mongoose.Types.ObjectId(),
      seq: i + 1,
      basePaise: base,
      pgChargePaise: pg,
      totalPaise: base + pg,
      referenceId: referenceIdFor(_id, i + 1),
      expireBy,
      status: "FAILED_CREATE",
      createError: "NOT_ATTEMPTED",
      createAttempts: 0,
      emailOutboxIds: [],
    };
  });

  const doc: any = new PaymentRequest({
    _id,
    subject: resolved.subject,
    subjectId: resolved.subjectId,
    bookingIds: resolved.bookingIds,
    invoiceId: resolved.invoiceId,
    requestId: resolved.requestId,
    customerId: resolved.customerId,
    invoiceWorkspaceId: resolved.invoiceWorkspaceId,
    mid: "B2B",
    subjectRef: resolved.subjectRef,
    targetBasePaise: resolved.targetPaise,
    targetSource: {
      kind: resolved.subject === "BOOKING" ? "BOOKING_GRAND_TOTAL" : "INVOICE_GRAND_TOTAL",
      valueAtCreation: resolved.targetRupees,
    },
    splitPattern: pattern,
    pgChargePct: pct,
    recipient,
    status: "OPEN",
    isOpen: true,
    links,
    history: [],
    createdBy: actor.id,
    createdByEmail: actor.email,
  });
  pushHistory(doc, actor.id, "REQUEST_CREATED", { targetBasePaise: resolved.targetPaise, splitPattern: pattern, pgChargePct: pct, links: bases.length });

  try {
    await saveRequest(doc);
  } catch (err: any) {
    if (err?.code === 11000) {
      throw new PaymentRequestError(409, "OPEN_REQUEST_EXISTS", "There is already an open payment request for this.");
    }
    throw err;
  }

  for (const link of doc.links) await createOnRazorpay(doc, link, actor.id);
  await saveRequest(doc);
  return { kind: "CREATED", request: doc };
}

/* ───────────────────────── retry / cancel / replace / refresh ───────────────────────── */

export async function retryFailedLinks(doc: any, actor: Actor): Promise<any> {
  assertCreationAllowed();
  if (!doc.isOpen) throw new PaymentRequestError(409, "REQUEST_CLOSED", "This payment request is closed.");
  const failed = doc.links.filter((l: any) => l.status === "FAILED_CREATE");
  if (!failed.length) throw new PaymentRequestError(409, "NOTHING_TO_RETRY", "No link is waiting to be created.");
  for (const link of failed) await createOnRazorpay(doc, link, actor.id);
  await saveRequest(doc);
  return doc;
}

function findLink(doc: any, linkId: unknown): any {
  const link = doc.links.find((l: any) => String(l._id) === String(linkId));
  if (!link) throw new PaymentRequestError(404, "LINK_NOT_FOUND", "Link not found.");
  return link;
}

/** Cancel one link on Razorpay and here. Mutates `doc`; does not save. */
async function cancelOne(doc: any, link: any, by: string): Promise<"CANCELLED" | "REFRESHED" | "NOT_CANCELLABLE"> {
  if (link.status === "FAILED_CREATE") {
    // It may exist on Razorpay after all (a timed-out create): look before
    // writing it off, or a live link would outlive its record.
    let existing: any = null;
    try {
      existing = await fetchPaymentLinkByReference(link.referenceId);
    } catch (err: any) {
      throw new PaymentRequestError(502, "RAZORPAY_UNAVAILABLE", `Couldn't check Razorpay: ${err?.message || "error"}`);
    }
    if (!existing) {
      link.status = "CANCELLED";
      link.cancelledAt = new Date();
      pushHistory(doc, by, "LINK_CANCELLED", { linkId: String(link._id), note: "never created on Razorpay" });
      return "CANCELLED";
    }
    const adopted = applyRemoteLink(doc, link, existing, firstPaymentOf(existing), by);
    if (adopted === "MISMATCH" || link.status !== "CREATED") return "REFRESHED";
  }
  if (link.status !== "CREATED") return "NOT_CANCELLABLE";

  try {
    // Razorpay only cancels a `created` link, and ours is CREATED: a 2xx here
    // is the CREATED → CANCELLED move.
    await cancelPaymentLink(link.razorpayLinkId);
    link.status = "CANCELLED";
    link.cancelledAt = new Date();
    pushHistory(doc, by, "LINK_CANCELLED", { linkId: String(link._id) });
    return "CANCELLED";
  } catch (err: any) {
    if (err instanceof RazorpayLinkError && err.status === 400) {
      // Already paid / expired on Razorpay: take its word, through the guards.
      const rz = await fetchPaymentLink(link.razorpayLinkId);
      applyRemoteLink(doc, link, rz, firstPaymentOf(rz), by);
      pushHistory(doc, by, "LINK_CANCEL_REFUSED", { linkId: String(link._id), razorpay: err.message, now: link.status });
      return "REFRESHED";
    }
    throw new PaymentRequestError(502, "RAZORPAY_UNAVAILABLE", `Razorpay didn't cancel the link: ${err?.message || "error"}`);
  }
}

export async function cancelLink(doc: any, linkId: unknown, actor: Actor): Promise<{ request: any; outcome: string }> {
  assertGateway();
  const link = findLink(doc, linkId);
  if (link.status !== "CREATED" && link.status !== "FAILED_CREATE") {
    throw new PaymentRequestError(409, "NOT_CANCELLABLE", `A ${link.status.toLowerCase()} link can't be cancelled.`);
  }
  const outcome = await cancelOne(doc, link, actor.id);
  await saveRequest(doc);
  return { request: doc, outcome };
}

/**
 * Replace a cancelled / expired link — or a created one, which is cancelled
 * first — with a new link for exactly the same base, a new reference, and
 * replacesLinkId pointing back.
 */
export async function replaceLink(doc: any, linkId: unknown, opts: { expireBy?: unknown }, actor: Actor): Promise<any> {
  assertCreationAllowed();
  if (!doc.isOpen) throw new PaymentRequestError(409, "REQUEST_CLOSED", "This payment request is closed — raise a new one.");
  const old = findLink(doc, linkId);
  if (doc.links.some((l: any) => String(l.replacesLinkId || "") === String(old._id))) {
    throw new PaymentRequestError(409, "ALREADY_REPLACED", "This link has already been replaced.");
  }
  if (old.status === "PAID") throw new PaymentRequestError(409, "LINK_PAID", "A paid link can't be replaced.");
  if (old.status === "FAILED_CREATE") throw new PaymentRequestError(409, "RETRY_INSTEAD", "Retry this link instead of replacing it.");

  let expireBy: Date;
  try {
    expireBy = clampExpiry(opts.expireBy);
  } catch (err) {
    if (err instanceof PaymentMathError) throw new PaymentRequestError(400, err.code, err.message);
    throw err;
  }

  if (old.status === "CREATED") {
    const outcome = await cancelOne(doc, old, actor.id);
    if (old.status === "PAID") {
      await saveRequest(doc);
      throw new PaymentRequestError(409, "LINK_PAID", "The link was paid meanwhile — nothing to replace.");
    }
    if (outcome !== "CANCELLED" && old.status !== "EXPIRED" && old.status !== "CANCELLED") {
      throw new PaymentRequestError(409, "NOT_CANCELLABLE", "The link couldn't be cancelled, so it wasn't replaced.");
    }
  }

  const seq = Math.max(...doc.links.map((l: any) => l.seq)) + 1;
  const pg = pgChargePaise(old.basePaise, doc.pgChargePct);
  doc.links.push({
    _id: new mongoose.Types.ObjectId(),
    seq,
    basePaise: old.basePaise,
    pgChargePaise: pg,
    totalPaise: old.basePaise + pg,
    referenceId: referenceIdFor(doc._id, seq),
    expireBy,
    status: "FAILED_CREATE",
    createError: "NOT_ATTEMPTED",
    createAttempts: 0,
    replacesLinkId: old._id,
    emailOutboxIds: [],
  });
  const fresh = doc.links[doc.links.length - 1];
  pushHistory(doc, actor.id, "LINK_REPLACEMENT_ADDED", { linkId: String(fresh._id), replacesLinkId: String(old._id), basePaise: old.basePaise });
  await saveRequest(doc); // persist-first, as at creation
  await createOnRazorpay(doc, doc.links.find((l: any) => String(l._id) === String(fresh._id)), actor.id);
  await saveRequest(doc);
  return doc;
}

/** Pull every link's state from Razorpay and apply it through the guards. */
export async function refreshFromRazorpay(doc: any, actor: Actor): Promise<{ request: any; changes: Array<{ linkId: string; outcome: string }> }> {
  assertGateway();
  const changes: Array<{ linkId: string; outcome: string }> = [];
  for (const link of doc.links) {
    try {
      let rz: any = null;
      if (link.razorpayLinkId) rz = await fetchPaymentLink(link.razorpayLinkId);
      else if (link.status === "FAILED_CREATE") rz = await fetchPaymentLinkByReference(link.referenceId);
      if (!rz) continue;
      const outcome = applyRemoteLink(doc, link, rz, firstPaymentOf(rz), actor.id);
      if (outcome !== "UNCHANGED") changes.push({ linkId: String(link._id), outcome });
    } catch (err: any) {
      changes.push({ linkId: String(link._id), outcome: `ERROR: ${String(err?.message || "fetch failed").slice(0, 120)}` });
    }
  }
  if (changes.length) pushHistory(doc, actor.id, "REFRESHED", { changes });
  await saveRequest(doc);
  for (const c of changes) if (c.outcome === "PAID") await resolveOrphanForLink(doc, c.linkId);
  return { request: doc, changes };
}

/* ───────────────────────── webhook ───────────────────────── */

async function resolveOrphanForLink(doc: any, linkId: string) {
  const link = doc.links.find((l: any) => String(l._id) === linkId);
  if (!link?.razorpayPaymentId) return;
  try {
    await PaymentOrphan.updateOne(
      { razorpayPaymentId: link.razorpayPaymentId, resolvedAt: { $exists: false } },
      { $set: { resolvedAt: new Date(), resolvedBy: "payment-links", notes: `payment link ${link.referenceId} (request ${String(doc._id)})` } },
    );
  } catch (err: any) {
    paymentLogger.error("[payment-links] could not resolve the matching payment orphan", { paymentId: link.razorpayPaymentId, error: err?.message });
  }
}

export type WebhookOutcome = { handled: boolean; outcome: string; requestId?: string };

/**
 * Apply a payment_link.* webhook. The link is found by its Razorpay id —
 * never by notes. A link we still hold as FAILED_CREATE (its create timed
 * out) is matched by our own reference_id instead, then checked like any
 * other. Load → apply → save under optimistic concurrency, retried on a
 * version clash; a replay finds the state already applied and is a no-op.
 */
export async function applyPaymentLinkWebhook(event: string, payload: any): Promise<WebhookOutcome> {
  const rz = payload?.payload?.payment_link?.entity || {};
  const pay = payload?.payload?.payment?.entity || null;
  const rzId = String(rz.id || "");
  if (!rzId) return { handled: false, outcome: "NO_LINK_ID" };

  for (let attempt = 0; attempt < 3; attempt++) {
    let doc: any = await PaymentRequest.findOne({ "links.razorpayLinkId": rzId });
    let link: any = doc?.links.find((l: any) => l.razorpayLinkId === rzId);
    if (!doc && String(rz.reference_id || "").startsWith(REFERENCE_PREFIX)) {
      doc = await PaymentRequest.findOne({ "links.referenceId": String(rz.reference_id) });
      link = doc?.links.find((l: any) => l.referenceId === String(rz.reference_id) && l.status === "FAILED_CREATE" && !l.razorpayLinkId);
    }
    if (!doc || !link) return { handled: false, outcome: "UNKNOWN_LINK" };

    const remote = { ...rz };
    if (event === "payment_link.paid") remote.status = "paid";
    else if (event === "payment_link.expired") remote.status = "expired";
    else if (event === "payment_link.cancelled") remote.status = "cancelled";

    const outcome = applyRemoteLink(
      doc,
      link,
      remote,
      pay ? { id: pay.id, amount: Number(pay.amount), method: pay.method, orderId: pay.order_id } : null,
      "razorpay-webhook",
    );
    if (outcome === "UNCHANGED") return { handled: true, outcome: "REPLAY", requestId: String(doc._id) };
    pushHistory(doc, "razorpay-webhook", `WEBHOOK_${event.replace("payment_link.", "").toUpperCase()}`, { linkId: String(link._id), outcome });
    try {
      recompute(doc);
      await doc.save();
    } catch (err: any) {
      if (err?.name === "VersionError") continue;
      if (err?.code === 11000) return { handled: true, outcome: "DUPLICATE_PAYMENT", requestId: String(doc._id) };
      throw err;
    }
    if (outcome === "PAID") await resolveOrphanForLink(doc, String(link._id));
    if (outcome === "MISMATCH" || outcome === "IGNORED") {
      paymentLogger.error("[payment-links] webhook not applied", { event, requestId: String(doc._id), linkId: String(link._id), outcome });
    }
    return { handled: true, outcome, requestId: String(doc._id) };
  }
  return { handled: false, outcome: "VERSION_CONFLICT" };
}

/* ───────────────────────── R1 — orphan recogniser ───────────────────────── */

/**
 * Is this captured payment one of OUR payment links? Used by the B2B webhook
 * just before it would record a PaymentOrphan. First by the order id we
 * stored; failing that, ONE Razorpay lookup by payment id. A link made by
 * hand on the Razorpay dashboard has neither our reference prefix nor our
 * notes, so it still orphans exactly as before. Any lookup error answers
 * "not ours" — the orphan net stays the safe default.
 */
export async function isPlumboxPaymentLinkPayment(paymentEntity: any): Promise<boolean> {
  const orderId = String(paymentEntity?.order_id || "");
  if (orderId && (await PaymentRequest.exists({ "links.razorpayOrderId": orderId }))) return true;

  const paymentId = String(paymentEntity?.id || "");
  if (!paymentId || !paymentLinksConfigured()) return false;
  try {
    const rz = await fetchPaymentLinkByPaymentId(paymentId);
    if (!rz || !isPlumboxRazorpayLink(rz)) return false;
    if (orderId) {
      await PaymentRequest.updateOne(
        { "links.referenceId": String(rz.reference_id) },
        { $set: { "links.$[l].razorpayOrderId": orderId }, $inc: { __v: 1 } },
        { arrayFilters: [{ "l.referenceId": String(rz.reference_id), "l.razorpayOrderId": { $exists: false } }] },
      ).catch(() => undefined);
    }
    return true;
  } catch (err: any) {
    paymentLogger.warn("[payment-links] payment_id lookup failed — treating as not a payment link", { paymentId, error: err?.message });
    return false;
  }
}

/* ───────────────────────── list summary ───────────────────────── */

export type BookingLinkSummary = {
  /** The request the chip describes: the open one, else the latest. */
  requestId: string;
  status: "OPEN" | "PARTLY_PAID" | "PAID" | "CANCELLED";
  targetBasePaise: number;
  /** Links of that request that are live or paid (cancelled / expired left out). */
  linkCount: number;
  paidLinkCount: number;
  /** Across ALL of the booking's requests — what a cancel would have to deal with. */
  paidBasePaise: number;
  openLinkCount: number;
};

/** One query for a page of bookings — the list's Payment chip, without N+1. */
export function paymentSummaryByBooking(bookingIds: mongoose.Types.ObjectId[]): Promise<Record<string, BookingLinkSummary>> {
  return paymentSummaryBySubject("BOOKING", bookingIds);
}

export type InvoiceLinkSummary = Partial<BookingLinkSummary> & {
  /** Paid on BOOKING-subject links of the invoice's bookings (R6) — may exist with no invoice request. */
  bookingPaidBasePaise: number;
};

/**
 * One page of invoices: each invoice's own request summary, plus what its
 * bookings already collected by booking links. Two queries, whatever the page
 * size. An invoice with neither is left out.
 */
export async function paymentSummaryByInvoice(invoices: Array<{ _id: unknown; bookingIds?: unknown[] }>): Promise<Record<string, InvoiceLinkSummary>> {
  const out: Record<string, InvoiceLinkSummary> = {};
  if (!invoices.length) return out;
  const own = await paymentSummaryBySubject("INVOICE", invoices.map((i) => oid(i._id)));
  const allBookingIds = [...new Set(invoices.flatMap((i) => (i.bookingIds || []).map(String)))].filter((s) => mongoose.Types.ObjectId.isValid(s));
  const bookingReqs: any[] = allBookingIds.length
    ? await PaymentRequest.find({ subject: "BOOKING", subjectId: { $in: allBookingIds.map(oid) } }).select("subjectId links.status links.basePaise").lean()
    : [];
  const paidByBooking = new Map<string, number>();
  for (const r of bookingReqs) {
    const paid = (r.links || []).filter((l: any) => l.status === "PAID").reduce((s: number, l: any) => s + l.basePaise, 0);
    if (paid) paidByBooking.set(String(r.subjectId), (paidByBooking.get(String(r.subjectId)) ?? 0) + paid);
  }
  for (const inv of invoices) {
    const key = String(inv._id);
    const bookingPaidBasePaise = (inv.bookingIds || []).reduce<number>((s, b) => s + (paidByBooking.get(String(b)) ?? 0), 0);
    if (own[key] || bookingPaidBasePaise) out[key] = { ...(own[key] || {}), bookingPaidBasePaise };
  }
  return out;
}

async function paymentSummaryBySubject(subject: PaymentRequestSubject, subjectIds: mongoose.Types.ObjectId[]): Promise<Record<string, BookingLinkSummary>> {
  const out: Record<string, BookingLinkSummary> = {};
  if (!subjectIds.length) return out;
  const reqs: any[] = await PaymentRequest.find({ subject, subjectId: { $in: subjectIds } })
    .select("subjectId status isOpen targetBasePaise links.status links.basePaise createdAt")
    .sort({ createdAt: -1 })
    .lean();
  for (const r of reqs) {
    const key = String(r.subjectId);
    const links = r.links || [];
    const paidBase = links.filter((l: any) => l.status === "PAID").reduce((s: number, l: any) => s + l.basePaise, 0);
    const open = links.filter((l: any) => l.status === "CREATED" || l.status === "FAILED_CREATE").length;
    const prev = out[key];
    // Newest first, so the first one seen is the latest — unless an older
    // request is still open, which then describes the booking better.
    const primary = !prev || (r.isOpen && prev.status !== "OPEN" && prev.status !== "PARTLY_PAID");
    if (primary) {
      out[key] = {
        requestId: String(r._id),
        status: r.status,
        targetBasePaise: r.targetBasePaise,
        linkCount: links.filter((l: any) => l.status !== "CANCELLED" && l.status !== "EXPIRED").length,
        paidLinkCount: links.filter((l: any) => l.status === "PAID").length,
        paidBasePaise: (prev?.paidBasePaise ?? 0) + paidBase,
        openLinkCount: (prev?.openLinkCount ?? 0) + open,
      };
    } else {
      prev.paidBasePaise += paidBase;
      prev.openLinkCount += open;
    }
  }
  return out;
}

/* ───────────────────────── cancel hook (Steps 2/3) ───────────────────────── */

export type CancelOpenLinksReport = {
  cancelled: Array<{ requestId: string; linkId: string }>;
  paid: Array<{ requestId: string; linkId: string; basePaise: number; pgChargePaise: number }>;
  failed: Array<{ requestId: string; linkId: string; error: string }>;
};

/**
 * Cancel every not-yet-paid link on requests whose subject IS this booking /
 * invoice, and report the paid ones (refunds are not handled here). Exported
 * for Steps 2/3 to wire into the booking and invoice cancel routes; not wired
 * yet, so nothing calls it today.
 */
export async function cancelOpenLinksForSubject(subject: PaymentRequestSubject, subjectId: unknown, actor: Actor): Promise<CancelOpenLinksReport> {
  const report: CancelOpenLinksReport = { cancelled: [], paid: [], failed: [] };
  if (!mongoose.Types.ObjectId.isValid(String(subjectId))) return report;
  const docs: any[] = await PaymentRequest.find({ subject, subjectId: oid(subjectId) });
  for (const doc of docs) {
    for (const link of doc.links) {
      if (link.status === "PAID") {
        report.paid.push({ requestId: String(doc._id), linkId: String(link._id), basePaise: link.basePaise, pgChargePaise: link.pgChargePaise });
        continue;
      }
      if (link.status !== "CREATED" && link.status !== "FAILED_CREATE") continue;
      try {
        const outcome = await cancelOne(doc, link, actor.id);
        if (link.status === "CANCELLED") report.cancelled.push({ requestId: String(doc._id), linkId: String(link._id) });
        else if (link.status === "PAID") report.paid.push({ requestId: String(doc._id), linkId: String(link._id), basePaise: link.basePaise, pgChargePaise: link.pgChargePaise });
        else report.failed.push({ requestId: String(doc._id), linkId: String(link._id), error: outcome });
      } catch (err: any) {
        report.failed.push({ requestId: String(doc._id), linkId: String(link._id), error: String(err?.message || "cancel failed") });
      }
    }
    await saveRequest(doc);
  }
  return report;
}

/**
 * Called after a ManualBooking is saved as CANCELLED (routes/manualBookings.ts
 * PUT /:id and POST /:id/cancel, services/visaBillingSync.ts). Never throws:
 * the booking is already cancelled, and a Razorpay hiccup must not turn that
 * into an error. Returns null when there was nothing to do or it failed (the
 * failure is logged; the links can still be cancelled from the booking panel).
 */
export function cancelLinksAfterBookingCancelled(bookingId: unknown, actor: Actor): Promise<CancelOpenLinksReport | null> {
  return cancelLinksAfterSubjectCancelled("BOOKING", bookingId, actor);
}

/**
 * The same for any subject — routes/invoices.ts POST /:id/cancel calls it with
 * INVOICE after the invoice is saved CANCELLED. Never throws, never blocks.
 */
export async function cancelLinksAfterSubjectCancelled(subject: PaymentRequestSubject, subjectId: unknown, actor: Actor): Promise<CancelOpenLinksReport | null> {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(subjectId))) return null;
    if (!(await PaymentRequest.exists({ subject, subjectId: oid(subjectId) }))) return null;
    const report = await cancelOpenLinksForSubject(subject, subjectId, actor);
    if (report.failed.length) {
      paymentLogger.error(`[payment-links] ${subject.toLowerCase()} cancelled but some links could not be cancelled`, { subjectId: String(subjectId), failed: report.failed });
    }
    return report;
  } catch (err: any) {
    paymentLogger.error(`[payment-links] cancelling links after ${subject.toLowerCase()} cancel failed`, { subjectId: String(subjectId), error: err?.message });
    return null;
  }
}

/** Shape for API responses. */
export function serializeRequest(doc: any) {
  const d = typeof doc?.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(d._id),
    subject: d.subject,
    subjectId: String(d.subjectId),
    subjectRef: d.subjectRef,
    bookingIds: (d.bookingIds || []).map(String),
    invoiceId: d.invoiceId ? String(d.invoiceId) : null,
    requestId: d.requestId ? String(d.requestId) : null,
    customerId: String(d.customerId),
    invoiceWorkspaceId: d.invoiceWorkspaceId ? String(d.invoiceWorkspaceId) : null,
    status: d.status,
    targetBasePaise: d.targetBasePaise,
    targetSource: d.targetSource,
    splitPattern: d.splitPattern,
    pgChargePct: d.pgChargePct,
    recipient: d.recipient,
    links: (d.links || []).map((l: any) => ({
      id: String(l._id),
      seq: l.seq,
      basePaise: l.basePaise,
      pgChargePaise: l.pgChargePaise,
      totalPaise: l.totalPaise,
      referenceId: l.referenceId,
      razorpayLinkId: l.razorpayLinkId ?? null,
      shortUrl: l.shortUrl ?? null,
      expireBy: l.expireBy,
      status: l.status,
      createError: l.status === "FAILED_CREATE" ? l.createError ?? null : null,
      paidAt: l.paidAt ?? null,
      paidAmountPaise: l.paidAmountPaise ?? null,
      method: l.method ?? null,
      replacesLinkId: l.replacesLinkId ? String(l.replacesLinkId) : null,
      emailsSent: (l.emailOutboxIds || []).length,
    })),
    history: d.history,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
