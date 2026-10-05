// Server-side SBT fulfilment: once a checkout is paid, the SERVER books with TBO
// and saves the booking — whether the browser, the Razorpay webhook or a retry
// gets there first. The money row (SBTPayment) is claimed with a conditional
// update, so exactly one caller fulfils it.
//
//   createCheckout     price (server), MC + coverage checks, then
//                        personal → Razorpay order (row CREATED, fulfilment stored)
//                        official → wallet reserved + ledger (row PAID) → fulfil
//   payCheckout        browser: verify payment with Razorpay → PAID → fulfil
//   markPaidFromWebhook webhook: payment.captured → PAID → fulfil in background
//   fulfilCheckout     run the certified route handlers (ticket-lcc, GDS book →
//                      ticket, hotel book, generate-voucher) with the stored
//                      request, then bookings/save; settle the row:
//                        TICKETED   (partial refunds for failed legs / dropped add-ons)
//                        REFUNDED   supplier failure or fare change → automatic refund
//                        NEEDS_OPS  unknown outcome → ops alerted, never refunded blind
//
// The route modules register their handlers here (registerFulfilHandlers), so
// this file does not import them — no import cycle.
import type { Request, Response } from "express";
import mongoose from "mongoose";
import SBTPayment from "../models/SBTPayment.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { sbtLogger } from "../utils/logger.js";
import { sendMail } from "../utils/mailer.js";
import { DESK_EMAIL } from "./actorNames.js";
import { releasePNR } from "./tbo.flight.service.js";
import {
  callerScope,
  isRefusal,
  priceFlight,
  priceHotelQuote,
  priceHeldHotel,
  reserveOfficial,
  refundPaymentRow,
  verifyPayment,
  type Refusal,
} from "./sbtPaymentGate.js";
import { createRazorpayOrder, razorpayConfigured, razorpayKeyId } from "./sbtRazorpay.js";
import { requestBookingRefusal, markRequestBooked } from "./sbtRequestBooking.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";

type AnyObj = Record<string, any>;
type Handler = (req: any, res: any) => unknown;

export type FulfilHandlerName =
  | "flightTicketLcc" | "flightBook" | "flightTicket" | "flightSave"
  | "hotelBook" | "hotelVoucher" | "hotelSave";

const handlers: Partial<Record<FulfilHandlerName, Handler>> = {};

/** Called once by routes/sbt.flights.ts and routes/sbt.hotels.ts at load. */
export function registerFulfilHandlers(h: Partial<Record<FulfilHandlerName, Handler>>) {
  Object.assign(handlers, h);
}

/** Run an Express handler in-process and collect its response. */
export function invokeHandler(name: FulfilHandlerName, req: AnyObj): Promise<{ status: number; body: AnyObj }> {
  const handler = handlers[name];
  if (!handler) return Promise.reject(new Error(`fulfil handler not registered: ${name}`));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (status: number, body: AnyObj) => { if (!done) { done = true; resolve({ status, body: body ?? {} }); } };
    const res: AnyObj = {
      statusCode: 200,
      headersSent: false,
      locals: {},
      status(code: number) { this.statusCode = code; return this; },
      json(body: AnyObj) { this.headersSent = true; finish(this.statusCode, body); return this; },
      send(body: unknown) { this.headersSent = true; finish(this.statusCode, typeof body === "object" ? (body as AnyObj) : { body }); return this; },
      end() { this.headersSent = true; finish(this.statusCode, {}); return this; },
      set() { return this; },
      setHeader() { return this; },
      type() { return this; },
    };
    Promise.resolve()
      .then(() => handler(req, res))
      .then(() => { if (!done) finish(res.statusCode, {}); })
      .catch((err) => { if (!done) { done = true; reject(err); } });
  });
}

/* ───────────────────────── helpers ───────────────────────── */

const send = (res: Response, r: Refusal) => res.status(r.status).json({ error: r.error, code: r.code });

/** The booker as the route handlers expect req.user — JSON-safe copy. Keeps
 *  isDemoUser: a Demo Platform booking must reach the simulator inside each
 *  handler (maybeRouteToDemoSimulator), never TBO. */
function actorOf(req: AnyObj): AnyObj {
  return JSON.parse(JSON.stringify(req.user || {}));
}

async function fakeRequest(row: AnyObj, body: AnyObj, extra: AnyObj = {}): Promise<AnyObj> {
  const wsId = new mongoose.Types.ObjectId(String(row.workspaceId));
  const workspace = await CustomerWorkspace.findById(wsId).lean();
  return {
    user: row.actor || { _id: row.userId, id: row.userId, sub: row.userId, roles: [] },
    body,
    params: {},
    query: {},
    headers: {},
    ip: "sbt-fulfil",
    get: () => undefined,
    workspaceObjectId: wsId,
    workspaceId: String(row.workspaceId),
    workspace,
    sbtPayment: row,
    sbtFulfil: { paymentRowId: String(row._id) },
    ...extra,
  };
}

const firstId = (...vals: unknown[]) => {
  for (const v of vals) if (v != null && String(v) !== "" && String(v) !== "0") return String(v);
  return "";
};

/** PNR / BookingId / TicketId out of an LCC Ticket or GDS Ticket response —
 *  the same reads SBTPaymentMode.bookWithTBO used. */
