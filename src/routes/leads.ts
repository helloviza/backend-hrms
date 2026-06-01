import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Lead, { LEAD_STAGES, LEAD_SOURCES } from "../models/Lead.js";
import LeadActivity, { ACTIVITY_TYPES } from "../models/LeadActivity.js";
import CRMCompany from "../models/CRMCompany.js";
import CRMContact from "../models/CRMContact.js";
import { resolveOrCreateCompany } from "../utils/crmCompany.js";
import type { LeadStage } from "../models/Lead.js";
import type { ActivityType } from "../models/LeadActivity.js";
import { UserPermission } from "../models/UserPermission.js";
import User from "../models/User.js";
import Task from "../models/Task.js";
import { requireAuth } from "../middleware/auth.js";
import { requireHouse } from "../middleware/requireHouse.js";
import { triggerTaskAutomation } from "../services/taskAutomation.js";
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
// ROUTE 4 — GET /reports/by-rep
// ═══════════════════════════════════════════════════════════════

router.get("/reports/by-rep", async (_req, res) => {
  try {
    const reps = await Lead.aggregate([
      {
        $group: {
          _id: "$assignedTo",
          repName: { $first: "$assignedToName" },
          total: { $sum: 1 },
          won: { $sum: { $cond: [{ $eq: ["$stage", "won"] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ["$stage", "lost"] }, 1, 0] } },
          pipelineValue: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ["$stage", "won"] }, { $ne: ["$stage", "lost"] }] },
                "$dealValue",
                0,
              ],
            },
          },
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
          pipelineValue: 1,
          conversion: {
            $cond: [
              { $gt: [{ $add: ["$won", "$lost"] }, 0] },
              {
                $round: [
                  { $multiply: [{ $divide: ["$won", { $add: ["$won", "$lost"] }] }, 100] },
                  1,
                ],
              },
              0,
            ],
          },
        },
      },
      { $sort: { total: -1 } },
    ]);

    return res.json({ reps });
  } catch (err) {
    logger.error("leads GET /reports/by-rep error", { err });
    return res.status(500).json({ error: "Failed to load rep report." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 5 — GET /reports/monthly
// ═══════════════════════════════════════════════════════════════

router.get("/reports/monthly", async (_req, res) => {
  try {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const monthly = await Lead.aggregate([
      { $match: { createdAt: { $gte: twelveMonthsAgo } } },
      {
        $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          new: { $sum: 1 },
          won: { $sum: { $cond: [{ $eq: ["$stage", "won"] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ["$stage", "lost"] }, 1, 0] } },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const formatted = monthly.map((m: any) => ({
      month: `${MONTHS[m._id.month - 1]} ${m._id.year}`,
      new: m.new,
      won: m.won,
      lost: m.lost,
    }));

    return res.json({ monthly: formatted });
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
    const fromMs = dateFrom && !isNaN(dateFrom.getTime()) ? dateFrom.getTime() : null;
    const toMs = dateTo && !isNaN(dateTo.getTime()) ? dateTo.getTime() : null;

    // Lead-level filters (cheap, in Mongo). The date filter depends on activities
    // and is therefore applied after last_activity_date is computed below.
    const leadMatch: AnyObj = {};
    if (assignedToF.length)
      leadMatch.assignedTo = { $in: assignedToF.map((s) => new mongoose.Types.ObjectId(s)) };
    if (stageF.length) leadMatch.stage = { $in: stageF };
    if (sourceF.length) leadMatch.source = { $in: sourceF };
    if (typeF.length) leadMatch.type = { $in: typeF };

    const leads = (await Lead.find(leadMatch)
      .select("_id assignedTo assignedToName stage source type dealValue currency createdAt")
      .lean()) as any[];

    const leadIds = leads.map((l) => l._id);
    const activities = leadIds.length
      ? ((await LeadActivity.find({ leadId: { $in: leadIds } })
          .select("leadId type createdAt")
          .lean()) as any[])
      : [];

    const actByLead = new Map<string, any[]>();
    for (const a of activities) {
      const k = String(a.leadId);
      if (!actByLead.has(k)) actByLead.set(k, []);
      actByLead.get(k)!.push(a);
    }

    const now = Date.now();
    const DAY = 86400000;

    // last_activity_date + lead age, then date-range filter on last_activity_date.
    const scoped = leads
      .map((l) => {
        const acts = actByLead.get(String(l._id)) || [];
        let lastAct = 0;
        for (const a of acts) {
          const t = new Date(a.createdAt).getTime();
          if (t > lastAct) lastAct = t;
        }
        const created = new Date(l.createdAt).getTime();
        return { ...l, _acts: acts, _lastActivity: Math.max(created, lastAct), _created: created };
      })
      .filter((l) => {
        if (fromMs != null && l._lastActivity < fromMs) return false;
        if (toMs != null && l._lastActivity > toMs) return false;
        return true;
      });

    // ── Identity + constants ──
    const ownerKey = (l: any) => (l.assignedTo ? String(l.assignedTo) : "unassigned");
    const ownerLabel = (l: any) =>
      (l.assignedToName && String(l.assignedToName).trim()) ||
      (l.assignedTo ? "Unknown" : "Unassigned");
    const STAGES = LEAD_STAGES as readonly string[];
    const STAGE_LABEL: Record<string, string> = {
      new: "New", contacted: "Contacted", demo_scheduled: "Demo Scheduled",
      proposal_sent: "Proposal Sent", negotiation: "Negotiation", follow_up: "Follow Up",
      won: "Won", lost: "Lost",
    };
    const isClosed = (s: string) => s === "won" || s === "lost";
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const total = scoped.length;

    // ── S1 — status snapshot ──
    const statusCount: Record<string, number> = {};
    for (const s of STAGES) statusCount[s] = 0;
    for (const l of scoped) statusCount[l.stage] = (statusCount[l.stage] || 0) + 1;
    const statusSnapshot = STAGES.map((s) => ({
      stage: s, label: STAGE_LABEL[s], count: statusCount[s],
      pct: total ? r1((statusCount[s] / total) * 100) : 0,
    }));

    // ── Owner buckets ──
    const ownerMap = new Map<string, { ownerId: string; ownerName: string; leads: any[] }>();
    for (const l of scoped) {
      const k = ownerKey(l);
      if (!ownerMap.has(k)) ownerMap.set(k, { ownerId: k, ownerName: ownerLabel(l), leads: [] });
      ownerMap.get(k)!.leads.push(l);
    }
    const owners = [...ownerMap.values()].sort((a, b) => b.leads.length - a.leads.length);

    // ── S2 — owner × status matrix ──
    const ownerMatrix = {
      stages: STAGES.map((s) => ({ key: s, label: STAGE_LABEL[s] })),
      owners: owners.map((o) => {
        const byStatus: Record<string, number> = {};
        for (const s of STAGES) byStatus[s] = 0;
        for (const l of o.leads) byStatus[l.stage]++;
        return { ownerId: o.ownerId, ownerName: o.ownerName, total: o.leads.length, byStatus };
      }),
    };

    // ── S3 — performance (conversion%, win% null-safe, avgAgeDays) ──
    const performance = owners.map((o) => {
      const t = o.leads.length;
      const won = o.leads.filter((l) => l.stage === "won").length;
      const lost = o.leads.filter((l) => l.stage === "lost").length;
      const closed = won + lost;
      const ageSum = o.leads.reduce((s, l) => s + Math.max(0, Math.floor((now - l._created) / DAY)), 0);
      return {
        ownerId: o.ownerId, ownerName: o.ownerName, total: t, won, lost, closed,
        conversionPct: t ? r1((won / t) * 100) : 0,
        winPct: closed ? r1((won / closed) * 100) : null, // null-safe: no closed deals yet
        avgAgeDays: t ? Math.round(ageSum / t) : 0,
      };
    });

    // ── S5 — ageing (OPEN leads, by days since last activity) ──
    const BUCKETS = [
      { key: "0-7", label: "0–7 days", min: 0, max: 7 },
      { key: "8-14", label: "8–14 days", min: 8, max: 14 },
      { key: "15-30", label: "15–30 days", min: 15, max: 30 },
      { key: "31-60", label: "31–60 days", min: 31, max: 60 },
      { key: "60+", label: "60+ days", min: 61, max: Infinity },
    ];
    const daysSinceAct = (l: any) => Math.max(0, Math.floor((now - l._lastActivity) / DAY));
    const bucketOf = (d: number) => BUCKETS.find((b) => d >= b.min && d <= b.max)!.key;
    const openLeads = scoped.filter((l) => !isClosed(l.stage));
    const openTotal = openLeads.length;
    const ageingCount: Record<string, number> = {};
    for (const b of BUCKETS) ageingCount[b.key] = 0;
    for (const l of openLeads) ageingCount[bucketOf(daysSinceAct(l))]++;
    const ageing = {
      openTotal,
      buckets: BUCKETS.map((b) => ({
        key: b.key, label: b.label, count: ageingCount[b.key],
        pct: openTotal ? r1((ageingCount[b.key] / openTotal) * 100) : 0,
      })),
      byOwner: owners.map((o) => {
        const open = o.leads.filter((l) => !isClosed(l.stage));
        const bc: Record<string, number> = {};
        for (const b of BUCKETS) bc[b.key] = 0;
        for (const l of open) bc[bucketOf(daysSinceAct(l))]++;
        const ot = open.length;
        const bp: Record<string, number> = {};
        for (const b of BUCKETS) bp[b.key] = ot ? r1((bc[b.key] / ot) * 100) : 0;
        return { ownerId: o.ownerId, ownerName: o.ownerName, total: ot, buckets: bc, bucketPct: bp };
      }),
    };

    // ── S6 — stale (OPEN, days since last activity ≥ 14; critical ≥ 30) ──
    const STALE_DAYS = 14;
    const CRIT_DAYS = 30;
    let totalStale = 0;
    let totalPotential = 0;
    const staleByOwner = owners
      .map((o) => {
        const staleLeads = o.leads.filter((l) => !isClosed(l.stage) && daysSinceAct(l) >= STALE_DAYS);
        const potentialValue = staleLeads.reduce((s, l) => s + (Number(l.dealValue) || 0), 0);
        const criticalCount = staleLeads.filter((l) => daysSinceAct(l) >= CRIT_DAYS).length;
        totalStale += staleLeads.length;
        totalPotential += potentialValue;
        return {
          ownerId: o.ownerId, ownerName: o.ownerName, count: staleLeads.length,
          potentialValue, criticalCount, critical: criticalCount > 0,
        };
      })
      .filter((o) => o.count > 0)
      .sort((a, b) => b.count - a.count);
    const stale = {
      thresholdDays: STALE_DAYS, criticalDays: CRIT_DAYS,
      totalStale, totalPotentialValue: totalPotential, byOwner: staleByOwner,
    };

    // ── S7 — pipeline value by owner (OPEN leads) ──
    let totalPipeline = 0;
    let anyValue = false;
    const pipelineByOwner = owners
      .map((o) => {
        const open = o.leads.filter((l) => !isClosed(l.stage));
        const pipelineValue = open.reduce((s, l) => s + (Number(l.dealValue) || 0), 0);
        const valuedLeads = open.filter((l) => (Number(l.dealValue) || 0) > 0).length;
        if (pipelineValue > 0) anyValue = true;
        totalPipeline += pipelineValue;
        return {
          ownerId: o.ownerId, ownerName: o.ownerName,
          openLeads: open.length, pipelineValue, valuedLeads,
        };
      })
      .sort((a, b) => b.pipelineValue - a.pipelineValue);
    const pipeline = { totalPipelineValue: totalPipeline, hasAnyValue: anyValue, byOwner: pipelineByOwner };

    // ── S8 — activity effectiveness (attributed to the lead's owner) ──
    // Counts activities DONE IN THE PERIOD: each activity is included only when
    // its own createdAt falls in [dateFrom, dateTo] (when a range is set), scoped
    // to the report's leads. Not "all activities of snapshot leads".
    const INTERACTION_TYPES = ["call", "email", "meeting", "note", "follow_up"];
    const TYPE_LABEL: Record<string, string> = {
      call: "Calls", email: "Emails", meeting: "Meetings", note: "Notes", follow_up: "Follow-ups",
    };
    const typeTotals: Record<string, number> = {};
    for (const t of INTERACTION_TYPES) typeTotals[t] = 0;
    const actByOwner = new Map<string, Record<string, number>>();
    for (const o of owners) {
      const m: Record<string, number> = {};
      for (const t of INTERACTION_TYPES) m[t] = 0;
      actByOwner.set(o.ownerId, m);
    }
    for (const l of scoped) {
      const m = actByOwner.get(ownerKey(l));
      for (const a of l._acts) {
        const at = new Date(a.createdAt).getTime();
        if (fromMs != null && at < fromMs) continue;
        if (toMs != null && at > toMs) continue;
        if (INTERACTION_TYPES.includes(a.type)) {
          typeTotals[a.type]++;
          if (m) m[a.type]++;
        }
      }
    }
    const activityEffectiveness = {
      types: INTERACTION_TYPES.map((t) => ({ key: t, label: TYPE_LABEL[t] })),
      presentTypes: INTERACTION_TYPES.filter((t) => typeTotals[t] > 0).map((t) => ({
        key: t, label: TYPE_LABEL[t], count: typeTotals[t],
      })),
      absentTypes: INTERACTION_TYPES.filter((t) => typeTotals[t] === 0).map((t) => ({
        key: t, label: TYPE_LABEL[t],
      })),
      byOwner: owners.map((o) => {
        const counts = actByOwner.get(o.ownerId)!;
        const won = o.leads.filter((l) => l.stage === "won").length;
        return {
          ownerId: o.ownerId, ownerName: o.ownerName, activityCounts: counts,
          totalActivities: INTERACTION_TYPES.reduce((s, k) => s + counts[k], 0),
          conversionPct: o.leads.length ? r1((won / o.leads.length) * 100) : 0,
        };
      }),
    };

    return res.json({
      generatedAt: new Date().toISOString(),
      filters: {
        dateFrom: fromMs != null ? new Date(fromMs).toISOString() : null,
        dateTo: toMs != null ? new Date(toMs).toISOString() : null,
        assignedTo: assignedToF, stage: stageF, source: sourceF, type: typeF,
      },
      totals: { totalLeads: total, byStatus: statusCount },
      statusSnapshot,
      ownerMatrix,
      performance,
      ageing,
      stale,
      pipeline,
      activityEffectiveness,
    });
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

    return res.json({ lead, activities });
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

    lead.stage = stage as LeadStage;
    if (stage === "follow_up" && nextFollowUpDate) {
      lead.nextFollowUpDate = new Date(nextFollowUpDate);
    }
    await lead.save();

    await LeadActivity.create({
      leadId: lead._id,
      type: "stage_change" as ActivityType,
      note: note || `Stage changed from ${fromStage} to ${stage}`,
      fromStage: String(fromStage),
      toStage: String(stage),
      createdBy: mongoose.isValidObjectId(userId(user))
        ? new mongoose.Types.ObjectId(userId(user))
        : undefined,
      createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
    });

    // Task automation hook for stage transitions
    const stageMap: Record<string, string> = {
      contacted: "lead.stage_contacted",
      demo_scheduled: "lead.stage_demo",
      proposal_sent: "lead.stage_proposal",
    };
    const stageTrigger = stageMap[stage];
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

    return res.json({ lead });
  } catch (err) {
    logger.error("leads PUT /:id/stage error", { err });
    return res.status(500).json({ error: "Failed to update stage." });
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

    // Task automation hook
    triggerTaskAutomation("lead.won", {
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

    triggerTaskAutomation("lead.won", {
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
