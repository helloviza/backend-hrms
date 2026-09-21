// apps/backend/src/services/plumconnect/flows/types.ts
//
// PlumConnect Slice 6 — the shape of a per-department qualification flow.
// A flow is data: an ordered list of deterministic questions, each with the
// copy to send, the parser for the answer, and the Lead fields the parsed
// answer lands in. bot.ts is the ONLY interpreter; it drives whichever flow
// the registry (index.ts) returns for the conversation's businessLine.
// No question may call an LLM, read anything but the answer text, or write
// anything but the Lead paths it names.

import type { BusinessLine } from "../../../models/plumconnect/Conversation.js";

/** A Lead.updateOne `$set` patch — dotted paths into the Lead document. */
export type LeadPatch = Record<string, unknown>;

export interface ParsedAnswer {
  /** Echoed into the NEXT question's copy when that copy wants it (a name). Never anything else. */
  display: string;
  /** What the answer writes on the Lead: deterministic, capped, never interpreted. */
  set: LeadPatch;
}

export interface FlowQuestion {
  /** Conversation.bot.step while this question is open. Unique within the flow. */
  id: string;
  /** The question, given the previous answer's `display` ("" when there is none). */
  ask: (previousAnswer: string) => string;
  /** The re-ask after an unparseable answer (asked once; the second miss stops the bot). */
  askAgain: string;
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
  /** Message 1 on a fresh Lead: greeting + the first question in one send. `headline` is the (capped) ad headline or "". */
  welcome: (headline: string) => string;
  /** Asked in order, one per turn. The last answer completes the flow. */
  questions: readonly FlowQuestion[];
  /** The completion ack when the Lead has a real contact name. */
  handover: (name: string) => string;
  /** The completion ack without a name, and the give-up ack after a second unparseable answer. */
  handoverUnparsed: string;
}
