// apps/backend/src/models/ApprovalRequest.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";

/**
 * Legacy fields kept for backward compatibility with current UI/routes
 */
export type ApprovalStatus = "pending" | "approved" | "declined" | "on_hold";
export type AdminState =
  | "pending"
  | "assigned"
  | "in_progress"
  | "done"
  | "on_hold"
  | "cancelled";

/**
 * Lifecycle stage (legacy + workflow marker)
 *
 * NOTE:
 * - You are migrating to a new FSM truth-source, but stage is still used heavily by current UI/routes.
 * - Keep it compatible during transition.
 */
export type ApprovalStage =
  | "REQUEST_RAISED"
  | "REQUEST_APPROVED"
  | "REQUEST_DECLINED"
  | "REQUEST_ON_HOLD"
  | "PROPOSAL_PENDING"
  | "PROPOSAL_SUBMITTED"
  | "PROPOSAL_APPROVED"
  | "PROPOSAL_DECLINED"
  | "BOOKING_IN_PROGRESS"
  | "BOOKING_ON_HOLD"
  | "BOOKING_DONE"
  | "BOOKING_CANCELLED"
  | "COMPLETED"
  | "CANCELLED";

/**
 * ✅ NEW truth-source FSM (parallel tracks)
 */
export type RequestStage =
  | "REQUEST_SUBMITTED"
  | "AWAITING_L2_REQUEST_APPROVAL"
  | "REQUEST_APPROVED_BY_L2"
  | "REQUEST_DECLINED_BY_L2";

export type ProposalStage =
  | "PROPOSAL_NONE"
  | "PROPOSAL_POSTED"
  | "AWAITING_PROPOSAL_APPROVAL_L2_L0"
  | "PROPOSAL_APPROVED"
  | "PROPOSAL_DECLINED"
  | "PROPOSAL_EXPIRED";

export type BookingStage =
  | "BOOKING_NOT_STARTED"
  | "BOOKING_IN_PROGRESS"
  | "BOOKING_DONE"
  | "COMPLETED"
  | "CANCELLED";

export interface ApprovalFSM {
  current:
    | RequestStage
    | ProposalStage
    | BookingStage
    | "REQUEST_DECLINED_BY_L2"
    | "PROPOSAL_DECLINED"
    | "PROPOSAL_EXPIRED"
    | "CANCELLED"
    | "COMPLETED";

  request: { stage: RequestStage };
  proposal: { stage: ProposalStage };
  booking: { stage: BookingStage };

  updatedAt?: Date;
  version?: number;
}

export interface ApprovalCartItem {
  type: string; // flight/hotel/visa/...
  title?: string;
  description?: string;
  qty?: number;
  price?: number;
  meta?: any;
}

export interface ApprovalHistoryItem {
  action: string;
  at?: Date;

  /**
   * Existing field you use across routes.
   * Keep it for backward compatibility (string id/email etc).
   */
  by: string;

  comment?: string;
  userName?: string;
  userEmail?: string;
}

export interface ApprovalRequestDocument extends Document {
  ticketId?: string;

  customerId: string;
  customerName?: string;
  customerEmailDomain?: string;

  frontlinerId: string;
  frontlinerEmail: string;
  frontlinerName?: string;

  managerId?: string;
  managerEmail: string;
  managerName?: string;

  status: ApprovalStatus;
  adminState?: AdminState;

  /**
   * ✅ legacy workflow marker
   */
  stage: ApprovalStage;

  /**
   * ✅ NEW FSM truth-source (kept in parallel with legacy stage during migration)
   */
  fsm?: ApprovalFSM;

  comments?: string;
  cartItems: ApprovalCartItem[];

  approvedByName?: string;
  approvedByEmail?: string;

  history?: ApprovalHistoryItem[];
  meta?: any;

  // pricing (admin write; viewer sanitization happens in routes)
  bookingAmount?: number; // customer-facing amount
  actualBookingPrice?: number; // admin-only

