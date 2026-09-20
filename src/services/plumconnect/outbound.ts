// apps/backend/src/services/plumconnect/outbound.ts
//
// PlumConnect Slice 4a — the universal outbound wrapper.
//
// Every WhatsApp Cloud API message send in the backend goes through here:
// the PlumConnect flows (bot, consent — via send.ts) and the legacy flows
// (expense worker, arrival concierge, trip notifier) alike. The wrapper
//   1. calls the SAME sender in whatsappCloud.service.ts the caller always
//      called, with the same arguments — the wire is byte-identical, and the
//      caller gets back the same value shape it always got (void, boolean,
//      { sent, error });
//   2. ONLY under PLUMCONNECT_ENABLED, persists ONE OUTBOUND Message with the
//      wamid Meta returned, on the recipient's Conversation. For a
//      PlumConnect-originated send the conversation is given; for a legacy
//      send it is resolved-or-created from the recipient phone, with a kind
//      that reflects the origin (expense / arrival / trip).
//   3. never lets persistence break or double a send: a failed Message write
//      is logged and the send still counts as sent — the same rule Slice 3c
//      set. Persistence is entirely after the fact.
//
// With the flag OFF this module is a pass-through: zero reads, zero writes.
//
// This replaces Slice 3c's axios response interceptor + AsyncLocalStorage
// capture; the senders now return their outcome directly (Part A).
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §6 (D5), §9.

import mongoose from "mongoose";
import { isPlumConnectEnabled } from "../../config/plumconnect.js";
import { env } from "../../config/env.js";
import {
  sendTextMessage as cloudSendTextMessage,
  sendTextMessageResultOutcome as cloudSendTextMessageResultOutcome,
  sendTemplateMessageOutcome as cloudSendTemplateMessageOutcome,
  sendButtonMessage as cloudSendButtonMessage,
  sendTemplateWithImageHeader as cloudSendTemplateWithImageHeader,
  type ReplyButton,
  type SendOutcome,
  type TemplateSendResult,
} from "../whatsappCloud.service.js";
import { toCanonical } from "../../utils/phone.js";
import PlumConnectContact from "../../models/plumconnect/Contact.js";
import PlumConnectConversation, { type ConversationKind } from "../../models/plumconnect/Conversation.js";
import PlumConnectMessage, { type MessageType } from "../../models/plumconnect/Message.js";
import { openOrGetConversation } from "./conversationStore.js";
import { whatsappLogger } from "../../utils/logger.js";

/** Where a send comes from — decides the Conversation kind for a legacy send. */
export type SendOrigin = "expense" | "arrival" | "trip" | "bot" | "consent" | "support" | "agent";

const KIND_FOR_ORIGIN: Record<SendOrigin, ConversationKind> = {
  expense: "expense",
  arrival: "arrival",
  trip: "trip",
  bot: "lead",
  consent: "support",
  support: "support",
  agent: "support",
};

export interface PersistMeta {
  origin: SendOrigin;
  /** Known thread (PlumConnect-originated sends). Legacy sends leave it unset. */
  conversationId?: mongoose.Types.ObjectId | null;
  /** The agent, for a human reply (Slice 4b). null for bots and legacy flows. */
  authorUserId?: mongoose.Types.ObjectId | null;
  /** Free-form provenance for Message.payload. */
  payload?: Record<string, unknown>;
  now?: Date;
}

export interface PersistedSend {
  /** Set when a Message row was written. */
  messageId: mongoose.Types.ObjectId | null;
  /** true when the send happened but persistence failed. */
  persistFailed: boolean;
}

/* ───────────────────────────── persistence ───────────────────────────── */

/** Resolve-or-create the Contact for a recipient. Never overwrites identity. */
async function ensureContact(canonical: string, now: Date) {
  return PlumConnectContact.findOneAndUpdate(
    { phone: canonical },
    { $set: { lastSeenAt: now }, $setOnInsert: { phone: canonical, firstSeenAt: now, identityState: "unknown" } },
    { upsert: true, new: true },
  );
}

async function resolveConversationId(to: string, meta: PersistMeta, now: Date): Promise<mongoose.Types.ObjectId | null> {
  if (meta.conversationId) return meta.conversationId;
  const canonical = toCanonical(to);
  if (!canonical) return null;
  const contact = await ensureContact(canonical, now);
  const conversation = await openOrGetConversation({
    contactId: contact._id as mongoose.Types.ObjectId,
    kind: KIND_FOR_ORIGIN[meta.origin],
    channelAccountId: env.WA_PHONE_NUMBER_ID,
    now,
  });
  return conversation._id as mongoose.Types.ObjectId;
}

interface Persistable {
  to: string;
  type: MessageType;
  text: string;
  payload: Record<string, unknown>;
  outcome: SendOutcome;
}

/**
 * Persist an outcome as an OUTBOUND Message. Flag-gated; best-effort; never
 * throws. Nothing is written for a send Meta did not accept (no wamid).
 */
