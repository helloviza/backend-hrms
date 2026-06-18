// apps/backend/src/workers/expenseCaptureWorker.ts
import ExpenseCapture from "../models/ExpenseCapture.js";
import ExpenseReply from "../models/ExpenseReply.js";
import Expense from "../models/Expense.js";
import User from "../models/User.js";
import {
  isWhatsAppCloudConfigured,
  getMediaUrl,
  downloadMedia,
  sendTextMessage,
} from "../services/whatsappCloud.service.js";
import { uploadExpenseReceiptToS3 } from "../utils/s3Upload.js";
import { extractReceipt } from "../services/receiptExtractorGemini.js";
import { createExpense } from "../services/expenses.service.js";
import { resolveCategoryId } from "../services/expenseCategories.service.js";
import { quickSubmitExpense } from "../services/reports.service.js";
import { whatsappLogger } from "../utils/logger.js";

/**
 * Expense Capture Worker
 * ----------------------
 * Drains three queues each tick:
 *
 *  1. CAPTURE     ExpenseCapture(status:"queued")
 *       resolve waId -> User, download media, upload to S3, mark "captured".
 *       (Sprint 1 path — UNCHANGED; "captured" is the post-capture hook point.)
 *
 *  2. EXTRACT     ExpenseCapture(status:"captured")
 *       re-read the image from S3, run Gemini extraction, send the parsed
 *       summary + one-tap confirm, mark "awaiting_confirmation". On failure we
 *       KEEP the image and drop to "awaiting_correction" (never lose a receipt).
 *
 *  3. REPLY       ExpenseReply(status:"queued")
 *       match an inbound text to the pending capture by waId and apply
 *       confirm / correct / cancel.
 *
 * In-process polling worker (same shape as videoProcessingWorker): a single
 * atomic findOneAndUpdate claims each row, so it is safe to run one instance.
 * Idle when the Cloud API is not configured.
 */

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const BATCH_PER_TICK = 10;
const MAX_ATTEMPTS = 3;
const MAX_EXTRACTION_ATTEMPTS = 3;
const NOT_REGISTERED_MSG = "You're not registered — please contact your admin";
const CORRECTION_HINT =
  "Reply 1 to confirm, send a number to set the amount, or use:\n" +
  "amount: 450  |  merchant: Name  |  date: 2026-06-15\n" +
  "Reply cancel to discard.";

let isRunning = false;

function normalizeWaId(waId: string): string {
  return String(waId ?? "").replace(/[^0-9]/g, "");
}

/* ───────────────────────── stage 1: capture (UNCHANGED) ───────────────────── */

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

/* ───────────────────────── stage 2: extraction ────────────────────────────── */

