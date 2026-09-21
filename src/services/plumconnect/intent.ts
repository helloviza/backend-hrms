// apps/backend/src/services/plumconnect/intent.ts
//
// PlumConnect Slice 5 — the Intent Engine (Stage-1 routing).
//
// Answers ONE question for a non-employee contact: which business line do
// they want — plumtrips (corporate travel), helloviza (visas) or concierge
// (holidays)? Three signals, in this order, each deterministic, NO LLM:
//   1. a tapped menu button                        → intentSource "menu"
//   2. a CTWA referral whose ad id Ops has mapped   → intentSource "campaign_map"
//   3. keywords in the message text                 → intentSource "keyword"
// Nothing → the interactive menu is sent and we wait for a tap.
//
// The text is READ for routing only. Nothing here writes user text into a
// Lead field — the bot's deterministic parsers (bot.ts) remain the only
// thing that does. Business line and campaign lineage are orthogonal:
// classifyIntent() never sees attribution, and the campaign map is a
// routing table, not attribution (Slice 8 owns lineage).

import type mongoose from "mongoose";
import PlumConnectCampaignMap from "../../models/plumconnect/CampaignMap.js";
import PlumConnectConversation, { type BusinessLine, type IntentSource } from "../../models/plumconnect/Conversation.js";
import type { ReplyButton } from "../whatsappCloud.service.js";
import { sendButtonsOutcome } from "./outbound.js";
import { getMessage, MESSAGE_DEFAULTS } from "./messages.js";
import { whatsappLogger } from "../../utils/logger.js";

/* ───────────────────────────── keyword rules ───────────────────────────── */

/**
 * Keyword sets per business line. Each entry is a stem or phrase matched on
 * word boundaries after lower-casing. Weight 2 = unambiguous for that line,
 * weight 1 = suggestive. Ops-tunable in one place; no other file knows the
 * words.
 */
export const INTENT_KEYWORDS: Record<BusinessLine, Array<{ term: string; weight: 1 | 2 }>> = {
  helloviza: [
    { term: "visa", weight: 2 }, { term: "visas", weight: 2 }, { term: "passport", weight: 2 }, { term: "schengen", weight: 2 },
    { term: "e-visa", weight: 2 }, { term: "evisa", weight: 2 }, { term: "visa on arrival", weight: 2 }, { term: "immigration", weight: 1 },
    { term: "embassy", weight: 1 }, { term: "consulate", weight: 1 }, { term: "vfs", weight: 1 }, { term: "appointment", weight: 1 },
    { term: "document checklist", weight: 1 }, { term: "work permit", weight: 1 }, { term: "tourist visa", weight: 2 }, { term: "business visa", weight: 2 },
  ],
  plumtrips: [
    { term: "corporate travel", weight: 2 }, { term: "corporate", weight: 1 }, { term: "company", weight: 1 }, { term: "employees", weight: 1 },
    { term: "business travel", weight: 2 }, { term: "travel desk", weight: 2 }, { term: "travel policy", weight: 2 }, { term: "expense", weight: 1 },
    { term: "expenses", weight: 1 }, { term: "gst invoice", weight: 1 }, { term: "sbt", weight: 1 }, { term: "hrms", weight: 1 },
    { term: "team travel", weight: 2 }, { term: "office", weight: 1 }, { term: "vendor", weight: 1 }, { term: "b2b", weight: 2 }, { term: "platform", weight: 1 },
  ],
  concierge: [
    { term: "holiday", weight: 2 }, { term: "holidays", weight: 2 }, { term: "vacation", weight: 2 }, { term: "honeymoon", weight: 2 },
    { term: "package", weight: 2 }, { term: "packages", weight: 2 }, { term: "trip", weight: 1 }, { term: "tour", weight: 1 },
    { term: "itinerary", weight: 2 }, { term: "getaway", weight: 2 }, { term: "family trip", weight: 2 }, { term: "resort", weight: 1 },
    { term: "beach", weight: 1 }, { term: "cruise", weight: 2 }, { term: "safari", weight: 2 }, { term: "plan a", weight: 1 }, { term: "weekend", weight: 1 },
  ],
};

/** Minimum score to route without asking. Below this → the menu. */
export const INTENT_THRESHOLD = 2;
/** Score at which confidence saturates to 1.0. */
const SATURATION = 4;

export interface IntentClassification {
  businessLine: BusinessLine | null;
  /** 0..1 — strength of the winning line's match; 0 when nothing matched. */
  confidence: number;
  /** The terms that fired for the winning line (for the audit trail). */
  matched: string[];
}

