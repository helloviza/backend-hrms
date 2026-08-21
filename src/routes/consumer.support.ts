// apps/backend/src/routes/consumer.support.ts
//
// The consumer's own support cases — /api/consumer/support/cases.
//
// Same OWN-scope posture as consumer.profile.ts and consumer.applications.ts:
// requireConsumer lives inside the router, and every read filters on
// req.consumer.id LITERALLY. It cannot lean on the workspaceScope plugin,
// because all consumers share one synthetic D2C workspace and that plugin
// fails open — a workspace filter here would scope a consumer to every
// other consumer.
//
// ── WHAT THIS ROUTER REFUSES TO SEND ──────────────────────────────────
// A Ticket is a shared B2B ops document. Most of it is ops-internal and
// none of it is a consumer's to read:
//
//   assignedTo         — who inside Plumtrips owns the case
//   tags               — an ops filing vocabulary, ours to change freely
//   extractedFields    — a Gemini guess about the case, often wrong
//   slaDueBy /
//   firstResponseAt    — our internal promise to ourselves; publishing it
//                        turns an operational target into a commitment a
//                        customer can hold us to
//   workspaceId /
//   leadId             — B2B linkage, meaningless and null here
//   gmailThreadId /
//   gmailHistoryId     — mailbox internals
//   status (raw)       — mapped to a consumer vocabulary, never sent raw
//
// This is the same discipline consumer.applications.ts states at its `ops`
// block, where the concierge assignment is withheld: who inside Plumtrips
// touched a case is our business, not the customer's.
//
// ── WHAT OF THE THREAD THE CONSUMER SEES ─────────────────────────────
// Their own submitted message, the mapped status, and agent replies that
// were EXPLICITLY marked for them — `TicketMessage.visibleToConsumer`.
//
// That flag exists because `channel` never could carry this weight. It is
// a transport bucket (EMAIL|SYSTEM|PORTAL), and the console writes SYSTEM
// for three different things: agent internal notes (tickets.console.ts,
// the isInternalNote branch), status-change audit entries, and assignment
// audit entries ("Assigned to Priya"). "Not SYSTEM" was never a safe
// proxy for "the customer may read this", so nothing here infers from it.
//
// visibleToConsumer defaults to FALSE, which makes the read an allowlist:
// the three SYSTEM writers never set it, so they cannot appear here no
// matter how the query is later edited, and no message that predates the
// field can either. WHO replied is still withheld — the projection takes
// bodyHtml and createdAt, never fromEmail or sentBy.
import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";

import { requireConsumer } from "../middleware/requireConsumer.js";
import Ticket from "../models/Ticket.js";
import TicketMessage from "../models/TicketMessage.js";
import TicketAttachment from "../models/TicketAttachment.js";
import { putTicketAttachmentBytes } from "../services/ticketAttachmentStorage.js";
import {
  CALLBACK_SUBJECT,
  CONSUMER_SUPPORT_SUBJECTS,
  consumerStatusLabel,
  createConsumerSupportCase,
  isAllowedSubject,
} from "../services/consumerSupport.js";
import logger from "../utils/logger.js";

const router = Router();
router.use(requireConsumer);

const supportLogger = logger.child({ module: "consumerSupport.routes" });

function me(req: any): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(String(req.consumer.id));
}

const MAX_MESSAGE_LENGTH = 5000;
const MAX_PHONE_LENGTH = 32;

/**
 * Attachment limits.
 *
 * Deliberately the SAME numbers the B2B reply route already enforces
 * (tickets.console.ts's multer config): one queue, one set of limits, so
 * an agent never meets a consumer-uploaded file larger than one they could
 * have sent themselves.
 *
 * No mimetype filter, per the product call that any format is allowed —
 * which is a real widening compared with the consumer DOCUMENT locker
 * (PDF/PNG/JPEG/WEBP only). What protects the reader is that these bytes
 * are only ever served back as a download to an authenticated agent, never
 * rendered inline in the consumer's own browser as trusted markup.
 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ATTACHMENTS_PER_CASE = 5;

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS_PER_CASE },
}).array("files", MAX_ATTACHMENTS_PER_CASE);

/** Turns multer's own failures into the shapes this router already speaks. */
function attachmentUploadMw(req: any, res: any, next: any) {
  attachmentUpload(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        ok: false,
        error: `Each file must be ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB or smaller`,
        field: "files",
      });
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        ok: false,
        error: `You can attach up to ${MAX_ATTACHMENTS_PER_CASE} files`,
        field: "files",
      });
    }
    return res.status(400).json({ ok: false, error: err?.message || "Upload failed" });
  });
}

/**
 * GET /subjects — the allowlist, so Stage B's form renders exactly what the
 * server will accept rather than a copy that can drift out of step.
 */
router.get("/subjects", (_req, res) => {
  res.json({ ok: true, subjects: CONSUMER_SUPPORT_SUBJECTS });
});

/**
 * POST /cases — file a case.
 *
 * Anything identity-shaped in the body is IGNORED, not rejected: a client
 * that sends `email` or `consumerId` gets a case filed against their own
 * session identity. Rejecting would leak which field names matter.
 */
