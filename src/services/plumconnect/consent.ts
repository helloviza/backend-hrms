// apps/backend/src/services/plumconnect/consent.ts
//
// PlumConnect Slice 3c, Part C — the expense-capability bind for a
// SOFT-matched employee: someone whose phone matches a User (User.phone /
// TravellerProfile.mobile) but who has no User.waId, and who has just sent
// something expense-shaped (a photo / document — the same signal the expense
// capture uses). Slice 2 routed these to support and never enqueued; this
// closes that gap without ever weakening the §9 invariant:
//
//   • the receipt that triggered the prompt is NOT enqueued (soft never
//     enqueues, never touches a workspaceId);
//   • the ONLY writer of User.waId is still the Slice-1 resolver's
//     bindWaId(), called here on an explicit YES;
//   • a bind needs exactly ONE ACTIVE User behind the soft match — an
//     ambiguous phone (two users) is never guessed at.
//
// After YES the sender is hard, and their NEXT expense message goes through
// the wrap normally (Slice 2). "hi" from a soft employee is still support.

import type mongoose from "mongoose";
import PlumConnectContact from "../../models/plumconnect/Contact.js";
import type { IdentityResolution } from "./resolveIdentity.js";
import { bindWaId } from "./resolveIdentity.js";
import { sendAndPersist } from "./send.js";
import { getMessage } from "./messages.js";
import { whatsappLogger } from "../../utils/logger.js";

export const CONSENT_YES_BUTTON = "pc_bind_yes";
export const CONSENT_NO_BUTTON = "pc_bind_no";
/** Do not re-prompt more often than this while an answer is outstanding. */
export const CONSENT_REPROMPT_MS = 60 * 60 * 1000;

const YES_WORDS = new Set(["yes", "y", "yeah", "yep", "ok", "okay", "confirm", "haan", "ha"]);
const NO_WORDS = new Set(["no", "n", "nope", "cancel", "nahi", "nah"]);

export interface ConsentState {
  expenseBindAskedAt?: Date | null;
  expenseBindAnsweredAt?: Date | null;
  expenseBindAnswer?: "yes" | "no" | null;
}

/** Is this inbound an expense-shaped message (what the chain would capture)? */
export function isExpenseShaped(type: string): boolean {
  return type === "image" || type === "document";
}

/** A consent answer, if the inbound is one. Buttons first, then plain words. */
export function parseConsentAnswer(text: string, buttonId: string): "yes" | "no" | null {
  if (buttonId === CONSENT_YES_BUTTON) return "yes";
  if (buttonId === CONSENT_NO_BUTTON) return "no";
  const w = String(text || "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (YES_WORDS.has(w)) return "yes";
  if (NO_WORDS.has(w)) return "no";
  return null;
}

/** An answer is pending when we asked and nothing has been recorded since. */
export function consentPending(consent: ConsentState | undefined): boolean {
  return Boolean(consent?.expenseBindAskedAt) && !consent?.expenseBindAnsweredAt;
}

export interface ConsentContext {
  contactId: mongoose.Types.ObjectId;
  conversationId: mongoose.Types.ObjectId;
  canonical: string;
  identity: IdentityResolution;
  consent: ConsentState | undefined;
  now?: Date;
}

export type ConsentPromptOutcome = { prompted: true } | { prompted: false; reason: "recently_asked" | "already_answered" | "not_sent" };

/** Send the bind prompt (rate-limited while an answer is outstanding). Never enqueues. */
export async function promptForConsent(ctx: ConsentContext): Promise<ConsentPromptOutcome> {
  const now = ctx.now ?? new Date();
  const c = ctx.consent;
  if (c?.expenseBindAnsweredAt) return { prompted: false, reason: "already_answered" };
  if (c?.expenseBindAskedAt && now.getTime() - new Date(c.expenseBindAskedAt).getTime() < CONSENT_REPROMPT_MS) {
    return { prompted: false, reason: "recently_asked" };
  }
  const r = await sendAndPersist({
    conversationId: ctx.conversationId,
    to: ctx.canonical,
    text: await getMessage("consent.prompt", null),
    buttons: [
      { id: CONSENT_YES_BUTTON, title: (await getMessage("consent.prompt.yes", null)).slice(0, 20) },
      { id: CONSENT_NO_BUTTON, title: (await getMessage("consent.prompt.no", null)).slice(0, 20) },
    ],
    origin: "consent", payload: { consent: "expense_bind_prompt" },
    now,
  });
  if (!r.sent) return { prompted: false, reason: "not_sent" };
  await PlumConnectContact.updateOne({ _id: ctx.contactId }, { $set: { "consent.expenseBindAskedAt": now } });
  whatsappLogger.info("PlumConnect consent: bind prompt sent", { contactId: String(ctx.contactId) });
  return { prompted: true };
}

export type ConsentAnswerOutcome =
  | { answer: "yes"; bound: true; userId: string }
  | { answer: "yes"; bound: false; reason: "ambiguous_or_no_user" | "invalid_phone" | "user_inactive_or_missing" | "waid_taken" }
  | { answer: "no"; bound: false };

/** Record the answer; on YES bind through the single writer when exactly one ACTIVE user matches. */
export async function recordConsentAnswer(ctx: ConsentContext, answer: "yes" | "no"): Promise<ConsentAnswerOutcome> {
  const now = ctx.now ?? new Date();
  const base = { "consent.expenseBindAnsweredAt": now, "consent.expenseBindAnswer": answer };

  if (answer === "no") {
    await PlumConnectContact.updateOne({ _id: ctx.contactId }, { $set: base });
    await sendAndPersist({ conversationId: ctx.conversationId, to: ctx.canonical, text: await getMessage("consent.declined", null), origin: "consent", payload: { consent: "declined" }, now });
    return { answer: "no", bound: false };
  }

  const users = ctx.identity.soft.users;
  if (users.length !== 1) {
    await PlumConnectContact.updateOne({ _id: ctx.contactId }, { $set: base });
    await sendAndPersist({ conversationId: ctx.conversationId, to: ctx.canonical, text: await getMessage("consent.ambiguous", null), origin: "consent", payload: { consent: "ambiguous" }, now });
    whatsappLogger.warn("PlumConnect consent: YES but no single user behind the soft match", { contactId: String(ctx.contactId), candidates: users.length });
    return { answer: "yes", bound: false, reason: "ambiguous_or_no_user" };
  }

  const userId = users[0].userId;
  const bind = await bindWaId(userId, ctx.canonical);
  if (bind.ok === false) {
    const reason = bind.reason;
    await PlumConnectContact.updateOne({ _id: ctx.contactId }, { $set: base });
    await sendAndPersist({ conversationId: ctx.conversationId, to: ctx.canonical, text: await getMessage("consent.bind_failed", null), origin: "consent", payload: { consent: "bind_failed", reason }, now });
    return { answer: "yes", bound: false, reason };
  }

  await PlumConnectContact.updateOne(
    { _id: ctx.contactId },
    { $set: { ...base, "refs.userId": userId, identityState: "verified_employee" } },
  );
  await sendAndPersist({ conversationId: ctx.conversationId, to: ctx.canonical, text: await getMessage("consent.bound", null), origin: "consent", payload: { consent: "bound", userId: String(userId) }, now });
  whatsappLogger.info("PlumConnect consent: bound", { contactId: String(ctx.contactId), userId: String(userId) });
  return { answer: "yes", bound: true, userId: String(userId) };
}
