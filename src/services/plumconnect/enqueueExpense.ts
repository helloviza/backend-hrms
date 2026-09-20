// apps/backend/src/services/plumconnect/enqueueExpense.ts
//
// PlumConnect Slice 2, Part A — the expense chain's three inbound enqueues,
// extracted VERBATIM from routes/whatsapp.webhook.ts so that both the legacy
// webhook path and the PlumConnect dispatcher write the SAME rows.
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §4 (Slice 2), D3;
// docs/plumconnect/EXPENSE_SEAM_RECHECK.md seam 1.
//
// These functions are the only seam between PlumConnect and the expense
// worker chain. The worker (workers/expenseCaptureWorker.ts) polls
// ExpenseReply / ExpenseCapture for status:"queued" and knows nothing about
// who inserted the row; it resolves identity itself (User.waId) and assigns
// workspaceId itself. Nothing here decides tenant — it only decides that a
// row exists.
//
// Idempotency is the WhatsApp message id (wamid): the unique `messageId` on
// both collections plus $setOnInsert means a redelivered webhook (or the
// legacy path and the dispatcher both seeing one message during a cut-over)
// inserts once. A concurrent-delivery duplicate-key race (11000) is reported
// as "not enqueued", exactly as the inline code treated it.
//
// Hard invariant (plan §9): the dispatcher calls these ONLY for a sender with
// a hard identity. The legacy path calls them exactly where the inline
// upserts used to be.

import ExpenseCapture from "../../models/ExpenseCapture.js";
import ExpenseReply from "../../models/ExpenseReply.js";

export interface EnqueueResult {
  /** true when this call inserted the row; false when the wamid already existed. */
  enqueued: boolean;
}

export interface EnqueueExpenseReplyInput {
  messageId: string;
  waId: string;
  phoneNumberId: string;
  text: string;
}

export interface EnqueueExpenseButtonInput {
  messageId: string;
  waId: string;
  phoneNumberId: string;
  /** The tapped reply-button / list-row id; stored as the reply's `text`. */
  buttonId: string;
}

export interface EnqueueExpenseCaptureInput {
  messageId: string;
  mediaId: string;
  mime: string;
  mediaType: "image" | "document";
  filename?: string;
  caption?: string;
  waId: string;
  phoneNumberId: string;
}

function isDupKey(err: unknown): boolean {
  return (err as any)?.code === 11000;
}

/** Was whatsapp.webhook.ts:114-126 — a TEXT reply (confirm / correct / cancel / claim flow). */
export async function enqueueExpenseReply(input: EnqueueExpenseReplyInput): Promise<EnqueueResult> {
  const { messageId, waId, phoneNumberId, text } = input;
  try {
    const replyResult = await ExpenseReply.updateOne(
      { messageId },
      {
        $setOnInsert: {
          messageId,
          waId,
          phoneNumberId,
          text,
          status: "queued",
        },
      },
      { upsert: true },
    );
    return { enqueued: replyResult.upsertedCount > 0 };
  } catch (err) {
    if (isDupKey(err)) return { enqueued: false };
    throw err;
  }
}

/** Was whatsapp.webhook.ts:155-159 — a tapped button, enqueued as a reply whose text is the button id. */
export async function enqueueExpenseButton(input: EnqueueExpenseButtonInput): Promise<EnqueueResult> {
  const { messageId, waId, phoneNumberId, buttonId } = input;
  try {
    const interResult = await ExpenseReply.updateOne(
      { messageId },
      { $setOnInsert: { messageId, waId, phoneNumberId, text: buttonId, status: "queued" } },
      { upsert: true },
    );
    return { enqueued: interResult.upsertedCount > 0 };
  } catch (err) {
    if (isDupKey(err)) return { enqueued: false };
    throw err;
  }
}

/** Was whatsapp.webhook.ts:183-200 — an image / document receipt. */
export async function enqueueExpenseCapture(input: EnqueueExpenseCaptureInput): Promise<EnqueueResult> {
  const { messageId, mediaId, mime, mediaType, filename, caption, waId, phoneNumberId } = input;
  try {
    const result = await ExpenseCapture.updateOne(
      { messageId },
      {
        $setOnInsert: {
          messageId,
          mediaId,
          mime,
          mediaType,
          filename,
          caption,
          waId,
          phoneNumberId,
          sourceChannel: "whatsapp",
          status: "queued",
        },
      },
      { upsert: true },
    );
    return { enqueued: result.upsertedCount > 0 };
  } catch (err) {
    if (isDupKey(err)) return { enqueued: false };
    throw err;
  }
}
