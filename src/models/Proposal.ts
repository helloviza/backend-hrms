// apps/backend/src/models/Proposal.ts
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Proposal workflow:
 * - Booking/Proposal team creates DRAFT proposal for an approved ApprovalRequest
 * - Submit -> SUBMITTED (goes to L2 + L0 approvals)
 * - Both approve -> APPROVED (moves to booking execution)
 * - Decline -> DECLINED (revision required)
 * - Expire -> EXPIRED (optional/manual later)
 */

export type ProposalStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "APPROVED"
  | "DECLINED"
  | "EXPIRED";
export type ApprovalDecision = "PENDING" | "APPROVED" | "DECLINED";
export type BookingStatus = "NOT_STARTED" | "IN_PROGRESS" | "DONE" | "CANCELLED";

export type CustomerProposalAction = "accept" | "reject" | "needs_changes";

export type ProposalLineItem = {
  itemIndex: number; // 1-based index matching cart item order
  category: string; // "flight" | "hotel" | ...
  title: string;

  qty: number;
  unitPrice: number;
  totalPrice: number;
  currency: string; // "INR"

  notes?: string;

  // Admin/booking team disposition for this line
  dispositionCode?: string;
  dispositionLabel?: string;
};

export type ProposalOption = {
  optionNo: number; // 1,2,3...
  title: string; // "Option 1"
  vendor?: string;
  validityTill?: Date | null;

  currency: string;
  totalAmount: number;

  notes?: string;

  lineItems: ProposalLineItem[];

  // attachments (proposal PDFs etc)
  attachments: string[];
};

export type ProposalApprovalInfo = {
  decision: ApprovalDecision;
  at?: Date | null;
  byEmail?: string;
  byName?: string;
  comment?: string;
};

export type ProposalApprovals = {
  l2: ProposalApprovalInfo;
  l0: ProposalApprovalInfo;
};

export type ProposalBooking = {
  status: BookingStatus;

  // booking docs (tickets/vouchers/invoice PDFs etc)
  attachments: string[];

  // customer-facing booking amount
  bookingAmount?: number;

  // admin-only cost/vendor price
  actualBookingPrice?: number;

  doneAt?: Date | null;
  doneByEmail?: string;
  doneByName?: string;

  note?: string;
};

export type ProposalCustomer = {
  action: CustomerProposalAction | null;
  note?: string;
  at?: Date | null;
  byEmail?: string;
  byName?: string;
};

export type ProposalHistoryEntry = {
  action: string;
  at: Date;
  byEmail?: string;
  byName?: string;
  note?: string;
};

/* ───────────────────────── Sub Schemas ───────────────────────── */

const proposalLineItemSchema = new Schema<ProposalLineItem>(
  {
    itemIndex: { type: Number, required: true },
    category: { type: String, required: true, default: "other" },
    title: { type: String, required: true, default: "" },

    qty: { type: Number, required: true, default: 1 },
    unitPrice: { type: Number, required: true, default: 0 },
    totalPrice: { type: Number, required: true, default: 0 },
    currency: { type: String, required: true, default: "INR" },

    notes: { type: String, default: "" },

    dispositionCode: { type: String, default: "" },
    dispositionLabel: { type: String, default: "" },
  },
  { _id: false }
);

const proposalOptionSchema = new Schema<ProposalOption>(
  {
    optionNo: { type: Number, required: true, default: 1 },
    title: { type: String, required: true, default: "Option 1" },
    vendor: { type: String, default: "" },
    validityTill: { type: Date, default: null },

    currency: { type: String, required: true, default: "INR" },
    totalAmount: { type: Number, required: true, default: 0 },

    notes: { type: String, default: "" },

    lineItems: { type: [proposalLineItemSchema], required: true, default: [] },

    attachments: { type: [String], required: true, default: [] },
  },
  { _id: false }
);

const approvalInfoSchema = new Schema<ProposalApprovalInfo>(
  {
    decision: {
      type: String,
      enum: ["PENDING", "APPROVED", "DECLINED"],
      required: true,
      default: "PENDING",
    },
    at: { type: Date, default: null },
    byEmail: { type: String, default: "" },
    byName: { type: String, default: "" },
    comment: { type: String, default: "" },
  },
  { _id: false }
);

