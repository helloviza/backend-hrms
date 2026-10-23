// apps/backend/src/models/cstep/CstepChangeRequest.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";
import { CSTEP_SERVICE_TYPES, type CstepServiceType } from "./CstepArrangement.js";

/**
 * CstepChangeRequest
 * ------------------
 * CSTEP Travel & Claim Portal — a cancel / rebook request against one
 * arranged service (CstepArrangement line) on an arranged trip. Raised by
 * the traveller or by their Official / a CSTEP Admin; resolved (DONE or
 * DECLINED, with a note) by the Official / a CSTEP Admin. This record only
 * TRACKS and ROUTES the change — the Travel Desk makes the actual booking
 * change by hand; nothing here calls a supplier API.
 *
 * While a change request is OPEN, its arrangement line is reopened for the
 * Official to edit even though the trip is past ARRANGING (routes/cstep.ts's
 * PATCH /requests/:id/arrangements/:lineId) — that is the whole "act on it"
 * mechanism; the line has no CANCELLED / RESCHEDULED state of its own.
 *
 * serviceType is a snapshot of the line's arrangedType at raise time, so the
 * queue reads right even if the Official later changes the line's type.
 * raisedLogId / resolvedLogId are the CstepApproval entries the raise and
 * resolve wrote — the notification dedupe keys.
 */

export const CSTEP_CHANGE_KINDS = ["CANCEL", "REBOOK"] as const;
export type CstepChangeKind = (typeof CSTEP_CHANGE_KINDS)[number];
export const CSTEP_CHANGE_STATUSES = ["OPEN", "DONE", "DECLINED"] as const;
export type CstepChangeStatus = (typeof CSTEP_CHANGE_STATUSES)[number];

export interface ICstepChangeRequest extends Document {
  workspaceId: mongoose.Types.ObjectId;
  travelRequestId: mongoose.Types.ObjectId; // ref CstepTravelRequest
  arrangementId: mongoose.Types.ObjectId; // ref CstepArrangement — the service to change
  serviceType: CstepServiceType; // snapshot of the line's arrangedType at raise time

  kind: CstepChangeKind;
  details: string; // new dates / route for a rebook, or what to cancel
  reason: string;

  status: CstepChangeStatus;
  raisedBy: mongoose.Types.ObjectId; // ref User
  raisedAt: Date;
  raisedLogId?: mongoose.Types.ObjectId; // ref CstepApproval
  handledBy?: mongoose.Types.ObjectId; // ref User
  handledAt?: Date;
  resolutionNote?: string;
  resolvedLogId?: mongoose.Types.ObjectId; // ref CstepApproval

  createdAt: Date;
  updatedAt: Date;
}

const CstepChangeRequestSchema = new Schema<ICstepChangeRequest>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    travelRequestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", required: true, index: true },
    arrangementId: { type: Schema.Types.ObjectId, ref: "CstepArrangement", required: true },
    serviceType: { type: String, enum: CSTEP_SERVICE_TYPES, required: true },

    kind: { type: String, enum: CSTEP_CHANGE_KINDS, required: true },
    details: { type: String, required: true, trim: true },
    reason: { type: String, required: true, trim: true },

    status: { type: String, enum: CSTEP_CHANGE_STATUSES, default: "OPEN", index: true },
    raisedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    raisedAt: { type: Date, required: true },
    raisedLogId: { type: Schema.Types.ObjectId },
    handledBy: { type: Schema.Types.ObjectId, ref: "User" },
    handledAt: { type: Date },
    resolutionNote: { type: String, trim: true },
    resolvedLogId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

// One OPEN change per arrangement line at a time — a second raise on the
// same line is refused (409) until the first is resolved.
CstepChangeRequestSchema.index(
  { workspaceId: 1, arrangementId: 1 },
  { unique: true, partialFilterExpression: { status: "OPEN" } },
);

CstepChangeRequestSchema.plugin(workspaceScopePlugin);

const CstepChangeRequest: Model<ICstepChangeRequest> =
  (mongoose.models.CstepChangeRequest as Model<ICstepChangeRequest>) ||
  mongoose.model<ICstepChangeRequest>("CstepChangeRequest", CstepChangeRequestSchema);

export default CstepChangeRequest;
