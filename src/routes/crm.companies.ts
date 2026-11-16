import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import CRMCompany, {
  ACCOUNT_TYPES,
  LIFECYCLE_STATUSES,
  ACCOUNT_TIERS,
} from "../models/CRMCompany.js";
import CRMContact from "../models/CRMContact.js";
import Lead from "../models/Lead.js";
import Opportunity from "../models/Opportunity.js";
import { isClosedOpportunityStage, isOpenLead } from "../models/crmTaxonomy.js";
import { requireAuth } from "../middleware/auth.js";
import { requireHouse } from "../middleware/requireHouse.js";
import { requireCRMAccess } from "../utils/crmAccess.js";
import { moduleScope, leadMatch, opportunityMatch, contactMatch, companyMatchFor } from "../services/crmScope.js";
import { normalizeCompanyName } from "../utils/companyName.js";
import { isCrmV2FoundationEnabled, isCrmV2OpportunityEnabled } from "../config/crmV2.js";
import logger from "../utils/logger.js";

const router = express.Router();
type AnyObj = Record<string, any>;

// ── Write ALLOW-list (Slice 1; both flag paths since audit P1-5) ─────
// POST / PUT never spread req.body into the document — flag on or off. They
// copy exactly the fields pages/crm/CompanyForm.tsx and the CompanyDetail.tsx
// edit panel offer, plus the validated Company Account fields. Legacy fields
// keep their loose typing (the schema trims/casts them); the Account fields
// are validated against the model enums so a bad value is a 400, not a
// Mongoose 500. Every other key is ignored and echoed back as `ignored`
// (CompanyDetail posts the whole company back, so unknown keys are not
// rejected). Never client-writable: nameNormalized (derived from name by the
// model hook), customerId / customerWorkspaceId (set by customer onboarding,
// server-side), createdBy, companyCode, leadId, contactCount, timestamps.
//
// isPrivate: anyone who reaches the write — the creator on POST, the creator
// or an admin on PUT (the existing PUT gate). It only narrows who ELSE sees
// the creator's own company (companyMatch keeps createdBy-me visible), so it
// cannot widen the caller's access. Booleans only.
const WRITABLE_LEGACY_FIELDS = [
  "name", "industry", "companySize", "website", "phone", "email",
  "city", "state", "country", "address", "notes",
] as const;
// Handled explicitly below with validation.
const RULED_FIELDS = ["isPrivate", "accountType", "lifecycleStatus", "accountTier", "accountManagerId"] as const;

type PickResult = { ok: boolean; data: AnyObj; ignored: string[]; error?: string };

function pickWritableFields(body: AnyObj): PickResult {
  const data: AnyObj = {};
  const allowed = new Set<string>([...WRITABLE_LEGACY_FIELDS, ...RULED_FIELDS]);
  const ignored = Object.keys(body).filter((k) => !allowed.has(k));
  for (const k of WRITABLE_LEGACY_FIELDS) {
    if (k in body) data[k] = body[k];
  }
  if ("isPrivate" in body) {
    if (typeof body.isPrivate === "boolean") data.isPrivate = body.isPrivate;
    else ignored.push("isPrivate");
  }
  if ("accountType" in body) {
    if (!(ACCOUNT_TYPES as readonly string[]).includes(body.accountType)) {
      return { ok: false, data, ignored, error: `accountType must be one of: ${ACCOUNT_TYPES.join(", ")}` };
    }
    data.accountType = body.accountType;
  }
  if ("lifecycleStatus" in body) {
    if (!(LIFECYCLE_STATUSES as readonly string[]).includes(body.lifecycleStatus)) {
      return { ok: false, data, ignored, error: `lifecycleStatus must be one of: ${LIFECYCLE_STATUSES.join(", ")}` };
    }
    data.lifecycleStatus = body.lifecycleStatus;
  }
  if ("accountTier" in body) {
    if (body.accountTier === null || body.accountTier === "") {
      data.accountTier = null;
    } else if (!(ACCOUNT_TIERS as readonly string[]).includes(body.accountTier)) {
      return { ok: false, data, ignored, error: `accountTier must be one of: ${ACCOUNT_TIERS.join(", ")} (or null)` };
    } else {
      data.accountTier = body.accountTier;
    }
  }
  if ("accountManagerId" in body) {
    const v = body.accountManagerId;
    if (v === null || v === "") data.accountManagerId = null;
    else if (!mongoose.isValidObjectId(String(v))) return { ok: false, data, ignored, error: "accountManagerId must be a valid id or null" };
    else data.accountManagerId = new mongoose.Types.ObjectId(String(v));
  }
  return { ok: true, data, ignored };
}

