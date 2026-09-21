// apps/backend/src/services/plumconnect/messages.ts
//
// PlumConnect Track C — the canned-message store's read path and its
// defaults. MESSAGE_DEFAULTS is the ONE source of truth for every string
// the system sends: it is what the seed writes (verbatim — today's copy),
// and what getMessage() falls back to when a key has no row, so a missing
// or typo'd key can never send an empty message.
//
//   getMessage(key, line, vars)   line override → global row → default,
//                                 enabled rows only; read LIVE on every
//                                 send (an edit takes effect immediately)
//   renderMessage(text, vars)     deterministic {placeholder} substitution
//                                 of the key's declared variables only — no
//                                 templating engine, no LLM; an unknown
//                                 placeholder is left as typed
//
// Key families: <flow>.<step> for the three qualification flows (Slice 6),
// menu.* (Slice 5), consent.* (Slice 3c), busy.<line> (Track C — sent once
// when Track B holds a lead because its mapped agents are all away).

import mongoose from "mongoose";
import PlumConnectCannedMessage from "../../models/plumconnect/CannedMessage.js";
import { ACCESS_LINES, isAccessLine, type AccessLine } from "./access.js";

export interface MessageDefault {
  text: string;
  /** The {placeholders} this text may use. */
  variables: readonly string[];
  /** For the editor. */
  description: string;
}

const ASK_NAME_AGAIN = "Sorry, I didn't catch that — what's your name?";

