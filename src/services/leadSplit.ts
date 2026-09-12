// apps/backend/src/services/leadSplit.ts
//
// THE Lead → (Lead + Opportunity) split logic — Phase 1 / Slice 2
// (docs/crm/PLUMBOX_MIGRATION_PLAN.md). One module, two halves:
//
//   planLeadSplit(lead, activities)  PURE. Given a lead as it is (legacy
//       `stage` + history) returns exactly what the split would do to it —
//       new status, whether an Opportunity is created and at which stage,
//       whether a demo activity is logged, what is preserved, and anything
//       that does not map cleanly. No I/O, no flag. The migration's dry run
//       is literally "plan every lead and count the plans".
//
//   applyLeadSplit(lead, plan, ctx)  WRITES the plan: upsert the Opportunity
//       on leadId (one per lead by index — a re-run cannot duplicate), append
//       the activities that make the change explainable (PRD N), $set the
//       lead's new fields. It NEVER touches Lead.stage and NEVER edits an
//       existing activity row.
//
// The same two functions serve the flagged live routes (PUT /leads/:id/stage,
// /win, /lose, /convert) through applyLegacyStageTransition(), so a lead
// moved to proposal_sent by the unchanged frontend and a lead migrated from
// proposal_sent end up in the identical shape.
//
// Reviewer-locked transition table (this overrides gap analysis §4.2):
//   new/email_sent/contacted → NEW / CONTACTED         no Opportunity
//   follow_up               → CONTACTED, keep nextFollowUpDate
//   demo_scheduled          → ENGAGED + `demo` activity
//   proposal_sent           → CONVERTED + Opportunity(Proposal)
//   negotiation             → CONVERTED + Opportunity(Negotiation)
//   won                     → CONVERTED + Opportunity(Closed Won)
//   lost                    → reached proposal_sent/negotiation/won ever?
//                               yes: CONVERTED + Opportunity(Closed Lost)
//                               no:  LOST at lead grain, reason kept
//
// Nothing here consults the feature flag except applyLegacyStageTransition
// (the route-facing entry); the migration runs the core deliberately.

import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import LeadActivity from "../models/LeadActivity.js";
import Opportunity from "../models/Opportunity.js";
import {
  LEGACY_LEAD_STAGES,
  LEGACY_TRANSITIONS,
  LEGACY_OPPORTUNITY_STAGES,
  MILESTONES,
  closedStage,
  pipelineForLeadType,
  pipelineStage,
  legacyStageToStatus,
  type LeadStatus,
  type LegacyLeadStage,
  type OpportunityPipeline,
} from "../models/crmTaxonomy.js";
import { hasTravelRequirement } from "../models/travelRequirement.js";
import { isCrmV2OpportunityEnabled, CrmV2DisabledError, CRM_V2_OPPORTUNITY_ENV } from "../config/crmV2.js";

type AnyObj = Record<string, any>;

/* ─────────────────────────── Inputs ─────────────────────────── */

