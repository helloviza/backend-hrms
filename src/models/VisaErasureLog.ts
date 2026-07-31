// apps/backend/src/models/VisaErasureLog.ts
//
// Append-only record of every hard-deletion/erasure run against the visa
// module (scripts/erase-visa-request.ts, scripts/erase-traveller-profile.ts)
// — modelled on VisaRuleAudit.ts / VisaActivityLog.ts's own append-only
// convention: one row per run, never updated, never deleted, written
// EXCLUSIVELY through recordVisaErasure() below (no route or script ever
// calls VisaErasureLog.create() directly).
//
// This is the ONE thing a real deletion path is not allowed to also delete —
// the whole point of an erasure log is that it survives the erasure it
// describes. Global (not workspace-scoped): a SUPERADMIN-only concierge-side
// record, not tenant data.
//
// Distinct from VisaActivityLog: that collection is the PER-CASE history a
// concierge/customer can read (and gets scrubbed, not deleted, by an
// erasure — see redactVisaActivityForApplications/redactVisaActivityForRequest
// in VisaActivityLog.ts). This collection is the audit trail OF the erasure
// tool itself — who ran it, against what, why, and exactly what it touched.
import mongoose, { Schema, type Document, type Model } from "mongoose";

export const VISA_ERASURE_SCOPES = ["VISA_REQUEST", "TRAVELLER_PROFILE"] as const;
export type VisaErasureScope = (typeof VISA_ERASURE_SCOPES)[number];

// Per-collection counts — deliberately a free-form map (not a fixed set of
// named fields) since the two entry points touch different collection sets
// (see scripts/lib/visaErasureCascade.ts) and a future third entry point
// shouldn't require a schema migration just to record its own counts.
export interface VisaErasureCounts {
  [collection: string]: number;
}

// Only ever set for scope "TRAVELLER_PROFILE" — CstepTravelRequest/CstepClaim
// hold a soft (non-enforced) reference to TravellerProfile from the
// unrelated CSTEP Travel & Claim Portal. Erasure never touches those rows
// (out of scope — a different subsystem), but a run against a traveller
// with CSTEP history must have surfaced that impact and had it explicitly
// acknowledged before proceeding; this records that it was.
export interface VisaErasureCstepImpact {
  travelRequestCount: number;
  claimCount: number;
  acknowledged: boolean;
}

export interface VisaErasureLogDocument extends Document {
  scope: VisaErasureScope;
  targetId: mongoose.Types.ObjectId; // the VisaRequest._id or TravellerProfile._id erased
  workspaceId: mongoose.Types.ObjectId; // ref CustomerWorkspace — the target's own tenant
  actorUserId: mongoose.Types.ObjectId; // ref User — verified SUPERADMIN at run time, see resolveSuperAdminActor()
  actorEmail: string; // denormalised for readability without a join — actor identity is exactly what this log exists to prove
  reason: string;
  counts: VisaErasureCounts;
  s3KeysDeleted: string[];
  cstepImpact: VisaErasureCstepImpact | null;
  performedAt: Date;
}

const VisaErasureLogSchema = new Schema<VisaErasureLogDocument>({
  scope: { type: String, enum: VISA_ERASURE_SCOPES, required: true },
  targetId: { type: Schema.Types.ObjectId, required: true, index: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
  actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  actorEmail: { type: String, required: true, trim: true, lowercase: true },
  reason: { type: String, required: true, trim: true },
  counts: { type: Schema.Types.Mixed, default: {} },
  s3KeysDeleted: { type: [String], default: [] },
  cstepImpact: { type: Schema.Types.Mixed, default: null },
  performedAt: { type: Date, required: true, default: Date.now },
});

VisaErasureLogSchema.index({ performedAt: -1 });

const VisaErasureLog: Model<VisaErasureLogDocument> =
  mongoose.models.VisaErasureLog ||
  mongoose.model<VisaErasureLogDocument>("VisaErasureLog", VisaErasureLogSchema);

export default VisaErasureLog;

export interface RecordVisaErasureInput {
  scope: VisaErasureScope;
  targetId: mongoose.Types.ObjectId | string;
  workspaceId: mongoose.Types.ObjectId | string;
  actorUserId: mongoose.Types.ObjectId | string;
  actorEmail: string;
  reason: string;
  counts: VisaErasureCounts;
  s3KeysDeleted: string[];
  cstepImpact?: VisaErasureCstepImpact | null;
}

/**
 * The ONE sanctioned writer for this collection. Unlike logVisaActivity()
 * (VisaActivityLog.ts), this DOES throw on failure — a logging failure here
 * must be visible to the operator running the script, never swallowed: an
 * erasure that ran but left no record of who/why/what is exactly the gap
 * this collection exists to close.
 */
export async function recordVisaErasure(entry: RecordVisaErasureInput): Promise<VisaErasureLogDocument> {
  const [doc] = await VisaErasureLog.create([
    {
      scope: entry.scope,
      targetId: entry.targetId,
      workspaceId: entry.workspaceId,
      actorUserId: entry.actorUserId,
      actorEmail: entry.actorEmail,
      reason: entry.reason,
      counts: entry.counts,
      s3KeysDeleted: entry.s3KeysDeleted,
      cstepImpact: entry.cstepImpact ?? null,
      performedAt: new Date(),
    },
  ]);
  return doc;
}
