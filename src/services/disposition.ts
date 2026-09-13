// apps/backend/src/services/disposition.ts
//
// THE disposition write path (Phase 1 / disposition slice). One call:
//
//   applyDisposition(lead, { subDisposition, note?, nextFollowUpDate?, actor })
//
// does, in order, and only this:
//   1. resolve the lead's pipeline (default stamped on first use) and the set
//      entry for the sub-disposition — unknown sub → error, nothing written;
//   2. DERIVE the four lead fields from the entry (disposition, subDisposition,
//      dispositionStage, dispositionStatus) plus the coherent Slice-2 status
//      and legacy stage the kanban/reports read — the rep never sets these;
//   3. capture nextFollowUpDate when the entry implies a next touch (required
//      then, ignored otherwise); lostReason ← sub-disposition on a Lost status;
//   4. append ONE `disposition` activity carrying from → to (explainable, never
//      rewrites history);
//   5. the SHADOW OPPORTUNITY — the rep works the lead only:
//        effect "open"  first time → create the Opportunity in the pipeline's
//                       deal pipeline at the entry's stage; later → sync stage
//                       + dealValue. Idempotent: find-by-leadId first, and the
//                       unique partial index on Opportunity.leadId closes the race.
//        effect "won"   → opportunity closed-won (created at closed-won if the
//                       lead was never Interested — Onboarded is a valid first
//                       disposition on the sheet).
//        effect "lost"  → opportunity closed-lost IF one exists (a lost lead
//                       that was never Interested stays lead-grain lost);
//        effect "none"  → nothing.
//      Every opportunity stage move appends an OPPORTUNITY stage_change row
//      (same shape services/leadSplit.ts writes) so timelines stay one story.
//   6. task-automation triggers: next_followup when a date was captured; the
//      opportunity milestone keys when the deal moved (legacy aliases resolve
//      inside triggerTaskAutomation).
//
// Not flag-checked here — the route is. Nothing here touches a lead that is
// not being dispositioned; migrated leads keep their stage/status untouched.

import mongoose from "mongoose";
import Lead, { type LeadDoc } from "../models/Lead.js";
import LeadActivity, { type DispositionSnapshot } from "../models/LeadActivity.js";
import Opportunity from "../models/Opportunity.js";
import { closedStage, isClosedOpportunityStage, MILESTONES } from "../models/crmTaxonomy.js";
import { FRESH_DISPOSITION, type DispositionEntry } from "../models/crmDisposition.js";
import { triggerTaskAutomation } from "./taskAutomation.js";
import { SYSTEM_WORKSPACE_ID } from "../config/defaultTaskAutomations.js";
import { resolvePipelineForLead, findEntry, canWorkPipeline, type PipelineActor } from "./crmPipelines.js";

export class DispositionError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = "DispositionError";
  }
}

export interface ApplyDispositionInput {
  subDisposition: string;
  note?: string;
  nextFollowUpDate?: string | Date | null;
  actor: PipelineActor & { name?: string };
}

export interface ApplyDispositionResult {
  lead: LeadDoc;
  entry: DispositionEntry;
  from: DispositionSnapshot;
  to: DispositionSnapshot;
  opportunity: null | { id: string; created: boolean; stage: string; fromStage: string | null; effect: DispositionEntry["opportunityEffect"] };
  activityId: string;
  pipeline: { id: string; key: string; name: string };
}

export function snapshotOf(lead: Pick<LeadDoc, "disposition" | "subDisposition" | "dispositionStage" | "dispositionStatus">): DispositionSnapshot {
  return {
    disposition: lead.disposition || "",
    subDisposition: lead.subDisposition || "",
    stage: lead.dispositionStage || FRESH_DISPOSITION.stage,
    status: lead.dispositionStatus || FRESH_DISPOSITION.status,
  };
}