export async function persistSend(p: Persistable, meta: PersistMeta): Promise<PersistedSend> {
  const none: PersistedSend = { messageId: null, persistFailed: false };
  if (!isPlumConnectEnabled()) return none;
  // A sender that returned nothing (a test double, or a pre-4a shape) is
  // simply "no outcome to persist" — never a crash on the send path.
  if (!p.outcome || !p.outcome.ok || !p.outcome.wamid) return none;
  const now = meta.now ?? new Date();
  try {
    const conversationId = await resolveConversationId(p.to, meta, now);
    if (!conversationId) return none;
    const doc = await PlumConnectMessage.create({
      conversationId,
      direction: "OUTBOUND",
      channel: "whatsapp",
      externalId: p.outcome.wamid,
      type: p.type,
      text: p.text,
      payload: { origin: meta.origin, ...p.payload, ...(meta.payload ?? {}) },
      authorUserId: meta.authorUserId ?? null,
      visibleToContact: true,
      deliveryStatus: "sent",
      sentAt: now,
    });
    await PlumConnectConversation.updateOne({ _id: conversationId }, { $set: { lastOutboundAt: now, lastMessageAt: now } }).catch(() => undefined);
    return { messageId: doc._id as mongoose.Types.ObjectId, persistFailed: false };
  } catch (err) {
    whatsappLogger.error("PlumConnect outbound: sent but could not persist the Message", {
      origin: meta.origin,
      to: p.to,
      wamid: p.outcome.wamid,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messageId: null, persistFailed: true };
  }
}

/* ───────────────────────────── outcome-returning wrapper ───────────────────────────── */

export interface WrappedSend {
  outcome: SendOutcome;
  persisted: PersistedSend;
}

export async function sendTextOutcome(to: string, body: string, meta: PersistMeta): Promise<WrappedSend> {
  const outcome = await cloudSendTextMessage(to, body);
  const persisted = await persistSend({ to, type: "text", text: body, payload: {}, outcome }, meta);
  return { outcome, persisted };
}

export async function sendTextResultOutcome(to: string, body: string, meta: PersistMeta): Promise<WrappedSend> {
  const outcome = await cloudSendTextMessageResultOutcome(to, body);
  const persisted = await persistSend({ to, type: "text", text: body, payload: {}, outcome }, meta);
  return { outcome, persisted };
}

export async function sendButtonsOutcome(to: string, body: string, buttons: ReplyButton[], meta: PersistMeta): Promise<WrappedSend> {
  const outcome = await cloudSendButtonMessage(to, body, buttons);
  const hasButtons = (buttons || []).length > 0;
  const persisted = await persistSend(
    { to, type: hasButtons ? "interactive" : "text", text: body, payload: { buttons: hasButtons ? buttons.slice(0, 3).map((b) => b.id) : undefined }, outcome },
    meta,
  );
  return { outcome, persisted };
}

export async function sendTemplateOutcome(
  to: string,
  templateName: string,
  bodyParams: string[],
  languageCode: string | undefined,
  meta: PersistMeta,
): Promise<WrappedSend> {
  const outcome = await cloudSendTemplateMessageOutcome(to, templateName, bodyParams, languageCode ?? "en");
  const persisted = await persistSend(
    { to, type: "template", text: `[template ${templateName}] ${(bodyParams || []).join(" · ")}`, payload: { template: templateName, params: bodyParams, language: languageCode ?? "en" }, outcome },
    meta,
  );
  return { outcome, persisted };
}

/* ───────────────────────────── legacy-shaped facades ───────────────────────────── */

/**
 * The senders a legacy caller imported from whatsappCloud.service.ts, with
 * IDENTICAL names, parameters and return values, bound to an origin. A caller
 * swaps one import line and changes nothing else:
 *
 *   const { sendTextMessage, sendButtonMessage } = outboundFor("expense");
 */
export function outboundFor(origin: SendOrigin) {
  const meta = (): PersistMeta => ({ origin });
  return {
    /** was Promise<void>; the outcome is now returned but no legacy caller reads it */
    sendTextMessage: async (to: string, body: string): Promise<SendOutcome> => (await sendTextOutcome(to, body, meta())).outcome,
    sendTextMessageResult: async (to: string, body: string): Promise<boolean> => (await sendTextResultOutcome(to, body, meta())).outcome.ok,
    sendTemplateMessage: async (to: string, templateName: string, bodyParams: string[], languageCode = "en"): Promise<boolean> =>
      (await sendTemplateOutcome(to, templateName, bodyParams, languageCode, meta())).outcome.ok,
    sendButtonMessage: async (to: string, body: string, buttons: ReplyButton[]): Promise<SendOutcome> =>
      (await sendButtonsOutcome(to, body, buttons, meta())).outcome,
    sendTemplateWithImageHeader: async (
      to: string,
      templateName: string,
      langCode: string,
      headerMediaId: string,
      bodyParams: string[],
    ): Promise<TemplateSendResult> => {
      const result = await cloudSendTemplateWithImageHeader(to, templateName, langCode, headerMediaId, bodyParams);
      await persistSend(
        {
          to,
          type: "template",
          text: `[template ${templateName}] ${(bodyParams || []).join(" · ")}`,
          payload: { template: templateName, params: bodyParams, language: langCode, headerMediaId },
          outcome: { ok: result.sent, wamid: result.wamid ?? null, raw: result.raw ?? null, error: result.error },
        },
        meta(),
      );
      return result;
    },
  };
}
