import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Lead, { LEAD_STAGES, LEAD_SOURCES, effectiveLeadStatus } from "../models/Lead.js";
import LeadActivity, { ACTIVITY_TYPES } from "../models/LeadActivity.js";
import Opportunity from "../models/Opportunity.js";
import { isCrmV2OpportunityEnabled, isCrmV2DispositionEnabled } from "../config/crmV2.js";
import { applyLegacyStageTransition, automationTriggerForPlan } from "../services/leadSplit.js";
import { applyDisposition, snapshotOf, DispositionError } from "../services/disposition.js";
import { resolvePipelineForLead, groupedSet, canWorkPipeline } from "../services/crmPipelines.js";
import CRMCompany from "../models/CRMCompany.js";
import CRMContact from "../models/CRMContact.js";
import { resolveOrCreateCompany, normalizeCompanyName } from "../utils/crmCompany.js";
import multer from "multer";
import { companyCheck, commitImport, dedupeSnapshot, normaliseSource, parseSpreadsheet, suggestMapping, validateRows, IMPORT_FIELDS, IMPORT_FILE_CAP_BYTES, IMPORT_ROW_CAP } from "../services/leadImport.js";
import type { LeadStage } from "../models/Lead.js";
import type { ActivityType } from "../models/LeadActivity.js";
import { UserPermission } from "../models/UserPermission.js";
import User from "../models/User.js";
import Task from "../models/Task.js";
import { requireAuth } from "../middleware/auth.js";
import { requireHouse } from "../middleware/requireHouse.js";
import { triggerTaskAutomation } from "../services/taskAutomation.js";
import { buildOwnerStatusReport } from "../services/ownerStatusReport.js";
import { SYSTEM_WORKSPACE_ID } from "../config/defaultTaskAutomations.js";
import logger from "../utils/logger.js";

const router = express.Router();

type AnyObj = Record<string, any>;

// HOUSE (Plumtrips internal) workspace _id. Per-file literal — the repo has no
// shared exported constant; this mirrors requireHouse.ts:7. NEVER write to it.
const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

// ── Permission helpers ──────────────────────────────────────────

function canWrite(access: string): boolean {
  return access === "WRITE" || access === "FULL";
}

function userId(user: AnyObj): string {
  return String(user.id || user.sub || "");
}

/** Resolve a user's display name for `assignedToName` via DB lookup, with the
 *  same fallback chain used by the assign route. Returns "" when the id is
 *  invalid or the user is missing — callers keep the id regardless.
 *  IMPORTANT: assignedToName must be resolved from the DB, NOT from the JWT
 *  payload's `user.name`. The token carries no name, so trusting it stored an
 *  empty owner label on every self-created lead (the bug this fixes). */
