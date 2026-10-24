// apps/backend/src/services/partnerTrack.email.ts
//
// The "Track my case" code email: the 6-digit code, how long it lasts, and
// nothing else — no prices, no case details, no links (the student types the
// code into the page they asked from). Sent only to the address that asked.
import { escapeHtml } from "../routes/approvals.email.js";
import { DISABLE_EMAILS, stripPriceText } from "../routes/approvals.security.js";
import { para, renderLayout, DESK_MAILBOX } from "./approvalEmails/layout.js";
import { enqueueEmail, type OutboxResult } from "./emailOutbox.js";

export const PARTNER_TRACK_CODE_EVENT = "partner_track_code";

export function renderPartnerTrackCode(opts: { code: string; partnerName: string }): { subject: string; html: string; text: string } {
  const subject = `Your Plumtrips case code: ${opts.code}`;
  const partner = stripPriceText(String(opts.partnerName || "").trim());
  const html = renderLayout({
    title: subject,
    preheader: `Your code is ${opts.code}. It works for 10 minutes.`,
    hero: { badge: "Track my case", tone: "blue", headline: escapeHtml(opts.code), instruction: "Enter this code to see your cases. It works for 10 minutes." },
    blocks: [
      para(`You asked to see the travel cases you raised${partner ? ` through <b>${escapeHtml(partner)}</b>` : ""}. Enter the code above on that page.`),
      para(`Didn't ask for this? You can ignore this email. Questions: ${escapeHtml(DESK_MAILBOX)}.`),
    ],
    footer: "customer",
  });
  const text = [
    `Your Plumtrips case code: ${opts.code}`,
    "It works for 10 minutes.",
    "",
    `You asked to see the travel cases you raised${partner ? ` through ${partner}` : ""}. Enter the code on that page.`,
    "Didn't ask for this? You can ignore this email.",
  ].join("\n");
  return { subject, html, text };
}

export async function sendPartnerTrackCode(opts: { to: string; code: string; partnerName: string }): Promise<OutboxResult | null> {
  if (DISABLE_EMAILS || !opts.to) return null;
  try {
    const m = renderPartnerTrackCode(opts);
    return await enqueueEmail({ event: PARTNER_TRACK_CODE_EVENT, to: [opts.to], replyTo: DESK_MAILBOX, subject: m.subject, html: m.html, text: m.text, customerName: opts.partnerName });
  } catch (err: any) {
    console.error("[partner-track] code email failed", err?.message);
    return null;
  }
}