  createdAt?: Date;
  updatedAt?: Date;
}

/* ────────────────────────────────────────────────────────────────
 * Enums (schema validation)
 * ──────────────────────────────────────────────────────────────── */

const STATUS_ENUM: ApprovalStatus[] = ["pending", "approved", "declined", "on_hold"];
const ADMIN_STATE_ENUM: AdminState[] = [
  "pending",
  "assigned",
  "in_progress",
  "done",
  "on_hold",
  "cancelled",
];

const STAGE_ENUM: ApprovalStage[] = [
  "REQUEST_RAISED",
  "REQUEST_APPROVED",
  "REQUEST_DECLINED",
  "REQUEST_ON_HOLD",

  "PROPOSAL_PENDING",
  "PROPOSAL_SUBMITTED",
  "PROPOSAL_APPROVED",
  "PROPOSAL_DECLINED",

  "BOOKING_IN_PROGRESS",
  "BOOKING_ON_HOLD",
  "BOOKING_DONE",
  "BOOKING_CANCELLED",

  "COMPLETED",
  "CANCELLED",
];

const REQUEST_STAGES = new Set<ApprovalStage>([
  "REQUEST_RAISED",
  "REQUEST_APPROVED",
  "REQUEST_DECLINED",
  "REQUEST_ON_HOLD",
]);

const ADVANCED_STAGES = new Set<ApprovalStage>([
  "PROPOSAL_PENDING",
  "PROPOSAL_SUBMITTED",
  "PROPOSAL_APPROVED",
  "PROPOSAL_DECLINED",
  "BOOKING_IN_PROGRESS",
  "BOOKING_ON_HOLD",
  "BOOKING_DONE",
  "BOOKING_CANCELLED",
  "COMPLETED",
  "CANCELLED",
]);

function isRequestStage(v: any): v is ApprovalStage {
  return REQUEST_STAGES.has(String(v || "") as ApprovalStage);
}

function isAdvancedStage(v: any): v is ApprovalStage {
  return ADVANCED_STAGES.has(String(v || "") as ApprovalStage);
}

/**
 * Default stage resolver based on status
 * (so existing code paths that only set status still behave correctly)
 *
 * IMPORTANT:
 * - Your new routes use: on_hold => status:"pending" + stage:"REQUEST_ON_HOLD"
 * - So "pending" MUST NOT automatically mean "REQUEST_RAISED" if stage is already set.
 */
function defaultStageFromStatus(status: any): ApprovalStage {
  const s = String(status || "pending").toLowerCase();
  if (s === "approved") return "REQUEST_APPROVED";
  if (s === "declined") return "REQUEST_DECLINED";
  if (s === "on_hold") return "REQUEST_ON_HOLD";
  return "REQUEST_RAISED";
}

function normalizeApprovalStatus(input: any): ApprovalStatus {
  const s = String(input || "pending").trim().toLowerCase();
  if (s === "approved") return "approved";
  if (s === "declined") return "declined";
  if (s === "on_hold" || s === "hold" || s === "on-hold") return "on_hold";
  return "pending";
}

/**
 * Legacy stage/status -> FSM mapper.
 *
 * NOTE: status comes from many places as string; keep this tolerant.
 * This fixes your TS2345 ("string not assignable to ApprovalStatus").
 */
