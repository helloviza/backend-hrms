import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requirePermission } from "../middleware/requirePermission.js";
import EmailTemplate from "../models/EmailTemplate.js";
import Ticket from "../models/Ticket.js";
import TicketLead from "../models/TicketLead.js";
import { renderTemplate } from "../utils/templateVariables.js";
import logger from "../utils/logger.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireWorkspace);

/* ── GET / — list templates for workspace ──────────────────── */
router.get("/", requirePermission("supportTickets", "READ"), async (req, res) => {
  try {
    const wsId = req.workspaceObjectId;
    const filter: Record<string, any> = { workspaceId: wsId, isActive: true };
    if (req.query.category) filter.category = req.query.category;

    const templates = await EmailTemplate.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .sort({ category: 1, name: 1 })
      .lean();

    return res.json({ success: true, templates });
  } catch (err) {
    logger.error("[EmailTemplates] list error", { err });
    return res.status(500).json({ success: false, error: "Failed to list templates" });
  }
});

/* ── POST / — create template ──────────────────────────────── */
router.post("/", requirePermission("supportTickets", "FULL"), async (req, res) => {
  try {
    const userId = (req as any).user?._id || (req as any).user?.id;
    const wsId = req.workspaceObjectId;
    if (!wsId) {
      return res.status(400).json({ success: false, error: "workspaceId not resolved — pass x-workspace-id header" });
    }
    const { name, subject, bodyHtml, category, description } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, error: "Template name is required" });
    }

    const existing = await EmailTemplate.findOne({ workspaceId: wsId, name: name.trim() });
    if (existing) {
      return res.status(409).json({ success: false, error: "A template with that name already exists" });
    }

    const template = await EmailTemplate.create({
      workspaceId: wsId,
      name: name.trim(),
      subject: subject?.trim() || undefined,
      bodyHtml: bodyHtml || "",
      category: category?.trim() || undefined,
      description: description?.trim() || undefined,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    const populated = await EmailTemplate.findById(template._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .lean();

    return res.status(201).json({ success: true, template: populated });
  } catch (err) {
    logger.error("[EmailTemplates] create error", { err });
    return res.status(500).json({ success: false, error: "Failed to create template" });
  }
});

/* ── GET /:id — single template ────────────────────────────── */
router.get("/:id", requirePermission("supportTickets", "READ"), async (req, res) => {
  try {
    const wsId = req.workspaceObjectId;
    const template = await EmailTemplate.findOne({ _id: req.params.id, workspaceId: wsId })
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .lean();

    if (!template) return res.status(404).json({ success: false, error: "Template not found" });
    return res.json({ success: true, template });
  } catch (err) {
    logger.error("[EmailTemplates] getById error", { err });
    return res.status(500).json({ success: false, error: "Failed to load template" });
  }
});

/* ── PATCH /:id — update template ──────────────────────────── */
router.patch("/:id", requirePermission("supportTickets", "FULL"), async (req, res) => {
  try {
    const userId = (req as any).user?._id || (req as any).user?.id;
    const wsId = req.workspaceObjectId;
    const { name, subject, bodyHtml, category, description } = req.body;

    const template = await EmailTemplate.findOne({ _id: req.params.id, workspaceId: wsId });
    if (!template) return res.status(404).json({ success: false, error: "Template not found" });

    if (name?.trim() && name.trim() !== template.name) {
      const dupe = await EmailTemplate.findOne({ workspaceId: wsId, name: name.trim(), _id: { $ne: template._id } });
      if (dupe) return res.status(409).json({ success: false, error: "A template with that name already exists" });
      template.name = name.trim();
    }
    if (subject !== undefined) template.subject = subject?.trim() || undefined;
    if (bodyHtml !== undefined) template.bodyHtml = bodyHtml;
    if (category !== undefined) template.category = category?.trim() || undefined;
    if (description !== undefined) template.description = description?.trim() || undefined;
    template.updatedBy = userId;

    await template.save();

    const populated = await EmailTemplate.findById(template._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .lean();

    return res.json({ success: true, template: populated });
  } catch (err) {
    logger.error("[EmailTemplates] update error", { err });
    return res.status(500).json({ success: false, error: "Failed to update template" });
  }
});

/* ── DELETE /:id — soft delete ─────────────────────────────── */
router.delete("/:id", requirePermission("supportTickets", "FULL"), async (req, res) => {
  try {
    const wsId = req.workspaceObjectId;
    const template = await EmailTemplate.findOne({ _id: req.params.id, workspaceId: wsId });
    if (!template) return res.status(404).json({ success: false, error: "Template not found" });

    template.isActive = false;
    await template.save();

    return res.json({ success: true });
  } catch (err) {
    logger.error("[EmailTemplates] delete error", { err });
    return res.status(500).json({ success: false, error: "Failed to delete template" });
  }
});

/* ── POST /:id/render — resolve variables server-side ──────── */
router.post("/:id/render", requirePermission("supportTickets", "READ"), async (req, res) => {
  try {
    const wsId = req.workspaceObjectId;
    const user = (req as any).user;

    const template = await EmailTemplate.findOne({ _id: req.params.id, workspaceId: wsId, isActive: true }).lean();
    if (!template) return res.status(404).json({ success: false, error: "Template not found" });

    let customerName = "";
    let customerEmail = "";
    let ticketRef = "";
    let companyName = "";

    const { ticketId } = req.body;
    if (ticketId) {
      const ticket = await Ticket.findById(ticketId).lean();
      if (ticket) {
        customerName = ticket.fromName || ticket.fromEmail.split("@")[0];
        customerEmail = ticket.fromEmail;
        ticketRef = ticket.ticketRef;

        if ((ticket as any).leadId) {
          const lead = await TicketLead.findById((ticket as any).leadId).lean();
          if (lead) companyName = (lead as any).company || "";
        }
      }
    }

    const currentDate = new Date().toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });

    const context = {
      customerName,
      customerEmail,
      ticketRef,
      agentName: user?.name || "",
      agentEmail: user?.email || "",
      companyName,
      currentDate,
    };

    const renderedHtml = renderTemplate(template.bodyHtml, context);
    const renderedSubject = template.subject ? renderTemplate(template.subject, context) : undefined;

    return res.json({ success: true, renderedHtml, renderedSubject });
  } catch (err) {
    logger.error("[EmailTemplates] render error", { err });
    return res.status(500).json({ success: false, error: "Failed to render template" });
  }
});

export default router;
