// apps/backend/src/models/plumconnect/AgentPresence.ts
//
// PlumConnect Track A — an agent's active / away state PER DEPARTMENT LINE
// (the four Slice 7 capabilities: plumtrips | helloviza | concierge |
// support). One row per (user, line); a user can be active on helloviza
// and away on plumtrips at the same time.
//
// Default is AWAY: no row = not active, and a row only counts while it is
// fresh (services/plumconnect/presence.ts — auto-away after the TTL,
// computed on read, no sweep) AND the user still holds the line's grant.
// Presence is opt-in: an agent is only "available" once they explicitly go
// active, so the safe default is "not receiving".
//
// Its own collection, keyed by userId, rather than a field on User or
// UserPermission: User is identity, UserPermission is the grant — this is
// runtime state that changes many times a day and must never touch either.
// Track B (the routing matrix) READS this; nothing routes on it yet.

import mongoose, { Schema, type Document } from "mongoose";
import { ACCESS_LINES, type AccessLine } from "../../services/plumconnect/access.js";

export interface IPlumConnectAgentPresence extends Document {
  userId: mongoose.Types.ObjectId;
  line: AccessLine;
  active: boolean;
  /** When the current active stretch began (null while away). */
  activeSince?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PlumConnectAgentPresenceSchema = new Schema<IPlumConnectAgentPresence>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    line: { type: String, enum: ACCESS_LINES, required: true },
    active: { type: Boolean, default: false },
    activeSince: { type: Date, default: null },
  },
  { timestamps: true },
);

// One row per (user, line).
PlumConnectAgentPresenceSchema.index({ userId: 1, line: 1 }, { unique: true });
// Track B's read: who is active on a line, freshest first.
PlumConnectAgentPresenceSchema.index({ line: 1, active: 1, updatedAt: -1 });

const PlumConnectAgentPresence =
  (mongoose.models.PlumConnectAgentPresence as mongoose.Model<IPlumConnectAgentPresence>) ||
  mongoose.model<IPlumConnectAgentPresence>("PlumConnectAgentPresence", PlumConnectAgentPresenceSchema);

export default PlumConnectAgentPresence;