function ticketFacts(body: AnyObj) {
  const resp = body?.Response?.Response ?? body?.Response ?? body;
  const fi = resp?.FlightItinerary ?? {};
  const bookingId = firstId(fi.BookingId, resp?.BookingId, body?.BookingId);
  return {
    pnr: String(fi.PNR || resp?.PNR || body?.PNR || ""),
    bookingId,
    ticketId: String(fi.Passenger?.[0]?.Ticket?.TicketId || resp?.TicketId || bookingId || ""),
  };
}

export async function alertOps(row: AnyObj, subject: string, lines: string[]) {
  try {
    await sendMail({
      to: DESK_EMAIL,
      subject: `[SBT] ${subject}`,
      kind: "NOTIFICATIONS",
      html: `<p>${lines.map((l) => String(l).replace(/[<>&]/g, "")).join("<br/>")}</p>
        <p style="color:#64748b;font-size:12px">Checkout ${String(row._id)} · ${row.product} · ${row.mode} · ₹${row.amount}
        · workspace ${row.workspaceId} · user ${row.userId}${row.razorpayPaymentId ? ` · payment ${row.razorpayPaymentId}` : ""}</p>`,
    });
    await SBTPayment.updateOne({ _id: row._id }, { $set: { opsAlertedAt: new Date() } });
  } catch (err: any) {
    sbtLogger.error("[sbt-fulfil] ops alert email failed", { paymentRowId: String(row._id), err: err?.message });
  }
}

/** Refund everything still refundable and close the row as REFUNDED — or
 *  NEEDS_OPS (+ alert) when the refund itself fails. */
async function refundAll(row: AnyObj, failureCode: string, reason: string, opsNote: string[]) {
  const fresh = (await SBTPayment.findById(row._id).lean()) as AnyObj;
  const left = Number(fresh.amountPaise) - Number(fresh.refundedPaise || 0);
  const r = await refundPaymentRow(fresh, left, failureCode);
  if (!r.ok) {
    await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "NEEDS_OPS", failureCode, failureReason: reason } });
    await alertOps(row, `Refund FAILED — needs action (${failureCode})`, [
      `The booking was not completed (${reason}) and the automatic refund failed: ${r.error}.`,
      "Refund the customer manually and close this checkout.", ...opsNote,
    ]);
    return;
  }
  await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "REFUNDED", failureCode, failureReason: reason, completedAt: new Date() } });
  await alertOps(row, `Booking not completed — refunded (${failureCode})`, [
    `Reason: ${reason}`, `Refunded automatically: ₹${(left / 100).toFixed(2)}.`, ...opsNote,
  ]);
}

/** A ticketed checkout that booked an L1's request moves it to BOOKED. The
 *  request id is the one the booking save validated and stored — never the
 *  body's. */
async function markCheckoutRequestBooked(product: "FLIGHT" | "HOTEL", bookingDocIds: string[], workspaceId: unknown) {
  const id = bookingDocIds.find(Boolean);
  if (!id) return;
  const Model: any = product === "FLIGHT" ? SBTBooking : SBTHotelBooking;
  const doc = (await Model.findById(id).lean()) as AnyObj | null;
  if (!doc?.sbtRequestId) return;
  await markRequestBooked(doc.sbtRequestId, workspaceId,
    product === "FLIGHT" ? { bookingId: doc._id } : { hotelBookingId: doc._id }, doc);
}

/* ───────────────────────── fulfil ───────────────────────── */

type LegOutcome =
  | { outcome: "SUCCESS"; facts: AnyObj; raw: AnyObj; ssrStripped?: string; partial?: AnyObj }
  | { outcome: "FAILED"; code: string; reason: string; heldPnr?: { pnr: string; bookingId: string; traceId: string } }
  | { outcome: "UNCERTAIN"; reason: string };

function classifyHttp(status: number, body: AnyObj): "FARE_CHANGED" | "UNCERTAIN" | null {
  if (status === 409 && body?.code === "FARE_CHANGED") return "FARE_CHANGED";
  if (status === 504 || body?.status === "timeout_unconfirmed" || body?.status === "BOOKING_UNCERTAIN"
    || body?.status === "BOOKING_PENDING") return "UNCERTAIN";
  return null;
}

const reasonOf = (body: AnyObj, status: number) =>
  String(body?.error || body?.message || body?.Response?.Error?.ErrorMessage
    || body?.Response?.Response?.Error?.ErrorMessage || `HTTP ${status}`).slice(0, 300);

