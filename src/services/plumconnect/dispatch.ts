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
//   2. CTWA REFERRAL    message.referral present         → lead conversation +
//                       (non-employee) the Intent Engine picks the business
//                       line (campaign map → keywords → menu) and a Lead is
//                       created through createLead() — Slice 3b/5
//   3. VERIFIED         hard identity (ACTIVE User.waId) → hand to the chain
//   4. SUPPORT          everything else                  → support conversation,
//                       OPEN, no expense row, no expense-bot reply.
//                       THIS REPLACES the legacy "default to expense".
//                       Slice 3c refines this bucket, in order: a pending
//                       consent answer → an active bot turn → a receipt from
//                       a soft-matched employee (consent prompt) → support.
//                       Slice 5 inserts the Intent Engine between (a) and
//                       (b) for a tapped menu button, and after (c) for an
//                       organic message on a thread not yet routed.
//
// Hard invariant (plan §9): the chain's enqueuers are called through
// enqueueForChain(), which refuses without a hard identity. Soft matches
// (User.phone / TravellerProfile / Consumer / CRMContact) only label the
// Contact — they never enqueue and never touch a workspaceId. The chain
// itself re-resolves identity (User.waId) and assigns workspaceId exactly
// as it does for the legacy path; this file decides WHO reaches the
// enqueue, nothing more.
//
// Slice 3c: the bot and the consent flow send through sendAndPersist()
// (services/plumconnect/send.ts); Slice 5's menu goes through the 4a wrapper
// (sendButtonsOutcome, origin "support"). Human replies are Slice 4.
//
// Slice 5 — the Intent Engine (intent.ts). For a NON-employee the business
// line is resolved ONCE per thread and stored on the Conversation:
//   menu tap → "menu"; mapped ad id → "campaign_map"; keywords → "keyword";
//   nothing → the interactive menu is sent and the thread waits.
// Business line and campaign lineage are orthogonal: classifyIntent() never
// reads attribution.
//
// Slice 6 — Stage 2. Once a line is resolved and the Lead exists, the gate
// requiresQualification(line) (flows/index.ts) decides whether the
// department's qualification flow runs: concierge (the exact 3c flow),
// plumtrips and helloviza each have one; support / expense / general have
// none and are never asked anything. The bot drives whichever flow the
// registry returns; the takeover contract (assignment / agent send silences
// it for good) is unchanged.

import type mongoose from "mongoose";
import { toCanonical } from "../../utils/phone.js";
import { resolveIdentity, type IdentityResolution } from "./resolveIdentity.js";
import { readExpenseInFlow, type ExpenseInFlow } from "./expenseInFlow.js";
import { upsertContact, openOrGetConversation, appendInbound } from "./conversationStore.js";
import { enqueueExpenseReply, enqueueExpenseButton, enqueueExpenseCapture, type EnqueueResult } from "./enqueueExpense.js";
import { captureLead, parseReferral, type CaptureHolidayLeadResult } from "./holidayLead.js";
import {
  classifyIntent,
  lookupCampaignMap,
  isMenuButton,
  menuChoiceToBusinessLine,
  menuRecentlySent,
  sendIntentMenu,
  recordIntent,
} from "./intent.js";
import { startBot, handleBotTurn, botIsActive, type BotTurnOutcome } from "./bot.js";
import { requiresQualification, threadBusinessLine } from "./flows/index.js";
import {
  isExpenseShaped,
  parseConsentAnswer,
  consentPending,
  promptForConsent,
  recordConsentAnswer,
  type ConsentPromptOutcome,
  type ConsentAnswerOutcome,
} from "./consent.js";
import type { ConversationKind, BusinessLine, IntentSource, IPlumConnectConversation } from "../../models/plumconnect/Conversation.js";
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

export type DispatchRoute =
  | "expense_inflow"
  | "lead_referral"
  | "expense_verified"
  | "support"
  // Slice 3c — all three are refinements of what Slice 2 called "support":
  | "bot" // the qualification bot answered on an active lead thread
  | "consent_prompt" // soft-matched employee sent a receipt → bind prompt, nothing enqueued
  | "consent_answer" // soft-matched employee answered YES/NO to the bind prompt
  // Slice 5 — the Intent Engine on an organic (non-referral) thread:
  | "intent_menu" // business line unknown → the menu was sent (or is still pending)
  | "intent_lead"; // business line resolved (menu tap / keywords) → Lead created or touched

