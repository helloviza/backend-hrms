import { Schema, model, type Types } from "mongoose";

// An invoice taken out of the active `invoices` collection by "Cancel for
// reissue" or "Delete invoice" (services/invoiceReissue.ts). The full raw
// document is kept in `snapshot` — Invoice.ts promises the document is
// retained (s.36), and this is where it is retained once it stops being an
// active invoice. Rows are never updated except to fill reissuedAsInvoiceId
// when the reserved number is reused.
//
// The snapshot holds the client's PII exactly as the invoice did; a future
// consumer-erasure pass must cover this collection too
// (docs/audits/invoice-reissue-audit.md §d).

export type ArchiveMode = "REISSUE" | "DELETE";

export interface IArchivedInvoice {
  _id: Types.ObjectId;
  invoiceId: Types.ObjectId; // the original Invoice._id
  invoiceNo: string;
  workspaceId: Types.ObjectId; // copied from the invoice (same mixed id-space)
  bookingIds: Types.ObjectId[];
  status: string; // the invoice's status when it was archived
  invoiceDate?: Date;
  grandTotal?: number;
  issuerGstin: string;
  clientName: string;
  snapshot: Record<string, unknown>;
  mode: ArchiveMode;
  reason: string;
  archivedAt: Date;
  archivedBy: Types.ObjectId;
  archivedByEmail?: string;
  // S3 copy of the invoice PDF taken before the number could be re-rendered
  // over invoices/<invoiceNo>.pdf. Null when no PDF had ever been stored.
  pdfArchiveKey?: string | null;
  reservationId?: Types.ObjectId | null;
  reissuedAsInvoiceId?: Types.ObjectId | null;
  reissuedAt?: Date | null;
  // Post-commit steps (payment-link cancel, partner-share clear, loyalty
  // update — services/invoiceReissue.ts runArchiveSideEffects): the failures
  // still outstanding, and every attempt ever made.
  sideEffectFailures?: Array<{ step: string; label: string; error: string; at: Date }>;
  sideEffectLog?: Array<{ step: string; ok: boolean; error?: string; at: Date; by?: string }>;
}

const ArchivedInvoiceSchema = new Schema<IArchivedInvoice>(
  {
    invoiceId: { type: Schema.Types.ObjectId, required: true, index: true },
    invoiceNo: { type: String, required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true },
    bookingIds: [{ type: Schema.Types.ObjectId }],
    status: { type: String, required: true },
    invoiceDate: Date,
    grandTotal: Number,
    issuerGstin: { type: String, default: "" },
    clientName: { type: String, default: "" },
    snapshot: { type: Schema.Types.Mixed, required: true },
    mode: { type: String, enum: ["REISSUE", "DELETE"], required: true },
    reason: { type: String, required: true },
    archivedAt: { type: Date, required: true },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedByEmail: String,
    pdfArchiveKey: { type: String, default: null },
    reservationId: { type: Schema.Types.ObjectId, default: null },
    reissuedAsInvoiceId: { type: Schema.Types.ObjectId, default: null },
    reissuedAt: { type: Date, default: null },
    sideEffectFailures: { type: Schema.Types.Mixed, default: () => [] },
    sideEffectLog: { type: Schema.Types.Mixed, default: () => [] },
  },
  { collection: "archived_invoices", minimize: false },
);

ArchivedInvoiceSchema.index({ archivedAt: -1 });

export default model<IArchivedInvoice>("ArchivedInvoice", ArchivedInvoiceSchema);