function normalise(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rule-based classification of ONE message. Scores each business line by
 * the weights of the terms that occur (word-bounded); the best line wins
 * when it clears INTENT_THRESHOLD and beats the runner-up (a tie is
 * ambiguous → null → menu). Pure; safe on any input; never throws.
 */
export function classifyIntent(text: unknown): IntentClassification {
  const s = normalise(text);
  if (!s) return { businessLine: null, confidence: 0, matched: [] };

  const scores: Array<{ line: BusinessLine; score: number; matched: string[] }> = [];
  for (const line of Object.keys(INTENT_KEYWORDS) as BusinessLine[]) {
    let score = 0;
    const matched: string[] = [];
    for (const { term, weight } of INTENT_KEYWORDS[line]) {
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}(?=$|[^\\p{L}\\p{N}])`, "u").test(s)) {
        score += weight;
        matched.push(term);
      }
    }
    scores.push({ line, score, matched });
  }
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (!best || best.score < INTENT_THRESHOLD || (second && second.score === best.score)) {
    return { businessLine: null, confidence: best ? Math.min(1, best.score / SATURATION) : 0, matched: [] };
  }
  return { businessLine: best.line, confidence: Math.min(1, best.score / SATURATION), matched: best.matched };
}

/* ───────────────────────────── campaign map ───────────────────────────── */

/** Ops' routing table: the ad id from a CTWA referral → business line, or null. */
export async function lookupCampaignMap(referral: { sourceId?: string; campaignId?: string } | null | undefined): Promise<BusinessLine | null> {
  const adId = String(referral?.sourceId ?? "").trim();
  const campaignId = String(referral?.campaignId ?? "").trim();
  if (!adId && !campaignId) return null;
  const ors: Array<Record<string, string>> = [];
  if (adId) ors.push({ adId });
  if (campaignId) ors.push({ campaignId });
  const row = await PlumConnectCampaignMap.findOne({ enabled: true, $or: ors }).select("businessLine").lean();
  return (row as any)?.businessLine ?? null;
}

/* ───────────────────────────── menu ───────────────────────────── */

export const MENU_BUTTON_IDS = {
  plumtrips: "pc_bl_plumtrips",
  helloviza: "pc_bl_helloviza",
  concierge: "pc_bl_concierge",
  other: "pc_bl_other",
} as const;

// WhatsApp caps reply buttons at 3 per message: the three business lines
// go on the menu; "Something else" is a typed fallback (plain text) and any
// unclassified reply after the menu is treated the same way.
// Track C: the copy lives in the canned-message store (menu.*); these are
// the seed defaults, kept for tests and as the fallback.
export const MENU_BUTTONS: ReplyButton[] = [
  { id: MENU_BUTTON_IDS.plumtrips, title: MESSAGE_DEFAULTS["menu.button.plumtrips"].text },
  { id: MENU_BUTTON_IDS.helloviza, title: MESSAGE_DEFAULTS["menu.button.helloviza"].text },
  { id: MENU_BUTTON_IDS.concierge, title: MESSAGE_DEFAULTS["menu.button.concierge"].text },
];

export const MENU_TEXT = MESSAGE_DEFAULTS["menu.text"].text;

/** The menu as the store has it right now (an edit takes effect on the next send). */
export async function menuCopy(): Promise<{ text: string; buttons: ReplyButton[] }> {
  const [text, plumtrips, helloviza, concierge] = await Promise.all([
    getMessage("menu.text", null),
    getMessage("menu.button.plumtrips", null),
    getMessage("menu.button.helloviza", null),
    getMessage("menu.button.concierge", null),
  ]);
  return {
    text,
    buttons: [
      { id: MENU_BUTTON_IDS.plumtrips, title: plumtrips.slice(0, 20) },
      { id: MENU_BUTTON_IDS.helloviza, title: helloviza.slice(0, 20) },
      { id: MENU_BUTTON_IDS.concierge, title: concierge.slice(0, 20) },
    ],
  };
}

/** A tapped menu button → the business line; "other"/anything else → null. */
export function menuChoiceToBusinessLine(buttonId: string): BusinessLine | null {
  switch (buttonId) {
    case MENU_BUTTON_IDS.plumtrips: return "plumtrips";
    case MENU_BUTTON_IDS.helloviza: return "helloviza";
    case MENU_BUTTON_IDS.concierge: return "concierge";
    default: return null;
  }
}

export function isMenuButton(buttonId: string): boolean {
  return Object.values(MENU_BUTTON_IDS).includes(buttonId as any);
}

/** Do not re-send the menu more often than this while unanswered. */
export const MENU_RESEND_MS = 24 * 60 * 60 * 1000;

export function menuRecentlySent(sentAt: Date | null | undefined, now: Date): boolean {
  return Boolean(sentAt) && now.getTime() - new Date(sentAt as Date).getTime() < MENU_RESEND_MS;
}

/**
 * Send the interactive intent menu on this thread through the Slice-4a
 * wrapper (origin "support"; the conversation is attached so the persisted
 * Message lands on THIS thread). Stamps intentMenuSentAt only when Meta
 * accepted the send.
 */
export async function sendIntentMenu(conversationId: mongoose.Types.ObjectId, to: string, now: Date): Promise<boolean> {
  const menu = await menuCopy();
  const { outcome } = await sendButtonsOutcome(to, menu.text, menu.buttons, { origin: "support", conversationId, payload: { intentMenu: true }, now });
  const sent = outcome.ok && Boolean(outcome.wamid);
  if (sent) await PlumConnectConversation.updateOne({ _id: conversationId }, { $set: { intentMenuSentAt: now } });
  whatsappLogger.info("PlumConnect intent: menu " + (sent ? "sent" : "NOT sent"), { conversationId: String(conversationId) });
  return sent;
}

/* ───────────────────────────── recording ───────────────────────────── */

export async function recordIntent(
  conversationId: mongoose.Types.ObjectId,
  businessLine: BusinessLine,
  source: IntentSource,
  confidence: number | null,
  intent: string,
): Promise<void> {
  await PlumConnectConversation.updateOne(
    { _id: conversationId },
    { $set: { businessLine, intentSource: source, intentConfidence: confidence, intent, kind: "lead" } },
  );
}
