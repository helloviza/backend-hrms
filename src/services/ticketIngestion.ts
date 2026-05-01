import type { gmail_v1 } from "googleapis";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Ticket from "../models/Ticket.js";
import TicketMessage from "../models/TicketMessage.js";
import TicketAttachment from "../models/TicketAttachment.js";
import { parseEmail } from "../utils/emailParser.js";
import { findOrCreateLead } from "./leadResolver.js";
import { uploadTicketAttachment } from "./ticketAttachments.js";
import { fetchAttachmentData, markMessageAsProcessed, sendReply } from "./gmail.js";
import { shouldSkipIngestionEntirely, shouldSendAutoAck } from "./ticketEmailFilter.js";
import { buildAutoAckHtml } from "../utils/ticketAutoAck.js";
import logger from "../utils/logger.js";

function normalizeRfcId(raw: string | null | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  return s.startsWith("<") ? s : `<${s}>`;
}

const GEMINI_EXTRACTION_PROMPT = `Extract booking request details from this email. Return JSON only:
{ "origin": "string or null", "destination": "string or null",
  "travelDate": "ISO date string or null", "returnDate": "ISO date string or null",
  "paxCount": "number or null", "requestType": "one of: booking_query, visa, transfer, hotel, flight, other",
  "summary": "1-sentence summary" }
If a field is unclear, use null. Do not infer.

Email:
`;

let _gemini: GoogleGenerativeAI | null = null;
function getGemini() {
  if (!_gemini) _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
  return _gemini;
}

async function extractTravelDetails(bodyText: string): Promise<Record<string, unknown>> {
  try {
    const model = getGemini().getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(GEMINI_EXTRACTION_PROMPT + bodyText);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn("[TicketIngestion] Gemini extraction failed", { err });
    return {};
  }
}

export type IngestResult =
  | { skipped: true; reason: string }
  | { ticket: InstanceType<typeof Ticket>; message: InstanceType<typeof TicketMessage> };