/** Human-readable money, omitting decimals when whole. */
function fmtMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null) return "—";
  const c = currency || "INR";
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${c} ${n}`;
}

/** Build the confirm/correct summary from the capture's pending extraction. */
function buildSummary(capture: any): string {
  const e = capture.extraction || {};
  const lines = ["🧾 Receipt read:"];
  if (e.merchant) lines.push(`Merchant: ${e.merchant}`);
  if (e.date) lines.push(`Date: ${e.date}`);
  lines.push(`Amount: ${fmtMoney(e.amount, e.currency)}`);
  if (e.taxAmount != null) lines.push(`Tax: ${fmtMoney(e.taxAmount, e.currency)}`);
  if (e.gstin) lines.push(`GSTIN: ${e.gstin}`);
  if (e.suggestedCategory) lines.push(`Category: ${e.suggestedCategory}`);
  lines.push("");
  lines.push("Reply 1 to confirm, or send the correct amount.");
  lines.push("You can also send:  amount: 450  |  merchant: Name  |  date: 2026-06-15");
  lines.push("Reply cancel to discard.");
  return lines.join("\n");
}

async function processOneExtraction(): Promise<boolean> {
  // Claim the oldest captured-but-not-yet-extracted receipt.
  const capture = await ExpenseCapture.findOneAndUpdate(
    { status: "captured" },
    { status: "extracting", $inc: { extractionAttempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );
  if (!capture) return false;

  try {
    if (!capture.imageKey) throw new Error("captured row has no imageKey");

    const { fields, raw } = await extractReceipt({
      imageKey: capture.imageKey,
      mime: capture.mime,
    });

    capture.extraction = {
      merchant: fields.merchant,
      date: fields.date,
      amount: fields.amount,
      currency: fields.currency,
      taxAmount: fields.taxAmount,
      gstin: fields.gstin,
      suggestedCategory: fields.suggestedCategory,
      perFieldConfidence: fields.perFieldConfidence,
    } as any;
    capture.extractionRaw = raw as any;
    capture.extractionModel = raw.model;
    capture.errorMessage = undefined;
    capture.status = "awaiting_confirmation";
    capture.markModified("extraction");
    await capture.save();

    await sendTextMessage(capture.waId, buildSummary(capture));
    whatsappLogger.info("Receipt extracted", {
      messageId: capture.messageId,
      amount: fields.amount,
      currency: fields.currency,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (capture.extractionAttempts >= MAX_EXTRACTION_ATTEMPTS) {
      // Give up on auto-extraction but KEEP the image — let the sender type it.
      capture.status = "awaiting_correction";
      capture.errorMessage = message;
      await capture.save();
      await sendTextMessage(
        capture.waId,
        "I couldn't read that receipt automatically. Please reply with the amount " +
          "(e.g. 450), or use:  amount: 450  |  merchant: Name  |  date: 2026-06-15.",
      );
      whatsappLogger.warn("Extraction failed — awaiting manual correction", {
        messageId: capture.messageId,
        error: message,
      });
    } else {
      // Transient: back to "captured" for another extraction attempt.
      capture.status = "captured";
      capture.errorMessage = message;
      await capture.save();
      whatsappLogger.error("Extraction error — will retry", {
        messageId: capture.messageId,
        attempts: capture.extractionAttempts,
        error: message,
      });
    }
    return true;
  }
}

/* ───────────────────────── stage 3: text replies ──────────────────────────── */

const CONFIRM_WORDS = new Set(["1", "yes", "y", "confirm", "ok", "okay", "confirmed"]);
const CANCEL_WORDS = new Set(["cancel", "stop"]);

/** Parse a bare amount like "450", "₹1,200.50", "Rs 90" -> number, else null. */
function parseAmount(text: string): number | null {
  if (!/\d/.test(text)) return null;
  const cleaned = text.replace(/[^0-9.]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** ISO yyyy-mm-dd, or dd/mm/yyyy (day-first) -> ISO, else null. */
function parseDateToIso(text: string): string | null {
  const s = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return s;
  const dmy = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = `20${y}`;
    const dd = d.padStart(2, "0");
    const mm = m.padStart(2, "0");
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31)
      return `${y}-${mm}-${dd}`;
  }
  return null;
}

type ReplyIntent =
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "correct"; field: "amount" | "merchant" | "date"; value: any }
  | { kind: "unparseable" };

function parseReply(rawText: string): ReplyIntent {
  const text = String(rawText ?? "").trim();
  const lower = text.toLowerCase();

  if (CONFIRM_WORDS.has(lower)) return { kind: "confirm" };
  if (CANCEL_WORDS.has(lower)) return { kind: "cancel" };

  // field: value  (deterministic — amount / merchant / date only)
  const kv = /^(amount|merchant|date)\s*[:=]\s*(.+)$/i.exec(text);
  if (kv) {
    const field = kv[1].toLowerCase() as "amount" | "merchant" | "date";
    const value = kv[2].trim();
    if (field === "amount") {
      const n = parseAmount(value);
      return n != null ? { kind: "correct", field, value: n } : { kind: "unparseable" };
    }
    if (field === "date") {
      const iso = parseDateToIso(value);
      return iso ? { kind: "correct", field, value: iso } : { kind: "unparseable" };
    }
    // merchant
    return value ? { kind: "correct", field, value } : { kind: "unparseable" };
  }

  // bare number -> amount
  const bare = parseAmount(text);
  if (bare != null) return { kind: "correct", field: "amount", value: bare };

  return { kind: "unparseable" };
}

/** Persist the confirmed Expense (idempotent on expenseCaptureId) + ack. */
async function confirmCapture(capture: any): Promise<void> {
  // Already persisted (duplicate confirm) — re-ack, do not double-insert.
  if (capture.expenseId) {
    const existing = await Expense.findById(capture.expenseId).lean();
    if (existing) {
      await sendTextMessage(
        capture.waId,
        `✅ Already saved: ${existing.merchant || "receipt"} — ${fmtMoney(existing.amount, existing.currency)}\nReference: ${existing.ref}`,
      );
      return;
    }
  }

  const e = capture.extraction || {};

  // Auto-classify on capture: fuzzy-match the AI's free-text suggestion to a
  // managed category (same logic as the web reviewer) so WhatsApp expenses land
  // already categorized. suggestedCategory is still stored as the fallback. A
  // failed lookup is non-fatal — never block confirming a receipt on it.
  let categoryId: string | null = null;
  try {
    categoryId = await resolveCategoryId(capture.workspaceId, e.suggestedCategory);
  } catch (clsErr) {
    whatsappLogger.warn("Auto-classify failed — leaving uncategorized", {
      messageId: capture.messageId,
      error: clsErr instanceof Error ? clsErr.message : String(clsErr),
    });
  }

  const expense = await createExpense({
    workspaceId: capture.workspaceId,
    employeeId: capture.employeeId,
    expenseCaptureId: capture._id,
    sourceChannel: "whatsapp",
    imageKey: capture.imageKey,
    s3Bucket: capture.s3Bucket,
    merchant: e.merchant,
    date: e.date,
    amount: e.amount,
    currency: e.currency,
    taxAmount: e.taxAmount,
    gstin: e.gstin,
    suggestedCategory: e.suggestedCategory,
    categoryId,
    rawExtraction: capture.extractionRaw,
    perFieldConfidence: e.perFieldConfidence,
    extractionModel: capture.extractionModel,
  });

  // Park the session in awaiting_submit and offer conversational quick-submit.
  // The expense is already saved (loose, pending_to_submit); the next inbound
  // reply either submits it or leaves it in the pending list.
  capture.status = "awaiting_submit";
  capture.expenseId = expense._id as any;
  await capture.save();

  const amt = `₹${Number(expense.amount || 0).toLocaleString("en-IN")}`;
  await sendTextMessage(
    capture.waId,
    `✅ Saved ${expense.ref} · ${expense.merchant || "receipt"} · ${amt}.\n` +
      `Reply *submit* to send it for approval now, or it'll wait in your pending list.`,
  );
  whatsappLogger.info("Expense confirmed", {
    messageId: capture.messageId,
    expenseId: String(expense._id),
    ref: expense.ref,
  });
}

