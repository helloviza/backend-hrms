// apps/backend/src/routes/opportunities.ts
//
// The OPPORTUNITY BOARD read surface — /api/opportunities. Closes the seam
// where an opportunity "opened on its lead": the board and the record page
// now have their own list / detail, while every WRITE to an opportunity's
// stage still happens through the lead (services/disposition.ts and the
// legacy stage routes via services/leadSplit.ts). Nothing here writes an
// opportunity — the board is a view over the rep's lead work, not a second
// place to do it. Two drivers of stage would desync the lead's disposition
// snapshot (the next disposition would snap the deal straight back).
//
// Gate: same as /api/leads — HOUSE + the leads permission module. OWN scope
// sees only opportunities it owns (ownerUserId, cascaded from Lead.assignedTo
// on assign / bulk-assign). Flag-gated on either CRM v2 switch that writes
// the collection (CRM_V2_OPPORTUNITY or CRM_V2_DISPOSITION); off → 404, the
// same posture as the disposition routes.
//
//   GET /            list — server-side aggregation (lead, contact, company,
//                    last activity joined), paginated, byStage rollup.
//   GET /summary     KPI strip — open pipeline ₹, weighted forecast ₹, won /
//                    lost this period, win rate.
//   GET /:id         detail — the opportunity, its lead, company, primary
//                    contact, the pipeline's stage table, and the lead's whole
//                    activity stream (the opportunity-opened / moved / won /
//                    lost rows already live there, subject OPPORTUNITY).

import express from "express";
import mongoose, { type PipelineStage } from "mongoose";
import Opportunity from "../models/Opportunity.js";
import Lead from "../models/Lead.js";
import LeadActivity from "../models/LeadActivity.js";
import CRMContact from "../models/CRMContact.js";
import CRMCompany from "../models/CRMCompany.js";
import { OPPORTUNITY_PIPELINES, PIPELINE_STAGES, closedStage, type OpportunityPipeline } from "../models/crmTaxonomy.js";
import { isCrmV2DispositionEnabled, isCrmV2OpportunityEnabled } from "../config/crmV2.js";
import { requireAuth } from "../middleware/auth.js";
import { requireHouse } from "../middleware/requireHouse.js";
import { requireLeadsAccess } from "./leads.js";
import logger from "../utils/logger.js";

const router = express.Router();
type AnyObj = Record<string, any>;

router.use(requireAuth);
router.use(requireHouse);
router.use(requireLeadsAccess);
router.use((_req, res, next) => {
  if (!isCrmV2OpportunityEnabled() && !isCrmV2DispositionEnabled()) return res.status(404).json({ error: "Not found." });
  next();
});

function userId(user: AnyObj): string {
  return String(user.id || user.sub || "");
}

// Every closed stage key across the three pipelines (closed_won / closed_lost
// / active_partner) — pipeline-agnostic filters use the union, the same way
// /leads/reports/kpis does.
const WON_STAGES = OPPORTUNITY_PIPELINES.map((p) => closedStage(p, "won"));
const LOST_STAGES = OPPORTUNITY_PIPELINES.map((p) => closedStage(p, "lost"));
const CLOSED_STAGES = Array.from(new Set([...WON_STAGES, ...LOST_STAGES]));

