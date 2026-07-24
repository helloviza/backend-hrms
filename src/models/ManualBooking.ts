import { Schema, model, type Document } from "mongoose";
import TravelBooking from "./TravelBooking.js";
import CustomerWorkspace from "./CustomerWorkspace.js";

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

// Canonical list of every ManualBooking.type value — single source of truth
// for the Mongoose enum below AND for ManualBookingType (used by
// constants/serviceTaxonomy.ts on both frontend and backend so the intake
// forms' service options can never drift from what this schema actually
// accepts). Order is cosmetic; membership is what matters.
export const MANUAL_BOOKING_TYPES = [
  "FLIGHT", "HOTEL", "VISA", "TRANSFER", "OTHER",
  "CAB", "FOREX", "ESIM", "HOLIDAYS", "EVENTS",
  "DUMMY_FLIGHT", "DUMMY_HOTEL", "TRAIN",
  "FLIGHT_RESCHEDULE", "TROPHY", "GIFT", "STATIONERY",
  "INSURANCE", "GROUP_BOOKING",
] as const;

export type ManualBookingType = (typeof MANUAL_BOOKING_TYPES)[number];

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
  type: ManualBookingType;
  status: "PENDING" | "WIP" | "CONFIRMED" | "INVOICED" | "CANCELLED";
  subStatus?: SubStatus;
  source: "MANUAL" | "SBT" | "ADMIN_QUEUE" | "SBT_AUTO";
  sourceBookingId?: Schema.Types.ObjectId;
  sourceBookingRef?: string;
  itinerary: {
    origin?: string;
    destination?: string;
    flightNo?: string;    // reused as trainNo for TRAIN bookings
    airline?: string;
    hotelName?: string;
    roomType?: string;
    nights?: number;
    roomCount?: number;
    description?: string;
    trainClass?: string;
    // Transportation group — Transfer/Cab only.
    pickupLocation?: string;
    dropLocation?: string;
    vehicleType?: string;
    // Visa Service group only.
    visaCountry?: string;
    visaType?: string;
  };
  passengers: {
    name: string;
    email?: string;
    phone?: string;
    panNo?: string;
    passportNo?: string;
    type: "ADULT" | "CHILD" | "INFANT";
  }[];
  // Uploaded ticket/voucher/other files — see infra/audit/
  // manual-bookings-voucher-upload-audit.md. Metadata only; bytes live in S3
  // under bookings/attachments/<bookingId>/... (utils/s3Upload.ts).
  attachments: {
    type: "ticket" | "voucher" | "other";
    originalFilename: string;
    s3Key: string;
    size: number;
    mimeType: string;
    uploadedBy: Schema.Types.ObjectId;
    uploadedAt: Date;
  }[];
  // Repeatable invoice-line-item table — Group Booking (Holidays/Events/Group
  // Booking) only, for now. See infra/audit/events-line-items-audit.md. When
  // non-empty, the pre-save hook below derives pricing.quotedPrice/grandTotal
  // from Σ amount instead of the ON_MARKUP/ON_FULL markup-diff math, and
  // buildLineItemsForBooking() (utils/invoiceLineItems.ts) emits one invoice
  // row per entry instead of the usual 1-2 synthesized rows.
  lineItems: {
    sNo: number;
    itemDescription: string;
    quantity: number;
    rate: number;
    gstPct: number;
    gstAmount: number;
    amount: number;
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
  isActive?: boolean;
  cancelledAt?: Date;
  cancelledBy?: Schema.Types.ObjectId;
  cancellationReason?: string;
  cancellationNote?: string;
  deletedAt?: Date;
  deletedBy?: Schema.Types.ObjectId;
  deletionReason?: string;
  deletionNote?: string;
  createdBy?: string;
  createdByEmail?: string;
  isDemo?: boolean;
  createdByDemoUser?: boolean;
  // Free-form bag (Demo Platform uses metadata.demoRef for seed idempotency;
  // travel-intake uses metadata.intakeRef for dedup — see routes/intake.travel.ts).
  metadata?: Record<string, unknown>;
  // Assignment — orthogonal to `status` (booking lifecycle). Introduced for the
  // travel-intake pipeline: intake rows land PENDING_TO_ASSIGN until a staffer
  // is assigned. See the pre-save linkage rule below.
  assignmentStatus: "PENDING_TO_ASSIGN" | "ASSIGNED";
  assignPerson?: Schema.Types.ObjectId;
  assignPersonName?: string;
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
      enum: MANUAL_BOOKING_TYPES,
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
      roomCount: { type: Number, default: 1, min: 1 },
      description: String,
      trainClass: String,
      pickupLocation: String,
      dropLocation: String,
      vehicleType: String,
      visaCountry: String,
      visaType: String,
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
    attachments: [
      {
        type: { type: String, enum: ["ticket", "voucher", "other"], required: true },
        originalFilename: { type: String, required: true },
        s3Key: { type: String, required: true },
        size: { type: Number, required: true },
        mimeType: { type: String, required: true },
        uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    lineItems: [
      {
        sNo: { type: Number, required: true },
        itemDescription: { type: String, required: true },
        quantity: { type: Number, required: true, default: 1 },
        rate: { type: Number, required: true, default: 0 },
        gstPct: { type: Number, required: true, default: 0 },
        // gstAmount/amount are server-recomputed every save (pre-save hook
        // below) from quantity×rate×gstPct — never trusted as submitted, same
        // convention as the top-level pricing.* derived fields.
        gstAmount: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
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
    isActive: { type: Boolean, default: true, index: true },
    cancelledAt: { type: Date },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancellationReason: { type: String },
    cancellationNote: { type: String },
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletionReason: { type: String },
    deletionNote: { type: String },
    createdBy: { type: String, index: true },
    createdByEmail: { type: String },
    // Demo Platform — booking authored under impersonation / seeded for a demo workspace
    isDemo: { type: Boolean, default: false, index: true },
    createdByDemoUser: { type: Boolean, default: false, index: true },
    // Free-form bag — Demo Platform uses metadata.demoRef for seed idempotency;
    // travel-intake uses metadata.intakeRef for dedup.
    metadata: { type: Schema.Types.Mixed },
    // Assignment — see IManualBooking comment above. Independent of `status`.
    assignmentStatus: {
      type: String,
      enum: ["PENDING_TO_ASSIGN", "ASSIGNED"],
      default: "PENDING_TO_ASSIGN",
      index: true,
    },
    assignPerson: { type: Schema.Types.ObjectId, ref: "User", index: true },
    assignPersonName: { type: String, trim: true },
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
  const hasLineItems = Array.isArray((this as any).lineItems) && (this as any).lineItems.length > 0;

  if (p && hasLineItems) {
    // Group Booking with an explicit line-item table (infra/audit/
    // events-line-items-audit.md, section B2): pricing.quotedPrice/grandTotal
    // are DERIVED from Σ line amounts here, instead of the ON_MARKUP/ON_FULL
    // markup-diff math below — so the invoice total always matches the rows,
    // by construction (no separate re-derivation to drift against). Each
    // row's gstAmount/amount is itself server-recomputed from
    // quantity×rate×gstPct — never trusted as submitted, same convention as
    // every other pricing.* derived field. actualPrice is left exactly as
    // typed — Group Booking still tracks margin against a single Actual
    // Inventory Price; only the client-facing total is line-item-driven.
    let lineSubtotal = 0;
    let lineGstTotal = 0;
    let lineGrandTotal = 0;

    (this as any).lineItems.forEach((li: any, idx: number) => {
      const quantity = Number(li.quantity) || 0;
      const rate = Number(li.rate) || 0;
      const gstPct = Number(li.gstPct) || 0;
      const base = quantity * rate;
      const gstAmount = parseFloat(((base * gstPct) / 100).toFixed(2));
      const amount = parseFloat((base + gstAmount).toFixed(2));

      li.sNo = li.sNo != null ? li.sNo : idx + 1;
      li.gstAmount = gstAmount;
      li.amount = amount;

      lineSubtotal += base;
      lineGstTotal += gstAmount;
      lineGrandTotal += amount;
    });

    const actualPrice = p.actualPrice || p.supplierCost || 0;
    p.actualPrice  = actualPrice;
    p.supplierCost = actualPrice;
    p.quotedPrice  = parseFloat(lineSubtotal.toFixed(2));
    p.sellingPrice = p.quotedPrice;
    p.gstAmount    = parseFloat(lineGstTotal.toFixed(2));
    p.grandTotal   = parseFloat(lineGrandTotal.toFixed(2));
    p.totalWithGST = p.grandTotal;
    p.diff         = parseFloat((p.quotedPrice - actualPrice).toFixed(2));
    p.markupAmount = p.diff;
    p.basePrice    = p.diff; // ON_FULL semantics: net profit before GST
    p.profitMargin = actualPrice > 0
      ? parseFloat(((p.basePrice / actualPrice) * 100).toFixed(2))
      : 0;
  } else if (p) {
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
      // GST charged on top of full quoted price; the full markup is net profit
      gstAmount  = parseFloat((quotedPrice * gstPercent / 100).toFixed(2));
      grandTotal = parseFloat((quotedPrice + gstAmount).toFixed(2));
      basePrice  = parseFloat(diff.toFixed(2));
    }

    p.diff         = parseFloat(diff.toFixed(2));
    p.markupAmount = parseFloat(diff.toFixed(2));  // keep alias equal to diff
    p.gstAmount    = gstAmount;
    p.basePrice    = basePrice;
    p.grandTotal   = grandTotal;
    p.totalWithGST = grandTotal;
    p.profitMargin = actualPrice > 0
      ? parseFloat(((basePrice / actualPrice) * 100).toFixed(2))
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

/* ── Assignment linkage (independent of `status`) ──────────────────────
 * assignPerson set + still PENDING_TO_ASSIGN → ASSIGNED.
 * assignPerson cleared → revert to PENDING_TO_ASSIGN, regardless of prior value.
 * Deliberately does not read/write `status` — the two fields stay orthogonal.
 */
ManualBookingSchema.pre("save", function (next) {
  if (this.assignPerson) {
    if (this.assignmentStatus === "PENDING_TO_ASSIGN") {
      this.assignmentStatus = "ASSIGNED";
    }
  } else {
    this.assignmentStatus = "PENDING_TO_ASSIGN";
  }
  next();
});

/* ── Sync to TravelBooking mirror on save ──────────────────────────────
 * Symmetric with the SBTBooking / SBTHotelBooking post-save hooks: upsert one
 * TravelBooking keyed by { reference: doc._id }. The mirror is what the
 * customer Bookings tab (/api/my-bookings) reads — manual bookings did not
 * surface there until now.
 *
 * COST NEVER ENTERS THE MIRROR: `amount` is the customer-billed total
 * (pricing.grandTotal / totalWithGST / quotedPrice — all customer-facing),
 * NEVER actualPrice/supplierCost/markupAmount/profitMargin. TravelBooking has
 * no cost field, and metadata below carries only descriptive (non-cost) data.
 */

// ManualBooking.type → TravelBooking.service (total mapping; all targets valid enum members)
function manualTypeToService(t: string): string {
  switch (t) {
    case "FLIGHT":
    case "FLIGHT_RESCHEDULE":            // reschedule mirrors as a flight
    case "DUMMY_FLIGHT": return "FLIGHT";
    case "HOTEL":
    case "DUMMY_HOTEL":  return "HOTEL";
    case "VISA":         return "VISA";
    case "CAB":          return "CAB";
    case "TRANSFER":     return "TRANSFER";
    case "FOREX":        return "FOREX";
    case "ESIM":         return "ESIM";
    case "HOLIDAYS":     return "HOLIDAY";
    case "EVENTS":       return "MICE";
    case "TRAIN":        return "TRAIN";
    case "OTHER":
    case "TROPHY":                       // gift/trophy/stationery/insurance/group-booking mirror as OTHER
    case "GIFT":
    case "STATIONERY":
    case "INSURANCE":
    case "GROUP_BOOKING":  return "OTHER"; // for now — revisit once the line-item builder lands
    default:             return "OTHER";
  }
}

// Display name for the actual traveller from passengers[]: lead passenger,
// plus "+N" for additional passengers (e.g. "Nowshiba Malik +2"). NOT bookedBy.
function formatTravellerName(passengers: any): string {
  if (!Array.isArray(passengers) || passengers.length === 0) return "";
  const leadName = String(passengers[0]?.name || "").trim();
  const extra = passengers.length - 1;
  return extra > 0 ? `${leadName} +${extra}` : leadName;
}

// ManualBooking.status → TravelBooking.status (INVOICED→CONFIRMED, WIP→PENDING, else 1:1)
function manualStatusToTravel(s: string): "CONFIRMED" | "CANCELLED" | "PENDING" | "FAILED" {
  if (s === "INVOICED") return "CONFIRMED";
  if (s === "WIP") return "PENDING";
  if (s === "CONFIRMED") return "CONFIRMED";
  if (s === "CANCELLED") return "CANCELLED";
  return "PENDING"; // PENDING and any unexpected value
}

export async function syncManualBookingToMirror(doc: any): Promise<void> {
  // Skip SBT-origin rows — those already mirror in from the SBT side (avoid double-count).
  if (doc.source === "SBT" || doc.source === "SBT_AUTO" || doc.sourceBookingId) return;

  const tenantId = String(doc.workspaceId); // = Customer._id (the canonical key)

  // Resolve the CustomerWorkspace _id for this customer (required field on the mirror).
  let workspaceId: any = undefined;
  try {
    const ws: any = await CustomerWorkspace.findOne({ customerId: tenantId })
      .select("_id")
      .lean();
    if (ws?._id) workspaceId = ws._id;
  } catch {
    /* leave undefined — tenantId still scopes the customer Bookings tab */
  }

  const type = String(doc.type || "");
  const isHotel = type === "HOTEL" || type === "DUMMY_HOTEL";
  const origin = doc.itinerary?.origin || "";
  // destination is a CITY only — NEVER the hotel name (that caused the
  // Top-Destinations contamination). For hotels the city lives in
  // itinerary.destination or, failing that, `sector`. If neither has a city,
  // leave destination empty. Hotel name stays available via metadata.hotelName.
  const destination =
    doc.itinerary?.destination || (isHotel ? doc.sector : "") || "";

  // Customer-facing billed total only — never supplier cost / markup.
  const amount =
    doc.pricing?.grandTotal ?? doc.pricing?.totalWithGST ?? doc.pricing?.quotedPrice ?? 0;

  const lead = Array.isArray(doc.passengers) ? doc.passengers[0] : undefined;

  const update: any = {
    tenantId,
    service: manualTypeToService(type),
    amount,
    userId: doc.bookedBy, // required ref / ownership — NOT the displayed traveller
    status: manualStatusToTravel(String(doc.status || "")),
    paymentMode: "OFFICIAL", // agent-made on behalf of the customer
    source: "CONCIERGE", // non-SBT source
    reference: doc._id,
    referenceModel: "ManualBooking",
    destination,
    origin,
    // Actual traveller from passengers[] (lead + "+N"), surfaced to the customer
    // Bookings tab — distinct from userId (the staff booker).
    travellerName: formatTravellerName(doc.passengers),
    travellerEmail: lead?.email || "",
    // Soft-delete/restore parity with the source — see TravelBooking.ts's
    // isActive field. Fires both ways since delete/restore both call
    // booking.save(), which triggers this sync via the post("save") hook.
    isActive: doc.isActive !== false,
    bookedAt: doc.bookingDate || doc.createdAt,
    travelDate: doc.travelDate ? new Date(doc.travelDate) : null,
    travelDateEnd: doc.returnDate ? new Date(doc.returnDate) : null,
    // descriptive only — NO pricing/cost fields
    metadata: {
      bookingRef: doc.bookingRef,
      manualType: type,
      hotelName: doc.itinerary?.hotelName || "",
      airline: doc.itinerary?.airline || "",
      sector: doc.sector || "",
    },
  };
  if (workspaceId) update.workspaceId = workspaceId;

  await TravelBooking.findOneAndUpdate({ reference: doc._id }, update, {
    upsert: true,
    new: true,
  });
}

ManualBookingSchema.post("save", async function (doc: any) {
  try {
    await syncManualBookingToMirror(doc);
  } catch (e) {
    console.warn("TravelBooking sync (manual) failed:", (e as any)?.message);
  }
});

export default model<IManualBooking>("ManualBooking", ManualBookingSchema);
