// apps/backend/src/services/crmPipelines.ts
//
// Pipeline lookup + the access SEAM for the disposition slice.
//
//   ensureDefaultPipeline()   idempotent seed of "Corporate Calling" from
//                             models/crmDisposition.ts — creates the row only
//                             when none exists, so later edits to the set
//                             survive restarts. Called at STARTUP (server.ts,
//                             flag on) and by scripts/crm-disposition-set-apply.ts
//                             — never from a request (a GET must not write).
//   resolvePipelineForLead()  the pipeline a lead is worked in: its pipelineId,
//                             else the default (which is stamped on the lead at
//                             the first disposition — see services/disposition.ts).
//                             Never seeds: no row → PipelineNotConfiguredError (503).
//   findEntry()               the set row for a sub-disposition — active or not
//                             (callers refuse a NEW pick of an inactive one).
//   groupedSet()              the ACTIVE entries, grouped, for a picker.
//   canWorkPipeline()         THE one place that decides whether a user may
//                             disposition leads in a pipeline. Today every
//                             pipeline has no teams, so anyone the route already
//                             let through (leads WRITE) may work it. When
//                             `teamIds` is populated this is where team
//                             membership is checked — nothing else hardcodes
//                             "one global set" or "one team".

import mongoose from "mongoose";
import CrmPipeline, { type CrmPipelineDoc } from "../models/CrmPipeline.js";
import { CORPORATE_CALLING_PIPELINE, CORPORATE_CALLING_SET, isActiveEntry, type DispositionEntry } from "../models/crmDisposition.js";

/** No pipeline row to resolve — the startup seed did not run (flag was off at
 *  boot) or failed. Routes answer 503 with this message. */
export class PipelineNotConfiguredError extends Error {
  readonly status = 503;
  constructor() {
    super("The calling disposition set is not set up on this server yet. Restart the backend with CRM_V2_DISPOSITION=true (it seeds the default set at startup) or run scripts/crm-disposition-set-apply.ts.");
    this.name = "PipelineNotConfiguredError";
  }
}

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
  if (!def) throw new PipelineNotConfiguredError();
  return def;
}

export function findEntry(pipeline: Pick<CrmPipelineDoc, "dispositionSet">, subDisposition: string): DispositionEntry | null {
  const key = String(subDisposition || "").trim().toLowerCase();
  return pipeline.dispositionSet.find((e) => e.subDisposition.toLowerCase() === key) ?? null;
}

/** Grouped view for a picker: disposition → its ACTIVE sub-dispositions (set
 *  order). A disposition whose subs are all inactive drops out. */
export function groupedSet(pipeline: Pick<CrmPipelineDoc, "dispositionSet">) {
  const groups: Array<{ disposition: string; subs: DispositionEntry[] }> = [];
  for (const e of pipeline.dispositionSet) {
    if (!isActiveEntry(e)) continue;
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
