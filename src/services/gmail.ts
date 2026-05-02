import { google, type gmail_v1 } from "googleapis";
import { JWT } from "google-auth-library";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import logger from "../utils/logger.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

let _client: gmail_v1.Gmail | null = null;
let _processedLabelId: string | null = null;

function loadServiceAccountKey(): Record<string, string> {
  const keyPath = process.env.GMAIL_SERVICE_ACCOUNT_KEY_PATH;
  const keyJson = process.env.GMAIL_SERVICE_ACCOUNT_KEY;

  if (keyPath) {
    try {
      const resolved = path.isAbsolute(keyPath)
        ? keyPath
        : path.resolve(process.cwd(), keyPath);
      return JSON.parse(fs.readFileSync(resolved, "utf-8"));
    } catch (err) {
      logger.warn("[Gmail] Could not read key file, trying inline JSON env var", { keyPath, err });
    }
  }

  if (keyJson) {
    return JSON.parse(keyJson);
  }

  throw new Error(
    "Gmail service account key not configured — set GMAIL_SERVICE_ACCOUNT_KEY_PATH or GMAIL_SERVICE_ACCOUNT_KEY",
  );
}

export function initGmailClient(): gmail_v1.Gmail {
  if (_client) return _client;

  const key = loadServiceAccountKey();
  const inboxEmail = process.env.TICKETING_INBOX_EMAIL || "booking@plumtrips.com";

  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: inboxEmail,
  });

  _client = google.gmail({ version: "v1", auth });
  logger.info("[Gmail] Client initialized", { impersonating: inboxEmail });
  return _client;
}

async function getOrCreateProcessedLabelId(): Promise<string> {
  if (_processedLabelId) return _processedLabelId;

  const gmail = initGmailClient();
  const labelName = process.env.TICKETING_GMAIL_LABEL_PROCESSED || "Plumtrips/Processed";

  try {
    const listRes = await gmail.users.labels.list({ userId: "me" });
    const existing = (listRes.data.labels || []).find((l) => l.name === labelName);

    if (existing?.id) {
      _processedLabelId = existing.id;
      logger.info("[Gmail] Found processed label", { labelName, id: _processedLabelId });
      return _processedLabelId;
    }

    const createRes = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });

    _processedLabelId = createRes.data.id!;
    logger.info("[Gmail] Created processed label", { labelName, id: _processedLabelId });
    return _processedLabelId;
  } catch (err) {
    logger.error("[Gmail] getOrCreateProcessedLabelId failed", { err });
    throw err;
  }
}

export async function fetchUnprocessedMessages(): Promise<gmail_v1.Schema$Message[]> {
  const gmail = initGmailClient();
  const labelName = process.env.TICKETING_GMAIL_LABEL_PROCESSED || "Plumtrips/Processed";
  const query = `in:inbox -label:${labelName}`;

  try {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 50,
    });

    const stubs = listRes.data.messages || [];
    logger.info("[Gmail] Message list fetched", { count: stubs.length, query });

    if (stubs.length === 0) return [];

    const fullMessages = await Promise.all(
      stubs.map(async (stub) => {
        const res = await gmail.users.messages.get({
          userId: "me",
          id: stub.id!,
          format: "full",
        });
        return res.data;
      }),
    );

    return fullMessages;
  } catch (err) {
    logger.error("[Gmail] fetchUnprocessedMessages failed", { err });
    throw err;
  }
}

export async function fetchAttachmentData(
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const gmail = initGmailClient();
  try {
    const res = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    const data = res.data.data || "";
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64");
  } catch (err) {
    logger.error("[Gmail] fetchAttachmentData failed", { messageId, attachmentId, err });
    throw err;
  }
}

export async function markMessageAsProcessed(messageId: string): Promise<void> {
  const gmail = initGmailClient();
  try {
    const labelId = await getOrCreateProcessedLabelId();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: [labelId],
        removeLabelIds: ["INBOX"],
      },
    });
    logger.info("[Gmail] Message marked as processed", { messageId });
  } catch (err) {
    logger.error("[Gmail] markMessageAsProcessed failed", { messageId, err });
    throw err;
  }
}

