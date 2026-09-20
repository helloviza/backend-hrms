// apps/backend/src/services/plumconnect/bot.ts
//
// PlumConnect Slice 3c, Part B — the holiday qualification bot.
// A deterministic state machine over Conversation.bot; NO LLM anywhere on
// the inbound path (the prompt-injection boundary the arrival concierge set
// in arrivalInbound.ts:8-9 and plan §9). Replies go out on the webhook path
// through sendAndPersist() — sub-second, never via the 10 s poll queue (D8)
// — and only ever in reply to an inbound, so always inside Meta's 24 h
// window (no templates).
//
//   ask_name ──answer──▶ ask_destination ──answer──▶ ask_dates ──answer──▶ done
//
// One question per turn. Answers land in Lead.contactName /
// Lead.travelRequirement via deterministic parsing only: trimmed,
// control-characters stripped, length-capped (the sanitize pattern at
// routes/leads.ts:258). No field is interpreted as an instruction. An
// unparseable answer is re-asked once; a second miss stops the bot
// (stoppedBy "unparsed") and leaves the step for a human. Once stopped, for
// ANY reason, the bot never speaks on that conversation again.
//
// Human takeover: an assigned conversation, or an agent-authored outbound
// (Slice 4), stops the bot (stoppedBy "human").

import type mongoose from "mongoose";
import Lead from "../../models/Lead.js";
import PlumConnectConversation, { type IPlumConnectConversation, type BotStopReason } from "../../models/plumconnect/Conversation.js";
import { sendAndPersist } from "./send.js";
import { CONTACT_NAME_FALLBACK } from "./holidayLead.js";
import { whatsappLogger } from "../../utils/logger.js";

export const BOT_STEPS = ["ask_name", "ask_destination", "ask_dates", "done"] as const;
export type BotStep = (typeof BOT_STEPS)[number];

const MAX_RETRIES = 1;

/* ───────────────────────────── deterministic parsing ───────────────────────────── */