/** One flight leg: LCC → ticket-lcc; GDS → Book then Ticket. */
async function fulfilFlightLeg(row: AnyObj, request: AnyObj, isLCC: boolean): Promise<LegOutcome> {
  if (isLCC) {
    const r = await invokeHandler("flightTicketLcc", await fakeRequest(row, request));
    const k = classifyHttp(r.status, r.body);
    if (k === "FARE_CHANGED") return { outcome: "FAILED", code: "FARE_CHANGED", reason: "Fare changed at ticketing" };
    if (k === "UNCERTAIN") return { outcome: "UNCERTAIN", reason: reasonOf(r.body, r.status) };
    const facts = ticketFacts(r.body);
    if (r.status < 400 && facts.bookingId) {
      return {
        outcome: "SUCCESS", facts, raw: r.body, ssrStripped: r.body?.ssrStripped || "",
        partial: {
          returnPnr: String(r.body?.returnPnr || ""),
          returnBookingId: r.body?.returnBookingId ? String(r.body.returnBookingId) : "",
          returnFailed: !!(r.body?.isReturn && !r.body?.returnBookingId),
          returnFareChanged: r.body?.returnFareChanged === true,
          returnSsrStripped: r.body?.returnSsrStripped || "",
        },
      };
    }
    return { outcome: "FAILED", code: "SUPPLIER_FAILED", reason: reasonOf(r.body, r.status) };
  }

  // GDS: Book (PNR held, nothing charged), then Ticket.
  const gdsBody = { ...request };
  const b = await invokeHandler("flightBook", await fakeRequest(row, gdsBody));
  const bk = classifyHttp(b.status, b.body);
  if (bk === "UNCERTAIN") return { outcome: "UNCERTAIN", reason: reasonOf(b.body, b.status) };
  const pnr = String(b.body?.PNR || b.body?.Response?.Response?.PNR || "");
  const bookingId = firstId(b.body?.BookingId, b.body?.Response?.Response?.BookingId);
  if (b.status >= 400 || !bookingId) return { outcome: "FAILED", code: "SUPPLIER_FAILED", reason: reasonOf(b.body, b.status) };
  const held = { pnr, bookingId, traceId: String(request.TraceId || "") };
  if (b.body?.isPriceChanged === true) return { outcome: "FAILED", code: "FARE_CHANGED", reason: "Fare changed at booking", heldPnr: held };

  const t = await invokeHandler("flightTicket", await fakeRequest(row, {
    TraceId: request.TraceId, PNR: pnr, BookingId: bookingId, caseLabel: b.body?.caseLabel || "",
  }));
  const tk = classifyHttp(t.status, t.body);
  if (tk === "FARE_CHANGED") return { outcome: "FAILED", code: "FARE_CHANGED", reason: "Fare changed at ticketing", heldPnr: held };
  if (tk === "UNCERTAIN") return { outcome: "UNCERTAIN", reason: reasonOf(t.body, t.status) };
  if (t.status < 400 && (t.body?.Response?.ResponseStatus === 1 || t.body?.recoveredFromTimeout === true)) {
    const facts = ticketFacts(t.body);
    return { outcome: "SUCCESS", facts: { ...facts, pnr: facts.pnr || pnr, bookingId: facts.bookingId || bookingId }, raw: t.body };
  }
  return { outcome: "FAILED", code: "SUPPLIER_FAILED", reason: reasonOf(t.body, t.status), heldPnr: held };
}

async function releaseHeldPnr(held?: { pnr: string; bookingId: string; traceId: string }) {
  if (!held?.bookingId) return;
  try {
    await releasePNR({ BookingId: Number(held.bookingId), PNR: held.pnr });
  } catch (err: any) {
    sbtLogger.warn("[sbt-fulfil] release of held GDS PNR failed", { pnr: held.pnr, err: err?.message });
  }
}

/** Amount (rupees) a failed leg returns: its share of the fare. */
function legAmountFor(row: AnyObj, resultIndex: string): number {
  const legs = (row.legAmounts || []) as Array<{ resultIndexes?: string[]; resultIndex?: string; amount: number }>;
  const hit = legs.find((l) => (l.resultIndexes || [l.resultIndex]).includes(resultIndex));
  return Number(hit?.amount) || 0;
}

/** Add-ons TBO made us drop, in rupees ("seat" = seats, "all" = every add-on). */
function droppedAddOns(row: AnyObj, stripped: string[]): number {
  const b = row.addOnBreakdown || { seat: 0, meal: 0, baggage: 0 };
  if (stripped.includes("all")) return Number(b.seat || 0) + Number(b.meal || 0) + Number(b.baggage || 0);
  if (stripped.includes("seat")) return Number(b.seat || 0);
  return 0;
}

export interface FulfilResult {
  checkoutId: string;
  status: string;
  failureCode?: string;
  message?: string;
  result?: AnyObj;
  refundedAmount?: number;
  pendingDecision?: AnyObj;
}

export async function checkoutView(rowId: unknown): Promise<FulfilResult> {
  const row = (await SBTPayment.findById(rowId).lean()) as AnyObj | null;
  if (!row) return { checkoutId: String(rowId), status: "NOT_FOUND" };
  const messages: Record<string, string> = {
    FARE_CHANGED: "The fare changed before your ticket could be issued. You have been refunded — please search again.",
    SUPPLIER_FAILED: "The airline or hotel could not confirm this booking. You have been refunded.",
    BOOKING_TERMS_CHANGED: "The cancellation policy changed. Please review it to continue.",
  };
  return {
    checkoutId: String(row._id),
    status: row.status,
    failureCode: row.failureCode,
    message: row.status === "NEEDS_OPS"
      ? "We could not confirm your booking automatically. Our Travel Desk has been alerted and will contact you."
      : row.failureCode ? messages[row.failureCode] || row.failureReason : undefined,
    result: row.result,
    refundedAmount: Number(row.refundedPaise || 0) / 100,
    pendingDecision: row.status === "PAID" ? row.pendingDecision : undefined,
  };
}

