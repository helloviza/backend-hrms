// apps/backend/src/models/PlutoConversation.ts
//
// Capstone — durable, TENANT-SCOPED conversation memory (closes audit RED #1).
// The PRD memory key is {workspaceId, conversationId, userId}. Uniqueness is on
// {workspaceId, conversationId} (a conversationId is unique WITHIN a workspace,
// never globally — so another tenant's id can never collide or be read). userId
// records the originator and is NOT part of the uniqueness constraint.
//
// handoffDelivered is promoted to a top-level field: it is the authoritative,
// server-side, cross-instance dedup home for the AI handoff.

import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const TTL_DAYS = Number(process.env.PLUTO_CONVERSATION_TTL_DAYS) || 30;

export interface IPlutoConversation extends Document {
  workspaceId: mongoose.Types.ObjectId;
  conversationId: string; // client-facing id (scoped by workspaceId)
  userId?: mongoose.Types.ObjectId | null;
  context: any; // the conversation-context bag written by runConciergeTurn
  handoffDelivered: boolean;
  lastTurnAt: Date;
  createdAt: Date;
}

const PlutoConversationSchema = new Schema<IPlutoConversation>({
  // workspaceId added by workspaceScopePlugin (ObjectId, required, indexed).
  conversationId: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  context: { type: Schema.Types.Mixed, default: {} },
  handoffDelivered: { type: Boolean, default: false },
  lastTurnAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

PlutoConversationSchema.plugin(workspaceScopePlugin);
// A conversationId is unique WITHIN a workspace — the read scope + leak guard.
PlutoConversationSchema.index({ workspaceId: 1, conversationId: 1 }, { unique: true });
// TTL: conversations self-prune 30 days after the last turn (env-overridable).
PlutoConversationSchema.index({ lastTurnAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 });

const PlutoConversation =
  (mongoose.models.PlutoConversation as mongoose.Model<IPlutoConversation>) ||
  mongoose.model<IPlutoConversation>("PlutoConversation", PlutoConversationSchema);

export default PlutoConversation;
