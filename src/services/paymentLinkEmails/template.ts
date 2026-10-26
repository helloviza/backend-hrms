// apps/backend/src/services/paymentLinkEmails/template.ts
//
// The customer email that carries a payment request's links: one block per
// link with its amount (booking amount and PG charge shown separately), a
// "Pay ₹X" button and the expiry. Built from the approval emails' layout
// (services/approvalEmails/layout.ts) by import only — that file and the
// approval email map are not changed.
import { renderLayout, card, button, factsGrid, para, sectionLabel, noteBox, CONTENT_W, DESK_MAILBOX, type Fact } from "../approvalEmails/layout.js";
import { escapeHtml } from "../../routes/approvals.email.js";

export type PaymentLinkEmailLink = {
  seq: number;
  basePaise: number;
  pgChargePaise: number;
  totalPaise: number;
  shortUrl: string;
  expireBy: Date;
};

export type PaymentLinkEmailInput = {
  recipientName?: string;
  subject: "BOOKING" | "INVOICE";
  subjectRef: string;
  targetBasePaise: number;
  links: PaymentLinkEmailLink[];
  /** All links of the request, for "payment 2 of 3". */
  linkCount: number;
};

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const rupees = (paise: number) => INR.format(paise / 100);

function expiryText(d: Date): string {
  return new Date(d).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }) + " IST";
}

export function paymentLinkEmailSubject(input: PaymentLinkEmailInput): string {
  const what = input.subject === "INVOICE" ? `Invoice ${input.subjectRef}` : `Booking ${input.subjectRef}`;
  return `Payment link for ${what} — Plumtrips`;
}

function linkBlock(l: PaymentLinkEmailLink, count: number): string {
  const heading = count > 1 ? `Payment ${l.seq} of ${count}` : "Your payment";
  const facts: Fact[] = [{ label: "Amount", value: escapeHtml(rupees(l.basePaise)) }];
  if (l.pgChargePaise > 0) facts.push({ label: "Payment gateway charge", value: escapeHtml(rupees(l.pgChargePaise)) });
  facts.push({ label: "Total to pay", value: `<b>${escapeHtml(rupees(l.totalPaise))}</b>` });
  facts.push({ label: "Link valid until", value: escapeHtml(expiryText(l.expireBy)) });
  return card(
    `${sectionLabel(escapeHtml(heading))}
     ${factsGrid(facts)}
     <div style="height:12px;line-height:12px;font-size:0;">&nbsp;</div>
     ${button(`Pay ${rupees(l.totalPaise)}`, l.shortUrl, "primary", CONTENT_W - 38)}`,
  );
}

export function paymentLinkEmailHtml(input: PaymentLinkEmailInput): string {
  const what = input.subject === "INVOICE" ? `invoice <b>${escapeHtml(input.subjectRef)}</b>` : `booking <b>${escapeHtml(input.subjectRef)}</b>`;
  const hasPg = input.links.some((l) => l.pgChargePaise > 0);
  const greeting = input.recipientName ? `Dear ${escapeHtml(input.recipientName)},` : "Hello,";
  const intro =
    input.linkCount > 1
      ? `Please pay for ${what} using the secure Razorpay links below. The amount is split into ${input.linkCount} payments; each link is for a fixed amount.`
      : `Please pay for ${what} using the secure Razorpay link below.`;

  return renderLayout({
    title: paymentLinkEmailSubject(input),
    preheader: `Pay ${rupees(input.links.reduce((s, l) => s + l.totalPaise, 0))} for ${input.subject === "INVOICE" ? "invoice" : "booking"} ${input.subjectRef}`,
    hero: {
      badge: "Payment request",
      tone: "blue",
      headline: "Complete your payment",
      instruction: escapeHtml(`${input.subject === "INVOICE" ? "Invoice" : "Booking"} ${input.subjectRef}`),
    },
    blocks: [
      para(`${greeting}<br /><br />${intro}`),
      factsGrid([
        { label: input.subject === "INVOICE" ? "Invoice" : "Booking reference", value: escapeHtml(input.subjectRef) },
        { label: "Amount due", value: escapeHtml(rupees(input.targetBasePaise)) },
      ]),
      ...input.links.map((l) => linkBlock(l, input.linkCount)),
      hasPg
        ? noteBox("Payment gateway charge", escapeHtml("The payment gateway charge is added to each link on top of the amount due. It is not part of your booking invoice."))
        : "",
      para(`If you have already paid, or something looks wrong, reply to this email or write to <a href="mailto:${DESK_MAILBOX}">${DESK_MAILBOX}</a>.`),
    ],
    footer: "customer",
  });
}

export function paymentLinkEmailText(input: PaymentLinkEmailInput): string {
  const lines = [
    input.recipientName ? `Dear ${input.recipientName},` : "Hello,",
    "",
    `Payment for ${input.subject === "INVOICE" ? "invoice" : "booking"} ${input.subjectRef}. Amount due: ${rupees(input.targetBasePaise)}.`,
    "",
  ];
  for (const l of input.links) {
    lines.push(input.linkCount > 1 ? `Payment ${l.seq} of ${input.linkCount}` : "Your payment");
    lines.push(`  Amount: ${rupees(l.basePaise)}`);
    if (l.pgChargePaise > 0) lines.push(`  Payment gateway charge: ${rupees(l.pgChargePaise)}`);
    lines.push(`  Total to pay: ${rupees(l.totalPaise)}`);
    lines.push(`  Valid until: ${expiryText(l.expireBy)}`);
    lines.push(`  Pay: ${l.shortUrl}`);
    lines.push("");
  }
  lines.push(`Questions? Reply to this email or write to ${DESK_MAILBOX}.`);
  lines.push("Plumtrips");
  return lines.join("\n");
}
