import { Schema, model, type Document, type Types } from "mongoose";

/**
 * SBTMarginChange — append-only log of every change to SBT margins: the
 * defaults (scope DEFAULTS, incl. the master switch) and each company override
 * (scope WORKSPACE: added, changed, removed). Written by routes/admin.sbt.ts
 * only; never updated or deleted.
 */
export interface ISBTMarginChange extends Document {
  scope: "DEFAULTS" | "WORKSPACE";
  action: "UPDATE" | "CREATE" | "REMOVE";
  workspaceId: Types.ObjectId | null;
  workspaceName: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string;
  actorId: string;
  actorName: string;
  at: Date;
}

const SBTMarginChangeSchema = new Schema<ISBTMarginChange>({
  scope: { type: String, enum: ["DEFAULTS", "WORKSPACE"], required: true },
  action: { type: String, enum: ["UPDATE", "CREATE", "REMOVE"], required: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", default: null, index: true },
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
  SBTMarginChangeSchema.pre(op, function () {
    throw new Error("SBTMarginChange is append-only");
  });
}

export default model<ISBTMarginChange>("SBTMarginChange", SBTMarginChangeSchema);
