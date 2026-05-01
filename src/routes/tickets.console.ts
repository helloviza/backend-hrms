import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import Ticket from "../models/Ticket.js";
import TicketMessage from "../models/TicketMessage.js";
import TicketLead from "../models/TicketLead.js";
import TicketAttachment from "../models/TicketAttachment.js";
import User from "../models/User.js";
import { sendReply } from "../services/gmail.js";
import logger from "../utils/logger.js";

const router = express.Router();

router.use(requireAuth);
router.use((req, res, next) => {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ success: false, error: "SUPERADMIN access required" });
  }
  next();
});

/* ── GET / — list tickets with filters ────────────────────────── */
router.get("/", async (req, res) => {
  try {
    const { status, priority, assignedTo, search, scope, page = 1, limit = 25, sort = "-createdAt" } = req.query;
    const userId = (req as any).user?._id || (req as any).user?.id;

    const filter: Record<string, any> = {};
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    if (scope === "my") filter.assignedTo = userId;
    else if (scope === "unassigned") filter.assignedTo = null;

    if (assignedTo && scope !== "my" && scope !== "unassigned") {
      filter.assignedTo = assignedTo;
    }

    if (search) {
      const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ subject: re }, { fromName: re }, { fromEmail: re }, { ticketRef: re }];
    }

    const pg = Math.max(1, Number(page));
    const lim = Math.min(100, Math.max(1, Number(limit)));
    const skip = (pg - 1) * lim;

    const [items, total] = await Promise.all([
      Ticket.find(filter)
        .sort(sort as string)
        .skip(skip)
        .limit(lim)
        .populate("assignedTo", "name email")
        .lean(),
      Ticket.countDocuments(filter),
    ]);

    return res.json({ success: true, items, total, page: pg, totalPages: Math.ceil(total / lim) });
  } catch (err) {
    logger.error("[TicketsConsole] list error", { err });
    return res.status(500).json({ success: false, error: "Failed to list tickets" });
  }
});

/* ── SLA helpers ────────────────────────────────────────────────── */
function formatSlaCountdown(remaining: number): string {
  if (remaining < 0) {
    const overdue = Math.abs(remaining);
    if (overdue < 60) return `Breached ${Math.round(overdue)}m ago`;
    const h = Math.floor(overdue / 60);
    const m = Math.round(overdue % 60);
    return m > 0 ? `Breached ${h}h ${m}m ago` : `Breached ${h}h ago`;
  }
  if (remaining < 60) return `${Math.round(remaining)} min left`;
  const h = Math.floor(remaining / 60);
  const m = Math.round(remaining % 60);
  return m > 0 ? `${h}h ${m}m left` : `${h}h left`;
}

function computeSlaInfo(ticket: any, now: Date): {
  slaState: "OK" | "AT_RISK" | "BREACHING" | "BREACHED";
  slaCountdown: string;
  slaWhich: "first_response" | "resolution" | "none";
  remainingMin: number;
} {
  if (ticket.status === "CLOSED") {
    return { slaState: "OK", slaCountdown: "Closed", slaWhich: "none", remainingMin: Infinity };
  }
  const elapsed = (now.getTime() - new Date(ticket.createdAt).getTime()) / 60000;

  if (!ticket.firstResponseAt) {
    const remaining = 30 - elapsed;
    const slaCountdown = formatSlaCountdown(remaining);
    if (remaining < 0)   return { slaState: "BREACHED",  slaCountdown, slaWhich: "first_response", remainingMin: remaining };
    if (remaining < 7.5) return { slaState: "BREACHING", slaCountdown, slaWhich: "first_response", remainingMin: remaining };
    if (remaining < 15)  return { slaState: "AT_RISK",   slaCountdown, slaWhich: "first_response", remainingMin: remaining };
    return { slaState: "OK", slaCountdown, slaWhich: "first_response", remainingMin: remaining };
  } else {
    const remaining = 480 - elapsed;
    const slaCountdown = formatSlaCountdown(remaining);
    if (remaining < 0)    return { slaState: "BREACHED",  slaCountdown, slaWhich: "resolution", remainingMin: remaining };
    if (remaining < 120)  return { slaState: "BREACHING", slaCountdown, slaWhich: "resolution", remainingMin: remaining };
    if (remaining < 240)  return { slaState: "AT_RISK",   slaCountdown, slaWhich: "resolution", remainingMin: remaining };
    return { slaState: "OK", slaCountdown, slaWhich: "resolution", remainingMin: remaining };
  }
}

