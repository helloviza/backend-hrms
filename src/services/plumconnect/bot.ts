// apps/backend/src/services/plumconnect/bot.ts
//
// PlumConnect Slice 3c, Part B — the qualification bot; Slice 6 — generalised
// to drive any registered flow (flows/index.ts) instead of the hard-coded
// concierge steps. A deterministic state machine over Conversation.bot; NO
// LLM anywhere on the inbound path (the prompt-injection boundary the arrival
// concierge set in arrivalInbound.ts:8-9 and plan §9). Replies go out on the
// webhook path through sendAndPersist() — sub-second, never via the 10 s
// poll queue (D8) — and only ever in reply to an inbound, so always inside
// Meta's 24 h window (no templates).
//
//   questions[0] ──answer──▶ questions[1] ──answer──▶ … ──answer──▶ done
//
// One question per turn. Conversation.bot.step is the id of the open
// question in the conversation's flow ("done" once complete). Answers land
// on the Lead only through the flow's deterministic parsers: trimmed,
// control-characters stripped, length-capped (the sanitize pattern at
// routes/leads.ts:258). No field is interpreted as an instruction. An
// unparseable answer is re-asked once; a second miss stops the bot
// (stoppedBy "unparsed") and leaves the step for a human. Once stopped, for
// ANY reason, the bot never speaks on that conversation again.
//
// Human takeover: an assigned conversation, or an agent-authored outbound
// (Slice 4), stops the bot (stoppedBy "human").
//
// Which flow: flows/index.ts — the conversation's businessLine (a pre-Slice-5
// lead thread reads as concierge). A line with no flow (support / expense /
// general) never gets a bot: startBot() is a no-op and handleBotTurn()
// reports "inactive".

import type mongoose from "mongoose";
import Lead from "../../models/Lead.js";
import PlumConnectConversation, { type IPlumConnectConversation, type BotStopReason } from "../../models/plumconnect/Conversation.js";
import { sendAndPersist } from "./send.js";
import { CONTACT_NAME_FALLBACK } from "./holidayLead.js";
import { flowForConversation } from "./flows/index.js";
import { sanitize } from "./flows/parse.js";
import { getMessage } from "./messages.js";
import { whatsappLogger } from "../../utils/logger.js";

// The Slice 3c parsers live with the flows now; re-exported so nothing that
// imported them from here has to move.
export { sanitize, parseName, parseDestination, parseDates } from "./flows/parse.js";

export const BOT_DONE_STEP = "done";

const MAX_RETRIES = 1;

/* ───────────────────────────── state helpers ───────────────────────────── */

async function setBot(conversationId: mongoose.Types.ObjectId, patch: Record<string, unknown>) {
  const $set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) $set[`bot.${k}`] = v;
  await PlumConnectConversation.updateOne({ _id: conversationId }, { $set });
}

export async function stopBot(conversationId: mongoose.Types.ObjectId, reason: BotStopReason, now: Date = new Date()) {
  await setBot(conversationId, { active: false, stoppedBy: reason, stoppedAt: now });
}

/** True when the bot may speak on this conversation. */
export function botIsActive(conversation: IPlumConnectConversation): boolean {
  return Boolean(conversation.bot?.active) && !conversation.bot?.stoppedBy;
}

export interface BotContext {
  conversation: IPlumConnectConversation;
  to: string; // canonical phone
  leadId: mongoose.Types.ObjectId;
  now?: Date;
}

/**
 * Start the flow on a freshly created Lead: message 1 = welcome + first
 * question. A conversation whose line needs no qualification gets nothing.
 */
export async function startBot(ctx: BotContext, headline: string): Promise<void> {
  const now = ctx.now ?? new Date();
  const conversationId = ctx.conversation._id as mongoose.Types.ObjectId;
  const flow = flowForConversation(ctx.conversation);
  if (!flow) {
    whatsappLogger.info("PlumConnect bot: no qualification flow for this line — not started", {
      conversationId: String(conversationId),
      businessLine: ctx.conversation.businessLine ?? null,
    });
    return;
  }
  const first = flow.questions[0];
  await setBot(conversationId, { active: true, step: first.id, retries: 0, stoppedBy: null, stoppedAt: null });
  // Track C: copy from the store (line override → global → seed default).
  const h = sanitize(headline, 80);
  const welcome = h ? await getMessage(flow.welcome.withHeadline, flow.businessLine, { headline: h }) : await getMessage(flow.welcome.key, flow.businessLine);
  await sendAndPersist({ conversationId, to: ctx.to, text: welcome, payload: { bot: first.id }, now });
  whatsappLogger.info("PlumConnect bot: started", { conversationId: String(conversationId), leadId: String(ctx.leadId), flow: flow.businessLine });
}

