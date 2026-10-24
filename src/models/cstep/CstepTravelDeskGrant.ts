// apps/backend/src/models/cstep/CstepTravelDeskGrant.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepTravelDeskGrant
 * --------------------
 * #12 — the workspace-level CSTEP "Travel Desk" role: one row per (workspace,
 * user) a CSTEP Admin has granted it to. A holder is the Travel Desk for
 * EVERY traveller in the workspace — arranging, change requests and
 * settlement (routes/cstep.ts callerIsTravelDesk) — alongside the
 * per-traveller Official (TravellerProfile.officialUserId), who stays the
 * Travel Desk for their own travellers. Grantable to any workspace user,
 * a CSTEP Admin included; it carries none of the Admin's own powers.
 *
 * Revoking keeps the row (revokedAt / revokedBy) so who held the role, and
 * when, stays on record; granting again clears revokedAt and restamps
 * grantedBy / grantedAt. A grant is active while revokedAt is unset.
 */
export interface ICstepTravelDeskGrant extends Document {
  workspaceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  grantedBy: mongoose.Types.ObjectId;
  grantedAt: Date;
  revokedBy?: mongoose.Types.ObjectId;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CstepTravelDeskGrantSchema = new Schema<ICstepTravelDeskGrant>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    grantedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    grantedAt: { type: Date, required: true },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User" },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

CstepTravelDeskGrantSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
CstepTravelDeskGrantSchema.plugin(workspaceScopePlugin);

const CstepTravelDeskGrant =
  (mongoose.models.CstepTravelDeskGrant as mongoose.Model<ICstepTravelDeskGrant>) ||
  mongoose.model<ICstepTravelDeskGrant>("CstepTravelDeskGrant", CstepTravelDeskGrantSchema);

export default CstepTravelDeskGrant;
