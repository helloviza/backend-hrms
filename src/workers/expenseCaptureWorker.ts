// apps/backend/src/workers/expenseCaptureWorker.ts
import ExpenseCapture from "../models/ExpenseCapture.js";
import ExpenseReply from "../models/ExpenseReply.js";
import ExpenseWaSession from "../models/ExpenseWaSession.js";
import Expense from "../models/Expense.js";
import Report from "../models/Report.js";
import User from "../models/User.js";
import {
  isWhatsAppCloudConfigured,
  getMediaUrl,
  downloadMedia,
  sendTextMessage,
  sendButtonMessage,
} from "../services/whatsappCloud.service.js";
import { uploadExpenseReceiptToS3 } from "../utils/s3Upload.js";
import { extractReceipt } from "../services/receiptExtractorGemini.js";
import { createExpense } from "../services/expenses.service.js";
import { resolveCategoryId } from "../services/expenseCategories.service.js";
import {
  quickSubmitExpense,
  createReport,
  linkExpensesToReport,
  submitReport,
} from "../services/reports.service.js";
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
 *       an inbound text OR tapped interactive button (the webhook enqueues the
 *       button id as the reply text). Routed by waId: a receipt awaiting
 *       confirmation → confirm/fix/cancel; otherwise the post-confirm /
 *       open-claim conversation in ExpenseWaSession (submit, bundle multiple
 *       bills into one claim, submit the claim). Buttons drive it; the typed
 *       keywords ("1"/"submit"/"cancel"/"yes"/"no") still work as fallbacks.
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
  lines.push("Tap an option below — or reply: 1 (confirm) · amount: 450 · cancel.");
  return lines.join("\n");
}

/* ── Interactive button ids. Each id doubles as a typed keyword, so a button tap
 * (webhook enqueues the id as the reply text) and the typed word are handled
 * identically. Text fallbacks stay available everywhere. ─────────────────── */
const BTN = {
  CONFIRM: "confirm",
  FIX: "fix_amount",
  CANCEL: "cancel",
  SUBMIT: "submit",
  ADD_TO_CLAIM: "add_to_claim",
  LATER: "later",
  ADD_MORE: "add_more",
  YES: "yes",
  NO: "no",
} as const;

async function sendConfirmButtons(waId: string, body: string): Promise<void> {
  await sendButtonMessage(waId, body, [
    { id: BTN.CONFIRM, title: "Confirm" },
    { id: BTN.FIX, title: "Fix amount" },
    { id: BTN.CANCEL, title: "Cancel" },
  ]);
}

/** Post-confirm choices. With an open claim the only loose-expense options are
 *  Submit / Later (Add-to-claim is offered via the Yes/No add decision). */
async function sendPostConfirmButtons(waId: string, body: string, hasOpenClaim: boolean): Promise<void> {
  const buttons = hasOpenClaim
    ? [
        { id: BTN.SUBMIT, title: "Submit" },
        { id: BTN.LATER, title: "Later" },
      ]
    : [
        { id: BTN.SUBMIT, title: "Submit" },
        { id: BTN.ADD_TO_CLAIM, title: "Add to claim" },
        { id: BTN.LATER, title: "Later" },
      ];
  await sendButtonMessage(waId, body, buttons);
}

async function sendOpenClaimButtons(waId: string, body: string): Promise<void> {
  await sendButtonMessage(waId, body, [
    { id: BTN.ADD_MORE, title: "Add more" },
    { id: BTN.SUBMIT, title: "Submit" },
  ]);
}

async function sendYesNoButtons(waId: string, body: string): Promise<void> {
  await sendButtonMessage(waId, body, [
    { id: BTN.YES, title: "Yes" },
    { id: BTN.NO, title: "No" },
  ]);
}

/* ── Per-waId session helpers ─────────────────────────────────────────── */
async function getSession(waId: string) {
  return ExpenseWaSession.findOne({ waId });
}

async function upsertSession(waId: string, fields: Record<string, any>) {
  return ExpenseWaSession.findOneAndUpdate(
    { waId },
    { $set: fields, $setOnInsert: { waId } },
    { upsert: true, new: true },
  );
}

/** Reset the conversation; the open claim (if any) remains a DRAFT in the portal. */
async function clearSession(waId: string) {
  await ExpenseWaSession.updateOne(
    { waId },
    { $set: { state: "idle", openClaimId: null, openClaimName: null, pendingExpenseId: null } },
  );
}

/** The session's open claim IF it still exists, is the caller's, and is still a
 *  draft/clarification (editable). Returns null otherwise — covers a claim
 *  submitted/closed out-of-band via the portal. */
async function loadEditableOpenClaim(session: any) {
  if (!session?.openClaimId) return null;
  const report: any = await Report.findById(session.openClaimId);
  if (!report) return null;
  if (String(report.employeeId) !== String(session.employeeId)) return null;
  if (report.status !== "draft" && report.status !== "clarification_required") return null;
  return report;
}

function defaultClaimName(): string {
  const d = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  return `WhatsApp claim · ${d}`;
}

