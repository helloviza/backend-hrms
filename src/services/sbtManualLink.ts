// apps/backend/src/services/sbtManualLink.ts
//
// SBT → Manual Booking link — Phase P1 of docs/specs/sbt-to-manual-booking-spec.md.
//
// Every confirmed SBT flight / hotel gets ONE linked ManualBooking: CONFIRMED,
// booked by the client (bookedBy = the SBT booking user, clientSelfBooked),
// priced from the API (actual) and the charge (quoted), both LOCKED.
//
// Entry points
//   onSbtBookingWrite   — the SBT models' save + mirror-resync hooks, through
//                         services/sbtManualLinkTrigger.ts (never awaited there).
//   ensureLinkedManualBooking — one booking, idempotent. Also what POST
//                         /admin/manual-bookings/import-from-sbt calls (via IMPORT).
//   sweepManualLinks    — jobs/sbt-manual-link-sweep.ts, every 10 minutes.
//
// Rules
//   - Switch: SBTConfig "global".manualLinkEnabled (default OFF). Automatic
//     linking (hooks + sweep) only for SBT bookings made since the switch was
//     first turned on (manualLinkEnabledAt) — older ones are the P2 backfill.
//     The staff import ignores the switch.
//   - Fails CLOSED while the unique index on ManualBooking.sbtLink.bookingId is
//     not verified (bootstrap/ensureSbtManualLinkIndexes.ts): without it two
//     racing creates could both win.
//   - Idempotent: that index, plus "already linked" checks first. An E11000 on
//     it = another writer won → its row is returned.
//   - A row from the old import (source SBT, sourceBookingId, no sbtLink) counts
//     as linked: never a second booking for it (P2 adopts it).
//   - Test bookings never link. Demo bookings link with isDemo (never invoiced).
//   - Only CONFIRMED links. A hotel HOLD links when it is vouchered (CONFIRMED).
//   - Never throws into the booking path: failures are recorded on the SBT doc
//     (manualLinkError / Attempts / AttemptAt) and retried by the sweep; ops
//     are alerted once, after the 3rd failure.
//   - The TravelBooking mirror is NOT switched in P1: linked rows have source
//     SBT_AUTO / SBT, which buildManualBookingMirror skips, so the SBT row stays
//     the one dashboard row.
//   - Cancellation (minimal; full sync is P3): when the linked SBT booking turns
//     CANCELLED / CANCEL_PENDING, sbtLink.sbtStatus + refund / charge are
//     recorded, a note is added and ops are alerted. Status and price are NOT
//     changed.
//
// SBT docs are written with the NATIVE collection (no hooks), so recording a
// link or a failure never re-enters this service or the mirror sync.
import mongoose from "mongoose";
import ManualBooking, { type SbtLinkModel } from "../models/ManualBooking.js";
import { saveWithBookingRefRetry } from "../utils/sbtLinkLock.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import SBTConfig from "../models/SBTConfig.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";
import User from "../models/User.js";
import { sbtCabin } from "./ticketFallback.js";
import { sendMail } from "../utils/mailer.js";
import { DESK_EMAIL } from "./actorNames.js";
import { istDateString } from "../utils/dateIST.js";
import { sbtLogger } from "../utils/logger.js";
import { sbtLinkIndexAvailable } from "../bootstrap/ensureSbtManualLinkIndexes.js";

type AnyObj = Record<string, any>;

export const ALERT_AFTER_FAILURES = 3;
export const CANCEL_STATUSES = ["CANCELLED", "CANCEL_PENDING"] as const;

const modelOf = (m: SbtLinkModel): any => (m === "SBTBooking" ? SBTBooking : SBTHotelBooking);
const r2 = (n: number) => Math.round(n * 100) / 100;
const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));

/* ── Switch ────────────────────────────────────────────────────────── */

export interface ManualLinkSettings { enabled: boolean; enabledAt: Date | null }
let settingsCache: { at: number; value: ManualLinkSettings } | null = null;
const SETTINGS_TTL_MS = 30_000;

