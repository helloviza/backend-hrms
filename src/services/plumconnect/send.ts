// apps/backend/src/services/plumconnect/send.ts
//
// PlumConnect Slice 3c, Part A — the ONE outbound path PlumConnect uses:
// send through the existing whatsappCloud senders, then persist ONE
// OUTBOUND Message on the conversation with the wamid Meta returned.
//
// Constraints this satisfies at once:
//   • whatsappCloud.service.ts is not changed by a single line. The senders
//     are imported and called as-is; nothing about WHAT is sent changes.
//   • The wamid comes from the real Graph response (data.messages[0].id).
//     The senders discard that response (dispatch audit §F), so it is read
//     here by an axios RESPONSE INTERCEPTOR that is inert unless a
//     sendAndPersist() call is on the async stack (AsyncLocalStorage). It
//     never alters a response and never fires for anyone else's request.
//     The Slice-4 service-layer wrapper (which persists EVERY send, legacy
//     included) supersedes this; until then this is the only capture.
//   • Persistence is best-effort: a failed Message write is logged, the
//     send still counts as sent, and nothing is retried — a persistence
//     failure can never break or double a send.
//
// "Sent" means Meta accepted the message, i.e. a wamid came back. When the
// Cloud API is not configured the senders skip silently (their own
// behaviour) and no wamid arrives → { sent: false }, nothing persisted.
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §5, §6 (D5), §9.

import { AsyncLocalStorage } from "node:async_hooks";
import axios from "axios";
import type mongoose from "mongoose";
import { sendTextMessage, sendButtonMessage, type ReplyButton } from "../whatsappCloud.service.js";
import PlumConnectMessage, { type MessageType } from "../../models/plumconnect/Message.js";
import PlumConnectConversation from "../../models/plumconnect/Conversation.js";
import { whatsappLogger } from "../../utils/logger.js";

interface SendContext {
  wamid: string | null;
}

const sendContext = new AsyncLocalStorage<SendContext>();

// Registered once per process. Reads the wamid off a Cloud API "/messages"
// response ONLY when a sendAndPersist() context is active; passes every
// response through untouched either way.
axios.interceptors.response.use((response) => {
  const ctx = sendContext.getStore();
  if (ctx && !ctx.wamid) {
    const url = String(response?.config?.url ?? "");
    const id = response?.data?.messages?.[0]?.id;
    if (/\/messages$/.test(url) && typeof id === "string" && id) ctx.wamid = id;
  }
  return response;
});

export interface SendAndPersistInput {
  conversationId: mongoose.Types.ObjectId;
  /** Meta recipient — bare digits (the canonical phone). */
  to: string;
  /** Plain text, or text + up to 3 reply buttons. */
  text: string;
  buttons?: ReplyButton[];
  /** Who is speaking: the bot / consent flow (null) or an agent (Slice 4). */
  authorUserId?: mongoose.Types.ObjectId | null;
  /** Free-form provenance for the Message.payload (bot step, prompt kind, …). */
  payload?: Record<string, unknown>;
  now?: Date;
}

export interface SendAndPersistResult {
  sent: boolean;
  wamid: string | null;
  messageId: mongoose.Types.ObjectId | null;
  /** true when the send happened but the Message row could not be written. */
  persistFailed: boolean;
}

export async function sendAndPersist(input: SendAndPersistInput): Promise<SendAndPersistResult> {
  const now = input.now ?? new Date();
  const ctx: SendContext = { wamid: null };

  await sendContext.run(ctx, async () => {
    if (input.buttons && input.buttons.length > 0) {
      await sendButtonMessage(input.to, input.text, input.buttons);
    } else {
      await sendTextMessage(input.to, input.text);
    }
  });

  if (!ctx.wamid) {
    // Not configured, or Meta rejected it — the senders already logged why.
    return { sent: false, wamid: null, messageId: null, persistFailed: false };
  }

  const type: MessageType = input.buttons && input.buttons.length > 0 ? "interactive" : "text";
  try {
    const doc = await PlumConnectMessage.create({
      conversationId: input.conversationId,
      direction: "OUTBOUND",
      channel: "whatsapp",
      externalId: ctx.wamid,
      type,
      text: input.text,
      payload: { ...(input.payload ?? {}), buttons: input.buttons?.map((b) => b.id) },
      authorUserId: input.authorUserId ?? null,
      visibleToContact: true,
      deliveryStatus: "sent",
      sentAt: now,
    });
    await PlumConnectConversation.updateOne(
      { _id: input.conversationId },
      { $set: { lastOutboundAt: now, lastMessageAt: now } },
    ).catch(() => undefined);
    return { sent: true, wamid: ctx.wamid, messageId: doc._id as mongoose.Types.ObjectId, persistFailed: false };
  } catch (err) {
    whatsappLogger.error("PlumConnect: sent but could not persist the outbound Message", {
      conversationId: String(input.conversationId),
      wamid: ctx.wamid,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: true, wamid: ctx.wamid, messageId: null, persistFailed: true };
  }
}
