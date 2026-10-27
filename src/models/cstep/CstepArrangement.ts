// apps/backend/src/models/cstep/CstepArrangement.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepArrangement
 * ----------------
 * CSTEP Travel & Claim Portal — Step 3 (arrangement stage). One row per
 * service the Official user (Travel Administrator) arranges against an
 * APPROVED request, while that request is ARRANGING. A SEPARATE record
 * from CstepTravelRequest — the traveller's original request is NEVER
 * overwritten; this model only ever ADDS rows alongside it.
 *
 * source:
 *   - "REQUESTED": seeded from the traveller's own form fields when the
 *     Official first opens the request for arranging (see routes/cstep.ts's
 *     POST /requests/:id/start-arranging) — requestedType is set, and
 *     arrangedType defaults to the same value (the Official can still pick
 *     a different arrangedType, e.g. Flight requested but Train arranged;
 *     requestedType is never changed after seeding — only what's shown
 *     alongside it, arrangedType, can differ).
 *   - "ADDED": created directly by the Official for something not on the
 *     traveller's original form (Forex, Stationery, etc.) — requestedType
 *     is never set for these.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as every
 * other CSTEP model.
 */

export const CSTEP_SERVICE_TYPES = [
  "FLIGHT",
  "HOTEL",
  "CAB",
  "TRAIN",
  "BUS",
  "VISA",
  "FOREX",
  "STATIONERY",
  "OTHER",
] as const;
export type CstepServiceType = (typeof CSTEP_SERVICE_TYPES)[number];

export type CstepArrangementSource = "REQUESTED" | "ADDED";
export type CstepArrangementStatus = "PENDING" | "ARRANGED";

// Amount + currency addition — LIVE exchange-rate pre-fill, manual
// override, frozen INR. "LIVE" | "MANUAL" record which one actually
// produced the stored exchangeRate; null/absent means no rate has been set
// yet (or currency is INR, where a rate isn't meaningful — see routes/
// cstep.ts's computeArrangementAmountFields, which forces rate=1 there).
export type CstepRateSource = "LIVE" | "MANUAL";

// Vendor + payment addition. paymentStatus is deliberately a separate field
// from `status` (PENDING | ARRANGED is the Official's arranging progress;
// this is whether the vendor has been paid) so the two never read as
// "Pending / Pending". MANUAL = set from the request page; IMPORT = a
// Finance payment sheet (paymentBatchId names that upload).
export const CSTEP_PAYMENT_STATUSES = ["UNPAID", "PAID"] as const;
export type CstepPaymentStatus = (typeof CSTEP_PAYMENT_STATUSES)[number];
export type CstepPaymentSource = "MANUAL" | "IMPORT";

/** Cleanup #4 — who added an ADDED line: the workspace Travel Desk (grant
 * holder), this traveller's assigned Official, or a CSTEP Admin acting as an
 * override (routes/cstep.ts arrangerRole). Lines added before it was
 * stamped have none; the request detail derives it from createdBy. */
export const CSTEP_ARRANGER_ROLES = ["TRAVEL_DESK", "OFFICIAL", "ADMIN"] as const;
export type CstepArrangerRole = (typeof CSTEP_ARRANGER_ROLES)[number];

/** Request statuses from ARRANGING onwards — where an arrangement line's
 * vendor can be paid (by hand on the request page — the Official at the
 * arrange step, or Finance/Admin — or by the Finance payment import), and
 * where the Vendor payments list and its export look. A line still needs a
 * vendor before it can be paid. */
export const CSTEP_VENDOR_PAYABLE_STATUSES = [
  "ARRANGING",
  "ARRANGED",
  "REPORT_PENDING",
  "REPORT_UNDER_APPROVAL",
  "REPORT_SUBMITTED",
  "TRANSFERRED_TO_FINANCE",
  "SETTLED",
  "REIMBURSED",
] as const;

/** Why a line can't be paid or go out to Tally yet — it carries no usable
 * INR amount — or null when amountInr is a positive number. A foreign
 * amount with no exchange rate never computed one, so it says that. */
export function arrangementAmountGap(line: { amountInr?: number | null; amount?: number | null; currency?: string | null }): string | null {
  if (Number(line.amountInr) > 0) return null;
  const currency = String(line.currency || "INR").toUpperCase();
  if (currency !== "INR" && Number(line.amount) > 0) return `has an amount in ${currency} but no exchange rate`;
  return "has no amount";
}

export interface ICstepArrangement extends Document {
  workspaceId: mongoose.Types.ObjectId;
  requestId: mongoose.Types.ObjectId; // ref CstepTravelRequest

  source: CstepArrangementSource;
  requestedType?: CstepServiceType; // set only for source: "REQUESTED" — never edited after seeding
  arrangedType: CstepServiceType; // what the Official actually arranged; may differ from requestedType
  details?: string; // free-text, manual entry

