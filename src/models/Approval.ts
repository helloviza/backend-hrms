import { Schema, model } from "mongoose";
const ApprovalSchema = new Schema(
  {
    entity: {
      type: String,
      enum: ["PROFILE", "LEAVE", "VENDOR", "OD"],
      required: true,
    },
    entityId: { type: Schema.Types.ObjectId, required: true },
    requesterId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approverId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },
    note: String,
  },
  { timestamps: true },
);
export default model("Approval", ApprovalSchema);