/**
 * Book and save a PAID checkout. Safe to call from anywhere, any number of
 * times: only the caller that moves the row PAID → CLAIMED does the work; the
 * rest get the current state.
 */
export async function fulfilCheckout(
  rowId: unknown,
  via: "browser" | "webhook" | "retry",
  opts: { acceptCancellationPolicyChange?: boolean } = {},
): Promise<FulfilResult> {
  const row = (await SBTPayment.findOneAndUpdate(
    { _id: rowId, status: "PAID", fulfilment: { $exists: true } },
    { $set: { status: "CLAIMED", claimedAt: new Date(), fulfilledVia: via }, $unset: { pendingDecision: 1 } },
    { new: true },
  ).lean()) as AnyObj | null;
  if (!row) return checkoutView(rowId);

  const f = row.fulfilment as AnyObj;
  const opsCtx = [`Kind: ${f.kind}`, `Fulfilled via: ${via}`];
  try {
    /* ── hotels ── */
    if (f.kind === "HOTEL_BOOK" || f.kind === "HOTEL_VOUCHER") {
      let r: { status: number; body: AnyObj };
      if (f.kind === "HOTEL_BOOK") {
        r = await invokeHandler("hotelBook", await fakeRequest(row, {
          ...f.request,
          bookingMode: "voucher",
          customerChargedAmount: row.amount,
          ...(opts.acceptCancellationPolicyChange ? { isCancellationPolicyChangedAccepted: true } : {}),
        }));
      } else {
        r = await invokeHandler("hotelVoucher", await fakeRequest(row, { ...(f.request || {}) }, { params: { id: row.heldBookingId } }));
      }

      if (r.status === 409 && r.body?.code === "BOOKING_TERMS_CHANGED") {
        // The customer decides: back to PAID with the new policy; accept → fulfil again,
        // walk away → the sweep refunds after 20 minutes.
        await SBTPayment.updateOne({ _id: row._id }, { $set: {
          status: "PAID", failureCode: "BOOKING_TERMS_CHANGED",
          pendingDecision: { code: "BOOKING_TERMS_CHANGED", updatedCancellationPolicy: r.body?.updatedCancellationPolicy ?? [] },
        } });
        return checkoutView(row._id);
      }
      const k = classifyHttp(r.status, r.body);
      if (k === "UNCERTAIN") {
        await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "NEEDS_OPS", failureCode: "SUPPLIER_UNCERTAIN", failureReason: reasonOf(r.body, r.status) } });
        await alertOps(row, "Hotel booking outcome unknown after payment", ["Check TBO before refunding.", ...opsCtx, `Client ref: ${f.request?.ClientReferenceId || ""}`]);
        return checkoutView(row._id);
      }
      if (!(r.status < 400 && r.body?.ok === true)) {
        const code = r.body?.code === "FARE_CHANGED" ? "FARE_CHANGED" : "SUPPLIER_FAILED";
        await refundAll(row, code, reasonOf(r.body, r.status), opsCtx);
        return checkoutView(row._id);
      }

      if (f.kind === "HOTEL_VOUCHER") {
        await SBTPayment.updateOne({ _id: row._id }, { $set: {
          status: "TICKETED", completedAt: new Date(), bookingDocIds: [String(row.heldBookingId)],
          result: { bookingDocId: String(row.heldBookingId), voucherStatus: r.body?.voucherStatus || "GENERATED" },
        } });
        return checkoutView(row._id);
      }

      const hotelData = {
        bookingId: String(r.body?.bookingId || r.body?.BookingId || ""),
        confirmationNo: r.body?.ConfirmationNo || "",
        bookingRefNo: r.body?.BookingRefNo || "",
        isHeld: r.body?.isHeld ?? false,
        lastVoucherDate: r.body?.lastVoucherDate ?? null,
        priceChangedDuringBook: r.body?.priceChangedDuringBook ?? false,
        priceChangeAmount: r.body?.priceChangeAmount ?? 0,
        clientReferenceId: r.body?.clientReferenceId || f.request?.ClientReferenceId || "",
      };
      await SBTPayment.updateOne({ _id: row._id }, { $set: { tboBookingId: hotelData.bookingId, clientReferenceId: hotelData.clientReferenceId } });
      const saved = await invokeHandler("hotelSave", await fakeRequest(row, {
        ...(f.save || {}),
        paymentMode: row.mode === "OFFICIAL" ? "official" : "personal",
        razorpayOrderId: row.razorpayOrderId,
        ...hotelData,
      }));
      const docId = String(saved.body?.booking?._id || "");
      if (saved.status >= 400 || !docId) {
        await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "NEEDS_OPS", failureCode: "SAVE_FAILED", failureReason: reasonOf(saved.body, saved.status), result: hotelData } });
        await alertOps(row, "Hotel BOOKED but not saved", ["The supplier confirmed the booking; our record failed to save. Do NOT refund.", `TBO BookingId ${hotelData.bookingId}, confirmation ${hotelData.confirmationNo}`, ...opsCtx]);
        return checkoutView(row._id);
      }
      await SBTPayment.updateOne({ _id: row._id }, { $set: {
        status: "TICKETED", completedAt: new Date(), bookingDocIds: [docId], result: { ...hotelData, bookingDocId: docId },
      } });
      await markCheckoutRequestBooked("HOTEL", [docId], row.workspaceId);
      return checkoutView(row._id);
    }

    /* ── flights ── */
    const legs: Array<{ request: AnyObj; isLCC: boolean; save: AnyObj }> =
      f.kind === "FLIGHT_MULTI"
        ? (f.request.legs || []).map((l: AnyObj, i: number) => ({
            request: l.request, isLCC: l.isLCC !== false,
            save: { ...(f.save?.common || {}), ...((f.save?.legs || [])[i] || {}) },
          }))
        : [{ request: f.request, isLCC: f.kind === "FLIGHT_LCC", save: f.save || {} }];

    const booked: AnyObj[] = [];
    const stripped: string[] = [];
    let failure: { code: string; reason: string; legIndex: number } | null = null;
    let uncertain: string | null = null;
    let partialRefund = 0; // rupees
    const partialNotes: string[] = [];

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const out = await fulfilFlightLeg(row, leg.request, leg.isLCC);
      if (out.outcome === "UNCERTAIN") { uncertain = out.reason; break; }
      if (out.outcome === "FAILED") {
        await releaseHeldPnr(out.heldPnr);
        failure = { code: out.code, reason: out.reason, legIndex: i };
        break;
      }
      if (out.ssrStripped) stripped.push(out.ssrStripped);
      if (out.partial?.returnSsrStripped) stripped.push(out.partial.returnSsrStripped);
      if (out.partial?.returnFailed || out.partial?.returnFareChanged) {
        const ibAmount = legAmountFor(row, String(leg.request.returnResultIndex || ""));
        partialRefund += ibAmount;
        partialNotes.push(`Return leg NOT ticketed (${out.partial?.returnFareChanged ? "fare changed" : "supplier failure"}) — refunded ₹${ibAmount}.`);
      }
      booked.push({ i, leg, facts: out.facts, raw: out.raw, partial: out.partial });
    }

    if (booked.length === 0) {
      if (uncertain) {
        await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "NEEDS_OPS", failureCode: "SUPPLIER_UNCERTAIN", failureReason: uncertain } });
        await alertOps(row, "Flight ticketing outcome unknown after payment", ["Check TBO (Booking Details by TraceId) before refunding.", ...opsCtx, `TraceId: ${legs[0]?.request?.TraceId || ""}`]);
        return checkoutView(row._id);
      }
      await refundAll(row, failure?.code || "SUPPLIER_FAILED", failure?.reason || "Ticketing failed", opsCtx);
      return checkoutView(row._id);
    }

    // Some or all legs ticketed: save one booking per ticketed leg.
    const bookingDocIds: string[] = [];
    const legResults: AnyObj[] = [];
    const groupId = legs.length > 1 ? String(row._id) : undefined;
    for (const b of booked) {
      const legAmount = groupId ? legAmountFor(row, String(b.leg.request.ResultIndex || "")) : undefined;
      const saved = await invokeHandler("flightSave", await fakeRequest(row, {
        ...b.leg.save,
        paymentMode: row.mode === "OFFICIAL" ? "official" : "personal",
        razorpayOrderId: row.razorpayOrderId,
        pnr: b.facts.pnr,
        bookingId: b.facts.bookingId,
        ticketId: b.facts.ticketId,
        ticketingStatus: "TICKETED",
        traceId: b.leg.request.TraceId,
        resultIndex: b.leg.request.ResultIndex,
        returnPnr: b.partial?.returnPnr || "",
        returnBookingId: b.partial?.returnBookingId || "",
        raw: b.raw,
      }, { sbtFulfil: { paymentRowId: String(row._id), legAmount, multiCityGroupId: groupId, legIndex: b.i, legCount: legs.length } }));
      const docId = String(saved.body?.booking?._id || "");
      if (docId) bookingDocIds.push(docId);
      legResults.push({ legIndex: b.i, pnr: b.facts.pnr, bookingId: b.facts.bookingId, ticketId: b.facts.ticketId,
        returnPnr: b.partial?.returnPnr || "", returnBookingId: b.partial?.returnBookingId || "", bookingDocId: docId,
        saveFailed: !docId });
    }

    // Legs after a failure were never ticketed → their share is refunded.
    if (failure || uncertain) {
      for (let j = (failure?.legIndex ?? booked.length); j < legs.length; j++) {
        if (uncertain && j === booked.length) continue; // outcome unknown — never refund blind
        const amt = legAmountFor(row, String(legs[j].request.ResultIndex || ""));
        partialRefund += amt;
        partialNotes.push(`Leg ${j + 1} NOT ticketed (${failure?.code || "stopped"}) — refunded ₹${amt}.`);
      }
    }
    const addOnRefund = droppedAddOns(row, stripped);
    if (addOnRefund > 0) partialNotes.push(`TBO rejected selected add-ons (${stripped.join(", ")}) — refunded ₹${addOnRefund}.`);
    const toRefund = Math.round((partialRefund + addOnRefund) * 100);
    let refundFailed = false;
    if (toRefund > 0) {
      const r = await refundPaymentRow(row, toRefund, "PARTIAL_NOT_DELIVERED");
      refundFailed = !r.ok;
    }

    const saveFailed = legResults.some((l) => l.saveFailed);
    const needsOps = saveFailed || refundFailed || !!uncertain;
    const first = legResults[0];
    await SBTPayment.updateOne({ _id: row._id }, { $set: {
      status: needsOps ? "NEEDS_OPS" : "TICKETED",
      completedAt: new Date(),
      tboBookingId: first?.bookingId,
      bookingDocIds,
      ...(failure ? { failureCode: `PARTIAL_${failure.code}`, failureReason: failure.reason } : {}),
      result: { ...first, legs: legResults, partialRefundAmount: toRefund / 100 },
    } });
    if (!needsOps) await markCheckoutRequestBooked("FLIGHT", bookingDocIds, row.workspaceId);
    if (needsOps || partialNotes.length) {
      await alertOps(row, needsOps ? "Booking needs action" : "Booking completed with a partial refund", [
        ...partialNotes,
        ...(saveFailed ? ["A ticketed leg failed to save in our records — do NOT refund it."] : []),
        ...(refundFailed ? ["The partial refund FAILED — refund manually."] : []),
        ...(uncertain ? [`A leg's outcome is unknown (${uncertain}) — check TBO.`] : []),
        `PNRs: ${legResults.map((l) => l.pnr).filter(Boolean).join(", ")}`,
        ...opsCtx,
      ]);
    }
    return checkoutView(row._id);
  } catch (err: any) {
    sbtLogger.error("[sbt-fulfil] fulfilment crashed — needs ops", { paymentRowId: String(row._id), err: err?.message, stack: err?.stack });
    await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "NEEDS_OPS", failureCode: "FULFIL_ERROR", failureReason: String(err?.message || err).slice(0, 300) } });
    await alertOps(row, "Fulfilment error after payment — needs action", [`Error: ${err?.message}`, "The booking may or may not exist at TBO — check before refunding.", ...opsCtx]);
    return checkoutView(row._id);
  }
}

