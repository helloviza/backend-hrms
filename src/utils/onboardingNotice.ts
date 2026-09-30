// apps/backend/src/utils/onboardingNotice.ts
import { sendMail } from "./mailer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

/**
 * Visibility copy of onboarding emails for the PlumTrips team.
 *
 * Replaces the old hardcoded BCC on welcome / credentials emails: a BCC is a
 * full copy, so it carried the password (and later would carry the one-time
 * set-password link). This is a SEPARATE short notice to ONBOARDING_NOTIFY_ADDRESS
 * saying which email went to whom, for which company, when — and nothing else:
 * no password, no link, no token.
 *
 * A notice that fails is logged and swallowed; it never affects the email it
 * describes.
 */
/** PlumTrips' own onboarding-visibility inbox — the one definition of it. */
export const ONBOARDING_NOTIFY_ADDRESS = "salescynosurechannel@gmail.com";

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function companyFor(opts: { company?: string; workspaceId?: unknown }): Promise<string> {
  if (opts.company) return opts.company;
  if (!opts.workspaceId) return "";
  try {
    const ws: any = await CustomerWorkspace.findById(opts.workspaceId).select("companyName").lean();
    return String(ws?.companyName || "");
  } catch {
    return "";
  }
}

export async function sendOnboardingNotice(opts: {
  /** e.g. "Staff login credentials", "Client welcome" */
  emailType: string;
  recipient: string;
  company?: string;
  workspaceId?: unknown;
}): Promise<void> {
  const to = ONBOARDING_NOTIFY_ADDRESS;
  try {
    const company = (await companyFor(opts)) || "—";
    const sentAt = new Date();
    const ist = sentAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const html = `<table cellpadding="4" cellspacing="0" style="font-family:Arial,sans-serif;font-size:13px;color:#334155;">
<tr><td style="font-weight:600;">Email type</td><td>${esc(opts.emailType)}</td></tr>
<tr><td style="font-weight:600;">Recipient</td><td>${esc(opts.recipient)}</td></tr>
<tr><td style="font-weight:600;">Company</td><td>${esc(company)}</td></tr>
<tr><td style="font-weight:600;">Sent at</td><td>${esc(ist)} IST (${esc(sentAt.toISOString())})</td></tr>
</table>`;
    await sendMail({
      to,
      subject: `[Onboarding] ${opts.emailType} sent to ${opts.recipient}`,
      html,
      kind: "ONBOARDING",
    });
  } catch (err: any) {
    console.warn("[onboardingNotice] notice not sent:", err?.message || err);
  }
}
