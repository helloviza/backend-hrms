// SBT payment containment: the server prices every booking itself and books
// with TBO only after the payment is proven.
//
//   guards          sbtBookerGuards — SBT workspace + not an L1 requester
//   pricing         priceFlight / priceHotelQuote / priceHeldHotel — from the
//                   server's SBTQuote (+ the SSR prices TBO returned), never a
//                   client amount
//   create-order    createOrderHandler — Razorpay order for the server amount
//   verify          verifyHandler — signature AND the payment fetched from
//                   Razorpay is captured, for this order, for exactly that amount
//   paymentGate     before book / ticket / ticket-lcc / generate-voucher: claim a
//                   PAID Razorpay row, or reserve the business-wallet monthly limit
//                   with a conditional update; settle on the supplier's answer
//
// Every money row is an SBTPayment (models/SBTPayment.ts).
import type { Request, Response, NextFunction } from "express";
import SBTQuote from "../models/SBTQuote.js";
import SBTPayment from "../models/SBTPayment.js";
import SBTSsrSnapshot, { type SsrPriceItem } from "../models/SBTSsrSnapshot.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import SBTMultiCityTrace from "../models/SBTMultiCityTrace.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { sbtLogger } from "../utils/logger.js";
import {
  razorpayConfigured,
  razorpayKeyId,
  checkoutSignatureValid,
  createRazorpayOrder,
  fetchRazorpayPayment,
  captureRazorpayPayment,
} from "./sbtRazorpay.js";

type AnyObj = Record<string, any>;
type Product = "FLIGHT" | "HOTEL";

/** Quotes are usable for this long (matches the SBTQuote TTL index). */
export const QUOTE_TTL_MS = 3600 * 1000;

export interface Refusal { ok: false; status: number; code: string; error: string }
const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });
/** Narrowing on `ok` needs strictNullChecks, which this project has off. */
export function isRefusal(x: unknown): x is Refusal {
  return (x as AnyObj)?.ok === false;
}
const send = (res: Response, r: Refusal) => res.status(r.status).json({ error: r.error, code: r.code });

export function callerScope(req: Request | AnyObj): { workspaceId: string; userId: string } {
  const r = req as AnyObj;
  return {
    workspaceId: String(r.workspaceObjectId ?? ""),
    userId: String(r.user?._id ?? r.user?.id ?? r.user?.sub ?? ""),
  };
}

const monthKeyNow = () => new Date().toISOString().slice(0, 7); // same key the wallet routes use

/* ───────────────────────── guards ───────────────────────── */

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254"; // Plumtrips HOUSE (same literal as requireHouse)

/** Plumtrips Travel Desk: SUPERADMIN, or anyone working in the HOUSE workspace.
 *  Everyone else is self-service. */
export function isTravelDeskCaller(req: Request | AnyObj): boolean {
  if (isSuperAdmin(req as Request)) return true;
  const r = req as AnyObj;
  return String(r.workspaceId || r.workspace?._id || "") === HOUSE_WORKSPACE_ID;
}

export const MULTI_CITY_MESSAGE = "For multi-city trips, please contact the Travel Desk";
export const FARE_DIFFERENCE_MESSAGE = "A fare difference applies — our Travel Desk will contact you";

/** Remember the TraceIds of a multi-city search (best effort). */
export async function rememberMultiCityTraces(traceIds: unknown[]) {
  const ids = [...new Set(traceIds.filter(Boolean).map(String))];
  if (!ids.length) return;
  try {
    await SBTMultiCityTrace.insertMany(ids.map((traceId) => ({ traceId })), { ordered: false });
  } catch (err: any) {
    sbtLogger.warn("[sbt-pay] multi-city traces not stored", { err: err?.message });
  }
}

export async function isMultiCityTrace(traceIds: unknown[]): Promise<boolean> {
  const ids = traceIds.filter(Boolean).map(String);
  if (!ids.length) return false;
  return !!(await SBTMultiCityTrace.exists({ traceId: { $in: ids } }));
}

/** Self-service may not book or pay for a multi-city trip. Recognised by the
 *  quote (stamped at FareQuote), the TraceId, or the request's own flag. */
export async function multiCityRefusal(req: Request | AnyObj, quoteIsMultiCity = false): Promise<Refusal | null> {
  if (isTravelDeskCaller(req)) return null;
  const b = ((req as AnyObj).body || {}) as AnyObj;
  if (quoteIsMultiCity || b.isMultiCity === true || b.tripType === "multi-city"
    || await isMultiCityTrace([b.TraceId, b.returnTraceId])) {
    return refuse(403, "MULTI_CITY_TRAVEL_DESK", MULTI_CITY_MESSAGE);
  }
  return null;
}

