// apps/backend/src/models/NavPreferenceAudit.ts
//
// One row per change of a person's User.visibleNavGroups — written ONLY by
// services/navPreference.service.ts. Append-only: who, when, before → after,
// and whether it came through the API or the admin script.
import { Schema, model } from "mongoose";

const NavPreferenceAuditSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, trim: true, lowercase: true },
    /** null = no restriction (the full Header). */
    before: { type: [String], default: undefined },
    after: { type: [String], default: undefined },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    actorEmail: { type: String, trim: true, lowercase: true },
    via: { type: String, enum: ["api", "script"], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

NavPreferenceAuditSchema.index({ userId: 1, createdAt: -1 });

export default model("NavPreferenceAudit", NavPreferenceAuditSchema);
