// apps/backend/src/models/cstep/CstepAmendment.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepAmendment
 * --------------
 * CSTEP Travel & Claim Portal — append-only field-level edit audit.
 * Originally scoped to approver edits on an open CstepClaim (claimId); Phase
 * 4 additively widened it to also log traveller/approver edits made on a
 * CstepTravelRequest BEFORE a claim exists — requestId is set instead of
 * claimId in that case. Exactly one of requestId/claimId is set per entry;
 * enforced at the call site, not the schema. Documents are never updated
 * after insert; changedAt is the record's own timestamp (deliberately a
 * string, not Mongoose timestamps — this is a log entry, not a mutable
 * resource).
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export interface ICstepAmendment extends Document {
  workspaceId: mongoose.Types.ObjectId;
  claimId?: mongoose.Types.ObjectId; // ref CstepClaim — set once a claim exists
  requestId?: mongoose.Types.ObjectId; // ref CstepTravelRequest — set pre-claim

  field: string;
  oldValue?: any;
  newValue?: any;

  changedBy: mongoose.Types.ObjectId; // ref User
  changedAt: string; // ISO string, not Date — see module note
  reason: string;
}

const CstepAmendmentSchema = new Schema<ICstepAmendment>({
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
  claimId: { type: Schema.Types.ObjectId, ref: "CstepClaim", index: true },
  requestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", index: true },

  field: { type: String, required: true, trim: true },
  oldValue: { type: Schema.Types.Mixed },
  newValue: { type: Schema.Types.Mixed },

  changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  changedAt: { type: String, required: true },
  reason: { type: String, required: true, trim: true },
});

CstepAmendmentSchema.plugin(workspaceScopePlugin);

const CstepAmendment =
  (mongoose.models.CstepAmendment as mongoose.Model<ICstepAmendment>) ||
  mongoose.model<ICstepAmendment>("CstepAmendment", CstepAmendmentSchema);

export default CstepAmendment;