/* ───────────────────────── checkout endpoints ───────────────────────── */

const FULFIL_KINDS = ["FLIGHT_LCC", "FLIGHT_GDS", "FLIGHT_MULTI", "HOTEL_BOOK", "HOTEL_VOUCHER"];

/** The ResultIndexes a flight checkout will ticket. */
function ticketedResultIndexes(kind: string, request: AnyObj): string[] {
  if (kind === "FLIGHT_MULTI") return (request.legs || []).map((l: AnyObj) => String(l?.request?.ResultIndex || ""));
  const out = [String(request.ResultIndex || "")];
  if (request.isReturn && !request.isSpecialReturn && request.returnResultIndex) out.push(String(request.returnResultIndex));
  return out;
}

/** Per-quote share of the fare — what a failed leg refunds. Shares are whole
 *  rupees and add up to exactly `base`. */
function legShares(legs: Array<{ resultIndexes: string[]; sellingFare: number }>, base: number) {
  const total = legs.reduce((s, l) => s + l.sellingFare, 0);
  let given = 0;
  return legs.map((l, i) => {
    const amount = i === legs.length - 1 ? base - given : Math.round(base * (total > 0 ? l.sellingFare / total : 1 / legs.length));
    given += amount;
    return { resultIndexes: l.resultIndexes, amount };
  });
}

