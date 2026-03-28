// apps/backend/src/models/LeaveRequest.ts
import { Schema, model } from "mongoose";

const LeaveRequestSchema = new Schema(
  {
    // Who is requesting the leave
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // Leave type — new canonical keys
    type: {
      type: String,
      enum: [
        "CL",
        "SL",
        "EL",
        "BEREAVEMENT",
        "PATERNITY",
        "MATERNITY",
        "COMPOFF",
        "UNPAID",
        // Keep legacy values so old data still passes validation
        "CASUAL",
        "SICK",
        "PAID",
      ],
      required: true,
    },

    // Date window
    from: { type: Date, required: true },
    to: { type: Date, required: true },

    // Pre-computed number of days
    days: { type: Number },

    // Reason entered by employee
    reason: { type: String },

    // Day-length & half-day support
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
    // Specific date for half day when range is multi-day
    halfDayDate: { type: Date },

    // Optional attachment metadata
    attachmentName: { type: String },

    // Approval workflow status
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
      default: "PENDING",
    },

    // Approver (HR / Manager)
    approverId: { type: Schema.Types.ObjectId, ref: "User" },

    // Cancellation fields
    cancelledAt: { type: Date },
    cancelReason: { type: String },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },

    // History of actions on this leave
    history: [
      {
        at: { type: Date },
        by: { type: Schema.Types.ObjectId, ref: "User" },
        action: { type: String },
        note: { type: String },
      },
    ],
  },
  {
    timestamps: true,
  },
);

export default model("LeaveRequest", LeaveRequestSchema);