export async function manualLinkSettings(): Promise<ManualLinkSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const doc: any = await SBTConfig.findOne({ key: "global" }).select("manualLinkEnabled manualLinkEnabledAt").lean();
  const value = { enabled: doc?.manualLinkEnabled === true, enabledAt: doc?.manualLinkEnabledAt ? new Date(doc.manualLinkEnabledAt) : null };
  settingsCache = { at: Date.now(), value };
  return value;
}

export function resetManualLinkSettingsCache(): void {
  settingsCache = null;
}

/* ── Mapping (pure) ────────────────────────────────────────────────── */

/** "YYYY-MM-DD…" → that calendar day at UTC midnight (the booking form's convention). */
export function dateOnly(raw: unknown): Date | undefined {
  const m = String(raw ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** "…THH:MM…" → "HH:MM" as printed (SBT times are local wall clock). */
export function clockOf(raw: unknown): string | undefined {
  const m = String(raw ?? "").match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : undefined;
}

function fmtDuration(min: unknown): string | undefined {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

function itineraryOf(resp: AnyObj | null | undefined): AnyObj | null {
  if (!resp || typeof resp !== "object") return null;
  return resp?.Response?.Response?.FlightItinerary ?? resp?.Response?.FlightItinerary ?? resp?.FlightItinerary ?? null;
}

function segmentsOf(resp: AnyObj | null | undefined): AnyObj[] {
  const segs = itineraryOf(resp)?.Segments;
  if (!Array.isArray(segs)) return [];
  return (segs as any[]).flat().filter((s) => s && typeof s === "object");
}

/** Every printed segment of the kept supplier response, outbound then return. */
export function flightSegments(sbt: AnyObj): Array<AnyObj & { _inbound: boolean }> {
  const out = segmentsOf(sbt.raw).map((s) => ({ ...s, _inbound: Number(s.TripIndicator) === 2 }));
  const ret = segmentsOf(sbt.raw?.returnTicketResult).map((s) => ({ ...s, _inbound: true }));
  return [...out, ...ret];
}

function flightNoOf(seg: AnyObj): string {
  const code = String(seg?.Airline?.AirlineCode || "").trim();
  const no = String(seg?.Airline?.FlightNumber || "").trim();
  if (!no) return "";
  return /^\d+$/.test(no) && code ? `${code}${no}` : no;
}

export function legsFromSbtFlight(sbt: AnyObj): AnyObj[] {
  const segs = flightSegments(sbt);
  if (!segs.length) {
    return [{
      origin: sbt.origin?.city || sbt.origin?.code || "",
      destination: sbt.destination?.city || sbt.destination?.code || "",
      flightNo: sbt.flightNumber || "",
      airline: sbt.airlineName || "",
      departDate: dateOnly(sbt.departureTime),
      departTime: clockOf(sbt.departureTime),
      arriveDate: dateOnly(sbt.arrivalTime),
      arriveTime: clockOf(sbt.arrivalTime),
      cabinClass: sbtCabin(sbt.cabin) ?? undefined,
    }];
  }
  return segs.map((s, i) => {
    const next = segs[i + 1];
    // A layover is printed after this leg when the next one continues the
    // same direction (TBO's GroundTime sits on the segment that follows).
    const layover = next && next._inbound === s._inbound ? fmtDuration(next.GroundTime) : undefined;
    return {
      origin: s.Origin?.Airport?.CityName || s.Origin?.Airport?.AirportCode || "",
      destination: s.Destination?.Airport?.CityName || s.Destination?.Airport?.AirportCode || "",
      flightNo: flightNoOf(s),
      airline: s.Airline?.AirlineName || sbt.airlineName || "",
      departDate: dateOnly(s.Origin?.DepTime),
      departTime: clockOf(s.Origin?.DepTime),
      arriveDate: dateOnly(s.Destination?.ArrTime),
      arriveTime: clockOf(s.Destination?.ArrTime),
      cabinClass: sbtCabin(s.CabinClass ?? sbt.cabin) ?? undefined,
      ...(layover ? { layover } : {}),
    };
  });
}

function paxTypeOf(v: unknown): "ADULT" | "CHILD" | "INFANT" {
  const s = String(v ?? "").toUpperCase();
  if (s === "CHILD" || s === "2") return "CHILD";
  if (s === "INFANT" || s === "3") return "INFANT";
  return "ADULT";
}

/** Invoice pricing: actual = API price (what we owe TBO), quoted = the charge. */
export function sbtLinkPricing(sbt: AnyObj): { actualPrice: number; quotedPrice: number; basis: "MARGIN_RECORD" | "NET_FALLBACK" } {
  const quoted = r2(Number(sbt.totalFare) || 0);
  const recorded = typeof sbt.marginSource === "string" && sbt.marginSource !== "";
  if (recorded) return { actualPrice: r2(quoted - (Number(sbt.marginAmount) || 0)), quotedPrice: quoted, basis: "MARGIN_RECORD" };
  const net = (Number(sbt.netAmount) || 0) + (Number(sbt.extras) || 0);
  return { actualPrice: r2(net > 0 ? net : quoted), quotedPrice: quoted, basis: "NET_FALLBACK" };
}

export interface LinkContext {
  customerId: string;
  user: { _id: unknown; email?: string; phone?: string; name?: string } | null;
  via: "AUTO" | "IMPORT";
  actor?: { _id?: unknown; email?: string } | null;
  paymentId?: string;
  /** Snapshots from checkout (P4): the SBT booking's own, else its payment row's. */
  walletMode?: "PREPAID" | "POSTPAID" | null;
  billTo?: AnyObj | null;
  now?: Date;
}

/** The ManualBooking to create for this SBT booking (no write). */
export function mapSbtToManualBooking(model: SbtLinkModel, sbt: AnyObj, ctx: LinkContext): AnyObj {
  const { actualPrice, quotedPrice, basis } = sbtLinkPricing(sbt);
  const now = ctx.now ?? new Date();
  const isFlight = model === "SBTBooking";
  const userEmail = ctx.user?.email || "";
  const userPhone = ctx.user?.phone || "";
  const linkedOn = istDateString(now);
  const notes = ctx.via === "IMPORT"
    ? `Booked online in SBT · linked from the SBT queue by ${ctx.actor?.email || "staff"} on ${linkedOn}`
    : `Booked online in SBT · linked automatically on ${linkedOn}`;
  const lockedType = isFlight ? "FLIGHT" : "HOTEL";

  const common = {
    workspaceId: oid(ctx.customerId),
    type: lockedType,
    source: ctx.via === "IMPORT" ? "SBT" : "SBT_AUTO",
    sourceBookingId: sbt._id,
    status: "CONFIRMED",
    bookingDate: sbt.bookedAt ? new Date(sbt.bookedAt) : sbt.createdAt ? new Date(sbt.createdAt) : now,
    bookedBy: sbt.userId,
    createdBy: String(sbt.userId),
    createdByEmail: userEmail || undefined,
    clientSelfBooked: true,
    pricing: { actualPrice, quotedPrice, gstMode: "ON_MARKUP", gstPercent: 18, currency: "INR" },
    notes,
    isDemo: sbt.isDemo === true,
    createdByDemoUser: sbt.createdByDemoUser === true,
    ...(ctx.billTo ? { billTo: ctx.billTo } : {}),
    pricingLocked: {
      at: now, by: "SYSTEM", reason: "SBT_API_PRICE",
      actualPrice, quotedPrice, gstMode: "ON_MARKUP", gstPercent: 18, currency: "INR", type: lockedType,
    },
  };
  const link = {
    model,
    bookingId: sbt._id,
    paymentId: ctx.paymentId,
    multiCityGroupId: sbt.multiCityGroupId || undefined,
    legIndex: typeof sbt.legIndex === "number" ? sbt.legIndex : undefined,
    returnPnr: sbt.returnPnr || undefined,
    paymentMode: sbt.paymentMode === "official" ? "official" : "personal",
    walletMode: ctx.walletMode ?? null,
    sbtStatus: String(sbt.status || ""),
    syncedAt: now,
    createdVia: ctx.via,
    pricingBasis: basis,
  };

  if (isFlight) {
    const legs = legsFromSbtFlight(sbt);
    const segs = flightSegments(sbt);
    const roundTrip = !!sbt.returnPnr || segs.some((s) => s._inbound);
    const firstInbound = segs.find((s) => s._inbound);
    const pax = Array.isArray(sbt.passengers) ? sbt.passengers : [];
    return {
      ...common,
      sourceBookingRef: sbt.pnr || sbt.bookingId || String(sbt._id),
      travelDate: legs[0]?.departDate ?? dateOnly(sbt.departureTime),
      returnDate: roundTrip ? dateOnly(firstInbound?.Origin?.DepTime) : undefined,
      sector: `${sbt.origin?.city || ""}-${sbt.destination?.city || ""}`,
      itinerary: {
        description: `${sbt.origin?.city || ""} → ${sbt.destination?.city || ""}`,
        tripType: roundTrip ? "ROUND_TRIP" : "ONE_WAY",
        legs,
      },
      passengers: pax.map((p: AnyObj, i: number) => {
        const lead = p.isLead === true || (i === 0 && !pax.some((q: AnyObj) => q.isLead === true));
        return {
          name: `${p.firstName || ""} ${p.lastName || ""}`.trim() || "Passenger",
          email: p.email || (lead ? sbt.contactEmail || userEmail : "") || undefined,
          phone: p.contactNo || p.phone || (lead ? sbt.contactPhone || userPhone : "") || undefined,
          type: paxTypeOf(p.paxType),
        };
      }),
      supplierName: sbt.airlineName || "TBO",
      supplierPNR: sbt.pnr || sbt.bookingId,
      sbtLink: link,
    };
  }

  const checkIn = dateOnly(sbt.checkIn);
  const checkOut = dateOnly(sbt.checkOut);
  const nights = checkIn && checkOut ? Math.max(1, Math.round((checkOut.getTime() - checkIn.getTime()) / 86400000)) : undefined;
  const guests = Array.isArray(sbt.guests) ? sbt.guests : [];
  return {
    ...common,
    sourceBookingRef: sbt.confirmationNo || sbt.bookingRefNo || sbt.bookingId || String(sbt._id),
    travelDate: checkIn,
    returnDate: checkOut,
    sector: sbt.cityName || "",
    itinerary: {
      hotelName: sbt.hotelName || "",
      roomType: sbt.roomName || "",
      destination: sbt.cityName || "",
      nights,
      roomCount: Math.max(1, Number(sbt.rooms) || 1),
      description: sbt.hotelName || "",
    },
    passengers: guests.map((g: AnyObj, i: number) => {
      const lead = g.LeadPassenger === true || (i === 0 && !guests.some((q: AnyObj) => q.LeadPassenger === true));
      return {
        name: `${g.FirstName || ""} ${g.LastName || ""}`.trim() || "Guest",
        email: lead ? userEmail || undefined : undefined,
        phone: lead ? userPhone || undefined : undefined,
        type: Number(g.PaxType) === 2 ? "CHILD" : "ADULT",
      };
    }),
    supplierName: "TBO",
    supplierPNR: sbt.confirmationNo || sbt.bookingRefNo || sbt.bookingId,
    sbtLink: link,
  };
}

/* ── Lookups ───────────────────────────────────────────────────────── */

/** The ManualBooking already linked to this SBT booking (new link or old import), or null. */
export async function existingLinkedBooking(sbtId: unknown): Promise<AnyObj | null> {
  const id = oid(sbtId);
  const linked = await ManualBooking.findOne({ "sbtLink.bookingId": id }).lean();
  if (linked) return linked;
  return ManualBooking.findOne({ sourceBookingId: id, source: { $in: ["SBT", "SBT_AUTO"] } }).lean();
}

/** Customer._id behind the SBT booking's workspace — must be a real Customer. */
async function customerIdFor(sbt: AnyObj): Promise<string | null> {
  const cws: any = await CustomerWorkspace.findById(sbt.workspaceId).select("customerId").lean();
  const cid = cws?.customerId ? String(cws.customerId) : "";
  if (!cid || !mongoose.isValidObjectId(cid)) return null;
  return (await Customer.exists({ _id: cid })) ? cid : null;
}

/** The checkout payment row behind this SBT booking: its id and snapshots. */
async function paymentRowFor(model: SbtLinkModel, sbt: AnyObj): Promise<{ id?: string; walletMode?: "PREPAID" | "POSTPAID" | null; billTo?: AnyObj | null }> {
  const db = mongoose.connection.db;
  if (!db) return {};
  const id = String(sbt._id);
  // The same keys paymentFactsForSave matched the booking's payment by
  // (services/sbtPaymentGate.ts), plus the ids the checkout records after.
  const or: AnyObj[] = [{ bookingDocIds: id }];
  if (model === "SBTHotelBooking") or.push({ heldBookingId: id });
  if (sbt.razorpayOrderId) or.push({ razorpayOrderId: sbt.razorpayOrderId });
  if (sbt.bookingId && String(sbt.bookingId) !== "0") or.push({ tboBookingId: String(sbt.bookingId) });
  if (sbt.clientReferenceId) or.push({ clientReferenceId: String(sbt.clientReferenceId) });
  const row = await db.collection("sbtpayments").findOne(
    // Workspace, not user: a booking made for an L1's request is owned by the
    // requester while the payment row is the booker's.
    { product: model === "SBTBooking" ? "FLIGHT" : "HOTEL", workspaceId: String(sbt.workspaceId), $or: or },
    { projection: { _id: 1, mode: 1, walletMode: 1, billTo: 1 }, sort: { createdAt: -1 } },
  );
  if (!row?._id) return {};
  return {
    id: String(row._id),
    walletMode: row.mode === "OFFICIAL" && (row.walletMode === "PREPAID" || row.walletMode === "POSTPAID") ? row.walletMode : null,
    billTo: row.billTo && typeof row.billTo === "object" ? row.billTo : null,
  };
}

/* ── When a booking is ready to link ───────────────────────────────── */

/**
 * CONFIRMED is not enough. A hotel's /book stamps CONFIRMED on its skeleton
 * (net + margin) BEFORE bookings/save writes the charged totalFare and
 * paymentStatus from the payment row — linking then would lock a ₹0 price.
 * So an automatic link also needs the charge (totalFare > 0) and the payment
 * (paymentStatus "paid"; the demo simulator has no payment row). The write
 * that sets them re-triggers the hook. A staff import (IMPORT) needs the
 * charge only: older bookings predate the payment flag.
 */
export function linkableReason(sbt: AnyObj, via: "AUTO" | "IMPORT" = "AUTO"): null | "NOT_CONFIRMED" | "NOT_PRICED" | "NOT_PAID" {
  if (String(sbt?.status || "").toUpperCase() !== "CONFIRMED") return "NOT_CONFIRMED";
  if (!(Number(sbt.totalFare) > 0)) return "NOT_PRICED";
  if (via === "AUTO" && sbt.paymentStatus !== "paid" && sbt.isDemo !== true) return "NOT_PAID";
  return null;
}

/* ── Create ────────────────────────────────────────────────────────── */

export type LinkResult =
  | { status: "created"; booking: AnyObj }
  | { status: "exists"; booking: AnyObj; legacy: boolean }
  | { status: "skipped"; reason: "TEST" | "NOT_CONFIRMED" | "NOT_PRICED" | "NOT_PAID" }
  | { status: "failed"; reason: string; error: string };

const isLinkIndexDup = (err: any) =>
  err?.code === 11000 && (Object.prototype.hasOwnProperty.call(err?.keyPattern || {}, "sbtLink.bookingId") || /sbtLink/.test(String(err?.message || "")));

/**
 * Link one SBT booking (the doc, lean or hydrated). Idempotent. Never throws:
 * a failure is returned (and, unless `record:false`, written to the SBT doc).
 */
export async function ensureLinkedManualBooking(
  model: SbtLinkModel,
  sbt: AnyObj,
  opts: { via: "AUTO" | "IMPORT"; actor?: { _id?: unknown; email?: string } | null; record?: boolean; now?: Date } = { via: "AUTO" },
): Promise<LinkResult> {
  const record = opts.record !== false;
  try {
    if (sbt.isTest === true) return { status: "skipped", reason: "TEST" };

    const existing = await existingLinkedBooking(sbt._id);
    if (existing) {
      if (String(sbt.manualBookingId || "") !== String(existing._id)) {
        await setBackPointer(model, sbt._id, existing._id);
      }
      return { status: "exists", booking: existing, legacy: !existing.sbtLink };
    }

    const notReady = linkableReason(sbt, opts.via);
    if (notReady) return { status: "skipped", reason: notReady };

    if (!(await sbtLinkIndexAvailable())) {
      return await failed(model, sbt, "INDEX_MISSING", "The ManualBooking link index is missing — linking is disabled until it is built", record);
    }

    const customerId = await customerIdFor(sbt);
    if (!customerId) return await failed(model, sbt, "NO_CUSTOMER", "The SBT workspace has no client company", record);

    const user: any = sbt.userId ? await User.findById(sbt.userId).select("email phone name").lean() : null;
    const pay = await paymentRowFor(model, sbt);
    const walletMode = sbt.walletMode === "PREPAID" || sbt.walletMode === "POSTPAID" ? sbt.walletMode : pay.walletMode ?? null;
    const billTo = sbt.billTo && typeof sbt.billTo === "object" ? sbt.billTo : pay.billTo ?? null;
    const data = mapSbtToManualBooking(model, sbt, { customerId, user, via: opts.via, actor: opts.actor, paymentId: pay.id, walletMode, billTo, now: opts.now });
    if (!data.travelDate) return await failed(model, sbt, "NO_TRAVEL_DATE", "The SBT booking has no readable travel date", record);

    let saved: any;
    try {
      saved = await saveWithBookingRefRetry(new ManualBooking(data));
    } catch (err: any) {
      if (isLinkIndexDup(err)) {
        const winner = await existingLinkedBooking(sbt._id);
        if (winner) return { status: "exists", booking: winner, legacy: false };
      }
      throw err;
    }
    await setBackPointer(model, sbt._id, saved._id);
    sbtLogger.info("[SBT-MANUAL-LINK] linked", { model, sbtId: String(sbt._id), bookingRef: saved.bookingRef, via: opts.via });
    return { status: "created", booking: saved.toObject() };
  } catch (err: any) {
    return await failed(model, sbt, "ERROR", String(err?.message || err), record);
  }
}

async function setBackPointer(model: SbtLinkModel, sbtId: unknown, mbId: unknown) {
  await modelOf(model).collection.updateOne(
    { _id: oid(sbtId) },
    { $set: { manualBookingId: oid(mbId) }, $unset: { manualLinkError: "" } },
  );
}

async function failed(model: SbtLinkModel, sbt: AnyObj, reason: string, error: string, record: boolean): Promise<LinkResult> {
  sbtLogger.warn("[SBT-MANUAL-LINK] link failed", { model, sbtId: String(sbt?._id), reason, error });
  if (record && sbt?._id) {
    try {
      await recordLinkFailure(model, sbt, `${reason}: ${error}`);
    } catch (e: any) {
      sbtLogger.error("[SBT-MANUAL-LINK] could not record the failure", { sbtId: String(sbt._id), error: e?.message });
    }
  }
  return { status: "failed", reason, error };
}

/** +1 attempt; the 3rd failure alerts ops (once). */
export async function recordLinkFailure(model: SbtLinkModel, sbt: AnyObj, message: string): Promise<number> {
  const coll = modelOf(model).collection;
  const after: any = await coll.findOneAndUpdate(
    { _id: oid(sbt._id) },
    { $set: { manualLinkError: message.slice(0, 500), manualLinkAttemptAt: new Date() }, $inc: { manualLinkAttempts: 1 } },
    { returnDocument: "after", projection: { manualLinkAttempts: 1, manualLinkAlertedAt: 1, pnr: 1, confirmationNo: 1, workspaceId: 1 } },
  );
  const row = after?.value !== undefined ? after.value : after; // driver 5 vs 6 result shape
  const attempts = Number(row?.manualLinkAttempts) || 0;
  if (attempts >= ALERT_AFTER_FAILURES && !row?.manualLinkAlertedAt) {
    const claimed = await coll.updateOne({ _id: oid(sbt._id), manualLinkAlertedAt: { $in: [null] } }, { $set: { manualLinkAlertedAt: new Date() } });
    if (claimed.modifiedCount === 1) {
      await alertOps(`Manual Booking link failed ${attempts}× — ${model === "SBTBooking" ? "flight" : "hotel"} ${row?.pnr || row?.confirmationNo || sbt._id}`, [
        `An SBT booking could not be linked to a Manual Booking after ${attempts} attempts.`,
        `Last error: ${message}`,
        `SBT ${model} ${String(sbt._id)} · workspace ${String(row?.workspaceId ?? sbt.workspaceId ?? "")}`,
        "It is listed in Manual Bookings → Import from SBT (the repair view). Link it from there once the cause is fixed.",
      ]);
    }
  }
  return attempts;
}

async function alertOps(subject: string, lines: string[]) {
  try {
    await sendMail({
      to: DESK_EMAIL,
      subject: `[SBT] ${subject}`,
      kind: "NOTIFICATIONS",
      html: `<p>${lines.map((l) => String(l).replace(/[<>&]/g, "")).join("<br/>")}</p>`,
    });
  } catch (err: any) {
    sbtLogger.error("[SBT-MANUAL-LINK] ops alert email failed", { subject, error: err?.message });
  }
}

/* ── Status changes on a linked booking (minimal, P1) ─────────────── */

/**
 * Record the SBT status on the linked booking. CANCELLED / CANCEL_PENDING also
 * add a note with the refund and charge and alert ops. Never changes the
 * booking's status or price (that is P3). Idempotent per status.
 */
export async function noteSbtStatus(model: SbtLinkModel, sbt: AnyObj, booking: AnyObj): Promise<"noted" | "unchanged"> {
  const status = String(sbt.status || "");
  if (!booking?.sbtLink || booking.sbtLink.sbtStatus === status) return "unchanged";
  const isCancel = (CANCEL_STATUSES as readonly string[]).includes(status);
  const refund = Number(sbt.refundedAmount);
  const charge = Number(sbt.cancellationCharge);
  const set: AnyObj = { "sbtLink.sbtStatus": status, "sbtLink.syncedAt": new Date() };
  if (Number.isFinite(refund)) set["sbtLink.refundedAmount"] = refund;
  if (Number.isFinite(charge)) set["sbtLink.cancellationCharge"] = charge;
  if (isCancel) {
    const inr = (n: number) => (Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : "not known yet");
    const line = status === "CANCEL_PENDING"
      ? `${istDateString()} · Cancellation requested in SBT (awaiting the supplier) — refund ${inr(refund)}, charge ${inr(charge)}. Status and price not changed.`
      : `${istDateString()} · Cancelled in SBT — refund ${inr(refund)}, charge ${inr(charge)}. Status and price not changed; Finance to review.`;
    set.notes = [String(booking.notes || "").trim(), line].filter(Boolean).join("\n");
  }
  const r = await ManualBooking.updateOne(
    { _id: booking._id, "sbtLink.sbtStatus": { $ne: status } },
    { $set: set },
  );
  if (r.modifiedCount !== 1) return "unchanged";
  if (isCancel) {
    await alertOps(`Linked booking ${booking.bookingRef} ${status === "CANCELLED" ? "cancelled" : "cancellation pending"} in SBT`, [
      `${booking.bookingRef} (${booking.type}) was ${status === "CANCELLED" ? "cancelled" : "sent for cancellation"} in SBT.`,
      `Refund: ${Number.isFinite(refund) ? refund : "not known yet"} · Charge: ${Number.isFinite(charge) ? charge : "not known yet"}.`,
      `Manual Booking status (${booking.status}) and price were NOT changed — review it${booking.status === "INVOICED" ? "; it is invoiced, so a credit note may be needed" : ""}.`,
    ]);
  }
  return "noted";
}

/* ── Hook entry ────────────────────────────────────────────────────── */

/** Called (queued) after every SBT booking save / mirrored query write. */
export async function onSbtBookingWrite(model: SbtLinkModel, id: string): Promise<void> {
  if (!mongoose.isValidObjectId(id) || mongoose.connection.readyState !== 1) return;
  const sbt: AnyObj | null = await modelOf(model).collection.findOne({ _id: oid(id) });
  if (!sbt) return;

  // Already linked: only the status note (works with the switch off too —
  // staff-linked rows still hear about their cancellation).
  const linked = sbt.manualBookingId
    ? await ManualBooking.findOne({ _id: sbt.manualBookingId }).lean()
    : await ManualBooking.findOne({ "sbtLink.bookingId": sbt._id }).lean();
  if (linked) {
    await noteSbtStatus(model, sbt, linked);
    return;
  }

  if (sbt.isTest === true || linkableReason(sbt, "AUTO")) return;
  const settings = await manualLinkSettings();
  if (!settings.enabled) return;
  if (!settings.enabledAt || new Date(sbt.bookedAt || sbt.createdAt || 0) < settings.enabledAt) return;
  await ensureLinkedManualBooking(model, sbt, { via: "AUTO" });
}

/* ── Sweep ─────────────────────────────────────────────────────────── */

export const SWEEP_MIN_AGE_MS = 2 * 60 * 1000; // let the hook go first
export const SWEEP_BATCH = 100;

/** Link confirmed SBT bookings the hook missed (since the switch went on). */
export async function sweepManualLinks(now: Date = new Date()): Promise<{ scanned: number; created: number; failed: number; exists: number }> {
  const out = { scanned: 0, created: 0, failed: 0, exists: 0 };
  const settings = await manualLinkSettings();
  if (!settings.enabled || !settings.enabledAt) return out;
  for (const model of ["SBTBooking", "SBTHotelBooking"] as const) {
    const docs: AnyObj[] = await modelOf(model).collection
      .find({
        // Same readiness as linkableReason(…, "AUTO"): confirmed, priced, paid (or demo).
        status: "CONFIRMED",
        totalFare: { $gt: 0 },
        $or: [{ paymentStatus: "paid" }, { isDemo: true }],
        isTest: { $ne: true },
        manualBookingId: { $in: [null] },
        bookedAt: { $gte: settings.enabledAt, $lte: new Date(now.getTime() - SWEEP_MIN_AGE_MS) },
      })
      .sort({ bookedAt: 1 })
      .limit(SWEEP_BATCH)
      .toArray();
    for (const sbt of docs) {
      out.scanned += 1;
      const r = await ensureLinkedManualBooking(model, sbt, { via: "AUTO" });
      if (r.status === "created") out.created += 1;
      else if (r.status === "failed") out.failed += 1;
      else if (r.status === "exists") out.exists += 1;
    }
  }
  return out;
}