/**
 * POST …/checkout — price on the server and start a checkout.
 *   body: { mode: "personal"|"official", kind, quoteIds | quoteId | heldBookingId,
 *           request (Book/Ticket body; multi-city: { legs: [{ request, isLCC }] }),
 *           save (booking details) }
 *   personal → { checkoutId, orderId, amount (paise), keyId }
 *   official → the fulfilment result
 */
export function createCheckoutHandler(product: "FLIGHT" | "HOTEL") {
  return async (req: Request, res: Response) => {
    try {
      const scope = callerScope(req);
      const b = (req.body || {}) as AnyObj;
      const kind = String(b.kind || "");
      const mode = b.mode === "official" ? "official" : "personal";
      if (!FULFIL_KINDS.includes(kind) || kind.startsWith("FLIGHT") !== (product === "FLIGHT")) {
        return res.status(400).json({ error: "Unknown booking kind", code: "BAD_KIND" });
      }
      const request = (b.request && typeof b.request === "object") ? b.request : {};
      const save = (b.save && typeof b.save === "object") ? b.save : {};
      // Booking an L1's request: only its assigned booker / a Workspace Leader,
      // only while PENDING — refused here, before any money moves.
      const notBookable = await requestBookingRefusal(req, save, product === "FLIGHT" ? "flight" : "hotel");
      if (notBookable) return res.status(notBookable.status).json({ error: notBookable.error, code: notBookable.code });
      let row: AnyObj;

      if (product === "FLIGHT") {
        const lists = kind === "FLIGHT_MULTI"
          ? (request.legs || []).map((l: AnyObj) => l?.request?.Passengers)
          : [request.Passengers, request.returnPassengers];
        const p = await priceFlight(scope, b.quoteIds, lists);
        if (isRefusal(p)) return send(res, p);
        const ris = ticketedResultIndexes(kind, request);
        if (!ris.length || ris.some((ri) => !ri || !p.resultIndexes.includes(ri))) {
          return res.status(410).json({ error: "Fare expired, please search again", code: "FARE_EXPIRED" });
        }
        if (kind === "FLIGHT_MULTI" && (request.legs || []).length !== (b.quoteIds || []).length) {
          return res.status(400).json({ error: "Every leg needs its own fare quote", code: "LEG_NOT_QUOTED" });
        }
        row = {
          product, ...scope, quoteIds: p.quoteIds, resultIndexes: p.resultIndexes,
          amount: p.amount, baseAmount: p.base, addOnAmount: p.addOn, addOnBreakdown: p.addOnBreakdown,
          legAmounts: legShares(p.legs, p.base), margin: p.margin,
        };
      } else if (kind === "HOTEL_VOUCHER") {
        const p = await priceHeldHotel(scope, b.heldBookingId);
        if (isRefusal(p)) return send(res, p);
        row = { product, ...scope, heldBookingId: String(b.heldBookingId), amount: p.amount, baseAmount: p.amount };
      } else {
        const p = await priceHotelQuote(scope, b.quoteId);
        if (isRefusal(p)) return send(res, p);
        if (String(request.BookingCode || "") !== p.bookingCode) {
          return res.status(410).json({ error: "Fare expired, please search again", code: "FARE_EXPIRED" });
        }
        row = {
          product, ...scope, quoteIds: [p.quoteId], bookingCode: p.bookingCode, amount: p.amount, baseAmount: p.amount,
          clientReferenceId: typeof request.ClientReferenceId === "string" ? request.ClientReferenceId : undefined,
          margin: p.margin,
        };
      }

      row.fulfilment = { kind, request, save };
      row.actor = actorOf(req);
      row.amountPaise = Math.round(row.amount * 100);

      if (mode === "official" && (req as AnyObj).user?.isDemoUser === true) {
        // Demo Platform: the simulator inside each handler deducts the demo wallet.
        const _id = new mongoose.Types.ObjectId();
        await SBTPayment.create({ ...row, _id, mode: "OFFICIAL", status: "PAID", paidAt: new Date(), isDemo: true });
        return res.json(await fulfilCheckout(_id, "browser"));
      }
      if (mode === "official") {
        const _id = new mongoose.Types.ObjectId();
        const reserved = await reserveOfficial(req, row.amount, {
          key: `debit:${_id}`, reason: "BOOKING", paymentId: String(_id), product,
        });
        if (isRefusal(reserved)) return send(res, reserved);
        await SBTPayment.create({ ...row, _id, mode: "OFFICIAL", status: "PAID", paidAt: new Date(), monthKey: reserved.monthKey });
        return res.json(await fulfilCheckout(_id, "browser"));
      }

      if (!razorpayConfigured()) return res.status(503).json({ error: "Payment gateway not configured" });
      const order = await createRazorpayOrder(row.amountPaise, `sbt_${product === "FLIGHT" ? "flt" : "htl"}_${Date.now()}`);
      if (!order?.id || Number(order.amount) !== row.amountPaise) {
        return res.status(502).json({ error: "Razorpay order creation failed" });
      }
      const doc = await SBTPayment.create({ ...row, mode: "RAZORPAY", status: "CREATED", razorpayOrderId: order.id });
      return res.json({
        ok: true, checkoutId: String(doc._id), orderId: order.id, amount: order.amount,
        currency: order.currency || "INR", keyId: razorpayKeyId(), serverAmount: row.amount,
      });
    } catch (err: any) {
      sbtLogger.error("[sbt-fulfil] checkout create failed", { product, err: err?.message });
      return res.status(500).json({ error: "Could not start checkout" });
    }
  };
}

