// apps/backend/src/utils/visaEmails.ts
//
// Visa module — approver notification email when a request enters the
// customer-side approval gate. Peer of utils/claimEmails.ts: same mailer,
// same best-effort contract (the caller treats any failure as non-fatal, and
// the in-app approvals badge stays the fallback notice).
//
// Branding note: this surface is HELLOVIZA, never Plumtrips — the visa
// nav/footer/copy and the HV- reference prefix are all Helloviza (see
// models/VisaRequest.ts's mintVisaRequestReferenceNumber). The expenses
// email's PlumTrips header is deliberately NOT copied across.

import { sendMail } from "./mailer.js";
import { env } from "../config/env.js";

/** First configured frontend origin, trailing slash stripped. */
function frontendBase(): string {
  return String(env.FRONTEND_ORIGIN || "")
    .split(",")[0]
    .trim()
    .replace(/\/+$/, "");
}

export async function sendVisaSubmittedEmail(params: {
  to: string;
  approverName?: string;
  requesterName: string;
  referenceNumber: string;
  requestId: string;
  destinationName: string;
  travellerCount: number;
  /** True when the request routed to its own requestor (no distinct approver
   *  existed in the workspace). The copy says so plainly rather than
   *  pretending somebody else asked them. */
  selfRouted?: boolean;
}): Promise<void> {
  const {
    to,
    approverName,
    requesterName,
    referenceNumber,
    requestId,
    destinationName,
    travellerCount,
    selfRouted,
  } = params;

  const link = `${frontendBase()}/visa/track/${requestId}`;
  const greeting = approverName ? approverName.split(/\s+/)[0] : "there";
  const travellers = `${travellerCount} traveller${travellerCount === 1 ? "" : "s"}`;

  const lead = selfRouted
    ? `Hi ${greeting}, your visa request is ready for approval. There's no separate approver set up on this workspace, so it's come to you.`
    : `Hi ${greeting}, <strong>${requesterName}</strong> raised a visa request that needs your approval before it reaches the Helloviza team.`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:32px auto;">

<tr><td style="background:#0f2e4a;padding:18px 28px;border-radius:14px 14px 0 0;">
<span style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:0.5px;">Helloviza</span>
</td></tr>

<tr><td style="background:#ffffff;padding:32px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">

<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e293b;">A visa request needs your approval</h1>

<p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.6;">${lead}</p>

<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;margin:0 0 24px;">
<table cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;color:#334155;">
<tr><td style="padding:5px 0;font-weight:600;width:120px;">Reference</td><td style="padding:5px 0;">${referenceNumber}</td></tr>
<tr><td style="padding:5px 0;font-weight:600;">Raised by</td><td style="padding:5px 0;">${requesterName}</td></tr>
<tr><td style="padding:5px 0;font-weight:600;">Destination</td><td style="padding:5px 0;font-weight:700;color:#0f172a;">${destinationName}</td></tr>
<tr><td style="padding:5px 0;font-weight:600;">Travellers</td><td style="padding:5px 0;">${travellers}</td></tr>
</table>
</div>

<p style="margin:0 0 24px;font-size:13px;color:#64748b;line-height:1.6;">
Nothing is sent to the Helloviza team until you approve it.
</p>

<div style="text-align:center;margin:28px 0 8px;">
<a href="${link}" style="display:inline-block;background:#0f2e4a;color:#ffffff;font-size:15px;font-weight:600;padding:14px 40px;border-radius:10px;text-decoration:none;">Review the request</a>
</div>

<p style="margin:18px 0 0;font-size:12px;color:#94a3b8;word-break:break-all;">${link}</p>

</td></tr>

<tr><td style="background:#f8fafc;padding:18px 28px;text-align:center;font-size:11px;color:#94a3b8;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;">
This is an automated message from Helloviza. Do not reply to this email.<br/>
&copy; Peachmint Trips and Planners Private Limited
</td></tr>

</table>
</body></html>`;

  const text =
    `${requesterName} raised visa request ${referenceNumber} (${destinationName}, ${travellers}) — awaiting your approval.\n` +
    `Nothing reaches the Helloviza team until you approve it.\n` +
    `Review: ${link}`;

  await sendMail({
    to,
    subject: `Visa request ${referenceNumber} from ${requesterName} — awaiting your approval`,
    html,
    text,
    kind: "APPROVALS",
  });
}
