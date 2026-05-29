// apps/backend/src/models/DemoSession.ts
//
// Audit trail for the Demo Platform impersonation flow.
// Every successful POST /api/admin/demo/start-session writes one row here
// and updates it on /end-session. Records are persistent (no TTL) — the
// audit trail must survive indefinitely for compliance/forensics.
import { Schema, model, type Document } from "mongoose";

export interface IDemoSession extends Document {
  callerUserId: Schema.Types.ObjectId;
  targetUserId: Schema.Types.ObjectId;
  callerEmail: string;
  targetEmail: string;
  customerId?: string;
  workspaceId?: string;
  startedAt: Date;
  endedAt?: Date;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
  status: "ACTIVE" | "ENDED" | "EXPIRED";
  endedReason?: "MANUAL" | "TIMEOUT" | "ADMIN_REVOKE";
  tokenJti?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DemoSessionSchema = new Schema<IDemoSession>(
  {
    callerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    callerEmail: { type: String, required: true },
    targetEmail: { type: String, required: true },
    customerId: { type: String },
    workspaceId: { type: String },
    startedAt: { type: Date, required: true, default: Date.now },
    endedAt: { type: Date },
    reason: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },
    status: {
      type: String,
      enum: ["ACTIVE", "ENDED", "EXPIRED"],
      default: "ACTIVE",
      required: true,
    },
    endedReason: {
      type: String,
      enum: ["MANUAL", "TIMEOUT", "ADMIN_REVOKE"],
    },
    tokenJti: { type: String },
  },
  { timestamps: true },
);

DemoSessionSchema.index({ callerUserId: 1, startedAt: -1 });
DemoSessionSchema.index({ targetUserId: 1, startedAt: -1 });

export default model<IDemoSession>("DemoSession", DemoSessionSchema);
