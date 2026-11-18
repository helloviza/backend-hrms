import { Schema, model, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import TravelBooking from "./TravelBooking.js";
import { attachMirrorResyncHooks } from "../utils/mirrorResyncHooks.js";
import { parseTBODate } from "../lib/tbo-date.js";
import { travelCanonicalCity as canonicalCity, travelCountryFor as countryFor } from "../data/destinationLookup.js";
import { resolveSbtTenantId } from "../services/sbtMirrorTenant.js";

function tboDateSetter(v: any): Date | null | undefined {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") return parseTBODate(v);
  return null;
}

export interface ISBTHotelBooking extends Document {
  userId: Schema.Types.ObjectId;
  workspaceId: Schema.Types.ObjectId;
  customerId?: string; // legacy
  bookingId: string;
  confirmationNo: string;
  bookingRefNo: string;
  invoiceNumber?: string;
  hotelCode: string;
  hotelName: string;
  cityName: string;
  cityCode?: string;
  countryCode?: string;
  checkIn: string;
  checkOut: string;
  rooms: number;
  guests: {
    Title: string;
    FirstName: string;
    LastName: string;
    PaxType: number;
    LeadPassenger: boolean;
  }[];
  roomName: string;
  mealType: string;
  totalFare: number;
  netAmount: number;
  // Server's PreBook selling total, stamped at /book — what vouchering a hold costs.
  serverSellingTotal?: number;
  recommendedSellingRate?: number | null;
  cancellationPolicyText?: string | null;
  isPublishedFare?: boolean;
  tds?: number;
  agentCommission?: number;
  currency: string;
  isRefundable: boolean;
  cancelPolicies: unknown[];
  status: "CONFIRMED" | "CANCELLED" | "FAILED" | "PENDING" | "CANCEL_PENDING" | "HELD" | "EXPIRED" | "CLOSED" | "ORPHAN_CLEANED";
  isHeld?: boolean;
  lastVoucherDate?: Date;
  lastCancellationDate?: Date | null;
  voucherGeneratedAt?: Date;
  paymentStatus: "paid" | "failed" | "pending";
  paymentId: string;
  razorpayOrderId: string;
  razorpayAmount: number;
  isVouchered: boolean;
  failureReason?: string;
  paymentCapturedAt?: Date;
  webhookProcessed?: boolean;
  refundId?: string;
  refundStatus?: string;
  refundProcessedAt?: Date;
  paymentMode?: "official" | "personal";
  marginPercent?: number;
  marginAmount?: number;
  // Which margin rule priced the booking (from its PreBook quote). Absent on older bookings.
  marginSource?: string;
  marginOverrideId?: string | null;
  marginVersion?: number;
  displayAmount?: number;
  raw?: unknown;
  tboVoucherData?: unknown;
  voucherStatus?: "PENDING" | "CONFIRMED" | "FAILED" | "GENERATED" | "PAYMENT_COLLECTED" | "HELD" | "CANCELLED" | "CANCEL_PENDING";
  sbtRequestId?: Schema.Types.ObjectId;
  cancellationCharge?: number;
  refundedAmount?: number;
  changeRequestId?: string;
  clientReferenceId?: string;
  changeRequests?: Array<{
    requestType?: string;
    requestedCheckIn?: string;
    requestedCheckOut?: string;
    remarks?: string;
    status?: string;
    raisedAt?: Date;
  }>;
  inclusion?: string;
  rateConditions?: string[];
  amenities?: string[];
  supplements?: unknown[];
  priceChangedDuringBook?: boolean;
  priceChangeAmount?: number;
  // POST-001: PaxIds from GetBookingDetail — required for PAN-at-voucher-time (HOLD bookings).
  paxDetails?: Array<{
    paxId: string;
    firstName: string;
    lastName: string;
    paxType: number;
    pan?: string | null;
  }>;
  panMandatory?: boolean;
  // Lead-adult PAN captured from the HOLD/Book request (TBO never echoes PAN
  // back via GetBookingDetail). Source for backfilling paxDetails[].pan.
  heldLeadPAN?: string;
  // PAN audit trail (TBO confirmation 2026-05-05). PAN is applied to international hotels only;
  // when isCorporateBooking=true, corporatePAN is the company PAN supplied at the payment page.
  isCorporateBooking?: boolean;
  corporatePAN?: string;
  rebookFromBookingId?: string;
  tboReferenceNo?: string | null;
  traceId?: string;
  roomDescription?: string | null;
  bookingDetailFetched?: boolean;
  bookingDetailFetchedAt?: Date | null;
  bookingDetailRaw?: unknown;
  // TBO cert Item 31 — defer GetBookingDetail by ≥120s after Book.
  pendingStatusCheckAt?: Date | null;
  statusCheckDone?: boolean;
  statusCheckAttempts?: number;
  lastStatusCheckAt?: Date | null;
  // Idempotency guard for the SBT-request "your hotel has been booked" email.
  // Email send moved from /save handler to deferred-status-check success path —
  // see commit gating voucher on reconciliation.
  confirmationEmailSentAt?: Date | null;
  bookedAt: Date;
  cancelledAt?: Date;
  closedAt?: Date;
  reminders?: Array<{ type: "24h" | "1h"; sentAt: Date }>;
  isDemo?: boolean;
  // Internal test data — see scripts/mark-sbt-test-data.ts.
  isTest?: boolean;
  createdByDemoUser?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SBTHotelBookingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    customerId: { type: String, trim: true, index: true }, // legacy
    bookingId: { type: String, default: "" },
    confirmationNo: { type: String, default: "" },
    bookingRefNo: { type: String, default: "" },
    invoiceNumber: { type: String, default: "" },
    hotelCode: { type: String, default: "" },
    hotelName: { type: String, default: "" },
    cityName: { type: String, default: "" },
    cityCode: { type: String, default: "" },
    countryCode: { type: String, default: "" },
    checkIn: { type: String, default: "" },
    checkOut: { type: String, default: "" },
    rooms: { type: Number, default: 1 },
    guests: [
      {
        Title: String,
        FirstName: String,
        LastName: String,
        PaxType: Number,
        LeadPassenger: Boolean,
      },
    ],
    roomName: { type: String, default: "" },
    mealType: { type: String, default: "" },
    totalFare: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    serverSellingTotal: { type: Number },
    recommendedSellingRate: { type: Number, default: null },
    cancellationPolicyText: { type: String, default: null },
    isPublishedFare: { type: Boolean, default: false },
    tds: { type: Number, default: 0 },
    agentCommission: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    isRefundable: { type: Boolean, default: false },
    cancelPolicies: { type: [Schema.Types.Mixed], default: [] },
    status: {
      type: String,
      enum: ["CONFIRMED", "CANCELLED", "FAILED", "PENDING", "CANCEL_PENDING", "HELD", "EXPIRED", "CLOSED", "ORPHAN_CLEANED"],
      default: "CONFIRMED",
    },
    isHeld: { type: Boolean, default: false },
    lastVoucherDate: { type: Date, set: tboDateSetter },
    lastCancellationDate: { type: Date, default: null, set: tboDateSetter },
    voucherGeneratedAt: { type: Date },
    paymentStatus: {
      type: String,
      enum: ["paid", "failed", "pending"],
      default: "pending",
    },
    paymentId: { type: String, default: "" },
    razorpayOrderId: { type: String, default: "", index: true },
    razorpayAmount: { type: Number, default: 0 },
    isVouchered: { type: Boolean, default: false },
    failureReason: { type: String, default: "" },
    paymentCapturedAt: { type: Date },
    webhookProcessed: { type: Boolean, default: false },
    refundId: { type: String },
    refundStatus: { type: String },
    refundProcessedAt: { type: Date },
    paymentMode: { type: String, enum: ["official", "personal"], default: "personal" },
    marginPercent: { type: Number, default: 0 },
    marginAmount: { type: Number, default: 0 },
    marginSource: { type: String },
    marginOverrideId: { type: String },
    marginVersion: { type: Number },
    displayAmount: { type: Number, default: 0 },
    raw: { type: Schema.Types.Mixed, default: null },
    tboVoucherData: { type: Schema.Types.Mixed, default: null },
    voucherStatus: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "FAILED", "GENERATED", "PAYMENT_COLLECTED", "HELD", "CANCELLED", "CANCEL_PENDING"],
      default: null,
    },
    sbtRequestId: { type: Schema.Types.ObjectId, ref: "SBTRequest", default: null, index: true },
    cancellationCharge: { type: Number, default: 0 },
    refundedAmount: { type: Number, default: 0 },
    clientReferenceId: { type: String, sparse: true },
    changeRequestId: { type: String },
    changeRequests: [{
      requestType: { type: String },
      requestedCheckIn: { type: String },
      requestedCheckOut: { type: String },
      remarks: { type: String },
      status: { type: String, default: "submitted" },
      raisedAt: { type: Date, default: Date.now },
    }],
    inclusion: { type: String, default: "" },
    rateConditions: { type: [String], default: [] },
    amenities: { type: [String], default: [] },
    supplements: { type: [Schema.Types.Mixed], default: [] },
    priceChangedDuringBook: { type: Boolean, default: false },
    priceChangeAmount: { type: Number, default: 0 },
    paxDetails: [{
      paxId: { type: String },
      firstName: { type: String },
      lastName: { type: String },
      paxType: { type: Number },
      pan: { type: String, trim: true, default: null },
    }],
    panMandatory: { type: Boolean, default: false },
    heldLeadPAN: { type: String, trim: true, default: "" },
    isCorporateBooking: { type: Boolean, default: false },
    corporatePAN: { type: String, default: "" },
    rebookFromBookingId: { type: String, default: null },
    tboReferenceNo: { type: String, default: null, index: true },
    traceId: { type: String, default: null, index: true },
    roomDescription: { type: String, default: null },
    bookingDetailFetched: { type: Boolean, default: false },
    bookingDetailFetchedAt: { type: Date, default: null },
    bookingDetailRaw: { type: Schema.Types.Mixed, default: null },
    // TBO cert Item 31 — defer GetBookingDetail by ≥120s after Book.
    pendingStatusCheckAt: { type: Date, default: null, index: true },
    statusCheckDone: { type: Boolean, default: false, index: true },
    statusCheckAttempts: { type: Number, default: 0 },
    lastStatusCheckAt: { type: Date, default: null },
    confirmationEmailSentAt: { type: Date, default: null },
    bookedAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date },
    closedAt: { type: Date },
    reminders: [{
      type: { type: String, enum: ["24h", "1h"] },
      sentAt: { type: Date, default: Date.now },
    }],
    // Demo Platform — booking authored under impersonation / seeded for a demo workspace
    isDemo: { type: Boolean, default: false, index: true },
    isTest: { type: Boolean, default: false, index: true },
    createdByDemoUser: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

