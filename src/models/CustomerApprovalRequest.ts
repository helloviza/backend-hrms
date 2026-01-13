import mongoose, { Schema } from "mongoose";

const HistorySchema = new Schema(
  {
    action: { type: String, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User" },
    at: { type: Date, default: Date.now },
    comment: { type: String, default: "" },
    meta: { type: Schema.Types.Mixed, default: {} },
    cartSnapshot: { type: Array, default: [] },
  },
  { _id: false }
);

const CustomerApprovalRequestSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true }, // Business workspace
    requesterId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }, // L1
    approverId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }, // L2

    ticketId: { type: String, index: true },

    status: { type: String, default: "pending", index: true }, // pending|approved|declined|on_hold
    adminState: { type: String, default: "pending", index: true }, // pending|assigned|done|on_hold|cancelled

    cartItems: { type: Array, default: [] },
    comments: { type: String, default: "" },

    assignedAgent: { type: Object, default: null }, // { type: 'human'|'ai', name }
    history: { type: [HistorySchema], default: [] },

    emailActions: {
      approveHash: { type: String, default: "" },
      declineHash: { type: String, default: "" },
      holdHash: { type: String, default: "" },
      expiresAt: { type: Date, default: null },
      usedAt: { type: Date, default: null },
      usedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      usedVia: { type: String, default: "" }, // "email"|"console"
    },
  },
  { timestamps: true }
);

CustomerApprovalRequestSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });

export default mongoose.models.CustomerApprovalRequest ||
  mongoose.model("CustomerApprovalRequest", CustomerApprovalRequestSchema);
