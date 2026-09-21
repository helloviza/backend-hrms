// apps/backend/src/models/plumconnect/CannedMessage.ts
//
// PlumConnect Track C — the editable store for every string the system
// sends on WhatsApp (bot questions, welcomes, handovers, re-asks, the
// intent menu, the consent prompts, the busy/away reply). One row per
// (key, line): line null is the global text for a key; a line row is a
// per-department override (services/plumconnect/messages.ts getMessage
// resolves line → global → the hardcoded seed default, so an unset or
// typo'd key never sends an empty message).
//
// The seed (scripts/plumconnect-seed-messages.ts) writes today's exact
// strings, so behaviour is byte-identical until someone edits. Text is
// plain with deterministic {placeholder} substitution only (the
// `variables` a key supports) — no templating engine, no LLM.

import mongoose, { Schema, type Document } from "mongoose";
import { ACCESS_LINES, type AccessLine } from "../../services/plumconnect/access.js";

export interface IPlumConnectCannedMessage extends Document {
  key: string;
  /** null = the global default for the key; a line = that department's override. */
  line: AccessLine | null;
  text: string;
  /** The {placeholders} this key's text may use (from the defaults; informational for the editor). */
  variables: string[];
  enabled: boolean;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const PlumConnectCannedMessageSchema = new Schema<IPlumConnectCannedMessage>(
  {
    key: { type: String, required: true, trim: true },
    line: { type: String, enum: [...ACCESS_LINES, null], default: null },
    text: { type: String, required: true },
    variables: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// One global row and at most one row per line, per key.
PlumConnectCannedMessageSchema.index({ key: 1, line: 1 }, { unique: true });

const PlumConnectCannedMessage =
  (mongoose.models.PlumConnectCannedMessage as mongoose.Model<IPlumConnectCannedMessage>) ||
  mongoose.model<IPlumConnectCannedMessage>("PlumConnectCannedMessage", PlumConnectCannedMessageSchema);

export default PlumConnectCannedMessage;
