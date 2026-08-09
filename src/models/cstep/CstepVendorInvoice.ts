// apps/backend/src/models/cstep/CstepVendorInvoice.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepVendorInvoice
 * ------------------
 * CSTEP Travel & Claim Portal — the CSTEP-paid stream: invoices billed
 * directly to CSTEP rather than paid by the traveller and claimed back.
 *
 * sbtBookingRef is a plain string, deliberately NOT an ObjectId/ref — a soft
 * pointer at a live SBTBooking without any schema-level FK into that
 * collection (SBTBooking.ts is untouched by this module).
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export type CstepVendorInvoiceMode =
  | "AIR"
  | "RAIL"
  | "CAB"
  | "BUS"
  | "HOTEL"
  | "VISA"
  | "INSURANCE"
  | "REGISTRATION"
  | "TELECOM"
  | "FOREX"
  | "OTHER";

export interface ICstepInvoiceShare {
  claimId?: mongoose.Types.ObjectId; // ref CstepClaim
  splitAmount?: number;
}

export interface ICstepVendorInvoice extends Document {
  workspaceId: mongoose.Types.ObjectId;
  claimId: mongoose.Types.ObjectId; // ref CstepClaim
  vendorId: mongoose.Types.ObjectId; // ref CstepVendor

  invoiceNo: string;
  invoiceDate?: string; // "YYYY-MM-DD"
  amount: number;
  currency: string;
  amountInr: number;
  gst?: number;
  tds?: number;
  mode: CstepVendorInvoiceMode;
  project?: string;

  paymentStatus: "UNPAID" | "PAID";
  source: "MANUAL" | "PLUMTRIPS_IMPORT" | "SCANNED";

  sbtBookingRef?: string; // soft reference — no hard FK to the live SBT model

  sharedWith: ICstepInvoiceShare[]; // multi-traveller invoice splits

  attachmentId?: mongoose.Types.ObjectId; // ref CstepAttachment

  createdBy: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepInvoiceShareSchema = new Schema<ICstepInvoiceShare>(
  {
    claimId: { type: Schema.Types.ObjectId, ref: "CstepClaim" },
    splitAmount: { type: Number },
  },
  { _id: false },
);

const CstepVendorInvoiceSchema = new Schema<ICstepVendorInvoice>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    claimId: { type: Schema.Types.ObjectId, ref: "CstepClaim", required: true, index: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "CstepVendor", required: true, index: true },

    invoiceNo: { type: String, required: true, trim: true },
    invoiceDate: { type: String },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR", uppercase: true },
    amountInr: { type: Number, required: true },
    gst: { type: Number },
    tds: { type: Number },
    mode: {
      type: String,
      enum: ["AIR", "RAIL", "CAB", "BUS", "HOTEL", "VISA", "INSURANCE", "REGISTRATION", "TELECOM", "FOREX", "OTHER"],
      required: true,
    },
    project: { type: String, trim: true },

    paymentStatus: { type: String, enum: ["UNPAID", "PAID"], default: "UNPAID", index: true },
    source: { type: String, enum: ["MANUAL", "PLUMTRIPS_IMPORT", "SCANNED"], required: true },

    sbtBookingRef: { type: String, trim: true, index: true, sparse: true },

    sharedWith: { type: [CstepInvoiceShareSchema], default: [] },

    attachmentId: { type: Schema.Types.ObjectId, ref: "CstepAttachment" },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

CstepVendorInvoiceSchema.plugin(workspaceScopePlugin);

const CstepVendorInvoice =
  (mongoose.models.CstepVendorInvoice as mongoose.Model<ICstepVendorInvoice>) ||
  mongoose.model<ICstepVendorInvoice>("CstepVendorInvoice", CstepVendorInvoiceSchema);

export default CstepVendorInvoice;
