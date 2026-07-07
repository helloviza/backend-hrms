import mongoose, { Schema, model, type Document } from "mongoose";
import Counter from "./Counter.js";
import CompanySettings from "./CompanySettings.js";

export interface IInvoiceLineItem {
  bookingRef: string;
  rowType: "COST" | "SERVICE_FEE";
  description: string;
  subDescription: string;
  qty: number;
  rate: number;
  igst: number;
  amount: number;
  passengerNames: string[];
  travelDate?: Date;
  type: string;
}

export interface IEditHistoryEntry {
  editedAt: Date;
  editedBy: Schema.Types.ObjectId;
  fieldsChanged: string[];
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
}

export interface IInvoice extends Document {
  invoiceNo: string;
  workspaceId: Schema.Types.ObjectId;
  billingPeriod?: string;
  bookingIds: Schema.Types.ObjectId[];
  lineItems: IInvoiceLineItem[];
  subtotal: number;
  totalGST: number;
  grandTotal: number;
  supplyType: "IGST" | "CGST_SGST" | "CGST_UTGST" | "EXPORT" | "NONE";
  cgstAmount: number;
  sgstAmount: number;
  utgstAmount: number;
  igstAmount: number;
  gstTypeAutoDetected?: string;
  gstTypeOverridden?: boolean;
  gstOverrideReason?: string;
  gstOverrideBy?: Schema.Types.ObjectId;
  gstBypass?: boolean;
  gstBypassType?: "CGST_SGST" | "CGST_UTGST" | null;
  gstBypassReason?: string;
  editedAt?: Date;
  editedBy?: Schema.Types.ObjectId;
  editHistory?: IEditHistoryEntry[];
  placeOfSupply?: string;
  issuerState?: string;
  clientState?: string;
  issuerDetails?: {
    companyName?: string;
    gstin?: string;
    address?: string;        // legacy freeform
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    country?: string;
    pincode?: string;
    email?: string;
    phone?: string;
    website?: string;
    state?: string;
  };
  clientDetails?: {
    companyName?: string;
    gstin?: string;
    billingAddress?: string; // legacy freeform
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    country?: string;
    pincode?: string;
    contactPerson?: string;
    email?: string;
    state?: string;
  };
  status: "DRAFT" | "SENT" | "PAID" | "CANCELLED";
  cancelledAt?: Date;
  cancelledBy?: Schema.Types.ObjectId;
  cancellationReason?: string;
  cancellationNote?: string;
  terms?: string;
  notes?: string;
  showInclusiveTaxNote?: boolean;
  isDemo?: boolean;
  invoiceDate: Date;
  dueDate?: Date;
  pdfUrl?: string;
  generatedAt: Date;
  sentAt?: Date;
  paidAt?: Date;
  createdBy?: Schema.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceSchema = new Schema<IInvoice>(
  {
    invoiceNo: { type: String, unique: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    billingPeriod: String,
    bookingIds: [{ type: Schema.Types.ObjectId, ref: "ManualBooking" }],
    lineItems: { type: mongoose.Schema.Types.Mixed, default: [] },
    subtotal: { type: Number, default: 0 },
    totalGST: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    supplyType: { type: String, enum: ["IGST", "CGST_SGST", "CGST_UTGST", "EXPORT", "NONE"], default: "IGST" },
    cgstAmount: { type: Number, default: 0 },
    sgstAmount: { type: Number, default: 0 },
    utgstAmount: { type: Number, default: 0 },
    igstAmount: { type: Number, default: 0 },
    gstTypeAutoDetected: { type: String },
    gstTypeOverridden: { type: Boolean, default: false },
    gstOverrideReason: { type: String },
    gstOverrideBy: { type: Schema.Types.ObjectId, ref: "User" },
    gstBypass: { type: Boolean, default: false },
    gstBypassType: {
      type: String,
      enum: ["CGST_SGST", "CGST_UTGST", null],
      default: null,
    },
    gstBypassReason: { type: String, default: "" },
    placeOfSupply: { type: String },
    issuerState: String,
    clientState: String,
    issuerDetails: {
      companyName: String,
      gstin: String,
      address: String,       // legacy freeform
      addressLine1: String,
      addressLine2: String,
      city: String,
      country: String,
      pincode: String,
      email: String,
      phone: String,
      website: String,
      state: String,
    },
    clientDetails: {
      companyName: String,
      gstin: String,
      billingAddress: String, // legacy freeform
      addressLine1: String,
      addressLine2: String,
      city: String,
      country: String,
      pincode: String,
      contactPerson: String,
      email: String,
      state: String,
    },
    status: { type: String, enum: ["DRAFT", "SENT", "PAID", "CANCELLED"], default: "DRAFT" },
    cancelledAt: Date,
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancellationReason: String,
    cancellationNote: String,
    terms: String,
    notes: String,
    showInclusiveTaxNote: { type: Boolean, default: false },
    // Demo Platform — invoice generated from demo bookings (seed or impersonation)
    isDemo: { type: Boolean, default: false, index: true },
    invoiceDate: { type: Date, required: true, default: () => new Date() },
    dueDate: Date,
    pdfUrl: String,
    generatedAt: { type: Date, default: Date.now },
    sentAt: Date,
    paidAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    editedAt: Date,
    editedBy: { type: Schema.Types.ObjectId, ref: "User" },
    editHistory: [{
      editedAt: Date,
      editedBy: { type: Schema.Types.ObjectId, ref: "User" },
      fieldsChanged: [String],
      oldValues: { type: Schema.Types.Mixed },
      newValues: { type: Schema.Types.Mixed },
    }],
  },
  { timestamps: true },
);

InvoiceSchema.index({ workspaceId: 1, status: 1 });
InvoiceSchema.index({ workspaceId: 1, generatedAt: -1 });

InvoiceSchema.pre("save", async function (next) {
  try {
    if (!this.isNew || this.invoiceNo) return next();

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const fyStartYear = month >= 4 ? year : year - 1;

    // Resolve which GST profile issued this invoice, purely to decide which
    // numbering series it belongs to — branches on "is this the default
    // profile" (empty invoiceSeriesPrefix), never on which state. Any
    // invoice whose issuer GSTIN doesn't match a registry entry (registry
    // not seeded yet, or a pre-registry invoice) falls back to the exact
    // legacy bare path below — this is what makes the default series
    // untouched and backfill-free.
    const gstin = ((this.issuerDetails as any)?.gstin || "").toUpperCase().trim();
    let prefix = "";
    let cadence: "annual" | "monthly" = "annual";
    if (gstin) {
      const companySettings = await CompanySettings.findOne().lean();
      const profile = (companySettings?.gstProfiles || []).find(
        (p: any) => (p.gstin || "").toUpperCase().trim() === gstin,
      );
      prefix = (profile?.invoiceSeriesPrefix || "").trim().toUpperCase();
      cadence = (companySettings as any)?.invoiceSeriesCadence === "monthly" ? "monthly" : "annual";
    }
    const isDefaultSeries = !prefix;

    let counterKey: string;
    let period: string;
    if (isDefaultSeries) {
      // DEFAULT PROFILE (or no registry match) — unchanged, forever. Same
      // Counter key, same bare format, zero backfill.
      period = String(fyStartYear);
      counterKey = `invoice:FY${fyStartYear}`;
    } else if (cadence === "monthly") {
      period = `${year}${String(month).padStart(2, "0")}`;
      counterKey = `invoice:${period}:${gstin}`;
    } else {
      period = String(fyStartYear);
      counterKey = `invoice:FY${fyStartYear}:${gstin}`;
    }

    // Pure atomic $inc, upsert — one MongoDB operation, fully serialized by
    // the storage engine. Never pair this with a second, separate adjustment
    // step that reassigns the local seq (see
    // infra/audit/invoice-numbering-per-gstin-audit.md §2 — that pattern is
    // exactly what let the old FY2026 catch-up hand two concurrent requests
    // the same computed number).
    let counter = await Counter.findByIdAndUpdate(
      counterKey,
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
    let nextSeq = counter!.seq;

    // FY 2026-27 minimum: legacy default-series catch-up only. Scoped to
    // isDefaultSeries so it can never run against a per-GSTIN counter — new
    // series always start clean from 0.
    if (isDefaultSeries && fyStartYear === 2026 && nextSeq < 40) {
      const adjusted = await Counter.findByIdAndUpdate(
        counterKey,
        { $max: { seq: 40 } },
        { new: true },
      );
      nextSeq = adjusted!.seq;
    }

    this.invoiceNo = isDefaultSeries
      ? `INV-${period}${String(nextSeq).padStart(4, "0")}`
      : `INV-${prefix}${period}${String(nextSeq).padStart(4, "0")}`;
    next();
  } catch (err) {
    next(err as Error);
  }
});

export default model<IInvoice>("Invoice", InvoiceSchema);