function oid(v: any): mongoose.Types.ObjectId | null {
  return v && mongoose.isValidObjectId(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null;
}

export async function applyDisposition(lead: LeadDoc, input: ApplyDispositionInput): Promise<ApplyDispositionResult> {
  const pipeline = await resolvePipelineForLead(lead);
  if (!canWorkPipeline(input.actor, pipeline)) throw new DispositionError("You are not on a team that works this pipeline.", 403);
  const entry = findEntry(pipeline, input.subDisposition);
  if (!entry) throw new DispositionError(`"${input.subDisposition}" is not a sub-disposition of ${pipeline.name}.`, 400);

  let followUp: Date | null = null;
  if (entry.nextTouch) {
    if (!input.nextFollowUpDate) throw new DispositionError(`"${entry.subDisposition}" needs a next follow-up date.`, 400);
    followUp = new Date(input.nextFollowUpDate);
    if (isNaN(followUp.getTime())) throw new DispositionError("nextFollowUpDate is not a valid date.", 400);
  }

  const from = snapshotOf(lead);
  const to: DispositionSnapshot = { disposition: entry.disposition, subDisposition: entry.subDisposition, stage: entry.stage, status: entry.status };
  const actorId = oid(input.actor.id);
  const actorName = input.actor.name || "System";
  const note = String(input.note || "").trim();

  // ── 2/3. derive onto the lead ──
  if (!lead.pipelineId) lead.pipelineId = pipeline._id as mongoose.Types.ObjectId;
  lead.disposition = entry.disposition;
  lead.subDisposition = entry.subDisposition;
  lead.dispositionStage = entry.stage;
  lead.dispositionStatus = entry.status;
  lead.dispositionAt = new Date();
  const fromLegacyStage = lead.stage;
  const fromStatus = lead.status || null;
  lead.stage = entry.legacyStage;
  lead.status = entry.leadStatus;
  if (followUp) {
    lead.nextFollowUpDate = followUp;
    if (note) lead.followUpNotes = note;
  }
  if (entry.status === "Lost") lead.lostReason = entry.subDisposition;
  if (entry.status === "Won" && !lead.wonDate) lead.wonDate = new Date();
  await lead.save();

  // ── 4. the disposition activity ──
  const act = await LeadActivity.create({
    leadId: lead._id,
    subject: { type: "LEAD", id: lead._id },
    type: "disposition",
    note: note || `${entry.disposition} — ${entry.subDisposition}`,
    fromStage: String(fromLegacyStage || ""),
    toStage: entry.legacyStage,
    fromStatus: fromStatus || undefined,
    toStatus: entry.leadStatus,
    disposition: { from, to },
    createdBy: actorId ?? undefined,
    createdByName: actorName,
  });

  // ── 5. shadow opportunity ──
  let oppResult: ApplyDispositionResult["opportunity"] = null;
  const effect = entry.opportunityEffect;
  if (effect !== "none") {
    const leadId = lead._id as mongoose.Types.ObjectId;
    let opp = await Opportunity.findOne({ leadId });
    const targetStage =
      effect === "open" ? entry.opportunityStage! : effect === "won" ? closedStage(pipeline.opportunityPipeline, "won") : closedStage(pipeline.opportunityPipeline, "lost");

    if (!opp && effect === "lost") {
      // Never Interested → lost at the lead grain only. No phantom lost deal.
    } else {
      let created = false;
      let fromStage: string | null = null;
      if (!opp) {
        try {
          opp = await Opportunity.create({
            name: lead.companyName || lead.contactName || lead.leadCode || "Opportunity",
            pipeline: pipeline.opportunityPipeline,
            stage: targetStage,
            dealValue: Number(lead.dealValue) > 0 ? Number(lead.dealValue) : 0,
            currency: lead.currency || "INR",
            primaryContactId: oid(lead.convertedToContactId),
            companyId: oid(lead.companyId) ?? oid(lead.convertedToCompanyId),
            leadId,
            ownerUserId: oid(lead.assignedTo),
            ownerName: lead.assignedToName || "",
            createdBy: actorId,
            legacyLeadStage: entry.legacyStage,
            automatedByRule: "",
            lostReason: effect === "lost" ? entry.subDisposition : "",
            travelRequirement: (lead as any).travelRequirement ?? {},
            serviceMix: (lead as any).travelRequirement?.serviceMix ?? [],
          });
          created = true;
        } catch (e: any) {
          if (e?.code !== 11000) throw e; // lost the race — take the winner
          opp = await Opportunity.findOne({ leadId });
          if (!opp) throw e;
        }
      }
      if (!created) {
        fromStage = opp!.stage;
        const wasClosed = isClosedOpportunityStage(opp!.pipeline, opp!.stage);
        if (opp!.stage !== targetStage) {
          opp!.stage = targetStage;
          if (wasClosed) opp!.closedAt = null; // reopened (e.g. Interested after a Lost)
        }
        if (Number(lead.dealValue) > 0) opp!.dealValue = Number(lead.dealValue);
        if (effect === "lost") opp!.lostReason = entry.subDisposition;
        if (lead.convertedToContactId && !opp!.primaryContactId) opp!.primaryContactId = oid(lead.convertedToContactId);
        if (lead.assignedTo && !opp!.ownerUserId) {
          opp!.ownerUserId = oid(lead.assignedTo);
          opp!.ownerName = lead.assignedToName || "";
        }
        if (opp!.isModified()) await opp!.save();
      }
      const changed = created || fromStage !== opp!.stage;
      if (changed) {
        await LeadActivity.create({
          leadId,
          subject: { type: "OPPORTUNITY", id: opp!._id },
          type: "stage_change",
          note: created
            ? `Opportunity opened from disposition "${entry.subDisposition}" at ${opp!.stage}`
            : `Opportunity moved ${fromStage} → ${opp!.stage} (disposition "${entry.subDisposition}")`,
          fromStage: fromStage || "",
          toStage: opp!.stage,
          createdBy: actorId ?? undefined,
          createdByName: actorName,
        });
      }
      if (!lead.opportunityId || String(lead.opportunityId) !== String(opp!._id)) {
        lead.opportunityId = opp!._id as mongoose.Types.ObjectId;
        await Lead.updateOne({ _id: lead._id }, { $set: { opportunityId: opp!._id } });
      }
      oppResult = { id: String(opp!._id), created, stage: opp!.stage, fromStage, effect };

      // ── 6. triggers for the deal move ──
      if (changed) {
        const st = opp!.stage;
        const key = (MILESTONES.won.oppStages as readonly string[]).includes(st)
          ? "opportunity.won"
          : (MILESTONES.lost.oppStages as readonly string[]).includes(st)
            ? "opportunity.lost"
            : (MILESTONES.negotiation.oppStages as readonly string[]).includes(st)
              ? "opportunity.stage_negotiation"
              : (MILESTONES.proposal.oppStages as readonly string[]).includes(st)
                ? "opportunity.stage_proposal"
                : null;
        if (key) {
          triggerTaskAutomation(key, {
            workspaceId: SYSTEM_WORKSPACE_ID,
            entityType: "OPPORTUNITY",
            entityId: opp!._id as mongoose.Types.ObjectId,
            entityRef: lead.leadCode,
            ownerId: lead.assignedTo,
            variables: { leadName: lead.contactName || lead.companyName || "Lead", ownerName: lead.assignedToName || "" },
          }).catch(() => {});
        }
      }
    }
  }

  if (followUp) {
    triggerTaskAutomation("lead.next_followup", {
      workspaceId: SYSTEM_WORKSPACE_ID,
      entityType: "LEAD",
      entityId: lead._id as mongoose.Types.ObjectId,
      entityRef: lead.leadCode,
      ownerId: lead.assignedTo,
      eventDate: followUp,
      variables: { leadName: lead.contactName || lead.companyName || "Lead" },
    }).catch(() => {});
  }

  return {
    lead,
    entry,
    from,
    to,
    opportunity: oppResult,
    activityId: String(act._id),
    pipeline: { id: String(pipeline._id), key: pipeline.key, name: pipeline.name },
  };
}
