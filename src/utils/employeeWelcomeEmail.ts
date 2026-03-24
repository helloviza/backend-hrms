import { sendMail } from "./mailer.js";

const BCC_VERIFY = "salescynosurechannel@gmail.com";

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export async function sendEmployeeWelcomeEmail(params: {
  name: string;
  email: string;
  loginUrl: string;
  effectiveDate: Date;
  tempPassword?: string;
}): Promise<void> {
  const { name, email, loginUrl, effectiveDate, tempPassword } = params;
  const firstName = String(name || "").trim().split(/\s+/)[0] || "there";
  const dateStr = formatDate(effectiveDate);

  const credentialsBlock = tempPassword
    ? `
<div style="margin:24px 0;">
<div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#00477f;margin-bottom:10px;">Your Login Credentials</div>
<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;">
<table cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;color:#334155;">
<tr><td style="padding:5px 0;font-weight:600;width:170px;">Login URL</td><td style="padding:5px 0;"><a href="${loginUrl}" style="color:#00477f;text-decoration:underline;">${loginUrl}</a></td></tr>
<tr><td style="padding:5px 0;font-weight:600;">Email (Login ID)</td><td style="padding:5px 0;">${email}</td></tr>
<tr><td style="padding:5px 0;font-weight:600;">Temporary Password</td><td style="padding:5px 0;font-family:monospace;font-size:14px;color:#0f172a;font-weight:700;">${tempPassword}</td></tr>
</table>
</div>
<p style="margin:12px 0 0;font-size:13px;color:#b45309;font-weight:700;">Please change your password immediately after first login.</p>
</div>`
    : "";

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:32px auto;">

<!-- HEADER BAR -->
<tr><td style="background:#00477f;padding:18px 28px;border-radius:14px 14px 0 0;">
<span style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:0.5px;">PlumTrips HRMS</span>
</td></tr>

<!-- BODY -->
<tr><td style="background:#ffffff;padding:32px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">

<h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1e293b;">Welcome aboard, ${firstName}! &#x1F44B;</h1>

<p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.6;">
We're excited to have you join the team. Your HRMS account is now active and ready.
</p>

<p style="margin:0 0 24px;font-size:14px;color:#334155;">
<strong>Effective Date:</strong> ${dateStr}
</p>

${credentialsBlock}

<!-- NEXT STEPS -->
<div style="margin:24px 0;">
<div style="font-size:14px;font-weight:600;color:#1e293b;margin-bottom:10px;">Getting Started</div>
<ul style="margin:0;padding:0 0 0 20px;font-size:14px;color:#475569;line-height:2;">
<li>Log in using the credentials above</li>
<li>Update your profile and upload your photo</li>
<li>Check your leave balance and attendance dashboard</li>
</ul>
</div>

<!-- CTA BUTTON -->
<div style="text-align:center;margin:28px 0 8px;">
<a href="${loginUrl}" style="display:inline-block;background:#00477f;color:#ffffff;font-size:15px;font-weight:600;padding:14px 40px;border-radius:10px;text-decoration:none;">Go to My HRMS Dashboard</a>
</div>

</td></tr>

<!-- FOOTER -->
<tr><td style="background:#f8fafc;padding:18px 28px;text-align:center;font-size:11px;color:#94a3b8;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;">
This is an automated message from PlumTrips HRMS. Do not reply to this email.<br/>
&copy; Peachmint Trips and Planners Private Limited
</td></tr>

</table>
</body></html>`;

  await sendMail({
    to: email,
    subject: "Welcome to the Team \u2014 Your HRMS Access is Ready \uD83C\uDF89",
    html,
    from:
      process.env.MAIL_FROM_ONBOARDING ||
      "PlumTrips HRMS <onboarding@plumtrips.com>",
    bcc: BCC_VERIFY,
    kind: "WELCOME",
  });
}
