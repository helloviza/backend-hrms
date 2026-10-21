// apps/backend/src/routes/cstep.notificationSettings.ts
//
// CSTEP notification settings — the mailbox CSTEP's emails are sent as, over
// CSTEP's own SMTP server (services/cstepMailTransport.ts). Mounted at
// /api/cstep/notifications behind the same chain as routes/cstep.ts
// (requireAuth → requireWorkspace → requireFeature("cstepEnabled"); see
// server.ts). Every route is CSTEP Admin only.
//
//   GET  /settings       — every field except the password, plus
//                          passwordSet, and the 20 most recent changes.
//   PUT  /settings       — saves them. The password is write-only: absent or
//                          "" keeps the stored one, a value replaces it,
//                          clearPassword:true removes it. It is encrypted
//                          (CSTEP_SMTP_KEY) before it is written; if that key
//                          is unavailable the save fails and nothing changes.
//                          Turning `enabled` on needs a host, a mailbox and a
//                          password. A save that changed something writes
//                          one CstepNotificationSettingsChange row naming
//                          the fields — never their values.
//   POST /settings/test  — { to } sends one sample email through the SAVED
//                          settings (enabled or not — this is how a sender is
//                          proven before it is switched on) and reports the
//                          SMTP result. Logged as a TEST change row.
import { Router } from "express";
import mongoose from "mongoose";
import CstepNotificationSettings from "../models/cstep/CstepNotificationSettings.js";
import CstepNotificationSettingsChange from "../models/cstep/CstepNotificationSettingsChange.js";
import { ownerId, isCstepAdmin } from "../utils/cstepAccess.js";
import { encryptCstepSmtpPass, resolveCstepTransport } from "../services/cstepMailTransport.js";
import { renderCstepEmailLayout } from "../services/cstepEmailLayout.js";
import { sendMail } from "../utils/mailer.js";

const router = Router();

const CHANGES_SHOWN = 20;
const MAX_ADMIN_RECIPIENTS = 20;
const MAX_PASSWORD = 256;
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The fields a change row may name (the password only as "smtpPass"). */
const FIELDS = ["enabled", "senderMailbox", "senderName", "replyTo", "smtpHost", "smtpPort", "adminRecipients"] as const;

function view(doc: any) {
  return {
    enabled: doc?.enabled === true,
    senderMailbox: doc?.senderMailbox || "",
    senderName: doc?.senderName || "",
    replyTo: doc?.replyTo || "",
    smtpHost: doc?.smtpHost || "",
    smtpPort: Number(doc?.smtpPort) || 587,
    adminRecipients: (doc?.adminRecipients || []) as string[],
    passwordSet: !!doc?.smtpPassEnc,
    updatedAt: doc?.updatedAt || null,
  };
}

async function loadView(workspaceId: any) {
  const doc: any = await CstepNotificationSettings.findOne({ workspaceId }).select("+smtpPassEnc").lean();
  return view(doc);
}

const nameOf = (u: any): string | undefined =>
  u && typeof u === "object" ? u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || undefined : undefined;

async function recentChanges(workspaceId: any) {
  const rows = await CstepNotificationSettingsChange.find({ workspaceId })
    .sort({ changedAt: -1 })
    .limit(CHANGES_SHOWN)
    .populate("changedBy", "firstName lastName name email")
    .lean();
  return (rows as any[]).map((c) => ({
    _id: String(c._id),
    action: c.action,
    fields: c.fields || [],
    testOk: c.testOk,
    changedBy: String(c.changedBy?._id || c.changedBy),
    changedByName: nameOf(c.changedBy),
    changedAt: c.changedAt,
  }));
}

router.get("/settings", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can view the notification settings" });
    const [settings, changes] = await Promise.all([loadView(req.workspaceObjectId), recentChanges(req.workspaceObjectId)]);
    res.json({ ok: true, settings, changes });
  } catch (err: any) {
    console.error("[CSTEP notification settings GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the notification settings" });
  }
});

