// apps/backend/src/utils/saasInviteEmail.ts
// Polished welcome email for SaaS HRMS tenants invited by SuperAdmin.
// Mirrors the layout approved in scripts/preview-welcome-email.ts.

export interface SaasInviteEmailData {
  adminName: string;
  companyName: string;
  loginUrl: string;
  loginEmail: string;
  tempPassword: string;
  trainingTime?: string;    // e.g., "11:00 AM IST" — falls back to "shortly"
  trainingMethod?: string;  // e.g., "Zoom" — falls back to "Zoom (link will be shared separately)"
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveTrainingCopy(data: SaasInviteEmailData) {
  const hasTime = !!data.trainingTime?.trim();
  const method = data.trainingMethod?.trim() || "Zoom (link will be shared separately)";
  const time = data.trainingTime?.trim() || "shortly";
  return { hasTime, method, time };
}

export function buildWelcomeEmailHtml(data: SaasInviteEmailData): string {
  const adminName = escapeHtml(data.adminName);
  const companyName = escapeHtml(data.companyName);
  const loginUrlAttr = data.loginUrl;
  const loginUrlText = escapeHtml(data.loginUrl);
  const loginEmail = escapeHtml(data.loginEmail);
  const tempPassword = escapeHtml(data.tempPassword);

  const { hasTime, method, time } = resolveTrainingCopy(data);
  const trainingLine = hasTime
    ? `We will walk you through setup at <strong>${escapeHtml(time)}</strong> via ${escapeHtml(method)}.`
    : `We will walk you through setup ${escapeHtml(time)} via ${escapeHtml(method)}.`;

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <div style="background:#00477f;padding:24px 32px;">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:600;letter-spacing:0.5px;">PlumTrips HRMS</h1>
    </div>

    <div style="padding:32px;">
      <p style="margin:0 0 16px;font-size:14px;color:#1e293b;">
        Hi <strong>${adminName}</strong>,
      </p>

      <p style="margin:0 0 8px;font-size:14px;color:#334155;line-height:1.6;">
        Welcome to <strong>Plumtrips HRMS</strong>. Your workspace for
        <strong>${companyName}</strong> is ready, and you have been set up as
        the tenant administrator.
      </p>

      <div style="margin:24px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;">
        <table style="width:100%;font-size:13px;color:#334155;">
          <tr>
            <td style="padding:6px 0;color:#64748b;width:140px;">Login URL:</td>
            <td style="padding:6px 0;"><a href="${loginUrlAttr}" style="color:#00477f;text-decoration:none;">${loginUrlText}</a></td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748b;">Login Email:</td>
            <td style="padding:6px 0;font-weight:600;">${loginEmail}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748b;">Temporary Password:</td>
            <td style="padding:6px 0;font-family:monospace;font-weight:700;background:#fef3c7;padding:4px 8px;border-radius:4px;">${tempPassword}</td>
          </tr>
        </table>
      </div>

      <p style="margin:0 0 20px;font-size:13px;color:#b45309;font-weight:600;">
        &#9888; Please change your password immediately after first login.
      </p>

      <div style="text-align:center;margin:0 0 24px;">
        <a href="${loginUrlAttr}" style="display:inline-block;background:#00477f;color:#fff;font-size:14px;font-weight:600;padding:12px 32px;border-radius:8px;text-decoration:none;">
          Login to HRMS &rarr;
        </a>
      </div>

      <p style="margin:0 0 8px;font-size:13px;color:#334155;line-height:1.6;">
        ${trainingLine} We'll cover your company profile, departments, holiday
        calendar, and bulk employee import.
      </p>

      <p style="margin:0 0 8px;font-size:13px;color:#334155;line-height:1.6;">
        Reply to this email with any questions before then.
      </p>

      <p style="margin:24px 0 0;font-size:13px;color:#334155;">
        &mdash; The Plumtrips Team
      </p>
    </div>

    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
      <p style="margin:0;font-size:11px;color:#94a3b8;text-align:center;">
        This is an automated message from PlumTrips HRMS. Do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

export function buildWelcomeEmailText(data: SaasInviteEmailData): string {
  const { hasTime, method, time } = resolveTrainingCopy(data);
  const trainingLine = hasTime
    ? `We will walk you through setup at ${time} via ${method}.`
    : `We will walk you through setup ${time} via ${method}.`;

  return [
    `Hi ${data.adminName},`,
    "",
    `Welcome to Plumtrips HRMS. Your workspace for ${data.companyName} is ready,`,
    "and you have been set up as the tenant administrator.",
    "",
    `Login URL:        ${data.loginUrl}`,
    `Login Email:      ${data.loginEmail}`,
    `Temporary Pwd:    ${data.tempPassword}`,
    "",
    "Please change your password immediately after first login.",
    "",
    `${trainingLine} We'll cover your company profile, departments,`,
    "holiday calendar, and bulk employee import.",
    "",
    "Reply to this email with any questions before then.",
    "",
    "— The Plumtrips Team",
  ].join("\n");
}