async function resolveUserName(uid: string): Promise<string> {
  if (!mongoose.isValidObjectId(uid)) return "";
  const u = (await User.findById(uid).select("name firstName lastName email").lean()) as any;
  if (!u) return "";
  return (
    (u.name && String(u.name).trim()) ||
    `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
    (u.email ? String(u.email).trim() : "")
  );
}

// ── Slice 2 (CRM_V2_OPPORTUNITY): split hook for the legacy stage routes ──
// The unchanged frontend keeps sending the 9 legacy stage values. With the
// flag on, every route that sets Lead.stage calls this AFTER its own save (so
// the model hook has already derived Lead.status) and the split service
// creates/advances/closes the lead's Opportunity to match, logs a demo for
// demo_scheduled, and hands back the trigger key for the new taxonomy
// (legacy keys resolve as aliases inside triggerTaskAutomation). With the
// flag off this is a no-op and the caller fires its legacy trigger.
async function runOpportunitySplit(
  lead: any,
  user: AnyObj,
): Promise<{ triggered: boolean; opportunityId: string | null }> {
  if (!isCrmV2OpportunityEnabled()) return { triggered: false, opportunityId: null };
  const actorId = mongoose.isValidObjectId(userId(user)) ? new mongoose.Types.ObjectId(userId(user)) : null;
  const actorName = user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System";
  const { plan, result } = await applyLegacyStageTransition(lead, { actorId, actorName });
  const trig = automationTriggerForPlan(plan);
  if (trig) {
    const isOpp = trig.entityType === "OPPORTUNITY" && result.opportunityId;
    triggerTaskAutomation(trig.key, {
      workspaceId: SYSTEM_WORKSPACE_ID,
      entityType: isOpp ? "OPPORTUNITY" : "LEAD",
      entityId: isOpp ? new mongoose.Types.ObjectId(result.opportunityId!) : (lead._id as mongoose.Types.ObjectId),
      entityRef: lead.leadCode,
      ownerId: lead.assignedTo,
      variables: { leadName: lead.contactName || lead.companyName || "Lead", ownerName: lead.assignedToName || "" },
    }).catch(() => {});
  }
  return { triggered: !!trig, opportunityId: result.opportunityId };
}

// ── requireLeadsAccess ──────────────────────────────────────────

async function requireLeadsAccess(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  try {
    const user = (req as any).user as AnyObj | undefined;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
    if (roles.includes("SUPERADMIN") || roles.includes("ADMIN")) {
      (req as any).leadsAccess = "FULL";
      (req as any).leadsScope = "ALL";
      next();
      return;
    }

    const perm = (await UserPermission.findOne({
      $or: [{ userId: user.sub }, { userId: user.id }],
    })
      .select("modules")
      .lean()) as any;

    const leadsModule = perm?.modules?.leads;
    const access: string = leadsModule?.access || "NONE";
    const scope: string = leadsModule?.scope || "NONE";

    if (access === "NONE") {
      res.status(403).json({ error: "You do not have access to the leads module." });
      return;
    }

    (req as any).leadsAccess = access;
    (req as any).leadsScope = scope;
    next();
  } catch (err) {
    logger.error("requireLeadsAccess error", { err });
    res.status(500).json({ error: "Permission check failed" });
  }
}

// ── In-memory rate limiter for /website-capture ─────────────────

const ipCounts = new Map<string, { count: number; reset: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipCounts.get(ip);
  if (!entry || now > entry.reset) {
    ipCounts.set(ip, { count: 1, reset: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

// ── Date formatter ──────────────────────────────────────────────

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d as any);
  if (isNaN(dt.getTime())) return "";
  return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
}

// ── Shared export filter resolver ───────────────────────────────
// Lets the XLSX exports match the Owner-Status report's on-screen slice.
// ADDITIVE + backward-compatible:
//   • assignedTo / stage / source / type — optional multi-value lead filters
//     (absent ⇒ no effect; existing callers pass none).
//   • dateFrom / dateTo — when dateBasis="last_activity" the range is applied to
//     last_activity_date = max(latest LeadActivity.createdAt, Lead.createdAt),
//     matching the report. Otherwise (default) it stays on createdAt — the
//     legacy behavior CRMDashboard's export relies on.
//   • OWN scope is preserved and overrides any assignedTo param.
// Read-only; no schema change.
async function resolveExportLeads(
  req: express.Request,
  opts: { ignoreDateFilter?: boolean } = {}
): Promise<any[]> {
  const q = req.query as AnyObj;
  const user = (req as any).user as AnyObj;
  const leadsScope = (req as any).leadsScope as string;

  const toArr = (v: unknown): string[] => {
    if (v == null) return [];
    const raw = Array.isArray(v) ? v : String(v).split(",");
    return raw.map((s) => String(s).trim()).filter(Boolean);
  };

  const assignedToF = toArr(q.assignedTo).filter((s) => mongoose.isValidObjectId(s));
  const stageF = toArr(q.stage).filter((s) => (LEAD_STAGES as readonly string[]).includes(s));
  const sourceF = toArr(q.source);
  const typeF = toArr(q.type).filter((s) => s === "company" || s === "individual");

  const dateFrom = q.dateFrom ? new Date(String(q.dateFrom)) : null;
  const dateTo = q.dateTo ? new Date(String(q.dateTo)) : null;
  if (dateFrom && !isNaN(dateFrom.getTime())) dateFrom.setHours(0, 0, 0, 0);
  if (dateTo && !isNaN(dateTo.getTime())) dateTo.setHours(23, 59, 59, 999);
  const fromMs = dateFrom && !isNaN(dateFrom.getTime()) ? dateFrom.getTime() : null;
  const toMs = dateTo && !isNaN(dateTo.getTime()) ? dateTo.getTime() : null;
  const byActivity = String(q.dateBasis || "") === "last_activity";

  const leadMatch: AnyObj = {};
  // OWN scope wins over any assignedTo param.
  if (leadsScope === "OWN") {
    const uid = userId(user);
    if (mongoose.isValidObjectId(uid)) leadMatch.assignedTo = new mongoose.Types.ObjectId(uid);
  } else if (assignedToF.length) {
    leadMatch.assignedTo = { $in: assignedToF.map((s) => new mongoose.Types.ObjectId(s)) };
  }
  if (stageF.length) leadMatch.stage = { $in: stageF };
  if (sourceF.length) leadMatch.source = { $in: sourceF };
  if (typeF.length) leadMatch.type = { $in: typeF };

  // Legacy date basis (createdAt) — unchanged for existing callers.
  // ignoreDateFilter ⇒ owner/status/source/type + OWN scope only (the activities
  // export applies its date range to the activity's own createdAt instead).
  if (!opts.ignoreDateFilter && !byActivity && (fromMs != null || toMs != null)) {
    leadMatch.createdAt = {};
    if (fromMs != null) leadMatch.createdAt.$gte = new Date(fromMs);
    if (toMs != null) leadMatch.createdAt.$lte = new Date(toMs);
  }

  const leads = (await Lead.find(leadMatch).sort({ createdAt: -1 }).lean()) as any[];

  // last_activity_date basis — compute + filter in memory (matches the report).
  if (!opts.ignoreDateFilter && byActivity && (fromMs != null || toMs != null)) {
    const ids = leads.map((l) => l._id);
    const acts = ids.length
      ? ((await LeadActivity.find({ leadId: { $in: ids } }).select("leadId createdAt").lean()) as any[])
      : [];
    const maxByLead = new Map<string, number>();
    for (const a of acts) {
      const k = String(a.leadId);
      const t = new Date(a.createdAt).getTime();
      if (t > (maxByLead.get(k) || 0)) maxByLead.set(k, t);
    }
    return leads.filter((l) => {
      const last = Math.max(new Date(l.createdAt).getTime(), maxByLead.get(String(l._id)) || 0);
      if (fromMs != null && last < fromMs) return false;
      if (toMs != null && last > toMs) return false;
      return true;
    });
  }

  return leads;
}

// ═══════════════════════════════════════════════════════════════
// ROUTE 15 — POST /website-capture
// Sits above the router-level requireHouse gate, so it carries its own
// route-level requireHouse: this is an authenticated HOUSE-only write into
// the global CRM leads collection. requireWorkspace (mount-level) has already
// populated req.workspaceId by the time requireHouse runs here.
// ═══════════════════════════════════════════════════════════════

router.post("/website-capture", requireHouse, async (req, res) => {
  try {
    const ip: string = (req as any).ip || req.socket?.remoteAddress || "unknown";
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }

    const body = req.body as AnyObj;
    const { name, phone, email = "", company = "", message = "", source = "website" } = body;

    if (!name || !phone) {
      return res.status(400).json({ error: "Name and phone are required." });
    }

    const sanitize = (v: unknown, max = 200) => String(v || "").trim().slice(0, max);

    const defaultRep = (await (User as any).findOne({
      roles: { $in: ["ADMIN", "SUPERADMIN"] },
    })
      .select("_id name")
      .lean()) as any;

    // Anchor inbound leads on a shared company immediately (resolve-or-create).
    const companyName = sanitize(company);
    let companyId: mongoose.Types.ObjectId | null = null;
    if (companyName) {
      const co = await resolveOrCreateCompany({ name: companyName }, defaultRep?._id);
      companyId = co?._id ?? null;
    }

    const lead = await Lead.create({
      contactName: sanitize(name),
      contactPhone: sanitize(phone, 20),
      contactEmail: sanitize(email),
      companyName,
      companyId,
      notes: sanitize(message, 1000),
      source: (LEAD_SOURCES as readonly string[]).includes(source) ? source : "website",
      stage: "new",
      assignedTo: defaultRep?._id,
      assignedToName: defaultRep?.name || "",
      createdBy: defaultRep?._id,
    });

    if (message) {
      await LeadActivity.create({
        leadId: lead._id,
        type: "note",
        note: sanitize(message, 1000),
        createdBy: defaultRep?._id,
        createdByName: "Website",
      });
    }

    return res.json({
      success: true,
      message: "Thank you for your interest. Our team will contact you shortly.",
    });
  } catch (err) {
    logger.error("website-capture error", { err });
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── Auth gate (all routes below require authentication) ─────────
router.use(requireAuth);

// ── HOUSE gate (CRM is a Plumtrips HOUSE-only product) ──────────
// Placed after the public /website-capture route above so that route stays
// reachable; everything below is HOUSE-only. requireWorkspace runs at the
// mount (server.ts) and populates req.workspaceId before this fires.
router.use(requireHouse);

// ── Leads access gate (all routes below require leads module) ───
router.use(requireLeadsAccess);

// ═══════════════════════════════════════════════════════════════
// ROUTE 0 — GET /reps  (CRM reps for the Leads assignee filter)
// ═══════════════════════════════════════════════════════════════
// Returns HOUSE users who can act on leads, mirroring requireLeadsAccess
// EXACTLY: role ∈ {ADMIN, SUPERADMIN} (implicit — they pass the gate with no
// UserPermission row) OR a UserPermission with modules.leads.access ≠ NONE.
// Restricted to active HOUSE employees (User.status ≠ INACTIVE).
//
// v1 KNOWN LIMITATION: historical assignees who have since lost CRM access are
// NOT included — their existing leads remain in the data but won't appear as a
// filter option. UserPermission.status (suspended/revoked) is intentionally
// NOT special-cased in v1, matching the current gate which ignores it.
router.get("/reps", async (_req, res) => {
  try {
    // Access arm. UserPermission stores workspaceId + userId as Strings, and
    // userId === String(User._id) (the value requireLeadsAccess looks up).
    const grants = await UserPermission.find({
      workspaceId: HOUSE_WORKSPACE_ID,
      universe: "STAFF",
      // Positive, default-closed match. NOT { $ne: 'NONE' }: in MongoDB $ne
      // matches missing fields, so absent leads.access would be pulled in —
      // yet requireLeadsAccess coerces absent → 'NONE' → 403. This mirrors the
      // gate: only an explicit READ/WRITE/FULL grant counts.
      "modules.leads.access": { $in: ["READ", "WRITE", "FULL"] },
    })
      .select("userId")
      .lean();

    // Role arm. HOUSE ADMIN/SUPERADMIN pass the gate by role regardless of any
    // UserPermission row, so they MUST be unioned in. User.workspaceId is an
    // ObjectId — note the String-vs-ObjectId difference vs UserPermission.
    const houseObjectId = new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID);
    const roleReps = await User.find({
      workspaceId: houseObjectId,
      roles: { $in: ["ADMIN", "SUPERADMIN"] },
    })
      .select("_id")
      .lean();

    // Union of both arms (de-duped by id), then resolve against active HOUSE
    // employees. The final User scope enforces HOUSE + status ≠ INACTIVE, so a
    // granted-but-inactive or non-HOUSE id drops out here.
    const union = new Map<string, mongoose.Types.ObjectId>();
    for (const g of grants as any[]) {
      const id = String(g.userId || "");
      if (mongoose.isValidObjectId(id)) union.set(id, new mongoose.Types.ObjectId(id));
    }
    for (const u of roleReps as any[]) union.set(String(u._id), u._id);

    const users = (await User.find({
      workspaceId: houseObjectId,
      _id: { $in: [...union.values()] },
      status: { $ne: "INACTIVE" },
    })
      .select("_id name firstName lastName email")
      .lean()) as any[];

    const reps = users
      .map((u) => ({
        _id: String(u._id),
        name:
          (u.name && String(u.name).trim()) ||
          `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
          (u.email ? String(u.email).trim() : ""),
      }))
      .filter((r) => r.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ reps });
  } catch (err) {
    logger.error("leads GET /reps error", { err });
    return res.status(500).json({ error: "Failed to load reps." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 0b — GET /company-check?name=… | ?companyId=…
// ═══════════════════════════════════════════════════════════════
// Same-company dedupe context for the new-lead form: does this company
// already exist, and which leads does it already carry (with their owner)?
// Read-only and ADVISORY — POST / never consults it; the rep decides.
//
// Resolution is the one dedupe key (utils/companyName.ts nameNormalized),
// with a case-insensitive exact-name fallback for legacy rows whose key is
// still "". Leads are matched on Lead.companyId, plus unanchored legacy rows
// whose companyName equals the resolved company's name.
//
// Scope: deliberately NOT narrowed to OWN — the point is to reveal that a
// colleague owns the account. Only leadCode / contact / stage / owner are
// exposed. `open` uses the same definition as the Companies rollups
// (canonical status not in CONVERTED / LOST).
router.get("/company-check", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const hasId = q.companyId && mongoose.isValidObjectId(String(q.companyId));
    if (!hasId && !normalizeCompanyName(q.name)) {
      return res.status(400).json({ error: "name or companyId is required." });
    }
    return res.json(await companyCheck(hasId ? { companyId: String(q.companyId) } : { name: String(q.name) }));
  } catch (err) {
    logger.error("leads GET /company-check error", { err });
    return res.status(500).json({ error: "Failed to check the company." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 0c — POST /import/preview · POST /import/commit  (ask #6)
// ═══════════════════════════════════════════════════════════════
// Bulk lead import. preview parses the upload (CSV / XLSX, ≤ 10 MB, ≤ 1000
// rows) or re-validates already-parsed rows under a confirmed mapping, and
// runs every row through the same-company dedupe — it writes NOTHING.
// commit creates the valid rows through Lead.create (atomic leadCode from
// the Counter, company anchored on nameNormalized exactly like POST /),
// tags a row whose company already carried an open lead as a possible
// duplicate (advisory), and reports created / invalid / failed per row.
// Both need write access: import is a write intent.
// See services/leadImport.ts.
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_FILE_CAP_BYTES } });

function importDefaults(raw: AnyObj): { source: string } | { error: string } {
  const src = raw?.source ? normaliseSource(String(raw.source)) : "manual";
  if (!src) return { error: `Unknown source "${raw.source}". Use one of: ${LEAD_SOURCES.join(", ")}.` };
  return { source: src };
}

router.post("/import/preview", importUpload.single("file"), async (req, res) => {
  try {
    if (!canWrite((req as any).leadsAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    const body = (req.body || {}) as AnyObj;
    const parseJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

    let columns: string[];
    let rows: Record<string, string>[];
    let truncated = false;
    let totalRows = 0;
    if ((req as any).file?.buffer) {
      const parsed = parseSpreadsheet((req as any).file.buffer);
      if (!parsed.columns.length) return res.status(400).json({ error: "The file has no header row." });
      columns = parsed.columns;
      rows = parsed.rows;
      truncated = parsed.truncated;
      totalRows = parsed.totalRows;
    } else if (Array.isArray(parseJson(body.rows))) {
      rows = parseJson(body.rows);
      if (rows.length > IMPORT_ROW_CAP) return res.status(400).json({ error: `At most ${IMPORT_ROW_CAP} rows per import.` });
      columns = Array.isArray(parseJson(body.columns)) ? parseJson(body.columns) : Object.keys(rows[0] || {});
      totalRows = rows.length;
    } else {
      return res.status(400).json({ error: "Upload a CSV / XLSX as `file`, or send parsed `rows`." });
    }

    const suggestedMapping = suggestMapping(columns);
    const mapping: Record<string, string> = parseJson(body.mapping) || suggestedMapping;
    const defaults = importDefaults(parseJson(body.defaults) || {});
    if ("error" in defaults) return res.status(400).json({ error: defaults.error });

    const validated = validateRows(rows, mapping, defaults);
    const snapshot = await dedupeSnapshot(validated.filter((r) => r.lead));
    const out = validated.map((r) => {
      const d = snapshot.get(r.row);
      return {
        row: r.row,
        values: r.values,
        valid: !!r.lead,
        errors: r.errors,
        warnings: r.warnings,
        duplicate: d && d.existingOpen.length ? d.existingOpen[0] : null,
        existingOpenCount: d?.existingOpen.length ?? 0,
        sameCompanyRowsInFile: d?.sameCompanyRowsInFile ?? 0,
      };
    });
    return res.json({
      columns,
      suggestedMapping,
      mapping,
      fields: IMPORT_FIELDS,
      defaults,
      rowCount: rows.length,
      totalRows,
      truncated,
      cap: IMPORT_ROW_CAP,
      rows: out,
      summary: {
        total: out.length,
        valid: out.filter((r) => r.valid).length,
        invalid: out.filter((r) => !r.valid).length,
        flagged: out.filter((r) => r.valid && r.duplicate).length,
      },
    });
  } catch (err: any) {
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File is larger than 10 MB." });
    logger.error("leads POST /import/preview error", { err });
    return res.status(500).json({ error: "Could not read that file." });
  }
});

router.post("/import/commit", async (req, res) => {
  try {
    if (!canWrite((req as any).leadsAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    const user = (req as any).user as AnyObj;
    const body = (req.body || {}) as AnyObj;
    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "rows is required." });
    if (rows.length > IMPORT_ROW_CAP) return res.status(400).json({ error: `At most ${IMPORT_ROW_CAP} rows per import.` });
    if (!body.mapping || typeof body.mapping !== "object") return res.status(400).json({ error: "mapping is required." });
    const defaults = importDefaults(body.defaults || {});
    if ("error" in defaults) return res.status(400).json({ error: defaults.error });

    // Every row must be valid up front — the batch never starts half-baked.
    const validated = validateRows(rows, body.mapping, defaults);
    if (!validated.some((r) => r.lead)) {
      return res.status(400).json({ error: "No valid rows to import.", invalid: validated.map((r) => ({ row: r.row, errors: r.errors })) });
    }

    const importerId = userId(user);
    const importerName = await resolveUserName(importerId);
    const ownerId = body.assignedTo && mongoose.isValidObjectId(String(body.assignedTo)) ? String(body.assignedTo) : importerId;
    const ownerName = ownerId === importerId ? importerName : await resolveUserName(ownerId);
    if (ownerId !== importerId && !ownerName) return res.status(400).json({ error: "assignedTo is not a known user." });

    const report = await commitImport({
      rows, mapping: body.mapping, defaults,
      importer: { id: importerId, name: importerName },
      owner: { id: ownerId, name: ownerName },
    });
    return res.status(201).json(report);
  } catch (err) {
    logger.error("leads POST /import/commit error", { err });
    return res.status(500).json({ error: "Import failed." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 1 — POST /  (create lead)
// ═══════════════════════════════════════════════════════════════

router.post("/", async (req, res) => {
  try {
    if (!canWrite((req as any).leadsAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }

    const user = (req as any).user as AnyObj;
    const body = req.body as AnyObj;

    if (!body.contactName || !body.contactPhone) {
      return res.status(400).json({ error: "contactName and contactPhone are required." });
    }

    const assignedToId = body.assignedTo || userId(user);
    // Resolve the owner label from the assignee id via DB lookup — one path for
    // both the self-assign default and an explicitly-passed rep. A caller-
    // supplied assignedToName is honored as-is; otherwise we resolve from the
    // DB (never from user.name — see resolveUserName).
    const assignedToName =
      (body.assignedToName && String(body.assignedToName).trim()) ||
      (await resolveUserName(String(assignedToId)));

    const createdById = mongoose.isValidObjectId(userId(user))
      ? new mongoose.Types.ObjectId(userId(user))
      : undefined;

    // Anchor on a shared company (resolve-or-create) for company-type leads with
    // a non-blank name. companyId is set server-side, never trusted from the body.
    const leadType = body.type === "individual" ? "individual" : "company";
    let companyId: mongoose.Types.ObjectId | null = null;
    if (leadType === "company" && body.companyName && String(body.companyName).trim()) {
      const co = await resolveOrCreateCompany(
        {
          name: body.companyName,
          industry: body.industry,
          companySize: body.companySize,
          location: body.location,
          website: body.website,
          gstin: body.gstin,
        },
        createdById
      );
      companyId = co?._id ?? null;
    }

    const lead = await Lead.create({
      ...body,
      assignedTo: mongoose.isValidObjectId(assignedToId)
        ? new mongoose.Types.ObjectId(String(assignedToId))
        : undefined,
      assignedToName,
      companyId,
      createdBy: createdById,
    });

    if (body.notes) {
      await LeadActivity.create({
        leadId: lead._id,
        type: "note" as ActivityType,
        note: String(body.notes),
        createdBy: lead.createdBy,
        createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
      });
    }

    // Task automation hook — fire-and-forget, never breaks lead creation
    triggerTaskAutomation("lead.created", {
      workspaceId: SYSTEM_WORKSPACE_ID,
      entityType: "LEAD",
      entityId: lead._id as mongoose.Types.ObjectId,
      entityRef: lead.leadCode,
      ownerId: lead.assignedTo,
      variables: {
        leadName: lead.contactName || lead.companyName || "Lead",
        ownerName: lead.assignedToName || "",
      },
    }).catch(() => {});

    return res.status(201).json({ lead });
  } catch (err) {
    logger.error("leads POST / error", { err });
    return res.status(500).json({ error: "Failed to create lead." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 2 — GET /  (list leads)
// ═══════════════════════════════════════════════════════════════

// ── Lead enrichment: last activity + temperature (additive, read-only) ──
// Surfaced on the leads list so the redesigned cards can show "last activity"
// and a hot/warm/cold dot WITHOUT a schema change. Existing response fields are
// untouched; these are extra optional fields.
const LATE_STAGES = new Set(["demo_scheduled", "proposal_sent", "negotiation"]);
const ACTIVITY_LABELS: Record<string, string> = {
  note: "Note added",
  call: "Call logged",
  email: "Email sent",
  meeting: "Meeting",
  stage_change: "Stage changed",
  assignment: "Reassigned",
  follow_up: "Follow-up set",
  won: "Marked won",
  lost: "Marked lost",
  invite_sent: "Invite sent",
};
const DAY_MS = 86_400_000;

// Deterministic temperature heuristic (see design.md):
//   HOT  = overdue follow-up OR a fresh touch (≤3d) while in a late stage
//   COLD = no touch in 14+ days (falls back to createdAt when no activity)
//   WARM = everything else. HOT takes precedence over COLD.
function computeTemperature(opts: {
  stage: string;
  nextFollowUpDate?: Date | null;
  lastActivityAt?: Date | null;
  createdAt: Date;
  now: Date;
}): "hot" | "warm" | "cold" {
  const { stage, nextFollowUpDate, lastActivityAt, createdAt, now } = opts;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const overdue =
    !!nextFollowUpDate && nextFollowUpDate.getTime() < startOfToday.getTime();
  const freshTouch =
    !!lastActivityAt && now.getTime() - lastActivityAt.getTime() <= 3 * DAY_MS;
  if (overdue || (freshTouch && LATE_STAGES.has(stage))) return "hot";
  const lastTouch = lastActivityAt ?? createdAt;
  if (now.getTime() - lastTouch.getTime() >= 14 * DAY_MS) return "cold";
  return "warm";
}

async function enrichLeads(leads: any[]): Promise<any[]> {
  if (!leads.length) return leads;
  const ids = leads.map((l) => l._id);
  // One grouped query → latest activity per lead (uses {leadId,createdAt} index).
  const latest = await LeadActivity.aggregate([
    { $match: { leadId: { $in: ids } } },
    { $sort: { leadId: 1, createdAt: -1 } },
    {
      $group: {
        _id: "$leadId",
        at: { $first: "$createdAt" },
        type: { $first: "$type" },
        note: { $first: "$note" },
      },
    },
  ]);
  const byLead = new Map<string, any>(latest.map((a: any) => [String(a._id), a]));
  const now = new Date();
  return leads.map((l) => {
    const a = byLead.get(String(l._id));
    const lastActivityAt: Date | null = a?.at ?? null;
    const lastActivityLabel = a
      ? a.type === "note" && a.note
        ? `Note: ${String(a.note).slice(0, 40)}`
        : ACTIVITY_LABELS[a.type] || "Activity"
      : null;
    return {
      ...l,
      lastActivityAt,
      lastActivityLabel,
      temperature: computeTemperature({
        stage: l.stage,
        nextFollowUpDate: l.nextFollowUpDate ?? null,
        lastActivityAt,
        createdAt: l.createdAt,
        now,
      }),
    };
  });
}

router.get("/", async (req, res) => {
  try {
    const user = (req as any).user as AnyObj;
    const leadsScope = (req as any).leadsScope as string;
    const q = req.query as AnyObj;
    const filter: AnyObj = {};

    if (leadsScope === "OWN") {
      const uid = userId(user);
      if (mongoose.isValidObjectId(uid)) {
        filter.assignedTo = new mongoose.Types.ObjectId(uid);
      }
    } else {
      if (q.assignedTo && mongoose.isValidObjectId(String(q.assignedTo))) {
        filter.assignedTo = new mongoose.Types.ObjectId(String(q.assignedTo));
      }
    }

    if (q.stage) {
      const stages = String(q.stage).split(",").filter(Boolean);
      filter.stage = { $in: stages };
    }
    if (q.source) filter.source = q.source;

    // Additive read filter — used by the lead form's CompanyPicker to count how
    // many leads already exist for a picked canonical company (dedup context).
    if (q.companyId && mongoose.isValidObjectId(String(q.companyId))) {
      filter.companyId = new mongoose.Types.ObjectId(String(q.companyId));
    }

    // Additive read filter — the Leads page's Today view (ask #11): follow-up
    // overdue or due today. The client sends its own end-of-day cutoff (its
    // timezone), so "today" here is exactly the Inbox's derivation:
    // nextFollowUpDate < startOfTomorrow.
    if (q.dueBefore) {
      const cutoff = new Date(String(q.dueBefore));
      if (!isNaN(cutoff.getTime())) filter.nextFollowUpDate = { $lt: cutoff };
    }

    if (q.dateFrom || q.dateTo) {
      filter.createdAt = {};
      if (q.dateFrom) filter.createdAt.$gte = new Date(String(q.dateFrom));
      if (q.dateTo) filter.createdAt.$lte = new Date(String(q.dateTo));
    }

    if (q.search) {
      const re = new RegExp(String(q.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { contactName: re },
        { companyName: re },
        { contactPhone: re },
        { contactEmail: re },
      ];
    }

    const page = Math.max(1, parseInt(String(q.page || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || "20"), 10)));
    const skip = (page - 1) * limit;

    const [leads, total] = await Promise.all([
      Lead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Lead.countDocuments(filter),
    ]);

    const enriched = await enrichLeads(leads);

    return res.json({ leads: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error("leads GET / error", { err });
    return res.status(500).json({ error: "Failed to list leads." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 3 — GET /reports/summary
// ═══════════════════════════════════════════════════════════════

router.get("/reports/summary", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const dateFilter: AnyObj = {};
    if (q.dateFrom || q.dateTo) {
      dateFilter.createdAt = {};
      if (q.dateFrom) dateFilter.createdAt.$gte = new Date(String(q.dateFrom));
      if (q.dateTo) dateFilter.createdAt.$lte = new Date(String(q.dateTo));
    }

    const [byStage, bySource, wonCount, lostCount, pipelineAgg, avgAgg] =
      await Promise.all([
        Lead.aggregate([{ $match: dateFilter }, { $group: { _id: "$stage", count: { $sum: 1 } } }]),
        Lead.aggregate([{ $match: dateFilter }, { $group: { _id: "$source", count: { $sum: 1 } } }]),
        Lead.countDocuments({ ...dateFilter, stage: "won" }),
        Lead.countDocuments({ ...dateFilter, stage: "lost" }),
        Lead.aggregate([
          { $match: { ...dateFilter, stage: { $nin: ["won", "lost"] } } },
          { $group: { _id: null, total: { $sum: "$dealValue" } } },
        ]),
        Lead.aggregate([
          { $match: { ...dateFilter, stage: "won" } },
          { $group: { _id: null, avg: { $avg: "$dealValue" } } },
        ]),
      ]);

    const totalPipelineValue: number = pipelineAgg[0]?.total || 0;
    const avgDealValue: number = Math.round(avgAgg[0]?.avg || 0);
    const winRate =
      wonCount + lostCount > 0
        ? Math.round((wonCount / (wonCount + lostCount)) * 1000) / 10
        : 0;

    return res.json({
      byStage: Object.fromEntries(byStage.map((s: any) => [s._id, s.count])),
      bySource: Object.fromEntries(bySource.map((s: any) => [s._id, s.count])),
      totalPipelineValue,
      wonCount,
      lostCount,
      winRate,
      avgDealValue,
    });
  } catch (err) {
    logger.error("leads GET /reports/summary error", { err });
    return res.status(500).json({ error: "Failed to load summary." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 4 — GET /reports/by-rep  (Agent-wise snapshot, ask #10)
// ═══════════════════════════════════════════════════════════════
// Per owner: leads owned, dispositioned today, open leads, won (count + ₹),
// win rate, open opportunities. Optional dateFrom / dateTo scope the LEAD
// rows on createdAt; `todayStart` (ISO, the caller's start of day) scopes
// "dispositioned today" — defaults to the server's. Won / lost read the
// effective disposition status (dispositionStatus, else the legacy stage)
// so pre-disposition rows still count. Open opportunities come from a
// second aggregate on Opportunity.ownerUserId, joined here by rep id.

/** Effective disposition status: dispositionStatus, else legacy stage → Won / Lost / Open. */
const EFFECTIVE_STATUS_EXPR = {
  $switch: {
    branches: [
      { case: { $in: ["$dispositionStatus", ["Won", "Lost", "In-progress", "Open"]] }, then: "$dispositionStatus" },
      { case: { $eq: ["$stage", "won"] }, then: "Won" },
      { case: { $eq: ["$stage", "lost"] }, then: "Lost" },
    ],
    default: "Open",
  },
};

function createdAtFilter(q: AnyObj): AnyObj {
  const f: AnyObj = {};
  const from = q.dateFrom ? new Date(String(q.dateFrom)) : null;
  const to = q.dateTo ? new Date(String(q.dateTo)) : null;
  if ((from && !isNaN(from.getTime())) || (to && !isNaN(to.getTime()))) {
    f.createdAt = {};
    if (from && !isNaN(from.getTime())) f.createdAt.$gte = from;
    if (to && !isNaN(to.getTime())) f.createdAt.$lte = to;
  }
  return f;
}

router.get("/reports/by-rep", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const dateFilter = createdAtFilter(q);
    const todayStartRaw = q.todayStart ? new Date(String(q.todayStart)) : null;
    const todayStart = todayStartRaw && !isNaN(todayStartRaw.getTime()) ? todayStartRaw : new Date(new Date().setHours(0, 0, 0, 0));

    const [reps, opps] = await Promise.all([
      Lead.aggregate([
        { $match: dateFilter },
        { $addFields: { effStatus: EFFECTIVE_STATUS_EXPR } },
        {
          $group: {
            _id: "$assignedTo",
            repName: { $first: "$assignedToName" },
            total: { $sum: 1 },
            won: { $sum: { $cond: [{ $eq: ["$effStatus", "Won"] }, 1, 0] } },
            lost: { $sum: { $cond: [{ $eq: ["$effStatus", "Lost"] }, 1, 0] } },
            open: { $sum: { $cond: [{ $in: ["$effStatus", ["Open", "In-progress"]] }, 1, 0] } },
            wonValue: { $sum: { $cond: [{ $eq: ["$effStatus", "Won"] }, "$dealValue", 0] } },
            pipelineValue: { $sum: { $cond: [{ $in: ["$effStatus", ["Open", "In-progress"]] }, "$dealValue", 0] } },
            dispositionedToday: { $sum: { $cond: [{ $gte: ["$dispositionAt", todayStart] }, 1, 0] } },
          },
        },
        {
          $project: {
            _id: 0,
            repId: "$_id",
            repName: 1,
            total: 1,
            won: 1,
            lost: 1,
            open: 1,
            wonValue: 1,
            pipelineValue: 1,
            dispositionedToday: 1,
            conversion: {
              $cond: [
                { $gt: [{ $add: ["$won", "$lost"] }, 0] },
                { $round: [{ $multiply: [{ $divide: ["$won", { $add: ["$won", "$lost"] }] }, 100] }, 1] },
                0,
              ],
            },
          },
        },
        { $sort: { total: -1 } },
      ]),
      Opportunity.aggregate([
        { $match: { stage: { $nin: ["closed_won", "closed_lost", "active_partner"] } } },
        { $group: { _id: "$ownerUserId", openOpportunities: { $sum: 1 } } },
      ]),
    ]);

    const oppByRep = new Map<string, number>(opps.map((o: any) => [String(o._id), o.openOpportunities]));
    const withOpps = reps.map((r: any) => ({
      ...r,
      repId: r.repId ? String(r.repId) : null,
      repName: r.repName || (r.repId ? "" : "Unassigned"),
      openOpportunities: oppByRep.get(String(r.repId)) || 0,
    }));

    return res.json({ reps: withOpps, todayStart: todayStart.toISOString() });
  } catch (err) {
    logger.error("leads GET /reports/by-rep error", { err });
    return res.status(500).json({ error: "Failed to load rep report." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 4b — GET /reports/by-status  (Status-wise snapshot, ask #10)
// ═══════════════════════════════════════════════════════════════
// Counts per DISPOSITION status (Open / In-progress / Won / Lost), not the
// legacy stages. Rows never dispositioned map through the legacy stage, so
// the four buckets always sum to the total. Optional dateFrom / dateTo.
const DISPOSITION_STATUSES = ["Open", "In-progress", "Won", "Lost"] as const;

router.get("/reports/by-status", async (req, res) => {
  try {
    const rows = await Lead.aggregate([
      { $match: createdAtFilter(req.query as AnyObj) },
      { $addFields: { effStatus: EFFECTIVE_STATUS_EXPR } },
      { $group: { _id: "$effStatus", count: { $sum: 1 }, value: { $sum: "$dealValue" } } },
    ]);
    const map = new Map<string, { count: number; value: number }>(rows.map((r: any) => [r._id, { count: r.count, value: r.value }]));
    const byStatus = DISPOSITION_STATUSES.map((status) => ({ status, count: map.get(status)?.count || 0, value: map.get(status)?.value || 0 }));
    return res.json({ byStatus, total: byStatus.reduce((s, b) => s + b.count, 0) });
  } catch (err) {
    logger.error("leads GET /reports/by-status error", { err });
    return res.status(500).json({ error: "Failed to load status report." });
  }
});

// ═══════════════════════════════════════════════════════════════
// Command center aggregates (ask: CRM command center)
// ═══════════════════════════════════════════════════════════════
// Everything below is a Mongo aggregation over the leads (and activities /
// opportunities) collections — the dashboard never pulls lead rows. All
// share EFFECTIVE_STATUS_EXPR (disposition status, legacy stage as the
// fallback) and createdAtFilter (dateFrom / dateTo on createdAt).

/** Effective LEAD status (the v2 taxonomy): stored status, else the legacy
 *  stage through the same table the model's pre-validate uses. */
const EFFECTIVE_LEAD_STATUS_EXPR = {
  $switch: {
    branches: [
      { case: { $in: ["$status", ["NEW", "ASSIGNED", "CONTACTED", "ENGAGED", "QUALIFIED", "CONVERTED", "NURTURE", "LOST"]] }, then: "$status" },
      { case: { $in: ["$stage", ["email_sent", "contacted", "follow_up"]] }, then: "CONTACTED" },
      { case: { $eq: ["$stage", "demo_scheduled"] }, then: "ENGAGED" },
      { case: { $in: ["$stage", ["proposal_sent", "negotiation", "won"]] }, then: "CONVERTED" },
      { case: { $eq: ["$stage", "lost"] }, then: "LOST" },
    ],
    default: "NEW",
  },
};

// Funnel step predicates, cumulative by construction (each implies the previous).
const STEP_CONTACTED = { $or: [{ $not: { $in: ["$effLead", ["NEW", "ASSIGNED"]] } }, { $ne: ["$dispositionAt", null] }] };
const STEP_INTERESTED = {
  $or: [
    { $eq: ["$disposition", "Interested"] },
    { $in: ["$effStatus", ["In-progress", "Won"]] },
    { $in: ["$effLead", ["ENGAGED", "QUALIFIED", "CONVERTED"]] },
  ],
};
const STEP_OPPORTUNITY = { $or: [{ $ne: ["$opportunityId", null] }, { $eq: ["$effLead", "CONVERTED"] }, { $eq: ["$effStatus", "Won"] }] };
const STEP_WON = { $eq: ["$effStatus", "Won"] };
const IS_OPEN = { $in: ["$effStatus", ["Open", "In-progress"]] };
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

// ── GET /reports/funnel ──────────────────────────────────────────
// lead → contacted → interested → opportunity → won for leads created in the
// range, with each step's conversion from the previous step and from the top.
router.get("/reports/funnel", async (req, res) => {
  try {
    const rows = await Lead.aggregate([
      { $match: createdAtFilter(req.query as AnyObj) },
      { $addFields: { effStatus: EFFECTIVE_STATUS_EXPR, effLead: EFFECTIVE_LEAD_STATUS_EXPR } },
      {
        $group: {
          _id: null,
          leads: { $sum: 1 },
          contacted: { $sum: { $cond: [STEP_CONTACTED, 1, 0] } },
          interested: { $sum: { $cond: [STEP_INTERESTED, 1, 0] } },
          opportunity: { $sum: { $cond: [STEP_OPPORTUNITY, 1, 0] } },
          won: { $sum: { $cond: [STEP_WON, 1, 0] } },
          wonValue: { $sum: { $cond: [STEP_WON, "$dealValue", 0] } },
        },
      },
    ]);
    const r = rows[0] || { leads: 0, contacted: 0, interested: 0, opportunity: 0, won: 0, wonValue: 0 };
    const order: Array<[string, string, number]> = [["leads", "Leads", r.leads], ["contacted", "Contacted", r.contacted], ["interested", "Interested", r.interested], ["opportunity", "Opportunity", r.opportunity], ["won", "Won", r.won]];
    const steps = order.map(([key, label, count], i) => ({
      key, label, count,
      fromPrevious: i === 0 ? null : pct(count, order[i - 1][2]),
      fromTop: i === 0 ? null : pct(count, r.leads),
    }));
    return res.json({ steps, wonValue: r.wonValue, overallConversion: pct(r.won, r.leads) });
  } catch (err) {
    logger.error("leads GET /reports/funnel error", { err });
    return res.status(500).json({ error: "Failed to load funnel." });
  }
});

// ── GET /reports/by-source ───────────────────────────────────────
// Source-to-outcome: per source (sourceChannel, else legacy source) — leads,
// contacted, interested, opportunities, won, lost, conversion %, pipeline ₹
// (open dealValue), won ₹. Same range filter as the funnel.
router.get("/reports/by-source", async (req, res) => {
  try {
    const rows = await Lead.aggregate([
      { $match: createdAtFilter(req.query as AnyObj) },
      {
        $addFields: {
          effStatus: EFFECTIVE_STATUS_EXPR,
          effLead: EFFECTIVE_LEAD_STATUS_EXPR,
          src: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$sourceChannel", ""] } }, 0] }, "$sourceChannel", { $ifNull: ["$source", "other"] }] },
        },
      },
      {
        $group: {
          _id: "$src",
          leads: { $sum: 1 },
          contacted: { $sum: { $cond: [STEP_CONTACTED, 1, 0] } },
          interested: { $sum: { $cond: [STEP_INTERESTED, 1, 0] } },
          opportunities: { $sum: { $cond: [STEP_OPPORTUNITY, 1, 0] } },
          won: { $sum: { $cond: [STEP_WON, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ["$effStatus", "Lost"] }, 1, 0] } },
          wonValue: { $sum: { $cond: [STEP_WON, "$dealValue", 0] } },
          pipelineValue: { $sum: { $cond: [IS_OPEN, "$dealValue", 0] } },
        },
      },
      { $sort: { leads: -1, _id: 1 } },
    ]);
    const sources = rows.map((r: any) => ({
      source: r._id || "other",
      leads: r.leads, contacted: r.contacted, interested: r.interested, opportunities: r.opportunities, won: r.won, lost: r.lost,
      wonValue: r.wonValue, pipelineValue: r.pipelineValue,
      conversion: pct(r.won, r.leads),
    }));
    return res.json({ sources, total: sources.reduce((s, r) => s + r.leads, 0) });
  } catch (err) {
    logger.error("leads GET /reports/by-source error", { err });
    return res.status(500).json({ error: "Failed to load source report." });
  }
});

// ── GET /reports/activity?todayStart=&tz=&days=7 ─────────────────
// Team activity logged today (LeadActivity rows by type since the caller's
// start of day) plus a per-day total over the trailing `days` for the trend.
router.get("/reports/activity", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const todayStartRaw = q.todayStart ? new Date(String(q.todayStart)) : null;
    const todayStart = todayStartRaw && !isNaN(todayStartRaw.getTime()) ? todayStartRaw : new Date(new Date().setHours(0, 0, 0, 0));
    const tz = typeof q.tz === "string" && q.tz ? q.tz : "UTC";
    const days = Math.min(31, Math.max(1, parseInt(String(q.days || "7"), 10) || 7));
    const now = new Date();
    const trendFrom = new Date(now.getTime() - days * 86_400_000);

    let byType: any[];
    let trendRows: any[];
    let fmt: Intl.DateTimeFormat;
    try {
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      [byType, trendRows] = await Promise.all([
        LeadActivity.aggregate([{ $match: { createdAt: { $gte: todayStart } } }, { $group: { _id: "$type", count: { $sum: 1 } } }]),
        LeadActivity.aggregate([
          { $match: { createdAt: { $gte: trendFrom } } },
          { $addFields: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: tz } } } },
          { $group: { _id: "$day", count: { $sum: 1 } } },
        ]),
      ]);
    } catch {
      return res.status(400).json({ error: "Unknown timezone." });
    }
    const today: Record<string, number> = {};
    for (const r of byType) today[r._id] = r.count;
    const trendMap = new Map<string, number>(trendRows.map((r) => [r._id, r.count]));
    const trend: Array<{ day: string; count: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = fmt.format(new Date(now.getTime() - i * 86_400_000));
      trend.push({ day, count: trendMap.get(day) || 0 });
    }
    return res.json({ today, total: byType.reduce((s: number, r: any) => s + r.count, 0), trend, todayStart: todayStart.toISOString() });
  } catch (err) {
    logger.error("leads GET /reports/activity error", { err });
    return res.status(500).json({ error: "Failed to load activity." });
  }
});

// ── GET /reports/follow-up-health?todayStart=&dueBefore= ──────────
// The Inbox's definitions, counted server-side over OPEN leads (effective
// disposition Open / In-progress):
//   dueToday    nextFollowUpDate in [todayStart, dueBefore)
//   overdue     nextFollowUpDate < now                (Inbox isOverdue)
//   noNextAction no nextFollowUpDate at all
//   slaRisk     overdue, or NEW and untouched for a day  (Inbox slaRisk)
router.get("/reports/follow-up-health", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const now = new Date();
    const todayStartRaw = q.todayStart ? new Date(String(q.todayStart)) : null;
    const todayStart = todayStartRaw && !isNaN(todayStartRaw.getTime()) ? todayStartRaw : new Date(new Date().setHours(0, 0, 0, 0));
    const dueBeforeRaw = q.dueBefore ? new Date(String(q.dueBefore)) : null;
    const dueBefore = dueBeforeRaw && !isNaN(dueBeforeRaw.getTime()) ? dueBeforeRaw : new Date(todayStart.getTime() + 86_400_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);

    const [agg, untouched] = await Promise.all([
      Lead.aggregate([
        { $addFields: { effStatus: EFFECTIVE_STATUS_EXPR } },
        { $match: { $expr: IS_OPEN } },
        {
          $group: {
            _id: null,
            open: { $sum: 1 },
            dueToday: { $sum: { $cond: [{ $and: [{ $gte: ["$nextFollowUpDate", todayStart] }, { $lt: ["$nextFollowUpDate", dueBefore] }] }, 1, 0] } },
            overdue: { $sum: { $cond: [{ $and: [{ $ne: ["$nextFollowUpDate", null] }, { $lt: ["$nextFollowUpDate", now] }] }, 1, 0] } },
            noNextAction: { $sum: { $cond: [{ $eq: [{ $ifNull: ["$nextFollowUpDate", null] }, null] }, 1, 0] } },
          },
        },
      ]),
      // NEW leads older than a day with no activity at all — the Inbox's second SLA fact.
      Lead.aggregate([
        { $addFields: { effStatus: EFFECTIVE_STATUS_EXPR, effLead: EFFECTIVE_LEAD_STATUS_EXPR } },
        { $match: { $expr: { $and: [IS_OPEN, { $eq: ["$effLead", "NEW"] }, { $lt: ["$createdAt", dayAgo] }, { $or: [{ $eq: [{ $ifNull: ["$nextFollowUpDate", null] }, null] }, { $gte: ["$nextFollowUpDate", now] }] }] } } },
        { $lookup: { from: LeadActivity.collection.name, localField: "_id", foreignField: "leadId", as: "acts", pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }] } },
        { $match: { acts: { $size: 0 } } },
        { $count: "n" },
      ]),
    ]);
    const a = agg[0] || { open: 0, dueToday: 0, overdue: 0, noNextAction: 0 };
    const newUntouched = untouched[0]?.n || 0;
    return res.json({ open: a.open, dueToday: a.dueToday, overdue: a.overdue, noNextAction: a.noNextAction, newUntouched, slaRisk: a.overdue + newUntouched });
  } catch (err) {
    logger.error("leads GET /reports/follow-up-health error", { err });
    return res.status(500).json({ error: "Failed to load follow-up health." });
  }
});

// ── GET /reports/kpis?dateFrom=&dateTo=&todayStart= ──────────────
// Ribbon numbers. newLeads carries a prior-period value ONLY when the range
// is bounded on both ends (an equally-sized window immediately before it);
// otherwise `prior` is null and the client shows no delta — never a made-up
// percentage. hot = the server's own temperature rule (computeTemperature)
// over open leads; pipelineValue = open dealValue; openOpportunities from the
// opportunities collection.
router.get("/reports/kpis", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const now = new Date();
    const range = createdAtFilter(q);
    const from = range.createdAt?.$gte as Date | undefined;
    const to = range.createdAt?.$lte as Date | undefined;
    const todayStartRaw = q.todayStart ? new Date(String(q.todayStart)) : null;
    const startOfToday = todayStartRaw && !isNaN(todayStartRaw.getTime()) ? todayStartRaw : new Date(new Date().setHours(0, 0, 0, 0));
    const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);

    let prior: AnyObj | null = null;
    if (from && to && to.getTime() > from.getTime()) {
      const len = to.getTime() - from.getTime();
      prior = { createdAt: { $gte: new Date(from.getTime() - len - 1), $lt: from } };
    }

    const [current, priorCount, openAgg, hotAgg, oppAgg] = await Promise.all([
      Lead.countDocuments(range),
      prior ? Lead.countDocuments(prior) : Promise.resolve(null),
      Lead.aggregate([
        { $addFields: { effStatus: EFFECTIVE_STATUS_EXPR } },
        { $match: { $expr: IS_OPEN } },
        { $group: { _id: null, count: { $sum: 1 }, value: { $sum: "$dealValue" } } },
      ]),
      Lead.aggregate([
        { $addFields: { effStatus: EFFECTIVE_STATUS_EXPR } },
        { $match: { $expr: IS_OPEN } },
        { $lookup: { from: LeadActivity.collection.name, localField: "_id", foreignField: "leadId", as: "last", pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 1 }, { $project: { createdAt: 1 } }] } },
        {
          $match: {
            $expr: {
              $or: [
                { $and: [{ $ne: [{ $ifNull: ["$nextFollowUpDate", null] }, null] }, { $lt: ["$nextFollowUpDate", startOfToday] }] },
                { $and: [{ $in: ["$stage", Array.from(LATE_STAGES)] }, { $gte: [{ $ifNull: [{ $arrayElemAt: ["$last.createdAt", 0] }, new Date(0)] }, threeDaysAgo] }] },
              ],
            },
          },
        },
        { $count: "n" },
      ]),
      Opportunity.aggregate([
        { $match: { stage: { $nin: ["closed_won", "closed_lost", "active_partner"] } } },
        { $group: { _id: null, count: { $sum: 1 }, value: { $sum: "$dealValue" } } },
      ]),
    ]);

    return res.json({
      newLeads: { current, prior: priorCount },
      hot: hotAgg[0]?.n || 0,
      open: openAgg[0]?.count || 0,
      pipelineValue: openAgg[0]?.value || 0,
      openOpportunities: { count: oppAgg[0]?.count || 0, value: oppAgg[0]?.value || 0 },
      period: from && to ? { from: from.toISOString(), to: to.toISOString(), prior: prior ? { from: prior.createdAt.$gte.toISOString(), to: prior.createdAt.$lt.toISOString() } : null } : null,
    });
  } catch (err) {
    logger.error("leads GET /reports/kpis error", { err });
    return res.status(500).json({ error: "Failed to load KPIs." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 4c — GET /reports/daily?days=30  (Day-wise snapshot, ask #10)
// ═══════════════════════════════════════════════════════════════
// Leads created per day for the last N days (default 30, max 92), and how
// many of those are won today — the same "won" reading as /reports/monthly.
// Days are bucketed in the caller's timezone (`tz`, IANA, default UTC) and
// every day in the window is present, zero-filled.
router.get("/reports/daily", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const days = Math.min(92, Math.max(1, parseInt(String(q.days || "30"), 10) || 30));
    const tz = typeof q.tz === "string" && q.tz ? q.tz : "UTC";
    const now = new Date();
    const from = new Date(now.getTime() - (days - 1) * 86_400_000);
    from.setUTCHours(0, 0, 0, 0);
    // One extra day of slack so a tz ahead of UTC still gets its first bucket.
    const matchFrom = new Date(from.getTime() - 86_400_000);

    let rows: any[];
    let fmt: Intl.DateTimeFormat;
    try {
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      rows = await Lead.aggregate([
        { $match: { createdAt: { $gte: matchFrom } } },
        { $addFields: { effStatus: EFFECTIVE_STATUS_EXPR, day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: tz } } } },
        { $group: { _id: "$day", created: { $sum: 1 }, won: { $sum: { $cond: [{ $eq: ["$effStatus", "Won"] }, 1, 0] } } } },
      ]);
    } catch {
      return res.status(400).json({ error: "Unknown timezone." });
    }
    const map = new Map<string, { created: number; won: number }>(rows.map((r) => [r._id, { created: r.created, won: r.won }]));
    const daily: Array<{ day: string; created: number; won: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = fmt.format(new Date(now.getTime() - i * 86_400_000));
      daily.push({ day, created: map.get(day)?.created || 0, won: map.get(day)?.won || 0 });
    }
    return res.json({ daily, days, tz });
  } catch (err) {
    logger.error("leads GET /reports/daily error", { err });
    return res.status(500).json({ error: "Failed to load daily report." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 5 — GET /reports/monthly  (Month-wise snapshot, ask #10)
// ═══════════════════════════════════════════════════════════════
// Leads created per month over the last 12, and how many of those are won /
// lost today (effective disposition status). Every month is present,
// zero-filled; `key` is YYYY-MM for stable charting, `month` the label.
router.get("/reports/monthly", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const months = Math.min(36, Math.max(1, parseInt(String(q.months || "12"), 10) || 12));
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    const rows = await Lead.aggregate([
      { $match: { createdAt: { $gte: start } } },
      { $addFields: { effStatus: EFFECTIVE_STATUS_EXPR } },
      {
        $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          new: { $sum: 1 },
          won: { $sum: { $cond: [{ $eq: ["$effStatus", "Won"] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ["$effStatus", "Lost"] }, 1, 0] } },
        },
      },
    ]);
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const map = new Map<string, any>(rows.map((m: any) => [`${m._id.year}-${String(m._id.month).padStart(2, "0")}`, m]));
    const monthly: Array<{ key: string; month: string; new: number; won: number; lost: number }> = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const m = map.get(key);
      monthly.push({ key, month: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, new: m?.new || 0, won: m?.won || 0, lost: m?.lost || 0 });
    }
    return res.json({ monthly });
  } catch (err) {
    logger.error("leads GET /reports/monthly error", { err });
    return res.status(500).json({ error: "Failed to load monthly report." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 5b — GET /reports/owner-status  (Owner Wise Lead Status Report)
// ═══════════════════════════════════════════════════════════════
// Read-only. The snapshot is keyed on last_activity_date =
//   max(latest LeadActivity.createdAt, Lead.createdAt)
// which is computed per lead FIRST, then the date-range filter is applied to it
// (the other filters are plain lead fields, matched in Mongo up front).
// Optional multi-value params (comma-separated or repeated): dateFrom, dateTo
// (on last_activity_date), assignedTo, stage, source, type.
// Sits beside /reports/* so it inherits requireAuth + requireHouse + leads access.
router.get("/reports/owner-status", async (req, res) => {
  try {
    const q = req.query as AnyObj;

    const toArr = (v: unknown): string[] => {
      if (v == null) return [];
      const raw = Array.isArray(v) ? v : String(v).split(",");
      return raw.map((s) => String(s).trim()).filter(Boolean);
    };

    const assignedToF = toArr(q.assignedTo).filter((s) => mongoose.isValidObjectId(s));
    const stageF = toArr(q.stage).filter((s) => (LEAD_STAGES as readonly string[]).includes(s));
    const sourceF = toArr(q.source);
    const typeF = toArr(q.type).filter((s) => s === "company" || s === "individual");

    const dateFrom = q.dateFrom ? new Date(String(q.dateFrom)) : null;
    const dateTo = q.dateTo ? new Date(String(q.dateTo)) : null;
    if (dateFrom && !isNaN(dateFrom.getTime())) dateFrom.setHours(0, 0, 0, 0);
    if (dateTo && !isNaN(dateTo.getTime())) dateTo.setHours(23, 59, 59, 999);
    // Aggregation extracted to services/ownerStatusReport so the Sales Pulse
    // snapshot reuses identical numbers. The route only parses/validates the
    // query (above) and shapes the response (the service returns it whole).
    // Slice 2: this route feeds pages/crm/Reports.tsx, which indexes the
    // snapshot by the 9 legacy stage keys — pin the legacy vocabulary until
    // the frontend is taught the new one (risk M12). Sales Pulse follows the
    // flag through the same builder.
    const report = await buildOwnerStatusReport(
      {
        assignedTo: assignedToF,
        stage: stageF,
        source: sourceF,
        type: typeF,
        dateFrom,
        dateTo,
      },
      { vocabulary: "legacy" },
    );

    return res.json(report);
  } catch (err) {
    logger.error("leads GET /reports/owner-status error", { err });
    return res.status(500).json({ error: "Failed to load owner-status report." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 6 — GET /export  (XLSX)
// ═══════════════════════════════════════════════════════════════

router.get("/export", async (req, res) => {
  try {
    // Shared resolver: OWN scope + optional assignedTo/stage/source/type and a
    // createdAt (default) or last_activity_date (dateBasis=last_activity) range.
    const leads = (await resolveExportLeads(req)).slice(0, 5000);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Leads");
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const columns = [
      "Lead Code", "Type", "Company Name", "Industry", "Company Size",
      "Location", "Contact Name", "Contact Phone", "Contact Email",
      "Designation", "Source", "Stage", "Budget", "Deal Value", "Currency",
      "Assigned To", "Next Follow Up", "Lost Reason", "Won Date",
      "Created At", "Notes",
    ];

    const headerRow = sheet.addRow(columns);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } };
    headerRow.alignment = { vertical: "middle" };

    const colWidths = [14, 10, 22, 18, 12, 16, 20, 16, 24, 16, 12, 14, 12, 12, 10, 18, 16, 20, 14, 18, 30];
    colWidths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

    for (const l of leads as any[]) {
      sheet.addRow([
        l.leadCode || "",
        l.type || "",
        l.companyName || "",
        l.industry || "",
        l.companySize || "",
        l.location || "",
        l.contactName || "",
        l.contactPhone || "",
        l.contactEmail || "",
        l.contactDesignation || "",
        l.source || "",
        l.stage || "",
        l.budget || "",
        l.dealValue || 0,
        l.currency || "INR",
        l.assignedToName || "",
        fmtDate(l.nextFollowUpDate),
        l.lostReason || "",
        fmtDate(l.wonDate),
        fmtDate(l.createdAt),
        l.notes || "",
      ]);
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="leads-export.xlsx"');

    await workbook.xlsx.write(res as any);
    res.end();
  } catch (err) {
    logger.error("leads GET /export error", { err });
    return res.status(500).json({ error: "Export failed." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 6b — GET /export/activities  (XLSX — all activities)
// ═══════════════════════════════════════════════════════════════

router.get("/export/activities", async (req, res) => {
  try {
    // When any report filter is present, return activities whose OWN createdAt is
    // in the date range, scoped to leads matching owner/status/source/type (the
    // lead's last_activity is NOT used to gate activities here). With NO params it
    // stays "all activities" — unchanged behavior for existing callers.
    const q = req.query as AnyObj;
    const hasFilter = !!(q.assignedTo || q.stage || q.source || q.type || q.dateFrom || q.dateTo);

    let activities: any[];
    if (hasFilter) {
      // Lead scope: owner/status/source/type + OWN only — no date gating on leads.
      const scopedLeads = await resolveExportLeads(req, { ignoreDateFilter: true });
      const scopedIds = scopedLeads.map((l) => l._id);

      // Date range applied to each activity's own createdAt.
      const aFrom = q.dateFrom ? new Date(String(q.dateFrom)) : null;
      const aTo = q.dateTo ? new Date(String(q.dateTo)) : null;
      if (aFrom && !isNaN(aFrom.getTime())) aFrom.setHours(0, 0, 0, 0);
      if (aTo && !isNaN(aTo.getTime())) aTo.setHours(23, 59, 59, 999);

      const actFilter: AnyObj = { leadId: { $in: scopedIds } };
      if ((aFrom && !isNaN(aFrom.getTime())) || (aTo && !isNaN(aTo.getTime()))) {
        actFilter.createdAt = {};
        if (aFrom && !isNaN(aFrom.getTime())) actFilter.createdAt.$gte = aFrom;
        if (aTo && !isNaN(aTo.getTime())) actFilter.createdAt.$lte = aTo;
      }

      activities = scopedIds.length
        ? ((await LeadActivity.find(actFilter).sort({ createdAt: -1 }).lean()) as any[])
        : [];
    } else {
      activities = (await LeadActivity.find({}).sort({ createdAt: -1 }).lean()) as any[];
    }

    const leadIds = [...new Set(activities.map((a: any) => a.leadId?.toString()).filter(Boolean))];

    const leads = await Lead.find({ _id: { $in: leadIds } })
      .select("leadCode contactName companyName stage")
      .lean();

    const leadMap = new Map((leads as any[]).map((l) => [l._id.toString(), l]));

    const missingUserIds = [...new Set(
      (activities as any[])
        .filter((a) => !a.createdByName && a.createdBy)
        .map((a) => a.createdBy?.toString())
        .filter(Boolean),
    )];

    const userDocs = missingUserIds.length > 0
      ? await User.find({ _id: { $in: missingUserIds } })
          .select("_id name firstName lastName email")
          .lean()
      : [];

    const userMap = new Map(
      (userDocs as any[]).map((u) => [
        u._id.toString(),
        u.name ||
          `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
          u.email ||
          "Unknown",
      ]),
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Lead Activities");

    sheet.columns = [
      { header: "Lead Code", key: "leadCode", width: 18 },
      { header: "Company", key: "company", width: 25 },
      { header: "Contact Name", key: "contact", width: 22 },
      { header: "Lead Stage", key: "stage", width: 18 },
      { header: "Activity Type", key: "type", width: 18 },
      { header: "Note / Description", key: "note", width: 45 },
      { header: "From Stage", key: "fromStage", width: 18 },
      { header: "To Stage", key: "toStage", width: 18 },
      { header: "Done By", key: "createdByName", width: 22 },
      { header: "Date & Time", key: "createdAt", width: 22 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } };

    for (const activity of activities as any[]) {
      const lead = leadMap.get(activity.leadId?.toString());
      sheet.addRow({
        leadCode: lead?.leadCode || "—",
        company: lead?.companyName || "—",
        contact: lead?.contactName || "—",
        stage: lead?.stage || "—",
        type: activity.type || "—",
        note: activity.note || "—",
        fromStage: activity.fromStage || "—",
        toStage: activity.toStage || "—",
        createdByName: activity.createdByName ||
          userMap.get(activity.createdBy?.toString()) ||
          "—",
        createdAt: activity.createdAt
          ? new Date(activity.createdAt).toLocaleString("en-IN", {
              day: "2-digit", month: "short", year: "numeric",
              hour: "2-digit", minute: "2-digit",
            })
          : "—",
      });
    }

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (rowNumber % 2 === 0) {
        row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    });

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="lead-activities-${Date.now()}.xlsx"`);
    return res.send(buffer);
  } catch (err) {
    logger.error("leads GET /export/activities error", { err });
    return res.status(500).json({ error: "Export failed." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 6c — GET /counts-by-stage
// ═══════════════════════════════════════════════════════════════

router.get("/counts-by-stage", async (_req, res) => {
  try {
    const agg = await Lead.aggregate([
      { $group: { _id: "$stage", count: { $sum: 1 } } },
    ]);
    const counts: Record<string, number> = {};
    for (const item of agg as Array<{ _id: string; count: number }>) {
      if (item._id) counts[item._id] = item.count;
    }
    return res.json(counts);
  } catch (err) {
    logger.error("leads GET /counts-by-stage error", { err });
    return res.status(500).json({ error: "Failed to load stage counts." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 6d — GET /pipeline-summary  (read-only)
// ═══════════════════════════════════════════════════════════════
// Powers the pipeline KPI strip and rich kanban column headers. Per-stage
// rollups { count, sumValue, followupsDue } plus board-level KPIs. HOUSE-gated
// by the router-level requireHouse above. MUST stay ABOVE GET /:id, or Express
// captures the literal path with the :id param route.
//
// NOTE: sumValue / openPipelineValue sum dealValue across mixed currencies
// (INR/USD/AED) without conversion — this mirrors GET /reports/summary, which
// the existing reports already do. The frontend renders these as INR-dominant.
router.get("/pipeline-summary", async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const CLOSED = ["won", "lost"];

    const [
      stageAgg,
      dueAgg,
      openAgg,
      wonMonthAgg,
      overdueFollowups,
      // ── Trend inputs (real timestamps only — no fabrication) ──
      activeAddedThisWeek, // leads created in the last 7 days, still open
      wonThisMonthCount, // won/lost terminal events sourced from LeadActivity
      lostThisMonthCount,
      wonLastMonthCount,
      lostLastMonthCount,
    ] = await Promise.all([
        // per-stage lead count + summed deal value
        Lead.aggregate([
          { $group: { _id: "$stage", count: { $sum: 1 }, sumValue: { $sum: "$dealValue" } } },
        ]),
        // per-stage follow-ups due (date set and not in the future)
        Lead.aggregate([
          { $match: { nextFollowUpDate: { $ne: null, $lte: now } } },
          { $group: { _id: "$stage", due: { $sum: 1 } } },
        ]),
        // open pipeline: summed value + active count (everything except won/lost)
        Lead.aggregate([
          { $match: { stage: { $nin: CLOSED } } },
          { $group: { _id: null, value: { $sum: "$dealValue" }, count: { $sum: 1 } } },
        ]),
        // won value this calendar month (by wonDate)
        Lead.aggregate([
          { $match: { stage: "won", wonDate: { $gte: startOfMonth } } },
          { $group: { _id: null, value: { $sum: "$dealValue" } } },
        ]),
        // overdue follow-ups across open stages (strictly past due)
        Lead.countDocuments({ stage: { $nin: CLOSED }, nextFollowUpDate: { $lt: now } }),
        // trend inputs
        Lead.countDocuments({ stage: { $nin: CLOSED }, createdAt: { $gte: weekAgo } }),
        LeadActivity.countDocuments({ type: "won", createdAt: { $gte: startOfMonth } }),
        LeadActivity.countDocuments({ type: "lost", createdAt: { $gte: startOfMonth } }),
        LeadActivity.countDocuments({ type: "won", createdAt: { $gte: startOfLastMonth, $lt: startOfMonth } }),
        LeadActivity.countDocuments({ type: "lost", createdAt: { $gte: startOfLastMonth, $lt: startOfMonth } }),
      ]);

    const byStage = Object.fromEntries((stageAgg as any[]).map((s) => [s._id, s]));
    const dueByStage = Object.fromEntries((dueAgg as any[]).map((s) => [s._id, s.due]));

    const perStage: Record<
      string,
      { count: number; sumValue: number; followupsDue: number }
    > = {};
    for (const stage of LEAD_STAGES) {
      perStage[stage] = {
        count: byStage[stage]?.count ?? 0,
        sumValue: byStage[stage]?.sumValue ?? 0,
        followupsDue: dueByStage[stage] ?? 0,
      };
    }

    // All-time win rate (headline) from current stage distribution.
    const wonAll = byStage.won?.count ?? 0;
    const lostAll = byStage.lost?.count ?? 0;
    const winRatePctCurrent =
      wonAll + lostAll > 0 ? Math.round((wonAll / (wonAll + lostAll)) * 1000) / 10 : 0;

    // Win-rate trend: this month vs last month, from terminal LeadActivity
    // events. Null (→ no delta shown) when a month had no closes.
    const wrThis =
      wonThisMonthCount + lostThisMonthCount > 0
        ? (wonThisMonthCount / (wonThisMonthCount + lostThisMonthCount)) * 100
        : null;
    const wrLast =
      wonLastMonthCount + lostLastMonthCount > 0
        ? (wonLastMonthCount / (wonLastMonthCount + lostLastMonthCount)) * 100
        : null;
    const winRateTrendPp =
      wrThis !== null && wrLast !== null
        ? Math.round((wrThis - wrLast) * 10) / 10
        : null;

    return res.json({
      perStage,
      kpis: {
        openPipelineValue: openAgg[0]?.value ?? 0,
        activeCount: openAgg[0]?.count ?? 0,
        wonThisMonthValue: wonMonthAgg[0]?.value ?? 0,
        overdueFollowups,
      },
      trends: {
        winRatePctCurrent,
        winRateTrendPp, // percentage points, this month vs last; null if undetermined
        activeAddedThisWeek, // open leads created in the last 7 days
        wonThisMonthCount,
        wonLastMonthCount,
      },
    });
  } catch (err) {
    logger.error("leads GET /pipeline-summary error", { err });
    return res.status(500).json({ error: "Failed to load pipeline summary." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 7 — GET /:id
// ═══════════════════════════════════════════════════════════════

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const lead = await Lead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    const activities = await LeadActivity.find({ leadId: lead._id })
      .sort({ createdAt: -1 })
      .lean();

    // Slice 2: the converted-to Opportunity rides along under the flag so a
    // detail page can show the deal without a second round trip.
    const opportunity =
      isCrmV2OpportunityEnabled() && (lead as any).opportunityId
        ? await Opportunity.findById((lead as any).opportunityId).lean()
        : null;

    return res.json({ lead, activities, ...(opportunity ? { opportunity } : {}) });
  } catch (err) {
    logger.error("leads GET /:id error", { err });
    return res.status(500).json({ error: "Failed to get lead." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 8 — PUT /:id  (update fields)
// ═══════════════════════════════════════════════════════════════

router.put("/:id", async (req, res) => {
  try {
    if (!canWrite((req as any).leadsAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    if (lead.stage === "won" || lead.stage === "lost") {
      return res.status(400).json({ error: "Cannot edit a closed lead." });
    }

    const PROTECTED = new Set([
      "_id", "leadCode", "stage", "createdBy", "createdAt",
      "wonDate", "lostReason", "onboardingInviteSent",
      // companyId is resolved server-side from companyName/type below — never
      // accept it raw from the client.
      "companyId",
      // Slice 2: derived by the model hook / the split service, never client-set.
      "status", "opportunityId", "workspaceId",
      // Disposition slice: derived from the pipeline set by POST /:id/disposition.
      "pipelineId", "disposition", "subDisposition", "dispositionStage", "dispositionStatus", "dispositionAt",
    ]);

    const body = req.body as AnyObj;
    const hadFollowUpDate = !!(lead as any).nextFollowUpDate;
    for (const key of Object.keys(body)) {
      if (!PROTECTED.has(key)) {
        (lead as any)[key] = body[key];
      }
    }

    // Re-anchor on the (post-edit) company. Null it when the lead is now an
    // individual or its company name was cleared; otherwise resolve-or-create
    // and re-point (handles a renamed company on the lead).
    const companyName = String(lead.companyName || "").trim();
    if (lead.type === "individual" || !companyName) {
      lead.companyId = null;
    } else {
      const co = await resolveOrCreateCompany(
        {
          name: companyName,
          industry: lead.industry,
          companySize: lead.companySize,
          location: lead.location,
          website: lead.website,
          gstin: lead.gstin,
        },
        lead.createdBy as mongoose.Types.ObjectId | undefined
      );
      lead.companyId = co?._id ?? null;
    }

    await lead.save();

    // Task automation for next follow-up date change
    if (body.nextFollowUpDate && lead.nextFollowUpDate) {
      const followUpDate = new Date(body.nextFollowUpDate);
      if (!isNaN(followUpDate.getTime())) {
        triggerTaskAutomation("lead.next_followup", {
          workspaceId: SYSTEM_WORKSPACE_ID,
          entityType: "LEAD",
          entityId: lead._id as mongoose.Types.ObjectId,
          entityRef: lead.leadCode,
          ownerId: lead.assignedTo,
          eventDate: followUpDate,
          variables: { leadName: lead.contactName || lead.companyName || "Lead" },
        }).catch(() => {});
      }
    }

    return res.json({ lead });
  } catch (err) {
    logger.error("leads PUT /:id error", { err });
    return res.status(500).json({ error: "Failed to update lead." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 9 — PUT /:id/stage
// ═══════════════════════════════════════════════════════════════

router.put("/:id/stage", async (req, res) => {
  try {
    if (!canWrite((req as any).leadsAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const { stage, note, nextFollowUpDate } = req.body as AnyObj;

    if (!(LEAD_STAGES as readonly string[]).includes(stage)) {
      return res.status(400).json({
        error: `Invalid stage. Must be one of: ${LEAD_STAGES.join(", ")}`,
      });
    }

    if (stage === "follow_up" && !nextFollowUpDate) {
      return res.status(400).json({ error: "nextFollowUpDate is required for follow_up stage." });
    }

    if (stage === "follow_up" && (!note || !String(note).trim())) {
      return res.status(400).json({ error: "A note is required when moving a lead to follow_up." });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    const user = (req as any).user as AnyObj;
    const fromStage = lead.stage;
    const flagOn = isCrmV2OpportunityEnabled();
    const fromStatus = flagOn ? effectiveLeadStatus(lead) : undefined;

    lead.stage = stage as LeadStage;
    if (stage === "follow_up" && nextFollowUpDate) {
      lead.nextFollowUpDate = new Date(nextFollowUpDate);
    }
    await lead.save();

    // fromStage/toStage keep the legacy vocabulary (what the frontend sent and
    // renders). Under the flag the same row also records the LEAD-status
    // transition in the new taxonomy and names its subject.
    await LeadActivity.create({
      leadId: lead._id,
      type: "stage_change" as ActivityType,
      note: note || `Stage changed from ${fromStage} to ${stage}`,
      fromStage: String(fromStage),
      toStage: String(stage),
      ...(flagOn
        ? { subject: { type: "LEAD", id: lead._id }, fromStatus, toStatus: effectiveLeadStatus(lead) }
        : {}),
      createdBy: mongoose.isValidObjectId(userId(user))
        ? new mongoose.Types.ObjectId(userId(user))
        : undefined,
      createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
    });

    // Slice 2: under the flag the split service owns the Opportunity side
    // effects AND the trigger (new keys, legacy aliases); the legacy stage
    // map below is only used when the flag is off.
    const split = await runOpportunitySplit(lead, user);

    // Task automation hook for stage transitions (legacy keys, flag off)
    const stageMap: Record<string, string> = {
      contacted: "lead.stage_contacted",
      demo_scheduled: "lead.stage_demo",
      proposal_sent: "lead.stage_proposal",
    };
    const stageTrigger = flagOn ? undefined : stageMap[stage];
    if (stageTrigger) {
      triggerTaskAutomation(stageTrigger, {
        workspaceId: SYSTEM_WORKSPACE_ID,
        entityType: "LEAD",
        entityId: lead._id as mongoose.Types.ObjectId,
        entityRef: lead.leadCode,
        ownerId: lead.assignedTo,
        variables: { leadName: lead.contactName || lead.companyName || "Lead" },
      }).catch(() => {});
    }

    return res.json({ lead, ...(split.opportunityId ? { opportunityId: split.opportunityId } : {}) });
  } catch (err) {
    logger.error("leads PUT /:id/stage error", { err });
    return res.status(500).json({ error: "Failed to update stage." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 9b — disposition capture (CRM_V2_DISPOSITION)
// ═══════════════════════════════════════════════════════════════
// GET  /:id/dispositions  → the lead's pipeline, its grouped disposition set
//                           and the lead's current (or fresh) disposition.
// POST /:id/disposition   → { subDisposition, note?, nextFollowUpDate? }
//                           derives stage/status, appends the activity, fires
//                           / syncs the shadow opportunity (services/disposition.ts)
//                           and returns the cascade so the UI can show it.
// Flag off: 404 — the surface does not exist.

router.get("/:id/dispositions", async (req, res) => {
  if (!isCrmV2DispositionEnabled()) return res.status(404).json({ error: "Not found." });
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid lead ID." });
    const lead = await Lead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ error: "Lead not found." });
    const user = (req as any).user as AnyObj;
    const pipeline = await resolvePipelineForLead(lead as any);
    return res.json({
      pipeline: { _id: String(pipeline._id), key: pipeline.key, name: pipeline.name, opportunityPipeline: pipeline.opportunityPipeline },
      canWork: canWorkPipeline({ id: userId(user), roles: user.roles }, pipeline) && canWrite((req as any).leadsAccess),
      groups: groupedSet(pipeline).map((g) => ({
        disposition: g.disposition,
        subs: g.subs.map((e) => ({
          subDisposition: e.subDisposition, stage: e.stage, status: e.status,
          nextTouch: e.nextTouch, opportunityEffect: e.opportunityEffect, opportunityStage: e.opportunityStage ?? null,
        })),
      })),
      current: snapshotOf(lead as any),
      opportunityId: (lead as any).opportunityId ? String((lead as any).opportunityId) : null,
    });
  } catch (err) {
    logger.error("leads GET /:id/dispositions error", { err });
    return res.status(500).json({ error: "Failed to load dispositions." });
  }
});

router.post("/:id/disposition", async (req, res) => {
  if (!isCrmV2DispositionEnabled()) return res.status(404).json({ error: "Not found." });
  try {
    if (!canWrite((req as any).leadsAccess)) return res.status(403).json({ error: "Write access required." });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid lead ID." });
    const { subDisposition, note, nextFollowUpDate } = req.body as AnyObj;
    if (!subDisposition || !String(subDisposition).trim()) return res.status(400).json({ error: "subDisposition is required." });

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    const user = (req as any).user as AnyObj;
    const actorName = user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System";
    const result = await applyDisposition(lead, {
      subDisposition: String(subDisposition),
      note: note ? String(note) : "",
      nextFollowUpDate: nextFollowUpDate || null,
      actor: { id: userId(user), roles: user.roles, name: actorName },
    });
    return res.json({
      lead: result.lead,
      from: result.from,
      to: result.to,
      entry: { disposition: result.entry.disposition, subDisposition: result.entry.subDisposition, stage: result.entry.stage, status: result.entry.status, opportunityEffect: result.entry.opportunityEffect },
      opportunity: result.opportunity,
      contact: result.contact,
      pipeline: result.pipeline,
      activityId: result.activityId,
    });
  } catch (err: any) {
    if (err instanceof DispositionError) return res.status(err.status).json({ error: err.message });
    logger.error("leads POST /:id/disposition error", { err });
    return res.status(500).json({ error: "Failed to save disposition." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 10 — POST /:id/activity
// ═══════════════════════════════════════════════════════════════

router.post("/:id/activity", async (req, res) => {
  try {
    if (!canWrite((req as any).leadsAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const { type, note, nextFollowUpDate } = req.body as AnyObj;

    if (!(ACTIVITY_TYPES as readonly string[]).includes(type)) {
      return res.status(400).json({
        error: `Invalid type. Must be one of: ${ACTIVITY_TYPES.join(", ")}`,
      });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    const user = (req as any).user as AnyObj;

    if (type === "follow_up" && nextFollowUpDate) {
      lead.nextFollowUpDate = new Date(nextFollowUpDate);
      await lead.save();
    }

    const activity = await LeadActivity.create({
      leadId: lead._id,
      type: type as ActivityType,
      note: note || "",
      createdBy: mongoose.isValidObjectId(userId(user))
        ? new mongoose.Types.ObjectId(userId(user))
        : undefined,
      createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
    });

    return res.status(201).json({ activity });
  } catch (err) {
    logger.error("leads POST /:id/activity error", { err });
    return res.status(500).json({ error: "Failed to create activity." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 11 — POST /:id/assign
// ═══════════════════════════════════════════════════════════════

router.post("/:id/assign", async (req, res) => {
  try {
    if ((req as any).leadsAccess !== "FULL") {
      return res.status(403).json({ error: "Full access required to reassign leads." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const { userId: repId } = req.body as AnyObj;
    if (!repId || !mongoose.isValidObjectId(String(repId))) {
      return res.status(400).json({ error: "Valid userId is required." });
    }

    const rep = (await User.findById(repId).select("name").lean()) as any;
    if (!rep) return res.status(404).json({ error: "User not found." });

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    const user = (req as any).user as AnyObj;
    lead.assignedTo = new mongoose.Types.ObjectId(String(repId));
    lead.assignedToName = rep.name || "";
    await lead.save();

    await LeadActivity.create({
      leadId: lead._id,
      type: "assignment" as ActivityType,
      note: `Assigned to ${rep.name || repId}`,
      createdBy: mongoose.isValidObjectId(userId(user))
        ? new mongoose.Types.ObjectId(userId(user))
        : undefined,
      createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
    });

    // Reassignment cascade: update all open auto-tasks for this lead
    Task.updateMany(
      {
        linkedType: "LEAD",
        linkedId: lead._id,
        status: { $in: ["OPEN", "IN_PROGRESS"] },
        autoTriggerKey: { $exists: true },
      },
      { $set: { assignedTo: lead.assignedTo } }
    ).catch((err: any) => logger.error("leads assign cascade error", { err }));

    return res.json({ lead });
  } catch (err) {
    logger.error("leads POST /:id/assign error", { err });
    return res.status(500).json({ error: "Failed to assign lead." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 11b — POST /bulk-assign  (ask #8)
// ═══════════════════════════════════════════════════════════════
// Reassign up to BULK_ASSIGN_CAP leads to one rep in a single call. Same
// FULL-access gate as POST /:id/assign — reassigning other people's leads is
// a privileged action, WRITE is not enough. Per lead it does exactly what the
// single route does: set owner, write one `assignment` activity, cascade the
// open auto-tasks. Each lead is applied independently and reported: a missing
// or failing id lands in `failed` with its reason, the rest still land — the
// caller sees precisely what happened, nothing is half-applied silently.
const BULK_ASSIGN_CAP = 200;

router.post("/bulk-assign", async (req, res) => {
  try {
    if ((req as any).leadsAccess !== "FULL") {
      return res.status(403).json({ error: "Full access required to reassign leads." });
    }
    const body = req.body as AnyObj;
    const repId = String(body.assignedTo || "");
    if (!mongoose.isValidObjectId(repId)) {
      return res.status(400).json({ error: "Valid assignedTo is required." });
    }
    const rawIds: unknown[] = Array.isArray(body.leadIds) ? body.leadIds : [];
    const leadIds = Array.from(new Set(rawIds.map((v) => String(v))));
    if (leadIds.length === 0) return res.status(400).json({ error: "leadIds is required." });
    if (leadIds.length > BULK_ASSIGN_CAP) {
      return res.status(400).json({ error: `At most ${BULK_ASSIGN_CAP} leads per reassignment.` });
    }

    const repName = await resolveUserName(repId);
    if (!repName) return res.status(404).json({ error: "User not found." });

    const user = (req as any).user as AnyObj;
    const actorId = mongoose.isValidObjectId(userId(user)) ? new mongoose.Types.ObjectId(userId(user)) : undefined;
    // Actor label from the DB, not the JWT (the token carries no name).
    const actorName = (await resolveUserName(userId(user))) || user.email || "System";
    const repObjectId = new mongoose.Types.ObjectId(repId);

    const updated: Array<{ _id: string; leadCode: string; previousOwnerName: string; unchanged: boolean }> = [];
    const failed: Array<{ _id: string; reason: string }> = [];

    for (const id of leadIds) {
      if (!mongoose.isValidObjectId(id)) {
        failed.push({ _id: id, reason: "Invalid lead ID." });
        continue;
      }
      try {
        const lead = await Lead.findById(id);
        if (!lead) {
          failed.push({ _id: id, reason: "Lead not found." });
          continue;
        }
        const previousOwnerName = lead.assignedToName || "";
        const unchanged = String(lead.assignedTo || "") === repId;
        lead.assignedTo = repObjectId;
        lead.assignedToName = repName;
        await lead.save();

        await LeadActivity.create({
          leadId: lead._id,
          type: "assignment" as ActivityType,
          note: previousOwnerName && !unchanged ? `Reassigned to ${repName} (from ${previousOwnerName})` : `Assigned to ${repName}`,
          createdBy: actorId,
          createdByName: actorName,
        });

        // Reassignment cascade — identical to POST /:id/assign.
        Task.updateMany(
          {
            linkedType: "LEAD",
            linkedId: lead._id,
            status: { $in: ["OPEN", "IN_PROGRESS"] },
            autoTriggerKey: { $exists: true },
          },
          { $set: { assignedTo: lead.assignedTo } }
        ).catch((err: any) => logger.error("leads bulk-assign cascade error", { err }));

        updated.push({ _id: String(lead._id), leadCode: lead.leadCode, previousOwnerName, unchanged });
      } catch (e: any) {
        failed.push({ _id: id, reason: e?.message || "Could not reassign this lead." });
      }
    }

    return res.json({
      assignedTo: repId,
      assignedToName: repName,
      updated,
      failed,
      summary: { requested: leadIds.length, updated: updated.length, failed: failed.length },
    });
  } catch (err) {
    logger.error("leads POST /bulk-assign error", { err });
    return res.status(500).json({ error: "Failed to reassign leads." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 12 — POST /:id/win
// ═══════════════════════════════════════════════════════════════

router.post("/:id/win", async (req, res) => {
  try {
    if (!canWrite((req as any).leadsAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    const user = (req as any).user as AnyObj;

    lead.stage = "won";
    lead.wonDate = new Date();

    await lead.save();

    const createdById = mongoose.isValidObjectId(userId(user))
      ? new mongoose.Types.ObjectId(userId(user))
      : undefined;

    await LeadActivity.create({
      leadId: lead._id,
      type: "won" as ActivityType,
      note: "Lead marked as won.",
      createdBy: createdById,
      createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
    });

    // Resolve the anchor company: reuse the lead's existing companyId if set
    // (never create a second company), else resolve-or-create from the name.
    let newCompany: any = null;
    if (lead.companyId) {
      newCompany = await CRMCompany.findById(lead.companyId);
    }
    if (!newCompany && lead.companyName && lead.companyName.trim()) {
      newCompany = await resolveOrCreateCompany(
        {
          name: lead.companyName,
          industry: lead.industry,
          companySize: lead.companySize,
          location: lead.location,
          website: lead.website,
          gstin: lead.gstin,
        },
        createdById
      );
    }

    // Auto-create Contact
    const nameParts = (lead.contactName || "").trim().split(" ");
    const newContact = await CRMContact.create({
      firstName: nameParts[0] || lead.contactName,
      lastName: nameParts.slice(1).join(" ") || "",
      jobTitle: lead.contactDesignation || "",
      phone: lead.contactPhone,
      email: lead.contactEmail || "",
      companyId: newCompany?._id || null,
      companyName: lead.companyName || "",
      source: lead.source,
      notes: lead.notes || "",
      leadId: lead._id,
      assignedTo: lead.assignedTo || null,
      createdBy: createdById,
      isPrivate: false,
      status: "active",
    });

    // Update lead with conversion references. companyId and convertedToCompanyId
    // are kept aligned on the same company.
    lead.convertedToContactId = newContact._id;
    lead.convertedToCompanyId = newCompany?._id || null;
    if (newCompany?._id) lead.companyId = newCompany._id;
    await lead.save();

    await LeadActivity.create({
      leadId: lead._id,
      type: "invite_sent" as ActivityType,
      note: `Auto-converted: Contact ${newContact.firstName} linked to Company ${newCompany?.name || "N/A"}`,
      createdBy: createdById,
      createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
    });

    // Slice 2: Closed Won Opportunity + opportunity.won trigger under the flag.
    const winSplit = await runOpportunitySplit(lead, user);

    // Task automation hook (legacy key, flag off)
    if (!winSplit.triggered) triggerTaskAutomation("lead.won", {
      workspaceId: SYSTEM_WORKSPACE_ID,
      entityType: "LEAD",
      entityId: lead._id as mongoose.Types.ObjectId,
      entityRef: lead.leadCode,
      ownerId: lead.assignedTo,
      variables: { leadName: lead.contactName || lead.companyName || "Lead" },
    }).catch(() => {});

    return res.json({ lead });
  } catch (err) {
    logger.error("leads POST /:id/win error", { err });
    return res.status(500).json({ error: "Failed to mark lead as won." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 13 — POST /:id/lose
// ═══════════════════════════════════════════════════════════════

router.post("/:id/lose", async (req, res) => {
  try {
    if (!canWrite((req as any).leadsAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    const { lostReason = "" } = req.body as AnyObj;
    const user = (req as any).user as AnyObj;

    lead.stage = "lost";
    lead.lostReason = String(lostReason).trim();
    await lead.save();

    await LeadActivity.create({
      leadId: lead._id,
      type: "lost" as ActivityType,
      note: `Lost: ${lostReason || "No reason provided"}`,
      createdBy: mongoose.isValidObjectId(userId(user))
        ? new mongoose.Types.ObjectId(userId(user))
        : undefined,
      createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
    });

    // Slice 2: under the flag a lead that ever reached the commercial process
    // closes its Opportunity as lost; otherwise it is lost at the lead grain.
    await runOpportunitySplit(lead, user);

    return res.json({ lead });
  } catch (err) {
    logger.error("leads POST /:id/lose error", { err });
    return res.status(500).json({ error: "Failed to mark lead as lost." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 13b — POST /:id/convert
// ═══════════════════════════════════════════════════════════════

router.post("/:id/convert", async (req, res) => {
  try {
    if (!canWrite((req as any).leadsAccess)) {
      return res.status(403).json({ error: "Write access required." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    if (lead.convertedToContactId) {
      return res.status(409).json({
        error: "Lead already converted.",
        contactId: String(lead.convertedToContactId),
      });
    }

    const user = (req as any).user as AnyObj;
    const createdById = mongoose.isValidObjectId(userId(user))
      ? new mongoose.Types.ObjectId(userId(user))
      : undefined;
    const byName =
      user.name ||
      `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
      user.email ||
      "System";

    const {
      firstName,
      lastName = "",
      phone,
      email = "",
      jobTitle = "",
      companyName = "",
      useExistingContactId,
      linkContactToCompany = true,
    } = req.body as AnyObj;

    let contact: any;

    if (useExistingContactId) {
      if (!mongoose.isValidObjectId(useExistingContactId)) {
        return res.status(400).json({ error: "Invalid existing contact ID." });
      }
      contact = await CRMContact.findById(useExistingContactId);
      if (!contact) return res.status(404).json({ error: "Existing contact not found." });
    } else {
      if (!firstName || !phone) {
        return res.status(400).json({ error: "firstName and phone are required." });
      }
      if (email) {
        const dup = (await CRMContact.findOne({
          email: String(email).trim().toLowerCase(),
        }).lean()) as any;
        if (dup) {
          return res.status(409).json({
            error: "Duplicate contact",
            errors: [
              {
                type: "duplicate_contact",
                id: String(dup._id),
                name: `${dup.firstName} ${dup.lastName}`.trim(),
                email: dup.email,
              },
            ],
          });
        }
      }
      contact = await CRMContact.create({
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        jobTitle: String(jobTitle).trim(),
        phone: String(phone).trim(),
        email: email ? String(email).trim().toLowerCase() : "",
        companyName: String(companyName || lead.companyName || ""),
        source: lead.source,
        notes: lead.notes || "",
        leadId: lead._id,
        assignedTo: lead.assignedTo || null,
        createdBy: createdById,
        isPrivate: false,
        status: "active",
      });
    }

    // Reuse the lead's anchor company if already set (never create a second);
    // else resolve-or-create from the chosen/lead name.
    let company: any = null;
    const targetCompanyName = String(companyName || lead.companyName || "").trim();
    if (lead.companyId) {
      company = await CRMCompany.findById(lead.companyId);
    }
    if (!company && targetCompanyName) {
      company = await resolveOrCreateCompany(
        {
          name: targetCompanyName,
          industry: lead.industry,
          companySize: lead.companySize,
          location: lead.location,
          website: lead.website,
          gstin: lead.gstin,
        },
        createdById
      );
    }

    if (company && linkContactToCompany && !useExistingContactId) {
      contact.companyId = company._id;
      contact.companyName = company.name;
      await contact.save();
    }

    lead.convertedToContactId = contact._id;
    lead.convertedToCompanyId = company?._id ?? null;
    if (company?._id) lead.companyId = company._id;
    lead.stage = "won";
    lead.wonDate = new Date();
    await lead.save();

    const contactLabel = `${contact.firstName} ${contact.lastName}`.trim();
    const companyLabel = company ? ` and Company "${company.name}"` : "";
    await LeadActivity.create({
      leadId: lead._id,
      type: "won" as ActivityType,
      note: `Converted: Contact "${contactLabel}"${companyLabel} created.`,
      createdBy: createdById,
      createdByName: byName,
    });

    // Slice 2: Closed Won Opportunity + opportunity.won trigger under the flag.
    const convertSplit = await runOpportunitySplit(lead, user);

    if (!convertSplit.triggered) triggerTaskAutomation("lead.won", {
      workspaceId: SYSTEM_WORKSPACE_ID,
      entityType: "LEAD",
      entityId: lead._id as mongoose.Types.ObjectId,
      entityRef: lead.leadCode,
      ownerId: lead.assignedTo,
      variables: { leadName: lead.contactName || lead.companyName || "Lead" },
    }).catch(() => {});

    return res.json({ contact, company, lead });
  } catch (err) {
    logger.error("leads POST /:id/convert error", { err });
    return res.status(500).json({ error: "Failed to convert lead." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 14 — DELETE /:id
// ═══════════════════════════════════════════════════════════════

router.delete("/:id", async (req, res) => {
  try {
    if ((req as any).leadsAccess !== "FULL") {
      return res.status(403).json({ error: "Full access required to delete leads." });
    }

    const user = (req as any).user as AnyObj;
    const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
    if (!roles.includes("ADMIN") && !roles.includes("SUPERADMIN")) {
      return res.status(403).json({ error: "Admin role required to delete leads." });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });

    await Promise.all([
      Lead.deleteOne({ _id: lead._id }),
      LeadActivity.deleteMany({ leadId: lead._id }),
    ]);

    return res.json({ success: true });
  } catch (err) {
    logger.error("leads DELETE /:id error", { err });
    return res.status(500).json({ error: "Failed to delete lead." });
  }
});

export default router;
