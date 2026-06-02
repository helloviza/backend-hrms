// apps/backend/src/routes/crmSalesPulse.ts
//
// SUPERADMIN routes for the CRM Sales Pulse report — modelled on
// routes/eodReport.ts. Config CRUD + a /send-test endpoint with the same three
// modes as EOD:
//   • dryRun  → compute snapshot + HTML (+ attempt PDF base64), return WITHOUT
//               sending. Safe to call anytime; never emails anyone.
//   • testRun → email to config.testRecipients only (persistStatus:false).
//   • live    → email to config.recipients.
//
// Mounting + auth (requireAuth, requireSuperAdmin) is done where this router is
// mounted in server.ts.

import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin.js";
import {
  CrmSalesPulseConfig,
  normalizeSendTimes,
} from "../models/CrmSalesPulseConfig.js";
import { computeSalesPulseSnapshot } from "../services/crmSalesPulseSnapshot.js";
import { buildSalesPulseHtml } from "../services/crmSalesPulseTemplate.js";
import { renderSalesPulseImage } from "../services/crmSalesPulseRenderer.js";
import { sendSalesPulse } from "../services/crmSalesPulseDelivery.js";
import { getNextFireAt, rescheduleSalesPulseCron } from "../jobs/crmSalesPulseCron.js";
import logger from "../utils/logger.js";

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

/* ── GET /config ───────────────────────────────────────────────── */
router.get("/config", async (_req, res) => {
  try {
    let config = await CrmSalesPulseConfig.findOne().lean();
    if (!config) {
      // Materialize defaults (DISABLED) on first read so the UI has a doc.
      config = (await CrmSalesPulseConfig.create({})).toObject();
    }
    const nextFireAt = config.enabled ? getNextFireAt(config.sendTimes ?? []) : null;
    res.json({
      ok: true,
      config,
      nextFireAt: nextFireAt ? nextFireAt.toISOString() : null,
    });
  } catch (err: any) {
    logger.error("[SalesPulse] GET /config error", { message: err?.message, stack: err?.stack });
    res.status(500).json({ ok: false, error: "Failed to load config" });
  }
});

/* ── POST /config ──────────────────────────────────────────────── */
router.post("/config", async (req, res) => {
  try {
    const { sendTimes, enabled, recipients, testRecipients, sections } = req.body ?? {};

    const update: Record<string, unknown> = {};
    if (sendTimes !== undefined) update.sendTimes = normalizeSendTimes(sendTimes);
    if (enabled !== undefined) update.enabled = !!enabled;
    if (recipients !== undefined) update.recipients = recipients;
    if (testRecipients !== undefined) update.testRecipients = testRecipients;
    if (sections !== undefined) update.sections = sections;

    const updated = await CrmSalesPulseConfig.findOneAndUpdate({}, update, {
      upsert: true,
      new: true,
    });

    // Reschedule whenever the schedule or on/off could have changed.
    if (sendTimes !== undefined || enabled !== undefined) {
      await rescheduleSalesPulseCron().catch((e: any) =>
        logger.error("[SalesPulse] Reschedule error", { message: e?.message }),
      );
    }

    const nextFireAt = updated?.enabled ? getNextFireAt(updated.sendTimes ?? []) : null;
    res.json({ ok: true, config: updated, nextFireAt: nextFireAt ? nextFireAt.toISOString() : null });
  } catch (err: any) {
    logger.error("[SalesPulse] POST /config error", { message: err?.message, stack: err?.stack });
    res.status(500).json({ ok: false, error: "Failed to save config" });
  }
});

/* ── POST /send-test ───────────────────────────────────────────── */
router.post("/send-test", async (req, res) => {
  try {
    const { dryRun, testRun, live, sections } = req.body ?? {};

    if (dryRun) {
      const snapshot = await computeSalesPulseSnapshot(sections);
      const html = buildSalesPulseHtml(snapshot);
      try {
        const png = await renderSalesPulseImage(html);
        return res.json({
          ok: true,
          dryRun: true,
          mode: "image",
          snapshot,
          html,
          pngBase64: png.toString("base64"),
        });
      } catch (renderErr: any) {
        logger.error("[SalesPulse] dryRun render failed", { message: renderErr?.message });
        return res.json({
          ok: true,
          dryRun: true,
          mode: "html",
          snapshot,
          html,
          pngBase64: null,
          renderError: renderErr instanceof Error ? renderErr.message : String(renderErr),
        });
      }
    }

    if (testRun) {
      const config = await CrmSalesPulseConfig.findOne().lean();
      const testRecipients = (config?.testRecipients ?? []).filter((r: any) => r.active !== false);
      if (!testRecipients.length) {
        return res.status(400).json({ ok: false, error: "No test recipients configured" });
      }
      const result = await sendSalesPulse({
        sectionsOverride: sections,
        recipientsOverride: testRecipients,
        persistStatus: false,
      });
      return res.json({ ok: true, testRun: true, ...result });
    }

    if (live) {
      const result = await sendSalesPulse({ sectionsOverride: sections });
      return res.json({ ok: true, live: true, ...result });
    }

    return res.status(400).json({ ok: false, error: "Specify one of: dryRun, testRun, live" });
  } catch (err: any) {
    logger.error("[SalesPulse] POST /send-test error", { message: err?.message, stack: err?.stack });
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "Failed" });
  }
});

export default router;