function isPrivilegedSBTUser(req: AnyObj): boolean {
  const roles = (req.user?.roles || []).map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));
  return (
    roles.includes("SUPERADMIN") || roles.includes("ADMIN") || roles.includes("HR") ||
    roles.includes("WORKSPACELEADER") || req.user?.customerMemberRole === "WORKSPACE_LEADER"
  );
}

/** L1 requesters raise requests; they never book or pay. Everyone else that
 *  requireSBT admits (L2, BOTH, direct bookers with no sbtRole, Workspace
 *  Leaders, Plumtrips staff) keeps booking. */
export async function requireSBTBooker(req: Request, res: Response, next: NextFunction) {
  try {
    if (isPrivilegedSBTUser(req as AnyObj)) return next();
    const { userId } = callerScope(req);
    const user = userId ? ((await User.findById(userId).select("sbtRole").lean()) as AnyObj | null) : null;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (String(user.sbtRole || "").toUpperCase() === "L1") {
      return res.status(403).json({
        error: "Bookings are made by your company's booker. Please raise a request instead.",
        code: "NOT_BOOKER",
      });
    }
    next();
  } catch {
    return res.status(500).json({ error: "Authorization check failed" });
  }
}

/** SBT workspace (Flow 1) + booker. SUPERADMIN / HOUSE bypass the feature
 *  flag inside requireFeature, as everywhere else. */
export const sbtBookerGuards = [requireFeature("sbtEnabled"), requireSBTBooker];

/* ───────────────────────── SSR (add-on) prices ───────────────────────── */

const SSR_KIND: Record<string, SsrPriceItem["kind"]> = {
  SeatDynamic: "seat", SeatPreference: "seat",
  MealDynamic: "meal", Meal: "meal",
  Baggage: "baggage",
};

function walkPriced(node: unknown, kind: SsrPriceItem["kind"], out: SsrPriceItem[]) {
  if (Array.isArray(node)) { for (const n of node) walkPriced(n, kind, out); return; }
  if (!node || typeof node !== "object") return;
  const o = node as AnyObj;
  if ("Code" in o && "Price" in o) {
    out.push({
      kind,
      code: String(o.Code ?? ""),
      origin: String(o.Origin ?? ""),
      destination: String(o.Destination ?? ""),
      price: Number(o.Price) || 0,
    });
    return;
  }
  for (const v of Object.values(o)) walkPriced(v, kind, out);
}

/** Every priced seat / meal / baggage item under the SSR keys of `node`. */
export function priceItemsOf(node: unknown): SsrPriceItem[] {
  const out: SsrPriceItem[] = [];
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node as AnyObj)) {
    const kind = SSR_KIND[k];
    if (kind) walkPriced(v, kind, out);
  }
  return out;
}

const itemKey = (i: SsrPriceItem) => `${i.kind}|${i.code}|${i.origin}|${i.destination}`;

/** Keep TBO's SSR price list for this user's later add-on pricing (best effort). */
export async function rememberSsr(req: Request | AnyObj, traceId: unknown, resultIndex: unknown, ssr: AnyObj) {
  try {
    const ri = String(resultIndex ?? "");
    if (!ri) return;
    const { userId, workspaceId } = callerScope(req);
    const items = priceItemsOf(ssr?.Response ?? ssr);
    await SBTSsrSnapshot.create({ traceId: String(traceId ?? ""), resultIndex: ri, userId, workspaceId, items });
  } catch (err: any) {
    sbtLogger.warn("[sbt-pay] SSR snapshot not stored", { err: err?.message });
  }
}

/**
 * Add-ons on the passengers, priced from the SSR lists TBO gave THIS user for
 * these ResultIndexes. The same item listed on outbound and return passenger
 * lists counts once. An item TBO never offered with a price is refused.
 * Rounded like the booking page: each kind's total ceiled, then summed.
 */
export async function priceAddOns(
  scope: { userId: string; workspaceId: string },
  resultIndexes: string[],
  passengerLists: unknown[],
): Promise<{ ok: true; amount: number } | Refusal> {
  const chosen = new Map<string, SsrPriceItem>();
  for (const list of passengerLists) {
    if (!Array.isArray(list)) continue;
    list.forEach((pax: AnyObj, i: number) => {
      for (const it of priceItemsOf(pax)) chosen.set(`${i}|${itemKey(it)}`, it);
    });
  }
  if (chosen.size === 0) return { ok: true, amount: 0 };

  const snaps = (await SBTSsrSnapshot.find({
    userId: scope.userId, workspaceId: scope.workspaceId, resultIndex: { $in: resultIndexes },
  }).lean()) as AnyObj[];
  const priceOf = new Map<string, number>();
  for (const s of snaps) {
    for (const it of (s.items || []) as SsrPriceItem[]) {
      const k = itemKey(it);
      priceOf.set(k, Math.max(priceOf.get(k) ?? 0, Number(it.price) || 0));
    }
  }

  const totals = { seat: 0, meal: 0, baggage: 0 };
  for (const it of chosen.values()) {
    const p = priceOf.get(itemKey(it));
    if (p === undefined) {
      if (it.price > 0) return refuse(409, "ADDON_NOT_PRICED", "A selected seat, meal or bag is no longer available. Please search again.");
      continue;
    }
    totals[it.kind] += p;
  }
  return { ok: true, amount: Math.ceil(totals.seat) + Math.ceil(totals.baggage) + Math.ceil(totals.meal) };
}