async function ownRow(req: Request, product: "FLIGHT" | "HOTEL") {
  const id = String((req.params as AnyObj)?.id || "");
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  return (await SBTPayment.findOne({ _id: id, product, ...callerScope(req) }).lean()) as AnyObj | null;
}

/** POST …/checkout/:id/pay — Razorpay handler data → verify → book. */
export function payCheckoutHandler(product: "FLIGHT" | "HOTEL") {
  return async (req: Request, res: Response) => {
    try {
      const row = await ownRow(req, product);
      if (!row || row.mode !== "RAZORPAY") return res.status(404).json({ error: "Checkout not found" });
      const b = (req.body || {}) as AnyObj;
      if (String(b.razorpay_order_id || "") !== row.razorpayOrderId) {
        return res.status(400).json({ error: "Payment does not belong to this order", code: "ORDER_MISMATCH" });
      }
      const v = await verifyPayment(callerScope(req), product, b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature);
      if (isRefusal(v)) return send(res, v);
      return res.json(await fulfilCheckout(row._id, "browser"));
    } catch (err: any) {
      sbtLogger.error("[sbt-fulfil] pay failed", { err: err?.message });
      return res.status(500).json({ error: "Payment could not be completed" });
    }
  };
}

/** POST …/checkout/:id/fulfil — retry a PAID checkout (e.g. after accepting a
 *  changed cancellation policy: { acceptCancellationPolicyChange: true }). */
