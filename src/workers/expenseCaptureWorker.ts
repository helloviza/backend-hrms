// apps/backend/src/workers/expenseCaptureWorker.ts
import ExpenseCapture from "../models/ExpenseCapture.js";
import User from "../models/User.js";
import {
  isWhatsAppCloudConfigured,
  getMediaUrl,
  downloadMedia,
  sendTextMessage,
} from "../services/whatsappCloud.service.js";
import { uploadExpenseReceiptToS3 } from "../utils/s3Upload.js";
import { whatsappLogger } from "../utils/logger.js";

/**
 * Expense Capture Worker
 * ----------------------
 * Drains queued inbound WhatsApp receipts (ExpenseCapture, status:"queued"):
 *   1. resolve waId -> User (+ workspace)         [no match -> reply + stop]
 *   2. GET media URL (Graph) -> download bytes    [URL ~5 min, re-fetched per attempt]
 *   3. upload to S3 under a workspace-scoped key
 *   4. mark the capture "captured" (Expense draft)
 *
 * In-process polling worker (same shape as videoProcessingWorker): a single
 * atomic findOneAndUpdate claims each row, so it is safe to run one instance.
 * Idle when the Cloud API is not configured.
 */

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const BATCH_PER_TICK = 10;
const MAX_ATTEMPTS = 3;
const NOT_REGISTERED_MSG = "You're not registered — please contact your admin";

let isRunning = false;

function normalizeWaId(waId: string): string {
  return String(waId ?? "").replace(/[^0-9]/g, "");
}

async function processOne(): Promise<boolean> {
  // Atomically claim the oldest queued capture.
  const capture = await ExpenseCapture.findOneAndUpdate(
    { status: "queued" },
    { status: "processing", $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );
  if (!capture) return false; // nothing left to process

  try {
    // ── 1. Resolve sender -> employee/workspace ──────────────────────────
    const normalized = normalizeWaId(capture.waId);
    const user = normalized ? await User.findOne({ waId: normalized }).lean() : null;

    if (!user) {
      await sendTextMessage(capture.waId, NOT_REGISTERED_MSG);
      capture.status = "unregistered";
      await capture.save();
      whatsappLogger.warn("Capture from unregistered sender", { messageId: capture.messageId, waId: capture.waId });
      return true;
    }

    // ── 2. Download media (fresh URL each attempt to dodge the 5-min expiry) ─
    const { url } = await getMediaUrl(capture.mediaId);
    if (!url) throw new Error(`No media URL returned for mediaId ${capture.mediaId}`);
    const buffer = await downloadMedia(url);

    // ── 3. Store under a workspace-scoped key ────────────────────────────
    const { bucket, key } = await uploadExpenseReceiptToS3({
      buffer,
      mime: capture.mime,
      workspaceId: String(user.workspaceId),
      employeeId: String(user._id),
      messageId: capture.messageId,
    });

    // ── 4. Mark captured (Expense draft) ─────────────────────────────────
    capture.status = "captured";
    capture.workspaceId = user.workspaceId as any;
    capture.employeeId = user._id as any;
    capture.imageKey = key;
    capture.s3Bucket = bucket;
    capture.errorMessage = undefined;
    await capture.save();

    whatsappLogger.info("Receipt captured", {
      messageId: capture.messageId,
      employeeId: String(user._id),
      workspaceId: String(user.workspaceId),
      key,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Transient failure: requeue until MAX_ATTEMPTS, then give up.
    capture.status = capture.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
    capture.errorMessage = message;
    await capture.save();
    whatsappLogger.error("Capture processing error", {
      messageId: capture.messageId,
      attempts: capture.attempts,
      status: capture.status,
      error: message,
    });
    return true;
  }
}

export function startExpenseCaptureWorker() {
  if (isRunning) return;
  isRunning = true;

  whatsappLogger.info("🧾 Expense capture worker started");

  setInterval(async () => {
    try {
      if (!isWhatsAppCloudConfigured()) return; // idle until configured

      for (let i = 0; i < BATCH_PER_TICK; i++) {
        const processed = await processOne();
        if (!processed) break; // queue drained
      }
    } catch (err) {
      whatsappLogger.error("Expense capture worker tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, POLL_INTERVAL_MS);
}
