// apps/backend/src/services/tripNotifier.ts
//
// Delivers a TripAlert over the channel on its TripWatch. WhatsApp uses the
// in-backend Meta Cloud API (template if WA_DISRUPTION_TEMPLATE is set, else
// free-form for dev / open-window). On WhatsApp failure/unconfigured with a
// fallback email, falls back to EMAIL. Retry once next cycle, then mark FAILED.

import {
  sendTemplateMessage,
  sendTextMessageResult,
} from "./whatsappCloud.service.js";
import { toWaRecipient } from "../utils/waNumber.js";
import { sendMail } from "../utils/mailer.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { watchMetric } from "../utils/plutoMetricsBuilder.js";

export const MAX_ATTEMPTS = 2;

/** PURE: short traveler-facing message. */
export function renderAlertMessage(alert: any, watch: any): string {
  const route = `${watch.origin || "?"}→${watch.destination || "?"}`;
  const date = watch.departDate
    ? new Date(watch.departDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })
    : "";
  return `Your flight ${watch.flightNo} ${route}${date ? ` on ${date}` : ""}: ${alert.detail}. Reply HELP to reach an agent.`;
}

async function sendWhatsApp(watch: any, alert: any, message: string): Promise<boolean> {
  const to = toWaRecipient(watch.notifyTarget);
  const template = process.env.WA_DISRUPTION_TEMPLATE;
  if (template) {
    const route = `${watch.origin || "?"}→${watch.destination || "?"}`;
    // Template body variables: {flightNo, route, changeSummary, newTime}
    return sendTemplateMessage(to, template, [watch.flightNo, route, alert.detail || "", alert.newTime || ""]);
  }
  // Dev / open-window free-form fallback.
  return sendTextMessageResult(to, message);
}

async function sendEmail(email: string, watch: any, message: string): Promise<boolean> {
  try {
    await sendMail({
      to: email,
      subject: `Flight update — ${watch.flightNo} ${watch.origin || ""}→${watch.destination || ""}`,
      kind: "REQUESTS",
      html: `<p>${message}</p>`,
    });
    return true;
  } catch {
    return false;
  }
}

export interface DeliveryOutcome {
  delivered: boolean;
  channelUsed: string | null;
  deliveryStatus: "SENT" | "FAILED" | "PENDING";
  attempts: number;
}

/**
 * Deliver an alert. Mutates nothing — returns the outcome; the worker persists
 * it. attempts is the pre-attempt count; on failure we keep PENDING until
 * MAX_ATTEMPTS, then FAILED (never infinite-retry).
 */
export async function deliverTripAlert(alert: any, watch: any): Promise<DeliveryOutcome> {
  const message = renderAlertMessage(alert, watch);
  const attempts = (alert.attempts || 0) + 1;
  let delivered = false;
  let channelUsed: string | null = null;

  if (watch.notifyChannel === "WHATSAPP") {
    delivered = await sendWhatsApp(watch, alert, message);
    if (delivered) channelUsed = "WHATSAPP";
  } else if (watch.notifyChannel === "EMAIL") {
    delivered = await sendEmail(watch.notifyTarget, watch, message);
    if (delivered) channelUsed = "EMAIL";
  }

  // Fallback: WhatsApp failed/unconfigured but we have an email on the watch.
  if (!delivered && watch.notifyChannel === "WHATSAPP" && watch.fallbackEmail) {
    delivered = await sendEmail(watch.fallbackEmail, watch, message);
    if (delivered) channelUsed = "EMAIL";
  }

  const workspaceId = String(watch.workspaceId);
  if (delivered) {
    void emitMetric(watchMetric("pluto.notify.sent", { workspaceId, reason: channelUsed || undefined }));
  } else {
    void emitMetric(watchMetric("pluto.notify.failed", { workspaceId, reason: `attempt_${attempts}` }, "error"));
  }

  const deliveryStatus: DeliveryOutcome["deliveryStatus"] = delivered
    ? "SENT"
    : attempts >= MAX_ATTEMPTS
      ? "FAILED"
      : "PENDING";

  return { delivered, channelUsed, deliveryStatus, attempts };
}