router.put("/settings", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can change the notification settings" });
    const body = req.body || {};
    const text = (v: any) => String(v ?? "").trim().replace(/\s+/g, " ");
    const bad = (error: string) => res.status(400).json({ error });

    const senderMailbox = text(body.senderMailbox).toLowerCase();
    const senderName = text(body.senderName).replace(/["<>]/g, "");
    const replyTo = text(body.replyTo).toLowerCase();
    const smtpHost = text(body.smtpHost).toLowerCase();
    const smtpPort = body.smtpPort === undefined || body.smtpPort === "" ? 587 : Number(body.smtpPort);
    const enabled = body.enabled === true;

    if (senderMailbox && (senderMailbox.length > 254 || !EMAIL.test(senderMailbox))) return bad("Sender mailbox must be an email address");
    if (senderName.length > 100) return bad("Sender name is too long (100 characters max)");
    if (replyTo && (replyTo.length > 254 || !EMAIL.test(replyTo))) return bad("Reply-to must be an email address");
    if (smtpHost && !HOST.test(smtpHost)) return bad("SMTP host must be a host name, e.g. smtp.office365.com");
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) return bad("SMTP port must be a whole number from 1 to 65535");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return bad("enabled must be true or false");

    if (body.adminRecipients !== undefined && !Array.isArray(body.adminRecipients)) return bad("adminRecipients must be a list");
    const adminRecipients: string[] = [];
    for (const raw of body.adminRecipients || []) {
      const e = text(raw).toLowerCase();
      if (!e) continue;
      if (e.length > 254 || !EMAIL.test(e)) return bad(`"${e.slice(0, 60)}" is not an email address`);
      if (!adminRecipients.includes(e)) adminRecipients.push(e);
    }
    if (adminRecipients.length > MAX_ADMIN_RECIPIENTS) return bad(`At most ${MAX_ADMIN_RECIPIENTS} Admin recipients`);

    // Password: write-only. undefined / "" keeps; a value replaces; clearPassword removes.
    const clearPassword = body.clearPassword === true;
    const newPass = typeof body.smtpPass === "string" ? body.smtpPass : "";
    if (body.smtpPass !== undefined && typeof body.smtpPass !== "string") return bad("smtpPass must be text");
    if (newPass.length > MAX_PASSWORD) return bad(`The password is too long (${MAX_PASSWORD} characters max)`);
    if (clearPassword && newPass) return bad("Send either a new password or clearPassword, not both");

    const existing: any = await CstepNotificationSettings.findOne({ workspaceId: req.workspaceObjectId }).select("+smtpPassEnc").lean();
    const passwordWillBeSet = clearPassword ? false : newPass ? true : !!existing?.smtpPassEnc;
    if (enabled && (!smtpHost || !senderMailbox || !passwordWillBeSet)) {
      return bad("To turn notifications on, set the sender mailbox, the SMTP host and the password first");
    }

    // Encrypt BEFORE anything is written: a missing/malformed prod key throws
    // here and the save fails loudly, with the stored settings untouched.
    let smtpPassEnc: string | undefined;
    if (newPass) {
      try {
        smtpPassEnc = encryptCstepSmtpPass(newPass, req.workspaceObjectId);
      } catch (err: any) {
        console.error("[CSTEP notification settings PUT] password encryption failed", err?.message);
        return res.status(500).json({ error: `The password could not be encrypted, so nothing was saved: ${err?.message}` });
      }
    }

    const next: Record<string, any> = { enabled, senderMailbox, senderName, replyTo, smtpHost, smtpPort, adminRecipients };
    const before = view(existing);
    const changed: string[] = FIELDS.filter((f) => JSON.stringify((before as any)[f]) !== JSON.stringify(next[f]));
    if (newPass || (clearPassword && existing?.smtpPassEnc)) changed.push("smtpPass");

    if (changed.length) {
      const update: any = {
        $set: { ...next, updatedBy: new mongoose.Types.ObjectId(ownerId(req)), ...(smtpPassEnc ? { smtpPassEnc } : {}) },
        $setOnInsert: { workspaceId: req.workspaceObjectId },
      };
      if (clearPassword) update.$unset = { smtpPassEnc: 1 };
      await CstepNotificationSettings.findOneAndUpdate({ workspaceId: req.workspaceObjectId }, update, { upsert: true });
      await CstepNotificationSettingsChange.create({
        workspaceId: req.workspaceObjectId,
        action: "UPDATE",
        fields: changed,
        changedBy: new mongoose.Types.ObjectId(ownerId(req)),
      });
      console.info(`[CSTEP notification settings PUT] ws=${String(req.workspaceObjectId)} by=${ownerId(req)} changed=${changed.join(",")}`);
    }

    res.json({ ok: true, changed, settings: await loadView(req.workspaceObjectId), changes: await recentChanges(req.workspaceObjectId) });
  } catch (err: any) {
    console.error("[CSTEP notification settings PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to save the notification settings" });
  }
});

router.post("/settings/test", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can send a test email" });
    const to = String(req.body?.to || "").trim().toLowerCase();
    if (!to || to.length > 254 || !EMAIL.test(to)) return res.status(400).json({ error: "Enter the email address to send the test to" });

    const t = await resolveCstepTransport(req.workspaceObjectId, { requireEnabled: false });
    if (t.ok === false) return res.status(409).json({ error: `Save the sender settings first (${t.reason})` });

    const { html, text } = renderCstepEmailLayout({
      title: "CSTEP notifications — test email",
      preheader: "Your CSTEP notification sender is working.",
      band: "photo",
      hero: { badge: "Test", tone: "blue", headline: "Your notification sender is working" },
      greeting: "",
      intro: "CSTEP Travel & Claim Portal emails will be sent from this mailbox once notifications are turned on. No action is needed.",
      facts: [
        { label: "Sent as", value: t.from },
        { label: "SMTP server", value: `${t.smtp.host}:${t.smtp.port}` },
        ...(t.replyTo ? [{ label: "Replies go to", value: t.replyTo }] : []),
      ],
      contactEmail: t.contactEmail,
    });
    const r: any = await sendMail({
      kind: "NOTIFICATIONS",
      from: t.from,
      replyTo: t.replyTo || undefined,
      to,
      subject: `[${t.orgLabel}] Test email — CSTEP notifications`,
      html,
      text,
      smtp: t.smtp,
    });
    const okSend = !(r && r.ok === false);
    await CstepNotificationSettingsChange.create({
      workspaceId: req.workspaceObjectId,
      action: "TEST",
      fields: [],
      testOk: okSend,
      changedBy: new mongoose.Types.ObjectId(ownerId(req)),
    });
    if (!okSend) return res.status(502).json({ ok: false, error: String(r?.error || "The test email was not accepted") });
    res.json({ ok: true, skipped: !!r?.skipped, messageId: r?.messageId || null });
  } catch (err: any) {
    console.error("[CSTEP notification settings test]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to send the test email" });
  }
});

export default router;
