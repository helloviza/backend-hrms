// apps/backend/src/services/partnerIntake.email.ts
//
// The one email a student gets when their request arrives through a partner
// link: "we have it, here is your case number, a travel expert will contact
// you". A template of its own, not one of the approval emails — those link to
// /customer/approvals/*, which needs a login the student doesn't have.
//
//   - no prices, no amounts (stripPriceText on every free-text value);
//   - no links at all — no login, no case page; replies go to the ops desk;
//   - sent only to the student's own address, through the outbox (retries).
import { escapeHtml } from "../routes/approvals.email.js";
import { DISABLE_EMAILS, stripPriceText } from "../routes/approvals.security.js";
import { para, renderLayout, requestHeading, sectionLabel, factsGrid, gap, DESK_MAILBOX } from "./approvalEmails/layout.js";
import { itemTitle, serviceOf } from "./approvalItemRules.js";
import { enqueueEmail, type OutboxResult } from "./emailOutbox.js";

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();
const safe = (v: any) => escapeHtml(stripPriceText(str(v)));

export const PARTNER_LEAD_RECEIVED_EVENT = "partner_lead_received";

const SERVICE_LABEL: Record<string, string> = { flight: "Flight", hotel: "Hotel", visa: "Visa" };

export function renderPartnerLeadReceived(opts: {
  caseNumber: string;
  studentName: string;
  partnerName: string;
  cartItems: AnyObj[];
}): { subject: string; html: string; text: string } {
  const first = str(opts.studentName).split(/\s+/)[0] || "there";
  const services = opts.cartItems
    .map((it) => {
      const type = serviceOf(it);
      return type ? { label: SERVICE_LABEL[type] || type, title: itemTitle(type, it.meta || {}) } : null;
    })
    .filter(Boolean) as Array<{ label: string; title: string }>;

  const subject = `We have your travel request — ${opts.caseNumber}`;
  const html = renderLayout({
    title: subject,
    preheader: `Your case number is ${opts.caseNumber}. A travel expert will contact you.`,
    hero: {
      badge: "Request received",
      tone: "blue",
      headline: `Thanks, ${safe(first)}`,
      instruction: "A travel expert will contact you shortly.",
    },
    blocks: [
      requestHeading("Your request", opts.caseNumber),
      para(
        `We have received your travel request${opts.partnerName ? ` from <b>${safe(opts.partnerName)}</b>` : ""}. ` +
          `A Plumtrips travel expert will contact you to go through the details. ` +
          `Please keep your case number handy: <b>${escapeHtml(opts.caseNumber)}</b>.`,
      ),
      services.length ? gap(4) + sectionLabel("What you asked for") : "",
      services.length ? factsGrid(services.map((s) => ({ label: s.label, value: safe(s.title) || "—" }))) : "",
      para(`Questions? Reply to this email or write to ${escapeHtml(DESK_MAILBOX)}, quoting ${escapeHtml(opts.caseNumber)}.`),
    ],
    footer: "customer",
  });
  const text = [
    `Thanks, ${stripPriceText(first)}.`,
    "",
    `We have received your travel request${opts.partnerName ? ` from ${stripPriceText(opts.partnerName)}` : ""}.`,
    "A Plumtrips travel expert will contact you shortly.",
    "",
    `Your case number: ${opts.caseNumber}`,
    ...services.map((s) => `- ${s.label}: ${stripPriceText(s.title)}`),
    "",
    `Questions? Reply to this email or write to ${DESK_MAILBOX}, quoting ${opts.caseNumber}.`,
  ].join("\n");
  return { subject, html, text };
}

/** Sends the confirmation to the student. Never throws (the case already exists). */
export async function sendPartnerLeadReceived(opts: {
  to: string;
  requestId: any;
  caseNumber: string;
  studentName: string;
  partnerName: string;
  cartItems: AnyObj[];
}): Promise<OutboxResult | null> {
  const to = str(opts.to).toLowerCase();
  if (!to || DISABLE_EMAILS) return null;
  try {
    const m = renderPartnerLeadReceived(opts);
    return await enqueueEmail({
      event: PARTNER_LEAD_RECEIVED_EVENT,
      to: [to],
      replyTo: DESK_MAILBOX,
      subject: m.subject,
      html: m.html,
      text: m.text,
      requestId: opts.requestId,
      caseCode: opts.caseNumber,
      customerName: opts.partnerName,
    });
  } catch (err: any) {
    console.error("[partner-intake] confirmation email failed", { requestId: String(opts.requestId || ""), error: err?.message });
    return null;
  }
}
