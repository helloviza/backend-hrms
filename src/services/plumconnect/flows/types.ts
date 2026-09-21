// apps/backend/src/services/plumconnect/flows/types.ts
//
// PlumConnect Slice 6 — the shape of a per-department qualification flow.
// A flow is data: an ordered list of deterministic questions, each with the
// copy to send, the parser for the answer, and the Lead fields the parsed
// answer lands in. bot.ts is the ONLY interpreter; it drives whichever flow
// the registry (index.ts) returns for the conversation's businessLine.
// No question may call an LLM, read anything but the answer text, or write
// anything but the Lead paths it names.
//
// Track C: copy is no longer inline. A flow names the canned-message KEY
// for each send (services/plumconnect/messages.ts) and, where the text
// takes a placeholder, how to fill it from the turn; the bot resolves the
// key through the store (line override → global → seed default) at send
// time, so an admin's edit takes effect on the next message.

import type { BusinessLine } from "../../../models/plumconnect/Conversation.js";

/** A Lead.updateOne `$set` patch — dotted paths into the Lead document. */
export type LeadPatch = Record<string, unknown>;

export interface ParsedAnswer {
  /** Echoed into the NEXT question's copy when that copy wants it (a name). Never anything else. */
  display: string;
  /** What the answer writes on the Lead: deterministic, capped, never interpreted. */
  set: LeadPatch;
}

/** A canned-message reference: the store key, plus the placeholder values the turn supplies. */
export interface MessageRef {
  key: string;
  /** Placeholder values for this send, from the previous answer's `display` (the name, usually). */
  vars?: (ctx: { previousAnswer: string }) => Record<string, string>;
}

export interface FlowQuestion {
  /** Conversation.bot.step while this question is open. Unique within the flow. */
  id: string;
  /** The question (the store key; `vars` fills e.g. {name} from the previous answer). */
  ask: MessageRef;
  /** The re-ask after an unparseable answer (asked once; the second miss stops the bot). */
  askAgain: MessageRef;
  /** Deterministic parse of the answer → the Lead patch; null = unparseable. */
  parse: (text: string, now: Date) => ParsedAnswer | null;
  /**
   * On the second miss, before the bot gives up: keep what they typed
   * somewhere a human reads (the Slice 3c "Dates (as typed)" discipline).
   * Optional — a question with nothing worth keeping omits it.
   */
  keepOnGiveUp?: (text: string) => LeadPatch;
}

export interface QualificationFlow {
  businessLine: BusinessLine;
  /** Message 1 on a fresh Lead: greeting + the first question in one send — `key` without an ad headline, `withHeadline` (takes {headline}) with one. */
  welcome: { key: string; withHeadline: string };
  /** Asked in order, one per turn. The last answer completes the flow. */
  questions: readonly FlowQuestion[];
  /** The completion ack when the Lead has a real contact name (takes {name}). */
  handover: string;
  /** The completion ack without a name, and the give-up ack after a second unparseable answer. */
  handoverUnparsed: string;
}