SBTHotelBookingSchema.plugin(workspaceScopePlugin);
SBTHotelBookingSchema.index({ workspaceId: 1, userId: 1, status: 1 });
SBTHotelBookingSchema.index({ userId: 1, createdAt: -1 });
SBTHotelBookingSchema.index({ bookingId: 1 });
// Partial unique index on bookingId — excludes TBO-failed bookings (bookingId === "0", null, missing).
// MongoDB partial filter expressions only support a limited operator set; $nin/$ne/$not are NOT allowed.
// $type:"string" ensures we don't index null/missing/numeric values.
// $gt:"0" lexicographically excludes "0" since real TBO bookingIds are 6-7 digit strings (all > "0").
SBTHotelBookingSchema.index(
  { bookingId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      bookingId: { $type: "string", $gt: "0" },
    },
    name: "bookingId_unique_partial",
  },
);
SBTHotelBookingSchema.index({ confirmationNo: 1 });
SBTHotelBookingSchema.index({ clientReferenceId: 1 }, { unique: true, sparse: true });
// TBO cert Item 31 — cron sweep query: find due deferred checks fast.
SBTHotelBookingSchema.index({ pendingStatusCheckAt: 1, statusCheckDone: 1 });

/* ── Sync to TravelBooking on save ── */

/** Today's date in IST, "YYYY-MM-DD". */
export function istDateKey(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * SBTHotelBooking.status → TravelBooking.status (Travel Spend FU-1, decision
 * 2026-11-18). Dead holds no longer sit in "Pending" for ever:
 *   EXPIRED / CLOSED / ORPHAN_CLEANED → FAILED
 *   CANCEL_PENDING                    → CANCELLED
 *   HELD whose check-in (IST) has passed → FAILED — in the MIRROR only; the
 *     source stays HELD. jobs/stale-hotel-hold-mirror.ts re-syncs these daily
 *     because nothing writes the booking when the date simply passes.
 *   HELD (check-in today or later), PENDING and anything unknown → PENDING
 */
export function mapHotelMirrorStatus(
  s: string,
  checkIn?: unknown,
  now: Date = new Date(),
): "CONFIRMED" | "CANCELLED" | "PENDING" | "FAILED" {
  if (s === "CONFIRMED") return "CONFIRMED";
  if (s === "CANCELLED" || s === "CANCEL_PENDING") return "CANCELLED";
  if (s === "FAILED" || s === "EXPIRED" || s === "CLOSED" || s === "ORPHAN_CLEANED") return "FAILED";
  if (s === "HELD") {
    const ci = String(checkIn ?? "").trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ci) && ci < istDateKey(now)) return "FAILED";
  }
  return "PENDING";
}

