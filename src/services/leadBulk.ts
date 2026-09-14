// apps/backend/src/services/leadBulk.ts
//
// Bulk actions on leads (POST /leads/bulk) — the manager's "change N leads in
// one go". One entry point, four actions, one shape of report:
//
//   resolveBulkTarget   explicit leadIds[] OR the Full Table's filter (the
//                       same params GET /leads takes), resolved server-side
//                       under the caller's scope so "all 211 matching" is one
//                       call, not eleven pages. Capped at BULK_CAP.
//   validateBulkParams  the action's inputs, checked ONCE up front (unknown
//                       stage, illegal disposition pair, missing follow-up
//                       date) — a bad request never starts half-applied.
//   runBulk             applies the action to every resolved lead
//                       independently through THE single-lead write path:
//                         reassign     → what POST /:id/assign does (owner,
//                                        `assignment` activity, task +
//                                        opportunity owner cascade)
//                         stage        → what PUT /:id/stage does (legacy
//                                        stage, `stage_change` activity,
//                                        runOpportunitySplit)
//                         status       → the Slice-2 status; the model hook
//                                        derives the legacy stage, then the
//                                        same activity + split as a stage move
//                         disposition  → services/disposition.ts
//                                        applyDisposition — derives stage /
//                                        status, writes the disposition
//                                        activity, materialises the Won
//                                        contact and the shadow opportunity,
//                                        exactly like a single disposition
//                       A lead that throws lands in `failed` with its reason
//                       and the batch continues; a lead already in the target
//                       state is reported `unchanged` and NOT rewritten
//                       (re-running a bulk is idempotent). Every write carries
//                       the batch id in its activity note, so a timeline row
//                       always says which bulk change moved it and who did it.
//
// Access is the ROUTE's job (leadsAccess FULL, like bulk-assign); scope is
// applied here: the filter target is narrowed by leadMatch(scope), and an
// explicit id outside the caller's scope fails per lead with the same
// "owned by someone else" reason the single routes give.
import mongoose from "mongoose";
import type express from "express";
import Lead, { LEAD_STAGES, effectiveLeadStatus, type LeadDoc, type LeadStage } from "../models/Lead.js";
import LeadActivity, { type ActivityType } from "../models/LeadActivity.js";
import Opportunity from "../models/Opportunity.js";
import Task from "../models/Task.js";
import { LEAD_STATUSES, type LeadStatus } from "../models/crmTaxonomy.js";
import { type DispositionEntry } from "../models/crmDisposition.js";
import { isCrmV2DispositionEnabled, isCrmV2OpportunityEnabled } from "../config/crmV2.js";
import { applyDisposition } from "./disposition.js";
import { resolveDispositionCells } from "./leadImport.js";
import { runOpportunitySplit } from "./leadSplit.js";
import { resolvePipelineForLead, type PipelineActor } from "./crmPipelines.js";
import { canManageOthers, ownsLead, type ScopeCtx } from "./crmScope.js";
import logger from "../utils/logger.js";

type AnyObj = Record<string, any>;

