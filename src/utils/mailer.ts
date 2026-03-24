import nodemailer from "nodemailer";

/**
 * Mail categories supported by the system.
 * Used ONLY for selecting the "From" identity.
 */
export type MailKind =
  | "REQUESTS"
  | "APPROVALS"
  | "CONFIRMATIONS"
  | "ONBOARDING"
  | "WELCOME"
  | "DEFAULT";

/**
 * Nodemailer attachment (subset we use)
 */
export type MailAttachment = {
  filename?: string;
  path?: string; // local filesystem path
  content?: any; // Buffer/string/stream
  contentType?: string;
  cid?: string;
  encoding?: string;
};

export type SendMailArgs = {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;

  // controls FROM selection
  kind?: MailKind;
  from?: string;

  // ✅ NEW: attachments passthrough
  attachments?: MailAttachment[];
};

/* -------------------- Env helpers -------------------- */
function envBool(v: any, def = false) {
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}

function envNum(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function normKind(k?: string): MailKind {
  const s = String(k || "").trim().toUpperCase();
  if (s === "REQUESTS") return "REQUESTS";
  if (s === "APPROVALS") return "APPROVALS";
  if (s === "CONFIRMATIONS") return "CONFIRMATIONS";
  if (s === "ONBOARDING") return "ONBOARDING";
  if (s === "WELCOME") return "WELCOME";
  return "DEFAULT";
}

function hasSmtpConfigured() {
  const url = String(process.env.SMTP_URL || "").trim();
  const host = String(process.env.SMTP_HOST || "").trim();
  return Boolean(url || host);
}

/* -------------------- FROM resolution -------------------- */
function pickFrom(args: SendMailArgs) {
  // 1️⃣ Explicit override always wins
  if (args.from) return String(args.from).trim();

  // 2️⃣ Global enforced FROM (rare but supported)
  if (process.env.SMTP_FROM) return String(process.env.SMTP_FROM).trim();

  const kind = normKind(args.kind);

  // 3️⃣ Kind-specific identities
  if (kind === "WELCOME" && process.env.MAIL_FROM_WELCOME)
    return String(process.env.MAIL_FROM_WELCOME).trim();

  if (kind === "ONBOARDING" && process.env.MAIL_FROM_ONBOARDING)
    return String(process.env.MAIL_FROM_ONBOARDING).trim();

  if (kind === "REQUESTS" && process.env.MAIL_FROM_REQUESTS)
    return String(process.env.MAIL_FROM_REQUESTS).trim();

  if (kind === "APPROVALS" && process.env.MAIL_FROM_APPROVALS)
    return String(process.env.MAIL_FROM_APPROVALS).trim();

  if (kind === "CONFIRMATIONS" && process.env.MAIL_FROM_CONFIRMATIONS)
    return String(process.env.MAIL_FROM_CONFIRMATIONS).trim();

  // 4️⃣ Safe default (NO no-reply dependency)
  return String(
    process.env.MAIL_FROM || "Plumtrips <confirmations@plumtrips.com>",
  ).trim();
}

/* -------------------- Transport -------------------- */
function makeTransport() {
  // Option A: SMTP_URL
  const smtpUrl = String(process.env.SMTP_URL || "").trim();
  if (smtpUrl) {
    return nodemailer.createTransport(smtpUrl);
  }

  // Option B: host / port / user / pass
  const host = String(process.env.SMTP_HOST || "").trim();
  if (!host) {
    // dev-safe transport (does not actually send)
    return nodemailer.createTransport({ jsonTransport: true });
  }

  const port = envNum(process.env.SMTP_PORT, 587);
  const secure = envBool(process.env.SMTP_SECURE, port === 465);

  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();

  const requireTLS = envBool(process.env.SMTP_REQUIRE_TLS, false);
  const rejectUnauthorized = envBool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true);

  const debug = envBool(process.env.SMTP_DEBUG, false);
  const logger = envBool(process.env.SMTP_LOGGER, false);

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    requireTLS,
    tls: { rejectUnauthorized },
    logger,
    debug,
  });
}

let cachedTransport: nodemailer.Transporter | null = null;

function getTransport() {
  if (!cachedTransport) cachedTransport = makeTransport();
  return cachedTransport;
}

/* -------------------- Public API -------------------- */
export async function sendMail(args: SendMailArgs) {
  // 🔒 Safety: prevent blank emails
  if (!args.html && !args.text) {
    throw new Error("sendMail requires html or text content");
  }

  const from = pickFrom(args);

  // 🛑 Kill switch
  if (envBool(process.env.DISABLE_EMAILS, false)) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log("📧 [mailer] DISABLE_EMAILS=1 — skipping send.", {
        to: args.to,
        subject: args.subject,
        from,
        kind: args.kind || "DEFAULT",
        attachments: Array.isArray(args.attachments) ? args.attachments.length : 0,
      });
    }
    return { ok: true, skipped: true };
  }

  // 🚫 SMTP not configured
  if (!hasSmtpConfigured()) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log("📧 [mailer] SMTP not configured. Skipping send.", {
        to: args.to,
        subject: args.subject,
        from,
        kind: args.kind || "DEFAULT",
        attachments: Array.isArray(args.attachments) ? args.attachments.length : 0,
      });
      return { ok: true, skipped: true };
    }
    return { ok: false, error: "SMTP not configured" };
  }

  const transporter = getTransport();

  try {
    const info = await transporter.sendMail({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      cc: args.cc,
      bcc: args.bcc,
      replyTo: args.replyTo,

      // ✅ NEW: pass attachments through to nodemailer
      attachments:
        Array.isArray(args.attachments) && args.attachments.length
          ? args.attachments
          : undefined,
    });

    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log("📧 [mailer] sent", {
        to: args.to,
        subject: args.subject,
        kind: args.kind || "DEFAULT",
        messageId: (info as any)?.messageId,
        attachments: Array.isArray(args.attachments) ? args.attachments.length : 0,
      });
    }

    return { ok: true, messageId: (info as any)?.messageId };
  } catch (err: any) {
    const msg = String(err?.message || err || "Unknown mail error");

    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("📧 [mailer] send failed", {
        to: args.to,
        subject: args.subject,
        kind: args.kind || "DEFAULT",
        error: msg,
      });
    }

    return { ok: false, error: msg };
  }
}
