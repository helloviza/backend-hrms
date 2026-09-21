// apps/backend/src/services/plumconnect/flows/index.ts
//
// PlumConnect Slice 6 — the qualification-flow registry and the gate.
//
// Stage 1 (Slice 5) decided WHAT the contact wants: Conversation.businessLine.
// Stage 2 (this slice) asks the department's qualifying questions — but only
// where qualification is required. The rule, made structural:
//
//   concierge / plumtrips / helloviza  → that department's flow runs
//   support / expense / general        → NO flow. The contact goes straight
//                                        to the human queue or the existing
//                                        expense path and the bot never
//                                        speaks. Never ask sales questions of
//                                        a support or expense contact.
//
// The dispatcher consults requiresQualification() after routing; bot.ts asks
// the registry which flow a conversation is on. Nothing else knows the
// questions. Human takeover (assignment / agent send) silences any flow for
// good — the Slice 3c contract, owned by bot.ts, unchanged.

import type { BusinessLine, IPlumConnectConversation } from "../../../models/plumconnect/Conversation.js";
import type { QualificationFlow } from "./types.js";
import { conciergeFlow } from "./concierge.js";
import { plumtripsFlow } from "./plumtrips.js";
import { hellovizaFlow } from "./helloviza.js";

export type { FlowQuestion, LeadPatch, ParsedAnswer, QualificationFlow } from "./types.js";

/**
 * Everything a routed inbound can land on. The three business lines are the
 * Slice 5 enum; the rest are the dispatcher's non-lead buckets, named here
 * so the gate can say "no" to them by name rather than by omission.
 */
export type QualificationLine = BusinessLine | "support" | "expense" | "general";

/** The registry: one flow per business line that qualifies. Keyed so a new line is a one-line addition. */
export const QUALIFICATION_FLOWS: Readonly<Record<BusinessLine, QualificationFlow>> = {
  concierge: conciergeFlow,
  plumtrips: plumtripsFlow,
  helloviza: hellovizaFlow,
};

/** The gate. True only for a business line with a registered flow. */
export function requiresQualification(line: QualificationLine | null | undefined): line is BusinessLine {
  return Boolean(line && Object.prototype.hasOwnProperty.call(QUALIFICATION_FLOWS, line));
}

/** The flow for a line, or null when qualification is not required. */
export function qualificationFlowFor(line: QualificationLine | null | undefined): QualificationFlow | null {
  return requiresQualification(line) ? QUALIFICATION_FLOWS[line] : null;
}

/**
 * The line a thread is already routed to. A pre-Slice-5 lead thread (Lead
 * exists, no businessLine stamped) was a holiday lead by construction.
 */
export function threadBusinessLine(conversation: IPlumConnectConversation): BusinessLine | null {
  if (conversation.businessLine) return conversation.businessLine;
  if (conversation.leadId) return "concierge";
  return null;
}

/** The flow a conversation's bot drives, or null (no line / no qualification). */
export function flowForConversation(conversation: IPlumConnectConversation): QualificationFlow | null {
  return qualificationFlowFor(threadBusinessLine(conversation));
}
