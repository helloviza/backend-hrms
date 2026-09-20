// apps/backend/src/services/plumconnect/send.ts
//
// PlumConnect send-and-persist for the flows that KNOW their conversation
// (bot, consent, agent replies). Since Slice 4a this is a thin adapter over
// services/plumconnect/outbound.ts — the universal wrapper that persists
// every send, PlumConnect-originated or legacy, under PLUMCONNECT_ENABLED.
//
// Slice 3c captured the wamid with an axios response interceptor scoped by
// AsyncLocalStorage because the senders discarded Meta's response. The
// senders now return it (whatsappCloud.service.ts, Part A of 4a), so that
// plumbing is gone: no interceptor, no async context.
//
// Result shape is unchanged from 3c: { sent, wamid, messageId, persistFailed }.
// "Sent" = Meta returned a wamid; unconfigured / rejected → sent:false and
// nothing persisted. Persistence is best-effort and never breaks a send.

import type mongoose from "mongoose";
import type { ReplyButton } from "../whatsappCloud.service.js";
import { sendTextOutcome, sendButtonsOutcome, type SendOrigin } from "./outbound.js";

export interface SendAndPersistInput {
  conversationId: mongoose.Types.ObjectId;
  /** Meta recipient — bare digits (the canonical phone). */
  to: string;
  /** Plain text, or text + up to 3 reply buttons. */
  text: string;
  buttons?: ReplyButton[];
  /** Who is speaking: the bot / consent flow (null) or an agent (Slice 4b). */
  authorUserId?: mongoose.Types.ObjectId | null;
  /** Free-form provenance for the Message.payload (bot step, prompt kind, …). */
  payload?: Record<string, unknown>;
  /** Defaults to "bot"; consent and agent sends say so. */
  origin?: SendOrigin;
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
  const meta = {
    origin: input.origin ?? ("bot" as const),
    conversationId: input.conversationId,
    authorUserId: input.authorUserId ?? null,
    payload: input.payload,
    now: input.now,
  };
  const { outcome, persisted } =
    input.buttons && input.buttons.length > 0
      ? await sendButtonsOutcome(input.to, input.text, input.buttons, meta)
      : await sendTextOutcome(input.to, input.text, meta);

  const sent = outcome.ok && Boolean(outcome.wamid);
  return { sent, wamid: sent ? outcome.wamid : null, messageId: persisted.messageId, persistFailed: persisted.persistFailed };
}