export const MESSAGE_DEFAULTS: Readonly<Record<string, MessageDefault>> = {
  // ── concierge (Slice 3c, relocated verbatim) ──────────────────────────
  "concierge.welcome": { text: "Hi! Thanks for reaching out to Plumtrips. To get started, what's your name?", variables: [], description: "Concierge: first message (organic, no ad headline)" },
  "concierge.welcome_headline": { text: 'Hi! Thanks for reaching out to Plumtrips about "{headline}". To get started, what\'s your name?', variables: ["headline"], description: "Concierge: first message when the contact tapped an ad" },
  "concierge.ask_name_again": { text: ASK_NAME_AGAIN, variables: [], description: "Concierge: name not understood, ask once more" },
  "concierge.ask_destination": { text: "Nice to meet you, {name}! Where would you like to go?", variables: ["name"], description: "Concierge: question 2" },
  "concierge.ask_destination_again": { text: "Which destination did you have in mind?", variables: [], description: "Concierge: destination not understood" },
  "concierge.ask_dates": { text: "Great — when are you planning to travel? (e.g. 12 Oct to 19 Oct)", variables: [], description: "Concierge: question 3" },
  "concierge.ask_dates_again": { text: "Could you share your travel dates? A rough date is fine, e.g. 15 Nov.", variables: [], description: "Concierge: dates not understood" },
  "concierge.handover": { text: "Perfect, {name}. A Plumtrips holiday planner will be with you shortly.", variables: ["name"], description: "Concierge: flow complete" },
  "concierge.handover_unparsed": { text: "Thanks — a Plumtrips holiday planner will pick this up with you shortly.", variables: [], description: "Concierge: handover without a name / after a second miss" },
  // ── plumtrips (Slice 6) ───────────────────────────────────────────────
  "plumtrips.welcome": { text: "Hi! Thanks for reaching out to Plumtrips. To get started, what's your name?", variables: [], description: "Plumtrips: first message (organic)" },
  "plumtrips.welcome_headline": { text: 'Hi! Thanks for reaching out to Plumtrips about "{headline}". To get started, what\'s your name?', variables: ["headline"], description: "Plumtrips: first message from an ad" },
  "plumtrips.ask_name_again": { text: ASK_NAME_AGAIN, variables: [], description: "Plumtrips: name not understood" },
  "plumtrips.ask_company": { text: "Nice to meet you, {name}! Which company are you with?", variables: ["name"], description: "Plumtrips: question 2" },
  "plumtrips.ask_company_again": { text: "Which company or organisation is this for?", variables: [], description: "Plumtrips: company not understood" },
  "plumtrips.ask_travellers": { text: "Thanks. Roughly how many employees travel for work? (a number is fine, e.g. 50)", variables: [], description: "Plumtrips: question 3" },
  "plumtrips.ask_travellers_again": { text: "Could you give a rough number of travelling employees? e.g. 20", variables: [], description: "Plumtrips: travellers not understood" },
  "plumtrips.ask_trips": { text: "And roughly how many trips a month does the team take? (e.g. 10)", variables: [], description: "Plumtrips: question 4" },
  "plumtrips.ask_trips_again": { text: "A rough number of trips per month is fine, e.g. 5.", variables: [], description: "Plumtrips: trips not understood" },
  "plumtrips.handover": { text: "Perfect, {name}. A Plumtrips corporate travel specialist will be with you shortly.", variables: ["name"], description: "Plumtrips: flow complete" },
  "plumtrips.handover_unparsed": { text: "Thanks — a Plumtrips corporate travel specialist will pick this up with you shortly.", variables: [], description: "Plumtrips: handover without a name / after a second miss" },
  // ── helloviza (Slice 6) ───────────────────────────────────────────────
  "helloviza.welcome": { text: "Hi! Thanks for reaching out to Helloviza. To get started, what's your name?", variables: [], description: "Helloviza: first message (organic)" },
  "helloviza.welcome_headline": { text: 'Hi! Thanks for reaching out to Helloviza about "{headline}". To get started, what\'s your name?', variables: ["headline"], description: "Helloviza: first message from an ad" },
  "helloviza.ask_name_again": { text: ASK_NAME_AGAIN, variables: [], description: "Helloviza: name not understood" },
  "helloviza.ask_country": { text: "Nice to meet you, {name}! Which country do you need a visa for?", variables: ["name"], description: "Helloviza: question 2" },
  "helloviza.ask_country_again": { text: "Which country is the visa for?", variables: [], description: "Helloviza: country not understood" },
  "helloviza.ask_visa_type": { text: "Got it. What type of visa is it — tourist, business, student, work, transit or medical?", variables: [], description: "Helloviza: question 3" },
  "helloviza.ask_visa_type_again": { text: "Is that a tourist, business, student, work, transit or medical visa?", variables: [], description: "Helloviza: visa type not understood" },
  "helloviza.handover": { text: "Perfect, {name}. A Helloviza visa expert will be with you shortly.", variables: ["name"], description: "Helloviza: flow complete" },
  "helloviza.handover_unparsed": { text: "Thanks — a Helloviza visa expert will pick this up with you shortly.", variables: [], description: "Helloviza: handover without a name / after a second miss" },
  // ── intent menu (Slice 5) ─────────────────────────────────────────────
  "menu.text": { text: "Hi! You've reached Plumtrips. What can we help with today?\nTap an option — or just tell us in a few words if it's something else.", variables: [], description: "The 3-button menu sent when the business line is unknown" },
  "menu.button.plumtrips": { text: "Corporate travel", variables: [], description: "Menu button 1 (max 20 characters)" },
  "menu.button.helloviza": { text: "Visa", variables: [], description: "Menu button 2 (max 20 characters)" },
  "menu.button.concierge": { text: "Holiday", variables: [], description: "Menu button 3 (max 20 characters)" },
  // ── expense consent (Slice 3c) ────────────────────────────────────────
  "consent.prompt": { text: "I can log expenses for you once you confirm this is your Plumtrips number. Reply YES to link it, or NO to leave it.", variables: [], description: "Soft-matched employee sent a receipt: the bind prompt" },
  "consent.prompt.yes": { text: "Yes, link it", variables: [], description: "Bind prompt button 1 (max 20 characters)" },
  "consent.prompt.no": { text: "No", variables: [], description: "Bind prompt button 2 (max 20 characters)" },
  "consent.declined": { text: "No problem — I won't log expenses from this number.", variables: [], description: "They said NO" },
  "consent.ambiguous": { text: "I couldn't match this number to a single Plumtrips account. Please contact your admin to link it.", variables: [], description: "They said YES but the number matches no single account" },
  "consent.bind_failed": { text: "I couldn't link this number just now. Please contact your admin.", variables: [], description: "They said YES but the link could not be written" },
  "consent.bound": { text: "Linked! Send the receipt again and I'll log it.", variables: [], description: "They said YES and the number is now linked" },
  // ── busy / away (Track C — the only new send) ─────────────────────────
  "busy.plumtrips": { text: "Our corporate travel team is busy right now — please allow us a moment, or reply CALLBACK to request a callback.", variables: [], description: "Sent once when a Plumtrips lead is held because every mapped agent is away" },
  "busy.helloviza": { text: "Our visa team is busy right now — please allow us a moment, or reply CALLBACK to request a callback.", variables: [], description: "Sent once when a Helloviza lead is held because every mapped agent is away" },
  "busy.concierge": { text: "Our holiday team is busy right now — please allow us a moment, or reply CALLBACK to request a callback.", variables: [], description: "Sent once when a Concierge lead is held because every mapped agent is away" },
  "busy.support": { text: "Our support team is busy, please allow us a moment or request a callback", variables: [], description: "Sent once when a support thread is held because every mapped agent is away" },
};

