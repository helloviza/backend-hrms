// apps/backend/src/models/cstep/CstepSequenceChange.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepSequenceChange
 * -------------------
 * Audit of a CSTEP Admin raising a reference series' next number
 * (PUT /cstep/sequences/:series). One row per change that actually moved
 * the counter — an equal (no-op) or refused (lower) start writes nothing.
 * fyStartYear is set for the FY-resetting series (TIN / LTC / EXP / EVR)
 * and null for the continuous ones (VENDOR / TALLY). Append-only.
 */
export interface ICstepSequenceChange extends Document {
  workspaceId: mongoose.Types.ObjectId;
  series: string;
  fyStartYear: number | null;
  oldNext: number;
  newNext: number;
  changedBy: mongoose.Types.ObjectId;
  changedAt: Date;
}

const CstepSequenceChangeSchema = new Schema<ICstepSequenceChange>({
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true },
  series: { type: String, required: true },
  fyStartYear: { type: Number, default: null },
  oldNext: { type: Number, required: true },
  newNext: { type: Number, required: true },
  changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  changedAt: { type: Date, default: Date.now },
});

CstepSequenceChangeSchema.index({ workspaceId: 1, changedAt: -1 });

CstepSequenceChangeSchema.plugin(workspaceScopePlugin);

const CstepSequenceChange =
  (mongoose.models.CstepSequenceChange as mongoose.Model<ICstepSequenceChange>) ||
  mongoose.model<ICstepSequenceChange>("CstepSequenceChange", CstepSequenceChangeSchema);

export default CstepSequenceChange;
