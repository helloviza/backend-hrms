// apps/backend/src/models/cstep/CstepProject.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepProject
 * ------------
 * The CSTEP Project Master — the list every intake form's Project is picked
 * from (routes/cstep.projects.ts). projectCode is CSTEP's own code (e.g.
 * PRJ-SOLAR), typed by the Admin — never auto-generated — and unique per
 * workspace; tallyProjectCC is the Tally cost-centre code (e.g. "130 OAK 06")
 * the Tally export writes as Project CC. A request keeps a snapshot of the
 * chosen project (CstepTravelRequest.projectCode / projectName /
 * projectTallyCC), so a later rename here never rewrites it.
 */
export interface ICstepProject extends Document {
  workspaceId: mongoose.Types.ObjectId;
  projectCode: string;
  projectName: string;
  tallyProjectCC?: string;
  isActive: boolean;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CstepProjectSchema = new Schema<ICstepProject>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    projectCode: { type: String, required: true, trim: true, uppercase: true },
    projectName: { type: String, required: true, trim: true },
    tallyProjectCC: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true },
);

CstepProjectSchema.index({ workspaceId: 1, projectCode: 1 }, { unique: true });

CstepProjectSchema.plugin(workspaceScopePlugin);

const CstepProject =
  (mongoose.models.CstepProject as mongoose.Model<ICstepProject>) ||
  mongoose.model<ICstepProject>("CstepProject", CstepProjectSchema);

export default CstepProject;
