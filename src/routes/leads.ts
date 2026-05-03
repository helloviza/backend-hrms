import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Lead, { LEAD_STAGES, LEAD_SOURCES } from "../models/Lead.js";
import LeadActivity, { ACTIVITY_TYPES } from "../models/LeadActivity.js";
import CRMCompany from "../models/CRMCompany.js";
import CRMContact from "../models/CRMContact.js";
import type { LeadStage } from "../models/Lead.js";
import type { ActivityType } from "../models/LeadActivity.js";
import { UserPermission } from "../models/UserPermission.js";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import logger from "../utils/logger.js";

const router = express.Router();

type AnyObj = Record<string, any>;

// ── Permission helpers ──────────────────────────────────────────

function canWrite(access: string): boolean {
  return access === "WRITE" || access === "FULL";
}

function userId(user: AnyObj): string {
  return String(user.id || user.sub || "");
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

// ═══════════════════════════════════════════════════════════════
// ROUTE 15 — POST /website-capture  (PUBLIC — before requireAuth)
// ═══════════════════════════════════════════════════════════════

router.post("/website-capture", async (req, res) => {
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

    const lead = await Lead.create({
      contactName: sanitize(name),
      contactPhone: sanitize(phone, 20),
      contactEmail: sanitize(email),
      companyName: sanitize(company),
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

// ── Leads access gate (all routes below require leads module) ───
router.use(requireLeadsAccess);

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
    let assignedToName = body.assignedToName || user.name || "";

    if (body.assignedTo && body.assignedTo !== userId(user)) {
      const rep = (await User.findById(body.assignedTo).select("name").lean()) as any;
      if (rep) assignedToName = rep.name || "";
    }

    const lead = await Lead.create({
      ...body,
      assignedTo: mongoose.isValidObjectId(assignedToId)
        ? new mongoose.Types.ObjectId(String(assignedToId))
        : undefined,
      assignedToName,
      createdBy: mongoose.isValidObjectId(userId(user))
        ? new mongoose.Types.ObjectId(userId(user))
        : undefined,
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

    return res.status(201).json({ lead });
  } catch (err) {
    logger.error("leads POST / error", { err });
    return res.status(500).json({ error: "Failed to create lead." });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 2 — GET /  (list leads)
// ═══════════════════════════════════════════════════════════════

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

    return res.json({ leads, total, page, pages: Math.ceil(total / limit) });
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
// ROUTE 6 — GET /export  (XLSX)
// ═══════════════════════════════════════════════════════════════

router.get("/export", async (req, res) => {
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
    }

    if (q.dateFrom || q.dateTo) {
      filter.createdAt = {};
      if (q.dateFrom) filter.createdAt.$gte = new Date(String(q.dateFrom));
      if (q.dateTo) filter.createdAt.$lte = new Date(String(q.dateTo));
    }

    const leads = await Lead.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Leads");
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const columns = [
      "Lead Code", "Type", "Company Name", "Industry", "Company Size",
      "Location", "Contact Name", "Contact Phone", "Contact Email",
      "Designation", "Source", "Stage", "Budget", "Deal Value", "Currency",
      "Assigned To", "Next Follow Up", "Lost Reason", "Won Date",
      "Invite Sent", "Created At", "Notes",
    ];

    const headerRow = sheet.addRow(columns);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } };
    headerRow.alignment = { vertical: "middle" };

    const colWidths = [14, 10, 22, 18, 12, 16, 20, 16, 24, 16, 12, 14, 12, 12, 10, 18, 16, 20, 14, 12, 18, 30];
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
        l.onboardingInviteSent ? "Yes" : "No",
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

router.get("/export/activities", async (_req, res) => {
  try {
    const activities = await LeadActivity.find({})
      .sort({ createdAt: -1 })
      .lean();

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
    ]);

    const body = req.body as AnyObj;
    for (const key of Object.keys(body)) {
      if (!PROTECTED.has(key)) {
        (lead as any)[key] = body[key];
      }
    }

    await lead.save();
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

    const { sendInvite = false, contactEmail } = req.body as AnyObj;
    const inviteEmail: string = contactEmail || lead.contactEmail || "";

    if (sendInvite && !inviteEmail) {
      return res.status(400).json({ error: "Email required to send invite." });
    }

    const user = (req as any).user as AnyObj;

    lead.stage = "won";
    lead.wonDate = new Date();

    if (sendInvite && inviteEmail) {
      const existing = lead.notes || "";
      lead.notes = existing.length > 0
        ? `${existing}\n[INVITE PENDING: ${inviteEmail}]`
        : `[INVITE PENDING: ${inviteEmail}]`;
    }

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

    if (sendInvite && inviteEmail) {
      await LeadActivity.create({
        leadId: lead._id,
        type: "invite_sent" as ActivityType,
        note: `Onboarding invite pending for ${inviteEmail}. SuperAdmin can send from Onboarding module.`,
        createdBy: createdById,
        createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
      });
    }

    // Auto-create Company if companyName exists
    let newCompany: any = null;
    if (lead.companyName) {
      const existingCompany = (await CRMCompany.findOne({
        name: { $regex: new RegExp(`^${lead.companyName}$`, "i") },
      }).lean()) as any;

      if (!existingCompany) {
        newCompany = await CRMCompany.create({
          name: lead.companyName,
          industry: lead.industry || "",
          companySize: lead.companySize || "",
          city: lead.location || "",
          phone: lead.contactPhone || "",
          email: lead.contactEmail || "",
          website: lead.website || "",
          leadId: lead._id,
          createdBy: createdById,
          isPrivate: false,
        });
      } else {
        newCompany = existingCompany;
      }
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

    // Update lead with conversion references
    lead.convertedToContactId = newContact._id;
    lead.convertedToCompanyId = newCompany?._id || null;
    await lead.save();

    await LeadActivity.create({
      leadId: lead._id,
      type: "invite_sent" as ActivityType,
      note: `Auto-converted: Contact ${newContact.firstName} and Company ${newCompany?.name || "N/A"} created`,
      createdBy: createdById,
      createdByName: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "System",
    });

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

    let company: any = null;
    const targetCompanyName = String(companyName || lead.companyName || "").trim();
    if (targetCompanyName) {
      const escaped = targetCompanyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const existing = (await CRMCompany.findOne({
        name: { $regex: new RegExp(`^${escaped}$`, "i") },
      }).lean()) as any;
      if (existing) {
        company = existing;
      } else {
        company = await CRMCompany.create({
          name: targetCompanyName,
          industry: lead.industry || "",
          companySize: lead.companySize || "",
          city: lead.location || "",
          phone: lead.contactPhone || "",
          email: lead.contactEmail || "",
          website: lead.website || "",
          leadId: lead._id,
          createdBy: createdById,
          isPrivate: false,
        });
      }
    }

    if (company && linkContactToCompany && !useExistingContactId) {
      contact.companyId = company._id;
      contact.companyName = company.name;
      await contact.save();
    }

    lead.convertedToContactId = contact._id;
    lead.convertedToCompanyId = company?._id ?? null;
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
