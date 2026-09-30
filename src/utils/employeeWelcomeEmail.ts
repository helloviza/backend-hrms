import { sendMail } from "./mailer.js";

// Never carries a password. A brand-new login gets a set-password link
// (utils/setPasswordLink.ts, 72h); an existing login gets no credentials.
function setPasswordBlock(setPasswordUrl: string): string {
  return `
<div style="margin:24px 0;">
<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;">
<p style="margin:0 0 12px;font-size:14px;color:#334155;">Your Plumtrips workspace access is ready. Set your password to sign in:</p>
<p style="margin:0 0 12px;font-size:13px;word-break:break-all;"><a href="${setPasswordUrl}" style="color:#00477f;text-decoration:underline;">${setPasswordUrl}</a></p>
<p style="margin:0;font-size:12px;color:#64748b;">This link expires in 72 hours. If it expires, use Forgot password on the sign-in page.</p>
</div>
</div>`;
}

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
  /** Only for a brand-new login; omit for an existing one. */
  setPasswordUrl?: string;
}): Promise<void> {
  const { name, email, loginUrl, effectiveDate, setPasswordUrl } = params;
  const firstName = String(name || "").trim().split(/\s+/)[0] || "there";
  const dateStr = formatDate(effectiveDate);

  const credentialsBlock = setPasswordUrl ? setPasswordBlock(setPasswordUrl) : "";

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
<li>${setPasswordUrl ? "Set your password using the link above, then sign in" : `Sign in with your existing login (${email})`}</li>
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
    kind: "WELCOME",
  });
}

export async function sendClientWelcomeEmail(params: {
  to: string;
  name: string;
  setPasswordUrl: string;
  loginUrl: string;
}): Promise<void> {
  const { to, name, setPasswordUrl, loginUrl } = params;
  const firstName = String(name || "").trim().split(/\s+/)[0] || "there";

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:32px auto;">

<!-- HEADER BAR -->
<tr><td style="background:#00477f;padding:18px 28px;border-radius:14px 14px 0 0;">
<span style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:0.5px;">Plumbox by PlumTrips</span>
</td></tr>

<!-- BODY -->
<tr><td style="background:#ffffff;padding:32px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">

<h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1e293b;">Welcome to Plumbox, ${firstName}!</h1>

<p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.6;">
Your Plumbox account has been created. Your sign-in email is <strong>${to}</strong>.
</p>

${setPasswordBlock(setPasswordUrl)}

<div style="text-align:center;margin:28px 0 8px;">
<a href="${loginUrl}" style="display:inline-block;background:#00477f;color:#ffffff;font-size:15px;font-weight:600;padding:14px 40px;border-radius:10px;text-decoration:none;">Log In to Plumbox</a>
</div>

</td></tr>

<!-- FOOTER -->
<tr><td style="background:#f8fafc;padding:18px 28px;text-align:center;font-size:11px;color:#94a3b8;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;">
This is an automated message from Plumbox. Do not reply to this email.<br/>
&copy; Peachmint Trips and Planners Private Limited
</td></tr>

</table>
</body></html>`;

  await sendMail({
    to,
    subject: "Welcome to Plumbox \u2014 Your Account is Ready",
    html,
    from:
      process.env.MAIL_FROM_ONBOARDING ||
      "Plumbox <onboarding@plumtrips.com>",
    kind: "WELCOME",
  });
}