/* ───────────────────────── quote pricing ───────────────────────── */

async function loadScopedQuote(scope: { userId: string; workspaceId: string }, quoteId: unknown, product: Product) {
  if (typeof quoteId !== "string" || !quoteId) return null;
  const q = (await SBTQuote.findOne({ quoteId }).lean()) as AnyObj | null;
  if (!q || q.product !== product) return null;
  if (String(q.userId ?? "") !== scope.userId || String(q.workspaceId ?? "") !== scope.workspaceId) return null;
  const age = Date.now() - new Date(q.createdAt).getTime();
  if (!(age >= 0 && age <= QUOTE_TTL_MS)) return null;
  return q;
}

const FARE_EXPIRED = refuse(410, "FARE_EXPIRED", "Fare expired, please search again");

export interface FlightPrice {
  ok: true; amount: number; base: number; addOn: number; quoteIds: string[]; resultIndexes: string[];
  isMultiCity: boolean;
}

/** ceil(Σ margined PublishedFare of the quoted legs) + add-ons. */
export async function priceFlight(
  scope: { userId: string; workspaceId: string },
  quoteIds: unknown,
  passengerLists: unknown[],
): Promise<FlightPrice | Refusal> {
  const ids = Array.isArray(quoteIds) ? quoteIds.filter((q) => typeof q === "string" && q) as string[] : [];
  if (ids.length === 0) return FARE_EXPIRED;
  let fare = 0;
  let isMultiCity = false;
  const resultIndexes = new Set<string>();
  for (const id of ids) {
    const q = await loadScopedQuote(scope, id, "FLIGHT");
    if (!q || !(Number(q.sellingFare) > 0)) return FARE_EXPIRED;
    fare += Number(q.sellingFare);
    if (q.isMultiCity === true) isMultiCity = true;
    for (const ri of (q.resultIndexes || []) as string[]) if (ri) resultIndexes.add(String(ri));
  }
  const base = Math.ceil(fare);
  const ris = [...resultIndexes];
  const add = await priceAddOns(scope, ris, passengerLists);
  if (isRefusal(add)) return add;
  return { ok: true, amount: base + add.amount, base, addOn: add.amount, quoteIds: ids, resultIndexes: ris, isMultiCity };
}

export async function priceHotelQuote(
  scope: { userId: string; workspaceId: string },
  quoteId: unknown,
): Promise<{ ok: true; amount: number; bookingCode: string; quoteId: string } | Refusal> {
  const q = await loadScopedQuote(scope, quoteId, "HOTEL");
  const amount = Math.round(Number(q?.serverDisplayFare) || 0);
  if (!q || !(amount > 0)) return FARE_EXPIRED;
  return { ok: true, amount, bookingCode: String(q.sourceRef), quoteId: String(quoteId) };
}

/** The latest scoped hotel quote for a BookingCode (hold → voucher pricing). */
export async function latestHotelQuoteFor(scope: { userId: string; workspaceId: string }, bookingCode: string) {
  if (!bookingCode) return null;
  const q = (await SBTQuote.findOne({
    product: "HOTEL", sourceRef: bookingCode, userId: scope.userId, workspaceId: scope.workspaceId,
  }).sort({ createdAt: -1 }).lean()) as AnyObj | null;
  if (!q) return null;
  const age = Date.now() - new Date(q.createdAt).getTime();
  return age >= 0 && age <= QUOTE_TTL_MS ? q : null;
}

/** What vouchering a held booking costs the customer. Holds made since this
 *  change carry the server price; older holds fall back to the highest figure
 *  the booking holds (logged). */