  // Amount + currency (additive, all optional — a row with no amount saves
  // fine). exchangeRate is INR per 1 unit of `currency` (always 1 for
  // INR). amountInr is FROZEN at write time (amount × exchangeRate,
  // computed once by routes/cstep.ts's PATCH/POST handlers) — it is never
  // recomputed on read, even if live rates move later. Feeds the Step 5
  // official-paid settlement later (not built yet).
  currency?: string; // ISO 3-letter code, default "INR"
  amount?: number;
  exchangeRate?: number; // INR per 1 unit of `currency`; 1 for INR
  rateDate?: string; // "YYYY-MM-DD" — date the rate is as-of (live fetch date, or entry date for manual)
  amountInr?: number; // frozen = amount × exchangeRate
  rateSource?: CstepRateSource;

  status: CstepArrangementStatus;

  // Vendor — chosen while ARRANGING; code + name are a snapshot taken at
  // write time, so a later rename in the Vendor Master never rewrites what
  // this row (or the Travel Register) says was booked.
  vendorId?: mongoose.Types.ObjectId; // ref CstepVendor
  vendorCode?: string;
  vendorName?: string;

  // Payment to that vendor — Finance/Admin, from ARRANGED onwards.
  paymentStatus: CstepPaymentStatus;
  paidAt?: Date;
  paidBy?: mongoose.Types.ObjectId; // ref User
  paymentRef?: string; // UTR / cheque no.
  paymentSource?: CstepPaymentSource;
  paymentBatchId?: mongoose.Types.ObjectId;
  vendorInvoiceNo?: string; // the vendor's bill no. — optional, captured on mark-paid

  // Tally journal voucher number (TALLY series), issued the first time the
  // paid line goes out in an "Export to Tally" sheet and reused after.
  tallyVoucherNo?: number;

  /** P1 — the booking document(s) the Travel Desk attached to this service
   * (e-ticket, hotel folio, cab voucher…), ref CstepAttachment. The booked
   * report leg linked to this line (CstepReportLeg.arrangementId) and its
   * ARRANGEMENT settlement line read them from here, live — never copied —
   * so a voucher attached after the report started still shows. */
  attachmentIds?: mongoose.Types.ObjectId[];

  createdBy: mongoose.Types.ObjectId; // ref User — who created this row (seeding, or the Official who added it)
  addedByRole?: CstepArrangerRole; // source: "ADDED" only — see CSTEP_ARRANGER_ROLES
  arrangedBy?: mongoose.Types.ObjectId; // ref User — who last marked it ARRANGED
  arrangedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const CstepArrangementSchema = new Schema<ICstepArrangement>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", required: true, index: true },

    source: { type: String, enum: ["REQUESTED", "ADDED"], required: true },
    requestedType: { type: String, enum: CSTEP_SERVICE_TYPES },
    arrangedType: { type: String, enum: CSTEP_SERVICE_TYPES, required: true },
    details: { type: String, trim: true },

    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    amount: { type: Number },
    exchangeRate: { type: Number },
    rateDate: { type: String },
    amountInr: { type: Number },
    rateSource: { type: String, enum: ["LIVE", "MANUAL"] },

    status: { type: String, enum: ["PENDING", "ARRANGED"], default: "PENDING", index: true },

    vendorId: { type: Schema.Types.ObjectId, ref: "CstepVendor" },
    vendorCode: { type: String, trim: true },
    vendorName: { type: String, trim: true },

    paymentStatus: { type: String, enum: CSTEP_PAYMENT_STATUSES, default: "UNPAID" },
    paidAt: { type: Date },
    paidBy: { type: Schema.Types.ObjectId, ref: "User" },
    paymentRef: { type: String, trim: true },
    paymentSource: { type: String, enum: ["MANUAL", "IMPORT"] },
    paymentBatchId: { type: Schema.Types.ObjectId },
    vendorInvoiceNo: { type: String, trim: true },

    tallyVoucherNo: { type: Number },

    attachmentIds: { type: [{ type: Schema.Types.ObjectId, ref: "CstepAttachment" }], default: undefined },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    addedByRole: { type: String, enum: CSTEP_ARRANGER_ROLES },
    arrangedBy: { type: Schema.Types.ObjectId, ref: "User" },
    arrangedAt: { type: Date },
  },
  { timestamps: true },
);

CstepArrangementSchema.index({ workspaceId: 1, vendorId: 1, paymentStatus: 1 });

CstepArrangementSchema.plugin(workspaceScopePlugin);

const CstepArrangement: Model<ICstepArrangement> =
  (mongoose.models.CstepArrangement as Model<ICstepArrangement>) ||
  mongoose.model<ICstepArrangement>("CstepArrangement", CstepArrangementSchema);

export default CstepArrangement;