router.post("/cases", async (req: any, res: any) => {
  try {
    const { subject, message, callbackPhone } = req.body ?? {};

    if (!isAllowedSubject(subject)) {
      return res.status(400).json({
        ok: false,
        error: "Choose a subject from the list",
        field: "subject",
      });
    }

    const trimmedMessage = typeof message === "string" ? message.trim() : "";
    if (!trimmedMessage) {
      return res.status(400).json({
        ok: false,
        error: "Tell us what you need help with",
        field: "message",
      });
    }
    if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        ok: false,
        error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`,
        field: "message",
      });
    }

    const rawPhone = typeof callbackPhone === "string" ? callbackPhone.trim() : "";
    if (rawPhone.length > MAX_PHONE_LENGTH) {
      return res.status(400).json({
        ok: false,
        error: "That phone number is too long",
        field: "callbackPhone",
      });
    }
    if (subject === CALLBACK_SUBJECT && !rawPhone) {
      return res.status(400).json({
        ok: false,
        error: "Add a phone number we can call you on",
        field: "callbackPhone",
      });
    }

    const { ticket } = await createConsumerSupportCase({
      // NOT req.body.consumerId — the session decides who this is.
      consumerId: me(req),
      subject,
      message: trimmedMessage,
      callbackPhone: rawPhone || null,
    });

    return res.status(201).json({
      ok: true,
      case: {
        ticketRef: ticket.ticketRef,
        subject: ticket.subject,
        status: consumerStatusLabel(ticket.status),
        createdAt: ticket.createdAt,
      },
    });
  } catch (err: any) {
    supportLogger.error("[ConsumerSupport] create failed", {
      consumerId: String(req.consumer?.id),
      err,
    });
    return res.status(500).json({ ok: false, error: "Could not file your request" });
  }
});

/**
 * POST /cases/:ticketRef/attachments — attach files to one's OWN case.
 *
 * ── THE FENCE ────────────────────────────────────────────────────────
 * The case is looked up by { ticketRef, consumerId } TOGETHER. A consumer
 * naming somebody else's reference gets the same 404 as one naming a
 * reference that does not exist — the lookup cannot match, so there is no
 * branch in which the wrong case is written to, and no oracle telling an
 * attacker which references are real.
 *
 * ── WHY THE MESSAGE LINK MATTERS ─────────────────────────────────────
 * The admin console renders attachment chips by filtering on
 * `msg.attachmentRefs.includes(att._id)` (components/admin/TicketDetail.tsx).
 * Setting TicketAttachment.messageId alone is NOT enough — without the
 * reverse pointer on the message the file is stored, downloadable by URL,
 * and invisible to the person who needs it. Both directions are written
 * here, the same way the B2B reply route does it.
 */
router.post("/cases/:ticketRef/attachments", attachmentUploadMw, async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const files: Express.Multer.File[] = (req.files as Express.Multer.File[]) || [];

    if (files.length === 0) {
      return res.status(400).json({ ok: false, error: "Attach at least one file", field: "files" });
    }

    const ticket = await Ticket.findOne({
      ticketRef: String(req.params.ticketRef),
      consumerId,
    });
    if (!ticket) {
      return res.status(404).json({ ok: false, error: "Case not found" });
    }

    // The consumer's own first message is what these files belong to — the
    // same message the history returns as `yourMessage`.
    const message = await TicketMessage.findOne({
      ticketId: ticket._id,
      direction: "INBOUND",
    }).sort({ createdAt: 1 });
    if (!message) {
      return res.status(409).json({ ok: false, error: "This case has no message to attach to" });
    }

    // Re-check the count SERVER-SIDE against what the case already holds,
    // not just against this request: multer caps one upload at five files,
    // and five uploads of five files would otherwise be twenty-five.
    const existing = await TicketAttachment.countDocuments({ ticketId: ticket._id });
    if (existing + files.length > MAX_ATTACHMENTS_PER_CASE) {
      return res.status(400).json({
        ok: false,
        error: `You can attach up to ${MAX_ATTACHMENTS_PER_CASE} files to a case`,
        field: "files",
      });
    }

    const saved: Array<{ fileName: string; size: number }> = [];
    for (const file of files) {
      // Belt-and-braces on size: multer already enforced it, but the value
      // that reaches the database should be checked where it is used.
      if (!file.buffer || file.buffer.length === 0) continue;
      if (file.buffer.length > MAX_ATTACHMENT_BYTES) {
        return res.status(413).json({
          ok: false,
          error: `Each file must be ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB or smaller`,
          field: "files",
        });
      }

      const stored = await putTicketAttachmentBytes({
        ticketRef: ticket.ticketRef,
        filename: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        data: file.buffer,
      });

      const att = await TicketAttachment.create({
        ticketId: ticket._id,
        messageId: message._id,
        fileName: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        size: stored.size,
        driver: stored.driver,
        storageKey: stored.storageKey,
        s3Key: stored.s3Key,
        s3Bucket: stored.s3Bucket,
        checksum: stored.checksum,
      });

      // THE REVERSE POINTER — see the header note.
      await TicketMessage.findByIdAndUpdate(message._id, {
        $push: { attachmentRefs: att._id },
      });

      saved.push({ fileName: att.fileName, size: att.size });
    }

    supportLogger.info("[ConsumerSupport] Attached files to web case", {
      ticketRef: ticket.ticketRef,
      consumerId: String(consumerId),
      count: saved.length,
    });

    return res.status(201).json({ ok: true, attachments: saved });
  } catch (err: any) {
    supportLogger.error("[ConsumerSupport] attach failed", {
      consumerId: String(req.consumer?.id),
      err,
    });
    return res.status(500).json({ ok: false, error: "Could not attach your files" });
  }
});

/**
 * GET /cases — the consumer's own cases, newest first.
 *
 * The projection is an ALLOWLIST (.select of named fields), not a denylist:
 * a field added to Ticket later is invisible here until someone chooses to
 * expose it, which is the safe direction for a shared ops model to grow in.
 */
router.get("/cases", async (req: any, res: any) => {
  try {
    const consumerId = me(req);

    const tickets = await Ticket.find({ consumerId })
      .select("_id ticketRef subject status createdAt updatedAt")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    if (tickets.length === 0) {
      return res.json({ ok: true, cases: [] });
    }

    // The consumer's own words, back to them. INBOUND only — see the header
    // note on why no agent-authored message is exposed in v1.
    const ownMessages = await TicketMessage.find({
      ticketId: { $in: tickets.map((t) => t._id) },
      direction: "INBOUND",
    })
      .select("ticketId bodyText createdAt")
      .sort({ createdAt: 1 })
      .lean();

    const firstMessageByTicket = new Map<string, string>();
    for (const msg of ownMessages) {
      const key = String(msg.ticketId);
      if (!firstMessageByTicket.has(key)) {
        firstMessageByTicket.set(key, String((msg as any).bodyText || ""));
      }
    }

    /* ── AGENT REPLIES ────────────────────────────────────────────────
     * `visibleToConsumer: true` is the whole gate, and it is an ALLOWLIST:
     * a message that does not say yes is not returned. Internal notes,
     * status audit and assignment audit never set it, so they cannot
     * match — not because they are filtered out, but because they were
     * never let in. Same for every message written before the field
     * existed.
     *
     * The projection is bodyHtml + createdAt and nothing else. No
     * fromEmail, no sentBy, no channel: WHO inside Plumtrips answered is
     * withheld on the same rule as the concierge assignment (see this
     * file's header). The ticket scope comes from `tickets`, which is
     * already fenced to this consumer, so a reply cannot arrive from a
     * case the reader does not own. */
    const agentReplies = await TicketMessage.find({
      ticketId: { $in: tickets.map((t) => t._id) },
      direction: "OUTBOUND",
      visibleToConsumer: true,
    })
      .select("ticketId bodyHtml createdAt")
      .sort({ createdAt: 1 })
      .lean();

    const repliesByTicket = new Map<string, Array<{ bodyHtml: string; createdAt: Date }>>();
    for (const msg of agentReplies) {
      const key = String(msg.ticketId);
      const list = repliesByTicket.get(key) ?? [];
      list.push({
        bodyHtml: String((msg as any).bodyHtml || ""),
        createdAt: (msg as any).createdAt,
      });
      repliesByTicket.set(key, list);
    }

    // How many files the reader themselves attached. A COUNT, not the
    // files: this is the consumer confirming their upload persisted, which
    // is the one thing they cannot otherwise verify. Filenames and download
    // links are a wider surface than that question needs, and the bytes are
    // already on the reader's own device.
    const attachmentCounts = await TicketAttachment.aggregate([
      { $match: { ticketId: { $in: tickets.map((t) => t._id) } } },
      { $group: { _id: "$ticketId", n: { $sum: 1 } } },
    ]);
    const countByTicket = new Map<string, number>(
      attachmentCounts.map((r: any) => [String(r._id), r.n as number]),
    );

    const cases = tickets.map((t) => ({
      ticketRef: t.ticketRef,
      subject: t.subject,
      status: consumerStatusLabel(t.status),
      createdAt: t.createdAt,
      // updatedAt is the honest "last activity" signal: it moves when ops
      // touch the case, without saying who or what they did.
      lastActivityAt: (t as any).updatedAt ?? t.createdAt,
      yourMessage: firstMessageByTicket.get(String(t._id)) ?? "",
      attachmentCount: countByTicket.get(String(t._id)) ?? 0,
      // Oldest first — the reader scrolls a conversation, not a stack.
      replies: repliesByTicket.get(String(t._id)) ?? [],
    }));

    return res.json({ ok: true, cases });
  } catch (err: any) {
    supportLogger.error("[ConsumerSupport] list failed", {
      consumerId: String(req.consumer?.id),
      err,
    });
    return res.status(500).json({ ok: false, error: "Could not load your requests" });
  }
});

export default router;