export async function priceHeldHotel(
  scope: { userId: string; workspaceId: string },
  heldBookingId: unknown,
): Promise<{ ok: true; amount: number; booking: AnyObj } | Refusal> {
  if (typeof heldBookingId !== "string" || !/^[a-f0-9]{24}$/i.test(heldBookingId)) {
    return refuse(404, "BOOKING_NOT_FOUND", "Booking not found");
  }
  const booking = (await SBTHotelBooking.findOne({
    _id: heldBookingId, userId: scope.userId, workspaceId: scope.workspaceId,
  }).lean()) as AnyObj | null;
  if (!booking) return refuse(404, "BOOKING_NOT_FOUND", "Booking not found");
  let amount = Math.round(Number(booking.serverSellingTotal) || 0);
  if (!(amount > 0)) {
    amount = Math.ceil(Math.max(
      Number(booking.totalFare) || 0, Number(booking.netAmount) || 0, Number(booking.recommendedSellingRate) || 0,
    ));
    sbtLogger.warn("[sbt-pay] held booking has no server price — using its stored figures", {
      bookingDocId: heldBookingId, amount,
    });
  }
  if (!(amount > 0)) return refuse(409, "PRICE_UNKNOWN", "This booking's price could not be confirmed. Please contact support.");
  return { ok: true, amount, booking };
}

/* ───────────────────────── business wallet ───────────────────────── */

function isWalletAdmin(req: AnyObj): boolean {
  const roles = (req.user?.roles || []).map((r: string) => String(r).toUpperCase());
  return roles.some((r: string) => ["ADMIN", "SUPERADMIN", "HR_ADMIN"].includes(r));
}

/** Reserve `amount` against the workspace's monthly official-booking limit in
 *  ONE conditional update (spend + amount ≤ limit; limit 0 = unlimited, as in
 *  routes/sbt.wallet.ts). Concurrent reservations cannot both pass. */
export async function reserveOfficial(req: Request | AnyObj, amount: number): Promise<{ ok: true; monthKey: string } | Refusal> {
  const wsId = (req as AnyObj).workspaceObjectId;
  if (!wsId) return refuse(400, "WORKSPACE_REQUIRED", "Workspace required");
  const monthKey = monthKeyNow();
  // Lazy month reset — conditional, so a racing reset can't wipe a fresh reservation.
  await CustomerWorkspace.updateOne(
    { _id: wsId, "sbtOfficialBooking.lastResetMonth": { $ne: monthKey } },
    { $set: { "sbtOfficialBooking.currentMonthSpend": 0, "sbtOfficialBooking.lastResetMonth": monthKey } },
    { runValidators: false },
  );
  const admin = isWalletAdmin(req as AnyObj);
  const r = await CustomerWorkspace.updateOne(
    {
      _id: wsId,
      ...(admin ? {} : { "sbtOfficialBooking.enabled": true }),
      $expr: {
        $let: {
          vars: {
            lim: { $ifNull: ["$sbtOfficialBooking.monthlyLimit", 0] },
            spend: { $ifNull: ["$sbtOfficialBooking.currentMonthSpend", 0] },
          },
          in: { $or: [{ $lte: ["$$lim", 0] }, { $lte: [{ $add: ["$$spend", amount] }, "$$lim"] }] },
        },
      },
    },
    { $inc: { "sbtOfficialBooking.currentMonthSpend": amount } },
    { runValidators: false },
  );
  if (r.modifiedCount === 1) return { ok: true, monthKey };
  const ws = (await CustomerWorkspace.findById(wsId).select("sbtOfficialBooking").lean()) as AnyObj | null;
  if (!admin && !ws?.sbtOfficialBooking?.enabled) {
    return refuse(403, "WALLET_DISABLED", "Business wallet is not enabled for this workspace");
  }
  return refuse(402, "LIMIT_EXCEEDED", "This booking would exceed your company's monthly travel limit");
}

export async function releaseOfficial(workspaceId: unknown, amount: number, monthKey?: string) {
  // A new month has already reset the counter — nothing to give back.
  if (!workspaceId || !(amount > 0) || monthKey !== monthKeyNow()) return;
  await CustomerWorkspace.updateOne(
    { _id: workspaceId },
    [{ $set: { "sbtOfficialBooking.currentMonthSpend": {
      $max: [0, { $subtract: [{ $ifNull: ["$sbtOfficialBooking.currentMonthSpend", 0] }, amount] }],
    } } }],
  );
}

/* ───────────────────────── create-order / verify ───────────────────────── */

async function persistOrder(res: Response, row: AnyObj, receipt: string) {
  if (!razorpayConfigured()) return res.status(503).json({ error: "Payment gateway not configured" });
  const amountPaise = Math.round(row.amount * 100);
  const order = await createRazorpayOrder(amountPaise, receipt);
  if (!order?.id || Number(order.amount) !== amountPaise) {
    return res.status(502).json({ error: "Razorpay order creation failed" });
  }
  await SBTPayment.create({ ...row, mode: "RAZORPAY", status: "CREATED", amountPaise, razorpayOrderId: order.id });
  return res.json({
    ok: true, orderId: order.id, amount: order.amount, currency: order.currency || "INR",
    keyId: razorpayKeyId(), serverAmount: row.amount,
  });
}

