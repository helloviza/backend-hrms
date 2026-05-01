import { google, type gmail_v1 } from "googleapis";
import { JWT } from "google-auth-library";
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

export async function sendReply(
  threadId: string,
  inReplyTo: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<{ messageId: string }> {
  const gmail = initGmailClient();
  const fromAddress = process.env.TICKETING_INBOX_EMAIL || "booking@plumtrips.com";
  const from = `Plumtrips Concierge <${fromAddress}>`;
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const date = new Date().toUTCString();

  const mimeLines = [
    "MIME-Version: 1.0",
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${inReplyTo}`,
    `Date: ${date}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    htmlBody,
  ];

  const raw = Buffer.from(mimeLines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId },
    });
    logger.info("[Gmail] Reply sent", { to, subject: replySubject, threadId, gmailId: res.data.id });
    return { messageId: res.data.id || "" };
  } catch (err) {
    logger.error("[Gmail] sendReply failed", { to, subject: replySubject, threadId, err });
    throw err;
  }
}