const bookingSchema = new Schema<ProposalBooking>(
  {
    status: {
      type: String,
      enum: ["NOT_STARTED", "IN_PROGRESS", "DONE", "CANCELLED"],
      required: true,
      default: "NOT_STARTED",
    },
    attachments: { type: [String], required: true, default: [] },

    bookingAmount: { type: Number },
    actualBookingPrice: { type: Number },

    doneAt: { type: Date, default: null },
    doneByEmail: { type: String, default: "" },
    doneByName: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const customerSchema = new Schema<ProposalCustomer>(
  {
    action: {
      type: String,
      enum: ["accept", "reject", "needs_changes"],
      default: null,
    },
    note: { type: String, default: "" },
    at: { type: Date, default: null },
    byEmail: { type: String, default: "" },
    byName: { type: String, default: "" },
  },
  { _id: false }
);

const historySchema = new Schema<ProposalHistoryEntry>(
  {
    action: { type: String, required: true },
    at: { type: Date, required: true, default: () => new Date() },
    byEmail: { type: String, default: "" },
    byName: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { _id: false }
);

/* ───────────────────────── Main Schema ───────────────────────── */

const proposalSchema = new Schema(
  {
    requestId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
      ref: "ApprovalRequest",
    },

    // versioning: latest is highest version per requestId
    version: { type: Number, required: true, default: 1, index: true },

    status: {
      type: String,
      enum: ["DRAFT", "SUBMITTED", "APPROVED", "DECLINED", "EXPIRED"],
      required: true,
      default: "DRAFT",
      index: true,
    },

    currency: { type: String, required: true, default: "INR" },
    totalAmount: { type: Number, required: true, default: 0 },

    options: { type: [proposalOptionSchema], required: true, default: [] },

    approvals: {
      l2: {
        type: approvalInfoSchema,
        required: true,
        default: () => ({ decision: "PENDING" }),
      },
      l0: {
        type: approvalInfoSchema,
        required: true,
        default: () => ({ decision: "PENDING" }),
      },
    },

    booking: {
      type: bookingSchema,
      required: true,
      default: () => ({ status: "NOT_STARTED", attachments: [] }),
    },

    // ✅ Needed because routes/proposals.ts writes doc.customer.*
    customer: {
      type: customerSchema,
      required: true,
      default: () => ({ action: null, note: "", at: null, byEmail: "", byName: "" }),
    },

    history: { type: [historySchema], required: true, default: [] },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

/* ───────────────────────── Indexes ───────────────────────── */

// Ensure only one proposal version per requestId
proposalSchema.index({ requestId: 1, version: 1 }, { unique: true });

// Helpful for queues
proposalSchema.index({ status: 1, updatedAt: -1 });
proposalSchema.index({ "approvals.l2.decision": 1, status: 1, updatedAt: -1 });
proposalSchema.index({ "approvals.l0.decision": 1, status: 1, updatedAt: -1 });
proposalSchema.index({ "booking.status": 1, status: 1, updatedAt: -1 });

/* ───────────────────────── Guard rails ─────────────────────────
 * Keep totals consistent if dev forgets.
 * We never throw here; we self-heal.
 */
proposalSchema.pre("save", function (next) {
  try {
    const doc: any = this;

    doc.options = Array.isArray(doc.options) ? doc.options : [];

    if (!Number.isFinite(Number(doc.totalAmount))) doc.totalAmount = 0;

    for (const opt of doc.options) {
      opt.lineItems = Array.isArray(opt.lineItems) ? opt.lineItems : [];

      for (const li of opt.lineItems) {
        const qty = Number(li.qty || 1);
        const unit = Number(li.unitPrice || 0);

        li.qty = Number.isFinite(qty) && qty > 0 ? qty : 1;
        li.unitPrice = Number.isFinite(unit) ? unit : 0;
        li.totalPrice = li.qty * li.unitPrice;

        li.currency = String(li.currency || opt.currency || doc.currency || "INR");
        li.category = String(li.category || "other");
        li.title = String(li.title || "");
      }

      const optTotal = opt.lineItems.reduce(
        (s: number, li: any) => s + (Number(li.totalPrice) || 0),
        0
      );

      opt.totalAmount = Number.isFinite(optTotal) ? optTotal : 0;
      opt.currency = String(opt.currency || doc.currency || "INR");
      opt.attachments = Array.isArray(opt.attachments) ? opt.attachments : [];
    }

    // ✅ Always keep proposal total aligned with Option-1 (default presented option)
    const option1 =
      doc.options.find((o: any) => Number(o.optionNo || 1) === 1) || doc.options[0];

    doc.totalAmount = option1 ? Number(option1.totalAmount || 0) : 0;

    // booking safety
    doc.booking = doc.booking || {};
    doc.booking.attachments = Array.isArray(doc.booking.attachments)
      ? doc.booking.attachments
      : [];

    const allowedBooking = new Set(["NOT_STARTED", "IN_PROGRESS", "DONE", "CANCELLED"]);
    doc.booking.status = allowedBooking.has(String(doc.booking.status))
      ? String(doc.booking.status)
      : "NOT_STARTED";

    // approvals safety
    doc.approvals = doc.approvals || {};
    doc.approvals.l2 = doc.approvals.l2 || { decision: "PENDING" };
    doc.approvals.l0 = doc.approvals.l0 || { decision: "PENDING" };

    const allowedDecision = new Set(["PENDING", "APPROVED", "DECLINED"]);
    doc.approvals.l2.decision = allowedDecision.has(String(doc.approvals.l2.decision))
      ? String(doc.approvals.l2.decision)
      : "PENDING";
    doc.approvals.l0.decision = allowedDecision.has(String(doc.approvals.l0.decision))
      ? String(doc.approvals.l0.decision)
      : "PENDING";

    // customer safety
    doc.customer = doc.customer || { action: null, note: "", at: null, byEmail: "", byName: "" };
    const allowedCustomer = new Set(["accept", "reject", "needs_changes"]);
    const act = doc.customer.action == null ? null : String(doc.customer.action);
    doc.customer.action = act === null ? null : (allowedCustomer.has(act) ? act : null);

    next();
  } catch {
    next();
  }
});

/* ───────────────────────── Model Export ───────────────────────── */

export type ProposalDoc = InferSchemaType<typeof proposalSchema> & mongoose.Document;

const ProposalModel =
  (mongoose.models.Proposal as Model<ProposalDoc>) ||
  mongoose.model<ProposalDoc>("Proposal", proposalSchema);

export default ProposalModel;
