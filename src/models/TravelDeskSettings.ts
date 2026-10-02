// apps/backend/src/models/TravelDeskSettings.ts
//
// The Plumtrips Travel Desk: which HOUSE staff work the approvals ops queue,
// who is Available / Away, and how new cases are allocated. One document
// (key "default") — the desk is Plumtrips-wide, not per customer workspace.
import mongoose, { Schema, Document } from "mongoose";

export type AllocationMode = "off" | "round_robin" | "least_busy";
export const ALLOCATION_MODES: AllocationMode[] = ["off", "round_robin", "least_busy"];

export interface TravelDeskAgent {
  userId: mongoose.Types.ObjectId;
  available: boolean;
}

export interface TravelDeskSettingsDocument extends Document {
  key: string;
  agents: TravelDeskAgent[];
  mode: AllocationMode;
  /** Try the customer's Account Manager (Customer.accountTeam.accountManager) first. */
  rmFirst: boolean;
  /** Round-robin pointer: the agent who got the last rotated case. */
  rrLastUserId?: mongoose.Types.ObjectId | null;
  updatedByEmail?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const AgentSchema = new Schema<TravelDeskAgent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    available: { type: Boolean, default: true },
  },
  { _id: false },
);

const TravelDeskSettingsSchema = new Schema<TravelDeskSettingsDocument>(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    agents: { type: [AgentSchema], default: [] },
    mode: { type: String, enum: ALLOCATION_MODES, default: "off" },
    rmFirst: { type: Boolean, default: true },
    rrLastUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedByEmail: { type: String },
  },
  { timestamps: true },
);

const TravelDeskSettings = mongoose.model<TravelDeskSettingsDocument>("TravelDeskSettings", TravelDeskSettingsSchema);
export default TravelDeskSettings;
