import { Schema, model, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import TravelBooking from "./TravelBooking.js";

export interface ISBTBooking extends Document {
  userId: Schema.Types.ObjectId;
  workspaceId: Schema.Types.ObjectId;
  customerId?: string; // legacy
  traceId?: string;
  pnr: string;
  bookingId: string;
  ticketId: string;
  ticketIds?: number[];
  isReturn?: boolean;
  returnPnr?: string;
  returnBookingId?: number;
  returnTraceId?: string;
  status: "CONFIRMED" | "CANCELLED" | "PENDING" | "FAILED" | "REISSUED";
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
    contactNo?: string;
    phone?: string;
    email?: string;
    dob?: string;
    dateOfBirth?: string;
    passportNo?: string;
    passportExpiry?: string;
    passportIssueDate?: string;
    nationality?: string;
    address?: string;
    city?: string;
    countryCode?: string;
    countryName?: string;
    cellCountryCode?: string;
    fare?: {
      BaseFare?: number;
      Tax?: number;
      YQTax?: number;
      OtherCharges?: number;
      AdditionalTxnFeeOfrd?: number;
      AdditionalTxnFeePub?: number;
    };
  }[];
  contactEmail: string;
  contactPhone: string;
  baseFare: number;
  taxes: number;
  extras: number;
  totalFare: number;
  currency: string;
  isLCC: boolean;
  fareBreakdown?: {
    passengerType: number;
    passengerCount: number;
    baseFare: number;
    tax: number;
    perPaxBaseFare: number;
    perPaxTax: number;
  }[];
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
  paymentMode?: "official" | "personal";
  reissuePaymentMode?: "GATEWAY" | "WALLET";
  netAmount?: number;
  displayAmount?: number;
  marginPercent?: number;
  marginAmount?: number;
  ticketingStatus: "NOT_ATTEMPTED" | "TICKETED" | "FAILED" | "TICKET_FAILED" | "PENDING";
  ticketingError?: string;
  raw?: unknown;
  cancelPolicies?: any[];
  isRefundable?: boolean;
  cancellationCharge?: number;
  refundedAmount?: number;
  changeRequestId?: string;
  reissuedFromBookingId?: Schema.Types.ObjectId;
  isReissued?: boolean;
  originalPNR?: string;
  onlineReissueAllowed?: boolean;
  sbtRequestId?: Schema.Types.ObjectId;
  changeRequests?: Array<{
    changeRequestId?: number;
    requestType?: string;
    requestedNewDate?: string;
    remarks?: string;
    status?: string;
    raisedAt?: Date;
    raisedBy?: any;
  }>;
  bookedAt: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SBTBookingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    customerId: { type: String, trim: true, index: true }, // legacy
    traceId: { type: String, default: "", index: true },
    pnr: { type: String, default: "" },
    bookingId: { type: String, default: "" },
    ticketId: { type: String, default: "" },
    ticketIds: { type: [Number], default: [] },
    isReturn: { type: Boolean, default: false },
    returnPnr: { type: String, default: "" },
    returnBookingId: { type: Number },
    returnTraceId: { type: String, default: "" },
    status: {
      type: String,
      enum: ["CONFIRMED", "CANCELLED", "PENDING", "FAILED", "REISSUED"],
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
        contactNo: String,
        phone: String,
        email: String,
        dob: String,
        dateOfBirth: String,
        passportNo: String,
        passportExpiry: String,
        passportIssueDate: String,
        nationality: String,
        address: String,
        city: String,
        countryCode: String,
        countryName: String,
        cellCountryCode: String,
        fare: {
          BaseFare: Number,
          Tax: Number,
          YQTax: Number,
          OtherCharges: Number,
          AdditionalTxnFeeOfrd: Number,
          AdditionalTxnFeePub: Number,
        },
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
    fareBreakdown: [
      {
        passengerType: { type: Number },
        passengerCount: { type: Number },
        baseFare: { type: Number },
        tax: { type: Number },
        perPaxBaseFare: { type: Number },
        perPaxTax: { type: Number },
      },
    ],
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
    paymentMode: { type: String, enum: ["official", "personal"], default: "personal" },
    reissuePaymentMode: { type: String, enum: ["GATEWAY", "WALLET"] },
    netAmount: { type: Number, default: 0 },
    displayAmount: { type: Number, default: 0 },
    marginPercent: { type: Number, default: 0 },
    marginAmount: { type: Number, default: 0 },
    ticketingStatus: {
      type: String,
      enum: ["NOT_ATTEMPTED", "TICKETED", "FAILED", "TICKET_FAILED", "PENDING"],
      default: "NOT_ATTEMPTED",
    },
    ticketingError: { type: String, default: "" },
    raw: { type: Schema.Types.Mixed },
    cancelPolicies: { type: [Schema.Types.Mixed], default: [] },
    isRefundable: { type: Boolean },
    cancellationCharge: { type: Number },
    refundedAmount: { type: Number },
    changeRequestId: { type: String },
    reissuedFromBookingId: { type: Schema.Types.ObjectId, ref: "SBTBooking" },
    isReissued: { type: Boolean, default: false },
    originalPNR: { type: String, default: "" },
    onlineReissueAllowed: { type: Boolean },
    sbtRequestId: { type: Schema.Types.ObjectId, ref: "SBTRequest", default: null, index: true },
    changeRequests: [{
      changeRequestId: { type: Number },
      requestType: { type: String },
      requestedNewDate: { type: String },
      remarks: { type: String },
      status: { type: String, default: "submitted" },
      raisedAt: { type: Date, default: Date.now },
      raisedBy: { type: Schema.Types.ObjectId, ref: "User" },
    }],
    bookedAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date },
  },
  { timestamps: true },
);

SBTBookingSchema.plugin(workspaceScopePlugin);
SBTBookingSchema.index({ workspaceId: 1, userId: 1, status: 1 });
SBTBookingSchema.index({ userId: 1, createdAt: -1 });
SBTBookingSchema.index({ pnr: 1 });
SBTBookingSchema.index({ bookingId: 1 });

/* ── Sync to TravelBooking on save ── */
function mapStatus(s: string): "CONFIRMED" | "CANCELLED" | "PENDING" | "FAILED" {
  if (s === "CONFIRMED") return "CONFIRMED";
  if (s === "CANCELLED") return "CANCELLED";
  if (s === "FAILED") return "FAILED";
  return "PENDING";
}

SBTBookingSchema.post("save", async function (doc: any) {
  try {
    await TravelBooking.findOneAndUpdate(
      { reference: doc._id },
      {
        tenantId: doc.customerId || "default",
        service: "FLIGHT",
        amount: doc.totalFare || 0,
        userId: doc.userId,
        status: mapStatus(doc.status),
        paymentMode: doc.paymentMode === "personal" ? "PERSONAL" : "OFFICIAL",
        source: "SBT",
        reference: doc._id,
        referenceModel: "SBTBooking",
        destination: doc.destination?.city || "",
        origin: doc.origin?.city || "",
        bookedAt: doc.bookedAt || doc.createdAt,
        travelDate: doc.departureTime ? new Date(doc.departureTime) : null,
        travelDateEnd: doc.arrivalTime ? new Date(doc.arrivalTime) : null,
        metadata: {
          airlineName: doc.airlineName,
          flightNumber: doc.flightNumber,
          pnr: doc.pnr,
          passengers: doc.passengers?.length || 0,
        },
      },
      { upsert: true, new: true },
    );
  } catch (e) {
    console.warn("TravelBooking sync failed:", (e as any)?.message);
  }
});

export default model<ISBTBooking>("SBTBooking", SBTBookingSchema);
