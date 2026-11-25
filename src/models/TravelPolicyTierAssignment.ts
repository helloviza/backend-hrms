// apps/backend/src/models/TravelPolicyTierAssignment.ts
//
// Explicit per-traveller mapping in the Travel Policy module (decisions D2,
// D3). Most travellers resolve to a tier by RULE (their designation or band —
// core.ts resolveTier); a row here exists only when an admin overrode that:
//   • tierKey  — pin the traveller to a tier (tierKeys are stable across
//                versions, so an override survives a new version)
//   • excluded — "GUEST": not an employee; left out of coverage / unmapped
// One row per TravellerProfile. TravellerProfile itself is NOT modified — it
// stays the single traveller master (audit §1).
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface ITravelPolicyTierAssignment extends Document {
  workspaceId: mongoose.Types.ObjectId;
  travellerProfileId: mongoose.Types.ObjectId;
  tierKey: string | null;
  excluded: "GUEST" | null;
  reason: string;
  setBy: { id: string; name: string; kind: string };
  createdAt: Date;
  updatedAt: Date;
}

const TravelPolicyTierAssignmentSchema = new Schema<ITravelPolicyTierAssignment>(
  {
    travellerProfileId: { type: Schema.Types.ObjectId, ref: "TravellerProfile", required: true },
    tierKey: { type: String, default: null },
    excluded: { type: String, enum: ["GUEST", null], default: null },
    reason: { type: String, default: "" },
    setBy: {
      id: { type: String, default: "" },
      name: { type: String, default: "" },
      kind: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

TravelPolicyTierAssignmentSchema.plugin(workspaceScopePlugin);
TravelPolicyTierAssignmentSchema.index({ workspaceId: 1, travellerProfileId: 1 }, { unique: true });

const TravelPolicyTierAssignment =
  (mongoose.models.TravelPolicyTierAssignment as mongoose.Model<ITravelPolicyTierAssignment>) ||
  mongoose.model<ITravelPolicyTierAssignment>("TravelPolicyTierAssignment", TravelPolicyTierAssignmentSchema);

export default TravelPolicyTierAssignment;
