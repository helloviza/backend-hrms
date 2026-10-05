// apps/backend/src/services/emailOutbox.ts
//
// Approval-flow emails are never fire-and-forget. Every message is written to
// EmailOutbox and tried at once; the caller learns whether that first try was
// delivered to SMTP. A failed try is retried by jobs/email-outbox-worker.ts:
//
//   try 1 at once → try 2 after 2 minutes → try 3 after 10 more minutes
//
// After the last failed try the row is FAILED: logged as an error, listed for
// staff (GET /api/approvals/admin/email-failures) and alerted to the ops desk
// (DESK_EMAIL). The alert itself is sent once and never alerts again.
//
// "Notified" is recorded only after a real send: callers pass the history row
// as `onSent` and it is pushed onto the request when (and only when) a try
// succeeds; `onFailed` is pushed when the row finally fails.
import EmailOutbox from "../models/EmailOutbox.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import { sendMail, type MailKind, type MailAttachment } from "../utils/mailer.js";
import logger from "../utils/logger.js";
import { DESK_EMAIL } from "./actorNames.js";
import { buildSendFailureAlertHtml } from "./approvalEmails/templates.js";

type AnyObj = Record<string, any>;

/** S3 bytes, loaded lazily: utils/s3Upload reads config/env on import. */
async function s3Bytes(key: string): Promise<Buffer> {
  const { getObjectBuffer } = await import("../utils/s3Upload.js");
  return getObjectBuffer(key);
}

/** Wait after try N fails (index 0 = after try 1). The array length + 1 is the try count. */
export const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** A claimed row whose process died mid-send is picked up again after this. */
const LOCK_MS = 5 * 60_000;

export const SEND_FAILURE_ALERT_EVENT = "email_send_failed_alert";

export type OutboxMessage = {
  event: string;
  kind?: MailKind;
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  /** `s3Key`: a file in S3 (booking documents), fetched on every try so retries re-read it. */
  attachments?: Array<MailAttachment & { s3Key?: string }>;
  requestId?: any;
  proposalId?: any;
  caseCode?: string;
  customerName?: string;
  onSent?: AnyObj | null;
  onFailed?: AnyObj | null;
};

export type OutboxResult = { ok: boolean; id: string; status: "SENT" | "PENDING" | "FAILED"; error?: string };

async function pushHistory(requestId: any, row: AnyObj | null | undefined, extra: AnyObj = {}) {
  if (!requestId || !row) return;
  try {
    await ApprovalRequest.updateOne({ _id: requestId }, { $push: { history: { ...row, ...extra, at: new Date() } } }).exec();
  } catch (err: any) {
    logger.error("[EmailOutbox] history update failed", { requestId: String(requestId), error: err?.message });
  }
}

/** Outbox attachments as the mailer takes them: S3 files become bytes. */
async function mailAttachments(list: AnyObj[] | undefined) {
  if (!list?.length) return undefined;
  return Promise.all(
    list.map(async (a: AnyObj) =>
      a.s3Key
        ? { filename: a.filename, content: await s3Bytes(a.s3Key), contentType: a.contentType || undefined }
        : { filename: a.filename, path: a.path, contentType: a.contentType || undefined },
    ),
  );
}

async function trySend(row: AnyObj): Promise<{ ok: boolean; error: string }> {
  try {
    const to: string[] = row.to || [];
    // An unreadable S3 file fails this try (and is retried), never sends without it.
    const attachments = await mailAttachments(row.attachments);
    const r: any = await sendMail({
      kind: row.kind,
      to: to.length === 1 ? to[0] : to,
      cc: row.cc?.length ? row.cc : undefined,
      replyTo: row.replyTo || undefined,
      subject: row.subject,
      html: row.html,
      attachments,
    });
    // utils/mailer.ts reports SMTP errors as { ok: false } rather than throwing.
    if (r && r.ok === false) return { ok: false, error: String(r.error || "send failed") };
    return { ok: true, error: "" };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err || "send failed") };
  }
}

async function attempt(row: AnyObj, now = new Date()): Promise<OutboxResult> {
  const id = String(row._id);
  const attempts = Number(row.attempts || 0) + 1;
  const max = Number(row.maxAttempts || MAX_ATTEMPTS);
  const { ok, error } = await trySend(row);

  if (ok) {
    await EmailOutbox.updateOne(
      { _id: row._id },
      { $set: { status: "SENT", attempts, sentAt: new Date(), lockedUntil: null, lastError: "" } },
    ).exec();
    await pushHistory(row.requestId, row.onSent);
    return { ok: true, id, status: "SENT" };
  }

  if (attempts >= max) {
    await EmailOutbox.updateOne(
      { _id: row._id },
      { $set: { status: "FAILED", attempts, failedAt: new Date(), lockedUntil: null, lastError: error } },
    ).exec();
    logger.error("[EmailOutbox] permanently failed", { id, event: row.event, to: row.to, attempts, error });
    await pushHistory(row.requestId, row.onFailed, { comment: `${row.onFailed?.comment || "Email failed"} (${error})` });
    if (row.event !== SEND_FAILURE_ALERT_EVENT) await alertDesk({ ...row, attempts, lastError: error });
    return { ok: false, id, status: "FAILED", error };
  }

  const wait = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  await EmailOutbox.updateOne(
    { _id: row._id },
    { $set: { status: "PENDING", attempts, nextAttemptAt: new Date(now.getTime() + wait), lockedUntil: null, lastError: error } },
  ).exec();
  logger.warn("[EmailOutbox] send failed, will retry", { id, event: row.event, attempts, error });
  return { ok: false, id, status: "PENDING", error };
}