/** routes/leads.ts:258 — trim + cap — plus control-character stripping and whitespace collapse. */
export function sanitize(v: unknown, max = 200): string {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A human name: 2–80 chars after sanitising. Nothing else is inspected. */
export function parseName(text: string): string | null {
  const s = sanitize(text, 80);
  if (s.length < 2) return null;
  // Someone answering "my name is Priya" — take what follows the phrase.
  const m = /^(?:my name is|i am|i'm|this is|it's|its)\s+(.+)$/i.exec(s);
  return (m ? sanitize(m[1], 80) : s) || null;
}

/** A destination: 2–120 chars after sanitising. */
export function parseDestination(text: string): string | null {
  const s = sanitize(text, 120);
  return s.length >= 2 ? s : null;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// Longest names first so "sept" is not cut to "sep" + "t".
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const DATE_RE = () =>
  new RegExp(
    String.raw`(\d{4})-(\d{1,2})-(\d{1,2})` + // 1-3  yyyy-mm-dd
      String.raw`|(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})` + // 4-6  dd/mm/yyyy (day-first)
      String.raw`|(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\b(?:\s+(\d{4}))?` + // 7-9  12 oct [2026]
      String.raw`|\b(${MONTH_ALT})\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?`, // 10-12 oct 12[, 2026]
    "g",
  );

function utc(y: number, m: number, d: number): Date | null {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null;
}

/**
 * Pull up to two dates out of free text, deterministically. Accepts
 * yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy (day-first — India), "12 Oct [2026]",
 * "Oct 12[, 2026]". A date with no year gets the next occurrence from `now`.
 * Returns { start, end } (end null when only one date), or null.
 */
export function parseDates(text: string, now: Date = new Date()): { start: Date; end: Date | null } | null {
  const s = sanitize(text, 200).toLowerCase();
  const found: Date[] = [];

  const push = (d: Date | null) => {
    if (d && found.length < 2) found.push(d);
  };
  const withYear = (y: number, m: number, d: number) => push(utc(y < 100 ? 2000 + y : y, m, d));
  const noYear = (m: number, d: number) => {
    let dt = utc(now.getUTCFullYear(), m, d);
    if (dt && dt.getTime() < now.getTime() - 86_400_000) dt = utc(now.getUTCFullYear() + 1, m, d);
    push(dt);
  };

  // Scan left to right so "12 oct to 19 oct" keeps its order. The month
  // slots are the real month names only, so a stray word next to a number
  // ("around 5", "and 12") can never swallow the digits.
  const re = DATE_RE();
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && found.length < 2) {
    if (m[1]) withYear(+m[1], +m[2] - 1, +m[3]);
    else if (m[4]) withYear(+m[6], +m[5] - 1, +m[4]);
    else if (m[7]) m[9] ? withYear(+m[9], MONTHS[m[8]], +m[7]) : noYear(MONTHS[m[8]], +m[7]);
    else if (m[10]) m[12] ? withYear(+m[12], MONTHS[m[10]], +m[11]) : noYear(MONTHS[m[10]], +m[11]);
  }

  if (found.length === 0) return null;
  if (found.length === 2 && found[1].getTime() < found[0].getTime()) found.reverse();
  return { start: found[0], end: found[1] ?? null };
}

/* ───────────────────────────── copy ───────────────────────────── */

const COPY = {
  welcome: (headline: string) =>
    `Hi! Thanks for reaching out to Plumtrips${headline ? ` about "${headline}"` : ""}. To get started, what's your name?`,
  askNameAgain: "Sorry, I didn't catch that — what's your name?",
  askDestination: (name: string) => `Nice to meet you, ${name}! Where would you like to go?`,
  askDestinationAgain: "Which destination did you have in mind?",
  askDates: "Great — when are you planning to travel? (e.g. 12 Oct to 19 Oct)",
  askDatesAgain: "Could you share your travel dates? A rough date is fine, e.g. 15 Nov.",
  handover: (name: string) => `Perfect, ${name}. A Plumtrips holiday planner will be with you shortly.`,
  handoverUnparsed: "Thanks — a Plumtrips holiday planner will pick this up with you shortly.",
};

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

/** Start the bot on a freshly created holiday lead: message 1 = welcome + name. */
export async function startBot(ctx: BotContext, headline: string): Promise<void> {
  const now = ctx.now ?? new Date();
  const conversationId = ctx.conversation._id as mongoose.Types.ObjectId;
  await setBot(conversationId, { active: true, step: "ask_name", retries: 0, stoppedBy: null, stoppedAt: null });
  await sendAndPersist({ conversationId, to: ctx.to, text: COPY.welcome(sanitize(headline, 80)), payload: { bot: "ask_name" }, now });
  whatsappLogger.info("PlumConnect bot: started", { conversationId: String(conversationId), leadId: String(ctx.leadId) });
}

export type BotTurnOutcome =
  | { handled: true; step: BotStep; advanced: boolean; stopped: BotStopReason | null }
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

  // Human takeover: an assigned thread silences the bot for good.
  if (conv.assignedTo) {
    await stopBot(conversationId, "human", now);
    whatsappLogger.info("PlumConnect bot: stopped — conversation assigned to a human", { conversationId: String(conversationId) });
    return { handled: false, reason: "human" };
  }

  if (!text || !sanitize(text)) return { handled: false, reason: "no_text" };

  const step = (conv.bot.step || "ask_name") as BotStep;
  const retries = conv.bot.retries || 0;

  const retryOrGiveUp = async (againCopy: string, giveUpCopy: string): Promise<BotTurnOutcome> => {
    if (retries < MAX_RETRIES) {
      await setBot(conversationId, { retries: retries + 1 });
      await sendAndPersist({ conversationId, to: ctx.to, text: againCopy, payload: { bot: step, retry: retries + 1 }, now });
      return { handled: true, step, advanced: false, stopped: null };
    }
    await stopBot(conversationId, "unparsed", now);
    await sendAndPersist({ conversationId, to: ctx.to, text: giveUpCopy, payload: { bot: step, gaveUp: true }, now });
    return { handled: true, step, advanced: false, stopped: "unparsed" };
  };

  if (step === "ask_name") {
    const name = parseName(text);
    if (!name) return retryOrGiveUp(COPY.askNameAgain, COPY.handoverUnparsed);
    // Overwrite the placeholder (or whatever the profile gave us) with what they said.
    await Lead.updateOne({ _id: ctx.leadId }, { $set: { contactName: name } });
    await setBot(conversationId, { step: "ask_destination", retries: 0 });
    await sendAndPersist({ conversationId, to: ctx.to, text: COPY.askDestination(name), payload: { bot: "ask_destination" }, now });
    return { handled: true, step: "ask_destination", advanced: true, stopped: null };
  }

  if (step === "ask_destination") {
    const destination = parseDestination(text);
    if (!destination) return retryOrGiveUp(COPY.askDestinationAgain, COPY.handoverUnparsed);
    await Lead.updateOne({ _id: ctx.leadId }, { $set: { "travelRequirement.destination": destination } });
    await setBot(conversationId, { step: "ask_dates", retries: 0 });
    await sendAndPersist({ conversationId, to: ctx.to, text: COPY.askDates, payload: { bot: "ask_dates" }, now });
    return { handled: true, step: "ask_dates", advanced: true, stopped: null };
  }

  if (step === "ask_dates") {
    const dates = parseDates(text, now);
    if (!dates) {
      // Second miss: keep what they typed for the planner before handing over.
      if (retries >= MAX_RETRIES) {
        await Lead.updateOne({ _id: ctx.leadId }, { $set: { "travelRequirement.notes": `Dates (as typed): ${sanitize(text, 200)}` } });
      }
      return retryOrGiveUp(COPY.askDatesAgain, COPY.handoverUnparsed);
    }
    await Lead.updateOne(
      { _id: ctx.leadId },
      { $set: { "travelRequirement.travelDate": dates.start, "travelRequirement.travelDateEnd": dates.end } },
    );
    await completeLead(ctx.leadId);
    await setBot(conversationId, { step: "done", retries: 0 });
    await stopBot(conversationId, "complete", now);
    const lead: any = await Lead.findById(ctx.leadId).select("contactName").lean();
    const name = lead?.contactName && lead.contactName !== CONTACT_NAME_FALLBACK ? lead.contactName : "";
    await sendAndPersist({ conversationId, to: ctx.to, text: name ? COPY.handover(name) : COPY.handoverUnparsed, payload: { bot: "done" }, now });
    whatsappLogger.info("PlumConnect bot: complete", { conversationId: String(conversationId), leadId: String(ctx.leadId) });
    return { handled: true, step: "done", advanced: true, stopped: "complete" };
  }

  // "done" or unknown: nothing to say.
  return { handled: false, reason: "inactive" };
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
