// apps/backend/src/models/VisaRuleAudit.ts
//
// Append-only audit trail for VisaRule changes — a separate collection,
// deliberately NOT an array embedded on VisaRule itself: fee/rule history
// grows without bound (every fee correction, every publish, every retire),
// while VisaRule is a small, frequently-read document that should stay
// cheap to load. One row per change; never updated or deleted.
//
// Written exclusively by routes/admin.visa.rules.ts — every POST/PATCH
// that mutates a VisaRule (create, update, clone, publish, retire, bulk
// edit) writes exactly one of these alongside it, in the same request.
// Global (NOT workspace-scoped) — VisaRule itself is global reference
// data, so its audit trail is too.
import mongoose, { Schema, type Document, type Model } from "mongoose";

// IMPORT is distinct from UPDATE: same field-change shape, but this is the
// signal routes/admin.visa.rules.importExport.ts's bulk spreadsheet import
// writes instead of UPDATE — "marked as a bulk import" per that feature's
// own brief, so a reviewer can tell a spreadsheet-driven change from a
// hand-edit in the console without reading prose.
// UNRETIRE is its own action rather than a second UPDATE, for the same
// reason IMPORT is: the field-change shape is identical to any other
// status transition, but a reviewer scanning the trail needs to see that a
// withdrawn rule was deliberately brought back — that is a different act
// from editing one, and it is the entry someone will go looking for when
// asking "who restored this, and when".
export const VISA_RULE_AUDIT_ACTIONS = ["CREATE", "UPDATE", "PUBLISH", "RETIRE", "UNRETIRE", "CLONE", "IMPORT"] as const;
export type VisaRuleAuditAction = (typeof VISA_RULE_AUDIT_ACTIONS)[number];

// One changed field. `from`/`to` are Mixed — a rule field can be a number,
// string, boolean, Date, or an array (documentRequirements) — deliberately
// NOT normalised to strings, so a reader can still tell a real 0 from an
// absent/undefined value.
export interface VisaRuleFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface VisaRuleAuditDocument extends Document {
  ruleId: mongoose.Types.ObjectId; // ref VisaRule — the rule this entry is about
  action: VisaRuleAuditAction;
  // Field-level diff. For CREATE and CLONE this is every field the new
  // rule was created with (from: null). For UPDATE it is only the fields
  // that actually changed. For PUBLISH/RETIRE/UNRETIRE it is always exactly
  // one entry — the status transition.
  changes: VisaRuleFieldChange[];
  // Set only when action === "CLONE" — the rule this one was cloned from.
  clonedFromRuleId?: mongoose.Types.ObjectId; // ref VisaRule
  performedByUserId: mongoose.Types.ObjectId; // ref User
  performedAt: Date;
}

const VisaRuleFieldChangeSchema = new Schema<VisaRuleFieldChange>(
  {
    field: { type: String, required: true },
    from: { type: Schema.Types.Mixed },
    to: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const VisaRuleAuditSchema = new Schema<VisaRuleAuditDocument>({
  ruleId: { type: Schema.Types.ObjectId, ref: "VisaRule", required: true, index: true },
  action: { type: String, enum: VISA_RULE_AUDIT_ACTIONS, required: true },
  changes: { type: [VisaRuleFieldChangeSchema], default: [] },
  clonedFromRuleId: { type: Schema.Types.ObjectId, ref: "VisaRule" },
  performedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  performedAt: { type: Date, required: true, default: Date.now },
});

// Primary read path: "show this rule's change history, newest first."
VisaRuleAuditSchema.index({ ruleId: 1, performedAt: -1 });

const VisaRuleAudit: Model<VisaRuleAuditDocument> =
  mongoose.models.VisaRuleAudit ||
  mongoose.model<VisaRuleAuditDocument>("VisaRuleAudit", VisaRuleAuditSchema);

export default VisaRuleAudit;