const STATUS_FILTERS = ["open", "won", "lost", "closed", "all"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** The base $match every list/summary query starts from: scope + filters. */
function baseMatch(req: express.Request, q: AnyObj = req.query as AnyObj): AnyObj {
  const user = (req as any).user as AnyObj;
  const match: AnyObj = {};

  if ((req as any).leadsScope === "OWN") {
    const uid = userId(user);
    match.ownerUserId = mongoose.isValidObjectId(uid) ? new mongoose.Types.ObjectId(uid) : null;
  } else if (q.owner && mongoose.isValidObjectId(String(q.owner))) {
    match.ownerUserId = new mongoose.Types.ObjectId(String(q.owner));
  } else if (q.owner === "unassigned") {
    match.ownerUserId = null;
  }

  if (q.pipeline && (OPPORTUNITY_PIPELINES as readonly string[]).includes(String(q.pipeline))) match.pipeline = String(q.pipeline);

  const status = (STATUS_FILTERS as readonly string[]).includes(String(q.status || "")) ? (String(q.status) as StatusFilter) : "open";
  if (status === "open") match.stage = { $nin: CLOSED_STAGES };
  else if (status === "won") match.stage = { $in: WON_STAGES };
  else if (status === "lost") match.stage = { $in: LOST_STAGES };
  else if (status === "closed") match.stage = { $in: CLOSED_STAGES };
  // An explicit stage filter narrows within the status bucket.
  if (q.stage) {
    const stages = String(q.stage).split(",").map((s) => s.trim()).filter(Boolean);
    if (stages.length) match.stage = match.stage ? { ...match.stage, $in: (match.stage.$in ? stages.filter((s) => match.stage.$in.includes(s)) : stages) } : { $in: stages };
  }

  if (q.dateFrom || q.dateTo) {
    match.createdAt = {};
    const from = q.dateFrom ? new Date(String(q.dateFrom)) : null;
    const to = q.dateTo ? new Date(String(q.dateTo)) : null;
    if (from && !isNaN(from.getTime())) match.createdAt.$gte = from;
    if (to && !isNaN(to.getTime())) match.createdAt.$lte = to;
    if (!Object.keys(match.createdAt).length) delete match.createdAt;
  }
  return match;
}

const LEAD_FIELDS = { leadCode: 1, contactName: 1, contactPhone: 1, contactEmail: 1, contactDesignation: 1, companyName: 1, assignedTo: 1, assignedToName: 1, nextFollowUpDate: 1, subDisposition: 1, dispositionStage: 1, dispositionStatus: 1, status: 1, stage: 1 };

// The joins the board / table / detail all need: the lead the deal shadows,
// the buying contact (primaryContactId — set on Won; else the lead's contact
// fields stand in), the company anchor, and the newest activity on the lead.
function joinStages(): PipelineStage[] {
  return [
    { $lookup: { from: Lead.collection.name, localField: "leadId", foreignField: "_id", as: "lead", pipeline: [{ $project: LEAD_FIELDS }] } },
    { $unwind: { path: "$lead", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: CRMContact.collection.name, localField: "primaryContactId", foreignField: "_id", as: "contact", pipeline: [{ $project: { firstName: 1, lastName: 1, email: 1, phone: 1, jobTitle: 1 } }] } },
    { $unwind: { path: "$contact", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: CRMCompany.collection.name, localField: "companyId", foreignField: "_id", as: "company", pipeline: [{ $project: { name: 1, companyCode: 1, customerId: 1 } }] } },
    { $unwind: { path: "$company", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: LeadActivity.collection.name,
        let: { lid: "$leadId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$leadId", "$$lid"] } } },
          { $sort: { createdAt: -1 } },
          { $limit: 1 },
          { $project: { createdAt: 1, type: 1, note: 1, createdByName: 1 } },
        ],
        as: "last",
      },
    },
  ];
}

const ROW_PROJECT = {
  opportunityCode: 1, name: 1, pipeline: 1, stage: 1, probability: 1, forecastCategory: 1, dealValue: 1, currency: 1,
  closeDate: 1, closedAt: 1, nextAction: 1, nextActionDueAt: 1, lostReason: 1,
  ownerUserId: 1, ownerName: 1, leadId: 1, companyId: 1, primaryContactId: 1, createdAt: 1, updatedAt: 1,
  lead: 1, company: 1,
  primaryContact: {
    $cond: [
      { $ifNull: ["$contact._id", false] },
      { _id: "$contact._id", name: { $trim: { input: { $concat: [{ $ifNull: ["$contact.firstName", ""] }, " ", { $ifNull: ["$contact.lastName", ""] }] } } }, email: "$contact.email", phone: "$contact.phone", jobTitle: "$contact.jobTitle", fromLead: false },
      { $cond: [{ $ifNull: ["$lead._id", false] }, { _id: null, name: "$lead.contactName", email: "$lead.contactEmail", phone: "$lead.contactPhone", jobTitle: "$lead.contactDesignation", fromLead: true }, null] },
    ],
  },
  lastActivityAt: { $arrayElemAt: ["$last.createdAt", 0] },
  lastActivityType: { $arrayElemAt: ["$last.type", 0] },
  lastActivityNote: { $arrayElemAt: ["$last.note", 0] },
  ageDays: { $floor: { $divide: [{ $subtract: ["$$NOW", "$createdAt"] }, 86_400_000] } },
};