/* ── GET /dashboard — operational triage (must be before /:id) ── */
router.get("/dashboard", async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay   = new Date(startOfDay.getTime() + 86_400_000);
    const sevenDaysAgo  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyMinAgo  = new Date(now.getTime() - 30 * 60 * 1000);

    // All open tickets with assignedTo populated
    const openTickets = await Ticket.find({ status: { $ne: "CLOSED" } })
      .populate("assignedTo", "name email")
      .lean();

    // Compute SLA state for every open ticket
    const ticketsWithSla = openTickets.map((t) => ({ ...t, ...computeSlaInfo(t, now) }));

    // Headline
    const slaAtRisk       = ticketsWithSla.filter((t) => t.slaState === "AT_RISK" || t.slaState === "BREACHING").length;
    const slaBreached     = ticketsWithSla.filter((t) => t.slaState === "BREACHED").length;
    const unassignedCount = ticketsWithSla.filter((t) => !(t as any).assignedTo).length;

    // awaitingAgent: open tickets whose most recent message is INBOUND and arrived > 30 min ago
    const openIds = openTickets.map((t) => (t as any)._id);
    const awaitingRows = await TicketMessage.aggregate([
      { $match: { ticketId: { $in: openIds } } },
      { $sort: { sentAt: -1, createdAt: -1 } },
      { $group: { _id: "$ticketId", direction: { $first: "$direction" }, sentAt: { $first: "$sentAt" } } },
      { $match: { direction: "INBOUND", sentAt: { $lt: thirtyMinAgo } } },
    ]);
    const awaitingAgentCount = awaitingRows.length;

    // SLA queue: top 10 sorted by urgency (lowest remainingMin first = most overdue/urgent)
    const slaQueue = [...ticketsWithSla]
      .sort((a, b) => a.remainingMin - b.remainingMin)
      .slice(0, 10)
      .map((t) => ({
        _id:            (t as any)._id,
        ticketRef:      t.ticketRef,
        subject:        t.subject,
        fromEmail:      t.fromEmail,
        fromName:       t.fromName,
        status:         t.status,
        priority:       t.priority,
        createdAt:      t.createdAt,
        firstResponseAt: t.firstResponseAt ?? null,
        slaState:       t.slaState,
        slaCountdown:   t.slaCountdown,
        slaWhich:       t.slaWhich,
        assignedTo:     (t as any).assignedTo ?? null,
      }));

    // Unassigned queue: top 10 oldest unassigned open tickets
    const unassignedQueue = openTickets
      .filter((t) => !(t as any).assignedTo)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 10)
      .map((t) => ({
        _id:                  (t as any)._id,
        ticketRef:            t.ticketRef,
        subject:              t.subject,
        fromEmail:            t.fromEmail,
        fromName:             t.fromName,
        createdAt:            t.createdAt,
        waitingMinutes:       Math.round((now.getTime() - new Date(t.createdAt).getTime()) / 60000),
        priority:             t.priority,
        extractedRequestType: (t.extractedFields as any)?.requestType ?? null,
      }));

    // Agent load: all staff users, include those with 0 open tickets
    const agents = await User.find(
      { roles: { $in: ["SUPERADMIN", "ADMIN", "HR", "OPS"] } },
      "name email",
    ).lean();

    const agentLoad = await Promise.all(
      (agents as any[]).map(async (a) => {
        const idStr = a._id.toString();
        const openAssigned = openTickets.filter(
          (t) => (t as any).assignedTo && (t as any).assignedTo._id?.toString() === idStr,
        ).length;

        const [closedToday, respondedTickets] = await Promise.all([
          Ticket.countDocuments({ assignedTo: a._id, closedAt: { $gte: startOfDay, $lt: endOfDay } }),
          Ticket.find(
            { assignedTo: a._id, firstResponseAt: { $exists: true, $ne: null }, createdAt: { $gte: sevenDaysAgo } },
            "firstResponseAt createdAt",
          ).lean(),
        ]);

        const avgFirstResponseMin =
          respondedTickets.length === 0
            ? null
            : Math.round(
                respondedTickets.reduce(
                  (sum, t) =>
                    sum +
                    ((t as any).firstResponseAt.getTime() - new Date((t as any).createdAt).getTime()) / 60000,
                  0,
                ) / respondedTickets.length,
              );

        const capacityState: "AVAILABLE" | "STRETCHED" | "OVERLOADED" =
          openAssigned < 3 ? "AVAILABLE" : openAssigned <= 8 ? "STRETCHED" : "OVERLOADED";

        return { userId: a._id, name: a.name, email: a.email, openAssigned, closedToday, capacityState, avgFirstResponseMin };
      }),
    );

    const capOrder: Record<string, number> = { OVERLOADED: 0, STRETCHED: 1, AVAILABLE: 2 };
    agentLoad.sort(
      (a, b) => capOrder[a.capacityState] - capOrder[b.capacityState] || b.openAssigned - a.openAssigned,
    );

    return res.json({
      success: true,
      headline: { slaAtRisk, slaBreached, unassignedCount, awaitingAgentCount },
      slaQueue,
      unassignedQueue,
      agentLoad,
    });
  } catch (err) {
    logger.error("[TicketsConsole] dashboard error", { err });
    return res.status(500).json({ success: false, error: "Failed to load dashboard" });
  }
});

