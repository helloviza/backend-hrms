import { Schema, model, type Document } from "mongoose";

export interface ISBTBooking extends Document {
  userId: Schema.Types.ObjectId;
  customerId?: string;
  pnr: string;
  bookingId: string;
  ticketId: string;
  status: "CONFIRMED" | "CANCELLED" | "PENDING" | "FAILED";
  origin: { code: string; city: string };
  destination: { code: string; city: string };
  departureTime: string;
  arrivalTime: string;
  airlineCode: string;
  airlineName: string;
  flightNumber: string;
  cabin: number;
  passengers: {
    title: string;
    firstName: string;
    lastName: string;
    paxType: string;
    isLead: boolean;
  }[];
  contactEmail: string;
  contactPhone: string;
  baseFare: number;
  taxes: number;
  extras: number;
  totalFare: number;
  currency: string;
  isLCC: boolean;
  razorpayPaymentId?: string;
  razorpayOrderId?: string;
  razorpayAmount?: number;
  paymentStatus?: "pending" | "paid" | "failed";
  paymentTimestamp?: Date;
  paymentCapturedAt?: Date;
  webhookProcessed?: boolean;
  failureReason?: string;
  refundId?: string;
  refundStatus?: string;
  refundProcessedAt?: Date;
  raw?: unknown;
  bookedAt: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SBTBookingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    customerId: { type: String, trim: true, index: true },
    pnr: { type: String, default: "" },
    bookingId: { type: String, default: "" },
    ticketId: { type: String, default: "" },
    status: {
      type: String,
      enum: ["CONFIRMED", "CANCELLED", "PENDING", "FAILED"],
      default: "CONFIRMED",
    },
    origin: {
      code: { type: String, required: true },
      city: { type: String, required: true },
    },
    destination: {
      code: { type: String, required: true },
      city: { type: String, required: true },
    },
    departureTime: { type: String, required: true },
    arrivalTime: { type: String, required: true },
    airlineCode: { type: String, required: true },
    airlineName: { type: String, required: true },
    flightNumber: { type: String, required: true },
    cabin: { type: Number, default: 2 },
    passengers: [
      {
        title: String,
        firstName: String,
        lastName: String,
        paxType: String,
        isLead: Boolean,
      },
    ],
    contactEmail: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    baseFare: { type: Number, required: true },
    taxes: { type: Number, default: 0 },
    extras: { type: Number, default: 0 },
    totalFare: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    isLCC: { type: Boolean, default: false },
    razorpayPaymentId: { type: String, default: "" },
    razorpayOrderId: { type: String, default: "", index: true },
    razorpayAmount: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
    paymentTimestamp: { type: Date },
    paymentCapturedAt: { type: Date },
    webhookProcessed: { type: Boolean, default: false },
    failureReason: { type: String, default: "" },
    refundId: { type: String },
    refundStatus: { type: String },
    refundProcessedAt: { type: Date },
    raw: { type: Schema.Types.Mixed },
    sbtRequestId: { type: Schema.Types.ObjectId, ref: "SBTRequest", default: null, index: true },
    bookedAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date },
  },
  { timestamps: true },
);

SBTBookingSchema.index({ userId: 1, createdAt: -1 });
SBTBookingSchema.index({ pnr: 1 });
SBTBookingSchema.index({ bookingId: 1 });

export default model<ISBTBooking>("SBTBooking", SBTBookingSchema);
