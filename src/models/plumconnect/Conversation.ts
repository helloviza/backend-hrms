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

// "trip" — Slice 4a: flight-disruption alerts from the trip notifier, so a
// legacy send has a thread of the right kind to land on.
export const CONVERSATION_KINDS = ["support", "lead", "expense", "arrival", "trip", "unknown"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_STATUSES = ["OPEN", "PENDING", "RESOLVED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

// "unparsed" — Slice 3c: the bot re-asked once and still could not parse the
// answer; it stops and leaves the step for a human.
// Slice 5 — Stage-1 routing. businessLine = WHAT the contact wants; campaign
// lineage (Slice 8) = WHERE they came from. Orthogonal by design: intent
// classification never reads attribution and attribution never reads intent.
export const BUSINESS_LINES = ["plumtrips", "helloviza", "concierge"] as const;
export type BusinessLine = (typeof BUSINESS_LINES)[number];
export const INTENT_SOURCES = ["keyword", "menu", "campaign_map"] as const;
export type IntentSource = (typeof INTENT_SOURCES)[number];

export const BOT_STOP_REASONS = ["human", "complete", "timeout", "unparsed"] as const;
export type BotStopReason = (typeof BOT_STOP_REASONS)[number];

// Track B — how the assignment matrix last routed this thread. Additive,
// defaults empty; a pre-Track-B thread reads state "".
//   assigned  assignedTo was set by the router (autoAssigned: true — NOT a
//             human takeover, so the qualification bot keeps running)
//   tie       two+ mapped agents at the same priority were eligible: left
//             UNASSIGNED, `candidates` are the tied agents; first to take wins
//   held      nobody mapped / nobody eligible: OPEN + unassigned, awaiting
//             an agent; re-resolved on the unassigned queue's read
export const ROUTING_STATES = ["", "assigned", "tie", "held"] as const;
export type RoutingState = (typeof ROUTING_STATES)[number];

export interface IPlumConnectConversationRouting {
  state: RoutingState;
  targetType: string;
  targetKey: string;
  candidates: mongoose.Types.ObjectId[];
  autoAssigned: boolean;
  resolvedAt?: Date | null;
  reason: string;
  /** How many agents the target had mapped when last resolved (0 = matrix not configured for it). */
  mapped: number;
  /** Track C: when the busy/away reply went out (once per held thread; null = never). */
  busySentAt?: Date | null;
}

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
  /** Slice 5 — set once the Intent Engine has routed the thread; null until then. */
  businessLine?: BusinessLine | null;
  intent: string;
  intentSource?: IntentSource | null;
  intentConfidence?: number | null;
  /** When the interactive intent menu was last sent (null = never). */
  intentMenuSentAt?: Date | null;
  bot: IPlumConnectConversationBot;
  routing: IPlumConnectConversationRouting;
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

const RoutingSchema = new Schema<IPlumConnectConversationRouting>(
  {
    state: { type: String, enum: ROUTING_STATES, default: "" },
    targetType: { type: String, trim: true, default: "" },
    targetKey: { type: String, trim: true, default: "" },
    candidates: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
    autoAssigned: { type: Boolean, default: false },
    resolvedAt: { type: Date, default: null },
    reason: { type: String, trim: true, default: "" },
    mapped: { type: Number, default: 0 },
    busySentAt: { type: Date, default: null },
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
    // Slice 5 — additive, all default null / "".
    businessLine: { type: String, enum: [...BUSINESS_LINES, null], default: null },
    intent: { type: String, trim: true, default: "" },
    intentSource: { type: String, enum: [...INTENT_SOURCES, null], default: null },
    intentConfidence: { type: Number, default: null },
    intentMenuSentAt: { type: Date, default: null },
    bot: { type: BotSchema, default: () => ({}) },
    routing: { type: RoutingSchema, default: () => ({}) },
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
// Department queues (Slice 5): the inbox filters by business line.
PlumConnectConversationSchema.index({ businessLine: 1 }, { sparse: true });
// Track B: the unassigned queue's re-resolve, and "surfaced to the tied agents".
PlumConnectConversationSchema.index({ "routing.state": 1, assignedTo: 1, status: 1 });
PlumConnectConversationSchema.index({ "routing.candidates": 1 }, { sparse: true });

const PlumConnectConversation =
  (mongoose.models.PlumConnectConversation as mongoose.Model<IPlumConnectConversation>) ||
  mongoose.model<IPlumConnectConversation>("PlumConnectConversation", PlumConnectConversationSchema);

export default PlumConnectConversation;