export type DispatchOutcome =
  | {
      route: DispatchRoute;
      canonical: string;
      contactId: mongoose.Types.ObjectId;
      conversationId: mongoose.Types.ObjectId;
      identityState: IdentityResolution["identityState"];
      /** Present only when the chain was handed the message. */
      enqueue?: EnqueueResult & { collection: "ExpenseReply" | "ExpenseCapture" } | { enqueued: false; collection: null; reason: string };
      /** Present on lead_referral / intent_lead for a non-employee: what the lead adapter did. */
      lead?: CaptureHolidayLeadResult;
      /** Slice 5: how the business line was (or was not) resolved on this turn. */
      intent?: IntentOutcome;
      /** Slice 3c: what the bot / consent flow did on this turn. */
      bot?: BotTurnOutcome;
      consent?: ConsentPromptOutcome | ConsentAnswerOutcome;
      inFlow: ExpenseInFlow;
    }
  | { route: "duplicate"; canonical: string; messageId: string }
  | { route: "dropped"; reason: "unusable_phone" | "missing_message_id"; from: string };

export interface IntentOutcome {
  businessLine: BusinessLine | null;
  /** null when the line was already on the thread (no resolution this turn) or nothing resolved. */
  source: IntentSource | null;
  confidence: number;
  /** Set on intent_menu: whether the menu went out on THIS turn (false = recently sent, waiting). */
  menuSent?: boolean;
}

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

  // Everything below is the NON-employee world (plus the soft-employee
  // consent flow). A hard identity never reaches the Intent Engine.
  const leadCtx = { env, canonical, contactId: contact._id as mongoose.Types.ObjectId, conversation, base, now };

  if (route === "lead_referral") {
    // Slice 3b: the referral is already verbatim on the Conversation
    // (openOrGetConversation) and on the inbound Message payload. An employee
    // who taps an ad keeps the lead-kind thread but gets no Lead row.
    if (identity.hard) {
      whatsappLogger.info("PlumConnect: CTWA referral from a verified employee — thread only, no Lead", {
        messageId: env.messageId,
        conversationId: String(conversation._id),
      });
      return { route, ...base };
    }
    // Slice 5: which business line does this ad sell? A thread that is
    // already routed keeps its line (a repeat referral is a touch, 3b).
    // Otherwise: Ops' campaign map → keywords in the text → ask.
    const routed = threadBusinessLine(conversation);
    if (routed) return routeToBusinessLine({ ...leadCtx, route, businessLine: routed, source: null, confidence: 1, label: "" });
    const parsed = parseReferral(env.referral);
    const mapped = await lookupCampaignMap({ sourceId: parsed.sourceId });
    if (mapped) {
      return routeToBusinessLine({ ...leadCtx, route, businessLine: mapped, source: "campaign_map", confidence: 1, label: `ad:${parsed.sourceId}` });
    }
    const c = classifyIntent(env.text);
    if (c.businessLine) {
      return routeToBusinessLine({ ...leadCtx, route, businessLine: c.businessLine, source: "keyword", confidence: c.confidence, label: c.matched.join(",") });
    }
    const menuSent = await offerMenu(conversation, canonical, now);
    return { route: "intent_menu", ...base, intent: { businessLine: null, source: null, confidence: c.confidence, menuSent } };
  }

  // ── Slice 3c refinements of the support bucket ───────────────────────────
  // (a) A pending consent answer from a soft-matched employee.
  if (identity.identityState === "soft_employee" && consentPending(contact.consent)) {
    const answer = parseConsentAnswer(env.text, env.buttonId);
    if (answer) {
      const consent = await recordConsentAnswer(
        { contactId: contact._id as mongoose.Types.ObjectId, conversationId: conversation._id as mongoose.Types.ObjectId, canonical, identity, consent: contact.consent, now },
        answer,
      );
      return { route: "consent_answer", ...base, consent };
    }
  }
  // Slice 5 — a tapped intent-menu button resolves the line ("menu").
  if (!identity.hard && env.type === "interactive" && isMenuButton(env.buttonId)) {
    const chosen = menuChoiceToBusinessLine(env.buttonId);
    const routed = threadBusinessLine(conversation);
    if (chosen && !routed) {
      return routeToBusinessLine({ ...leadCtx, route: "intent_lead", businessLine: chosen, source: "menu", confidence: 1, label: `menu:${chosen}` });
    }
    // "Something else" (or a stale tap on an already-routed thread) → support.
    whatsappLogger.info("PlumConnect intent: menu answered without a line — support", {
      conversationId: String(conversation._id),
      buttonId: env.buttonId,
      alreadyRouted: routed,
    });
    return { route: "support", ...base, intent: { businessLine: routed, source: routed ? null : "menu", confidence: 0 } };
  }
  // (b) A qualification flow is mid-way on this (non-employee) thread — the
  //     bot answers with whichever department's flow the thread is on.
  if (conversation.leadId && botIsActive(conversation)) {
    const bot = await handleBotTurn({ conversation, to: canonical, leadId: conversation.leadId as mongoose.Types.ObjectId, now }, env.text);
    if (bot.handled) return { route: "bot", ...base, bot };
    // not handled (assigned → stopped, or no text) → falls through to support below
  }
  // (c) A soft-matched employee sent a receipt: ask before ever enqueuing.
  if (identity.identityState === "soft_employee" && isExpenseShaped(env.type) && !env.referral) {
    const consent = await promptForConsent({
      contactId: contact._id as mongoose.Types.ObjectId,
      conversationId: conversation._id as mongoose.Types.ObjectId,
      canonical,
      identity,
      consent: contact.consent,
      now,
    });
    return { route: "consent_prompt", ...base, consent };
  }

  // Slice 5 — an organic message on a thread the Intent Engine has not
  // routed yet: keywords decide, or the menu is sent (at most once a day
  // while unanswered). A routed thread whose flow is over (or that has
  // none) falls through: the department's human queue owns it.
  // A soft-matched employee mid-consent is answering a different question:
  // no menu on top of the bind prompt.
  if (!identity.hard && !threadBusinessLine(conversation) && !consentPending(contact.consent)) {
    const c = classifyIntent(env.text);
    if (c.businessLine) {
      return routeToBusinessLine({ ...leadCtx, route: "intent_lead", businessLine: c.businessLine, source: "keyword", confidence: c.confidence, label: c.matched.join(",") });
    }
    const menuSent = await offerMenu(conversation, canonical, now);
    return { route: "intent_menu", ...base, intent: { businessLine: null, source: null, confidence: c.confidence, menuSent } };
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

/* ───────────────────────────── Slice 5 helpers ───────────────────────────── */

/** Send the menu unless one is still pending from the last day. */
async function offerMenu(conversation: IPlumConnectConversation, to: string, now: Date): Promise<boolean> {
  if (menuRecentlySent(conversation.intentMenuSentAt, now)) {
    whatsappLogger.info("PlumConnect intent: menu pending — not re-sent", { conversationId: String(conversation._id) });
    return false;
  }
  const sent = await sendIntentMenu(conversation._id as mongoose.Types.ObjectId, to, now);
  if (sent) conversation.intentMenuSentAt = now;
  return sent;
}

interface RouteToLineInput {
  env: InboundEnvelope;
  canonical: string;
  contactId: mongoose.Types.ObjectId;
  conversation: IPlumConnectConversation;
  base: {
    canonical: string;
    contactId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    identityState: IdentityResolution["identityState"];
    inFlow: ExpenseInFlow;
  };
  now: Date;
  route: DispatchRoute;
  businessLine: BusinessLine;
  /** null = the thread was already routed; nothing to record this turn. */
  source: IntentSource | null;
  confidence: number;
  /** Audit label for Conversation.intent — NEVER the user's text. */
  label: string;
}

/**
 * Business line resolved → stamp it (first time only), create-or-touch the
 * Lead through the 3a seam, then consult the Slice 6 gate: a line that
 * requires qualification gets its flow (the bot's first question on a new
 * Lead; a bot turn on a mid-flow thread — for concierge this is exactly the
 * 3b/3c behaviour). A line without a flow stops at the Lead: the thread sits
 * in the department queue with its businessLine and no bot ever starts.
 */
async function routeToBusinessLine(input: RouteToLineInput): Promise<DispatchOutcome> {
  const { env, canonical, conversation, base, now, route, businessLine, source, confidence } = input;
  const conversationId = conversation._id as mongoose.Types.ObjectId;
  const intent: IntentOutcome = { businessLine, source, confidence };

  if (source) {
    await recordIntent(conversationId, businessLine, source, confidence, input.label);
    conversation.businessLine = businessLine;
    conversation.intentSource = source;
    conversation.intentConfidence = confidence;
    conversation.intent = input.label;
    conversation.kind = "lead";
    whatsappLogger.info("PlumConnect intent: resolved", { conversationId: String(conversationId), businessLine, source, confidence });
  }

  const lead = await captureLead({
    businessLine,
    canonical,
    profileName: env.profileName,
    referralRaw: env.referral ?? undefined,
    contactId: input.contactId,
    conversation,
    messageId: env.messageId,
    now,
  });

  if (requiresQualification(businessLine)) {
    // A brand-new lead gets the flow's first question; a repeat touch on a
    // thread where the bot is mid-flow treats the text as the answer it was
    // waiting for (Slice 3c, unchanged).
    if (lead.touch === "first") {
      await startBot({ conversation, to: canonical, leadId: lead.leadId, now }, parseReferral(env.referral).headline);
      return { route, ...base, lead, intent };
    }
    if (botIsActive(conversation)) {
      const bot = await handleBotTurn({ conversation, to: canonical, leadId: lead.leadId, now }, env.text);
      return { route, ...base, lead, bot, intent };
    }
  }
  return { route, ...base, lead, intent };
}