function savedLine(expense: any): string {
  const amt = `₹${Number(expense.amount || 0).toLocaleString("en-IN")}`;
  return `✅ Saved ${expense.ref} · ${expense.merchant || "receipt"} · ${amt}.`;
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

    await sendConfirmButtons(capture.waId, buildSummary(capture));
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

  // The capture's own job is done; the expense is saved loose (pending_to_submit).
  // Everything after this — submit / bundle into a claim — is per-waId session
  // state, so the conversation can span multiple receipts.
  capture.status = "confirmed";
  capture.expenseId = expense._id as any;
  await capture.save();

  const session = await getSession(capture.waId);
  const openClaim = await loadEditableOpenClaim(session);

  if (openClaim) {
    // A claim is already open — don't silently bundle; ask.
    await upsertSession(capture.waId, {
      workspaceId: capture.workspaceId,
      employeeId: capture.employeeId,
      state: "await_add_decision",
      pendingExpenseId: expense._id,
      openClaimId: openClaim._id,
      openClaimName: openClaim.name,
    });
    await sendYesNoButtons(capture.waId, `${savedLine(expense)}\nAdd to claim “${openClaim.name}”?`);
  } else {
    await upsertSession(capture.waId, {
      workspaceId: capture.workspaceId,
      employeeId: capture.employeeId,
      state: "post_confirm",
      pendingExpenseId: expense._id,
      openClaimId: null,
      openClaimName: null,
    });
    await sendPostConfirmButtons(capture.waId, `${savedLine(expense)}\nSubmit it for approval now?`, false);
  }

  whatsappLogger.info("Expense confirmed", {
    messageId: capture.messageId,
    expenseId: String(expense._id),
    ref: expense.ref,
  });
}

/**
 * Capture-level reply: a receipt is awaiting confirm / fix / cancel.
 * Buttons: [Confirm] [Fix amount] [Cancel]; text "1"/amount/"cancel" also work.
 */
