// apps/backend/src/models/PaymentRequest.ts
//
// One amount to collect from a customer, split into 1–3 fixed-amount Razorpay
// Payment Links on the Plumtrips (B2B) account. The subject is either a
// ManualBooking (before booking) or an Invoice (status SENT). Audit:
// docs/audits/payment-links-audit.md §8.2.
//
// STATUS ONLY. Nothing here, and nothing that writes it, changes a booking's
// or an invoice's status: the RM does that on the existing screens.
//
// ── MONEY ────────────────────────────────────────────────────────────────
// Integer paise everywhere. `basePaise` is the link's share of the target
// (the booking / invoice amount); `pgChargePaise` is the PG charge added on
// top, computed once at creation and never re-derived. It is NOT part of the
// booking invoice. totalPaise = basePaise + pgChargePaise is what Razorpay
// collects.
//
// ── THE SUM RULE ─────────────────────────────────────────────────────────
// Every link that is live (not CANCELLED / EXPIRED), plus every cancelled /
// expired link not yet replaced, adds up to targetBasePaise exactly. A
// replacement carries exactly the base of the link it replaces.
//
// ── TENANT IDS ───────────────────────────────────────────────────────────
// customerId is always the Customer._id (ManualBooking.workspaceId's space);
// invoiceWorkspaceId is the CustomerWorkspace._id (Invoice.workspaceId's
// space, which falls back to the Customer._id when no workspace exists).
// No workspaceScopePlugin: it would add a required CustomerWorkspace-ref
// workspaceId and auto-filter on it, which is the id-space mix-up this record
// must not make. Routes scope explicitly on BOTH fields.
//
// ── INDEXES ON LINK IDS ──────────────────────────────────────────────────
// razorpayLinkId / razorpayPaymentId are set only after Razorpay answers, so
// some links carry them and some don't. A unique SPARSE index on the array
// path ignores the links without the field; a partial index does not (it
// indexes the missing ones as null and rejects the second document) — checked
// against mongod. So: sparse, and these fields are never written as null.
// Default import for mongoose.models: under Node's native ESM loader (prod runs
// dist/ with plain node) `models` is not a named export of the CommonJS
// mongoose package, and importing it by name crashes the server at boot.
import mongoose, { Schema, model, type Document, type Model, type Types } from "mongoose";

export const PAYMENT_REQUEST_SUBJECTS = ["BOOKING", "INVOICE"] as const;
export type PaymentRequestSubject = (typeof PAYMENT_REQUEST_SUBJECTS)[number];

export const PAYMENT_REQUEST_STATUSES = ["OPEN", "PARTLY_PAID", "PAID", "CANCELLED"] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

/** FAILED_CREATE = not (yet) a link on Razorpay. Rows are written in this state
 *  before the Razorpay call, so a crash mid-creation leaves retryable links. */
export const PAYMENT_LINK_STATUSES = ["CREATED", "PAID", "EXPIRED", "CANCELLED", "FAILED_CREATE"] as const;
export type PaymentLinkStatus = (typeof PAYMENT_LINK_STATUSES)[number];

export interface IPaymentLink {
  _id: Types.ObjectId;
  seq: number;
  basePaise: number;
  pgChargePaise: number;
  totalPaise: number;
  referenceId: string;
  razorpayLinkId?: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  shortUrl?: string;
  expireBy: Date;
  status: PaymentLinkStatus;
  createError?: string;
  createAttempts: number;
  paidAt?: Date;
  paidAmountPaise?: number;
  method?: string;
  cancelledAt?: Date;
  expiredAt?: Date;
  replacesLinkId?: Types.ObjectId;
  emailOutboxIds: Types.ObjectId[];
  createdAt?: Date;
}

export interface IPaymentRequestHistory {
  at: Date;
  by: string;
  action: string;
  detail?: Record<string, unknown>;
}