/** The slice of a Lead the planner reads. Lean rows and hydrated docs both fit. */
export interface LeadLike {
  _id: any;
  leadCode?: string;
  stage?: string | null;
  status?: string | null;
  type?: string | null;
  companyName?: string;
  contactName?: string;
  source?: string;
  sourceChannel?: string;
  enquiryType?: string;
  assignedTo?: any;
  assignedToName?: string;
  createdBy?: any;
  companyId?: any;
  convertedToCompanyId?: any;
  convertedToContactId?: any;
  opportunityId?: any;
  dealValue?: number;
  currency?: string;
  lostReason?: string;
  wonDate?: Date | null;
  nextFollowUpDate?: Date | null;
  travelRequirement?: AnyObj | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** The slice of a LeadActivity the planner reads (history, oldest→newest or any order). */
export interface ActivityLike {
  type: string;
  toStage?: string | null;
  fromStage?: string | null;
  createdAt?: Date;
  subject?: { type?: string; id?: any } | null;
}

/* ─────────────────────────── Plan ─────────────────────────── */

export interface OpportunityPlan {
  pipeline: OpportunityPipeline;
  stage: string;
  /** Terminal timestamp for a closed stage, with where it came from. */
  closedAt: Date | null;
  closedAtSource: "wonDate" | "won_activity" | "lost_activity" | "lead_updatedAt" | "none";
  lostReason: string;
}

export interface SplitPlan {
  leadId: string;
  leadCode: string;
  legacyStage: string;
  /** Human-readable transition key, the unit the dry run counts by. */
  transition: string;
  leadStatus: LeadStatus | null;
  opportunity: OpportunityPlan | null;
  logDemo: boolean;
  preserveFollowUp: boolean;
  /** Where a `lost` landed. */
  lostAt: "lead" | "opportunity" | null;
  sourceChannel: string;
  enquiryType: string;
  /** Idempotency: the row already carries the result of a previous apply. */
  skipped: "already_converted" | "already_migrated" | null;
  /** The row does not map cleanly; apply() refuses it. */
  unmapped: string | null;
  warnings: string[];
}

export interface PlanOptions {
  /** "migration" (default) skips rows already carrying the split's output.
   *  "live" never skips — the lead just moved, apply what it moved to. */
  mode?: "migration" | "live";
}

function lastActivityOfType(acts: ActivityLike[], type: string): ActivityLike | null {
  let best: ActivityLike | null = null;
  for (const a of acts) {
    if (a.type !== type) continue;
    if (!best || (a.createdAt && best.createdAt && a.createdAt > best.createdAt)) best = a;
  }
  return best;
}

/** Did this lead's history ever enter the commercial process? Reads the
 *  legacy stage_change vocabulary (history is never rewritten) plus the
 *  dedicated `won` activity type the /win and /convert routes write. */
export function reachedOpportunityStage(lead: LeadLike, acts: ActivityLike[]): boolean {
  if (lead.opportunityId) return true;
  if (lead.wonDate) return true;
  for (const a of acts) {
    if (a.subject?.type && a.subject.type !== "LEAD") continue;
    if (a.type === "won") return true;
    if (a.type === "stage_change" && (LEGACY_OPPORTUNITY_STAGES as readonly string[]).includes(String(a.toStage || ""))) {
      return true;
    }
  }
  return false;
}

export function planLeadSplit(lead: LeadLike, activities: ActivityLike[] = [], opts: PlanOptions = {}): SplitPlan {
  const mode = opts.mode ?? "migration";
  const legacyStage = String(lead.stage || "");
  const base: SplitPlan = {
    leadId: String(lead._id),
    leadCode: lead.leadCode || "",
    legacyStage,
    transition: "",
    leadStatus: null,
    opportunity: null,
    logDemo: false,
    preserveFollowUp: false,
    lostAt: null,
    sourceChannel: lead.sourceChannel || lead.source || "",
    enquiryType: lead.enquiryType || (lead.type === "individual" ? "" : "corporate_account"),
    skipped: null,
    unmapped: null,
    warnings: [],
  };

  if (!(LEGACY_LEAD_STAGES as readonly string[]).includes(legacyStage)) {
    return { ...base, transition: `${legacyStage || "(blank)"}→UNMAPPED`, unmapped: `stage "${legacyStage || ""}" is not a legacy stage` };
  }
  const t = LEGACY_TRANSITIONS[legacyStage as LegacyLeadStage];
  const pipeline = pipelineForLeadType(lead.type);
  if (!base.enquiryType && lead.type === "individual") {
    base.warnings.push("enquiryType left blank (individual lead — service not recoverable from legacy row)");
  }

  let plan: SplitPlan;

  if (legacyStage === "lost") {
    const reached = reachedOpportunityStage(lead, activities);
    if (reached) {
      const lostAct = lastActivityOfType(activities, "lost");
      const closedAt = lostAct?.createdAt ?? lead.updatedAt ?? null;
      plan = {
        ...base,
        transition: "lost→CONVERTED+Opportunity(closed_lost)",
        leadStatus: "CONVERTED",
        lostAt: "opportunity",
        opportunity: {
          pipeline,
          stage: closedStage(pipeline, "lost"),
          closedAt,
          closedAtSource: lostAct?.createdAt ? "lost_activity" : lead.updatedAt ? "lead_updatedAt" : "none",
          lostReason: String(lead.lostReason || ""),
        },
      };
      if (!lostAct?.createdAt) plan.warnings.push("closedAt approximated from lead.updatedAt (no `lost` activity)");
    } else {
      plan = { ...base, transition: "lost→LOST(lead)", leadStatus: "LOST", lostAt: "lead" };
      if (!String(lead.lostReason || "").trim()) plan.warnings.push("lost without a reason");
    }
  } else if (t.opportunityStage) {
    const stage = t.opportunityStage[pipeline];
    const isWon = legacyStage === "won";
    const wonAct = isWon ? lastActivityOfType(activities, "won") : null;
    const closedAt = isWon ? (lead.wonDate ?? wonAct?.createdAt ?? lead.updatedAt ?? null) : null;
    plan = {
      ...base,
      transition: `${legacyStage}→CONVERTED+Opportunity(${stage})`,
      leadStatus: t.leadStatus,
      opportunity: {
        pipeline,
        stage,
        closedAt,
        closedAtSource: !isWon ? "none" : lead.wonDate ? "wonDate" : wonAct?.createdAt ? "won_activity" : lead.updatedAt ? "lead_updatedAt" : "none",
        lostReason: "",
      },
    };
    if (isWon && !lead.wonDate && !wonAct?.createdAt) plan.warnings.push("won without wonDate or `won` activity — closedAt approximated from lead.updatedAt");
    if (!(Number(lead.dealValue) > 0)) plan.warnings.push("opportunity created with dealValue 0");
  } else {
    plan = {
      ...base,
      transition: `${legacyStage}→${t.leadStatus}${t.logDemo ? "+demo" : ""}`,
      leadStatus: t.leadStatus,
      logDemo: !!t.logDemo,
      preserveFollowUp: !!t.preserveFollowUp,
    };
    if (t.preserveFollowUp && !lead.nextFollowUpDate) plan.warnings.push("follow_up without nextFollowUpDate");
  }

  // Sanity: the stage the plan names must exist in the pipeline's table.
  if (plan.opportunity && !pipelineStage(plan.opportunity.pipeline, plan.opportunity.stage)) {
    return { ...plan, opportunity: null, unmapped: `no stage "${plan.opportunity.stage}" in pipeline ${plan.opportunity.pipeline}` };
  }

  // Idempotency (migration mode only).
  if (mode === "migration") {
    if (lead.opportunityId) plan.skipped = "already_converted";
    else if (lead.status && !plan.opportunity) plan.skipped = "already_migrated";
  }
  return plan;
}

/* ─────────────────────────── Apply ─────────────────────────── */

export interface ApplyContext {
  /** "" for a human action; the migration id otherwise (rollback key). */
  ruleId: string;
  actorId?: mongoose.Types.ObjectId | null;
  actorName?: string;
  /** Pinned timestamp for migration-written activities (defaults to now). */
  at?: Date;
}

export interface ApplyResult {
  leadId: string;
  opportunityId: string | null;
  opportunityCreated: boolean;
  opportunityAdvanced: boolean;
  activitiesWritten: number;
  leadUpdated: boolean;
  skipped: SplitPlan["skipped"];
}

function oid(v: any): mongoose.Types.ObjectId | null {
  if (!v) return null;
  return mongoose.isValidObjectId(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null;
}

export async function applyLeadSplit(lead: LeadLike, plan: SplitPlan, ctx: ApplyContext): Promise<ApplyResult> {
  const result: ApplyResult = {
    leadId: plan.leadId,
    opportunityId: lead.opportunityId ? String(lead.opportunityId) : null,
    opportunityCreated: false,
    opportunityAdvanced: false,
    activitiesWritten: 0,
    leadUpdated: false,
    skipped: plan.skipped,
  };
  if (plan.unmapped) throw new Error(`refusing to apply an unmapped plan for lead ${plan.leadId}: ${plan.unmapped}`);
  if (plan.skipped) return result;

  const leadId = new mongoose.Types.ObjectId(String(lead._id));
  const actor = { createdBy: ctx.actorId ?? oid(lead.assignedTo) ?? undefined, createdByName: ctx.actorName || "System" };
  const stamp = ctx.at ? { createdAt: ctx.at } : {};

  // ── Opportunity: find-or-create on leadId (unique partial index) ──
  let oppId: mongoose.Types.ObjectId | null = null;
  if (plan.opportunity) {
    const p = plan.opportunity;
    const existing = await Opportunity.findOne({ leadId });
    if (existing) {
      oppId = existing._id as mongoose.Types.ObjectId;
      if (existing.stage !== p.stage || existing.pipeline !== p.pipeline) {
        const from = existing.stage;
        if (existing.pipeline !== p.pipeline) existing.pipeline = p.pipeline;
        existing.stage = p.stage;
        if (p.closedAt) existing.closedAt = p.closedAt;
        if (p.lostReason) existing.lostReason = p.lostReason;
        if (p.stage === closedStage(p.pipeline, "lost") && !existing.lostReason && lead.lostReason) {
          existing.lostReason = String(lead.lostReason);
        }
        await existing.save();
        await LeadActivity.create({
          leadId,
          subject: { type: "OPPORTUNITY", id: oppId },
          type: "stage_change",
          note: `Opportunity stage changed from ${from} to ${p.stage}`,
          fromStage: from,
          toStage: p.stage,
          automatedByRule: ctx.ruleId,
          ...actor,
          ...stamp,
        });
        result.activitiesWritten++;
        result.opportunityAdvanced = true;
      }
    } else {
      try {
        const created = await Opportunity.create({
          name: lead.companyName || lead.contactName || lead.leadCode || "Opportunity",
          pipeline: p.pipeline,
          stage: p.stage,
          dealValue: Number(lead.dealValue) > 0 ? Number(lead.dealValue) : 0,
          currency: lead.currency || "INR",
          closedAt: p.closedAt,
          lostReason: p.lostReason,
          primaryContactId: oid(lead.convertedToContactId),
          companyId: oid(lead.companyId) ?? oid(lead.convertedToCompanyId),
          leadId,
          ownerUserId: oid(lead.assignedTo),
          ownerName: lead.assignedToName || "",
          createdBy: oid(lead.createdBy) ?? ctx.actorId ?? null,
          legacyLeadStage: plan.legacyStage,
          automatedByRule: ctx.ruleId,
          travelRequirement: hasTravelRequirement(lead.travelRequirement as any) ? lead.travelRequirement : {},
          serviceMix: (lead.travelRequirement as any)?.serviceMix ?? [],
          ...stamp,
        });
        oppId = created._id as mongoose.Types.ObjectId;
        result.opportunityCreated = true;
      } catch (e: any) {
        // Lost a race on the unique leadId index — the other writer's row is
        // the opportunity; take it and fall through to the lead update.
        if (e?.code !== 11000) throw e;
        const winner = await Opportunity.findOne({ leadId }).select("_id").lean();
        if (!winner) throw e;
        oppId = winner._id as mongoose.Types.ObjectId;
      }
      if (result.opportunityCreated) {
        await LeadActivity.create({
          leadId,
          subject: { type: "OPPORTUNITY", id: oppId },
          type: "stage_change",
          note: `Opportunity created from lead (legacy stage ${plan.legacyStage}) at ${p.stage}`,
          fromStage: "",
          toStage: p.stage,
          automatedByRule: ctx.ruleId,
          ...actor,
          ...stamp,
        });
        result.activitiesWritten++;
      }
    }
    result.opportunityId = String(oppId);
  }

  // ── "A demo happened" survives the stage retirement ──
  if (plan.logDemo) {
    const already = ctx.ruleId
      ? await LeadActivity.exists({ leadId, type: "demo", automatedByRule: ctx.ruleId })
      : null;
    if (!already) {
      await LeadActivity.create({
        leadId,
        subject: { type: "LEAD", id: leadId },
        type: "demo",
        note: ctx.ruleId ? "Demo (recorded from legacy stage demo_scheduled)" : "Demo scheduled",
        automatedByRule: ctx.ruleId,
        ...actor,
        ...stamp,
      });
      result.activitiesWritten++;
    }
  }

  // ── Lead: new fields only. Lead.stage is NEVER written here (gap §4.4). ──
  const $set: AnyObj = {};
  if (plan.leadStatus) $set.status = plan.leadStatus;
  if (plan.sourceChannel && !lead.sourceChannel) $set.sourceChannel = plan.sourceChannel;
  if (plan.enquiryType && !lead.enquiryType) $set.enquiryType = plan.enquiryType;
  if (oppId) $set.opportunityId = oppId;
  if (Object.keys($set).length) {
    // Raw update on purpose: no hooks, no timestamps bump, no touch on stage.
    const r = await Lead.collection.updateOne({ _id: leadId }, { $set });
    result.leadUpdated = (r.modifiedCount ?? 0) > 0;
    // Keep a hydrated caller (the live routes) in step with the store.
    for (const [k, v] of Object.entries($set)) (lead as AnyObj)[k] = v;
  }
  return result;
}

/* ───────────────────── Live route entry (flag-gated) ─────────────────────
 * Called by PUT /leads/:id/stage, /win, /lose, /convert AFTER they have set
 * and saved the legacy `stage` (so the model hook has already derived
 * `status`). Re-plans the lead against its history in "live" mode and
 * applies: proposal_sent / negotiation / won create-or-advance the
 * Opportunity, demo_scheduled logs a demo, lost closes the Opportunity when
 * one exists. Returns the plan so the route can pick the automation trigger. */
export async function applyLegacyStageTransition(
  lead: LeadLike,
  ctx: Omit<ApplyContext, "ruleId" | "at">,
): Promise<{ plan: SplitPlan; result: ApplyResult }> {
  if (!isCrmV2OpportunityEnabled()) {
    throw new CrmV2DisabledError("applyLegacyStageTransition", CRM_V2_OPPORTUNITY_ENV);
  }
  const history = (await LeadActivity.find({ leadId: lead._id })
    .select("type toStage fromStage createdAt subject")
    .lean()) as ActivityLike[];
  const plan = planLeadSplit(lead, history, { mode: "live" });
  if (plan.unmapped) return { plan, result: { leadId: plan.leadId, opportunityId: null, opportunityCreated: false, opportunityAdvanced: false, activitiesWritten: 0, leadUpdated: false, skipped: null } };
  if (plan.opportunity === null && lead.opportunityId) {
    plan.warnings.push("lead moved back to a pre-opportunity stage; existing Opportunity left untouched");
  }
  const result = await applyLeadSplit(lead, plan, { ...ctx, ruleId: "" });
  return { plan, result };
}

/** Convenience for consumers that need the derived status of any row. */
export { legacyStageToStatus };

/* ───────────────────── Task-automation trigger for a plan ─────────────────
 * The legacy routes keyed triggers on the retired stage names
 * (lead.stage_contacted / _demo / _proposal, lead.won). Under the flag the
 * key comes from what the plan actually did, and the entity the task links
 * to is the Opportunity when one was created or advanced. Legacy aliases
 * are resolved inside triggerTaskAutomation(). */
export function automationTriggerForPlan(plan: SplitPlan): { key: string; entityType: "LEAD" | "OPPORTUNITY" } | null {
  if (plan.unmapped) return null;
  if (plan.opportunity) {
    const st = plan.opportunity.stage;
    if ((MILESTONES.won.oppStages as readonly string[]).includes(st)) return { key: "opportunity.won", entityType: "OPPORTUNITY" };
    if ((MILESTONES.lost.oppStages as readonly string[]).includes(st)) return { key: "opportunity.lost", entityType: "OPPORTUNITY" };
    if ((MILESTONES.negotiation.oppStages as readonly string[]).includes(st)) return { key: "opportunity.stage_negotiation", entityType: "OPPORTUNITY" };
    if ((MILESTONES.proposal.oppStages as readonly string[]).includes(st)) return { key: "opportunity.stage_proposal", entityType: "OPPORTUNITY" };
    return null;
  }
  if (plan.leadStatus === "CONTACTED") return { key: "lead.status_contacted", entityType: "LEAD" };
  if (plan.leadStatus === "ENGAGED") return { key: "lead.status_engaged", entityType: "LEAD" };
  return null;
}
