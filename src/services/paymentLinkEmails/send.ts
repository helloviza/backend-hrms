// apps/backend/src/services/paymentLinkEmails/send.ts
//
// Sends a payment request's open links to its recipient through the email
// outbox (retries, desk alert on final failure). Event "payment_link_sent".
// The outbox row id is recorded on every link the email carried.
import mongoose from "mongoose";
import { enqueueEmail, type OutboxResult } from "../emailOutbox.js";
import { DESK_MAILBOX } from "../approvalEmails/layout.js";
import { paymentLinkEmailHtml, paymentLinkEmailSubject, paymentLinkEmailText, type PaymentLinkEmailInput } from "./template.js";

export const PAYMENT_LINK_EMAIL_EVENT = "payment_link_sent";

export type SendPaymentLinkEmailResult = { outbox: OutboxResult; linkIds: string[]; to: string };

/**
 * Email every CREATED link of `doc` (a hydrated PaymentRequest) to its
 * recipient. Mutates `doc` (emailOutboxIds + history); the caller saves.
 */
export async function sendPaymentLinkEmail(doc: any, by: string): Promise<SendPaymentLinkEmailResult> {
  const to = String(doc.recipient?.email || "").trim();
  if (!to) throw Object.assign(new Error("The payment request has no recipient email."), { status: 400, code: "BAD_RECIPIENT" });
  const open = doc.links.filter((l: any) => l.status === "CREATED" && l.shortUrl);
  if (!open.length) throw Object.assign(new Error("There is no open link to send."), { status: 409, code: "NO_OPEN_LINKS" });

  const input: PaymentLinkEmailInput = {
    recipientName: doc.recipient?.name,
    subject: doc.subject,
    subjectRef: doc.subjectRef,
    targetBasePaise: doc.targetBasePaise,
    linkCount: doc.links.filter((l: any) => l.status !== "CANCELLED" && l.status !== "EXPIRED").length,
    links: open.map((l: any) => ({
      seq: l.seq,
      basePaise: l.basePaise,
      pgChargePaise: l.pgChargePaise,
      totalPaise: l.totalPaise,
      shortUrl: l.shortUrl,
      expireBy: l.expireBy,
    })),
  };

  const outbox = await enqueueEmail({
    event: PAYMENT_LINK_EMAIL_EVENT,
    kind: "CONFIRMATIONS",
    to: [to],
    replyTo: DESK_MAILBOX,
    subject: paymentLinkEmailSubject(input),
    html: paymentLinkEmailHtml(input),
    text: paymentLinkEmailText(input),
    requestId: doc.requestId || undefined,
    caseCode: doc.subjectRef,
    customerName: doc.recipient?.name || "",
  });

  const outboxId = mongoose.Types.ObjectId.isValid(outbox.id) ? new mongoose.Types.ObjectId(outbox.id) : null;
  for (const l of open) if (outboxId) l.emailOutboxIds.push(outboxId);
  doc.history.push({
    at: new Date(),
    by,
    action: "EMAIL_SENT",
    detail: { to, status: outbox.status, outboxId: outbox.id, linkIds: open.map((l: any) => String(l._id)), ...(outbox.error ? { error: outbox.error } : {}) },
  });
  return { outbox, linkIds: open.map((l: any) => String(l._id)), to };
}