export interface IPaymentRequest extends Document {
  subject: PaymentRequestSubject;
  bookingIds: Types.ObjectId[];
  invoiceId?: Types.ObjectId;
  requestId?: Types.ObjectId;
  /** The subject's own id (booking or invoice) — the one-open-request key. */
  subjectId: Types.ObjectId;
  /** True while status is OPEN / PARTLY_PAID — the partial unique index keys on it. */
  isOpen: boolean;
  customerId: Types.ObjectId;
  invoiceWorkspaceId?: Types.ObjectId;
  mid: "B2B";
  subjectRef: string;
  targetBasePaise: number;
  targetSource: { kind: "BOOKING_GRAND_TOTAL" | "INVOICE_GRAND_TOTAL"; valueAtCreation: number };
  splitPattern: string;
  pgChargePct: number;
  recipient: { name?: string; email?: string; phone?: string };
  status: PaymentRequestStatus;
  links: Types.DocumentArray<IPaymentLink & Document>;
  history: IPaymentRequestHistory[];
  createdBy: string;
  createdByEmail?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentLinkSchema = new Schema(
  {
    seq: { type: Number, required: true },
    basePaise: { type: Number, required: true, min: 100 },
    pgChargePaise: { type: Number, required: true, min: 0 },
    totalPaise: { type: Number, required: true, min: 100 },
    referenceId: { type: String, required: true, maxlength: 40 },
    razorpayLinkId: { type: String },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    shortUrl: { type: String },
    expireBy: { type: Date, required: true },
    status: { type: String, enum: PAYMENT_LINK_STATUSES, required: true },
    createError: { type: String },
    createAttempts: { type: Number, default: 0 },
    paidAt: { type: Date },
    paidAmountPaise: { type: Number },
    method: { type: String },
    cancelledAt: { type: Date },
    expiredAt: { type: Date },
    replacesLinkId: { type: Schema.Types.ObjectId },
    emailOutboxIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const PaymentRequestSchema = new Schema<IPaymentRequest>(
  {
    subject: { type: String, enum: PAYMENT_REQUEST_SUBJECTS, required: true },
    bookingIds: { type: [Schema.Types.ObjectId], ref: "ManualBooking", default: [], index: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "ApprovalRequest" },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    isOpen: { type: Boolean, required: true, default: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    invoiceWorkspaceId: { type: Schema.Types.ObjectId, index: true },
    mid: { type: String, enum: ["B2B"], default: "B2B", required: true },
    subjectRef: { type: String, default: "" },
    targetBasePaise: { type: Number, required: true, min: 100 },
    targetSource: {
      kind: { type: String, enum: ["BOOKING_GRAND_TOTAL", "INVOICE_GRAND_TOTAL"], required: true },
      valueAtCreation: { type: Number, required: true },
    },
    splitPattern: { type: String, required: true },
    pgChargePct: { type: Number, required: true, min: 0, max: 10 },
    recipient: {
      name: { type: String },
      email: { type: String },
      phone: { type: String },
    },
    status: { type: String, enum: PAYMENT_REQUEST_STATUSES, required: true, default: "OPEN" },
    links: { type: [PaymentLinkSchema], default: [] },
    history: {
      type: [
        new Schema(
          {
            at: { type: Date, required: true },
            by: { type: String, required: true },
            action: { type: String, required: true },
            detail: { type: Schema.Types.Mixed },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    createdBy: { type: String, required: true },
    createdByEmail: { type: String },
  },
  { timestamps: true, optimisticConcurrency: true },
);

/* One open request per subject. Becomes free again once the request is PAID
 * or CANCELLED (isOpen false). */
PaymentRequestSchema.index(
  { subject: 1, subjectId: 1 },
  { unique: true, partialFilterExpression: { isOpen: true }, name: "one_open_request_per_subject" },
);
PaymentRequestSchema.index({ "links.referenceId": 1 }, { unique: true, name: "link_reference_unique" });
PaymentRequestSchema.index({ "links.razorpayLinkId": 1 }, { unique: true, sparse: true, name: "link_razorpay_id_unique" });
PaymentRequestSchema.index({ "links.razorpayPaymentId": 1 }, { unique: true, sparse: true, name: "link_payment_id_unique" });
PaymentRequestSchema.index({ "links.razorpayOrderId": 1 }, { sparse: true, name: "link_order_id" });

const PaymentRequest: Model<IPaymentRequest> =
  (mongoose.models.PaymentRequest as Model<IPaymentRequest>) || model<IPaymentRequest>("PaymentRequest", PaymentRequestSchema);

export default PaymentRequest;
