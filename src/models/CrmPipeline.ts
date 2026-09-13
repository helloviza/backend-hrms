// apps/backend/src/models/CrmPipeline.ts
//
// CrmPipeline — a NEW collection (`crmpipelines`) that makes the calling
// pipeline a first-class, data-defined thing (Phase 1 / disposition slice).
//
// A pipeline OWNS its disposition set and, later, the team(s) scoped to it.
// Today exactly one row exists — "Corporate Calling" — seeded from
// models/crmDisposition.ts by services/crmPipelines.ts. Adding a second
// pipeline with a different disposition vocabulary, a different opportunity
// pipeline and its own team is an INSERT here, not a schema change.
//
// This is the intake/calling pipeline a LEAD is worked in. It is distinct from
// Opportunity.pipeline (corporate / travel_enquiry / partnerships — the DEAL
// pipeline); `opportunityPipeline` says which deal pipeline the shadow
// opportunity is opened in.
//
// Access seam: `teamIds` is reserved and empty today. services/crmPipelines.ts
// › canWorkPipeline() is the ONE place that decides whether a user may
// disposition leads in a pipeline; when teams exist it consults this field.
// Nothing hardcodes "the single global set" or "the single team".

import mongoose, { Document, Schema } from "mongoose";
import { OPPORTUNITY_PIPELINES, pipelineStage, type OpportunityPipeline } from "./crmTaxonomy.js";
import {
  DISPOSITION_STAGES,
  DISPOSITION_STATUSES,
  OPPORTUNITY_EFFECTS,
  validateDispositionSet,
  type DispositionEntry,
} from "./crmDisposition.js";

export const PIPELINE_KINDS = ["calling", "field"] as const;
export type PipelineKind = (typeof PIPELINE_KINDS)[number];

export interface CrmPipelineDoc extends Document {
  key: string;
  name: string;
  kind: PipelineKind;
  opportunityPipeline: OpportunityPipeline;
  dispositionSet: DispositionEntry[];
  /** Reserved: teams allowed to work this pipeline. Empty = everyone with leads access. */
  teamIds: mongoose.Types.ObjectId[];
  isDefault: boolean;
  active: boolean;
  workspaceId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const DispositionEntrySchema = new Schema<DispositionEntry>(
  {
    disposition: { type: String, required: true, trim: true },
    subDisposition: { type: String, required: true, trim: true },
    stage: { type: String, enum: DISPOSITION_STAGES, required: true },
    status: { type: String, enum: DISPOSITION_STATUSES, required: true },
    nextTouch: { type: Boolean, default: false },
    opportunityEffect: { type: String, enum: OPPORTUNITY_EFFECTS, default: "none" },
    opportunityStage: { type: String, trim: true },
    leadStatus: { type: String, required: true, trim: true },
    legacyStage: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const CrmPipelineSchema = new Schema<CrmPipelineDoc>(
  {
    key: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: PIPELINE_KINDS, default: "calling" },
    opportunityPipeline: { type: String, enum: OPPORTUNITY_PIPELINES, required: true },
    dispositionSet: { type: [DispositionEntrySchema], default: [] },
    teamIds: { type: [Schema.Types.ObjectId], default: [] },
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    // Reserved (decision A). Never read, never written.
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", default: null },
  },
  { timestamps: true, collection: "crmpipelines" },
);

CrmPipelineSchema.index({ key: 1 }, { unique: true });
CrmPipelineSchema.index({ isDefault: 1, active: 1 });

// A set must be structurally sound AND every "open" stage must exist in the
// deal pipeline the shadow opportunity is created in.
CrmPipelineSchema.pre("validate", function (next) {
  const problems = validateDispositionSet(this.dispositionSet || []);
  for (const e of this.dispositionSet || []) {
    if (e.opportunityEffect === "open" && e.opportunityStage && !pipelineStage(this.opportunityPipeline, e.opportunityStage)) {
      problems.push(`"${e.subDisposition}": opportunityStage "${e.opportunityStage}" is not a stage of ${this.opportunityPipeline}`);
    }
  }
  if (problems.length) return next(new Error(`dispositionSet invalid: ${problems.join("; ")}`));
  next();
});

const CrmPipeline = mongoose.model<CrmPipelineDoc>("CrmPipeline", CrmPipelineSchema);
export default CrmPipeline;
