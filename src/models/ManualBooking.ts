import { Schema, model, type Document } from "mongoose";

export const PENDING_SUB_STATUSES = [
  "Pending for Customer Confirmation",
  "Pending for Supplier Confirmation",
] as const;

export const CANCELLED_SUB_STATUSES = [
  "Fare Difference",
  "Price sudden increase",
  "Not Sure for dates",
  "Not Sure for Location",
  "Plan changed",
  "Travel cancelled",
] as const;

export const ALL_SUB_STATUSES = [
  ...PENDING_SUB_STATUSES,
  ...CANCELLED_SUB_STATUSES,
] as const;

export type SubStatus = (typeof ALL_SUB_STATUSES)[number] | "";

export interface IManualBooking extends Document {
  workspaceId: Schema.Types.ObjectId;
  bookingRef: string;
  bookingDate: Date;
  travelDate: Date;
  returnDate?: Date;
  reqDate?: Date;
  givenBy?: string;
  sector?: string;
  priceBenefits?: string;
  bookingWeek?: number;
  bookingMonth?: string;
  requestProcessTAT?: number;
  invoiceRaisedDate?: Date;
  type:
    | "FLIGHT" | "HOTEL" | "VISA" | "TRANSFER" | "OTHER"
    | "CAB" | "FOREX" | "ESIM" | "HOLIDAYS" | "EVENTS"
    | "DUMMY_FLIGHT" | "DUMMY_HOTEL";
  status: "PENDING" | "WIP" | "CONFIRMED" | "INVOICED" | "CANCELLED";
  subStatus?: SubStatus;
  source: "MANUAL" | "SBT" | "ADMIN_QUEUE" | "SBT_AUTO";
  sourceBookingId?: Schema.Types.ObjectId;
  sourceBookingRef?: string;
  itinerary: {
    origin?: string;
    destination?: string;
    flightNo?: string;
    airline?: string;
    hotelName?: string;
    roomType?: string;
    nights?: number;
    description?: string;
  };
  passengers: {
    name: string;
    email?: string;
    phone?: string;
    panNo?: string;
    passportNo?: string;
    type: "ADULT" | "CHILD" | "INFANT";
  }[];
  pricing: {
    // primary fields
    actualPrice: number;
    quotedPrice: number;
    diff?: number;
    basePrice?: number;
    grandTotal?: number;
    // backward-compat aliases
    supplierCost: number;
    sellingPrice?: number;
    markupAmount?: number;
    gstMode: "ON_FULL" | "ON_MARKUP";
    gstPercent: number;
    gstAmount?: number;
    totalWithGST?: number;
    currency: string;
    profitMargin?: number;
  };
  supplierName?: string;
  supplierPNR?: string;
  bookedBy: Schema.Types.ObjectId;
  notes?: string;
  invoiceId?: Schema.Types.ObjectId;
  createdBy?: string;
  createdByEmail?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ManualBookingSchema = new Schema<IManualBooking>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    bookingRef: { type: String, unique: true },
    bookingDate: { type: Date, default: Date.now },
    travelDate: { type: Date, required: true },
    returnDate: { type: Date },
    reqDate: { type: Date },
    givenBy: { type: String },
    sector: { type: String },
    priceBenefits: { type: String },
    bookingWeek: { type: Number },
    bookingMonth: { type: String },
    requestProcessTAT: { type: Number },
    invoiceRaisedDate: { type: Date },
    type: {
      type: String,
      enum: [
        "FLIGHT", "HOTEL", "VISA", "TRANSFER", "OTHER",
        "CAB", "FOREX", "ESIM", "HOLIDAYS", "EVENTS",
        "DUMMY_FLIGHT", "DUMMY_HOTEL",
      ],
      required: true,
    },
    status: { type: String, enum: ["PENDING", "WIP", "CONFIRMED", "INVOICED", "CANCELLED"], default: "PENDING" },
    subStatus: { type: String, enum: [...ALL_SUB_STATUSES, ""], default: "" },
    source: { type: String, enum: ["MANUAL", "SBT", "ADMIN_QUEUE", "SBT_AUTO"], default: "MANUAL" },
    sourceBookingId: { type: Schema.Types.ObjectId },
    sourceBookingRef: { type: String },
    itinerary: {
      origin: String,
      destination: String,
      flightNo: String,
      airline: String,
      hotelName: String,
      roomType: String,
      nights: Number,
      description: String,
    },
    passengers: [
      {
        name: { type: String, required: true },
        email: String,
        phone: String,
        panNo: String,
        passportNo: String,
        type: { type: String, enum: ["ADULT", "CHILD", "INFANT"], default: "ADULT" },
      },
    ],
    pricing: {
      // primary fields
      actualPrice: { type: Number, default: 0 },
      quotedPrice: { type: Number, default: 0 },
      diff: { type: Number },
      basePrice: { type: Number },
      grandTotal: { type: Number },
      // backward-compat aliases
      supplierCost: { type: Number, default: 0 },
      markupAmount: { type: Number, default: 0 },
      sellingPrice: { type: Number },
      gstMode: { type: String, enum: ["ON_FULL", "ON_MARKUP"], default: "ON_MARKUP" },
      gstPercent: { type: Number, default: 18 },
      gstAmount: { type: Number },
      totalWithGST: { type: Number },
      currency: { type: String, default: "INR" },
      profitMargin: { type: Number },
    },
    supplierName: String,
    supplierPNR: String,
    bookedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    notes: String,
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice" },
    createdBy: { type: String, index: true },
    createdByEmail: { type: String },
  },
  { timestamps: true },
);

