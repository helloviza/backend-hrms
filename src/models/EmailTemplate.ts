import mongoose, { Schema, model, type Document } from "mongoose";

export interface IEmailTemplate extends Document {
  workspaceId: Schema.Types.ObjectId;
  name: string;
  category?: string;
  subject?: string;
  bodyHtml: string;
  description?: string;
  isActive: boolean;
  createdBy: Schema.Types.ObjectId;
  updatedBy: Schema.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const EmailTemplateSchema = new Schema<IEmailTemplate>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, trim: true },
    subject: { type: String, trim: true },
    bodyHtml: { type: String, default: "" },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

EmailTemplateSchema.index({ workspaceId: 1 });
EmailTemplateSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
EmailTemplateSchema.index({ workspaceId: 1, category: 1 });

export default model<IEmailTemplate>("EmailTemplate", EmailTemplateSchema);
