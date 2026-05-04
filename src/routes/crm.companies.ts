import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import CRMCompany from "../models/CRMCompany.js";
import CRMContact from "../models/CRMContact.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCRMAccess } from "../utils/crmAccess.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
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
router.use(requireCRMAccess("crmCompanies"));
router.use(requireWorkspace);

// ═══════════════════════════════════════════════════════════════
// POST / — create company
// ═══════════════════════════════════════════════════════════════

router.post("/", async (req, res) => {
  try {
    if (!canWrite((req as any).crmAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }

    const user = (req as any).user as AnyObj;
    const body = req.body as AnyObj;

    if (!body.name) {
      return res.status(400).json({ error: "name is required." });
    }

    const company = await CRMCompany.create({
      ...body,
      createdBy: mongoose.isValidObjectId(userId(user))
        ? new mongoose.Types.ObjectId(userId(user))
        : undefined,
    });

    return res.status(201).json({ company });
  } catch (err) {
    logger.error("crm.companies POST / error", { err });
    return res.status(500).json({ error: "Failed to create company." });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /export — XLSX (must be before /:id)
// ═══════════════════════════════════════════════════════════════

router.get("/export", async (req, res) => {
  try {
    const user = (req as any).user as AnyObj;
    const crmScope = (req as any).crmScope as string;
    const conditions: AnyObj[] = [];

    if (crmScope === "OWN") {
      const uid = userId(user);
      if (mongoose.isValidObjectId(uid)) {
        conditions.push({ createdBy: new mongoose.Types.ObjectId(uid) });
      }
    }

    const filter = conditions.length > 0 ? { $and: conditions } : {};
    // TODO(T-015): CRMCompany lacks workspaceId stamp — defense-in-depth only
    if ((req as any).workspaceObjectId) Object.assign(filter, { workspaceId: (req as any).workspaceObjectId });
    const companies = await CRMCompany.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Companies");
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const columns = [
      "Company Code", "Name", "Industry", "Size", "City",
      "Country", "Phone", "Email", "Website", "Contact Count",
      "Created At", "Notes",
    ];

    const headerRow = sheet.addRow(columns);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } };
    headerRow.alignment = { vertical: "middle" };

    const colWidths = [14, 24, 18, 10, 16, 16, 16, 24, 22, 13, 18, 30];
    colWidths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

    for (const c of companies as any[]) {
      sheet.addRow([
        c.companyCode || "",
        c.name || "",
        c.industry || "",
        c.companySize || "",
        c.city || "",
        c.country || "",
        c.phone || "",
        c.email || "",
        c.website || "",
        c.contactCount || 0,
        fmtDate(c.createdAt),
        c.notes || "",
      ]);
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="companies-export.xlsx"');
    await workbook.xlsx.write(res as any);
    res.end();
  } catch (err) {
    logger.error("crm.companies GET /export error", { err });
    return res.status(500).json({ error: "Export failed." });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET / — list companies
// ═══════════════════════════════════════════════════════════════

router.get("/", async (req, res) => {
  try {
    const user = (req as any).user as AnyObj;
    const crmScope = (req as any).crmScope as string;
    const q = req.query as AnyObj;
    const conditions: AnyObj[] = [];
    const uid = userId(user);

    if (crmScope === "OWN") {
      if (mongoose.isValidObjectId(uid)) {
        conditions.push({ createdBy: new mongoose.Types.ObjectId(uid) });
      }
    } else {
      const scopeOr: AnyObj[] = [{ isPrivate: false }];
      if (mongoose.isValidObjectId(uid)) scopeOr.push({ createdBy: new mongoose.Types.ObjectId(uid) });
      conditions.push({ $or: scopeOr });
    }

    if (q.search) {
      const re = new RegExp(String(q.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      conditions.push({ name: re });
    }

    if (q.industry) conditions.push({ industry: String(q.industry) });

    const filter = conditions.length > 0 ? { $and: conditions } : {};
    // TODO(T-015): CRMCompany lacks workspaceId stamp — defense-in-depth only
    if ((req as any).workspaceObjectId) Object.assign(filter, { workspaceId: (req as any).workspaceObjectId });

    const page = Math.max(1, parseInt(String(q.page || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || "20"), 10)));
    const skip = (page - 1) * limit;

    const [companies, total] = await Promise.all([
      CRMCompany.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CRMCompany.countDocuments(filter),
    ]);

    return res.json({ companies, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error("crm.companies GET / error", { err });
    return res.status(500).json({ error: "Failed to list companies." });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /:id — single company + linked contacts
// ═══════════════════════════════════════════════════════════════

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid company ID." });
    }

    // TODO(T-015): CRMCompany lacks workspaceId stamp — defense-in-depth only
    const company = await CRMCompany.findOne({
      _id: req.params.id,
      ...((req as any).workspaceObjectId && { workspaceId: (req as any).workspaceObjectId }),
    }).lean();
    if (!company) return res.status(404).json({ error: "Company not found." });

    const contacts = await CRMContact.find({ companyId: company._id })
      .select("firstName lastName jobTitle phone email")
      .lean();

    return res.json({ company, contacts });
  } catch (err) {
    logger.error("crm.companies GET /:id error", { err });
    return res.status(500).json({ error: "Failed to get company." });
  }
});

// ═══════════════════════════════════════════════════════════════
// PUT /:id — update company
// ═══════════════════════════════════════════════════════════════

router.put("/:id", async (req, res) => {
  try {
    if (!canWrite((req as any).crmAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid company ID." });
    }

    // TODO(T-015): CRMCompany lacks workspaceId stamp — defense-in-depth only
    const company = await CRMCompany.findOne({
      _id: req.params.id,
      ...((req as any).workspaceObjectId && { workspaceId: (req as any).workspaceObjectId }),
    });
    if (!company) return res.status(404).json({ error: "Company not found." });

    const user = (req as any).user as AnyObj;
    const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
    const isAdmin = roles.includes("ADMIN") || roles.includes("SUPERADMIN");

    if (!isAdmin && String(company.createdBy) !== userId(user)) {
      return res.status(403).json({ error: "Only the creator or admin can edit this company." });
    }

    const PROTECTED = new Set(["_id", "companyCode", "createdBy", "createdAt"]);
    const body = req.body as AnyObj;
    for (const key of Object.keys(body)) {
      if (!PROTECTED.has(key)) {
        (company as any)[key] = body[key];
      }
    }

    await company.save();
    return res.json({ company });
  } catch (err) {
    logger.error("crm.companies PUT /:id error", { err });
    return res.status(500).json({ error: "Failed to update company." });
  }
});

// ═══════════════════════════════════════════════════════════════
// DELETE /:id — admin only; nullifies companyId on linked contacts
// ═══════════════════════════════════════════════════════════════

router.delete("/:id", async (req, res) => {
  try {
    const user = (req as any).user as AnyObj;
    const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
    if (!roles.includes("ADMIN") && !roles.includes("SUPERADMIN")) {
      return res.status(403).json({ error: "Admin role required to delete companies." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid company ID." });
    }

    // TODO(T-015): CRMCompany lacks workspaceId stamp — defense-in-depth only
    const company = await CRMCompany.findOne({
      _id: req.params.id,
      ...((req as any).workspaceObjectId && { workspaceId: (req as any).workspaceObjectId }),
    });
    if (!company) return res.status(404).json({ error: "Company not found." });

    await Promise.all([
      CRMCompany.deleteOne({ _id: company._id }),
      CRMContact.updateMany({ companyId: company._id }, { $set: { companyId: null } }),
    ]);

    return res.json({ success: true });
  } catch (err) {
    logger.error("crm.companies DELETE /:id error", { err });
    return res.status(500).json({ error: "Failed to delete company." });
  }
});

export default router;
