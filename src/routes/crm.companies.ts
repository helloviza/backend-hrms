import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import CRMCompany, {
  ACCOUNT_TYPES,
  LIFECYCLE_STATUSES,
  ACCOUNT_TIERS,
} from "../models/CRMCompany.js";
import CRMContact from "../models/CRMContact.js";
import { requireAuth } from "../middleware/auth.js";
import { requireHouse } from "../middleware/requireHouse.js";
import { requireCRMAccess } from "../utils/crmAccess.js";
import { normalizeCompanyName } from "../utils/companyName.js";
import { isCrmV2FoundationEnabled } from "../config/crmV2.js";
import logger from "../utils/logger.js";

const router = express.Router();
type AnyObj = Record<string, any>;

// ── CRM_V2_FOUNDATION write path (Slice 1) ──────────────────────────
// Under the flag, POST / PUT stop spreading req.body into the document and
// go through this allow-list instead. Legacy fields keep their loose typing
// (the schema trims/casts them); the Company Account fields are validated
// against the model enums so a bad value is a 400, not a Mongoose 500.
const WRITABLE_LEGACY_FIELDS = [
  "name", "industry", "companySize", "website", "phone", "email",
  "city", "state", "country", "address", "notes", "isPrivate",
] as const;
// Account fields (accountType, lifecycleStatus, accountTier, accountManagerId,
// customerId, customerWorkspaceId) are handled explicitly below with validation.

type PickResult = { ok: boolean; data: AnyObj; error?: string };

