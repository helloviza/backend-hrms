// apps/backend/src/services/plumconnect/dispatch.ts
//
// PlumConnect Slice 2 — the context-first inbound dispatcher (D4).
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §4, §9;
// docs/plumconnect/EXPENSE_SEAM_RECHECK.md.
//
// Runs on the webhook path, ONLY when PLUMCONNECT_ENABLED=true, AFTER the
// signature check and AFTER the arrival-concierge branch (which `continue`s
// before we are reached — arrival keeps its own security model untouched).
//
// Precedence — the first that applies wins:
//   1. IN-FLOW EXPENSE  a fresh (non-stale) expense capture/session for this
//                       sender AND a hard identity      → hand to the chain
//   2. CTWA REFERRAL    message.referral present         → lead conversation
//                       (Slice 3 owns the lead; here the thread + raw referral)
//   3. VERIFIED         hard identity (ACTIVE User.waId) → hand to the chain
//   4. SUPPORT          everything else                  → support conversation,
//                       OPEN, no expense row, no expense-bot reply.
//                       THIS REPLACES the legacy "default to expense".
//
// Hard invariant (plan §9): the chain's enqueuers are called through
// enqueueForChain(), which refuses without a hard identity. Soft matches
// (User.phone / TravellerProfile / Consumer / CRMContact) only label the
// Contact — they never enqueue and never touch a workspaceId. The chain
// itself re-resolves identity (User.waId) and assigns workspaceId exactly
// as it does for the legacy path; this file decides WHO reaches the
// enqueue, nothing more.
//
// This slice sends nothing. The consent prompt for soft-matched employees
// and the qualification bot are Slice 3; human replies are Slice 4.

import type mongoose from "mongoose";
import { toCanonical } from "../../utils/phone.js";
import { resolveIdentity, type IdentityResolution } from "./resolveIdentity.js";
import { readExpenseInFlow, type ExpenseInFlow } from "./expenseInFlow.js";
import { upsertContact, openOrGetConversation, appendInbound } from "./conversationStore.js";
import { enqueueExpenseReply, enqueueExpenseButton, enqueueExpenseCapture, type EnqueueResult } from "./enqueueExpense.js";
import type { ConversationKind } from "../../models/plumconnect/Conversation.js";
import { whatsappLogger } from "../../utils/logger.js";

/* ───────────────────────────── envelope ───────────────────────────── */

export interface InboundMedia {
  id: string;
  mime: string;
  mediaType: "image" | "document";
  filename?: string;
  caption?: string;
}

/** One parsed inbound message plus the bits of `value` the router needs. */
export interface InboundEnvelope {
  phoneNumberId: string;
  /** Meta's `from` — bare digits. Passed to the chain VERBATIM. */
  from: string;
  messageId: string;
  type: string;
  text: string;
  buttonId: string;
  media: InboundMedia | null;
  referral: unknown | null;
  context: unknown | null;
  profileName: string;
  timestamp: string;
}

/** Build the envelope from a raw Meta message + its enclosing `value`. Pure. */
export function buildInboundEnvelope(message: any, value: any, phoneNumberId: string): InboundEnvelope {
  const type: string = message?.type ?? "";
  const from: string = message?.from ?? "";
  const inter = message?.interactive ?? {};
  const contacts: any[] = Array.isArray(value?.contacts) ? value.contacts : [];
  const profile = contacts.find((c) => c?.wa_id === from)?.profile?.name ?? "";

  let media: InboundMedia | null = null;
  if (type === "image" || type === "document") {
    const m = message?.[type] ?? {};
    media = {
      id: m?.id ?? "",
      mime: m?.mime_type ?? "",
      mediaType: type,
      filename: m?.filename,
      caption: m?.caption,
    };
  }

  return {
    phoneNumberId: phoneNumberId ?? "",
    from,
    messageId: message?.id ?? "",
    type,
    text: type === "text" ? (message?.text?.body ?? "") : "",
    buttonId: type === "interactive" ? (inter?.button_reply?.id ?? inter?.list_reply?.id ?? "") : "",
    media,
    referral: message?.referral ?? null,
    context: message?.context ?? null,
    profileName: String(profile || ""),
    timestamp: String(message?.timestamp ?? ""),
  };
}

/* ───────────────────────────── outcome ───────────────────────────── */

export type DispatchRoute = "expense_inflow" | "lead_referral" | "expense_verified" | "support";

export type DispatchOutcome =
  | {
      route: DispatchRoute;
      canonical: string;
      contactId: mongoose.Types.ObjectId;
      conversationId: mongoose.Types.ObjectId;
      identityState: IdentityResolution["identityState"];
      /** Present only when the chain was handed the message. */
      enqueue?: EnqueueResult & { collection: "ExpenseReply" | "ExpenseCapture" } | { enqueued: false; collection: null; reason: string };
      inFlow: ExpenseInFlow;
    }
  | { route: "duplicate"; canonical: string; messageId: string }
  | { route: "dropped"; reason: "unusable_phone" | "missing_message_id"; from: string };

/* ───────────────────────────── the wrap (Part C) ───────────────────────────── */

/**
 * The ONLY path from the dispatcher into the expense chain. Refuses without a
 * hard identity — this is the §9 invariant made unconditional in code, not a
 * matter of call-site discipline.
 */