/** The TravelBooking row this booking should have (no write). Shared by
 *  the sync below and scripts/resync-travel-booking-mirrors.ts's dry run. */
function hotelCountry(doc: any): string | null {
  return (doc.countryCode || "").trim().toUpperCase() || countryFor(doc.cityName);
}

export async function buildSBTHotelBookingMirror(doc: any, now: Date = new Date()): Promise<Record<string, any>> {
  return {
    // Customer _id, resolved like the flight mirror (services/sbtMirrorTenant.ts, audit N7).
    tenantId: await resolveSbtTenantId(doc),
    service: "HOTEL",
    amount: doc.totalFare || doc.netAmount || 0,
    userId: doc.userId,
    status: mapHotelMirrorStatus(doc.status, doc.checkIn, now),
    paymentMode: doc.paymentMode === "personal" ? "PERSONAL" : "OFFICIAL",
    source: "SBT",
    reference: doc._id,
    referenceModel: "SBTHotelBooking",
    // Mirror the flags every TravelBooking reader filters on.
    isDemo: doc.isDemo === true,
    isTest: doc.isTest === true,
    destination: doc.cityName || "",
    // Cities-only Top Destinations: carry the authoritative source city +
    // country through (previously countryCode was dropped). countryCode is
    // already ISO-2; isInternational is null when country is unknown.
    // Canonical spelling when the lookup knows it ("New Delhi" → Delhi,
    // "Bombay/ Mumbai" → Mumbai) so Top Destinations doesn't split a city.
    destinationCity: canonicalCity(doc.cityName),
    // countryCode when TBO sent one, else the city's country from the lookup
    // ("New Delhi" → IN) — older rows have no countryCode, and the May
    // backfill had set their country from the city.
    destinationCountry: hotelCountry(doc),
    isInternational: hotelCountry(doc) == null ? null : hotelCountry(doc) !== "IN",
    origin: "",
    bookedAt: doc.bookedAt || doc.createdAt,
    travelDate: doc.checkIn ? new Date(doc.checkIn) : null,
    travelDateEnd: doc.checkOut ? new Date(doc.checkOut) : null,
    metadata: {
      hotelName: doc.hotelName,
      checkIn: doc.checkIn,
      checkOut: doc.checkOut,
      rooms: doc.rooms,
      guests: doc.guests?.length || 0,
      // Stay length for the nightly-rate panel (Phase B additions).
      nights: stayNights(doc.checkIn, doc.checkOut),
    },
  };
}

