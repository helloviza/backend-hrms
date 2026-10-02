// apps/backend/src/models/ApprovalLinkUse.ts
//
// One row per email decision link that has been USED (utils/approvalLinkToken.ts).
// The unique jti makes every link single-use. Not workspace-scoped on purpose:
// it is looked up by jti from a public, unauthenticated route.
import mongoose, { Schema } from "mongoose";

const ApprovalLinkUseSchema = new Schema(
  {
    jti: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["request", "proposal"], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    email: { type: String, required: true },
    action: { type: String, required: true },
    usedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

const ApprovalLinkUse: mongoose.Model<any> =
  (mongoose.models.ApprovalLinkUse as mongoose.Model<any>) ||
  mongoose.model<any>("ApprovalLinkUse", ApprovalLinkUseSchema);

export default ApprovalLinkUse;