const withIgnored = (ignored: string[]) => (ignored.length ? { ignored } : {});

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

    const picked = pickWritableFields(body);
    if (!picked.ok) return res.status(400).json({ error: picked.error });

    // ── Legacy path (CRM_V2_FOUNDATION off): allow-list, no dedupe ──
    // The model now keys nameNormalized on every save (Slice 2, un-gated), so
    // a duplicate name meets the prod unique+partial index here. That is a
    // 409 with the existing row's id, not a silent second company and not an
    // opaque 500 — the collapse-and-return behaviour stays behind the flag.
    if (!isCrmV2FoundationEnabled()) {
      try {
        const company = await CRMCompany.create({ ...picked.data, createdBy });
        return res.status(201).json({ company, ...withIgnored(picked.ignored) });
      } catch (e: any) {
        if (e?.code === 11000) {
          const existing = await CRMCompany.findOne({ nameNormalized: normalizeCompanyName(body.name) })
            .select("_id name")
            .lean();
          return res.status(409).json({
            error: "Another company already has this name.",
            existingId: existing ? String(existing._id) : undefined,
            existingName: existing?.name,
          });
        }
        throw e;
      }
    }

    // ── CRM_V2_FOUNDATION path: allow-list + dedupe on nameNormalized ──
    // Manual create resolves the same way lead-side resolveOrCreateCompany
    // does: an existing company with the same key is RETURNED, not duplicated
    // and not rejected (M8 code half). The response distinguishes the two
    // outcomes — 201 for a fresh row, 200 + deduped:true for a collapse — and
    // never applies the submitted attributes to the existing row ($setOnInsert
    // semantics, mirrored here with a find-then-create).
    const nameNormalized = normalizeCompanyName(picked.data.name);
    if (!nameNormalized) {
      return res.status(400).json({ error: "name is required." });
    }

    const existing = await CRMCompany.findOne({ nameNormalized }).lean();
    if (existing) {
      return res.status(200).json({ company: existing, deduped: true, ...withIgnored(picked.ignored) });
    }

    try {
      const company = await CRMCompany.create({ ...picked.data, nameNormalized, createdBy });
      return res.status(201).json({ company, ...withIgnored(picked.ignored) });
    } catch (e: any) {
      // Lost the race against a concurrent create / lead resolve; the prod
      // unique+partial index on nameNormalized rejected the second insert.
      // Return the winner — same outcome as the findOne hit above.
      if (e?.code === 11000) {
        const winner = await CRMCompany.findOne({ nameNormalized }).lean();
        if (winner) return res.status(200).json({ company: winner, deduped: true, ...withIgnored(picked.ignored) });
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
    // Same rule as the list and GET /:id — scope AND isPrivate
    // (services/crmScope companyMatch). The export used to skip isPrivate.
    const filter = await companyMatchFor(req);
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
    const q = req.query as AnyObj;
    // Scope goes through services/crmScope (normalizeScope): NONE / TEAM /
    // unknown narrow to OWN; only ALL / WORKSPACE get the shared view.
    const conditions: AnyObj[] = [await companyMatchFor(req)];

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
    // Lead / opportunity rollups for the page — same computed-on-read posture.
    // Leads anchor on Lead.companyId (backfill-lead-companyId); "open" is the
    // Leads page / Inbox rule (crmTaxonomy isOpenLead): disposition status
    // Open / In-progress — so Proposal / Negotiation leads count — else, for a
    // never-dispositioned lead, open unless stage won / lost, status LOST or
    // won (wonDate) — legacy proposal_sent / negotiation leads count as open.
    // Opportunities are read only under CRM_V2_OPPORTUNITY, matching
    // GET /leads/:id; off, the counts are 0 and the UI hides them.
    // Rollups follow the VIEWER's leads scope (services/crmScope): an OWN rep
    // counts their own leads / deals at the company, not everyone's; no
    // leads access at all → zeros.
    const leadsScope = moduleScope(req, "leads");
    const leadRows = companyIds.length && leadsScope
      ? await Lead.find({ ...leadMatch(leadsScope), companyId: { $in: companyIds } }).select("companyId stage status dispositionStatus wonDate").lean()
      : [];
    const leadCounts = new Map<string, { total: number; open: number }>();
    for (const l of leadRows as any[]) {
      const k = String(l.companyId);
      const e = leadCounts.get(k) || { total: 0, open: 0 };
      e.total += 1;
      if (isOpenLead(l)) e.open += 1;
      leadCounts.set(k, e);
    }
    const oppRows =
      isCrmV2OpportunityEnabled() && companyIds.length && leadsScope
        ? await Opportunity.find({ ...opportunityMatch(leadsScope), companyId: { $in: companyIds } }).select("companyId pipeline stage").lean()
        : [];
    const oppCounts = new Map<string, { total: number; open: number; won: number }>();
    for (const o of oppRows as any[]) {
      const k = String(o.companyId);
      const e = oppCounts.get(k) || { total: 0, open: 0, won: 0 };
      e.total += 1;
      if (!isClosedOpportunityStage(o.pipeline, o.stage)) e.open += 1;
      else if (o.stage !== "closed_lost") e.won += 1;
      oppCounts.set(k, e);
    }
    const withCounts = companies.map((c: any) => ({
      ...c,
      contactCount: countMap.get(String(c._id)) || 0,
      leadCount: leadCounts.get(String(c._id))?.total || 0,
      openLeadCount: leadCounts.get(String(c._id))?.open || 0,
      opportunityCount: oppCounts.get(String(c._id))?.total || 0,
      openOpportunityCount: oppCounts.get(String(c._id))?.open || 0,
      wonOpportunityCount: oppCounts.get(String(c._id))?.won || 0,
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

    // Same rule as the list and export (services/crmScope companyMatch, audit
    // P1-4): scope AND isPrivate. Outside it reads as "not found" — never
    // confirm existence, same as GET /leads/:id.
    const company = await CRMCompany.findOne({ _id: req.params.id, ...(await companyMatchFor(req)) }).lean();
    if (!company) return res.status(404).json({ error: "Company not found." });

    // Every rollup on the company follows the viewer's scope for THAT module
    // (services/crmScope): contacts by the crmContacts scope, deals by the
    // leads scope; no access → empty.
    const contactsScope = moduleScope(req, "crmContacts");
    const leadsScope = moduleScope(req, "leads");
    const contactFilter = contactsScope ? { ...contactMatch(contactsScope), companyId: company._id } : null;
    const contacts = contactFilter
      ? await CRMContact.find(contactFilter).select("firstName lastName jobTitle phone email status").lean()
      : [];

    // contactCount is computed-on-read — the stored field is never trusted.
    const contactCount = contactFilter ? await CRMContact.countDocuments(contactFilter) : 0;

    // Opportunities anchored on this company (Opportunity.companyId ← Lead.companyId).
    // Gated like the `opportunity` on GET /leads/:id; off, the array is empty.
    const opportunities = isCrmV2OpportunityEnabled() && leadsScope
      ? await Opportunity.find({ ...opportunityMatch(leadsScope), companyId: company._id })
          .select("opportunityCode name pipeline stage dealValue currency closeDate closedAt nextAction nextActionDueAt lostReason ownerName leadId primaryContactId createdAt updatedAt")
          .sort({ createdAt: -1 })
          .lean()
      : [];

    return res.json({ company: { ...company, contactCount }, contacts, opportunities });
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

    const body = (req.body || {}) as AnyObj;
    const picked = pickWritableFields(body);
    if (!picked.ok) return res.status(400).json({ error: picked.error });

    // ── Legacy path (CRM_V2_FOUNDATION off): allow-list, no pre-check ──
    // Same E11000 → 409 translation as POST: the un-gated key hook means a
    // rename onto another company's name is refused by the index.
    if (!isCrmV2FoundationEnabled()) {
      for (const [k, v] of Object.entries(picked.data)) {
        (company as any)[k] = v;
      }
      try {
        await company.save();
      } catch (e: any) {
        if (e?.code === 11000) {
          const clash = await CRMCompany.findOne({
            nameNormalized: normalizeCompanyName(company.name),
            _id: { $ne: company._id },
          })
            .select("_id name")
            .lean();
          return res.status(409).json({
            error: "Another company already has this name.",
            existingId: clash ? String(clash._id) : undefined,
            existingName: clash?.name,
          });
        }
        throw e;
      }
      return res.json({ company, ...withIgnored(picked.ignored) });
    }

    // ── CRM_V2_FOUNDATION path: allow-list; rename re-keys nameNormalized ──

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
    return res.json({ company, ...withIgnored(picked.ignored) });
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