/** POST …/payment/create-order — the amount is the server's; any client amount is ignored. */
export function createOrderHandler(product: Product) {
  return async (req: Request, res: Response) => {
    try {
      const scope = callerScope(req);
      const b = (req.body || {}) as AnyObj;
      if (product === "FLIGHT") {
        const p = await priceFlight(scope, b.quoteIds, [b.Passengers, b.returnPassengers]);
        if (isRefusal(p)) return send(res, p);
        const mc = await multiCityRefusal(req, p.isMultiCity);
        if (mc) return send(res, mc);
        return await persistOrder(res, {
          product, ...scope, quoteIds: p.quoteIds, resultIndexes: p.resultIndexes,
          amount: p.amount, baseAmount: p.base, addOnAmount: p.addOn,
        }, `sbt_${Date.now()}`);
      }
      if (b.heldBookingId) {
        const p = await priceHeldHotel(scope, b.heldBookingId);
        if (isRefusal(p)) return send(res, p);
        return await persistOrder(res, {
          product, ...scope, heldBookingId: String(b.heldBookingId), amount: p.amount, baseAmount: p.amount,
        }, `sbt_htl_${Date.now()}`);
      }
      const p = await priceHotelQuote(scope, b.quoteId);
      if (isRefusal(p)) return send(res, p);
      return await persistOrder(res, {
        product, ...scope, quoteIds: [p.quoteId], bookingCode: p.bookingCode, amount: p.amount, baseAmount: p.amount,
      }, `sbt_htl_${Date.now()}`);
    } catch (err: any) {
      sbtLogger.error("[sbt-pay] create-order failed", { product, err: err?.message });
      return res.status(500).json({ error: "Payment order creation failed" });
    }
  };
}

/** POST …/payment/verify — PAID only when Razorpay itself says this payment was
 *  captured, on this order, for exactly the amount the server set. */
export function verifyHandler(product: Product) {
  return async (req: Request, res: Response) => {
    try {
      const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig } = (req.body || {}) as AnyObj;
      if (!orderId || !paymentId || !sig) return res.status(400).json({ error: "Missing payment verification fields" });
      if (!razorpayConfigured()) return res.status(503).json({ error: "Payment gateway not configured" });
      const scope = callerScope(req);
      const row = await SBTPayment.findOne({ razorpayOrderId: String(orderId), product, ...scope });
      if (!row) return res.status(404).json({ error: "Payment order not found", code: "PAYMENT_NOT_FOUND" });
      if (row.razorpayPaymentId) {
        if (row.razorpayPaymentId === String(paymentId)) return res.json({ ok: true, verified: true });
        return res.status(409).json({ error: "This order is already paid", code: "PAYMENT_ALREADY_USED" });
      }
      if (!checkoutSignatureValid(String(orderId), String(paymentId), String(sig))) {
        return res.status(400).json({ error: "Payment verification failed — signature mismatch", code: "BAD_SIGNATURE" });
      }

      let payment = await fetchRazorpayPayment(String(paymentId));
      if (String(payment?.order_id ?? "") !== row.razorpayOrderId) {
        return res.status(400).json({ error: "Payment does not belong to this order", code: "ORDER_MISMATCH" });
      }
      if (Number(payment?.amount) !== row.amountPaise || String(payment?.currency ?? "INR") !== "INR") {
        sbtLogger.error("[sbt-pay] payment amount differs from server order", {
          orderId, paymentId, paid: payment?.amount, expected: row.amountPaise,
        });
        return res.status(400).json({ error: "Payment amount does not match the booking amount", code: "AMOUNT_MISMATCH" });
      }
      if (payment?.status === "authorized") payment = await captureRazorpayPayment(String(paymentId), row.amountPaise);
      if (payment?.status !== "captured") {
        return res.status(402).json({ error: "Payment not completed", code: "NOT_CAPTURED" });
      }

      try {
        const updated = await SBTPayment.findOneAndUpdate(
          { _id: row._id, status: "CREATED" },
          { $set: { status: "PAID", razorpayPaymentId: String(paymentId), paidAt: new Date() } },
          { new: true },
        );
        if (!updated) return res.status(409).json({ error: "This order is already paid", code: "PAYMENT_ALREADY_USED" });
      } catch (err: any) {
        if (err?.code === 11000) {
          return res.status(409).json({ error: "This payment has already been used", code: "PAYMENT_ALREADY_USED" });
        }
        throw err;
      }
      return res.json({ ok: true, verified: true });
    } catch (err: any) {
      sbtLogger.error("[sbt-pay] verify failed", { product, err: err?.message });
      return res.status(500).json({ error: "Payment verification failed" });
    }
  };
}

/* ───────────────────────── book / ticket gate ───────────────────────── */

export type GateKind = "flight-ticket-lcc" | "flight-book" | "flight-ticket" | "hotel-book" | "hotel-voucher";

