import mongoose, { Schema, model, type Document } from "mongoose";

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

export interface IInvoice extends Document {
  invoiceNo: string;
  workspaceId: Schema.Types.ObjectId;
  billingPeriod?: string;
  bookingIds: Schema.Types.ObjectId[];
  lineItems: IInvoiceLineItem[];
  subtotal: number;
  totalGST: number;
  grandTotal: number;
  supplyType: "IGST" | "CGST_SGST";
  issuerState?: string;
  clientState?: string;
  issuerDetails?: {
    companyName?: string;
    gstin?: string;
    address?: string;
    email?: string;
    phone?: string;
    website?: string;
    state?: string;
  };
  clientDetails?: {
    companyName?: string;
    gstin?: string;
    billingAddress?: string;
    contactPerson?: string;
    email?: string;
    state?: string;
  };
  status: "DRAFT" | "SENT" | "PAID" | "CANCELLED";
  terms?: string;
  notes?: string;
  showInclusiveTaxNote?: boolean;
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
    supplyType: { type: String, enum: ["IGST", "CGST_SGST"], default: "IGST" },
    issuerState: String,
    clientState: String,
    issuerDetails: {
      companyName: String,
      gstin: String,
      address: String,
      email: String,
      phone: String,
      website: String,
      state: String,
    },
    clientDetails: {
      companyName: String,
      gstin: String,
      billingAddress: String,
      contactPerson: String,
      email: String,
      state: String,
    },
    status: { type: String, enum: ["DRAFT", "SENT", "PAID", "CANCELLED"], default: "DRAFT" },
    terms: String,
    notes: String,
    showInclusiveTaxNote: { type: Boolean, default: false },
    invoiceDate: { type: Date, required: true, default: () => new Date() },
    dueDate: Date,
    pdfUrl: String,
    generatedAt: { type: Date, default: Date.now },
    sentAt: Date,
    paidAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

InvoiceSchema.index({ workspaceId: 1, status: 1 });
InvoiceSchema.index({ workspaceId: 1, generatedAt: -1 });

InvoiceSchema.pre("save", async function (next) {
  try {
    console.log('[Invoice pre-save] isNew:', this.isNew);
    console.log('[Invoice pre-save] lineItems type:', typeof this.lineItems);
    console.log('[Invoice pre-save] lineItems isArray:', Array.isArray(this.lineItems));
    console.log('[Invoice pre-save] lineItems[0]:', this.lineItems?.[0]);

    if (!this.isNew || this.invoiceNo) return next();

    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const year = now.getFullYear();
    const fyStartYear = month >= 4 ? year : year - 1;

    const prefix = `INV-${fyStartYear}`; // e.g. "INV-2026"

    const existingCount = await (this.constructor as any).countDocuments({
      invoiceNo: { $regex: `^${prefix}` },
    });

    // One-time offset for FY 2026-27; all subsequent FYs start at 1
    const startNumber = fyStartYear === 2026 ? 40 : 1;
    const sequenceNumber = existingCount + startNumber;
    this.invoiceNo = `${prefix}${String(sequenceNumber).padStart(4, "0")}`;
    // Example: "INV-20260040"

    next();
  } catch (err) {
    next(err as Error);
  }
});

export default model<IInvoice>("Invoice", InvoiceSchema);
