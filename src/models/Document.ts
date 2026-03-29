import mongoose, { Schema, type Document as MongoDoc, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type DocumentCategory =
  | "IDENTITY"
  | "EDUCATION"
  | "EMPLOYMENT"
  | "BANK"
  | "TAX"
  | "MEDICAL"
  | "CONTRACT"
  | "OTHER";

export type VerificationStatus = "PENDING" | "VERIFIED" | "REJECTED";

export interface HRDocumentDoc extends MongoDoc {
  workspaceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  uploadedBy?: mongoose.Types.ObjectId;
  vendorId?: mongoose.Types.ObjectId;
  category: DocumentCategory;
  name: string;
  description?: string;
  key: string;
  contentType?: string;
  fileSize?: number;
  expiryDate?: Date;
  isConfidential: boolean;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  verificationStatus: VerificationStatus;
  createdAt: Date;
  updatedAt: Date;
}

const DocumentSchema = new Schema<HRDocumentDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor" },
    category: {
      type: String,
      enum: ["IDENTITY", "EDUCATION", "EMPLOYMENT", "BANK", "TAX", "MEDICAL", "CONTRACT", "OTHER"],
      default: "OTHER",
    },
    name: { type: String, required: true },
    description: { type: String },
    key: { type: String, required: true },
    contentType: { type: String },
    fileSize: { type: Number },
    expiryDate: { type: Date },
    isConfidential: { type: Boolean, default: false },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
    verificationStatus: {
      type: String,
      enum: ["PENDING", "VERIFIED", "REJECTED"],
      default: "PENDING",
    },
  },
  { timestamps: true },
);

DocumentSchema.plugin(workspaceScopePlugin);
DocumentSchema.index({ workspaceId: 1, userId: 1, category: 1 });

const DocumentModel: Model<HRDocumentDoc> =
  (mongoose.models.Document as Model<HRDocumentDoc>) ||
  mongoose.model<HRDocumentDoc>("Document", DocumentSchema);

export default DocumentModel;