/** Nights between two YYYY-MM-DD(…) dates, or null when either is missing or the stay isn't 1–59 nights. */
export function stayNights(checkIn: unknown, checkOut: unknown): number | null {
  const day = (v: unknown) => {
    const m = String(v ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  };
  const n = Math.round((day(checkOut) - day(checkIn)) / 86400000);
  return Number.isFinite(n) && n >= 1 && n < 60 ? n : null;
}

/** Upsert this booking's TravelBooking mirror row from the source doc
 *  (hydrated or lean). Throws on failure — callers decide. */
export async function syncSBTHotelBookingToMirror(doc: any): Promise<void> {
  await TravelBooking.findOneAndUpdate({ reference: doc._id }, await buildSBTHotelBookingMirror(doc), { upsert: true, new: true });
}

SBTHotelBookingSchema.post("save", async function (doc: any) {
  try {
    await syncSBTHotelBookingToMirror(doc);
  } catch (e) {
    console.warn("TravelBooking sync failed:", (e as any)?.message);
  }
});

/** Paths syncSBTHotelBookingToMirror reads. A findOneAndUpdate / updateOne / updateMany that
 *  writes any of them re-syncs the mirror (utils/mirrorResyncHooks.ts) —
 *  status transitions, fare updates and isDemo/isTest flags used to skip
 *  the save hook and leave the mirror stale (Travel Spend audit N4). */
export const SBT_HOTEL_BOOKING_MIRROR_PATHS = ["customerId", "workspaceId", "totalFare", "netAmount", "userId", "status", "paymentMode", "isDemo", "isTest", "cityName", "countryCode", "bookedAt", "createdAt", "checkIn", "checkOut", "hotelName", "rooms", "guests"] as const;

export async function resyncSBTHotelBookingMirrors(ids: unknown[]): Promise<{ synced: number; failed: number; missing: number }> {
  const out = { synced: 0, failed: 0, missing: 0 };
  if (!ids.length) return out;
  const docs = await SBTHotelBookingModel.find({ _id: { $in: ids } }).lean();
  out.missing = ids.length - docs.length;
  for (const doc of docs) {
    try {
      await syncSBTHotelBookingToMirror(doc);
      out.synced += 1;
    } catch (e) {
      out.failed += 1;
      console.warn("TravelBooking resync (sbt-hotel) failed:", String((doc as any)._id), (e as any)?.message);
    }
  }
  return out;
}

attachMirrorResyncHooks(SBTHotelBookingSchema, {
  label: "sbt-hotel",
  mirrorPaths: SBT_HOTEL_BOOKING_MIRROR_PATHS,
  resync: (ids) => resyncSBTHotelBookingMirrors(ids),
});

const SBTHotelBookingModel = model<ISBTHotelBooking>("SBTHotelBooking", SBTHotelBookingSchema);
export default SBTHotelBookingModel;