async function handleCaptureReply(capture: any, waId: string, text: string): Promise<void> {
  const t = text.trim().toLowerCase();

  if (t === BTN.FIX) {
    await sendTextMessage(
      waId,
      "Send the correct amount (e.g. 450), or:\n" +
        "amount: 450  |  merchant: Name  |  date: 2026-06-15",
    );
    return;
  }

  const intent = parseReply(text);
  if (intent.kind === "cancel") {
    capture.status = "cancelled";
    await capture.save();
    await sendTextMessage(waId, "Discarded. Send a new receipt photo whenever you're ready.");
  } else if (intent.kind === "confirm") {
    if (capture.extraction?.amount == null) {
      await sendTextMessage(waId, "I still need the amount. " + CORRECTION_HINT);
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
    await sendConfirmButtons(waId, buildSummary(capture));
  } else {
    await sendTextMessage(waId, "Sorry, I didn't get that.\n" + CORRECTION_HINT);
  }
}

/** After a SOLO decision (Submit/Later on a loose expense): if a claim is still
 *  open, return to it; otherwise the conversation is done. */
async function afterSoloDecision(waId: string, session: any): Promise<void> {
  const openClaim = await loadEditableOpenClaim(session);
  if (openClaim) {
    await upsertSession(waId, { state: "open_claim", pendingExpenseId: null });
    await sendOpenClaimButtons(waId, `Claim “${openClaim.name}” is still open. Add more, or submit.`);
  } else {
    await clearSession(waId);
  }
}

/** Submit the whole open claim via the shared submitReport state machine. */
async function submitOpenClaim(waId: string, session: any): Promise<void> {
  const result = await submitReport(session.workspaceId, session.employeeId, session.openClaimId);
  if (!result.ok) {
    if (result.reason === "blocking") {
      const list = (result.blocking || []).join("\n• ");
      await sendOpenClaimButtons(
        waId,
        `⚠️ Can't submit “${session.openClaimName}” yet:\n• ${list}\nFix from the portal, then tap Submit.`,
      );
    } else {
      // not_found / not_editable — closed out-of-band; stop tracking it.
      await clearSession(waId);
      await sendTextMessage(waId, "That claim can no longer be submitted from here — check the portal.");
    }
    return;
  }
  const n = result.expenseCount ?? 0;
  let msg = `📤 Submitted ${result.claimRef} (${n} expense${n === 1 ? "" : "s"}) to ${
    result.approverName || "your approver"
  } for approval.`;
  if (result.warnings && result.warnings.length) msg += `\nNote: ${result.warnings.join("; ")}`;
  await sendTextMessage(waId, msg);
  await clearSession(waId);
}

/**
 * Session-level reply: the post-confirm / open-claim conversation (spans
 * multiple receipts). Buttons drive it; the equivalent typed keywords work too.
 */
async function handleSessionReply(session: any, waId: string, text: string): Promise<void> {
  const t = text.trim().toLowerCase();
  const ws = session.workspaceId;
  const emp = session.employeeId;

  switch (session.state) {
    case "post_confirm": {
      const hasOpenClaim = Boolean(session.openClaimId);
      const isSubmit = t === BTN.SUBMIT || t === "1" || t === "yes" || t === "y";
      const isLater = t === BTN.LATER || t === "no" || t === "skip";
      const isAddToClaim = t === BTN.ADD_TO_CLAIM || t === "add" || t === "add to claim";

      if (isSubmit) {
        const result = await quickSubmitExpense(ws, emp, session.pendingExpenseId);
        await sendTextMessage(
          waId,
          result.ok
            ? `📤 Submitted ${result.claimRef} to ${result.approverName} for approval.`
            : `⚠️ Couldn't submit — ${result.reason}. It's in your pending list; fix & submit from the portal.`,
        );
        await afterSoloDecision(waId, session);
      } else if (isAddToClaim && !hasOpenClaim) {
        await upsertSession(waId, { state: "await_claim_name" });
        await sendTextMessage(waId, "What should we name this claim? (e.g. “Mumbai trip”)");
      } else if (isLater) {
        await sendTextMessage(waId, "👍 Saved to your pending list.");
        await afterSoloDecision(waId, session);
      } else {
        await sendPostConfirmButtons(waId, "Tap an option:", hasOpenClaim);
      }
      break;
    }

    case "await_claim_name": {
      const name = text.trim() || defaultClaimName();
      const claim = await createReport(ws, emp, name);
      await linkExpensesToReport(ws, emp, claim, [session.pendingExpenseId]);
      await upsertSession(waId, {
        state: "open_claim",
        openClaimId: claim._id,
        openClaimName: name,
        pendingExpenseId: null,
      });
      await sendOpenClaimButtons(
        waId,
        `📋 Claim “${name}” started — 1 expense added.\nSend the next receipt, or tap Submit.`,
      );
      break;
    }

    case "await_add_decision": {
      const isYes = t === BTN.YES || t === "y" || t === "1" || t === BTN.ADD_TO_CLAIM || t === "add";
      const isNo = t === BTN.NO || t === "n" || t === BTN.LATER || t === "skip";
      const openClaim = await loadEditableOpenClaim(session);

      if (isYes) {
        if (!openClaim) {
          // Claim closed out-of-band — fall back to a solo decision.
          await upsertSession(waId, { state: "post_confirm", openClaimId: null, openClaimName: null });
          await sendPostConfirmButtons(waId, "That claim is no longer open. Submit this expense on its own?", false);
          break;
        }
        await linkExpensesToReport(ws, emp, openClaim, [session.pendingExpenseId]);
        const count = await Expense.countDocuments({ reportId: openClaim._id });
        await upsertSession(waId, { state: "open_claim", pendingExpenseId: null });
        await sendOpenClaimButtons(
          waId,
          `✅ Added to “${openClaim.name}” (${count} expense${count === 1 ? "" : "s"}).\nSend the next receipt, or tap Submit.`,
        );
      } else if (isNo) {
        // Leave the bill loose; the open claim stays. Offer to submit it solo.
        await upsertSession(waId, { state: "post_confirm" }); // openClaimId stays set
        await sendPostConfirmButtons(
          waId,
          "👍 Left it loose (pending to submit). Submit it on its own, or leave it for later?",
          true,
        );
      } else {
        await sendYesNoButtons(waId, `Add to claim “${session.openClaimName}”?`);
      }
      break;
    }

    case "open_claim": {
      const isAddMore = t === BTN.ADD_MORE || t === "add more" || t === "more";
      const isSubmit = t === BTN.SUBMIT || t === "1" || t === "submit";
      if (isAddMore) {
        await sendTextMessage(waId, "📸 Send the next receipt.");
      } else if (isSubmit) {
        await submitOpenClaim(waId, session);
      } else {
        await sendOpenClaimButtons(
          waId,
          `Claim “${session.openClaimName}” is open. Add more receipts, or submit.`,
        );
      }
      break;
    }

    default:
      await sendTextMessage(waId, "Send a photo of a receipt to get started.");
  }
}

async function processOneReply(): Promise<boolean> {
  const reply = await ExpenseReply.findOneAndUpdate(
    { status: "queued" },
    { status: "processing", $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );
  if (!reply) return false;

  try {
    const waId = reply.waId;
    const text = String(reply.text || "");

    // 1) A receipt awaiting confirmation always takes precedence — it's the most
    //    immediate prompt ([Confirm]/[Fix amount]/[Cancel]).
    const capture = await ExpenseCapture.findOne({
      waId,
      status: { $in: ["awaiting_confirmation", "awaiting_correction"] },
    }).sort({ updatedAt: -1 });

    if (capture) {
      await handleCaptureReply(capture, waId, text);
    } else {
      // 2) Otherwise it's the post-confirm / open-claim conversation.
      const session = await getSession(waId);
      if (session && session.state && session.state !== "idle") {
        await handleSessionReply(session, waId, text);
      } else {
        await sendTextMessage(
          waId,
          "No receipt is awaiting confirmation. Send a photo of a receipt to get started.",
        );
      }
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
