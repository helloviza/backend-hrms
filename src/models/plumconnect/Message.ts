// apps/backend/src/models/plumconnect/Message.ts
//
// PlumConnect Slice 0 — one row per message in a Conversation, in BOTH
// directions. This is the thread model the repo has lacked: inbound WhatsApp
// today is persisted only as per-wamid job rows (ExpenseCapture /
// ExpenseReply) and outbound is not persisted at all
// (docs/audits/whatsapp-inbound-dispatch-audit.md §F).
//
// `externalId` is the channel's message id — for WhatsApp the wamid, from
// message.id inbound and from Graph's data.messages[0].id outbound. Unique so
// a redelivered webhook or a retried send can never double-insert; sparse so
// a system row or an internal note, which has no wamid, is never blocked.
//
// `visibleToContact` is a plain flag rather than TicketMessage's
// visibleToConsumer allow-list: default true, and an agent's internal note is
// the one thing that sets it false.
//
// Nothing writes this model in Slice 0.
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §2.

import mongoose, { Schema, type Document } from "mongoose";
import { CONVERSATION_CHANNELS, type ConversationChannel } from "./Conversation.js";

export const MESSAGE_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_TYPES = [
  "text",
  "interactive",
  "image",
  "document",
  "template",
  "button",
  "system",
  "note",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_DELIVERY_STATUSES = ["queued", "sent", "delivered", "read", "failed"] as const;
export type MessageDeliveryStatus = (typeof MESSAGE_DELIVERY_STATUSES)[number];

export interface IPlumConnectMessage extends Document {
  conversationId: mongoose.Types.ObjectId;
  direction: MessageDirection;
  channel: ConversationChannel;
  externalId?: string;
  type: MessageType;
  text: string;
  payload?: unknown;
  authorUserId?: mongoose.Types.ObjectId | null;
  visibleToContact: boolean;
  deliveryStatus?: MessageDeliveryStatus | null;
  sentAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PlumConnectMessageSchema = new Schema<IPlumConnectMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "PlumConnectConversation",
      required: true,
      index: true,
    },
    direction: { type: String, enum: MESSAGE_DIRECTIONS, required: true },
    channel: { type: String, enum: CONVERSATION_CHANNELS, default: "whatsapp" },
    externalId: { type: String, trim: true, unique: true, sparse: true },
    type: { type: String, enum: MESSAGE_TYPES, required: true },
    text: { type: String, default: "" },
    // Button id, media id, template name + params, referral, context — whatever
    // the channel attached that is not plain text.
    payload: { type: Schema.Types.Mixed, default: null },
    // The agent, for an OUTBOUND human reply or a "note". null for the bot,
    // the system, and every inbound row.
    authorUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    visibleToContact: { type: Boolean, default: true },
    deliveryStatus: { type: String, enum: [...MESSAGE_DELIVERY_STATUSES, null], default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Thread read: one conversation, oldest first.
PlumConnectMessageSchema.index({ conversationId: 1, createdAt: 1 });

const PlumConnectMessage =
  (mongoose.models.PlumConnectMessage as mongoose.Model<IPlumConnectMessage>) ||
  mongoose.model<IPlumConnectMessage>("PlumConnectMessage", PlumConnectMessageSchema);

export default PlumConnectMessage;