export const BULK_CAP = 1000;
export const BULK_ACTIONS = ["reassign", "stage", "status", "disposition"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export class BulkError extends Error {
  constructor(message: string, readonly status: number = 400, readonly extra: AnyObj = {}) {
    super(message);
    this.name = "BulkError";
  }
}

/* ───────────────────────────── target ───────────────────────────── */

export interface BulkTarget {
  mode: "ids" | "filter";
  /** Every id the action will be attempted on (already de-duplicated; capped). */
  leadIds: string[];
  /** For filter mode: how many rows matched (≤ cap by construction). */
  matched: number;
}

/**
 * `target.leadIds` → those ids (invalid ones kept so they fail per lead).
 * `target.filter`  → the ids of every lead matching the Full Table filter
 *                    under the caller's scope, newest first, capped.
 */
export async function resolveBulkTarget(
  raw: AnyObj,
  listFilter: (q: AnyObj) => AnyObj,
): Promise<BulkTarget> {
  const target = raw && typeof raw === "object" ? raw : {};
  if (Array.isArray(target.leadIds)) {
    const leadIds = Array.from(new Set(target.leadIds.map((v: unknown) => String(v))));
    if (leadIds.length === 0) throw new BulkError("leadIds is empty.");
    if (leadIds.length > BULK_CAP) throw new BulkError(`At most ${BULK_CAP} leads per bulk action (${leadIds.length} sent).`, 400, { cap: BULK_CAP, matched: leadIds.length });
    return { mode: "ids", leadIds, matched: leadIds.length };
  }
  if (target.filter && typeof target.filter === "object") {
    const filter = listFilter(target.filter);
    const rows = (await Lead.find(filter).sort({ createdAt: -1 }).select("_id").limit(BULK_CAP + 1).lean()) as Array<{ _id: mongoose.Types.ObjectId }>;
    if (rows.length === 0) throw new BulkError("No leads match this filter.", 400, { matched: 0 });
    if (rows.length > BULK_CAP) {
      const matched = await Lead.countDocuments(filter);
      throw new BulkError(`${matched} leads match — at most ${BULK_CAP} per bulk action. Narrow the filter.`, 400, { cap: BULK_CAP, matched });
    }
    return { mode: "filter", leadIds: rows.map((r) => String(r._id)), matched: rows.length };
  }
  throw new BulkError("target must carry leadIds[] or a filter.");
}

/* ───────────────────────────── params ───────────────────────────── */

export type BulkParams =
  | { action: "reassign"; assignedTo: string; assignedToName: string }
  | { action: "stage"; stage: LeadStage; note: string; nextFollowUpDate: Date | null }
  | { action: "status"; status: LeadStatus; note: string }
  | { action: "disposition"; entry: DispositionEntry; note: string; nextFollowUpDate: Date | null };

/** Check the action's inputs once, before any lead is touched. */
export async function validateBulkParams(
  action: unknown,
  params: AnyObj,
  resolveUserName: (id: string) => Promise<string>,
): Promise<BulkParams> {
  if (!(BULK_ACTIONS as readonly string[]).includes(String(action))) {
    throw new BulkError(`action must be one of: ${BULK_ACTIONS.join(", ")}.`);
  }
  const p = params && typeof params === "object" ? params : {};
  const note = String(p.note || "").trim();
  const parseDate = (v: unknown): Date | null => {
    if (!v) return null;
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
  };

  switch (action as BulkAction) {
    case "reassign": {
      const assignedTo = String(p.assignedTo || "");
      if (!mongoose.isValidObjectId(assignedTo)) throw new BulkError("Valid assignedTo is required.");
      const assignedToName = await resolveUserName(assignedTo);
      if (!assignedToName) throw new BulkError("User not found.", 404);
      return { action: "reassign", assignedTo, assignedToName };
    }
    case "stage": {
      const stage = String(p.stage || "");
      if (!(LEAD_STAGES as readonly string[]).includes(stage)) throw new BulkError(`Invalid stage. Must be one of: ${LEAD_STAGES.join(", ")}`);
      const nextFollowUpDate = parseDate(p.nextFollowUpDate);
      if (p.nextFollowUpDate && !nextFollowUpDate) throw new BulkError("nextFollowUpDate is not a valid date.");
      if (stage === "follow_up" && !nextFollowUpDate) throw new BulkError("nextFollowUpDate is required for follow_up stage.");
      if (stage === "follow_up" && !note) throw new BulkError("A note is required when moving leads to follow_up.");
      return { action: "stage", stage: stage as LeadStage, note, nextFollowUpDate };
    }
    case "status": {
      if (!isCrmV2OpportunityEnabled()) throw new BulkError("Status changes need CRM_V2_OPPORTUNITY.", 404);
      const status = String(p.status || "").toUpperCase();
      if (!(LEAD_STATUSES as readonly string[]).includes(status)) throw new BulkError(`Invalid status. Must be one of: ${LEAD_STATUSES.join(", ")}`);
      return { action: "status", status: status as LeadStatus, note };
    }
    case "disposition": {
      if (!isCrmV2DispositionEnabled()) throw new BulkError("Dispositions need CRM_V2_DISPOSITION.", 404);
      const pipeline = await resolvePipelineForLead({});
      const r = resolveDispositionCells(String(p.disposition || ""), String(p.subDisposition || ""), pipeline.dispositionSet);
      if ("error" in r) throw new BulkError(r.error);
      const nextFollowUpDate = parseDate(p.nextFollowUpDate);
      if (p.nextFollowUpDate && !nextFollowUpDate) throw new BulkError("nextFollowUpDate is not a valid date.");
      if (r.entry.nextTouch && !nextFollowUpDate) throw new BulkError(`"${r.entry.subDisposition}" needs a next follow-up date.`);
      return { action: "disposition", entry: r.entry, note, nextFollowUpDate };
    }
  }
  throw new BulkError("Unsupported action.");
}

/* ───────────────────────────── run ───────────────────────────── */

export interface BulkActor extends PipelineActor {
  id: string;
  name: string;
}

export interface BulkReport {
  batchId: string;
  action: BulkAction;
  target: { mode: BulkTarget["mode"]; matched: number };
  summary: { requested: number; updated: number; unchanged: number; failed: number };
  updated: Array<{ _id: string; leadCode: string; contactName: string; from: string; to: string; unchanged: boolean; opportunityId: string | null; contactId: string | null }>;
  failed: Array<{ _id: string; leadCode: string; reason: string }>;
}

export async function runBulk(input: { target: BulkTarget; params: BulkParams; scope: ScopeCtx; actor: BulkActor; /** false = the legacy /bulk-assign note text, untagged */ tagNotes?: boolean }): Promise<BulkReport> {
  const { target, params, scope, actor } = input;
  const batchId = `BLK-${new Date().toISOString().slice(0, 10)}-${new mongoose.Types.ObjectId().toHexString().slice(-6)}`;
  const actorId = mongoose.isValidObjectId(actor.id) ? new mongoose.Types.ObjectId(actor.id) : undefined;
  const actorName = actor.name || "System";
  const tag = input.tagNotes === false ? "" : ` (bulk ${batchId})`;
  const report: BulkReport = { batchId, action: params.action, target: { mode: target.mode, matched: target.matched }, summary: { requested: target.leadIds.length, updated: 0, unchanged: 0, failed: 0 }, updated: [], failed: [] };

  for (const id of target.leadIds) {
    if (!mongoose.isValidObjectId(id)) {
      report.failed.push({ _id: id, leadCode: "", reason: "Invalid lead ID." });
      continue;
    }
    let lead: LeadDoc | null = null;
    try {
      lead = await Lead.findById(id);
      if (!lead) {
        report.failed.push({ _id: id, leadCode: "", reason: "Lead not found." });
        continue;
      }
      // Scope: an id the caller may not touch fails here, exactly as the
      // single routes answer 403 (filter targets never contain one).
      if (!canManageOthers(scope) && !ownsLead(scope, lead)) {
        report.failed.push({ _id: id, leadCode: lead.leadCode, reason: "This lead is owned by someone else." });
        continue;
      }

      let row: BulkReport["updated"][number];
      switch (params.action) {
        case "reassign":
          row = await reassignOne(lead, params, actorId, actorName, tag);
          break;
        case "stage":
          row = await stageOne(lead, params, actor, actorId, actorName, tag);
          break;
        case "status":
          row = await statusOne(lead, params, actor, actorId, actorName, tag);
          break;
        case "disposition":
          row = await dispositionOne(lead, params, actor, tag);
          break;
      }
      report.updated.push(row);
      if (row.unchanged) report.summary.unchanged += 1;
      else report.summary.updated += 1;
    } catch (e: any) {
      logger.error("leads bulk per-lead error", { batchId, id, err: e });
      report.failed.push({ _id: id, leadCode: lead?.leadCode || "", reason: e?.message || "Could not update this lead." });
    }
  }
  report.summary.failed = report.failed.length;
  return report;
}

/* ── the four per-lead applications ── */

type Row = BulkReport["updated"][number];
const base = (lead: LeadDoc, from: string, to: string, unchanged: boolean): Row => ({
  _id: String(lead._id), leadCode: lead.leadCode, contactName: lead.contactName, from, to, unchanged,
  opportunityId: lead.opportunityId ? String(lead.opportunityId) : null, contactId: lead.convertedToContactId ? String(lead.convertedToContactId) : null,
});

/** Same as POST /:id/assign and /bulk-assign: owner + `assignment` activity + cascade. */
async function reassignOne(lead: LeadDoc, p: Extract<BulkParams, { action: "reassign" }>, actorId: mongoose.Types.ObjectId | undefined, actorName: string, tag: string): Promise<Row> {
  const previousOwnerName = lead.assignedToName || "";
  const unchanged = String(lead.assignedTo || "") === p.assignedTo;
  if (unchanged) return base(lead, previousOwnerName, p.assignedToName, true);
  lead.assignedTo = new mongoose.Types.ObjectId(p.assignedTo);
  lead.assignedToName = p.assignedToName;
  await lead.save();
  await LeadActivity.create({
    leadId: lead._id,
    type: "assignment" as ActivityType,
    note: `${previousOwnerName ? `Reassigned to ${p.assignedToName} (from ${previousOwnerName})` : `Assigned to ${p.assignedToName}`}${tag}`,
    createdBy: actorId,
    createdByName: actorName,
  });
  // Reassignment cascade — identical to POST /:id/assign.
  Task.updateMany(
    { linkedType: "LEAD", linkedId: lead._id, status: { $in: ["OPEN", "IN_PROGRESS"] }, autoTriggerKey: { $exists: true } },
    { $set: { assignedTo: lead.assignedTo } },
  ).catch((err: any) => logger.error("leads bulk reassign cascade error", { err }));
  Opportunity.updateOne({ leadId: lead._id }, { $set: { ownerUserId: lead.assignedTo, ownerName: lead.assignedToName } })
    .catch((err: any) => logger.error("leads bulk reassign opportunity cascade error", { err }));
  return base(lead, previousOwnerName, p.assignedToName, false);
}

/** Same as PUT /:id/stage: legacy stage, `stage_change` activity, split hook. */
async function stageOne(lead: LeadDoc, p: Extract<BulkParams, { action: "stage" }>, actor: BulkActor, actorId: mongoose.Types.ObjectId | undefined, actorName: string, tag: string): Promise<Row> {
  const fromStage = String(lead.stage);
  if (fromStage === p.stage && !(p.stage === "follow_up" && p.nextFollowUpDate)) return base(lead, fromStage, p.stage, true);
  const flagOn = isCrmV2OpportunityEnabled();
  const fromStatus = flagOn ? effectiveLeadStatus(lead) : undefined;
  lead.stage = p.stage;
  if (p.stage === "follow_up" && p.nextFollowUpDate) lead.nextFollowUpDate = p.nextFollowUpDate;
  await lead.save();
  await LeadActivity.create({
    leadId: lead._id,
    type: "stage_change" as ActivityType,
    note: `${p.note || `Stage changed from ${fromStage} to ${p.stage}`}${tag}`,
    fromStage,
    toStage: String(p.stage),
    ...(flagOn ? { subject: { type: "LEAD", id: lead._id }, fromStatus, toStatus: effectiveLeadStatus(lead) } : {}),
    createdBy: actorId,
    createdByName: actorName,
  });
  const split = await runOpportunitySplit(lead as any, actor);
  const row = base(lead, fromStage, p.stage, false);
  if (split.opportunityId) row.opportunityId = split.opportunityId;
  return row;
}

/** Slice-2 status set: the model hook derives the legacy stage; then the same
 *  activity + split as a stage move so an opportunity-bearing status
 *  (CONVERTED) builds its deal the way proposal_sent does. */
async function statusOne(lead: LeadDoc, p: Extract<BulkParams, { action: "status" }>, actor: BulkActor, actorId: mongoose.Types.ObjectId | undefined, actorName: string, tag: string): Promise<Row> {
  const fromStatus = effectiveLeadStatus(lead);
  if (fromStatus === p.status && lead.status === p.status) return base(lead, fromStatus, p.status, true);
  const fromStage = String(lead.stage);
  lead.status = p.status;
  await lead.save(); // pre-validate derives `stage` from the new status
  await LeadActivity.create({
    leadId: lead._id,
    subject: { type: "LEAD", id: lead._id },
    type: "stage_change" as ActivityType,
    note: `${p.note || `Status changed from ${fromStatus} to ${p.status}`}${tag}`,
    fromStage,
    toStage: String(lead.stage),
    fromStatus,
    toStatus: p.status,
    createdBy: actorId,
    createdByName: actorName,
  });
  const split = await runOpportunitySplit(lead as any, actor);
  const row = base(lead, fromStatus, p.status, false);
  if (split.opportunityId) row.opportunityId = split.opportunityId;
  return row;
}

/** THE disposition write path — identical to POST /:id/disposition. */
async function dispositionOne(lead: LeadDoc, p: Extract<BulkParams, { action: "disposition" }>, actor: BulkActor, tag: string): Promise<Row> {
  const from = `${lead.disposition || "—"} / ${lead.subDisposition || "—"}`;
  const to = `${p.entry.disposition} / ${p.entry.subDisposition}`;
  if (lead.subDisposition === p.entry.subDisposition && !(p.entry.nextTouch && p.nextFollowUpDate)) return base(lead, from, to, true);
  const res = await applyDisposition(lead, {
    subDisposition: p.entry.subDisposition,
    // The note doubles as followUpNotes on next-touch entries, so the batch
    // tag rides only on the default text — a rep-written note stays clean.
    note: p.note || `${p.entry.disposition} — ${p.entry.subDisposition}${tag}`,
    nextFollowUpDate: p.nextFollowUpDate,
    actor,
  });
  const row = base(res.lead, from, to, false);
  row.opportunityId = res.opportunity?.id ?? row.opportunityId;
  row.contactId = res.contact?.id ?? row.contactId;
  return row;
}

/** Tiny adapter so the route can pass its req-bound filter builder. */
export type ListFilterBuilder = (req: express.Request, q: AnyObj) => AnyObj;
