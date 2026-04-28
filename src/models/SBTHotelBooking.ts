import { Schema, model, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import TravelBooking from "./TravelBooking.js";

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
  isPublishedFare?: boolean;
  tds?: number;
  agentCommission?: number;
  currency: string;
  isRefundable: boolean;
  cancelPolicies: unknown[];
  status: "CONFIRMED" | "CANCELLED" | "FAILED" | "PENDING" | "CANCEL_PENDING" | "HELD" | "EXPIRED";
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
  displayAmount?: number;
  raw?: unknown;
  tboVoucherData?: unknown;
  voucherStatus?: "PENDING" | "CONFIRMED" | "FAILED" | "GENERATED" | "PAYMENT_COLLECTED" | "HELD" | "CANCELLED" | "CANCEL_PENDING";
  sbtRequestId?: Schema.Types.ObjectId;
  cancellationCharge?: number;
  refundedAmount?: number;
  changeRequestId?: string;
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
  bookedAt: Date;
  cancelledAt?: Date;
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
    hotelName: { type: String, required: true },
    cityName: { type: String, default: "" },
    cityCode: { type: String, default: "" },
    countryCode: { type: String, default: "" },
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
    isPublishedFare: { type: Boolean, default: false },
    tds: { type: Number, default: 0 },
    agentCommission: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    isRefundable: { type: Boolean, default: false },
    cancelPolicies: { type: [Schema.Types.Mixed], default: [] },
    status: {
      type: String,
      enum: ["CONFIRMED", "CANCELLED", "FAILED", "PENDING", "CANCEL_PENDING", "HELD", "EXPIRED"],
      default: "CONFIRMED",
    },
    isHeld: { type: Boolean, default: false },
    lastVoucherDate: { type: Date },
    lastCancellationDate: { type: Date, default: null },
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
    bookedAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date },
  },
  { timestamps: true },
);

SBTHotelBookingSchema.plugin(workspaceScopePlugin);
SBTHotelBookingSchema.index({ workspaceId: 1, userId: 1, status: 1 });
SBTHotelBookingSchema.index({ userId: 1, createdAt: -1 });
SBTHotelBookingSchema.index({ bookingId: 1 });
SBTHotelBookingSchema.index({ confirmationNo: 1 });

/* ── Sync to TravelBooking on save ── */
function mapStatus(s: string): "CONFIRMED" | "CANCELLED" | "PENDING" | "FAILED" {
  if (s === "CONFIRMED") return "CONFIRMED";
  if (s === "CANCELLED") return "CANCELLED";
  if (s === "FAILED") return "FAILED";
  return "PENDING"; // HELD and unknown map to PENDING in TravelBooking
}

SBTHotelBookingSchema.post("save", async function (doc: any) {
  try {
    await TravelBooking.findOneAndUpdate(
      { reference: doc._id },
      {
        tenantId: doc.customerId || "default",
        service: "HOTEL",
        amount: doc.totalFare || doc.netAmount || 0,
        userId: doc.userId,
        status: mapStatus(doc.status),
        paymentMode: doc.paymentMode === "personal" ? "PERSONAL" : "OFFICIAL",
        source: "SBT",
        reference: doc._id,
        referenceModel: "SBTHotelBooking",
        destination: doc.cityName || "",
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
        },
      },
      { upsert: true, new: true },
    );
  } catch (e) {
    console.warn("TravelBooking sync failed:", (e as any)?.message);
  }
});

export default model<ISBTHotelBooking>("SBTHotelBooking", SBTHotelBookingSchema);
