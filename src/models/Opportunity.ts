// apps/backend/src/models/Opportunity.ts
//
// Opportunity — NEW collection (`opportunities`), Phase 1 / Slice 2 of the
// Plumbox CRM rebuild (docs/crm/PLUMBOX_ARCHITECTURE_GAP_ANALYSIS.md §4, §6;
// PRD Sections D, H, O). The commercial buying motion, split out of the Lead
// row: a Lead is intake/triage, an Opportunity is a deal in a pipeline.
//
// Ship-dark: nothing writes this collection unless CRM_V2_OPPORTUNITY is on
// (routes) or scripts/migrate-lead-opportunity.ts is run deliberately. The
// model itself is not gated — same posture as CrmAssociation.
//
// Identity / links
//   leadId          the Lead this was converted from (unique+sparse — ONE
//                   opportunity per lead by construction, risk M7; the
//                   migration upserts on it so a re-run cannot duplicate).
//   companyId       the Company Account (crmcompanies, in place) ← Lead.companyId.
//   accountId       reserved bridge to the onboarded billing identity
//                   (Customer._id), mirroring CRMCompany.customerId; null until
//                   Closed Won triggers onboarding. Not written in this slice.
//   primaryContactId the buying contact (crmcontacts) ← Lead.convertedToContactId.
//
// Provenance (PRD N: event-sourced, explainable)
//   legacyLeadStage the Lead.stage this row was derived from — never dropped.
//   automatedByRule "" for a human write; the migration id for a migrated row
//                   (rollback deletes by it — docs/crm/PLUMBOX_MIGRATION_PLAN.md §7).
//
// Tenancy (decision A): workspaceId reserved, null, unindexed, never written.
//
// NO traveller PII here (risk D8) — the travel requirement carries routes,
// dates and counts, never passport / DOB / identity.

import mongoose, { Document, Schema } from "mongoose";
import Counter from "./Counter.js";
import {
  OPPORTUNITY_PIPELINES,
  PIPELINE_STAGES,
  TRAVEL_SERVICES,
  pipelineStage,
  type OpportunityPipeline,
  type TravelService,
} from "./crmTaxonomy.js";
import { TravelRequirementSchema, type TravelRequirement } from "./travelRequirement.js";

export const OPPORTUNITY_CURRENCIES = ["INR", "USD", "AED"] as const;
export type OpportunityCurrency = (typeof OPPORTUNITY_CURRENCIES)[number];