/**
 * Writes the email to the outbox and tries it once, now. Resolves after that
 * first try; never throws for a mail problem.
 */
export async function enqueueEmail(msg: OutboxMessage, opts: { maxAttempts?: number } = {}): Promise<OutboxResult> {
  const now = new Date();
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const fields = {
    event: msg.event,
    kind: msg.kind || "DEFAULT",
    to: msg.to,
    cc: msg.cc || [],
    replyTo: msg.replyTo || "",
    subject: msg.subject,
    html: msg.html,
    attachments: (msg.attachments || []).map((a) => ({ filename: a.filename || "", path: a.path || "", s3Key: a.s3Key || "", contentType: a.contentType || "" })),
    maxAttempts,
    requestId: msg.requestId || null,
    proposalId: msg.proposalId || null,
    caseCode: msg.caseCode || "",
    customerName: msg.customerName || "",
    onSent: msg.onSent || null,
    onFailed: msg.onFailed || null,
  };

  // Try 1 happens before the row is written, so the row is written once with
  // its outcome (SENT, or PENDING for the worker) rather than twice.
  const first = await trySend(fields);
  if (first.ok) {
    const row: any = await EmailOutbox.create({ ...fields, status: "SENT", attempts: 1, sentAt: new Date() });
    await pushHistory(msg.requestId, msg.onSent);
    return { ok: true, id: String(row._id), status: "SENT" };
  }
  if (maxAttempts <= 1) {
    const row: any = await EmailOutbox.create({ ...fields, status: "FAILED", attempts: 1, failedAt: new Date(), lastError: first.error });
    logger.error("[EmailOutbox] permanently failed", { id: String(row._id), event: msg.event, to: msg.to, attempts: 1, error: first.error });
    await pushHistory(msg.requestId, msg.onFailed, { comment: `${msg.onFailed?.comment || "Email failed"} (${first.error})` });
    if (msg.event !== SEND_FAILURE_ALERT_EVENT) await alertDesk({ ...fields, _id: row._id, attempts: 1, lastError: first.error });
    return { ok: false, id: String(row._id), status: "FAILED", error: first.error };
  }
  const row: any = await EmailOutbox.create({
    ...fields,
    status: "PENDING",
    attempts: 1,
    lastError: first.error,
    nextAttemptAt: new Date(now.getTime() + RETRY_DELAYS_MS[0]),
  });
  logger.warn("[EmailOutbox] send failed, will retry", { id: String(row._id), event: msg.event, attempts: 1, error: first.error });
  return { ok: false, id: String(row._id), status: "PENDING", error: first.error };
}

/** The ops desk hears about a permanent failure (one try, never re-alerted). */
async function alertDesk(row: AnyObj) {
  try {
    await enqueueEmail(
      {
        event: SEND_FAILURE_ALERT_EVENT,
        kind: "NOTIFICATIONS",
        to: [DESK_EMAIL],
        subject: `Email not delivered — ${row.caseCode || "approval flow"} — ${row.subject}`,
        html: buildSendFailureAlertHtml({
          event: String(row.event || ""),
          subject: String(row.subject || ""),
          to: row.to || [],
          cc: row.cc || [],
          attempts: Number(row.attempts || 0),
          error: String(row.lastError || ""),
          caseCode: String(row.caseCode || ""),
          customerName: String(row.customerName || ""),
          requestId: row.requestId ? String(row.requestId) : "",
        }),
        requestId: row.requestId,
        caseCode: row.caseCode,
        customerName: row.customerName,
      },
      { maxAttempts: 1 },
    );
    await EmailOutbox.updateOne({ _id: row._id }, { $set: { alertedAt: new Date() } }).exec();
  } catch (err: any) {
    logger.error("[EmailOutbox] desk alert failed", { id: String(row._id), error: err?.message });
  }
}

/**
 * One worker pass: every row due for a retry (and any row stuck mid-send past
 * its lock) is claimed — so two instances never send the same row — and tried.
 */
export async function processOutbox(now = new Date(), limit = 50): Promise<{ tried: number; sent: number; failed: number }> {
  let tried = 0;
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const row: any = await EmailOutbox.findOneAndUpdate(
      {
        $or: [
          { status: "PENDING", nextAttemptAt: { $lte: now } },
          { status: "SENDING", lockedUntil: { $lt: now } },
        ],
      },
      { $set: { status: "SENDING", lockedUntil: new Date(now.getTime() + LOCK_MS) } },
      { sort: { nextAttemptAt: 1 }, new: true },
    )
      .lean()
      .exec();
    if (!row) break;
    tried++;
    const r = await attempt(row, now);
    if (r.status === "SENT") sent++;
    if (r.status === "FAILED") failed++;
  }
  return { tried, sent, failed };
}

/** Staff list: permanently failed emails, newest first. No bodies. */
export async function listEmailFailures(limit = 100) {
  const rows: any[] = await EmailOutbox.find({ status: "FAILED" })
    .select("event to cc subject attempts lastError failedAt createdAt requestId caseCode customerName alertedAt")
    .sort({ failedAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .lean()
    .exec();
  return rows.map((r) => ({
    id: String(r._id),
    event: r.event,
    to: r.to || [],
    cc: r.cc || [],
    subject: r.subject,
    attempts: r.attempts,
    lastError: r.lastError,
    failedAt: r.failedAt,
    createdAt: r.createdAt,
    requestId: r.requestId ? String(r.requestId) : "",
    caseCode: r.caseCode || "",
    customerName: r.customerName || "",
    alerted: Boolean(r.alertedAt),
  }));
}