type Outcome = "SUCCESS" | "FAILED" | "UNCERTAIN";

function firstBookingId(body: AnyObj): string {
  const cands = [
    body?.BookingId, body?.bookingId,
    body?.Response?.Response?.BookingId, body?.Response?.Response?.FlightItinerary?.BookingId,
    body?.Response?.BookingId, body?.Response?.FlightItinerary?.BookingId,
  ];
  for (const c of cands) if (c != null && String(c) !== "" && String(c) !== "0") return String(c);
  return "";
}

/** How the supplier answered, read from the route's own response. A booking id
 *  in the answer always counts as success — money is never released while a
 *  booking may exist. */
export function outcomeOf(kind: GateKind, statusCode: number, body: AnyObj): { outcome: Outcome; tboBookingId: string } {
  const tboBookingId = firstBookingId(body);
  if (statusCode === 504 || body?.status === "timeout_unconfirmed" || body?.status === "BOOKING_UNCERTAIN"
    || body?.status === "BOOKING_PENDING") {
    return { outcome: "UNCERTAIN", tboBookingId };
  }
  if (kind === "flight-ticket") {
    const ok = statusCode < 400 && (body?.Response?.ResponseStatus === 1 || body?.recoveredFromTimeout === true);
    return { outcome: ok ? "SUCCESS" : "FAILED", tboBookingId };
  }
  if (kind === "hotel-book" || kind === "hotel-voucher") {
    return { outcome: statusCode < 400 && body?.ok === true ? "SUCCESS" : "FAILED", tboBookingId };
  }
  return { outcome: tboBookingId ? "SUCCESS" : "FAILED", tboBookingId };
}

/** Run `settle` with the route's response BEFORE it is sent, so the next call
 *  (GDS Ticket after Book) already sees the settled row. */
function settleOnResponse(res: Response, settle: (statusCode: number, body: AnyObj) => Promise<void>) {
  const original = res.json.bind(res);
  let settled = false;
  (res as AnyObj).json = (body: AnyObj) => {
    if (settled) return original(body);
    settled = true;
    settle(res.statusCode, body)
      .catch((err) => sbtLogger.error("[sbt-pay] settle failed — payment row needs ops review", { err: err?.message }))
      .finally(() => original(body));
    return res;
  };
}

/** The ResultIndexes a flight request will actually ticket. */
function ticketedResultIndexes(b: AnyObj): string[] {
  const out = [String(b.ResultIndex ?? "")];
  if (b.isReturn && !b.isSpecialReturn && b.returnResultIndex) out.push(String(b.returnResultIndex));
  return out.filter(Boolean);
}

const PAYMENT_REQUIRED = refuse(402, "PAYMENT_REQUIRED", "Payment is required before this booking can be confirmed");

async function claimRazorpay(
  scope: { userId: string; workspaceId: string },
  product: Product,
  orderId: unknown,
  check: (row: AnyObj) => Promise<Refusal | null>,
): Promise<{ ok: true; row: AnyObj } | Refusal> {
  if (typeof orderId !== "string" || !orderId) return PAYMENT_REQUIRED;
  const row = (await SBTPayment.findOne({ razorpayOrderId: orderId, product, ...scope }).lean()) as AnyObj | null;
  if (!row) return PAYMENT_REQUIRED;
  if (row.status === "CREATED") return PAYMENT_REQUIRED;
  if (row.status !== "PAID") return refuse(409, "PAYMENT_ALREADY_USED", "This payment has already been used for a booking");
  const bad = await check(row);
  if (bad) return bad;
  const claimed = await SBTPayment.findOneAndUpdate(
    { _id: row._id, status: "PAID" },
    { $set: { status: "CLAIMED", claimedAt: new Date() } },
    { new: true },
  ).lean();
  if (!claimed) return refuse(409, "PAYMENT_ALREADY_USED", "This payment has already been used for a booking");
  return { ok: true, row: claimed as AnyObj };
}

async function claimOfficial(
  req: Request,
  scope: { userId: string; workspaceId: string },
  row: AnyObj,
): Promise<{ ok: true; row: AnyObj } | Refusal> {
  const reserved = await reserveOfficial(req, row.amount);
  if (isRefusal(reserved)) return reserved;
  const doc = await SBTPayment.create({
    ...row, ...scope, mode: "OFFICIAL", status: "CLAIMED", amountPaise: Math.round(row.amount * 100),
    monthKey: reserved.monthKey, claimedAt: new Date(),
  });
  return { ok: true, row: doc.toObject() };
}

/**
 * Middleware before a TBO call that commits money. Refuses unless the booking
 * is paid (Razorpay row PAID and covering what is being booked) or the
 * business-wallet limit was just reserved; then settles the row on the route's
 * answer. Demo users go to the simulator inside the route — no money moves.
 */