function fsmFromLegacy(stage: ApprovalStage | undefined, status: any): ApprovalFSM {
  const st = (stage || "") as ApprovalStage;
  const s = normalizeApprovalStatus(status);

  // baseline defaults
  let requestStage: RequestStage = "REQUEST_SUBMITTED";
  let proposalStage: ProposalStage = "PROPOSAL_NONE";
  let bookingStage: BookingStage = "BOOKING_NOT_STARTED";

  // map request
  if (st === "REQUEST_RAISED") {
    requestStage = "AWAITING_L2_REQUEST_APPROVAL";
  } else if (st === "REQUEST_DECLINED" || s === "declined") {
    requestStage = "REQUEST_DECLINED_BY_L2";
  } else if (st === "REQUEST_APPROVED" || s === "approved") {
    requestStage = "REQUEST_APPROVED_BY_L2";
  } else if (st === "REQUEST_ON_HOLD" || s === "on_hold") {
    requestStage = "AWAITING_L2_REQUEST_APPROVAL";
  }

  // map proposal
  if (st === "PROPOSAL_PENDING") {
    proposalStage = "PROPOSAL_POSTED"; // effectively ready for proposal team
  } else if (st === "PROPOSAL_SUBMITTED") {
    proposalStage = "AWAITING_PROPOSAL_APPROVAL_L2_L0";
  } else if (st === "PROPOSAL_APPROVED") {
    proposalStage = "PROPOSAL_APPROVED";
  } else if (st === "PROPOSAL_DECLINED") {
    proposalStage = "PROPOSAL_DECLINED";
  }

  // map booking
  if (st === "BOOKING_IN_PROGRESS" || st === "BOOKING_ON_HOLD") {
    bookingStage = "BOOKING_IN_PROGRESS";
  } else if (st === "BOOKING_DONE") {
    bookingStage = "BOOKING_DONE";
  } else if (st === "BOOKING_CANCELLED" || st === "CANCELLED") {
    bookingStage = "CANCELLED";
  } else if (st === "COMPLETED") {
    bookingStage = "COMPLETED";
  }

  const fsm: ApprovalFSM = {
    current: "REQUEST_SUBMITTED",
    request: { stage: requestStage },
    proposal: { stage: proposalStage },
    booking: { stage: bookingStage },
    updatedAt: new Date(),
    version: 1,
  };

  return fsm;
}

function deriveFsmCurrent(fsm: ApprovalFSM, legacyStage: ApprovalStage | undefined) {
  const st = String(legacyStage || "").toUpperCase() as ApprovalStage;

  // booking terminal first
  if (st === "COMPLETED") return "COMPLETED";
  if (st === "CANCELLED" || st === "BOOKING_CANCELLED") return "CANCELLED";
  if (st === "BOOKING_DONE") return "BOOKING_DONE";
  if (st === "BOOKING_IN_PROGRESS" || st === "BOOKING_ON_HOLD") return "BOOKING_IN_PROGRESS";

  // proposal
  if (st === "PROPOSAL_DECLINED") return "PROPOSAL_DECLINED";
  if (st === "PROPOSAL_APPROVED") return "PROPOSAL_APPROVED";
  if (st === "PROPOSAL_SUBMITTED") return "AWAITING_PROPOSAL_APPROVAL_L2_L0";
  if (st === "PROPOSAL_PENDING") return "PROPOSAL_POSTED";

  // request
  if (st === "REQUEST_DECLINED") return "REQUEST_DECLINED_BY_L2";
  if (st === "REQUEST_APPROVED") return "REQUEST_APPROVED_BY_L2";
  if (st === "REQUEST_ON_HOLD" || st === "REQUEST_RAISED") return "AWAITING_L2_REQUEST_APPROVAL";

  // fallback
  return fsm.request?.stage || "REQUEST_SUBMITTED";

}

/* ────────────────────────────────────────────────────────────────
 * Schemas
 * ──────────────────────────────────────────────────────────────── */

