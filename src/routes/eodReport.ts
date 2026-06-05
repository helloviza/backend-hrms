// apps/backend/src/routes/eodReport.ts
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin.js";
import { EodReportConfig } from "../models/EodReportConfig.js";
import { whatsappService } from "../services/whatsappService.js";
import {
  buildEodCaption,
  buildEodMessageFromSnapshot,
  computeEodSnapshot,
  sendEodReport,
} from "../services/eodSnapshot.js";
import { buildEodHtml } from "../services/eodReportTemplate.js";
import { renderEodImage } from "../services/eodImageRenderer.js";
import { getNextFireAt, rescheduleEodCron } from "../jobs/eodCron.js";
import logger from "../utils/logger.js";

const router = express.Router();

router.use(requireAuth, requireSuperAdmin);

/* ── WA host gate ───────────────────────────────────────────────────
 * The /wa/* control endpoints (status, qr, disconnect, groups) only function
 * on the dedicated WA host (WA_HOST=true) that owns the single plumtrips-eod
 * client. Everywhere else they return 409 so no second host can initialize a
 * competing client or hand out a conflicting QR. */
router.use("/wa", (_req, res, next) => {
  if (process.env.WA_HOST !== "true") {
    return res.status(409).json({
      ok: false,
      error: "WhatsApp endpoints are served only by the dedicated WA host",
    });
  }
  next();
});

/* ── GET /config ────────────────────────────────────────────────── */
router.get("/config", async (_req, res) => {
  try {
    const config = await EodReportConfig.findOne()
      .select("-waSession")
      .lean();
    const sendTime = (config as any)?.sendTime ?? "19:00";
    const nextFireAt = getNextFireAt(sendTime);
    res.json({
      ok: true,
      config: config ?? {},
      nextFireAt: nextFireAt ? nextFireAt.toISOString() : null,
    });
  } catch (err: any) {
    logger.error("[EOD] GET /config error", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
    });
    res.status(500).json({ ok: false, error: "Failed to load config" });
  }
});

/* ── POST /config ───────────────────────────────────────────────── */
router.post("/config", async (req, res) => {
  try {
    const {
      sendTime,
      enabled,
      recipients,
      testRecipients,
      sections,
      waPhoneNumber,
    } = req.body;

    const existing = await EodReportConfig.findOne().lean();
    const prevSendTime = existing?.sendTime;

    const updated = await EodReportConfig.findOneAndUpdate(
      {},
      {
        ...(sendTime !== undefined && { sendTime }),
        ...(enabled !== undefined && { enabled }),
        ...(recipients !== undefined && { recipients }),
        ...(testRecipients !== undefined && { testRecipients }),
        ...(sections !== undefined && { sections }),
        ...(waPhoneNumber !== undefined && { waPhoneNumber }),
      },
      { upsert: true, new: true, select: "-waSession" },
    );

    if (sendTime !== prevSendTime || enabled !== undefined) {
      await rescheduleEodCron().catch((e: any) =>
        logger.error("[EOD] Reschedule error", {
          message: e?.message,
          stack: e?.stack,
          name: e?.name,
          cause: e?.cause,
        }),
      );
    }

    const nextFireAt = getNextFireAt((updated as any)?.sendTime ?? "19:00");
    res.json({
      ok: true,
      config: updated,
      nextFireAt: nextFireAt ? nextFireAt.toISOString() : null,
    });
  } catch (err: any) {
    logger.error("[EOD] POST /config error", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
    });
    res.status(500).json({ ok: false, error: "Failed to save config" });
  }
});

/* ── GET /wa/status ─────────────────────────────────────────────── */
router.get("/wa/status", async (_req, res) => {
  try {
    const config = await EodReportConfig.findOne()
      .select("waConnected waPhoneNumber")
      .lean();
    res.json({
      ok: true,
      status: whatsappService.getStatus(),
      connected: whatsappService.getStatus() === "connected",
      phoneNumber: config?.waPhoneNumber ?? "",
      waConnected: config?.waConnected ?? false,
    });
  } catch (err: any) {
    logger.error("[EOD] GET /wa/status error", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
    });
    res.status(500).json({ ok: false, error: "Failed to get WA status" });
  }
});