// ═══════════════════════════════════════════════════════════════
// GET /  — list (board + full table)
// ═══════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const match = baseMatch(req);
    const page = Math.max(1, parseInt(String(q.page || "1"), 10));
    const limit = Math.min(200, Math.max(1, parseInt(String(q.limit || "20"), 10)));
    const skip = (page - 1) * limit;

    const pipeline: PipelineStage[] = [{ $match: match }, ...joinStages()];
    if (q.search) {
      const re = new RegExp(String(q.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      pipeline.push({ $match: { $or: [{ name: re }, { opportunityCode: re }, { ownerName: re }, { "lead.contactName": re }, { "lead.leadCode": re }, { "lead.contactPhone": re }, { "company.name": re }] } });
    }
    const sortKey = ["createdAt", "updatedAt", "dealValue", "closedAt"].includes(String(q.sort)) ? String(q.sort) : "createdAt";
    const sortDir = q.dir === "asc" ? 1 : -1;
    pipeline.push({
      $facet: {
        rows: [{ $sort: { [sortKey]: sortDir, _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: ROW_PROJECT }],
        total: [{ $count: "n" }],
        byStage: [{ $group: { _id: { pipeline: "$pipeline", stage: "$stage" }, count: { $sum: 1 }, value: { $sum: "$dealValue" } } }],
      },
    });

    const [out] = await Opportunity.aggregate(pipeline);
    const total: number = out?.total?.[0]?.n || 0;
    const byStage = (out?.byStage || []).map((b: any) => ({ pipeline: b._id.pipeline, stage: b._id.stage, count: b.count, value: b.value }));
    return res.json({ opportunities: out?.rows || [], total, page, pages: Math.ceil(total / limit), byStage });
  } catch (err) {
    logger.error("opportunities GET / error", { err });
    return res.status(500).json({ error: "Failed to list opportunities." });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /summary  — KPI strip
// ═══════════════════════════════════════════════════════════════
// Same scope + pipeline / owner filters as the list; the status / stage /
// date filters are ignored (the strip describes the whole board, not the
// current column). `periodStart` (ISO, the caller's start of month) scopes
// "won this period" on closedAt; win rate is all-time won ÷ closed.
router.get("/summary", async (req, res) => {
  try {
    const q = req.query as AnyObj;
    const scope = baseMatch(req, { pipeline: q.pipeline, owner: q.owner, status: "all" });
    const startRaw = q.periodStart ? new Date(String(q.periodStart)) : null;
    const now = new Date();
    const periodStart = startRaw && !isNaN(startRaw.getTime()) ? startRaw : new Date(now.getFullYear(), now.getMonth(), 1);

    const [agg] = await Opportunity.aggregate([
      { $match: scope },
      {
        $facet: {
          open: [
            { $match: { stage: { $nin: CLOSED_STAGES } } },
            { $group: { _id: null, count: { $sum: 1 }, value: { $sum: "$dealValue" }, weighted: { $sum: { $multiply: ["$dealValue", { $divide: [{ $ifNull: ["$probability", 0] }, 100] }] } } } },
          ],
          wonPeriod: [{ $match: { stage: { $in: WON_STAGES }, closedAt: { $gte: periodStart } } }, { $group: { _id: null, count: { $sum: 1 }, value: { $sum: "$dealValue" } } }],
          lostPeriod: [{ $match: { stage: { $in: LOST_STAGES }, closedAt: { $gte: periodStart } } }, { $group: { _id: null, count: { $sum: 1 }, value: { $sum: "$dealValue" } } }],
          wonAll: [{ $match: { stage: { $in: WON_STAGES } } }, { $count: "n" }],
          lostAll: [{ $match: { stage: { $in: LOST_STAGES } } }, { $count: "n" }],
        },
      },
    ]);
    const wonAll = agg?.wonAll?.[0]?.n || 0;
    const lostAll = agg?.lostAll?.[0]?.n || 0;
    const wonPeriod = agg?.wonPeriod?.[0] || { count: 0, value: 0 };
    const lostPeriod = agg?.lostPeriod?.[0] || { count: 0, value: 0 };
    return res.json({
      open: { count: agg?.open?.[0]?.count || 0, value: agg?.open?.[0]?.value || 0, weighted: Math.round(agg?.open?.[0]?.weighted || 0) },
      wonPeriod: { count: wonPeriod.count, value: wonPeriod.value },
      lostPeriod: { count: lostPeriod.count, value: lostPeriod.value },
      winRate: wonAll + lostAll > 0 ? Math.round((wonAll / (wonAll + lostAll)) * 1000) / 10 : null,
      winRatePeriod: wonPeriod.count + lostPeriod.count > 0 ? Math.round((wonPeriod.count / (wonPeriod.count + lostPeriod.count)) * 1000) / 10 : null,
      closedAll: { won: wonAll, lost: lostAll },
      periodStart: periodStart.toISOString(),
    });
  } catch (err) {
    logger.error("opportunities GET /summary error", { err });
    return res.status(500).json({ error: "Failed to load opportunity summary." });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /:id  — detail
// ═══════════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid opportunity ID." });
    const [row] = await Opportunity.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(req.params.id) } },
      ...joinStages(),
      { $project: { ...ROW_PROJECT, serviceMix: 1, serviceLines: 1, travelRequirement: 1, probabilityOverridden: 1, legacyLeadStage: 1, automatedByRule: 1, accountId: 1, createdBy: 1 } },
    ]);
    if (!row) return res.status(404).json({ error: "Opportunity not found." });

    // OWN scope: your deals only — the board never listed it, the URL must not either.
    if ((req as any).leadsScope === "OWN") {
      const uid = userId((req as any).user);
      if (!row.ownerUserId || String(row.ownerUserId) !== uid) return res.status(403).json({ error: "This opportunity is owned by someone else." });
    }

    const { lead, company, primaryContact, ...opportunity } = row;
    const activities = row.leadId ? await LeadActivity.find({ leadId: row.leadId }).sort({ createdAt: -1 }).lean() : [];
    return res.json({
      opportunity,
      lead: lead || null,
      company: company || null,
      primaryContact: primaryContact || null,
      activities,
      stages: PIPELINE_STAGES[row.pipeline as OpportunityPipeline] || [],
    });
  } catch (err) {
    logger.error("opportunities GET /:id error", { err });
    return res.status(500).json({ error: "Failed to get opportunity." });
  }
});

export default router;
