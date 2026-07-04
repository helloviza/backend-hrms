// apps/backend/src/models/TripWatch.ts
//
// A traveler-opted-in watch over a single booked flight. Workspace-scoped.
// departDate is parsed ONCE at creation into a proper Date (Amendment I) so the
// worker's window query never re-parses booking strings.

import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface ITripWatch extends Document {
  workspaceId: mongoose.Types.ObjectId;
  bookingId?: mongoose.Types.ObjectId;
  sbtRequestId?: mongoose.Types.ObjectId;
  flightNo: string;
  carrier: string;
  origin: string;
  destination: string;
  departDate: Date; // UTC, parsed once at creation
  travelerUserId?: mongoose.Types.ObjectId;
  notifyChannel: "WHATSAPP" | "EMAIL";
  notifyTarget: string;
  fallbackEmail?: string | null;
  optInAt: Date;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  lastCheckedAt?: Date | null;
  lastKnownState?: any;
  claimedBy?: string | null;
  claimedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const TripWatchSchema = new Schema<ITripWatch>(
  {
    // workspaceId added by workspaceScopePlugin.
    bookingId: { type: Schema.Types.ObjectId, ref: "SBTBooking", default: null },
    sbtRequestId: { type: Schema.Types.ObjectId, ref: "SBTRequest", default: null, index: true },
    flightNo: { type: String, required: true },
    carrier: { type: String, default: "" },
    origin: { type: String, default: "" },
    destination: { type: String, default: "" },
    departDate: { type: Date, required: true },
    travelerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    notifyChannel: { type: String, enum: ["WHATSAPP", "EMAIL"], required: true },
    notifyTarget: { type: String, required: true },
    fallbackEmail: { type: String, default: null },
    optInAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["ACTIVE", "COMPLETED", "CANCELLED"], default: "ACTIVE", index: true },
    lastCheckedAt: { type: Date, default: null },
    lastKnownState: { type: Object, default: null },
    claimedBy: { type: String, default: null },
    claimedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

TripWatchSchema.plugin(workspaceScopePlugin);
// Worker claim/window query.
TripWatchSchema.index({ status: 1, departDate: 1, lastCheckedAt: 1 });

const TripWatch =
  (mongoose.models.TripWatch as mongoose.Model<ITripWatch>) ||
  mongoose.model<ITripWatch>("TripWatch", TripWatchSchema);

export default TripWatch;
