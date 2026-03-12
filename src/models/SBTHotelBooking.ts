import { Schema, model, type Document } from "mongoose";

export interface ISBTHotelBooking extends Document {
  userId: Schema.Types.ObjectId;
  customerId?: string;
  bookingId: string;
  confirmationNo: string;
  bookingRefNo: string;
  hotelCode: string;
  hotelName: string;
  cityName: string;
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
  currency: string;
  isRefundable: boolean;
  cancelPolicies: unknown[];
  status: "CONFIRMED" | "CANCELLED" | "FAILED" | "PENDING";
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
  bookedAt: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SBTHotelBookingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    customerId: { type: String, trim: true, index: true },
    bookingId: { type: String, default: "" },
    confirmationNo: { type: String, default: "" },
    bookingRefNo: { type: String, default: "" },
    hotelCode: { type: String, default: "" },
    hotelName: { type: String, required: true },
    cityName: { type: String, default: "" },
    checkIn: { type: String, required: true },
    checkOut: { type: String, required: true },
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
    totalFare: { type: Number, required: true },
    netAmount: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    isRefundable: { type: Boolean, default: false },
    cancelPolicies: { type: [Schema.Types.Mixed], default: [] },
    status: {
      type: String,
      enum: ["CONFIRMED", "CANCELLED", "FAILED", "PENDING"],
      default: "CONFIRMED",
    },
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
    sbtRequestId: { type: Schema.Types.ObjectId, ref: "SBTRequest", default: null, index: true },
    bookedAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date },
  },
  { timestamps: true },
);

SBTHotelBookingSchema.index({ userId: 1, createdAt: -1 });
SBTHotelBookingSchema.index({ bookingId: 1 });
SBTHotelBookingSchema.index({ confirmationNo: 1 });

export default model<ISBTHotelBooking>("SBTHotelBooking", SBTHotelBookingSchema);
