import { Schema, model, type Types } from "mongoose";

// An invoice number held back by "Cancel for reissue" so the corrected
// invoice can be issued under it again (services/invoiceReissue.ts). The
// Counter is never touched: a reused number is preset on the new invoice,
// and Invoice.ts's pre-save hook skips numbering when invoiceNo is set.
//
// SERIES. A number belongs to exactly one series, recorded here as it was
// at archive time:
//   issuerGstin   — the GSTIN the archived invoice was issued under
//   seriesPrefix  — "" for the default (bare) series, else the profile prefix
//   cadence       — annual | monthly (default series is always annual)
//   period        — "2026" (FY start year) or "202607" (YYYYMM)
//   counterKey    — the Counter _id the number was drawn from
// Reuse requires the same issuer GSTIN and an invoice date inside `period`
// (decision D1), checked server-side on every generate.
//
// One RESERVED row per number (partial unique index). A number may be
// reserved again after it was consumed and the reissue was itself archived,
// so the index must not cover CONSUMED / RELEASED rows.

export type ReservationStatus = "RESERVED" | "CONSUMED" | "RELEASED";

export interface IInvoiceNumberReservation {
  _id: Types.ObjectId;
  number: string;
  counterKey: string;
  issuerGstin: string;
  seriesPrefix: string;
  cadence: "annual" | "monthly";
  period: string;
  workspaceId: Types.ObjectId; // the archived invoice's workspaceId (tenant scope)
  bookingIds: Types.ObjectId[];
  archivedInvoiceId: Types.ObjectId;
  archivedInvoiceDate?: Date;
  status: ReservationStatus;
  createdAt: Date;
  createdBy: Types.ObjectId;
  consumedAt?: Date | null;
  consumedBy?: Types.ObjectId | null;
  consumedInvoiceId?: Types.ObjectId | null;
  releasedAt?: Date | null;
  releasedBy?: Types.ObjectId | null;
  releaseReason?: string | null;
}

const InvoiceNumberReservationSchema = new Schema<IInvoiceNumberReservation>(
  {
    number: { type: String, required: true },
    counterKey: { type: String, required: true },
    issuerGstin: { type: String, default: "" },
    seriesPrefix: { type: String, default: "" },
    cadence: { type: String, enum: ["annual", "monthly"], required: true },
    period: { type: String, required: true },
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true },
    bookingIds: [{ type: Schema.Types.ObjectId }],
    archivedInvoiceId: { type: Schema.Types.ObjectId, required: true },
    archivedInvoiceDate: Date,
    status: { type: String, enum: ["RESERVED", "CONSUMED", "RELEASED"], required: true, default: "RESERVED" },
    createdAt: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    consumedAt: { type: Date, default: null },
    consumedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    consumedInvoiceId: { type: Schema.Types.ObjectId, default: null },
    releasedAt: { type: Date, default: null },
    releasedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    releaseReason: { type: String, default: null },
  },
  { collection: "invoice_number_reservations" },
);

InvoiceNumberReservationSchema.index(
  { number: 1 },
  { unique: true, partialFilterExpression: { status: "RESERVED" }, name: "number_reserved_unique" },
);
InvoiceNumberReservationSchema.index({ bookingIds: 1, status: 1 });

export default model<IInvoiceNumberReservation>("InvoiceNumberReservation", InvoiceNumberReservationSchema);