async function enqueueForChain(env: InboundEnvelope, identity: IdentityResolution) {
  if (!identity.hard) {
    // Should be unreachable: every caller checks first. Throwing (rather than
    // silently skipping) makes a future refactor that breaks the ordering
    // fail loudly in tests.
    throw new Error("enqueueForChain called without a hard identity");
  }
  const base = { messageId: env.messageId, waId: env.from, phoneNumberId: env.phoneNumberId };

  if (env.type === "text") {
    const r = await enqueueExpenseReply({ ...base, text: env.text });
    return { ...r, collection: "ExpenseReply" as const };
  }
  if (env.type === "interactive") {
    if (!env.buttonId) return { enqueued: false as const, collection: null, reason: "interactive_without_button_id" };
    const r = await enqueueExpenseButton({ ...base, buttonId: env.buttonId });
    return { ...r, collection: "ExpenseReply" as const };
  }
  if ((env.type === "image" || env.type === "document") && env.media) {
    if (!env.media.id) return { enqueued: false as const, collection: null, reason: "media_without_id" };
    const r = await enqueueExpenseCapture({
      ...base,
      mediaId: env.media.id,
      mime: env.media.mime,
      mediaType: env.media.mediaType,
      filename: env.media.filename,
      caption: env.media.caption,
    });
    return { ...r, collection: "ExpenseCapture" as const };
  }
  // audio / location / sticker / … — the chain has no consumer for these
  // (the legacy path drops them at MEDIA_TYPES). Recorded on the
  // conversation, not enqueued.
  return { enqueued: false as const, collection: null, reason: `chain_has_no_consumer_for_${env.type || "unknown"}` };
}

/* ───────────────────────────── the dispatcher (Part B) ───────────────────────────── */

export async function dispatchInbound(env: InboundEnvelope, now: Date = new Date()): Promise<DispatchOutcome> {
  if (!env.messageId) return { route: "dropped", reason: "missing_message_id", from: env.from };

  const canonical = toCanonical(env.from);
  if (!canonical) {
    whatsappLogger.warn("PlumConnect: unusable sender phone", { from: env.from, messageId: env.messageId });
    return { route: "dropped", reason: "unusable_phone", from: env.from };
  }

  // One identity read, one chain-state read. Both READ-ONLY.
  const [identity, inFlow] = await Promise.all([resolveIdentity(canonical), readExpenseInFlow(env.from, now)]);

  // Classify (D4 precedence).
  let route: DispatchRoute;
  if (inFlow.inFlow && identity.hard) route = "expense_inflow";
  else if (env.referral) route = "lead_referral";
  else if (identity.hard) route = "expense_verified";
  else route = "support";

  const kind: ConversationKind = route === "lead_referral" ? "lead" : route === "support" ? "support" : "expense";

  // Our own records: Contact (reference-only), Conversation, inbound Message.
  const contact = await upsertContact({
    phone: canonical,
    displayName: env.profileName,
    identityState: identity.identityState,
    hardUserId: identity.hard?.userId ?? null,
    now,
  });
  const conversation = await openOrGetConversation({
    contactId: contact._id as mongoose.Types.ObjectId,
    kind,
    channelAccountId: env.phoneNumberId,
    referralRaw: env.referral ?? undefined,
    now,
  });
  const appended = await appendInbound({
    conversationId: conversation._id as mongoose.Types.ObjectId,
    externalId: env.messageId,
    type: env.type,
    text: env.text,
    payload: {
      buttonId: env.buttonId || undefined,
      media: env.media ?? undefined,
      referral: env.referral ?? undefined,
      context: env.context ?? undefined,
      rawType: env.type,
      timestamp: env.timestamp || undefined,
    },
    now,
  });

  // Redelivered wamid: everything for it already happened (including any
  // enqueue, which is itself idempotent on the same id). Do nothing more.
  if (appended.duplicate) {
    whatsappLogger.info("PlumConnect: duplicate delivery", { messageId: env.messageId });
    return { route: "duplicate", canonical, messageId: env.messageId };
  }

  const base = {
    canonical,
    contactId: contact._id as mongoose.Types.ObjectId,
    conversationId: conversation._id as mongoose.Types.ObjectId,
    identityState: identity.identityState,
    inFlow,
  };

  if (route === "expense_inflow" || route === "expense_verified") {
    const enqueue = await enqueueForChain(env, identity);
    whatsappLogger.info("PlumConnect: routed to expense chain", {
      messageId: env.messageId,
      route,
      enqueued: enqueue.enqueued,
      collection: enqueue.collection,
    });
    return { route, ...base, enqueue };
  }

  if (route === "lead_referral") {
    // Slice 3 creates the Lead + starts the bot here. Slice 2 only records
    // the thread with the verbatim referral (a CTWA referral arrives on the
    // first message only — it must be captured now or never).
    whatsappLogger.info("PlumConnect: CTWA referral captured (lead consumer not enabled)", {
      messageId: env.messageId,
      conversationId: String(conversation._id),
    });
    return { route, ...base };
  }

  // SUPPORT — the killed default. No enqueue, no reply; the inbox (Slice 4)
  // is the reply path.
  whatsappLogger.info("PlumConnect: support conversation", {
    messageId: env.messageId,
    conversationId: String(conversation._id),
    identityState: identity.identityState,
  });
  return { route, ...base };
}