async function processOneReply(): Promise<boolean> {
  const reply = await ExpenseReply.findOneAndUpdate(
    { status: "queued" },
    { status: "processing", $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );
  if (!reply) return false;

  try {
    // Match to the pending capture for this sender (most recent first).
    const capture = await ExpenseCapture.findOne({
      waId: reply.waId,
      status: { $in: ["awaiting_confirmation", "awaiting_correction", "awaiting_submit"] },
    }).sort({ updatedAt: -1 });

    if (!capture) {
      await sendTextMessage(
        reply.waId,
        "No receipt is awaiting confirmation. Send a photo of a receipt to get started.",
      );
      reply.status = "done";
      await reply.save();
      return true;
    }

    // Conversational quick-submit: the just-saved expense is awaiting "submit".
    // Single just-captured expense only — no chat bundling.
    if (capture.status === "awaiting_submit") {
      const t = String(reply.text || "").trim().toLowerCase();
      const wantsSubmit = t === "submit" || t === "yes" || t === "1";
      if (wantsSubmit) {
        const result = await quickSubmitExpense(
          capture.workspaceId as any,
          capture.employeeId as any,
          capture.expenseId as any,
        );
        await sendTextMessage(
          reply.waId,
          result.ok
            ? `📤 Submitted ${result.claimRef} to ${result.approverName} for approval.`
            : `⚠️ Couldn't submit — ${result.reason}. It's in your pending list; fix & submit from the portal.`,
        );
      } else {
        // Don't trap them — anything else just leaves it in the pending list.
        await sendTextMessage(reply.waId, "👍 Saved to your pending list.");
      }
      capture.status = "confirmed"; // close the session either way
      await capture.save();
      reply.status = "done";
      reply.errorMessage = undefined;
      await reply.save();
      return true;
    }

    const intent = parseReply(reply.text);

    if (intent.kind === "cancel") {
      capture.status = "cancelled";
      await capture.save();
      await sendTextMessage(reply.waId, "Discarded. Send a new receipt photo whenever you're ready.");
    } else if (intent.kind === "confirm") {
      if (capture.extraction?.amount == null) {
        // Nothing to confirm yet (e.g. extraction failed) — ask for the amount.
        await sendTextMessage(reply.waId, "I still need the amount. " + CORRECTION_HINT);
      } else {
        await confirmCapture(capture);
      }
    } else if (intent.kind === "correct") {
      const ext: any = capture.extraction || {};
      ext[intent.field] = intent.value;
      capture.extraction = ext;
      capture.status = "awaiting_confirmation";
      capture.markModified("extraction");
      await capture.save();
      await sendTextMessage(reply.waId, buildSummary(capture));
    } else {
      // unparseable
      await sendTextMessage(reply.waId, "Sorry, I didn't get that.\n" + CORRECTION_HINT);
    }

    reply.status = "done";
    reply.errorMessage = undefined;
    await reply.save();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply.status = reply.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
    reply.errorMessage = message;
    await reply.save();
    whatsappLogger.error("Reply processing error", {
      messageId: reply.messageId,
      attempts: reply.attempts,
      status: reply.status,
      error: message,
    });
    return true;
  }
}

/* ───────────────────────── tick / bootstrap ───────────────────────────────── */

async function drain(fn: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < BATCH_PER_TICK; i++) {
    const processed = await fn();
    if (!processed) break; // queue drained
  }
}

export function startExpenseCaptureWorker() {
  if (isRunning) return;
  isRunning = true;

  whatsappLogger.info("🧾 Expense capture worker started");

  setInterval(async () => {
    try {
      if (!isWhatsAppCloudConfigured()) return; // idle until configured

      await drain(processOne); // 1. capture
      await drain(processOneExtraction); // 2. extract
      await drain(processOneReply); // 3. replies
    } catch (err) {
      whatsappLogger.error("Expense capture worker tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, POLL_INTERVAL_MS);
}