export const FORECAST_CATEGORIES = ["pipeline", "best_case", "commit", "omitted"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

export interface ServiceLine {
  service: TravelService;
  qty: number;
  estAmount: number;
  currency: OpportunityCurrency;
}

export interface OpportunityDoc extends Document {
  opportunityCode: string;
  name: string;

  pipeline: OpportunityPipeline;
  stage: string;
  /** Stage default unless explicitly overridden (PRD H: "Sales Ops may
   *  override only with an explained reason" — the reason is an activity). */
  probability: number;
  probabilityOverridden: boolean;
  forecastCategory: ForecastCategory;

  dealValue: number;
  currency: OpportunityCurrency;
  closeDate?: Date | null;
  /** Set when the stage becomes a closed one; the migration copies
   *  Lead.wonDate ?? the won activity's createdAt, never fabricates. */
  closedAt?: Date | null;

  nextAction: string;
  nextActionDueAt?: Date | null;
  lostReason: string;

  primaryContactId?: mongoose.Types.ObjectId | null;
  companyId?: mongoose.Types.ObjectId | null;
  leadId?: mongoose.Types.ObjectId | null;
  accountId?: mongoose.Types.ObjectId | null;

  serviceMix: TravelService[];
  serviceLines: ServiceLine[];
  travelRequirement: TravelRequirement;

  ownerUserId?: mongoose.Types.ObjectId | null;
  ownerName: string;
  createdBy?: mongoose.Types.ObjectId | null;

  legacyLeadStage: string;
  automatedByRule: string;

  workspaceId?: mongoose.Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

const ServiceLineSchema = new Schema<ServiceLine>(
  {
    service: { type: String, enum: TRAVEL_SERVICES, required: true },
    qty: { type: Number, min: 0, default: 1 },
    estAmount: { type: Number, min: 0, default: 0 },
    currency: { type: String, enum: OPPORTUNITY_CURRENCIES, default: "INR" },
  },
  { _id: false },
);

const OpportunitySchema = new Schema<OpportunityDoc>(
  {
    opportunityCode: { type: String, trim: true },
    name: { type: String, trim: true, default: "" },

    pipeline: { type: String, enum: OPPORTUNITY_PIPELINES, required: true },
    stage: {
      type: String,
      required: true,
      validate: {
        validator(this: OpportunityDoc, v: string) {
          return pipelineStage(this.pipeline, v) !== null;
        },
        message: (props: any) => `stage "${props.value}" is not a stage of this pipeline`,
      },
    },
    probability: { type: Number, min: 0, max: 100, default: 0 },
    probabilityOverridden: { type: Boolean, default: false },
    forecastCategory: { type: String, enum: FORECAST_CATEGORIES, default: "pipeline" },

    dealValue: { type: Number, min: 0, default: 0 },
    currency: { type: String, enum: OPPORTUNITY_CURRENCIES, default: "INR" },
    closeDate: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    nextAction: { type: String, trim: true, default: "" },
    nextActionDueAt: { type: Date, default: null },
    lostReason: { type: String, trim: true, default: "" },

    primaryContactId: { type: Schema.Types.ObjectId, ref: "CRMContact", default: null },
    companyId: { type: Schema.Types.ObjectId, ref: "CRMCompany", default: null },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    accountId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },

    serviceMix: { type: [{ type: String, enum: TRAVEL_SERVICES }], default: [] },
    serviceLines: { type: [ServiceLineSchema], default: [] },
    travelRequirement: { type: TravelRequirementSchema, default: () => ({}) },

    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    ownerName: { type: String, trim: true, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    legacyLeadStage: { type: String, trim: true, default: "" },
    automatedByRule: { type: String, trim: true, default: "" },

    // Reserved (decision A). Never read, never written, not indexed for scoping.
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", default: null },
  },
  { timestamps: true, collection: "opportunities" },
);

// One opportunity per converted lead — the migration's idempotency key (M7).
// Partial (not sparse): `default: null` IS indexed by a sparse index, so a
// sparse-unique index would let exactly one null-leadId opportunity exist.
OpportunitySchema.index(
  { leadId: 1 },
  { unique: true, name: "opportunity_leadId_unique", partialFilterExpression: { leadId: { $type: "objectId" } } },
);
OpportunitySchema.index({ opportunityCode: 1 }, { unique: true, sparse: true });
OpportunitySchema.index({ pipeline: 1, stage: 1 });
OpportunitySchema.index({ ownerUserId: 1 });
OpportunitySchema.index({ companyId: 1 }, { sparse: true });
OpportunitySchema.index({ primaryContactId: 1 }, { sparse: true });
OpportunitySchema.index({ closeDate: 1 }, { sparse: true });
OpportunitySchema.index({ automatedByRule: 1 }, { sparse: true });
OpportunitySchema.index({ createdAt: -1 });

// Probability follows the stage table unless a human overrode it; closedAt
// is stamped the first time the stage becomes terminal and cleared if a
// closed deal is reopened (finance corrections — PRD H).
OpportunitySchema.pre("validate", function (next) {
  const def = pipelineStage(this.pipeline, this.stage);
  if (def) {
    const stageChanged = this.isNew || this.isModified("stage") || this.isModified("pipeline");
    if (this.isModified("probability")) {
      // A caller set it explicitly: it is an override iff it departs from
      // the table (defaults applied by Mongoose do not count as modified).
      this.probabilityOverridden = this.probability !== def.probability;
    } else if (stageChanged) {
      this.probability = def.probability;
      this.probabilityOverridden = false;
    }
    if (def.closed) {
      if (!this.closedAt) this.closedAt = new Date();
    } else if (this.isModified("stage") && this.closedAt) {
      this.closedAt = null;
    }
  }
  next();
});

// OPP-YYYY-NNNN from the atomic Counter — never countDocuments()+1 (risk D4).
OpportunitySchema.pre("save", async function (next) {
  if (this.opportunityCode) return next();
  try {
    const year = new Date().getFullYear();
    const c = await Counter.findByIdAndUpdate(
      `opportunity:${year}`,
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
    this.opportunityCode = `OPP-${year}-${String(c!.seq).padStart(4, "0")}`;
  } catch {
    // non-blocking — the code is a display id; the unique sparse index
    // tolerates its absence.
  }
  next();
});

/** Stage list for a pipeline, for UI pickers and validation messages. */
export function stagesFor(pipeline: OpportunityPipeline) {
  return PIPELINE_STAGES[pipeline];
}

const Opportunity = mongoose.model<OpportunityDoc>("Opportunity", OpportunitySchema);
export default Opportunity;
