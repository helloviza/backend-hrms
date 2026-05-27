/**
 * @deprecated ABANDONED — see infra/audit/eod-render-lambda-plan-2026-05-27.md.
 * The Fargate Scheduled Task path was designed but never wired to EventBridge
 * (no schedule/rule was ever created). The LIVE EOD path is the in-process
 * node-cron in jobs/eodCron.ts, and EOD images now render via the voucher
 * render Lambda (PNG mode) — not Chromium in this process. This file is retained
 * for reference only; do not wire it without revisiting that plan.
 *
 * Standalone EOD report execution for ECS Fargate Scheduled Task.
 *
 * Triggered by EventBridge daily at the configured time.
 * Connects to MongoDB → reads EodReportConfig → if enabled, renders image
 * and sends to live recipients → exits.
 *
 * Run via: node dist/jobs/runEodOnce.js
 * Container CMD in Dockerfile uses this entry point for Fargate task variant.
 *
 * Flags:
 *   --test  Send to testRecipients instead of live recipients (used for local dry-runs).
 */

import "dotenv/config";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { sendEodReport } from "../services/eodSnapshot.js";
import { EodReportConfig } from "../models/EodReportConfig.js";
import { whatsappService } from "../services/whatsappService.js";
import { closeEodRendererBrowser } from "../services/eodImageRenderer.js";

async function main() {
  const startTime = Date.now();
  const isTestMode = process.argv.includes("--test");
  logger.info("[runEodOnce] Starting standalone EOD report execution", {
    mode: isTestMode ? "test" : "live",
  });

  // Step 1 — Connect to MongoDB
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    logger.error("[runEodOnce] MONGO_URI not set, exiting");
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    logger.info("[runEodOnce] MongoDB connected");
  } catch (err: any) {
    logger.error("[runEodOnce] MongoDB connection failed", {
      message: err?.message,
      stack: err?.stack,
    });
    process.exit(1);
  }

  // Step 2 — Load config
  let config;
  try {
    config = await EodReportConfig.findOne().select("-waSession");
    if (!config) {
      logger.warn("[runEodOnce] No EodReportConfig found, exiting without sending");
      await mongoose.disconnect();
      process.exit(0);
    }
    if (!config.enabled) {
      logger.info("[runEodOnce] EOD report disabled in config, exiting");
      await mongoose.disconnect();
      process.exit(0);
    }

    logger.info("[runEodOnce] Loaded config", {
      enabled: config.enabled,
      recipientCount: config.recipients?.length ?? 0,
      recipients: (config.recipients ?? []).map((r) => ({
        name: r.name,
        type: r.type,
        number: r.number ? r.number.substring(0, 4) + "***" : undefined,
        groupId: r.groupId,
      })),
      testRecipientCount: config.testRecipients?.length ?? 0,
    });
  } catch (err: any) {
    logger.error("[runEodOnce] Failed to load config", {
      message: err?.message,
      stack: err?.stack,
    });
    process.exit(1);
  }

  // Step 3 — Initialize WhatsApp client
  // Note: requires .wwebjs_auth/ session to exist (mounted from EFS in Fargate).
  // First-run on a fresh EFS volume needs QR pairing — handle that separately.
  try {
    await whatsappService.initialize();
    logger.info("[runEodOnce] WhatsApp service initialized");
  } catch (err: any) {
    logger.error("[runEodOnce] WhatsApp init failed", {
      message: err?.message,
      stack: err?.stack,
    });
    await mongoose.disconnect();
    process.exit(1);
  }

  // Step 4 — Wait for WhatsApp to be ready (with timeout).
  // whatsappService.getStatus() returns one of: "disconnected" | "qr_ready" |
  // "connecting" | "connected" | "failed". The ready terminal state is "connected".
  const maxWaitMs = 60_000;
  const checkIntervalMs = 1000;
  let waited = 0;
  while (whatsappService.getStatus() !== "connected" && waited < maxWaitMs) {
    await new Promise((r) => setTimeout(r, checkIntervalMs));
    waited += checkIntervalMs;
  }

  if (whatsappService.getStatus() !== "connected") {
    logger.error("[runEodOnce] WhatsApp did not become ready within timeout", {
      status: whatsappService.getStatus(),
    });
    try {
      await whatsappService.disconnect();
    } catch {}
    try {
      await closeEodRendererBrowser();
    } catch {}
    await mongoose.disconnect();
    process.exit(1);
  }

  logger.info("[runEodOnce] WhatsApp ready, sending EOD report");

  // Step 5 — Send the report. In --test mode, override to testRecipients;
  // otherwise leave recipientsOverride undefined so sendEodReport reads live
  // recipients from the EodReportConfig document.
  try {
    const recipientsOverride = isTestMode ? config.testRecipients : undefined;
    const result = await sendEodReport({ recipientsOverride });
    logger.info("[runEodOnce] EOD report sent", {
      sent: result.sent,
      failed: result.failed,
      mode: result.mode,
      durationMs: Date.now() - startTime,
    });
  } catch (err: any) {
    logger.error("[runEodOnce] Failed to send EOD report", {
      message: err?.message,
      stack: err?.stack,
    });
  }

  // Step 6 — Cleanup
  try {
    await closeEodRendererBrowser();
  } catch {}
  try {
    await whatsappService.disconnect();
  } catch {}
  try {
    await mongoose.disconnect();
  } catch {}

  const totalMs = Date.now() - startTime;
  logger.info("[runEodOnce] Execution complete", { totalMs });
  process.exit(0);
}

main().catch((err) => {
  logger.error("[runEodOnce] Unhandled top-level error", {
    message: err?.message,
    stack: err?.stack,
  });
  process.exit(1);
});
