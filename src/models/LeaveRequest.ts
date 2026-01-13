import { Schema, model } from "mongoose";

const LeaveRequestSchema = new Schema(
  {
    // Who is requesting the leave
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // Leave type - aligned with frontend LEAVE_POLICY keys
    type: {
      type: String,
      enum: [
        "CASUAL",
        "SICK",
        "PAID",
        "UNPAID",
        "MATERNITY",
        "COMPOFF",
        "BEREAVEMENT",
        "PATERNITY",
      ],
      required: true,
    },

    // Date window
    from: { type: Date, required: true },
    to: { type: Date, required: true },

    // Optional pre-computed number of days (can be set by route logic)
    days: { type: Number },

    // Reason entered by employee
    reason: { type: String },

    // Day-length & half-day support (matches Apply.tsx payload)
    dayLength: {
      type: String,
      enum: ["FULL", "HALF"],
      default: "FULL",
    },
    halfDay: {
      type: Boolean,
      default: false,
    },
    halfSession: {
      type: String,
      enum: ["FIRST", "SECOND"],
      default: "FIRST",
    },

    // Optional attachment metadata (we store just the name for now)
    attachmentName: {
      type: String,
    },

    // Approval workflow status
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },

    // Approver (HR / Manager)
    approverId: { type: Schema.Types.ObjectId, ref: "User" },

    // History of actions on this leave
    history: [
      {
        at: { type: Date },
        by: { type: Schema.Types.ObjectId, ref: "User" },
        action: { type: String }, // e.g. "APPLIED", "APPROVED", "REJECTED"
        note: { type: String },
      },
    ],
  },
  {
    timestamps: true, // createdAt / updatedAt
  }
);

export default model("LeaveRequest", LeaveRequestSchema);
