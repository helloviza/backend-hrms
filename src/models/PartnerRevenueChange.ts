import { Schema, model, type Document, type Types } from "mongoose";

/**
 * PartnerRevenueChange — append-only log of every change to a partner's
 * revenue-share terms (added, changed, removed) and of every backfill that
 * wrote snapshots onto already-invoiced bookings. Written by
 * routes/admin.partnerRevenue.ts only; never updated or deleted.
 */
export interface IPartnerRevenueChange extends Document {
  action: "UPDATE" | "CREATE" | "REMOVE" | "BACKFILL";
  workspaceId: Types.ObjectId;
  workspaceName: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string;
  actorId: string;
  actorName: string;
  at: Date;
}

const PartnerRevenueChangeSchema = new Schema<IPartnerRevenueChange>({
  action: { type: String, enum: ["UPDATE", "CREATE", "REMOVE", "BACKFILL"], required: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
  workspaceName: { type: String, default: "" },
  before: { type: Schema.Types.Mixed, default: null },
  after: { type: Schema.Types.Mixed, default: null },
  reason: { type: String, default: "" },
  actorId: { type: String, default: "" },
  actorName: { type: String, default: "" },
  at: { type: Date, default: Date.now, index: true },
});

// Append-only: refuse updates and deletes through the model.
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete", "replaceOne"] as const) {
  PartnerRevenueChangeSchema.pre(op, function () {
    throw new Error("PartnerRevenueChange is append-only");
  });
}

export default model<IPartnerRevenueChange>("PartnerRevenueChange", PartnerRevenueChangeSchema);
