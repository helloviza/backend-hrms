// apps/backend/src/routes/eodReport.ts
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin.js";
import { EodReportConfig } from "../models/EodReportConfig.js";
import { whatsappService } from "../services/whatsappService.js";
import { buildEodMessage, sendEodReport } from "../services/eodSnapshot.js";
import { rescheduleEodCron } from "../jobs/eodCron.js";
import logger from "../utils/logger.js";

const router = express.Router();

router.use(requireAuth, requireSuperAdmin);

/* ── GET /config ────────────────────────────────────────────────── */
router.get("/config", async (_req, res) => {
  try {
    const config = await EodReportConfig.findOne()
      .select("-waSession")
      .lean();
    res.json({ ok: true, config: config ?? {} });
  } catch (err) {
    logger.error("[EOD] GET /config error", { err });
    res.status(500).json({ ok: false, error: "Failed to load config" });
  }
});

/* ── POST /config ───────────────────────────────────────────────── */
router.post("/config", async (req, res) => {
  try {
    const { sendTime, enabled, recipients, sections, waPhoneNumber } = req.body;

    const existing = await EodReportConfig.findOne().lean();
    const prevSendTime = existing?.sendTime;

    const updated = await EodReportConfig.findOneAndUpdate(
      {},
      {
        ...(sendTime !== undefined && { sendTime }),
        ...(enabled !== undefined && { enabled }),
        ...(recipients !== undefined && { recipients }),
        ...(sections !== undefined && { sections }),
        ...(waPhoneNumber !== undefined && { waPhoneNumber }),
      },
      { upsert: true, new: true, select: "-waSession" },
    );

    // Reschedule if sendTime changed or enabled toggled
    if (sendTime !== prevSendTime || enabled !== undefined) {
      await rescheduleEodCron().catch((e) =>
        logger.error("[EOD] Reschedule error", { e }),
      );
    }

    res.json({ ok: true, config: updated });
  } catch (err) {
    logger.error("[EOD] POST /config error", { err });
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
  } catch (err) {
    logger.error("[EOD] GET /wa/status error", { err });
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

    // Initialize client if not yet started
    if (currentStatus === "disconnected" || currentStatus === "failed") {
      whatsappService.initialize().catch((e) =>
        logger.error("[EOD] WA init error from /wa/qr", { e }),
      );
    }

    // Wait up to 15s for QR to appear
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
  } catch (err) {
    logger.error("[EOD] GET /wa/qr error", { err });
    res.status(500).json({ ok: false, error: "Failed to get QR code" });
  }
});

/* ── POST /wa/disconnect ────────────────────────────────────────── */
router.post("/wa/disconnect", async (_req, res) => {
  try {
    await whatsappService.disconnect();
    res.json({ ok: true, message: "WhatsApp disconnected" });
  } catch (err) {
    logger.error("[EOD] POST /wa/disconnect error", { err });
    res.status(500).json({ ok: false, error: "Failed to disconnect" });
  }
});

/* ── GET /wa/groups ─────────────────────────────────────────────── */
router.get("/wa/groups", async (_req, res) => {
  try {
    const groups = await whatsappService.getGroups();
    res.json({ ok: true, groups });
  } catch (err) {
    logger.error("[EOD] GET /wa/groups error", { err });
    const msg = err instanceof Error ? err.message : "Failed to get groups";
    res.status(400).json({ ok: false, error: msg });
  }
});

/* ── POST /send-test ────────────────────────────────────────────── */
router.post("/send-test", async (req, res) => {
  try {
    const { dryRun } = req.body;

    const message = await buildEodMessage();

    if (dryRun) {
      return res.json({ ok: true, message, sent: 0, failed: 0, errors: [], dryRun: true });
    }

    const result = await sendEodReport();
    return res.json({ ok: true, ...result, message });
  } catch (err) {
    logger.error("[EOD] POST /send-test error", { err });
    const msg = err instanceof Error ? err.message : "Failed to send report";
    res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
