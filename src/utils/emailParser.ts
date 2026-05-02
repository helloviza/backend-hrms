import type { gmail_v1 } from "googleapis";

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
  attachmentId?: string;
}

export interface ParsedEmail {
  fromEmail: string;
  fromName: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments: ParsedAttachment[];
  hasCalendarPart: boolean;
  gmailId: string;
  messageId: string;
  inReplyTo: string;
  threadId: string;
  historyId: string;
}

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function decodeBase64UrlToBuffer(encoded: string): Buffer {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

function getHeader(
  headers: { name?: string | null; value?: string | null }[],
  name: string,
): string {
  const target = name.toLowerCase();
  return headers.find((h) => h.name?.toLowerCase() === target)?.value || "";
}

function parseFrom(raw: string): { email: string; name: string } {
  const match = raw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^["']|["']$/g, ""),
      email: match[2].trim().toLowerCase(),
    };
  }
  return { email: raw.trim().toLowerCase(), name: "" };
}

function parseEmailList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => {
      const m = entry.match(/<([^>]+)>/);
      return (m ? m[1] : entry).trim().toLowerCase();
    })
    .filter(Boolean);
}

function extractParts(
  part: gmail_v1.Schema$MessagePart,
  acc: { bodyText: string; bodyHtml: string; attachments: ParsedAttachment[]; hasCalendarPart: boolean },
): void {
  const mime = part.mimeType || "";

  if (mime === "text/calendar" || mime === "application/ics") {
    acc.hasCalendarPart = true;
  }

  if (mime === "text/plain" && part.body?.data) {
    acc.bodyText += decodeBase64Url(part.body.data);
    return;
  }

  if (mime === "text/html" && part.body?.data) {
    acc.bodyHtml += decodeBase64Url(part.body.data);
    return;
  }

  if (mime.startsWith("multipart/") && part.parts?.length) {
    for (const sub of part.parts) extractParts(sub, acc);
    return;
  }

  if (part.filename && part.filename.length > 0) {
    acc.attachments.push({
      filename: part.filename,
      mimeType: mime,
      data: part.body?.data ? decodeBase64UrlToBuffer(part.body.data) : Buffer.alloc(0),
      attachmentId: part.body?.attachmentId ?? undefined,
    });
  }
}

export function parseEmail(gmailMsg: gmail_v1.Schema$Message): ParsedEmail {
  const headers = gmailMsg.payload?.headers || [];
  const { email: fromEmail, name: fromName } = parseFrom(getHeader(headers, "from"));

  const acc = { bodyText: "", bodyHtml: "", attachments: [] as ParsedAttachment[], hasCalendarPart: false };

  if (gmailMsg.payload) {
    const payload = gmailMsg.payload;

    if (payload.body?.data && !payload.parts?.length) {
      const decoded = decodeBase64Url(payload.body.data);
      if (payload.mimeType === "text/html") {
        acc.bodyHtml = decoded;
      } else {
        acc.bodyText = decoded;
      }
    }

    if (payload.parts?.length) {
      extractParts(payload, acc);
    }
  }

  return {
    fromEmail,
    fromName,
    to: parseEmailList(getHeader(headers, "to")),
    cc: parseEmailList(getHeader(headers, "cc")),
    bcc: parseEmailList(getHeader(headers, "bcc")),
    subject: getHeader(headers, "subject"),
    bodyText: acc.bodyText,
    bodyHtml: acc.bodyHtml,
    attachments: acc.attachments,
    hasCalendarPart: acc.hasCalendarPart,
    gmailId: gmailMsg.id || "",
    messageId: getHeader(headers, "message-id"),
    inReplyTo: getHeader(headers, "in-reply-to"),
    threadId: gmailMsg.threadId || "",
    historyId: gmailMsg.historyId || "",
  };
}