/* ── GET /users — admin users for assign dropdown (must be before /:id) ── */
router.get("/users", async (req, res) => {
  try {
    const users = await User.find(
      { roles: { $in: ["SUPERADMIN", "ADMIN", "HR", "OPS"] } },
      "name email roles",
    ).lean();
    return res.json({ success: true, users });
  } catch (err) {
    logger.error("[TicketsConsole] users list error", { err });
    return res.status(500).json({ success: false, error: "Failed to list users" });
  }
});

/* ── GET /:id — ticket detail with messages ─────────────────────── */
router.get("/:id", async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id)
      .populate("assignedTo", "name email")
      .lean();
    if (!ticket) return res.status(404).json({ success: false, error: "Ticket not found" });

    const [messages, lead, attachments] = await Promise.all([
      TicketMessage.find({ ticketId: ticket._id })
        .populate("sentBy", "name email")
        .sort({ createdAt: 1 })
        .lean(),
      (ticket as any).leadId ? TicketLead.findById((ticket as any).leadId).lean() : null,
      TicketAttachment.find({ ticketId: ticket._id }).lean(),
    ]);

    return res.json({ success: true, ticket, messages, lead, attachments });
  } catch (err) {
    logger.error("[TicketsConsole] getById error", { err });
    return res.status(500).json({ success: false, error: "Failed to load ticket" });
  }
});

/* ── POST /:id/reply — send reply or internal note ──────────────── */
router.post("/:id/reply", async (req, res) => {
  try {
    const { bodyHtml, isInternalNote } = req.body;
    const userId = (req as any).user?._id || (req as any).user?.id;
    const userEmail = (req as any).user?.email || "";

    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, error: "Ticket not found" });

    if (isInternalNote) {
      const msg = await TicketMessage.create({
        ticketId: ticket._id,
        direction: "OUTBOUND",
        channel: "SYSTEM",
        fromEmail: userEmail,
        toEmail: [],
        subject: ticket.subject,
        bodyHtml: bodyHtml || "",
        bodyText: "",
        sentBy: userId,
        sentAt: new Date(),
        deliveryStatus: "SENT",
      });
      const populated = await TicketMessage.findById(msg._id).populate("sentBy", "name email").lean();
      return res.json({ success: true, message: populated, ticket });
    }

    const lastInbound = await TicketMessage.findOne({
      ticketId: ticket._id,
      direction: "INBOUND",
    }).sort({ createdAt: -1 });

    const inReplyTo = lastInbound?.gmailMessageId || "";

    let gmailMessageId = "";
    if (ticket.gmailThreadId && inReplyTo) {
      const result = await sendReply(
        ticket.gmailThreadId,
        inReplyTo,
        ticket.fromEmail,
        ticket.subject,
        bodyHtml || "",
      );
      gmailMessageId = result.messageId;
    } else {
      logger.warn("[TicketsConsole] No threadId/inReplyTo — skipping Gmail send", {
        ticketId: ticket._id, threadId: ticket.gmailThreadId, inReplyTo,
      });
    }

    const msg = await TicketMessage.create({
      ticketId: ticket._id,
      direction: "OUTBOUND",
      channel: "EMAIL",
      fromEmail: userEmail,
      toEmail: [ticket.fromEmail],
      subject: ticket.subject,
      bodyHtml: bodyHtml || "",
      bodyText: "",
      gmailMessageId: gmailMessageId || undefined,
      gmailThreadId: ticket.gmailThreadId,
      inReplyTo: inReplyTo || undefined,
      sentBy: userId,
      sentAt: new Date(),
      deliveryStatus: "SENT",
    });

    if (!ticket.firstResponseAt) {
      ticket.firstResponseAt = new Date();
      await ticket.save();
    }

    const populated = await TicketMessage.findById(msg._id).populate("sentBy", "name email").lean();
    return res.json({ success: true, message: populated, ticket });
  } catch (err) {
    logger.error("[TicketsConsole] reply error", { err });
    return res.status(500).json({ success: false, error: "Failed to send reply" });
  }
});

