// apps/backend/src/models/ApprovalRequest.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";

export type ApprovalStatus = "pending" | "approved" | "declined" | "on_hold";
export type AdminState = "pending" | "assigned" | "done" | "on_hold" | "cancelled";

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

  comments?: string;
  cartItems: ApprovalCartItem[];

  approvedByName?: string;
  approvedByEmail?: string;

  history?: ApprovalHistoryItem[];
  meta?: any;

  createdAt?: Date;
  updatedAt?: Date;
}

const CartItemSchema = new Schema<ApprovalCartItem>(
  {
    type: { type: String, required: true },
    title: { type: String },
    description: { type: String },
    qty: { type: Number },
    price: { type: Number },
    meta: { type: Schema.Types.Mixed },
  },
  { _id: false }
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
  { _id: false }
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

    status: { type: String, default: "pending", index: true },
    adminState: { type: String, index: true },

    comments: { type: String },
    cartItems: { type: [CartItemSchema], default: [] },

    approvedByName: { type: String },
    approvedByEmail: { type: String },

    history: { type: [HistorySchema], default: [] },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

const ApprovalRequest: Model<ApprovalRequestDocument> =
  mongoose.models.ApprovalRequest ||
  mongoose.model<ApprovalRequestDocument>("ApprovalRequest", ApprovalRequestSchema);

export default ApprovalRequest;