export const MESSAGE_KEYS: readonly string[] = Object.keys(MESSAGE_DEFAULTS);

export function isMessageKey(key: unknown): key is string {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(MESSAGE_DEFAULTS, key);
}

/** Deterministic {placeholder} substitution. Only declared variables are replaced; anything else is left as typed. */
export function renderMessage(text: string, vars: Record<string, string> = {}): string {
  return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? "") : m));
}

/** The {placeholders} used in a text. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...String(text).matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]))];
}

/** The text a key resolves to for a line: line override → global row → default. Never empty. */
export async function resolveMessageText(key: string, line: AccessLine | null | undefined): Promise<{ text: string; source: "line" | "global" | "default" }> {
  const fallback = MESSAGE_DEFAULTS[key]?.text ?? "";
  const rows: any[] = await PlumConnectCannedMessage.find({ key, enabled: true, line: { $in: [line ?? null, null] } })
    .select("line text")
    .lean();
  const byLine = line ? rows.find((r) => r.line === line) : null;
  if (byLine && String(byLine.text).trim()) return { text: String(byLine.text), source: "line" };
  const global = rows.find((r) => r.line === null || r.line === undefined);
  if (global && String(global.text).trim()) return { text: String(global.text), source: "global" };
  return { text: fallback, source: "default" };
}

/** THE read path: the resolved, rendered text for a key on a line. */
export async function getMessage(key: string, line: AccessLine | null | undefined, vars: Record<string, string> = {}): Promise<string> {
  const { text } = await resolveMessageText(key, line);
  return renderMessage(text, vars);
}

/** The default text, rendered — for tests and the seed. */
export function defaultMessage(key: string, vars: Record<string, string> = {}): string {
  return renderMessage(MESSAGE_DEFAULTS[key]?.text ?? "", vars);
}

/* ───────────────────────────── seed ───────────────────────────── */

/**
 * Write every default as a global row, $setOnInsert only — a row that
 * exists (edited or not) is never touched. Idempotent. Returns how many
 * rows were created.
 */
export async function seedCannedMessages(): Promise<{ created: number; total: number }> {
  let created = 0;
  for (const [key, d] of Object.entries(MESSAGE_DEFAULTS)) {
    const r = await PlumConnectCannedMessage.updateOne(
      { key, line: null },
      { $setOnInsert: { key, line: null, text: d.text, variables: [...d.variables], enabled: true, updatedBy: null } },
      { upsert: true },
    );
    if (r.upsertedCount) created += 1;
  }
  return { created, total: MESSAGE_KEYS.length };
}

/* ───────────────────────────── editor view + write ───────────────────────────── */

