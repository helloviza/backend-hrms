import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import CRMContact from "../models/CRMContact.js";
import CRMCompany from "../models/CRMCompany.js";
import Lead from "../models/Lead.js";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCRMAccess } from "../utils/crmAccess.js";
import { triggerTaskAutomation } from "../services/taskAutomation.js";
import { SYSTEM_WORKSPACE_ID } from "../config/defaultTaskAutomations.js";
import logger from "../utils/logger.js";

const router = express.Router();
type AnyObj = Record<string, any>;

function userId(user: AnyObj): string {
  return String(user.id || user.sub || "");
}

function canWrite(access: string): boolean {
  return access === "WRITE" || access === "FULL";
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d as any);
  if (isNaN(dt.getTime())) return "";
  return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
}

router.use(requireAuth);
router.use(requireCRMAccess("crmContacts"));

// ═══════════════════════════════════════════════════════════════
// POST / — create contact
// ═══════════════════════════════════════════════════════════════

router.post("/", async (req, res) => {
  try {
    if (!canWrite((req as any).crmAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }

    const user = (req as any).user as AnyObj;
    const body = req.body as AnyObj;

    if (!body.firstName || !body.jobTitle || !body.phone) {
      return res.status(400).json({ error: "firstName, jobTitle and phone are required." });
    }

    let companyName = body.companyName || "";
    if (body.companyId && mongoose.isValidObjectId(String(body.companyId))) {
      const co = (await CRMCompany.findById(body.companyId).select("name").lean()) as any;
      if (co) companyName = co.name || companyName;
    }

    const contact = await CRMContact.create({
      ...body,
      companyName,
      createdBy: mongoose.isValidObjectId(userId(user))
        ? new mongoose.Types.ObjectId(userId(user))
        : undefined,
    });

    // Task automation hook
    triggerTaskAutomation("contact.created", {
      workspaceId: SYSTEM_WORKSPACE_ID,
      entityType: "CONTACT",
      entityId: contact._id as mongoose.Types.ObjectId,
      entityRef: String(contact._id),
      ownerId: mongoose.isValidObjectId(userId(user))
        ? new mongoose.Types.ObjectId(userId(user))
        : undefined,
      variables: {
        contactName: `${body.firstName || ""} ${body.lastName || ""}`.trim() || "Contact",
      },
    }).catch(() => {});

    return res.status(201).json({ contact });
  } catch (err) {
    logger.error("crm.contacts POST / error", { err });
    return res.status(500).json({ error: "Failed to create contact." });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /export — XLSX (must be before /:id)
// ═══════════════════════════════════════════════════════════════

router.get("/export", async (req, res) => {
  try {
    const user = (req as any).user as AnyObj;
    const crmScope = (req as any).crmScope as string;
    const crmAccess = (req as any).crmAccess as string;
    const conditions: AnyObj[] = [];
    const uid = userId(user);
    const uidObjId = mongoose.isValidObjectId(uid) ? new mongoose.Types.ObjectId(uid) : null;
    const isFullAdmin = crmAccess === "FULL" && crmScope === "ALL";

    if (crmScope === "OWN" && uidObjId) {
      conditions.push({ $or: [{ assignedTo: uidObjId }, { createdBy: uidObjId }] });
    } else if (!isFullAdmin) {
      const visOr: AnyObj[] = [{ isPrivate: false }];
      if (uidObjId) visOr.push({ createdBy: uidObjId });
      conditions.push({ $or: visOr });
    }

    const filter = conditions.length > 0 ? { $and: conditions } : {};
    const contacts = await CRMContact.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const exportAssignedIds = contacts
      .map((c: any) => c.assignedTo?.toString())
      .filter(Boolean) as string[];

    const exportAssignedUsers =
      exportAssignedIds.length > 0
        ? ((await User.find({ _id: { $in: exportAssignedIds } })
            .select("_id name firstName lastName email")
            .lean()) as any[])
        : [];

    const exportUserMap = new Map<string, string>(
      exportAssignedUsers.map((u: any) => [
        u._id.toString(),
        u.name ||
          `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
          u.email ||
          "",
      ])
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Contacts");
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const columns = [
      "Contact Code", "First Name", "Last Name", "Job Title",
      "Company", "Phone", "Email", "City", "Country",
      "Source", "Status", "Assigned To", "Tags", "Lead Source", "Created At",
    ];

    const headerRow = sheet.addRow(columns);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } };
    headerRow.alignment = { vertical: "middle" };

    const colWidths = [14, 16, 16, 20, 22, 16, 24, 14, 14, 12, 16, 16, 20, 12, 18];
    colWidths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

    for (const c of contacts as any[]) {
      sheet.addRow([
        c.contactCode || "",
        c.firstName || "",
        c.lastName || "",
        c.jobTitle || "",
        c.companyName || "",
        c.phone || "",
        c.email || "",
        c.city || "",
        c.country || "",
        c.source || "",
        c.status || "",
        c.assignedTo ? exportUserMap.get(c.assignedTo.toString()) || "" : "",
        (c.tags || []).join(", "),
        c.source || "",
        fmtDate(c.createdAt),
      ]);
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="contacts-export.xlsx"');
    await workbook.xlsx.write(res as any);
    res.end();
  } catch (err) {
    logger.error("crm.contacts GET /export error", { err });
    return res.status(500).json({ error: "Export failed." });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET / — list contacts
// ═══════════════════════════════════════════════════════════════

router.get("/", async (req, res) => {
  try {
    const user = (req as any).user as AnyObj;
    const crmScope = (req as any).crmScope as string;
    const crmAccess = (req as any).crmAccess as string;
    const q = req.query as AnyObj;
    const conditions: AnyObj[] = [];
    const uid = userId(user);
    const uidObjId = mongoose.isValidObjectId(uid) ? new mongoose.Types.ObjectId(uid) : null;
    const isFullAdmin = crmAccess === "FULL" && crmScope === "ALL";

    if (crmScope === "OWN" && uidObjId) {
      conditions.push({ $or: [{ assignedTo: uidObjId }, { createdBy: uidObjId }] });
    } else if (!isFullAdmin) {
      const visOr: AnyObj[] = [{ isPrivate: false }];
      if (uidObjId) visOr.push({ createdBy: uidObjId });
      conditions.push({ $or: visOr });
    }

    if (q.search) {
      const re = new RegExp(String(q.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      conditions.push({
        $or: [
          { firstName: re },
          { lastName: re },
          { phone: re },
          { email: re },
          { companyName: re },
        ],
      });
    }

    if (q.companyId && mongoose.isValidObjectId(String(q.companyId))) {
      conditions.push({ companyId: new mongoose.Types.ObjectId(String(q.companyId)) });
    }

    if (q.assignedTo && mongoose.isValidObjectId(String(q.assignedTo))) {
      conditions.push({ assignedTo: new mongoose.Types.ObjectId(String(q.assignedTo)) });
    }

    if (q.status) conditions.push({ status: String(q.status) });

    const filter = conditions.length > 0 ? { $and: conditions } : {};

    const page = Math.max(1, parseInt(String(q.page || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || "20"), 10)));
    const skip = (page - 1) * limit;

    const [contacts, total] = await Promise.all([
      CRMContact.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CRMContact.countDocuments(filter),
    ]);

    const assignedIds = contacts
      .map((c: any) => c.assignedTo?.toString())
      .filter(Boolean) as string[];

    const assignedUsers =
      assignedIds.length > 0
        ? ((await User.find({ _id: { $in: assignedIds } })
            .select("_id name firstName lastName email")
            .lean()) as any[])
        : [];

    const userMap = new Map<string, string>(
      assignedUsers.map((u: any) => [
        u._id.toString(),
        u.name ||
          `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
          u.email ||
          "",
      ])
    );

    const enriched = contacts.map((c: any) => ({
      ...c,
      assignedToName: c.assignedTo ? userMap.get(c.assignedTo.toString()) || "" : "",
    }));

    return res.json({ contacts: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error("crm.contacts GET / error", { err });
    return res.status(500).json({ error: "Failed to list contacts." });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /:id — single contact + linked lead
// ═══════════════════════════════════════════════════════════════

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid contact ID." });
    }

    const contact = await CRMContact.findById(req.params.id).lean();
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    let linkedLead = null;
    if (contact.leadId) {
      linkedLead = await Lead.findById(contact.leadId)
        .select("leadCode contactName companyName stage source dealValue assignedToName")
        .lean();
    }

    let assignedToName = "";
    if (contact.assignedTo) {
      const assignedUser = (await User.findById(contact.assignedTo)
        .select("name firstName lastName email")
        .lean()) as any;
      if (assignedUser) {
        assignedToName =
          assignedUser.name ||
          `${assignedUser.firstName || ""} ${assignedUser.lastName || ""}`.trim() ||
          assignedUser.email ||
          "";
      }
    }

    return res.json({ contact: { ...(contact as any), assignedToName }, linkedLead });
  } catch (err) {
    logger.error("crm.contacts GET /:id error", { err });
    return res.status(500).json({ error: "Failed to get contact." });
  }
});

// ═══════════════════════════════════════════════════════════════
// PUT /:id — update contact
// ═══════════════════════════════════════════════════════════════

router.put("/:id", async (req, res) => {
  try {
    if (!canWrite((req as any).crmAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid contact ID." });
    }

    const contact = await CRMContact.findById(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    const user = (req as any).user as AnyObj;
    const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
    const isAdmin = roles.includes("ADMIN") || roles.includes("SUPERADMIN");

    if (!isAdmin && String(contact.createdBy) !== userId(user)) {
      return res.status(403).json({ error: "Only the creator or admin can edit this contact." });
    }

    const PROTECTED = new Set(["_id", "contactCode", "createdBy", "createdAt", "leadId"]);
    const body = req.body as AnyObj;

    for (const key of Object.keys(body)) {
      if (!PROTECTED.has(key)) {
        (contact as any)[key] = body[key];
      }
    }

    // Re-fetch companyName if companyId changed
    if (body.companyId && mongoose.isValidObjectId(String(body.companyId))) {
      const co = (await CRMCompany.findById(body.companyId).select("name").lean()) as any;
      if (co) contact.companyName = co.name || contact.companyName;
    }

    await contact.save();
    return res.json({ contact });
  } catch (err) {
    logger.error("crm.contacts PUT /:id error", { err });
    return res.status(500).json({ error: "Failed to update contact." });
  }
});

// ═══════════════════════════════════════════════════════════════
// DELETE /:id — admin only
// ═══════════════════════════════════════════════════════════════

router.delete("/:id", async (req, res) => {
  try {
    const user = (req as any).user as AnyObj;
    const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
    if (!roles.includes("ADMIN") && !roles.includes("SUPERADMIN")) {
      return res.status(403).json({ error: "Admin role required to delete contacts." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid contact ID." });
    }

    const contact = await CRMContact.findById(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    await CRMContact.deleteOne({ _id: contact._id });
    return res.json({ success: true });
  } catch (err) {
    logger.error("crm.contacts DELETE /:id error", { err });
    return res.status(500).json({ error: "Failed to delete contact." });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /:id/assign — admin only
// ═══════════════════════════════════════════════════════════════

router.post("/:id/assign", async (req, res) => {
  try {
    const user = (req as any).user as AnyObj;
    const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
    if (!roles.includes("ADMIN") && !roles.includes("SUPERADMIN")) {
      return res.status(403).json({ error: "Admin role required to assign contacts." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid contact ID." });
    }

    const { userId: repId } = req.body as AnyObj;
    if (!repId || !mongoose.isValidObjectId(String(repId))) {
      return res.status(400).json({ error: "Valid userId is required." });
    }

    const rep = (await User.findById(repId).select("name").lean()) as any;
    if (!rep) return res.status(404).json({ error: "User not found." });

    const contact = await CRMContact.findById(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found." });

    contact.assignedTo = new mongoose.Types.ObjectId(String(repId));
    const prevNote = contact.notes || "";
    contact.notes = prevNote.length > 0
      ? `${prevNote}\n[Assigned to ${rep.name || repId}]`
      : `[Assigned to ${rep.name || repId}]`;

    await contact.save();
    return res.json({ contact });
  } catch (err) {
    logger.error("crm.contacts POST /:id/assign error", { err });
    return res.status(500).json({ error: "Failed to assign contact." });
  }
});

export default router;