function pickWritableFields(body: AnyObj): PickResult {
  const data: AnyObj = {};
  for (const k of WRITABLE_LEGACY_FIELDS) {
    if (k in body) data[k] = body[k];
  }
  if ("accountType" in body) {
    if (!(ACCOUNT_TYPES as readonly string[]).includes(body.accountType)) {
      return { ok: false, data, error: `accountType must be one of: ${ACCOUNT_TYPES.join(", ")}` };
    }
    data.accountType = body.accountType;
  }
  if ("lifecycleStatus" in body) {
    if (!(LIFECYCLE_STATUSES as readonly string[]).includes(body.lifecycleStatus)) {
      return { ok: false, data, error: `lifecycleStatus must be one of: ${LIFECYCLE_STATUSES.join(", ")}` };
    }
    data.lifecycleStatus = body.lifecycleStatus;
  }
  if ("accountTier" in body) {
    if (body.accountTier === null || body.accountTier === "") {
      data.accountTier = null;
    } else if (!(ACCOUNT_TIERS as readonly string[]).includes(body.accountTier)) {
      return { ok: false, data, error: `accountTier must be one of: ${ACCOUNT_TIERS.join(", ")} (or null)` };
    } else {
      data.accountTier = body.accountTier;
    }
  }
  for (const k of ["accountManagerId", "customerId"] as const) {
    if (k in body) {
      if (body[k] === null || body[k] === "") data[k] = null;
      else if (!mongoose.isValidObjectId(String(body[k]))) return { ok: false, data, error: `${k} must be a valid id or null` };
      else data[k] = new mongoose.Types.ObjectId(String(body[k]));
    }
  }
  if ("customerWorkspaceId" in body) {
    data.customerWorkspaceId =
      body.customerWorkspaceId === null || body.customerWorkspaceId === ""
        ? null
        : String(body.customerWorkspaceId).trim();
  }
  return { ok: true, data };
}

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
router.use(requireHouse); // CRM is a Plumtrips HOUSE-only product
router.use(requireCRMAccess("crmCompanies"));

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

    const createdBy = mongoose.isValidObjectId(userId(user))
      ? new mongoose.Types.ObjectId(userId(user))
      : undefined;

    // ── Legacy path (CRM_V2_FOUNDATION off): unchanged ──
    if (!isCrmV2FoundationEnabled()) {
      const company = await CRMCompany.create({ ...body, createdBy });
      return res.status(201).json({ company });
    }

    // ── CRM_V2_FOUNDATION path: allow-list + dedupe on nameNormalized ──
    // Manual create resolves the same way lead-side resolveOrCreateCompany
    // does: an existing company with the same key is RETURNED, not duplicated
    // and not rejected (M8 code half). The response distinguishes the two
    // outcomes — 201 for a fresh row, 200 + deduped:true for a collapse — and
    // never applies the submitted attributes to the existing row ($setOnInsert
    // semantics, mirrored here with a find-then-create).
    const picked = pickWritableFields(body);
    if (!picked.ok) return res.status(400).json({ error: picked.error });

    const nameNormalized = normalizeCompanyName(picked.data.name);
    if (!nameNormalized) {
      return res.status(400).json({ error: "name is required." });
    }

    const existing = await CRMCompany.findOne({ nameNormalized }).lean();
    if (existing) {
      return res.status(200).json({ company: existing, deduped: true });
    }

    try {
      const company = await CRMCompany.create({ ...picked.data, nameNormalized, createdBy });
      return res.status(201).json({ company });
    } catch (e: any) {
      // Lost the race against a concurrent create / lead resolve; the prod
      // unique+partial index on nameNormalized rejected the second insert.
      // Return the winner — same outcome as the findOne hit above.
      if (e?.code === 11000) {
        const winner = await CRMCompany.findOne({ nameNormalized }).lean();
        if (winner) return res.status(200).json({ company: winner, deduped: true });
      }
      throw e;
    }
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

    const page = Math.max(1, parseInt(String(q.page || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || "20"), 10)));
    const skip = (page - 1) * limit;

    const [companies, total] = await Promise.all([
      CRMCompany.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CRMCompany.countDocuments(filter),
    ]);

    // contactCount computed-on-read for this page only — one grouped aggregation
    // over the listed company ids; the stored field is never trusted.
    const companyIds = companies.map((c: any) => c._id);
    const countAgg = companyIds.length
      ? await CRMContact.aggregate([
          { $match: { companyId: { $in: companyIds } } },
          { $group: { _id: "$companyId", count: { $sum: 1 } } },
        ])
      : [];
    const countMap = new Map<string, number>(
      countAgg.map((r: any) => [String(r._id), r.count])
    );
    const withCounts = companies.map((c: any) => ({
      ...c,
      contactCount: countMap.get(String(c._id)) || 0,
    }));

    return res.json({ companies: withCounts, total, page, pages: Math.ceil(total / limit) });
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

    const company = await CRMCompany.findById(req.params.id).lean();
    if (!company) return res.status(404).json({ error: "Company not found." });

    const contacts = await CRMContact.find({ companyId: company._id })
      .select("firstName lastName jobTitle phone email")
      .lean();

    // contactCount is computed-on-read — the stored field is never trusted.
    const contactCount = await CRMContact.countDocuments({ companyId: company._id });

    return res.json({ company: { ...company, contactCount }, contacts });
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

    const company = await CRMCompany.findById(req.params.id);
    if (!company) return res.status(404).json({ error: "Company not found." });

    const user = (req as any).user as AnyObj;
    const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
    const isAdmin = roles.includes("ADMIN") || roles.includes("SUPERADMIN");

    if (!isAdmin && String(company.createdBy) !== userId(user)) {
      return res.status(403).json({ error: "Only the creator or admin can edit this company." });
    }

    const body = req.body as AnyObj;

    // ── Legacy path (CRM_V2_FOUNDATION off): unchanged ──
    if (!isCrmV2FoundationEnabled()) {
      const PROTECTED = new Set(["_id", "companyCode", "createdBy", "createdAt"]);
      for (const key of Object.keys(body)) {
        if (!PROTECTED.has(key)) {
          (company as any)[key] = body[key];
        }
      }
      await company.save();
      return res.json({ company });
    }

    // ── CRM_V2_FOUNDATION path: allow-list; rename re-keys nameNormalized ──
    const picked = pickWritableFields(body);
    if (!picked.ok) return res.status(400).json({ error: picked.error });

    // Key the row will carry after this save: the new name if renamed, else the
    // current name (which re-keys a legacy row whose nameNormalized is still "").
    const nextKey = normalizeCompanyName("name" in picked.data ? picked.data.name : company.name);
    if (!nextKey) return res.status(400).json({ error: "name cannot be blank." });
    if (nextKey !== company.nameNormalized) {
      // Landing on another company's key is a merge decision, not an edit —
      // refuse rather than create a duplicate key (the prod unique+partial
      // index would reject the save anyway, as an opaque 500).
      const clash = await CRMCompany.findOne({ nameNormalized: nextKey, _id: { $ne: company._id } })
        .select("_id name")
        .lean();
      if (clash) {
        return res.status(409).json({
          error: "Another company already has this name.",
          existingId: String(clash._id),
          existingName: clash.name,
        });
      }
    }

    for (const [k, v] of Object.entries(picked.data)) {
      (company as any)[k] = v;
    }
    // nameNormalized is derived by the model's pre-validate hook from `name`.
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

    const company = await CRMCompany.findById(req.params.id);
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
