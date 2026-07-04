// apps/backend/src/services/arrivalInbound.ts
//
// Phase 4 (Arrive) — inbound WhatsApp dispatch for the arrival concierge.
//
// SECURITY MODEL: inbound WhatsApp is UNAUTHENTICATED; the sender phone is the
// only identity signal. We process a message ONLY when the sender's number
// matches an ACTIVE ArrivalSession (that session row is the entire data scope).
// Unknown numbers get NO reply (silence) + a metric. No LLM ever sees inbound
// text — this is a constrained command set (a prompt-injection boundary).

import ArrivalSession from "../models/ArrivalSession.js";
import { sendTextMessageResult, sendButtonMessage } from "./whatsappCloud.service.js";
import { toWaRecipient } from "../utils/waNumber.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { arriveMetric } from "../utils/plutoMetricsBuilder.js";
import { ARRIVAL_BUTTONS } from "./arrivalSession.js";
import { resolveCommand } from "./arrivalConcierge.js";
import { escalateToBooker } from "./arrivalEscalation.js";

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX = 20; // max processed inbound / session / hour

export interface ArrivalInboundInput {
  waId: string; // sender number as delivered by Meta (no leading "+")
  messageId: string;
  buttonId?: string; // arr_* on a button tap
  text?: string;
  phoneNumberId?: string;
}

function toE164(waId: string): string {
  return "+" + String(waId || "").replace(/^\+/, "");
}

/** Lightweight routing predicate for the webhook (indexed lookup, no mutation). */
export async function hasActiveArrivalSession(waId: string): Promise<boolean> {
  if (!waId) return false;
  const s = await ArrivalSession.findOne({ phone: toE164(waId), status: "ACTIVE" })
    .select("_id")
    .lean();
  return Boolean(s);
}

/** The ACTIVE session for a sender's OWN number (most recent), or null. */
async function findActiveSession(waId: string): Promise<any> {
  if (!waId) return null;
  return ArrivalSession.findOne({ phone: toE164(waId), status: "ACTIVE" }).sort({ openedAt: -1 });
}

/**
 * Fire-and-forget handler for an inbound arrival message. Enforces the security
 * model, messageId idempotency, and the per-session hourly rate limit, then
 * delegates to the constrained command set. Never throws to the caller.
 */
export async function dispatchArrivalInbound(input: ArrivalInboundInput): Promise<void> {
  const { waId, messageId } = input;
  try {
    const found = await findActiveSession(waId);

    // SECURITY: no ACTIVE session for this sender → SILENCE (no reply).
    if (!found) {
      void emitMetric(arriveMetric("pluto.arrive.unknown_sender", {}, "warn"));
      return;
    }

    // Idempotency: claim the messageId atomically. A duplicate delivery (Meta
    // retries) finds it already present and no-ops.
    let session: any = found;
    if (messageId) {
      const claimed = await ArrivalSession.findOneAndUpdate(
        { _id: found._id, processedMessageIds: { $ne: messageId } },
        { $push: { processedMessageIds: messageId } },
        { new: true },
      );
      if (!claimed) return; // already processed
      session = claimed;
    }

    const workspaceId = String(session.workspaceId);
    const now = new Date();

    // Rate limit: rolling 1-hour window per session.
    const winStart = session.rateWindowStart ? new Date(session.rateWindowStart) : null;
    if (!winStart || now.getTime() - winStart.getTime() > RATE_WINDOW_MS) {
      session.rateWindowStart = now;
      session.rateWindowCount = 0;
    }
    if ((session.rateWindowCount || 0) >= RATE_MAX) {
      const notified = session.rateLimitNotifiedAt ? new Date(session.rateLimitNotifiedAt) : null;
      const windowRef = new Date(session.rateWindowStart as any);
      if (!notified || notified.getTime() < windowRef.getTime()) {
        await sendTextMessageResult(toWaRecipient(session.phone), "Thanks — an agent will follow up with you shortly.");
        session.rateLimitNotifiedAt = now;
      }
      session.lastInboundAt = now;
      await session.save();
      void emitMetric(arriveMetric("pluto.arrive.rate_limited", { workspaceId }, "warn"));
      return;
    }

    session.rateWindowCount = (session.rateWindowCount || 0) + 1;
    session.messageCount = (session.messageCount || 0) + 1;
    session.lastInboundAt = now;

    await executeArrivalCommand(session, input);

    await session.save();
    void emitMetric(arriveMetric("pluto.arrive.message_handled", { workspaceId }));
  } catch (e: any) {
    void emitMetric(arriveMetric("pluto.arrive.message_handled", { reason: e?.message }, "error"));
  }
}

const MENU_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day
const MENU_MAX = 3; // max unknown-command menus / session / day

/**
 * Execute the constrained command set (Step 3). resolveCommand is a pure
 * directive; here we apply the stateful bits: the daily menu cap, the opt-out
 * status change, and HELP escalation (Step 4 wires the real escalation).
 */
async function executeArrivalCommand(session: any, input: ArrivalInboundInput): Promise<void> {
  const to = toWaRecipient(session.phone);
  const result = resolveCommand(session, input.buttonId, input.text);

  if (result.action === "OPT_OUT") {
    session.status = "OPTED_OUT";
    if (result.text) await sendTextMessageResult(to, result.text);
    return;
  }

  if (result.action === "ESCALATE") {
    const reply = await escalateToBooker(session);
    await sendTextMessageResult(to, reply);
    return;
  }

  if (result.action === "MENU") {
    // Cap the unknown-command menu so we never loop endlessly.
    const now = new Date();
    const winStart = session.menuWindowStart ? new Date(session.menuWindowStart) : null;
    if (!winStart || now.getTime() - winStart.getTime() > MENU_WINDOW_MS) {
      session.menuWindowStart = now;
      session.menuCount = 0;
    }
    if ((session.menuCount || 0) >= MENU_MAX) {
      await sendTextMessageResult(to, "Reply HELP to reach a person.");
      return;
    }
    session.menuCount = (session.menuCount || 0) + 1;
    await sendButtonMessage(to, result.text || "How can I help?", result.buttons || ARRIVAL_BUTTONS);
    return;
  }

  // REPLY
  await sendTextMessageResult(to, result.text || "");
}
