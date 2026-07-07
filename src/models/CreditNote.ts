import mongoose, { Schema, model, type Document } from "mongoose";
import Counter from "./Counter.js";
import CompanySettings from "./CompanySettings.js";

export interface ICreditNoteLineItem {
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
  originalAmount?: number;
  creditedAmount?: number;
}

export interface ICreditNoteEditHistoryEntry {
  editedAt: Date;
  editedBy: Schema.Types.ObjectId;
  fieldsChanged: string[];
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
}

export interface ICreditNote extends Document {
  creditNoteNo: string;
  workspaceId: Schema.Types.ObjectId;

  originalInvoiceId: Schema.Types.ObjectId;
  originalInvoiceNo: string;
  originalInvoiceDate: Date;
  originalInvoiceAmount: number;

  serviceCategory: string;
  reasonId: Schema.Types.ObjectId;
  reasonText: string;
  reasonNote?: string;

  gstReasonCode: "01" | "02" | "03" | "04" | "05" | "06" | "07";
  gstReasonText: string;
  gstReasonOverridden: boolean;
  gstReasonOverrideBy?: Schema.Types.ObjectId;
  gstReasonOverrideReason?: string;

  isFullCredit: boolean;
  lineItems: ICreditNoteLineItem[];

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

  placeOfSupply?: string;
  issuerState?: string;
  clientState?: string;

  issuerDetails?: {
    companyName?: string;
    gstin?: string;
    address?: string;
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
    billingAddress?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    country?: string;
    pincode?: string;
    contactPerson?: string;
    email?: string;
    state?: string;
  };

  status: "DRAFT" | "ISSUED" | "CANCELLED";
  issuedAt?: Date;
  issuedBy?: Schema.Types.ObjectId;
  cancelledAt?: Date;
  cancelledBy?: Schema.Types.ObjectId;
  cancellationReason?: string;
  cancellationNote?: string;

  terms?: string;
  notes?: string;
  showInclusiveTaxNote?: boolean;
  isDemo?: boolean;
  creditNoteDate: Date;
  pdfUrl?: string;

  irn?: string;
  irnGeneratedAt?: Date;
  qrCodeData?: string;
  ackNo?: string;
  ackDate?: Date;

  generatedAt: Date;
  createdBy?: Schema.Types.ObjectId;
  editedAt?: Date;
  editedBy?: Schema.Types.ObjectId;
  editHistory?: ICreditNoteEditHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const CreditNoteSchema = new Schema<ICreditNote>(
  {
    creditNoteNo: { type: String, unique: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },

    originalInvoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    originalInvoiceNo: { type: String, required: true, index: true },
    originalInvoiceDate: { type: Date, required: true },
    originalInvoiceAmount: { type: Number, required: true },

    serviceCategory: { type: String, required: true, index: true },
    reasonId: { type: Schema.Types.ObjectId, ref: "CreditNoteReason", required: true },
    reasonText: { type: String, required: true },
    reasonNote: { type: String, maxlength: 500 },

    gstReasonCode: {
      type: String,
      enum: ["01", "02", "03", "04", "05", "06", "07"],
      required: true,
    },
    gstReasonText: { type: String, required: true },
    gstReasonOverridden: { type: Boolean, default: false },
    gstReasonOverrideBy: { type: Schema.Types.ObjectId, ref: "User" },
    gstReasonOverrideReason: { type: String },

    isFullCredit: { type: Boolean, required: true },
    lineItems: { type: mongoose.Schema.Types.Mixed, default: [] },

    subtotal: { type: Number, default: 0 },
    totalGST: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    supplyType: {
      type: String,
      enum: ["IGST", "CGST_SGST", "CGST_UTGST", "EXPORT", "NONE"],
      default: "IGST",
    },
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
      address: String,
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
      billingAddress: String,
      addressLine1: String,
      addressLine2: String,
      city: String,
      country: String,
      pincode: String,
      contactPerson: String,
      email: String,
      state: String,
    },

    status: {
      type: String,
      enum: ["DRAFT", "ISSUED", "CANCELLED"],
      default: "DRAFT",
    },
    issuedAt: Date,
    issuedBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancelledAt: Date,
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancellationReason: String,
    cancellationNote: String,

    terms: String,
    notes: String,
    showInclusiveTaxNote: { type: Boolean, default: false },

    isDemo: { type: Boolean, default: false, index: true },

    creditNoteDate: { type: Date, required: true, default: () => new Date() },
    pdfUrl: String,

    irn: String,
    irnGeneratedAt: Date,
    qrCodeData: String,
    ackNo: String,
    ackDate: Date,

    generatedAt: { type: Date, default: Date.now },
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

CreditNoteSchema.index({ workspaceId: 1, status: 1 });
CreditNoteSchema.index({ workspaceId: 1, generatedAt: -1 });
CreditNoteSchema.index({ originalInvoiceId: 1, status: 1 });

CreditNoteSchema.pre("save", async function (next) {
  try {
    if (!this.isNew || this.creditNoteNo) return next();

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const fyStartYear = month >= 4 ? year : year - 1;

    // Mirrors Invoice.ts's numbering branch exactly, keyed off the SAME
    // issuer GSTIN the credit note already inherited (verbatim, never
    // re-resolved) from its parent invoice — see routes/creditNotes.ts. A
    // credit note against a default-series invoice lands on the bare
    // credit-note series; a credit note against a per-GSTIN-series invoice
    // lands on that same GSTIN's own credit-note series.
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
      period = String(fyStartYear);
      counterKey = `creditnote:FY${fyStartYear}`;
    } else if (cadence === "monthly") {
      period = `${year}${String(month).padStart(2, "0")}`;
      counterKey = `creditnote:${period}:${gstin}`;
    } else {
      period = String(fyStartYear);
      counterKey = `creditnote:FY${fyStartYear}:${gstin}`;
    }

    const counter = await Counter.findByIdAndUpdate(
      counterKey,
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
    const nextSeq = counter!.seq;

    this.creditNoteNo = isDefaultSeries
      ? `CN-${period}${String(nextSeq).padStart(4, "0")}`
      : `CN-${prefix}${period}${String(nextSeq).padStart(4, "0")}`;
    next();
  } catch (err) {
    next(err as Error);
  }
});

export default model<ICreditNote>("CreditNote", CreditNoteSchema);
