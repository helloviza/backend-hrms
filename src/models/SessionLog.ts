import mongoose, { Schema, type Document } from "mongoose";

export interface ISessionLog extends Document {
  userId?: mongoose.Types.ObjectId;
  email: string;
  role?: string;
  event: "LOGIN" | "LOGOUT" | "TOKEN_REFRESH" | "LOGIN_FAILED" | "PASSWORD_CHANGE";
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
  failureReason?: string;
  sessionDuration?: number;
  createdAt: Date;
}

const sessionLogSchema = new Schema<ISessionLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    email: { type: String, default: "" },
    role: { type: String, default: "" },
    event: {
      type: String,
      required: true,
      enum: ["LOGIN", "LOGOUT", "TOKEN_REFRESH", "LOGIN_FAILED", "PASSWORD_CHANGE"],
    },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    success: { type: Boolean, default: true },
    failureReason: { type: String, default: "" },
    sessionDuration: { type: Number },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

// TTL index: auto-delete after 90 days
sessionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Compound index for efficient per-user queries
sessionLogSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model<ISessionLog>("SessionLog", sessionLogSchema);
