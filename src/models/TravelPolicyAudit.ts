// apps/backend/src/models/TravelPolicyAudit.ts
//
// Append-only audit trail for the Travel Policy module (spec §10). Same
// enforcement as models/ExpenseActivity.ts: every update / replace / delete
// path and every re-save of an existing row throws. Written only through
// services/travelPolicy.service.ts appendAudit (never throws to the caller).
//
// `actor` records the REAL person and in what capacity they acted:
// CLIENT_ADMIN (the company's own leader / tenant admin) or PLUMTRIPS_STAFF
// (SuperAdmin or a HOUSE user with the travelPolicy grant, acting on the
// client's behalf).
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type TravelPolicyAuditAction =
  | "DRAFT_CREATED"
  | "DRAFT_SAVED"
  | "DRAFT_DISCARDED"
  | "VERSION_PUBLISHED"
  | "VERSION_CLOSED"
  | "VERSION_REOPENED"
  | "VERSION_REPLACED"
  | "VERSION_CANCELLED"
  | "CITIES_SEEDED"
  | "CITY_CREATED"
  | "CITY_UPDATED"
  | "ASSIGNMENT_SET"
  | "ASSIGNMENT_CLEARED"
  | "TRAVELLERS_IMPORTED"
  | "DEPARTMENT_CREATED"
  | "DESIGNATION_CREATED"
  | "DESIGNATION_UPDATED"
  | "SETTING_CHANGED";

export interface ITravelPolicyAudit extends Document {
  workspaceId: mongoose.Types.ObjectId;
  workspaceName: string;
  action: TravelPolicyAuditAction;
  entity: "VERSION" | "CITY" | "ASSIGNMENT" | "TRAVELLER" | "ORG";
  entityId: string;
  versionId: string | null;
  versionNumber: number | null;
  categories: string[];
  summary: string;
  changes: { category: string; field: string; from: unknown; to: unknown }[];
  reason: string;
  actor: { id: string; name: string; email: string; kind: string; roles: string[] };
  createdAt: Date;
}

const TravelPolicyAuditSchema = new Schema<ITravelPolicyAudit>(
  {
    workspaceName: { type: String, default: "" },
    action: { type: String, required: true },
    entity: { type: String, enum: ["VERSION", "CITY", "ASSIGNMENT", "TRAVELLER", "ORG"], required: true },
    entityId: { type: String, default: "" },
    versionId: { type: String, default: null },
    versionNumber: { type: Number, default: null },
    categories: { type: [String], default: [] },
    summary: { type: String, default: "" },
    changes: { type: [Schema.Types.Mixed] as any, default: [] },
    reason: { type: String, default: "" },
    actor: {
      id: { type: String, default: "" },
      name: { type: String, default: "" },
      email: { type: String, default: "" },
      kind: { type: String, default: "" },
      roles: { type: [String], default: [] },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

TravelPolicyAuditSchema.plugin(workspaceScopePlugin);
TravelPolicyAuditSchema.index({ workspaceId: 1, createdAt: -1 });
TravelPolicyAuditSchema.index({ workspaceId: 1, versionId: 1 });

const APPEND_ONLY = "TravelPolicyAudit is append-only: write a new entry instead of editing or deleting history.";
for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  TravelPolicyAuditSchema.pre(op as any, function (next: any) {
    next(new Error(APPEND_ONLY));
  });
}
TravelPolicyAuditSchema.pre("save", function (next) {
  if (!this.isNew) return next(new Error(APPEND_ONLY));
  next();
});
TravelPolicyAuditSchema.pre("deleteOne", { document: true, query: false } as any, function (next: any) {
  next(new Error(APPEND_ONLY));
});

const TravelPolicyAudit =
  (mongoose.models.TravelPolicyAudit as mongoose.Model<ITravelPolicyAudit>) ||
  mongoose.model<ITravelPolicyAudit>("TravelPolicyAudit", TravelPolicyAuditSchema);

export default TravelPolicyAudit;