export async function ingestEmailToTicket(
  gmailMsg: gmail_v1.Schema$Message,
): Promise<IngestResult> {
  const parsed = parseEmail(gmailMsg);
  const gmailHeaders = gmailMsg.payload?.headers || [];

  logger.info("[TicketIngestion] Ingesting message", {
    gmailId: parsed.gmailId,
    from: parsed.fromEmail,
    subject: parsed.subject,
    threadId: parsed.threadId,
  });

  // Layer 1 — hard skip: system emails, auto-replies, mailing lists
  const skipCheck = shouldSkipIngestionEntirely(parsed, gmailHeaders);
  if (skipCheck.skip) {
    logger.info(`[TicketIngestion] Skipping ingestion: ${skipCheck.reason}`, {
      fromEmail: parsed.fromEmail,
      subject: parsed.subject,
      gmailId: parsed.gmailId,
    });
    if (parsed.gmailId) {
      try {
        await markMessageAsProcessed(parsed.gmailId);
      } catch (err) {
        logger.error("[TicketIngestion] markMessageAsProcessed failed on skip", {
          gmailId: parsed.gmailId,
          err,
        });
      }
    }
    return { skipped: true, reason: skipCheck.reason };
  }

  // Dedup: skip if we already have a TicketMessage for this Gmail message ID
  if (parsed.gmailId) {
    const dup = await TicketMessage.findOne({ gmailMessageId: parsed.gmailId }).lean();
    if (dup) {
      logger.info("[TicketIngestion] Skipping duplicate gmailMessageId", { gmailId: parsed.gmailId });
      const ticket = await Ticket.findById(dup.ticketId);
      return { ticket: ticket!, message: dup as any };
    }
  }

  const { lead, workspaceId } = await findOrCreateLead({
    email: parsed.fromEmail,
    name: parsed.fromName,
    signature: parsed.bodyText,
  });

  let isNewTicket = false;
  let ticket = parsed.threadId
    ? await Ticket.findOne({ gmailThreadId: parsed.threadId })
    : null;

  if (!ticket) {
    isNewTicket = true;
    ticket = await Ticket.create({
      subject: parsed.subject,
      fromEmail: parsed.fromEmail,
      fromName: parsed.fromName,
      leadId: lead._id,
      workspaceId: workspaceId ?? null,
      gmailThreadId: parsed.threadId || null,
      gmailHistoryId: parsed.historyId || null,
      status: "NEW",
    });
    logger.info("[TicketIngestion] Created ticket", { ticketRef: ticket.ticketRef, ticketId: ticket._id });
  }

  // Resolve attachment data for any that require separate API call
  const resolvedAttachments = await Promise.all(
    parsed.attachments.map(async (att) => {
      if (att.data.length === 0 && att.attachmentId && parsed.gmailId) {
        try {
          att.data = await fetchAttachmentData(parsed.gmailId, att.attachmentId);
        } catch (err) {
          logger.warn("[TicketIngestion] Could not fetch attachment data", {
            filename: att.filename,
            err,
          });
        }
      }
      return att;
    }),
  );

  // [DIAG] — remove after debugging rfcMessageId
  console.log("[DIAG] parsed.messageId:", JSON.stringify(parsed.messageId));
  console.log("[DIAG] About to save with rfcMessageId:", normalizeRfcId(parsed.messageId));
  // [/DIAG]

  // Create TicketMessage first (without attachmentRefs)
  const ticketMessage = await TicketMessage.create({
    ticketId: ticket._id,
    direction: "INBOUND",
    channel: "EMAIL",
    fromEmail: parsed.fromEmail,
    toEmail: parsed.to,
    ccEmail: parsed.cc,
    bccEmail: parsed.bcc,
    subject: parsed.subject,
    bodyHtml: parsed.bodyHtml,
    bodyText: parsed.bodyText,
    gmailMessageId: parsed.gmailId || undefined,
    rfcMessageId: normalizeRfcId(parsed.messageId),
    gmailThreadId: parsed.threadId || undefined,
    inReplyTo: parsed.inReplyTo || undefined,
    sentAt: new Date(),
    deliveryStatus: "SENT",
  });

  // Upload attachments and create records
  const attachmentDocs = await Promise.all(
    resolvedAttachments
      .filter((att) => att.data.length > 0)
      .map(async (att) => {
        try {
          const upload = await uploadTicketAttachment(ticket!.ticketRef, {
            filename: att.filename,
            mimeType: att.mimeType,
            data: att.data,
          });
          return TicketAttachment.create({
            ticketId: ticket!._id,
            messageId: ticketMessage._id,
            fileName: att.filename,
            mimeType: att.mimeType,
            size: upload.size,
            s3Key: upload.s3Key,
            s3Bucket: upload.s3Bucket,
            checksum: upload.checksum,
          });
        } catch (err) {
          logger.error("[TicketIngestion] Attachment upload failed", { filename: att.filename, err });
          return null;
        }
      }),
  );

  const validAttachmentIds = attachmentDocs
    .filter(Boolean)
    .map((doc) => doc!._id);

  if (validAttachmentIds.length > 0) {
    await TicketMessage.findByIdAndUpdate(ticketMessage._id, {
      $set: { attachmentRefs: validAttachmentIds },
    });
  }

  // Gemini extraction only for brand-new tickets
  if (isNewTicket) {
    const bodyForExtraction = parsed.bodyText || parsed.bodyHtml.replace(/<[^>]+>/g, " ");
    if (bodyForExtraction.trim()) {
      const extracted = await extractTravelDetails(bodyForExtraction);
      await Ticket.findByIdAndUpdate(ticket._id, { $set: { extractedFields: extracted } });
      logger.info("[TicketIngestion] Gemini extraction complete", {
        ticketRef: ticket.ticketRef,
        extracted,
      });
    }
  }

  // Auto-ack: Layer 2 + Layer 3 gate
  if (parsed.fromEmail && parsed.messageId) {
    const ackCheck = shouldSendAutoAck(parsed, isNewTicket);
    if (!ackCheck.send) {
      logger.info(`[TicketIngestion] Skipping auto-ack: ${ackCheck.reason}`, {
        ticketRef: ticket.ticketRef,
        fromEmail: parsed.fromEmail,
      });
    } else {
      const replyTo = parsed.fromEmail;
      const ackHtml = buildAutoAckHtml(ticket.ticketRef);
      try {
        const ackResult = await sendReply({
          threadId: parsed.threadId,
          inReplyToRfcId: parsed.messageId,
          referencesChain: [],
          to: replyTo,
          subject: parsed.subject,
          htmlBody: ackHtml,
        });
        // Store auto-ack as OUTBOUND so future reply references chains include it
        await TicketMessage.create({
          ticketId: ticket._id,
          direction: "OUTBOUND",
          channel: "EMAIL",
          fromEmail: process.env.TICKETING_INBOX_EMAIL || "booking@plumtrips.com",
          toEmail: [replyTo],
          subject: parsed.subject,
          bodyHtml: ackHtml,
          bodyText: "",
          gmailMessageId: ackResult.gmailMessageId || undefined,
          rfcMessageId: normalizeRfcId(ackResult.rfcMessageId),
          gmailThreadId: parsed.threadId || undefined,
          inReplyTo: parsed.messageId || undefined,
          sentAt: new Date(),
          deliveryStatus: "SENT",
        });
        logger.info("[TicketIngestion] Auto-ack sent", {
          ticketRef: ticket.ticketRef,
          to: replyTo,
          rfcMessageId: ackResult.rfcMessageId,
        });
      } catch (err) {
        logger.error("[TicketIngestion] Auto-ack send failed", { ticketRef: ticket.ticketRef, err });
      }
    }
  }

  // Mark processed in Gmail (non-blocking failure — don't abort if this fails)
  if (parsed.gmailId) {
    try {
      await markMessageAsProcessed(parsed.gmailId);
    } catch (err) {
      logger.error("[TicketIngestion] markMessageAsProcessed failed", {
        gmailId: parsed.gmailId,
        err,
      });
    }
  }

  return { ticket, message: ticketMessage };
}
