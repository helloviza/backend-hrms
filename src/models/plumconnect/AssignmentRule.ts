// apps/backend/src/models/plumconnect/AssignmentRule.ts
//
// PlumConnect Track B — the assignment matrix. One row = "this agent takes
// leads for this target, at this priority". A target is a DEPARTMENT line
// (the four Slice 7 lines) or a CAMPAIGN / AD (a Meta id from Slice 8 —
// Lead.attribution.sourceId is the ad; the Ad row's metaCampaignId is the
// campaign). An admin maps an employee to one or more targets, each with a
// priority (lower = higher priority).
//
// Every target carries a `line`: for a department target it IS the target;
// for a campaign / ad target it is the department the campaign sells, so
// (a) the CRUD can check the agent holds THAT line at WRITE+ and (b) the
// router only applies the rule to a conversation on that line — a visa
// agent cannot be mapped onto a holiday campaign by mistake.
//
// The row says who is MAPPED. Whether they are ELIGIBLE right now (present
// and active on the line — Track A — and holding WRITE+ — Slice 7) is
// decided at routing time (services/plumconnect/assignment.ts), never
// stored here.

import mongoose, { Schema, type Document } from "mongoose";
import { ACCESS_LINES, type AccessLine } from "../../services/plumconnect/access.js";

export const ASSIGNMENT_TARGET_TYPES = ["department", "campaign", "ad"] as const;
export type AssignmentTargetType = (typeof ASSIGNMENT_TARGET_TYPES)[number];

export interface IAssignmentTarget {
  type: AssignmentTargetType;
  /** The department line this rule serves (for campaign/ad: the line the campaign sells). */
  line: AccessLine;
  /** Meta campaign id (type "campaign") or ad id (type "ad"); "" for a department. */
  metaId: string;
}

export interface IPlumConnectAssignmentRule extends Document {
  target: IAssignmentTarget;
  /** "department:<line>" | "campaign:<metaId>" | "ad:<metaId>" — the router's lookup key. */
  targetKey: string;
  userId: mongoose.Types.ObjectId;
  /** Lower = higher priority. Equal priorities are a TIE (first-to-claim). */
  priority: number;
  enabled: boolean;
  createdBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export function assignmentTargetKey(target: Pick<IAssignmentTarget, "type" | "line" | "metaId">): string {
  return target.type === "department" ? `department:${target.line}` : `${target.type}:${String(target.metaId || "").trim()}`;
}

const TargetSchema = new Schema<IAssignmentTarget>(
  {
    type: { type: String, enum: ASSIGNMENT_TARGET_TYPES, required: true },
    line: { type: String, enum: ACCESS_LINES, required: true },
    metaId: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const PlumConnectAssignmentRuleSchema = new Schema<IPlumConnectAssignmentRule>(
  {
    target: { type: TargetSchema, required: true },
    targetKey: { type: String, required: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    priority: { type: Number, default: 100, min: 0 },
    enabled: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// The key is derived, never trusted from a caller.
PlumConnectAssignmentRuleSchema.pre("validate", function (next) {
  if (this.target) {
    if (this.target.type === "department") this.target.metaId = "";
    this.targetKey = assignmentTargetKey(this.target);
    if (this.target.type !== "department" && !this.target.metaId) return next(new Error("A campaign / ad target needs a metaId."));
  }
  next();
});

// One row per (agent, target).
PlumConnectAssignmentRuleSchema.index({ userId: 1, targetKey: 1 }, { unique: true });
// The router's read.
PlumConnectAssignmentRuleSchema.index({ targetKey: 1, enabled: 1, priority: 1 });

const PlumConnectAssignmentRule =
  (mongoose.models.PlumConnectAssignmentRule as mongoose.Model<IPlumConnectAssignmentRule>) ||
  mongoose.model<IPlumConnectAssignmentRule>("PlumConnectAssignmentRule", PlumConnectAssignmentRuleSchema);

export default PlumConnectAssignmentRule;