export interface SendReplyAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface SendReplyOptions {
  threadId: string;
  inReplyToRfcId: string;
  referencesChain: string[];
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  htmlBody: string;
  attachments?: SendReplyAttachment[];
}

export interface SendReplyResult {
  gmailMessageId: string;
  rfcMessageId: string;
}

export async function sendReply(opts: SendReplyOptions): Promise<SendReplyResult> {
  const { threadId, inReplyToRfcId, referencesChain, to, cc, bcc, subject, htmlBody, attachments } = opts;

  const gmail = initGmailClient();
  const fromAddress = process.env.TICKETING_INBOX_EMAIL || "booking@plumtrips.com";
  const from = `Plumtrips Concierge <${fromAddress}>`;

  // Strip any leading "Re:" stack to avoid "Re: Re: Re:" accumulation
  const replySubject = "Re: " + subject.replace(/^(Re:\s*)+/i, "").trim();
  const date = new Date().toUTCString();

  // Build References chain: all prior RFC Message-IDs + inReplyToRfcId at end
  const refsSet = referencesChain.filter(Boolean);
  if (inReplyToRfcId && !refsSet.includes(inReplyToRfcId)) {
    refsSet.push(inReplyToRfcId);
  }
  const references = refsSet.join(" ");

  const headerLines = [
    "MIME-Version: 1.0",
    `From: ${from}`,
    `To: ${to}`,
    ...(cc && cc.length > 0 ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc && bcc.length > 0 ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${replySubject}`,
    ...(inReplyToRfcId ? [`In-Reply-To: ${inReplyToRfcId}`] : []),
    ...(references ? [`References: ${references}`] : []),
    `Date: ${date}`,
  ];

  let mimeLines: string[];

  if (!attachments || attachments.length === 0) {
    mimeLines = [
      ...headerLines,
      "Content-Type: text/html; charset=UTF-8",
      "",
      htmlBody,
    ];
  } else {
    const boundary = `==Plumtrips_${crypto.randomBytes(12).toString("hex")}==`;
    mimeLines = [
      ...headerLines,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      htmlBody,
    ];

    for (const att of attachments) {
      const safeName = att.filename.replace(/"/g, "_");
      const b64 = att.content.toString("base64");
      // RFC 2045: base64 lines must be at most 76 chars
      const b64Lines = b64.match(/.{1,76}/g) || [];
      mimeLines.push(
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${safeName}"`,
        `Content-Disposition: attachment; filename="${safeName}"`,
        "Content-Transfer-Encoding: base64",
        "",
        ...b64Lines,
      );
    }

    mimeLines.push(`--${boundary}--`);
  }

  const raw = Buffer.from(mimeLines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  let newGmailId = "";
  let rfcMessageId = "";

  try {
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId },
    });

    newGmailId = res.data.id || "";
    logger.info("[Gmail] Reply sent", { to, subject: replySubject, threadId, gmailId: newGmailId });
  } catch (err) {
    logger.error("[Gmail] sendReply failed", { to, subject: replySubject, threadId, err });
    throw err;
  }

  // Fetch the RFC Message-ID of the sent message so callers can store it for threading
  if (newGmailId) {
    try {
      const fetchRes = await gmail.users.messages.get({
        userId: "me",
        id: newGmailId,
        format: "metadata",
        metadataHeaders: ["Message-ID"],
      });
      const rawId =
        (fetchRes.data.payload?.headers || [])
          .find((h) => h.name?.toLowerCase() === "message-id")?.value || "";
      const trimmedId = rawId.trim();
      rfcMessageId = trimmedId && !trimmedId.startsWith("<") ? `<${trimmedId}>` : trimmedId;
      logger.info("[Gmail] Captured rfcMessageId for sent reply", { gmailId: newGmailId, rfcMessageId });
    } catch (err) {
      logger.warn("[Gmail] Could not fetch rfcMessageId for sent reply", { newGmailId, err });
    }
  }

  return { gmailMessageId: newGmailId, rfcMessageId };
}