export function paymentGate(kind: GateKind) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if ((req as AnyObj).user?.isDemoUser === true) return next();
    try {
      const scope = callerScope(req);
      const b = (req.body || {}) as AnyObj;
      let claim: { ok: true; row: AnyObj } | Refusal;
      let onFail: "RELEASE" | "BACK_TO_BOOKED" = "RELEASE";

      if (kind === "hotel-book" && (b.bookingMode || "voucher") === "hold") {
        return next(); // a hold commits no money; vouchering it is gated
      }

      if (kind === "flight-ticket") {
        const bookingId = String(b.BookingId ?? "");
        const row = bookingId
          ? await SBTPayment.findOneAndUpdate(
              { tboBookingId: bookingId, product: "FLIGHT", status: "BOOKED", ...scope },
              { $set: { status: "CLAIMED", claimedAt: new Date() } },
              { new: true },
            ).lean()
          : null;
        claim = row ? { ok: true, row: row as AnyObj } : PAYMENT_REQUIRED;
        onFail = "BACK_TO_BOOKED";
      } else if (kind === "flight-ticket-lcc" || kind === "flight-book") {
        const ris = ticketedResultIndexes(b);
        const lists = [b.Passengers, b.returnPassengers];
        const mc = await multiCityRefusal(req);
        if (mc) return send(res, mc);
        if (b.paymentMode === "official") {
          const p = await priceFlight(scope, b.quoteIds, lists);
          if (isRefusal(p)) return send(res, p);
          const mcQuote = await multiCityRefusal(req, p.isMultiCity);
          if (mcQuote) return send(res, mcQuote);
          if (!ris.length || ris.some((ri) => !p.resultIndexes.includes(ri))) return send(res, FARE_EXPIRED);
          claim = await claimOfficial(req, scope, {
            product: "FLIGHT", quoteIds: p.quoteIds, resultIndexes: p.resultIndexes,
            amount: p.amount, baseAmount: p.base, addOnAmount: p.addOn,
          });
        } else {
          claim = await claimRazorpay(scope, "FLIGHT", b.razorpayOrderId, async (row) => {
            if (!ris.length || ris.some((ri) => !(row.resultIndexes || []).includes(ri))) {
              return refuse(409, "PAYMENT_MISMATCH", "This payment was made for a different flight");
            }
            const add = await priceAddOns(scope, row.resultIndexes || [], lists);
            if (isRefusal(add)) return add;
            if (Number(row.baseAmount) + add.amount > Number(row.amount)) {
              return refuse(409, "AMOUNT_NOT_COVERED", "The seats, meals or bags selected cost more than was paid");
            }
            return null;
          });
        }
      } else if (kind === "hotel-book") {
        const code = String(b.BookingCode ?? "");
        if (b.paymentMode === "official") {
          const p = await priceHotelQuote(scope, b.quoteId);
          if (isRefusal(p)) return send(res, p);
          if (p.bookingCode !== code) return send(res, FARE_EXPIRED);
          claim = await claimOfficial(req, scope, {
            product: "HOTEL", quoteIds: [p.quoteId], bookingCode: code, amount: p.amount, baseAmount: p.amount,
            clientReferenceId: typeof b.ClientReferenceId === "string" ? b.ClientReferenceId : undefined,
          });
        } else {
          claim = await claimRazorpay(scope, "HOTEL", b.razorpayOrderId, async (row) =>
            row.bookingCode === code ? null : refuse(409, "PAYMENT_MISMATCH", "This payment was made for a different room"));
        }
      } else {
        // hotel-voucher: vouchering a held booking
        const heldId = String((req.params as AnyObj)?.id ?? "");
        const price = await priceHeldHotel(scope, heldId);
        if (isRefusal(price)) return send(res, price);
        if (b.walletPayment === true || b.paymentMode === "official") {
          claim = await claimOfficial(req, scope, {
            product: "HOTEL", heldBookingId: heldId, amount: price.amount, baseAmount: price.amount,
          });
        } else {
          claim = await claimRazorpay(scope, "HOTEL", b.razorpayOrderId, async (row) => {
            if (row.heldBookingId !== heldId) return refuse(409, "PAYMENT_MISMATCH", "This payment was made for a different booking");
            if (Number(row.amount) < price.amount) return refuse(409, "AMOUNT_NOT_COVERED", "Payment does not cover this booking");
            return null;
          });
        }
      }

      if (isRefusal(claim)) return send(res, claim);
      const row = claim.row;
      (req as AnyObj).sbtPayment = row;

      settleOnResponse(res, async (statusCode, body) => {
        const { outcome, tboBookingId } = outcomeOf(kind, statusCode, body);
        if (outcome === "SUCCESS") {
          await SBTPayment.updateOne({ _id: row._id }, { $set: {
            status: kind === "flight-book" ? "BOOKED" : "TICKETED",
            ...(tboBookingId ? { tboBookingId } : {}),
            completedAt: new Date(),
          } });
          return;
        }
        if (outcome === "UNCERTAIN") {
          await SBTPayment.updateOne({ _id: row._id }, { $set: {
            status: "UNCERTAIN", ...(tboBookingId ? { tboBookingId } : {}),
            failureReason: "Supplier did not confirm — check with TBO before refunding",
          } });
          sbtLogger.error("[sbt-pay] booking outcome uncertain after payment — ops must reconcile", {
            paymentRowId: String(row._id), kind, mode: row.mode, amount: row.amount,
          });
          return;
        }
        const reason = String(body?.error || body?.message || body?.Response?.Error?.ErrorMessage || `HTTP ${statusCode}`).slice(0, 300);
        if (onFail === "BACK_TO_BOOKED") {
          await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "BOOKED", failureReason: reason } });
        } else if (row.mode === "OFFICIAL") {
          await releaseOfficial(row.workspaceId, Number(row.amount), row.monthKey);
          await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "RELEASED", failureReason: reason } });
        } else {
          // Paid but not booked: the payment stays usable for a retry.
          await SBTPayment.updateOne({ _id: row._id }, { $set: { status: "PAID", failureReason: reason } });
        }
      });
      next();
    } catch (err: any) {
      sbtLogger.error("[sbt-pay] payment gate failed", { kind, err: err?.message });
      return res.status(500).json({ error: "Payment check failed" });
    }
  };
}

