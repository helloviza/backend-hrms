// apps/backend/src/models/cstep/CstepEvent.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepEvent
 * ----------
 * The CSTEP Event Master (#15) — the named events a request can be tagged to
 * ("Related to an event? Yes" on any intake form), so spend can be seen per
 * event (GET /cstep/reports/event-spend). Managed by a CSTEP Admin
 * (routes/cstep.events.ts), modelled on the Project Master: eventCode is
 * CSTEP's own code, typed by the Admin, unique per workspace and fixed once
 * created. A request keeps a snapshot of the chosen event
 * (CstepTravelRequest.eventCode / eventName), so a later rename here never
 * rewrites it. Reporting-only — not a Tally cost centre (yet).
 */
export interface ICstepEvent extends Document {
  workspaceId: mongoose.Types.ObjectId;
  eventCode: string;
  eventName: string;
  startDate?: string; // "YYYY-MM-DD"
  endDate?: string; // "YYYY-MM-DD"
  location?: string;
  isActive: boolean;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CstepEventSchema = new Schema<ICstepEvent>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    eventCode: { type: String, required: true, trim: true, uppercase: true },
    eventName: { type: String, required: true, trim: true },
    startDate: { type: String },
    endDate: { type: String },
    location: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true },
);

CstepEventSchema.index({ workspaceId: 1, eventCode: 1 }, { unique: true });

CstepEventSchema.plugin(workspaceScopePlugin);

const CstepEvent =
  (mongoose.models.CstepEvent as mongoose.Model<ICstepEvent>) ||
  mongoose.model<ICstepEvent>("CstepEvent", CstepEventSchema);

export default CstepEvent;