ManualBookingSchema.index({ workspaceId: 1, status: 1 });
ManualBookingSchema.index({ workspaceId: 1, travelDate: -1 });
ManualBookingSchema.index({ bookingRef: 1 });

ManualBookingSchema.pre("save", async function (next) {
  // Auto-generate bookingRef for new documents
  if (this.isNew && !this.bookingRef) {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `MB-${yy}${mm}-`;

    const count = await (this.constructor as any).countDocuments({
      bookingRef: { $regex: `^${prefix}` },
    });

    this.bookingRef = `${prefix}${String(count + 1).padStart(4, "0")}`;
  }

  // Recalculate pricing fields every save
  const p = this.pricing;
  if (p) {
    // Resolve actual/quoted from either field name (backward compat)
    const actualPrice = p.actualPrice || p.supplierCost || 0;
    const quotedPrice = p.quotedPrice || p.sellingPrice || 0;
    const gstPercent = p.gstPercent ?? 18;
    const gstMode = p.gstMode ?? "ON_MARKUP";

    // Sync aliases in both directions
    p.actualPrice  = actualPrice;
    p.supplierCost = actualPrice;
    p.quotedPrice  = quotedPrice;
    p.sellingPrice = quotedPrice;

    const diff = quotedPrice - actualPrice;

    let gstAmount = 0;
    let basePrice = 0;
    let grandTotal = 0;

    if (gstMode === "ON_MARKUP") {
      // Markup is tax-inclusive — back-calculate GST from markup
      // GST = diff × 18/118
      gstAmount  = parseFloat((diff * gstPercent / (100 + gstPercent)).toFixed(2));
      basePrice  = parseFloat((diff - gstAmount).toFixed(2));
      grandTotal = parseFloat(quotedPrice.toFixed(2));
      // Client pays quotedPrice — GST is embedded within the markup
    }

    if (gstMode === "ON_FULL") {
      // GST charged on top of full quoted price
      gstAmount  = parseFloat((quotedPrice * gstPercent / 100).toFixed(2));
      grandTotal = parseFloat((quotedPrice + gstAmount).toFixed(2));
      // Internal profit calc: markup is still tax-inclusive
      basePrice  = parseFloat((diff * 100 / (100 + gstPercent)).toFixed(2));
      // (basePrice here = your net margin after paying GST on markup portion)
    }

    p.diff         = parseFloat(diff.toFixed(2));
    p.markupAmount = parseFloat(diff.toFixed(2));  // keep alias equal to diff
    p.gstAmount    = gstAmount;
    p.basePrice    = basePrice;
    p.grandTotal   = grandTotal;
    p.totalWithGST = grandTotal;
    p.profitMargin = quotedPrice > 0
      ? parseFloat(((diff / quotedPrice) * 100).toFixed(2))
      : 0;
  }

  // Always compute from booking creation date, not travel date
  const bookingDate = this.createdAt ? new Date(this.createdAt) : new Date();
  const startOfYear = new Date(bookingDate.getFullYear(), 0, 1);
  const weekNo = Math.ceil(
    ((bookingDate.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7,
  );
  this.bookingWeek = weekNo;
  this.bookingMonth = bookingDate.toLocaleString("en-IN", { month: "long", year: "numeric" });

  // Request process TAT
  if (this.reqDate && this.travelDate) {
    const diffMs =
      new Date(this.travelDate).getTime() - new Date(this.reqDate).getTime();
    this.requestProcessTAT = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  }

  next();
});

export default model<IManualBooking>("ManualBooking", ManualBookingSchema);