export interface MessageView {
  key: string;
  line: AccessLine | null;
  text: string;
  defaultText: string;
  /** A row exists and its text differs from the default (global) or from the global text (line). */
  overridden: boolean;
  enabled: boolean;
  variables: string[];
  description: string;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** Every key with its global text, plus every line row — what the editor lists. */
export async function listMessages(): Promise<MessageView[]> {
  const rows: any[] = await PlumConnectCannedMessage.find({}).sort({ key: 1, line: 1 }).lean();
  const out: MessageView[] = [];
  for (const key of MESSAGE_KEYS) {
    const d = MESSAGE_DEFAULTS[key];
    const global = rows.find((r) => r.key === key && (r.line === null || r.line === undefined));
    const globalText = global?.text ?? d.text;
    out.push({
      key, line: null, text: globalText, defaultText: d.text, overridden: Boolean(global) && global.text !== d.text,
      enabled: global ? Boolean(global.enabled) : true, variables: [...d.variables], description: d.description,
      updatedAt: global?.updatedAt ?? null, updatedBy: global?.updatedBy ? String(global.updatedBy) : null,
    });
    for (const line of ACCESS_LINES) {
      const row = rows.find((r) => r.key === key && r.line === line);
      if (!row) continue;
      out.push({
        key, line, text: row.text, defaultText: d.text, overridden: true, enabled: Boolean(row.enabled), variables: [...d.variables], description: d.description,
        updatedAt: row.updatedAt ?? null, updatedBy: row.updatedBy ? String(row.updatedBy) : null,
      });
    }
  }
  return out;
}

export type UpsertMessageResult = { ok: true; view: MessageView } | { ok: false; error: string };

/**
 * Edit a key's text / enabled flag, globally or for one line. A canned
 * message can never be blanked into silence; placeholders must be ones the
 * key declares; a button title is capped at WhatsApp's 20 characters.
 */
export async function upsertMessage(input: { key: unknown; line?: unknown; text?: unknown; enabled?: unknown; updatedBy?: mongoose.Types.ObjectId | null }): Promise<UpsertMessageResult> {
  if (!isMessageKey(input.key)) return { ok: false, error: "Unknown message key." };
  const key = input.key;
  const line = input.line === undefined || input.line === null || input.line === "" ? null : input.line;
  if (line !== null && !isAccessLine(line)) return { ok: false, error: "line must be one of plumtrips, helloviza, concierge, support (or omitted for the global text)." };
  if (input.text === undefined && input.enabled === undefined) return { ok: false, error: "Nothing to change: send text and/or enabled." };

  const $set: Record<string, unknown> = { updatedBy: input.updatedBy ?? null };
  if (input.text !== undefined) {
    const text = String(input.text ?? "").replace(/\r\n/g, "\n").trim();
    if (!text) return { ok: false, error: "A canned message cannot be empty." };
    if (text.length > 4096) return { ok: false, error: "Text is too long (max 4096 characters)." };
    if (/\.button\.|consent\.prompt\.(yes|no)$/.test(key) && text.length > 20) return { ok: false, error: "A button title is limited to 20 characters." };
    const allowed = new Set(MESSAGE_DEFAULTS[key].variables);
    const unknown = placeholdersIn(text).filter((v) => !allowed.has(v));
    if (unknown.length) return { ok: false, error: `Unknown placeholder(s) ${unknown.map((v) => `{${v}}`).join(", ")} — this message supports ${allowed.size ? [...allowed].map((v) => `{${v}}`).join(", ") : "none"}.` };
    $set.text = text;
  }
  if (input.enabled !== undefined) $set.enabled = Boolean(input.enabled);

  await PlumConnectCannedMessage.updateOne(
    { key, line },
    { $set, $setOnInsert: { key, line, variables: [...MESSAGE_DEFAULTS[key].variables], ...(input.text === undefined ? { text: MESSAGE_DEFAULTS[key].text } : {}) } },
    { upsert: true },
  );
  const view = (await listMessages()).find((v) => v.key === key && v.line === line)!;
  return { ok: true, view };
}

/** Remove a line override (the line falls back to the global text). */
export async function deleteLineOverride(key: unknown, line: unknown): Promise<boolean> {
  if (!isMessageKey(key) || !isAccessLine(line)) return false;
  const r = await PlumConnectCannedMessage.deleteOne({ key, line });
  return r.deletedCount > 0;
}
