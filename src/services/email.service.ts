/**
 * email.service.ts — High-level email functions for workspace provisioning.
 * Builds branded HTML and delegates to the existing sendMail() utility.
 */

import { sendMail } from "../utils/mailer.js";

const BRAND_COLOR = "#00477f";
const APP_NAME = "Plumtrips HRMS";

/* ── HTML wrapper ────────────────────────────────────────────────── */

function wrap(body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#333}
.hdr{background:${BRAND_COLOR};padding:24px 32px;color:#fff;font-size:20px;font-weight:600}
.cnt{padding:32px;max-width:560px;margin:0 auto}
.btn{display:inline-block;background:${BRAND_COLOR};color:#fff!important;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;margin:16px 0}
.ftr{padding:24px 32px;color:#888;font-size:12px;border-top:1px solid #eee;text-align:center}
</style></head><body>
<div class="hdr">${APP_NAME}</div>
<div class="cnt">${body}</div>
<div class="ftr">&copy; ${new Date().getFullYear()} Plumtrips Travel Pvt. Ltd. All rights reserved.</div>
</body></html>`;
}

/* ── Safe sender — never crash if SMTP isn't configured ──────────── */

async function safeSend(to: string, subject: string, html: string): Promise<void> {
  try {
    await sendMail({ to, subject, html, kind: "WELCOME" });
  } catch (err) {
    console.error(`[email.service] Failed to send "${subject}" to ${to}:`, err);
  }
}

/* ── Public API ──────────────────────────────────────────────────── */

export async function sendWelcomeEmail(
  to: string,
  data: { adminName: string; companyName: string; verifyUrl: string },
): Promise<void> {
  const html = wrap(`
    <h2>Welcome to ${APP_NAME}, ${data.adminName}!</h2>
    <p>Your workspace for <strong>${data.companyName}</strong> is ready. You're on a free 14-day trial with full access to core features.</p>
    <p>Please verify your email address to complete setup:</p>
    <a class="btn" href="${data.verifyUrl}">Verify Email Address</a>
    <p style="color:#888;font-size:13px">If the button doesn't work, paste this link into your browser:<br>${data.verifyUrl}</p>
    <p>Next steps:</p>
    <ol>
      <li>Choose a plan that fits your team</li>
      <li>Configure your workspace (leave policies, attendance, etc.)</li>
      <li>Invite your team members</li>
    </ol>
    <p>Happy onboarding!<br>— The Plumtrips Team</p>
  `);
  await safeSend(to, `Welcome to ${APP_NAME} — Verify your email`, html);
}

export async function sendEmailVerification(
  to: string,
  data: { name: string; verifyUrl: string },
): Promise<void> {
  const html = wrap(`
    <h2>Verify your email</h2>
    <p>Hi ${data.name},</p>
    <p>Click below to verify your email address:</p>
    <a class="btn" href="${data.verifyUrl}">Verify Email</a>
    <p style="color:#888;font-size:13px">This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>
  `);
  await safeSend(to, `${APP_NAME} — Verify your email`, html);
}

export async function sendWorkspaceCredentials(
  to: string,
  data: { companyName: string; loginUrl: string; tempPassword: string },
): Promise<void> {
  const html = wrap(`
    <h2>Your workspace is ready</h2>
    <p>An administrator has created a <strong>${data.companyName}</strong> workspace on ${APP_NAME}.</p>
    <p>Here are your login credentials:</p>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:6px 12px;font-weight:600">Email</td><td style="padding:6px 12px">${to}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:600">Temporary password</td><td style="padding:6px 12px;font-family:monospace;background:#f5f5f5;border-radius:4px">${data.tempPassword}</td></tr>
    </table>
    <a class="btn" href="${data.loginUrl}">Log in now</a>
    <p style="color:#c00;font-size:13px">Please change your password after your first login.</p>
  `);
  await safeSend(to, `${APP_NAME} — Your workspace credentials`, html);
}

export async function sendEmployeeInvite(
  to: string,
  data: { companyName: string; inviterName: string; inviteUrl: string; expiresAt: Date },
): Promise<void> {
  const expiry = data.expiresAt.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const html = wrap(`
    <h2>You're invited!</h2>
    <p><strong>${data.inviterName}</strong> has invited you to join <strong>${data.companyName}</strong> on ${APP_NAME}.</p>
    <p>Click below to set up your account and join the team:</p>
    <a class="btn" href="${data.inviteUrl}">Accept Invitation</a>
    <p style="color:#888;font-size:13px">This invitation expires on ${expiry}.</p>
    <p style="color:#888;font-size:13px">If you didn't expect this, you can ignore this email.</p>
  `);
  await safeSend(to, `${data.inviterName} invited you to ${data.companyName} on ${APP_NAME}`, html);
}

export async function sendPasswordReset(
  to: string,
  data: { name: string; resetUrl: string },
): Promise<void> {
  const html = wrap(`
    <h2>Reset your password</h2>
    <p>Hi ${data.name},</p>
    <p>We received a request to reset your password. Click below to choose a new one:</p>
    <a class="btn" href="${data.resetUrl}">Reset Password</a>
    <p style="color:#888;font-size:13px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
  `);
  await safeSend(to, `${APP_NAME} — Password reset`, html);
}
