import { sendMail } from "./mailer.js";

const BCC_VERIFY = "salescynosurechannel@gmail.com";

export function buildCredentialsHtml(opts: {
  name: string;
  officialEmail: string;
  tempPassword: string;
  loginUrl: string;
  employeeCode?: string;
}): string {
  const { name, officialEmail, tempPassword, loginUrl, employeeCode } = opts;
  const employeeIdRow = employeeCode
    ? `<tr><td style="padding:4px 0;font-weight:600;width:160px;">Employee ID</td><td style="padding:4px 0;">${employeeCode}</td></tr>`
    : "";
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:32px auto;">
<tr><td style="background:#00477f;padding:18px 24px;border-radius:12px 12px 0 0;">
<span style="color:#fff;font-size:16px;font-weight:700;letter-spacing:0.5px;">PlumTrips HRMS</span>
</td></tr>
<tr><td style="background:#fff;padding:28px 24px;border:1px solid #e2e8f0;border-top:0;">
<p style="margin:0 0 16px;font-size:14px;color:#1e293b;">Hi ${name},</p>
<p style="margin:0 0 20px;font-size:14px;color:#334155;">Your HRMS account has been activated. Here are your login credentials:</p>
<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;margin:0 0 20px;">
<table cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;color:#334155;">
${employeeIdRow}
<tr><td style="padding:4px 0;font-weight:600;width:160px;">Login URL</td><td style="padding:4px 0;"><a href="${loginUrl}" style="color:#00477f;text-decoration:underline;">${loginUrl}</a></td></tr>
<tr><td style="padding:4px 0;font-weight:600;">Official Email (Login ID)</td><td style="padding:4px 0;">${officialEmail}</td></tr>
<tr><td style="padding:4px 0;font-weight:600;">Temporary Password</td><td style="padding:4px 0;font-family:monospace;font-size:14px;color:#0f172a;font-weight:700;">${tempPassword}</td></tr>
</table>
</div>
<p style="margin:0 0 20px;font-size:13px;color:#b45309;font-weight:700;">Please change your password immediately after first login.</p>
<div style="text-align:center;margin:0 0 8px;">
<a href="${loginUrl}" style="display:inline-block;background:#00477f;color:#fff;font-size:14px;font-weight:600;padding:12px 32px;border-radius:8px;text-decoration:none;">Login to HRMS</a>
</div>
</td></tr>
<tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#94a3b8;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;background:#f8fafc;">
This is an automated message from PlumTrips HRMS. Do not reply to this email.
</td></tr>
</table>
</body></html>`;
}

export async function sendCredentialsEmail(opts: {
  to: string;
  name: string;
  officialEmail: string;
  tempPassword: string;
  loginUrl: string;
  employeeCode?: string;
}): Promise<void> {
  const html = buildCredentialsHtml(opts);
  await sendMail({
    to: opts.to,
    subject: "Your Plumtrips HRMS Login Credentials",
    html,
    from:
      process.env.MAIL_FROM_ONBOARDING ||
      "PlumTrips HRMS <onboarding@plumtrips.com>",
    bcc: BCC_VERIFY,
    kind: "WELCOME",
  });
}

export function buildRejectionHtml(name: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:32px auto;">
<tr><td style="background:#00477f;padding:18px 24px;border-radius:12px 12px 0 0;">
<span style="color:#fff;font-size:16px;font-weight:700;letter-spacing:0.5px;">PlumTrips</span>
</td></tr>
<tr><td style="background:#fff;padding:28px 24px;border:1px solid #e2e8f0;border-top:0;">
<p style="margin:0 0 16px;font-size:14px;color:#1e293b;">Hi ${name},</p>
<p style="margin:0 0 16px;font-size:14px;color:#334155;">Thank you for completing your onboarding with us. After careful review, we are unable to proceed with your application at this time.</p>
<p style="margin:0 0 4px;font-size:14px;color:#334155;">If you have any questions, please reach out to your contact at Plumtrips.</p>
</td></tr>
<tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#94a3b8;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;background:#f8fafc;">
This is an automated message from PlumTrips. Do not reply to this email.
</td></tr>
</table>
</body></html>`;
}

export async function sendRejectionEmail(opts: {
  to: string;
  name: string;
}): Promise<void> {
  const html = buildRejectionHtml(opts.name);
  await sendMail({
    to: opts.to,
    subject: "Update on Your Plumtrips Onboarding Application",
    html,
    from:
      process.env.MAIL_FROM_ONBOARDING ||
      "PlumTrips <onboarding@plumtrips.com>",
    bcc: "salescynosurechannel@gmail.com",
    kind: "ONBOARDING",
  });
}