/* ───────────────────────── reissue ───────────────────────── */

/**
 * The fare difference of reissuing `booking` onto the quoted ResultIndex, from
 * the caller's own FareQuote of the new flight — never the browser's priceDiff:
 *   ceil(new selling fare + supplier reissue charges) − ceil(fare paid, excl. add-ons)
 * Positive = the customer owes more.
 */
export async function reissueFareDifference(
  req: Request | AnyObj,
  booking: AnyObj,
  resultIndex: unknown,
): Promise<{ ok: true; diff: number; newFare: number; reissueCharges: number } | Refusal> {
  const scope = callerScope(req);
  const ri = String(resultIndex ?? "");
  if (!ri) return FARE_EXPIRED;
  const q = (await SBTQuote.findOne({
    product: "FLIGHT", userId: scope.userId, workspaceId: scope.workspaceId, resultIndexes: ri,
  }).sort({ createdAt: -1 }).lean()) as AnyObj | null;
  const age = q ? Date.now() - new Date(q.createdAt).getTime() : -1;
  if (!q || !(age >= 0 && age <= QUOTE_TTL_MS) || !(Number(q.sellingFare) > 0)) return FARE_EXPIRED;
  const reissueCharges = Number(q.supplierReissueCharges) || 0;
  const newFare = Number(q.sellingFare);
  const paidFare = (Number(booking.totalFare) || 0) - (Number(booking.extras) || 0);
  return { ok: true, diff: Math.ceil(newFare + reissueCharges) - Math.ceil(paidFare), newFare, reissueCharges };
}

/* ───────────────────────── booking save ───────────────────────── */

/** Payment facts for a booking save, from the payment row — never the body. */
export async function paymentFactsForSave(
  req: Request | AnyObj,
  product: Product,
  ref: { razorpayOrderId?: unknown; tboBookingId?: unknown; clientReferenceId?: unknown },
): Promise<AnyObj | null> {
  const scope = callerScope(req);
  const or: AnyObj[] = [];
  if (typeof ref.razorpayOrderId === "string" && ref.razorpayOrderId) or.push({ razorpayOrderId: ref.razorpayOrderId });
  if (ref.tboBookingId != null && String(ref.tboBookingId) !== "" && String(ref.tboBookingId) !== "0") {
    or.push({ tboBookingId: String(ref.tboBookingId) });
  }
  if (typeof ref.clientReferenceId === "string" && ref.clientReferenceId) or.push({ clientReferenceId: ref.clientReferenceId });
  if (!or.length) return null;
  const row = (await SBTPayment.findOne({
    product, ...scope, $or: or, status: { $in: ["CLAIMED", "BOOKED", "TICKETED", "UNCERTAIN"] },
  }).sort({ createdAt: -1 }).lean()) as AnyObj | null;
  if (!row) return null;
  return {
    paymentMode: row.mode === "OFFICIAL" ? "official" : "personal",
    paymentStatus: "paid",
    amount: Number(row.amount),
    razorpayOrderId: row.razorpayOrderId || "",
    razorpayPaymentId: row.razorpayPaymentId || "",
    razorpayAmount: row.mode === "RAZORPAY" ? Number(row.amountPaise) : 0,
    paidAt: row.paidAt || row.claimedAt,
  };
}
