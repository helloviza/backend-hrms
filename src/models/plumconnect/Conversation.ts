// apps/backend/src/models/plumconnect/Conversation.ts
//
// PlumConnect Slice 0 — a thread between one Contact and Plumtrips on one
// channel account. Channel-agnostic by construction: `channel` is an enum
// with a single value today, and `channelAccountId` is the account on our
// side (for WhatsApp, Meta's phone_number_id — which the expense rows have
// stored since day one and nothing has ever read).
//
// This is a HOUSE-operated surface, like Lead: no workspaceId and no
// workspaceScopePlugin. The tenant of the person on the other end, when there
// is one, is reachable through Contact.refs.userId.
//
// `status` is the support lifecycle decided for v1 (OPEN / PENDING / RESOLVED)
// — a PlumConnect conversation IS the support record; it is not a Ticket.
// `referralRaw` keeps Meta's CTWA `message.referral` verbatim; the typed copy
// that survives conversion lives on Lead.attribution.
//
// Nothing writes this model in Slice 0.
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §2.

import mongoose, { Schema, type Document } from "mongoose";

export const CONVERSATION_CHANNELS = ["whatsapp"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export const CONVERSATION_KINDS = ["support", "lead", "expense", "arrival", "unknown"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_STATUSES = ["OPEN", "PENDING", "RESOLVED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

// "unparsed" — Slice 3c: the bot re-asked once and still could not parse the
// answer; it stops and leaves the step for a human.
export const BOT_STOP_REASONS = ["human", "complete", "timeout", "unparsed"] as const;
export type BotStopReason = (typeof BOT_STOP_REASONS)[number];

export interface IPlumConnectConversationBot {
  active: boolean;
  step: string;
  /** Re-asks on the CURRENT step (Slice 3c; reset when the step advances). */
  retries: number;
  stoppedBy?: BotStopReason | null;
  stoppedAt?: Date | null;
}

export interface IPlumConnectConversation extends Document {
  contactId: mongoose.Types.ObjectId;
  channel: ConversationChannel;
  channelAccountId: string;
  kind: ConversationKind;
  status: ConversationStatus;
  assignedTo?: mongoose.Types.ObjectId | null;
  leadId?: mongoose.Types.ObjectId | null;
  referralRaw?: unknown;
  bot: IPlumConnectConversationBot;
  lastInboundAt?: Date | null;
  lastOutboundAt?: Date | null;
  lastMessageAt?: Date | null;
  resolvedAt?: Date | null;
  resolvedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const BotSchema = new Schema<IPlumConnectConversationBot>(
  {
    active: { type: Boolean, default: false },
    step: { type: String, trim: true, default: "" },
    retries: { type: Number, default: 0 },
    stoppedBy: { type: String, enum: [...BOT_STOP_REASONS, null], default: null },
    stoppedAt: { type: Date, default: null },
  },
  { _id: false },
);

const PlumConnectConversationSchema = new Schema<IPlumConnectConversation>(
  {
    contactId: { type: Schema.Types.ObjectId, ref: "PlumConnectContact", required: true, index: true },
    channel: { type: String, enum: CONVERSATION_CHANNELS, default: "whatsapp" },
    channelAccountId: { type: String, trim: true, default: "" },
    kind: { type: String, enum: CONVERSATION_KINDS, default: "unknown" },
    status: { type: String, enum: CONVERSATION_STATUSES, default: "OPEN" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    referralRaw: { type: Schema.Types.Mixed, default: null },
    bot: { type: BotSchema, default: () => ({}) },
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// Dispatcher: "does this contact have an open thread?"
PlumConnectConversationSchema.index({ contactId: 1, status: 1 });
// Inbox list: newest activity first within a status column.
PlumConnectConversationSchema.index({ status: 1, lastMessageAt: -1 });
// Inbox "mine" filter.
PlumConnectConversationSchema.index({ assignedTo: 1, status: 1 });
// Lead detail → its conversation.
PlumConnectConversationSchema.index({ leadId: 1 }, { sparse: true });

const PlumConnectConversation =
  (mongoose.models.PlumConnectConversation as mongoose.Model<IPlumConnectConversation>) ||
  mongoose.model<IPlumConnectConversation>("PlumConnectConversation", PlumConnectConversationSchema);

export default PlumConnectConversation;