/* ── PATCH /:id/status — change ticket status ─────────────────── */
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const userId = (req as any).user?._id || (req as any).user?.id;
    const userEmail = (req as any).user?.email || "";

    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, error: "Ticket not found" });

    const prevStatus = ticket.status;
    ticket.status = status;
    if (status === "CLOSED") ticket.closedAt = new Date();
    await ticket.save();

    const noteText = `Status changed: ${prevStatus} → ${status}`;
    await TicketMessage.create({
      ticketId: ticket._id,
      direction: "OUTBOUND",
      channel: "SYSTEM",
      fromEmail: userEmail,
      toEmail: [],
      subject: ticket.subject,
      bodyHtml: noteText,
      bodyText: noteText,
      sentBy: userId,
      sentAt: new Date(),
      deliveryStatus: "SENT",
    });

    return res.json({ success: true, ticket });
  } catch (err) {
    logger.error("[TicketsConsole] status update error", { err });
    return res.status(500).json({ success: false, error: "Failed to update status" });
  }
});

/* ── PATCH /:id/assign — assign ticket to user ───────────────── */
router.patch("/:id/assign", async (req, res) => {
  try {
    const { userId: assignUserId } = req.body;
    const actorId = (req as any).user?._id || (req as any).user?.id;
    const actorEmail = (req as any).user?.email || "";

    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, error: "Ticket not found" });

    ticket.assignedTo = assignUserId || undefined;
    await ticket.save();

    const assignedUser = assignUserId
      ? await User.findById(assignUserId, "name email").lean()
      : null;
    const noteText = assignUserId
      ? `Assigned to ${(assignedUser as any)?.name || assignUserId}`
      : "Unassigned";

    await TicketMessage.create({
      ticketId: ticket._id,
      direction: "OUTBOUND",
      channel: "SYSTEM",
      fromEmail: actorEmail,
      toEmail: [],
      subject: ticket.subject,
      bodyHtml: noteText,
      bodyText: noteText,
      sentBy: actorId,
      sentAt: new Date(),
      deliveryStatus: "SENT",
    });

    await ticket.populate("assignedTo", "name email");
    return res.json({ success: true, ticket });
  } catch (err) {
    logger.error("[TicketsConsole] assign error", { err });
    return res.status(500).json({ success: false, error: "Failed to assign ticket" });
  }
});

/* ── PATCH /:id/tags — update tags ─────────────────────────── */
router.patch("/:id/tags", async (req, res) => {
  try {
    const { tags } = req.body;
    const ticket = await Ticket.findByIdAndUpdate(
      req.params.id,
      { tags: Array.isArray(tags) ? tags : [] },
      { new: true },
    ).populate("assignedTo", "name email");

    if (!ticket) return res.status(404).json({ success: false, error: "Ticket not found" });
    return res.json({ success: true, ticket });
  } catch (err) {
    logger.error("[TicketsConsole] tags update error", { err });
    return res.status(500).json({ success: false, error: "Failed to update tags" });
  }
});

export default router;
