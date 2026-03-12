import { Schema, model, type Document } from "mongoose";

export interface IPaymentOrphan extends Document {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  amount: number;
  currency: string;
  webhookPayload: Record<string, unknown>;
  resolvedAt?: Date;
  resolvedBy?: string;
  notes?: string;
  createdAt: Date;
}

const PaymentOrphanSchema = new Schema(
  {
    razorpayPaymentId: { type: String, required: true, unique: true },
    razorpayOrderId: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    webhookPayload: { type: Schema.Types.Mixed, default: {} },
    resolvedAt: { type: Date },
    resolvedBy: { type: String },
    notes: { type: String },
  },
  { timestamps: true },
);

export default model<IPaymentOrphan>("PaymentOrphan", PaymentOrphanSchema);
