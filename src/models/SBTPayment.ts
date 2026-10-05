import { Schema, model, type Document } from "mongoose";

/**
 * SBTPayment — one row per SBT payment attempt: the amount the SERVER priced,
 * and the proof that it was paid before anything was booked with TBO.
 *
 *   RAZORPAY  created at /payment/create-order for the server amount (CREATED),
 *             PAID once /payment/verify has fetched the payment from Razorpay
 *             and found it captured for exactly that amount.
 *   OFFICIAL  created at book/ticket time after the workspace's monthly limit
 *             was reserved with a conditional update (CLAIMED straight away).
 *
 * Booking/ticketing CLAIMS a PAID row (conditional update), so a payment buys
 * one booking only. A clear supplier failure releases it (RAZORPAY → PAID
 * again so the user can retry; OFFICIAL → limit credited back, RELEASED).
 * A supplier timeout leaves it UNCERTAIN for ops — never silently released.
 *
 * CHECKOUT (services/sbtFulfil.ts): a row created through the checkout routes
 * also carries `fulfilment` — the exact Book/Ticket request and the booking
 * details — so the SERVER books with TBO once the payment is proven, whether
 * the browser, the Razorpay webhook or a retry gets there first. Outcomes:
 *   TICKETED   booked (booking rows in bookingDocIds)
 *   REFUNDED   supplier failure / fare change → money returned automatically
 *   NEEDS_OPS  outcome unknown (timeout, refund failure) → ops@ alerted
 *
 * See services/sbtPaymentGate.ts. Never deleted (audit trail).
 */
export type SBTPaymentStatus =
  | "CREATED" | "PAID" | "CLAIMED" | "BOOKED" | "TICKETED" | "RELEASED" | "UNCERTAIN"
  | "REFUNDED" | "NEEDS_OPS";

export type FulfilmentKind = "FLIGHT_LCC" | "FLIGHT_GDS" | "FLIGHT_MULTI" | "HOTEL_BOOK" | "HOTEL_VOUCHER";

export interface SBTRefund {
  refundId?: string; // Razorpay refund id; empty for a wallet credit
  amountPaise: number;
  reason: string;
  status: "INITIATED" | "PROCESSED" | "FAILED" | "CREDITED";
  at: Date;
}

export interface ISBTPayment extends Document {
  product: "FLIGHT" | "HOTEL";
  mode: "RAZORPAY" | "OFFICIAL";
  status: SBTPaymentStatus;
  userId: string;
  workspaceId: string;
  // What the amount was priced from.
  quoteIds: string[];
  resultIndexes: string[]; // FLIGHT — every ResultIndex the quotes cover
  bookingCode?: string; // HOTEL — PreBook BookingCode
  heldBookingId?: string; // HOTEL — held booking being vouchered
  reissueOfBookingId?: string; // FLIGHT — reissue fare difference (never claimable)
  // Server amount, rupees (whole) and paise. baseAmount = fare part (flights).
  amount: number;
  amountPaise: number;
  baseAmount: number;
  addOnAmount: number;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  monthKey?: string; // OFFICIAL — month the limit was reserved in
  tboBookingId?: string;
  clientReferenceId?: string;
  paidAt?: Date;
  claimedAt?: Date;
  completedAt?: Date;
  failureReason?: string;
  // ── checkout ──
  fulfilment?: {
    kind: FulfilmentKind;
    request: Record<string, any>; // Book / Ticket / Voucher body (multi-city: legs[])
    save: Record<string, any>; // booking details for bookings/save (descriptive only)
  };
  // The booker, as the route handlers expect req.user (server-side fulfilment).
  actor?: Record<string, any>;
  addOnBreakdown?: { seat: number; meal: number; baggage: number };
  // Per-leg share of `amount` (return / multi-city) — what a failed leg refunds.
  legAmounts?: Array<{ resultIndex: string; amount: number }>;
  bookingDocIds: string[];
  result?: Record<string, any>; // summary the browser shows (PNRs, confirmation no.)
  // FLIGHT — the supplier's full Book / Ticket response per TBO BookingId. The
  // customer's copy is stripped of fares; /bookings/save reads the net from here.
  supplierResponses?: Array<{ bookingId: string; response: unknown; at: Date }>;
  refunds: SBTRefund[];
  refundedPaise: number;
  failureCode?: string; // FARE_CHANGED, SUPPLIER_FAILED, BOOKING_TERMS_CHANGED, …
  pendingDecision?: Record<string, any>; // e.g. changed cancellation policy to accept
  fulfilledVia?: "browser" | "webhook" | "retry";
  lastPaymentFailure?: string;
  opsAlertedAt?: Date;
  // Demo Platform checkout: the simulator moves the demo wallet itself, so the
  // server never reserves or credits the limit for these rows.
  isDemo?: boolean;
  isTest: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SBTPaymentSchema = new Schema<ISBTPayment>(
  {
    product: { type: String, enum: ["FLIGHT", "HOTEL"], required: true },
    mode: { type: String, enum: ["RAZORPAY", "OFFICIAL"], required: true },
    status: {
      type: String,
      enum: ["CREATED", "PAID", "CLAIMED", "BOOKED", "TICKETED", "RELEASED", "UNCERTAIN", "REFUNDED", "NEEDS_OPS"],
      required: true,
    },
    userId: { type: String, required: true },
    workspaceId: { type: String, required: true },
    quoteIds: { type: [String], default: [] },
    resultIndexes: { type: [String], default: [] },
    bookingCode: { type: String },
    heldBookingId: { type: String },
    reissueOfBookingId: { type: String },
    amount: { type: Number, required: true },
    amountPaise: { type: Number, required: true },
    baseAmount: { type: Number, default: 0 },
    addOnAmount: { type: Number, default: 0 },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    monthKey: { type: String },
    tboBookingId: { type: String },
    clientReferenceId: { type: String },
    paidAt: { type: Date },
    claimedAt: { type: Date },
    completedAt: { type: Date },
    failureReason: { type: String },
    fulfilment: { type: Schema.Types.Mixed },
    actor: { type: Schema.Types.Mixed },
    addOnBreakdown: { type: Schema.Types.Mixed },
    legAmounts: { type: Schema.Types.Mixed },
    bookingDocIds: { type: [String], default: [] },
    result: { type: Schema.Types.Mixed },
    supplierResponses: { type: Schema.Types.Mixed },
    refunds: { type: Schema.Types.Mixed, default: [] } as any,
    refundedPaise: { type: Number, default: 0 },
    failureCode: { type: String },
    pendingDecision: { type: Schema.Types.Mixed },
    fulfilledVia: { type: String },
    lastPaymentFailure: { type: String },
    opsAlertedAt: { type: Date },
    isDemo: { type: Boolean, default: false },
    isTest: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

// One row per Razorpay order, and a captured payment can back ONE row only —
// the replay guard that holds even when two requests race.
SBTPaymentSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: "string" } } },
);
SBTPaymentSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string" } } },
);
SBTPaymentSchema.index({ tboBookingId: 1, userId: 1 });
// The checkout sweep (jobs/sbt-checkout-sweep.ts).
SBTPaymentSchema.index({ status: 1, paidAt: 1 });
SBTPaymentSchema.index({ status: 1, claimedAt: 1 });

export default model<ISBTPayment>("SBTPayment", SBTPaymentSchema);
