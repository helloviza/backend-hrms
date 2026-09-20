// apps/backend/src/services/plumconnect/conversationStore.ts
//
// PlumConnect Slice 2 — the dispatcher's writes to its OWN models (Contact /
// Conversation / Message). Nothing here touches a tenant collection or the
// expense chain's queues; the only tenant-adjacent write is Contact.refs.userId,
// which is a REFERENCE derived from a hard identity (User.waId — itself
// written only by the Slice-1 single writer).
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §4.

import mongoose from "mongoose";
import PlumConnectContact, { type ContactIdentityState } from "../../models/plumconnect/Contact.js";
import PlumConnectConversation, {
  type ConversationKind,
  type IPlumConnectConversation,
} from "../../models/plumconnect/Conversation.js";
import PlumConnectMessage, { MESSAGE_TYPES, type MessageType } from "../../models/plumconnect/Message.js";

/** The statuses under which a conversation is still "the current thread". */
const OPEN_STATUSES = ["OPEN", "PENDING"] as const;

export interface UpsertContactInput {
  phone: string; // canonical
  displayName?: string;
  identityState: ContactIdentityState;
  /** Set only from a hard identity. Never from a soft match. */
  hardUserId?: mongoose.Types.ObjectId | null;
  now?: Date;
}

/** Upsert the Contact for a canonical phone; refresh what this message tells us. */
export async function upsertContact(input: UpsertContactInput) {
  const now = input.now ?? new Date();
  const set: Record<string, unknown> = {
    lastSeenAt: now,
    identityState: input.identityState,
  };
  if (input.displayName) set.displayName = input.displayName;
  if (input.hardUserId) set["refs.userId"] = input.hardUserId;

  return PlumConnectContact.findOneAndUpdate(
    { phone: input.phone },
    { $set: set, $setOnInsert: { phone: input.phone, firstSeenAt: now } },
    { upsert: true, new: true },
  );
}

export interface OpenConversationInput {
  contactId: mongoose.Types.ObjectId;
  kind: ConversationKind;
  channelAccountId: string;
  /** Verbatim Meta referral, stored once (first message of a CTWA thread). */
  referralRaw?: unknown;
  now?: Date;
}

/**
 * The contact's current open thread, or a new one. An existing OPEN/PENDING
 * conversation is reused; its kind is only ever UPGRADED from
 * unknown/support to what this message implies (a CTWA click or a receipt
 * is a stronger signal than "someone said hi"), never downgraded. A
 * referral is recorded the first time one is seen on that thread.
 */
export async function openOrGetConversation(input: OpenConversationInput): Promise<IPlumConnectConversation> {
  const now = input.now ?? new Date();

  const existing = await PlumConnectConversation.findOne({
    contactId: input.contactId,
    status: { $in: [...OPEN_STATUSES] },
  }).sort({ lastMessageAt: -1, createdAt: -1 });

  if (existing) {
    const set: Record<string, unknown> = { lastInboundAt: now, lastMessageAt: now };
    if ((existing.kind === "unknown" || existing.kind === "support") && input.kind !== "unknown" && input.kind !== existing.kind) {
      set.kind = input.kind;
    }
    if (input.referralRaw && existing.referralRaw == null) set.referralRaw = input.referralRaw;
    if (!existing.channelAccountId && input.channelAccountId) set.channelAccountId = input.channelAccountId;
    await PlumConnectConversation.updateOne({ _id: existing._id }, { $set: set });
    Object.assign(existing, set);
    return existing;
  }

  return PlumConnectConversation.create({
    contactId: input.contactId,
    channel: "whatsapp",
    channelAccountId: input.channelAccountId,
    kind: input.kind,
    status: "OPEN",
    referralRaw: input.referralRaw ?? null,
    lastInboundAt: now,
    lastMessageAt: now,
  });
}

export interface AppendInboundInput {
  conversationId: mongoose.Types.ObjectId;
  externalId: string; // wamid
  type: string; // Meta message type; mapped onto MESSAGE_TYPES
  text?: string;
  payload?: unknown;
  now?: Date;
}

export function toMessageType(metaType: string): MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(metaType) ? (metaType as MessageType) : "unsupported";
}

/**
 * Persist an inbound message. The unique+sparse `externalId` is the
 * idempotency claim: a redelivered wamid returns { duplicate: true } and the
 * caller must do nothing else for it.
 */
export async function appendInbound(input: AppendInboundInput): Promise<{ duplicate: boolean; messageId: mongoose.Types.ObjectId | null }> {
  try {
    const doc = await PlumConnectMessage.create({
      conversationId: input.conversationId,
      direction: "INBOUND",
      channel: "whatsapp",
      externalId: input.externalId,
      type: toMessageType(input.type),
      text: input.text ?? "",
      payload: input.payload ?? null,
      sentAt: input.now ?? new Date(),
    });
    return { duplicate: false, messageId: doc._id as mongoose.Types.ObjectId };
  } catch (err: any) {
    if (err?.code === 11000) return { duplicate: true, messageId: null };
    throw err;
  }
}
