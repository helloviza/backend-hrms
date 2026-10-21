// apps/backend/src/services/cstepMailTransport.ts
//
// CSTEP's own mail transport: everything that turns a workspace's
// CstepNotificationSettings into the `smtp` override utils/mailer.ts sends
// with. Used by services/cstepNotifications.ts (to decide whether to queue a
// CSTEP email at all), services/emailOutbox.ts (to send a CSTEP row — read at
// SEND time, so a retry uses the current settings) and the settings routes
// (the test email). There is no fallback: a workspace without complete,
// enabled settings sends no CSTEP mail, and never via Plumtrips' mailer.
import CstepNotificationSettings from "../models/cstep/CstepNotificationSettings.js";
import { decryptField, encryptField } from "../security/fieldCrypto.js";
import { cstepSmtpAad, resolveCstepSmtpKey } from "../security/cstepSmtpKey.js";
import type { SmtpOverride } from "../utils/mailer.js";

/**
 * Global master switch, OFF unless CSTEP_NOTIFICATIONS_ENABLED is explicitly
 * truthy (true / 1 / yes / on). Sits ON TOP of each workspace's own
 * `enabled` setting — both must be on. Read per call, so flipping the env
 * var needs no code change.
 */
export function cstepNotificationsEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(String(process.env.CSTEP_NOTIFICATIONS_ENABLED || "").trim().toLowerCase());
}

export function encryptCstepSmtpPass(plain: string, workspaceId: unknown): string {
  return encryptField(plain, resolveCstepSmtpKey().key, cstepSmtpAad(workspaceId));
}

export function decryptCstepSmtpPass(envelope: string, workspaceId: unknown): string {
  return decryptField(envelope, resolveCstepSmtpKey().key, cstepSmtpAad(workspaceId));
}

/** `"CSTEP" <notify@cstep.in>` — the display name falls back to "CSTEP". */
export function cstepFromAddress(settings: { senderName?: string; senderMailbox?: string }): string {
  const name = String(settings.senderName || "").replace(/["<>\r\n]/g, "").trim() || "CSTEP";
  return `"${name}" <${settings.senderMailbox}>`;
}

/** The address the CSTEP email footer shows: where replies land — the reply-to, else the sender mailbox. */
export function cstepContactEmail(settings: { replyTo?: string; senderMailbox?: string } | null | undefined): string {
  return String(settings?.replyTo || settings?.senderMailbox || "").trim();
}

/** The organisation label the CSTEP email header/footer shows. */
export function cstepOrgLabel(settings: { senderName?: string } | null | undefined): string {
  return String(settings?.senderName || "").trim() || "CSTEP";
}

/** Nodemailer options for port 465 (implicit TLS) vs anything else (STARTTLS, required). */
export function cstepSmtpOptions(settings: any, pass: string): SmtpOverride {
  const port = Number(settings.smtpPort) || 587;
  const implicitTls = port === 465;
  return {
    cacheKey: `${String(settings.workspaceId)}:${new Date(settings.updatedAt || 0).getTime()}`,
    host: settings.smtpHost,
    port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    user: settings.senderMailbox,
    pass,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

export type CstepTransport =
  | { ok: true; settings: any; smtp: SmtpOverride; from: string; replyTo: string; contactEmail: string; orgLabel: string }
  | { ok: false; reason: string };

/**
 * The workspace's CSTEP transport, or why there is none. `requireEnabled`
 * is false only for the Admin's test email, which must work before the
 * workspace is switched on. Decryption failures (missing prod key, a
 * tampered value) come back as a reason, never as a send without a password.
 */
export async function resolveCstepTransport(workspaceId: unknown, opts: { requireEnabled?: boolean } = {}): Promise<CstepTransport> {
  const requireEnabled = opts.requireEnabled !== false;
  if (!workspaceId) return { ok: false, reason: "no workspace" };
  const settings: any = await CstepNotificationSettings.findOne({ workspaceId }).select("+smtpPassEnc").lean();
  if (!settings) return { ok: false, reason: "no CSTEP notification settings" };
  if (requireEnabled && settings.enabled !== true) return { ok: false, reason: "CSTEP notifications are disabled for this workspace" };
  if (!settings.smtpHost || !settings.senderMailbox) return { ok: false, reason: "CSTEP sender mailbox or SMTP host not set" };
  if (!settings.smtpPassEnc) return { ok: false, reason: "CSTEP SMTP password not set" };
  let pass: string;
  try {
    pass = decryptCstepSmtpPass(settings.smtpPassEnc, settings.workspaceId);
  } catch (err: any) {
    return { ok: false, reason: `CSTEP SMTP password unreadable: ${err?.message || err}` };
  }
  return {
    ok: true,
    settings,
    smtp: cstepSmtpOptions(settings, pass),
    from: cstepFromAddress(settings),
    replyTo: settings.replyTo || "",
    contactEmail: cstepContactEmail(settings),
    orgLabel: cstepOrgLabel(settings),
  };
}