const CartItemSchema = new Schema<ApprovalCartItem>(
  {
    type: { type: String, required: true },
    title: { type: String },
    description: { type: String },
    qty: { type: Number },
    price: { type: Number },

    // ✅ ensure nested writes always work
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const HistorySchema = new Schema<ApprovalHistoryItem>(
  {
    action: { type: String, required: true },
    at: { type: Date },
    by: { type: String, required: true },
    comment: { type: String },
    userName: { type: String },
    userEmail: { type: String },
  },
  { _id: false },
);

const ApprovalFSMSchema = new Schema<ApprovalFSM>(
  {
    current: { type: String, required: true },

    request: {
      stage: { type: String, required: true },
    },

    proposal: {
      stage: { type: String, required: true },
    },

    booking: {
      stage: { type: String, required: true },
    },

    updatedAt: { type: Date },
    version: { type: Number },
  },
  { _id: false },
);

const ApprovalRequestSchema = new Schema<ApprovalRequestDocument>(
  {
    ticketId: { type: String, index: true },

    customerId: { type: String, required: true, index: true },
    customerName: { type: String },
    customerEmailDomain: { type: String, index: true },

    frontlinerId: { type: String, required: true, index: true },
    frontlinerEmail: { type: String, required: true, index: true },
    frontlinerName: { type: String },

    managerId: { type: String, index: true },
    managerEmail: { type: String, required: true, index: true },
    managerName: { type: String },

    status: { type: String, enum: STATUS_ENUM, default: "pending", index: true },
    adminState: { type: String, enum: ADMIN_STATE_ENUM, index: true },

    stage: {
      type: String,
      enum: STAGE_ENUM,
      index: true,
      default: function (this: any) {
        return defaultStageFromStatus(this?.status);
      },
    },

    // ✅ NEW FSM
    fsm: { type: ApprovalFSMSchema, default: undefined },

    comments: { type: String },
    cartItems: { type: [CartItemSchema], default: [] },

    approvedByName: { type: String },
    approvedByEmail: { type: String },

    history: { type: [HistorySchema], default: [] },

    // ✅ CRITICAL: meta must always exist (attachments, ccLeaders, revoked, etc.)
    meta: { type: Schema.Types.Mixed, default: {} },

    // pricing
    bookingAmount: { type: Number },
    actualBookingPrice: { type: Number },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

/**
 * Keep stage consistent when status changes via legacy routes.
 * Also keep FSM backfilled so future routes can trust fsm (during transition).
 */
ApprovalRequestSchema.pre("save", function (next) {
  try {
    const doc: any = this;

    const statusNow = normalizeApprovalStatus(doc?.status);
    const currentStage = String(doc?.stage || "") as ApprovalStage;

    const statusModified =
      typeof doc.isModified === "function" ? doc.isModified("status") : false;

    // If caller explicitly set stage in this mutation, respect it (but still sync FSM)
    const stageModified =
      typeof doc.isModified === "function" ? doc.isModified("stage") : false;

    // If stage missing, compute from status (legacy safety)
    if (!currentStage) {
      doc.stage = defaultStageFromStatus(statusNow);
    } else {
      // If already in proposal/booking lifecycle, don't overwrite from status.
      if (!isAdvancedStage(currentStage)) {
        // If not request-stage, leave it (safe)
        if (isRequestStage(currentStage)) {
          // IMPORTANT: do not overwrite REQUEST_ON_HOLD when status is "pending"
          // (routes purposely keep status pending for on-hold)
          if (!(currentStage === "REQUEST_ON_HOLD" && statusNow === "pending")) {
            if (statusModified && !stageModified) {
              doc.stage = defaultStageFromStatus(statusNow);
            }
          }
        }
      }
    }

    // Backfill FSM only when missing OR when not explicitly edited
const fsmModified =
  typeof doc.isModified === "function" ? doc.isModified("fsm") : false;

const stageFinal = String(doc?.stage || "") as ApprovalStage;

if (!doc.fsm || !doc.fsm.request || !doc.fsm.proposal || !doc.fsm.booking || (!fsmModified && !stageModified && !statusModified)) {
  doc.fsm = fsmFromLegacy(stageFinal, statusNow);
}

doc.fsm.current = deriveFsmCurrent(doc.fsm, stageFinal);


    return next();
  } catch {
    return next();
  }
});

const ApprovalRequest: Model<ApprovalRequestDocument> =
  mongoose.models.ApprovalRequest ||
  mongoose.model<ApprovalRequestDocument>("ApprovalRequest", ApprovalRequestSchema);

export default ApprovalRequest;
