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
 * See services/sbtPaymentGate.ts. Never deleted (audit trail).
 */
export type SBTPaymentStatus =
  | "CREATED" | "PAID" | "CLAIMED" | "BOOKED" | "TICKETED" | "RELEASED" | "UNCERTAIN";

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
  createdAt: Date;
  updatedAt: Date;
}

const SBTPaymentSchema = new Schema<ISBTPayment>(
  {
    product: { type: String, enum: ["FLIGHT", "HOTEL"], required: true },
    mode: { type: String, enum: ["RAZORPAY", "OFFICIAL"], required: true },
    status: {
      type: String,
      enum: ["CREATED", "PAID", "CLAIMED", "BOOKED", "TICKETED", "RELEASED", "UNCERTAIN"],
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

export default model<ISBTPayment>("SBTPayment", SBTPaymentSchema);
