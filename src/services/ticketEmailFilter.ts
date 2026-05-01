import type { ParsedEmail } from "../utils/emailParser.js";

type GmailHeader = { name?: string | null; value?: string | null };

function getHeader(headers: GmailHeader[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function hasHeader(headers: GmailHeader[], name: string): boolean {
  return headers.some((h) => h.name?.toLowerCase() === name.toLowerCase());
}

// Local-part substrings that indicate automated senders
const SKIP_LOCAL_PART_PATTERNS = [
  "no-reply",
  "noreply",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
  "postmaster",
  "bounces",
  "mail-noreply",
];

// Google infrastructure subdomains — not real humans
const SKIP_GOOGLE_DOMAINS = new Set([
  "accounts.google.com",
  "mail.google.com",
  "calendar.google.com",
  "workspace.google.com",
]);

// Subject prefixes that indicate automated messages (lower-cased, starts-with match)
const SKIP_SUBJECT_PREFIXES = [
  "auto-reply",
  "auto reply",
  "automatic reply",
  "out of office",
  "ooo:",
  "undeliverable",
  "undelivered mail",
  "delivery status notification",
  "mail delivery failure",
  "returned mail",
  "failure notice",
];

/**
 * Layer 1 — Hard skip.
 * Pure function: no DB calls. Returns { skip: true, reason } if the message should be
 * silently discarded (mark as processed in Gmail, create no ticket, send no reply).
 */
export function shouldSkipIngestionEntirely(
  parsed: ParsedEmail,
  gmailHeaders: GmailHeader[],
): { skip: boolean; reason: string } {
  const email = parsed.fromEmail.toLowerCase();
  const atIdx = email.lastIndexOf("@");
  const localPart = atIdx >= 0 ? email.slice(0, atIdx) : email;
  const domain = atIdx >= 0 ? email.slice(atIdx + 1) : "";

  // Check sender local-part against automation patterns
  for (const pattern of SKIP_LOCAL_PART_PATTERNS) {
    if (localPart.includes(pattern)) {
      return {
        skip: true,
        reason: `Sender local-part matches skip pattern "${pattern}" (from: ${email})`,
      };
    }
  }

  // Check Google infrastructure domains (exact list + any *.google.com subdomain)
  if (SKIP_GOOGLE_DOMAINS.has(domain) || (domain.endsWith(".google.com") && domain !== "gmail.com")) {
    return {
      skip: true,
      reason: `Sender domain is a Google system domain (from: ${email})`,
    };
  }

  // RFC 3834 — Auto-Submitted header (any value except "no" means automated)
  const autoSubmitted = getHeader(gmailHeaders, "auto-submitted").toLowerCase().trim();
  if (autoSubmitted && autoSubmitted !== "no") {
    return { skip: true, reason: `Auto-Submitted header present: "${autoSubmitted}"` };
  }

  // Precedence: bulk | list | junk
  const precedence = getHeader(gmailHeaders, "precedence").toLowerCase().trim();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return { skip: true, reason: `Precedence header: "${precedence}"` };
  }

  // X-Auto-Response-Suppress (any value means "don't auto-respond")
  if (hasHeader(gmailHeaders, "x-auto-response-suppress")) {
    return { skip: true, reason: "X-Auto-Response-Suppress header present" };
  }

  // List-Unsubscribe (presence alone means it's a mailing list)
  if (hasHeader(gmailHeaders, "list-unsubscribe")) {
    return { skip: true, reason: "List-Unsubscribe header present (mailing list)" };
  }

  // X-Autoreply / X-Autorespond (non-standard but widely used)
  if (hasHeader(gmailHeaders, "x-autoreply")) {
    return { skip: true, reason: "X-Autoreply header present" };
  }
  if (hasHeader(gmailHeaders, "x-autorespond")) {
    return { skip: true, reason: "X-Autorespond header present" };
  }

  // Subject pattern check (case-insensitive, starts-with)
  const subject = parsed.subject.toLowerCase().trim();
  for (const prefix of SKIP_SUBJECT_PREFIXES) {
    if (subject.startsWith(prefix)) {
      return {
        skip: true,
        reason: `Subject starts with skip pattern "${prefix}" (subject: "${parsed.subject}")`,
      };
    }
  }

  return { skip: false, reason: "" };
}

/**
 * Layer 2 + Layer 3 — Auto-ack gate.
 * Pure function: no DB calls. Returns { send: false, reason } for:
 *   - Internal @plumtrips.com senders (agents handle directly)
 *   - Calendar invites (calendar system handles RSVPs)
 *   - Follow-up messages on an existing ticket (!isNewTicket)
 */
export function shouldSendAutoAck(
  parsed: ParsedEmail,
  isNewTicket: boolean,
): { send: boolean; reason: string } {
  // Layer 3 — loop prevention: only send auto-ack once per ticket lifecycle
  if (!isNewTicket) {
    return {
      send: false,
      reason: "Follow-up on existing ticket — auto-ack only sent once per ticket lifecycle",
    };
  }

  const email = parsed.fromEmail.toLowerCase();
  const atIdx = email.lastIndexOf("@");
  const domain = atIdx >= 0 ? email.slice(atIdx + 1) : "";

  // Layer 2 — internal team sender
  if (domain === "plumtrips.com") {
    return {
      send: false,
      reason: "Internal sender (@plumtrips.com) — agents will handle directly, no auto-reply needed",
    };
  }

  // Layer 2 — calendar invite: calendar system handles RSVPs
  if (parsed.hasCalendarPart) {
    return {
      send: false,
      reason: "Calendar invite detected (text/calendar part) — calendar system handles RSVPs",
    };
  }

  return { send: true, reason: "" };
}