/* ── GET /wa/qr ─────────────────────────────────────────────────── */
router.get("/wa/qr", async (_req, res) => {
  try {
    const currentStatus = whatsappService.getStatus();

    if (currentStatus === "connected") {
      return res.json({ ok: true, connected: true });
    }

    const existing = whatsappService.getQrCode();
    if (existing) {
      return res.json({ ok: true, qrCode: existing });
    }

    if (currentStatus === "disconnected" || currentStatus === "failed") {
      whatsappService.initialize().catch((e: any) =>
        logger.error("[EOD] WA init error from /wa/qr", {
          message: e?.message,
          stack: e?.stack,
          name: e?.name,
          cause: e?.cause,
        }),
      );
    }

    const qr = await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 15_000);
      whatsappService.onQr((q) => {
        clearTimeout(timeout);
        resolve(q);
      });
    });

    if (!qr) {
      return res.json({
        ok: true,
        qrCode: null,
        message: "QR not yet ready — client is initializing",
      });
    }

    return res.json({ ok: true, qrCode: qr });
  } catch (err: any) {
    logger.error("[EOD] GET /wa/qr error", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
    });
    res.status(500).json({ ok: false, error: "Failed to get QR code" });
  }
});

/* ── POST /wa/disconnect ────────────────────────────────────────── */
router.post("/wa/disconnect", async (_req, res) => {
  try {
    await whatsappService.disconnect();
    res.json({ ok: true, message: "WhatsApp disconnected" });
  } catch (err: any) {
    logger.error("[EOD] POST /wa/disconnect error", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
    });
    res.status(500).json({ ok: false, error: "Failed to disconnect" });
  }
});

/* ── GET /wa/groups ─────────────────────────────────────────────── */
router.get("/wa/groups", async (_req, res) => {
  try {
    const groups = await whatsappService.getGroups();
    res.json({ ok: true, groups });
  } catch (err: any) {
    logger.error("[EOD] GET /wa/groups error", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
    });
    const msg = err instanceof Error ? err.message : "Failed to get groups";
    res.status(400).json({ ok: false, error: msg });
  }
});

/* ── POST /send-test ────────────────────────────────────────────── */
/**
 * Three modes:
 *   1. dryRun:true   → renders image + caption; returns
 *                      { imageBase64, caption, fallbackText, mode } without sending.
 *                      If image rendering fails, falls back to text-only response.
 *   2. testRun:true  → sends image (or text fallback) to config.testRecipients only
 *   3. live:true     → sends image (or text fallback) to config.recipients
 *
 * `sections` may be passed in body to preview unsaved toggles.
 */
router.post("/send-test", async (req, res) => {
  try {
    const { dryRun, testRun, live, sections } = req.body ?? {};

    if (dryRun) {
      const snapshot = await computeEodSnapshot(sections);
      const caption = buildEodCaption(snapshot);
      const fallbackText = buildEodMessageFromSnapshot(snapshot);

      try {
        const html = buildEodHtml(snapshot);
        const buffer = await renderEodImage(html);
        return res.json({
          ok: true,
          dryRun: true,
          mode: "image",
          imageBase64: buffer.toString("base64"),
          caption,
          fallbackText,
        });
      } catch (renderErr: any) {
        logger.error("[EOD] dryRun image render failed", {
          message: renderErr?.message,
          stack: renderErr?.stack,
          name: renderErr?.name,
          cause: renderErr?.cause,
        });
        return res.json({
          ok: true,
          dryRun: true,
          mode: "text",
          imageBase64: null,
          caption,
          fallbackText,
          renderError: renderErr instanceof Error ? renderErr.message : String(renderErr),
        });
      }
    }

    if (testRun) {
      const config = await EodReportConfig.findOne().lean();
      const testRecipients = (config?.testRecipients ?? []).filter(
        (r: any) => r.active !== false,
      );
      if (!testRecipients.length) {
        return res.status(400).json({
          ok: false,
          error: "No test recipients configured",
        });
      }
      const result = await sendEodReport({
        sectionsOverride: sections,
        recipientsOverride: testRecipients,
        persistStatus: false,
      });
      return res.json({ ok: true, ...result, testRun: true });
    }

    const result = await sendEodReport({ sectionsOverride: sections });
    return res.json({ ok: true, ...result, live: true });
  } catch (err: any) {
    logger.error("[EOD] POST /send-test error", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
    });
    const msg = err instanceof Error ? err.message : "Failed to send report";
    res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