export type BotTurnOutcome =
  | { handled: true; step: string; advanced: boolean; stopped: BotStopReason | null }
  | { handled: false; reason: "inactive" | "human" | "no_text" };

/**
 * One inbound while the bot is active. Non-text inbounds (a photo, a voice
 * note) are recorded by the dispatcher and simply not answered — the bot
 * waits for text. Returns what it did so the dispatcher can log it.
 */
export async function handleBotTurn(ctx: BotContext, text: string): Promise<BotTurnOutcome> {
  const now = ctx.now ?? new Date();
  const conv = ctx.conversation;
  const conversationId = conv._id as mongoose.Types.ObjectId;

  if (!botIsActive(conv)) return { handled: false, reason: "inactive" };

  // Human takeover: an assigned thread silences the bot for good. An
  // assignment made by the routing matrix (Track B, routing.autoAssigned)
  // is not a takeover — the agent owns the thread while the bot still
  // qualifies it; their first reply / take through the inbox stops the bot
  // explicitly (routes/plumconnect.ts).
  if (conv.assignedTo && !conv.routing?.autoAssigned) {
    await stopBot(conversationId, "human", now);
    whatsappLogger.info("PlumConnect bot: stopped — conversation assigned to a human", { conversationId: String(conversationId) });
    return { handled: false, reason: "human" };
  }

  if (!text || !sanitize(text)) return { handled: false, reason: "no_text" };

  const flow = flowForConversation(conv);
  if (!flow) return { handled: false, reason: "inactive" };

  const step = conv.bot.step || flow.questions[0].id;
  const index = flow.questions.findIndex((q) => q.id === step);
  // "done" or a step this flow does not know: nothing to say.
  if (index < 0) return { handled: false, reason: "inactive" };
  const question = flow.questions[index];
  const retries = conv.bot.retries || 0;

  const line = flow.businessLine;
  const retryOrGiveUp = async (): Promise<BotTurnOutcome> => {
    if (retries < MAX_RETRIES) {
      await setBot(conversationId, { retries: retries + 1 });
      await sendAndPersist({ conversationId, to: ctx.to, text: await getMessage(question.askAgain.key, line), payload: { bot: step, retry: retries + 1 }, now });
      return { handled: true, step, advanced: false, stopped: null };
    }
    await stopBot(conversationId, "unparsed", now);
    await sendAndPersist({ conversationId, to: ctx.to, text: await getMessage(flow.handoverUnparsed, line), payload: { bot: step, gaveUp: true }, now });
    return { handled: true, step, advanced: false, stopped: "unparsed" };
  };

  const parsed = question.parse(text, now);
  if (!parsed) {
    // Second miss: keep what they typed for the human before handing over.
    if (retries >= MAX_RETRIES && question.keepOnGiveUp) {
      await Lead.updateOne({ _id: ctx.leadId }, { $set: question.keepOnGiveUp(text) });
    }
    return retryOrGiveUp();
  }

  await Lead.updateOne({ _id: ctx.leadId }, { $set: parsed.set });

  const next = flow.questions[index + 1];
  if (next) {
    await setBot(conversationId, { step: next.id, retries: 0 });
    const text = await getMessage(next.ask.key, line, next.ask.vars?.({ previousAnswer: parsed.display }) ?? {});
    await sendAndPersist({ conversationId, to: ctx.to, text, payload: { bot: next.id }, now });
    return { handled: true, step: next.id, advanced: true, stopped: null };
  }

  // Last question answered: the Lead is qualified, the flow is complete.
  await completeLead(ctx.leadId);
  await setBot(conversationId, { step: BOT_DONE_STEP, retries: 0 });
  await stopBot(conversationId, "complete", now);
  const lead: any = await Lead.findById(ctx.leadId).select("contactName").lean();
  const name = lead?.contactName && lead.contactName !== CONTACT_NAME_FALLBACK ? lead.contactName : "";
  const ack = name ? await getMessage(flow.handover, line, { name }) : await getMessage(flow.handoverUnparsed, line);
  await sendAndPersist({ conversationId, to: ctx.to, text: ack, payload: { bot: BOT_DONE_STEP }, now });
  whatsappLogger.info("PlumConnect bot: complete", { conversationId: String(conversationId), leadId: String(ctx.leadId), flow: flow.businessLine });
  return { handled: true, step: BOT_DONE_STEP, advanced: true, stopped: "complete" };
}

/**
 * Advance the lead to QUALIFIED through a document save so the Slice-2
 * pre-validate hook derives the legacy stage when CRM_V2_OPPORTUNITY is on;
 * with the flag off the status is persisted raw and readers use
 * effectiveLeadStatus().
 */
async function completeLead(leadId: mongoose.Types.ObjectId): Promise<void> {
  const lead = await Lead.findById(leadId);
  if (!lead) return;
  lead.status = "QUALIFIED";
  await lead.save();
}
