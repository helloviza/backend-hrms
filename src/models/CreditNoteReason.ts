import { Schema, model, type Document } from "mongoose";

export interface ICreditNoteReason extends Document {
  category: string;
  reason: string;
  code: string;
  gstReasonCode: "01" | "02" | "03" | "04" | "05" | "06" | "07";
  gstReasonText: string;
  isActive: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const CreditNoteReasonSchema = new Schema<ICreditNoteReason>(
  {
    category: { type: String, required: true, index: true, uppercase: true },
    reason: { type: String, required: true },
    code: { type: String, required: true, unique: true },
    gstReasonCode: {
      type: String,
      enum: ["01", "02", "03", "04", "05", "06", "07"],
      required: true,
    },
    gstReasonText: { type: String, required: true },
    isActive: { type: Boolean, default: true, index: true },
    displayOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

CreditNoteReasonSchema.index({ category: 1, isActive: 1, displayOrder: 1 });

export default model<ICreditNoteReason>("CreditNoteReason", CreditNoteReasonSchema);
