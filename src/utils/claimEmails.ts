// apps/backend/src/utils/claimEmails.ts
//
// Expense module — approver notification email on claim submission. Fires from
// the shared submit path (web + WhatsApp). Reuses the central mailer; sending is
// best-effort and the caller treats any failure as non-fatal.

import { sendMail } from "./mailer.js";
import { env } from "../config/env.js";

/** First configured frontend origin, trailing slash stripped. */
function frontendBase(): string {
  return String(env.FRONTEND_ORIGIN || "")
    .split(",")[0]
    .trim()
    .replace(/\/+$/, "");
}

function fmtINR(amount: number): string {
  const n = Number(amount) || 0;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export async function sendClaimSubmittedEmail(params: {
  to: string;
  approverName?: string;
  employeeName: string;
  claimRef: string;
  claimId: string;
  totalAmount: number;
}): Promise<void> {
  const { to, approverName, employeeName, claimRef, claimId, totalAmount } = params;
  const link = `${frontendBase()}/expenses/claims/${claimId}`;
  const greeting = approverName ? approverName.split(/\s+/)[0] : "there";
  const total = fmtINR(totalAmount);

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:32px auto;">

<tr><td style="background:#00477f;padding:18px 28px;border-radius:14px 14px 0 0;">
<span style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:0.5px;">PlumTrips Expenses</span>
</td></tr>

<tr><td style="background:#ffffff;padding:32px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">

<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e293b;">A claim needs your approval</h1>

<p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.6;">
Hi ${greeting}, <strong>${employeeName}</strong> submitted an expense claim for your approval.
</p>

<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;margin:0 0 24px;">
<table cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;color:#334155;">
<tr><td style="padding:5px 0;font-weight:600;width:120px;">Claim</td><td style="padding:5px 0;">${claimRef}</td></tr>
<tr><td style="padding:5px 0;font-weight:600;">Submitted by</td><td style="padding:5px 0;">${employeeName}</td></tr>
<tr><td style="padding:5px 0;font-weight:600;">Total</td><td style="padding:5px 0;font-weight:700;color:#0f172a;">${total}</td></tr>
</table>
</div>

<div style="text-align:center;margin:28px 0 8px;">
<a href="${link}" style="display:inline-block;background:#00477f;color:#ffffff;font-size:15px;font-weight:600;padding:14px 40px;border-radius:10px;text-decoration:none;">Review the claim</a>
</div>

<p style="margin:18px 0 0;font-size:12px;color:#94a3b8;word-break:break-all;">${link}</p>

</td></tr>

<tr><td style="background:#f8fafc;padding:18px 28px;text-align:center;font-size:11px;color:#94a3b8;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;">
This is an automated message from PlumTrips Expenses. Do not reply to this email.<br/>
&copy; Peachmint Trips and Planners Private Limited
</td></tr>

</table>
</body></html>`;

  const text =
    `${employeeName} submitted claim ${claimRef} (${total}) — awaiting your approval.\n` +
    `Review: ${link}`;

  await sendMail({
    to,
    subject: `New claim ${claimRef} from ${employeeName}, ${total} — awaiting your approval`,
    html,
    text,
    kind: "APPROVALS",
  });
}