export function retryCheckoutHandler(product: "FLIGHT" | "HOTEL") {
  return async (req: Request, res: Response) => {
    const row = await ownRow(req, product);
    if (!row) return res.status(404).json({ error: "Checkout not found" });
    return res.json(await fulfilCheckout(row._id, "retry", {
      acceptCancellationPolicyChange: (req.body as AnyObj)?.acceptCancellationPolicyChange === true,
    }));
  };
}

/** GET …/checkout/:id — status (the browser polls it after a webhook-completed payment). */
export function getCheckoutHandler(product: "FLIGHT" | "HOTEL") {
  return async (req: Request, res: Response) => {
    const row = await ownRow(req, product);
    if (!row) return res.status(404).json({ error: "Checkout not found" });
    return res.json(await checkoutView(row._id));
  };
}

/* ───────────────────────── webhook ───────────────────────── */

/**
 * payment.captured for a checkout order. Returns false when the order is not a
 * checkout (legacy handling continues). Marks PAID only when Razorpay's amount
 * and currency match the server order; then books in the background so the
 * webhook answers Razorpay at once (the sweep is the backstop).
 */
export async function markPaidFromWebhook(paymentEntity: AnyObj): Promise<boolean> {
  const orderId = String(paymentEntity?.order_id || "");
  if (!orderId) return false;
  const row = (await SBTPayment.findOne({ razorpayOrderId: orderId }).lean()) as AnyObj | null;
  if (!row) return false;
  if (row.status !== "CREATED") return true; // already paid / fulfilled — replay is a no-op
  const paise = Number(paymentEntity?.amount);
  if (paise !== Number(row.amountPaise) || String(paymentEntity?.currency || "INR") !== "INR") {
    sbtLogger.error("[sbt-fulfil] webhook amount differs from server order — NOT marked paid", {
      paymentRowId: String(row._id), paise, expected: row.amountPaise,
    });
    await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "NEEDS_OPS", failureCode: "AMOUNT_MISMATCH", lastPaymentFailure: `captured ${paise} vs order ${row.amountPaise}` } });
    await alertOps(row, "Captured amount differs from the order — needs action", [`Razorpay captured ${paise} paise; the order was ${row.amountPaise}.`, "Nothing was booked. Refund the payment."]);
    return true;
  }
  try {
    const updated = await SBTPayment.findOneAndUpdate(
      { _id: row._id, status: "CREATED" },
      { $set: { status: "PAID", razorpayPaymentId: String(paymentEntity.id), paidAt: new Date() } },
      { new: true },
    );
    if (!updated) return true;
  } catch (err: any) {
    if (err?.code === 11000) return true; // this payment already backs another row
    throw err;
  }
  if (row.fulfilment) {
    setImmediate(() => {
      fulfilCheckout(row._id, "webhook").catch((err) =>
        sbtLogger.error("[sbt-fulfil] webhook fulfilment failed", { paymentRowId: String(row._id), err: err?.message }));
    });
  }
  return true;
}

/* ───────────────────────── sweep ───────────────────────── */

export const SWEEP_AFTER_MS = 20 * 60 * 1000;

/**
 * Backstop, every few minutes:
 *  - PAID checkouts nobody fulfilled within 20 min (browser closed, webhook
 *    lost, policy change never answered) → refund automatically + alert ops.
 *  - CLAIMED checkouts stuck for 20 min (process died mid-booking) → NEEDS_OPS
 *    + alert; never refunded blind, the ticket may exist.
 */
export async function sweepCheckouts(now = new Date()): Promise<{ refunded: number; flagged: number }> {
  const cutoff = new Date(now.getTime() - SWEEP_AFTER_MS);
  let refunded = 0;
  let flagged = 0;
  const stalePaid = (await SBTPayment.find({
    status: "PAID", fulfilment: { $exists: true }, paidAt: { $lt: cutoff }, isTest: { $ne: true },
  }).limit(50).lean()) as AnyObj[];
  for (const row of stalePaid) {
    // Claim it so a late browser/webhook fulfil cannot race the refund.
    const claimed = await SBTPayment.findOneAndUpdate(
      { _id: row._id, status: "PAID" }, { $set: { status: "CLAIMED", claimedAt: now, fulfilledVia: "retry" } }, { new: true },
    ).lean();
    if (!claimed) continue;
    await refundAll(claimed as AnyObj, row.failureCode === "BOOKING_TERMS_CHANGED" ? "TERMS_NOT_ACCEPTED" : "NOT_FULFILLED",
      "Paid but not booked within 20 minutes", ["Swept by the 20-minute backstop."]);
    refunded++;
  }
  const stuck = (await SBTPayment.find({
    status: "CLAIMED", fulfilment: { $exists: true }, claimedAt: { $lt: cutoff },
  }).limit(50).lean()) as AnyObj[];
  for (const row of stuck) {
    const r = await SBTPayment.updateOne({ _id: row._id, status: "CLAIMED" }, { $set: { status: "NEEDS_OPS", failureCode: "STUCK", failureReason: "Booking in progress for over 20 minutes" } });
    if (r.modifiedCount !== 1) continue;
    await alertOps(row, "Booking stuck after payment — needs action", ["Fulfilment started but never finished (process restart?). Check TBO for a ticket before refunding."]);
    flagged++;
  }
  return { refunded, flagged };
}
