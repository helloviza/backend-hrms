import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

// Stage enum — matches PRD §24.2
export type SetupStage = "WELCOME" | "INIT" | "MODULES" | "TEAM" | "COMPLETE";

// Per-module progress sub-document
export interface ModuleProgress {
  status: "PENDING" | "IN_PROGRESS" | "CONFIGURED" | "SKIPPED";
  stepsCompleted: string[];
  lastUpdatedAt: Date;
}

const ModuleProgressSchema = new Schema<ModuleProgress>(
  {
    status: {
      type: String,
      enum: ["PENDING", "IN_PROGRESS", "CONFIGURED", "SKIPPED"],
      default: "PENDING",
      required: true,
    },
    stepsCompleted: { type: [String], default: [] },
    lastUpdatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

export interface TenantSetupProgressDocument extends Document {
  workspaceId: mongoose.Types.ObjectId;
  tenantType: "SAAS_HRMS";
  currentStage: SetupStage;
  currentStep: string | null;
  stagesCompleted: string[];
  stepsCompleted: string[];
  stepsSkipped: string[];
  moduleProgress: Map<string, ModuleProgress>;
  firstLoginAt: Date | null;
  ftuxStartedAt: Date | null;
  ftuxCompletedAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantSetupProgressModel extends Model<TenantSetupProgressDocument> {}

const TenantSetupProgressSchema = new Schema<TenantSetupProgressDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "CustomerWorkspace",
      required: true,
      unique: true,
      index: true,
    },
    tenantType: {
      type: String,
      enum: ["SAAS_HRMS"],
      required: true,
      default: "SAAS_HRMS",
    },
    currentStage: {
      type: String,
      enum: ["WELCOME", "INIT", "MODULES", "TEAM", "COMPLETE"],
      default: "WELCOME",
      required: true,
    },
    currentStep: { type: String, default: null },
    stagesCompleted: { type: [String], default: [] },
    stepsCompleted: { type: [String], default: [] },
    stepsSkipped: { type: [String], default: [] },
    moduleProgress: {
      type: Map,
      of: ModuleProgressSchema,
      default: () => new Map(),
    },
    firstLoginAt: { type: Date, default: null },
    ftuxStartedAt: { type: Date, default: null },
    ftuxCompletedAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

TenantSetupProgressSchema.plugin(workspaceScopePlugin);

const TenantSetupProgress =
  (mongoose.models.TenantSetupProgress as TenantSetupProgressModel) ||
  mongoose.model<TenantSetupProgressDocument, TenantSetupProgressModel>(
    "TenantSetupProgress",
    TenantSetupProgressSchema,
  );

export default TenantSetupProgress;
