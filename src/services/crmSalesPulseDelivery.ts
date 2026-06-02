// apps/backend/src/services/crmSalesPulseDelivery.ts
//
// DELIVERY layer — composes compute → template → render → WHATSAPP IMAGE.
// Mirrors EOD's sendEodReport() (eodSnapshot.ts): render the report HTML to a
// PNG via the render Lambda, then push it to WhatsApp recipients with a short
// caption via whatsappService.sendImageToRecipients().
//
// IMPORTANT: whatsappService.sendImageToRecipients() defaults to reading
// EodReportConfig.recipients when no override is passed. Sales Pulse recipients
// live on CrmSalesPulseConfig, so we ALWAYS resolve our own recipients and pass
// them as the explicit override — we never let it fall back to the EOD config.
//
// WhatsApp-only: there is no email/PDF path and no text fallback. If the image
// render fails there is nothing to send, so we record the failure and return.

import { whatsappService } from "./whatsappService.js";
import type { IEodRecipient } from "../models/EodReportConfig.js";
import {
  CrmSalesPulseConfig,
  type ICrmSalesPulseRecipient,
  type ICrmSalesPulseSections,
} from "../models/CrmSalesPulseConfig.js";
import {
  computeSalesPulseSnapshot,
  type SalesPulseSnapshot,
} from "./crmSalesPulseSnapshot.js";
import { buildSalesPulseHtml } from "./crmSalesPulseTemplate.js";
import { renderSalesPulseImage } from "./crmSalesPulseRenderer.js";
import logger from "../utils/logger.js";

export interface SalesPulseSendResult {
  sent: number;
  failed: number;
  errors: string[];
  mode: "image";
  recipients: string[];
}

/** Active recipients in the WhatsApp (IEodRecipient) shape the WA service wants. */
function activeRecipients(list: ICrmSalesPulseRecipient[] | undefined): IEodRecipient[] {
  return (list ?? [])
    .filter((r) => r.active !== false)
    .map((r) => ({
      type: r.type,
      number: r.number ?? "",
      groupId: r.groupId ?? "",
      name: r.name ?? "",
      active: r.active !== false,
    }));
}

/** Short caption that accompanies the image (mirrors EOD's buildEodCaption). */
function buildCaption(s: SalesPulseSnapshot): string {
  const byKey = (k: string) => s.kpis.find((x) => x.key === k)?.value ?? 0;
  return (
    `📊 Plumtrips Sales Pulse · ${s.dateLabel} (${s.fireSlotLabel})\n` +
    `${byKey("active_reps")} active rep${byKey("active_reps") === 1 ? "" : "s"} · ` +
    `${byKey("total_activities")} activities · ${byKey("new_leads")} new leads`
  );
}

/**
 * Build the snapshot + HTML, render the PNG, and send it over WhatsApp.
 *
 *  - recipientsOverride: send to this list instead of config.recipients (used
 *    by testRun → testRecipients). When omitted, live recipients are read from
 *    the config document.
 *  - sectionsOverride: preview unsaved section toggles.
 *  - persistStatus: write lastSent* back to the config (default true; the route
 *    passes false for test sends).
 *
 * NOTE: this is the LIVE send path. The cron is disabled by default and the
 * route guards live sends behind an explicit `live` flag.
 */
export async function sendSalesPulse(opts?: {
  recipientsOverride?: ICrmSalesPulseRecipient[];
  sectionsOverride?: Partial<ICrmSalesPulseSections>;
  persistStatus?: boolean;
}): Promise<SalesPulseSendResult> {
  const persistStatus = opts?.persistStatus ?? true;

  const recipients = opts?.recipientsOverride
    ? activeRecipients(opts.recipientsOverride)
    : activeRecipients((await CrmSalesPulseConfig.findOne().lean())?.recipients);

  if (!recipients.length) {
    if (persistStatus) {
      await CrmSalesPulseConfig.findOneAndUpdate(
        {},
        { lastSentAt: new Date(), lastSentStatus: "no_recipients", lastSentError: "No active recipients", lastSentMode: "unknown" },
        { upsert: true },
      );
    }
    return { sent: 0, failed: 0, errors: ["No active recipients"], mode: "image", recipients: [] };
  }

  const snapshot = await computeSalesPulseSnapshot(opts?.sectionsOverride);
  const html = buildSalesPulseHtml(snapshot);
  const caption = buildCaption(snapshot);
  const recipientLabels = recipients.map((r) => r.name || r.number || r.groupId);

  // Render the PNG. WhatsApp-only → a render failure means there is nothing to
  // send (no text fallback, unlike EOD).
  let imageBuffer: Buffer;
  try {
    imageBuffer = await renderSalesPulseImage(html);
  } catch (renderErr: any) {
    logger.error("[SalesPulse] Image render failed — nothing to send over WhatsApp", {
      message: renderErr?.message,
      name: renderErr?.name,
    });
    if (persistStatus) {
      await CrmSalesPulseConfig.findOneAndUpdate(
        {},
        {
          lastSentAt: new Date(),
          lastSentStatus: "render_failed",
          lastSentError: renderErr instanceof Error ? renderErr.message : String(renderErr),
          lastSentMode: "unknown",
        },
        { upsert: true },
      );
    }
    return {
      sent: 0,
      failed: recipients.length,
      errors: [`Image render failed: ${renderErr?.message ?? renderErr}`],
      mode: "image",
      recipients: recipientLabels,
    };
  }

  const waResult = await whatsappService.sendImageToRecipients(imageBuffer, caption, recipients);

  if (persistStatus) {
    await CrmSalesPulseConfig.findOneAndUpdate(
      {},
      {
        lastSentAt: new Date(),
        lastSentStatus: waResult.failed === 0 ? "success" : waResult.sent > 0 ? "partial" : "failed",
        lastSentError: waResult.errors.join(", "),
        lastSentMode: "image",
      },
      { upsert: true },
    );
  }

  logger.info(`[SalesPulse] Report image sent over WhatsApp: ${waResult.sent} ok, ${waResult.failed} failed`);
  return {
    sent: waResult.sent,
    failed: waResult.failed,
    errors: waResult.errors,
    mode: "image",
    recipients: recipientLabels,
  };
}
