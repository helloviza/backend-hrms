// apps/backend/src/services/crmPipelines.ts
//
// Pipeline lookup + the access SEAM for the disposition slice.
//
//   ensureDefaultPipeline()   idempotent seed of "Corporate Calling" from
//                             models/crmDisposition.ts — $setOnInsert only, so
//                             an admin's later edits to the set survive restarts.
//   resolvePipelineForLead()  the pipeline a lead is worked in: its pipelineId,
//                             else the default (which is stamped on the lead at
//                             the first disposition — see services/disposition.ts).
//   findEntry()               the set row for a sub-disposition.
//   canWorkPipeline()         THE one place that decides whether a user may
//                             disposition leads in a pipeline. Today every
//                             pipeline has no teams, so anyone the route already
//                             let through (leads WRITE) may work it. When
//                             `teamIds` is populated this is where team
//                             membership is checked — nothing else hardcodes
//                             "one global set" or "one team".

import mongoose from "mongoose";
import CrmPipeline, { type CrmPipelineDoc } from "../models/CrmPipeline.js";
import { CORPORATE_CALLING_PIPELINE, CORPORATE_CALLING_SET, type DispositionEntry } from "../models/crmDisposition.js";

export async function ensureDefaultPipeline(): Promise<CrmPipelineDoc> {
  const existing = await CrmPipeline.findOne({ key: CORPORATE_CALLING_PIPELINE.key });
  if (existing) return existing;
  try {
    return await CrmPipeline.create({ ...CORPORATE_CALLING_PIPELINE, dispositionSet: CORPORATE_CALLING_SET, teamIds: [] });
  } catch (e: any) {
    // Lost a race with a concurrent seed — the unique key index caught it.
    if (e?.code === 11000) {
      const winner = await CrmPipeline.findOne({ key: CORPORATE_CALLING_PIPELINE.key });
      if (winner) return winner;
    }
    throw e;
  }
}

export async function resolvePipelineForLead(lead: { pipelineId?: any }): Promise<CrmPipelineDoc> {
  if (lead.pipelineId && mongoose.isValidObjectId(String(lead.pipelineId))) {
    const p = await CrmPipeline.findById(lead.pipelineId);
    if (p) return p;
  }
  const def = await CrmPipeline.findOne({ isDefault: true, active: true });
  return def ?? ensureDefaultPipeline();
}

export function findEntry(pipeline: Pick<CrmPipelineDoc, "dispositionSet">, subDisposition: string): DispositionEntry | null {
  const key = String(subDisposition || "").trim().toLowerCase();
  return pipeline.dispositionSet.find((e) => e.subDisposition.toLowerCase() === key) ?? null;
}

/** Grouped view for a picker: disposition → its sub-dispositions (set order). */
export function groupedSet(pipeline: Pick<CrmPipelineDoc, "dispositionSet">) {
  const groups: Array<{ disposition: string; subs: DispositionEntry[] }> = [];
  for (const e of pipeline.dispositionSet) {
    let g = groups.find((x) => x.disposition === e.disposition);
    if (!g) {
      g = { disposition: e.disposition, subs: [] };
      groups.push(g);
    }
    g.subs.push(e);
  }
  return groups;
}

export interface PipelineActor {
  id?: string;
  roles?: string[];
  /** Reserved: the teams this user belongs to (none exist yet). */
  teamIds?: string[];
}

/** Access seam. See file header. */
export function canWorkPipeline(actor: PipelineActor, pipeline: Pick<CrmPipelineDoc, "teamIds" | "active">): boolean {
  if (!pipeline.active) return false;
  const roles = (actor.roles || []).map((r) => String(r).toUpperCase());
  if (roles.includes("SUPERADMIN") || roles.includes("ADMIN")) return true;
  if (!pipeline.teamIds || pipeline.teamIds.length === 0) return true; // no team scoping yet
  const mine = new Set((actor.teamIds || []).map(String));
  return pipeline.teamIds.some((t) => mine.has(String(t)));
}
