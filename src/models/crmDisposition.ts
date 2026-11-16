// apps/backend/src/models/crmDisposition.ts
//
// THE calling-disposition vocabulary (Phase 1 / disposition slice). It imports
// only the real Lead enums (Lead.status from crmTaxonomy, Lead.stage from the
// Lead model) so a set entry can be checked against what a lead can actually
// store. The CrmPipeline model, the disposition service, the routes, the
// set-apply script and the tests read one copy of:
//
//   • the four derived enums a lead carries (dispositionStatus / dispositionStage)
//   • the shape of one row of a pipeline's disposition set
//   • the seed set for the ONE pipeline that exists today, "Corporate Calling" —
//     v2 (2026-11-12): Imran's 21 active subs + the 11 retired v1 subs
//     (active: false). The live copy of the same 32 entries is
//     src/scripts/disposition-sets/corporate-calling-v2.json.
//
// The set is DATA on the pipeline row (models/CrmPipeline.ts): adding a second
// pipeline with its own dispositions is an insert, not a schema change. This
// file only holds the vocabulary and the seed.
//
// A rep picks a SUB-disposition. Everything else on the row is derived from
// the matching entry — the rep never sets stage or status directly.
//
// Changing the LIVE set: scripts/crm-disposition-set-apply.ts (dry run by
// default; --apply saves through the model so validateDispositionSet runs).

import { LEAD_STATUSES, pipelineStage, type LeadStatus } from "./crmTaxonomy.js";
import { LEAD_STAGES, type LeadStage } from "./Lead.js";

export const DISPOSITION_STATUSES = ["Open", "In-progress", "Lost", "Won"] as const;
export type DispositionStatus = (typeof DISPOSITION_STATUSES)[number];

export const DISPOSITION_STAGES = ["Prospect", "In-progress", "Lost", "Onboarded", "NC"] as const;
export type DispositionStage = (typeof DISPOSITION_STAGES)[number];

/** What a disposition does to the lead's shadow Opportunity. */
export const OPPORTUNITY_EFFECTS = ["none", "open", "won", "lost"] as const;
export type OpportunityEffect = (typeof OPPORTUNITY_EFFECTS)[number];

/** A fresh (never worked) lead: Open / Prospect, no disposition. */
export const FRESH_DISPOSITION = { stage: "Prospect", status: "Open" } as const;

export interface DispositionEntry {
  disposition: string;
  subDisposition: string;
  /** Derived onto Lead.dispositionStage. */
  stage: DispositionStage;
  /** Derived onto Lead.dispositionStatus. */
  status: DispositionStatus;
  /** The sub-disposition implies a next touch → capture nextFollowUpDate. */
  nextTouch: boolean;
  /** Shadow-opportunity effect (services/disposition.ts). */
  opportunityEffect: OpportunityEffect;
  /** Opportunity stage to create/sync to, for effect "open" (pipeline-scoped key). */
  opportunityStage?: string;
  /** Coherence with the rest of the CRM — derived, never rep-chosen:
   *  the Slice-2 Lead.status and the legacy 9-stage Lead.stage the kanban
   *  and reports still read. Must be values those Lead enums accept. */
  leadStatus: LeadStatus;
  legacyStage: LeadStage;
  /** false = retired: hidden from every picker and refused as a NEW pick,
   *  but still valid for the leads already on it (they display as before).
   *  Absent = true (rows stored before the field existed). */
  active?: boolean;
}

/** An entry a rep may pick now. Absent `active` counts as active. */
export function isActiveEntry(e: Pick<DispositionEntry, "active">): boolean {
  return e.active !== false;
}

/* ─────────────── Corporate Calling — the seed set (v2, Imran's set of 2026-11-12) ───────────────
 * 21 ACTIVE subs in 7 dispositions. Disposition → Sub-disposition → derived Stage / Status:
 *   Contacted      → Introduction Email Sent / Asked to follow up                → In-progress / Open
 *   Call Back      → Call Back Time Given / Call Back Time Not Given             → In-progress / Open
 *   Interested     → Demo Scheduled / Demo Done                                  → In-progress / Open  (no deal yet)
 *                    Proposal Mail Sent (deal at proposal) · Negotiation in Progress /
 *                    Onboarding link sent / Agreement in Progress / NDA in Progress (deal at negotiation)
 *   Nurture        → Nurture (one-sub group, like Onboarded)                     → In-progress / Open
 *   Not Interested → Repeated RNR / Competitor onboarded / Global tie up mandate /
 *                    Proposal rejected                                           → Lost / Lost
 *   Not Connected  → Number Does not Exist → Lost/Lost · Switched off → NC/Open
 *                    Ringing Only → NC/Open · Temp out of Service → Lost/Lost
 *   Onboarded      → Onboarded                                                   → Won / Won
 * Rule: every sub whose status is not Lost / Won needs a next follow-up date (nextTouch).
 *
 * 11 RETIRED subs (active: false) keep their v1 settings: hidden from every picker and
 * refused as a new pick, still valid for the leads already on them.
 *   Interested     → Follow up Required, Proposal Mail Required
 *   Not Interested → the nine v1 reasons
 */
const IP_OPEN = { stage: "In-progress", status: "Open" } as const;
const LOST = { stage: "Lost", status: "Lost" } as const;
const NC_OPEN = { stage: "NC", status: "Open" } as const;
const OPEN_NONE = { ...IP_OPEN, nextTouch: true, opportunityEffect: "none" } as const;
const LOST_ROW = { ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" } as const;
const RETIRED_LOST = { ...LOST_ROW, active: false } as const;

export const CORPORATE_CALLING_SET: DispositionEntry[] = [
  // Contacted
  { disposition: "Contacted", subDisposition: "Introduction Email Sent", ...OPEN_NONE, leadStatus: "CONTACTED", legacyStage: "contacted" },
  { disposition: "Contacted", subDisposition: "Asked to follow up", ...OPEN_NONE, leadStatus: "CONTACTED", legacyStage: "contacted" },
  // Call Back
  { disposition: "Call Back", subDisposition: "Call Back Time Given", ...OPEN_NONE, leadStatus: "CONTACTED", legacyStage: "follow_up" },
  { disposition: "Call Back", subDisposition: "Call Back Time Not Given", ...OPEN_NONE, leadStatus: "CONTACTED", legacyStage: "follow_up" },
  // Interested — demos carry no deal; from the proposal on, the shadow opportunity opens / syncs
  { disposition: "Interested", subDisposition: "Demo Scheduled", ...OPEN_NONE, leadStatus: "CONTACTED", legacyStage: "contacted" },
  { disposition: "Interested", subDisposition: "Demo Done", ...OPEN_NONE, leadStatus: "CONTACTED", legacyStage: "contacted" },
  { disposition: "Interested", subDisposition: "Proposal Mail Sent", ...IP_OPEN, nextTouch: true, opportunityEffect: "open", opportunityStage: "proposal", leadStatus: "CONVERTED", legacyStage: "proposal_sent" },
  { disposition: "Interested", subDisposition: "Negotiation in Progress", ...IP_OPEN, nextTouch: true, opportunityEffect: "open", opportunityStage: "negotiation", leadStatus: "CONVERTED", legacyStage: "negotiation" },
  { disposition: "Interested", subDisposition: "Onboarding link sent", ...IP_OPEN, nextTouch: true, opportunityEffect: "open", opportunityStage: "negotiation", leadStatus: "CONVERTED", legacyStage: "negotiation" },
  { disposition: "Interested", subDisposition: "Agreement in Progress", ...IP_OPEN, nextTouch: true, opportunityEffect: "open", opportunityStage: "negotiation", leadStatus: "CONVERTED", legacyStage: "negotiation" },
  { disposition: "Interested", subDisposition: "NDA in Progress", ...IP_OPEN, nextTouch: true, opportunityEffect: "open", opportunityStage: "negotiation", leadStatus: "CONVERTED", legacyStage: "negotiation" },
  // Nurture — one sub, so bulk / import may give the disposition alone
  { disposition: "Nurture", subDisposition: "Nurture", ...OPEN_NONE, leadStatus: "CONTACTED", legacyStage: "follow_up" },
  // Not Interested — all Lost / Lost
  { disposition: "Not Interested", subDisposition: "Repeated RNR", ...LOST_ROW },
  { disposition: "Not Interested", subDisposition: "Competitor onboarded", ...LOST_ROW },
  { disposition: "Not Interested", subDisposition: "Global tie up mandate", ...LOST_ROW },
  { disposition: "Not Interested", subDisposition: "Proposal rejected", ...LOST_ROW },
  // Not Connected
  { disposition: "Not Connected", subDisposition: "Number Does not Exist", ...LOST_ROW },
  { disposition: "Not Connected", subDisposition: "Switched off", ...NC_OPEN, nextTouch: true, opportunityEffect: "none", leadStatus: "CONTACTED", legacyStage: "contacted" },
  { disposition: "Not Connected", subDisposition: "Ringing Only", ...NC_OPEN, nextTouch: true, opportunityEffect: "none", leadStatus: "CONTACTED", legacyStage: "contacted" },
  { disposition: "Not Connected", subDisposition: "Temp out of Service", ...LOST_ROW },
  // Onboarded
  { disposition: "Onboarded", subDisposition: "Onboarded", stage: "Onboarded", status: "Won", nextTouch: false, opportunityEffect: "won", leadStatus: "CONVERTED", legacyStage: "won" },

  // ── Retired (active: false) — v1 settings unchanged ──
  { disposition: "Interested", subDisposition: "Follow up Required", ...IP_OPEN, nextTouch: true, opportunityEffect: "open", opportunityStage: "qualified", leadStatus: "CONVERTED", legacyStage: "follow_up", active: false },
  { disposition: "Interested", subDisposition: "Proposal Mail Required", ...IP_OPEN, nextTouch: false, opportunityEffect: "open", opportunityStage: "discovery", leadStatus: "CONVERTED", legacyStage: "contacted", active: false },
  { disposition: "Not Interested", subDisposition: "Stopped Answering Call", ...RETIRED_LOST },
  { disposition: "Not Interested", subDisposition: "Not Interested for Services", ...RETIRED_LOST },
  { disposition: "Not Interested", subDisposition: "Other Vendor onboarded", ...RETIRED_LOST },
  { disposition: "Not Interested", subDisposition: "Working with other vendors", ...RETIRED_LOST },
  { disposition: "Not Interested", subDisposition: "Trust Issue", ...RETIRED_LOST },
  { disposition: "Not Interested", subDisposition: "Not A right party contact", ...RETIRED_LOST },
  { disposition: "Not Interested", subDisposition: "Travel Desk Not Required", ...RETIRED_LOST },
  { disposition: "Not Interested", subDisposition: "Visa Services Not Required", ...RETIRED_LOST },
  { disposition: "Not Interested", subDisposition: "No Use Case Available", ...RETIRED_LOST },
];

/** Pipeline seed for the one calling pipeline that exists today. */
export const CORPORATE_CALLING_PIPELINE = {
  key: "corporate_calling",
  name: "Corporate Calling",
  kind: "calling",
  opportunityPipeline: "corporate",
  isDefault: true,
} as const;

/** Structural check a set must pass before it is stored (the CrmPipeline
 *  pre-validate hook runs it on every save; the seed must pass in tests):
 *   • sub-dispositions unique, case-insensitively (findEntry matches that way);
 *   • stage / status / effect from the disposition enums;
 *   • leadStatus a real Lead.status, legacyStage a real Lead.stage — a typo
 *     here would fail every lead.save() for that sub;
 *   • opportunityStage present exactly when the effect is "open", and — when
 *     the deal pipeline is given — a stage of that pipeline;
 *   • active, when present, a boolean. */
export function validateDispositionSet(set: DispositionEntry[], opportunityPipeline?: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of set) {
    if (!e.disposition?.trim() || !e.subDisposition?.trim()) problems.push("blank disposition / sub-disposition");
    const k = String(e.subDisposition || "").trim().toLowerCase();
    if (seen.has(k)) problems.push(`duplicate sub-disposition "${e.subDisposition}" (sub-dispositions are matched case-insensitively)`);
    seen.add(k);
    if (!(DISPOSITION_STAGES as readonly string[]).includes(e.stage)) problems.push(`"${e.subDisposition}": bad stage ${e.stage}`);
    if (!(DISPOSITION_STATUSES as readonly string[]).includes(e.status)) problems.push(`"${e.subDisposition}": bad status ${e.status}`);
    if (!(OPPORTUNITY_EFFECTS as readonly string[]).includes(e.opportunityEffect)) problems.push(`"${e.subDisposition}": bad effect`);
    if (!(LEAD_STATUSES as readonly string[]).includes(e.leadStatus)) problems.push(`"${e.subDisposition}": bad leadStatus ${e.leadStatus} (one of ${LEAD_STATUSES.join(", ")})`);
    if (!(LEAD_STAGES as readonly string[]).includes(e.legacyStage)) problems.push(`"${e.subDisposition}": bad legacyStage ${e.legacyStage} (one of ${LEAD_STAGES.join(", ")})`);
    if (e.opportunityEffect === "open" && !e.opportunityStage) problems.push(`"${e.subDisposition}": effect open needs opportunityStage`);
    if (e.opportunityEffect !== "open" && e.opportunityStage) problems.push(`"${e.subDisposition}": opportunityStage only valid with effect open`);
    if (opportunityPipeline && e.opportunityEffect === "open" && e.opportunityStage && !pipelineStage(opportunityPipeline, e.opportunityStage)) {
      problems.push(`"${e.subDisposition}": opportunityStage "${e.opportunityStage}" is not a stage of ${opportunityPipeline}`);
    }
    if (e.active !== undefined && typeof e.active !== "boolean") problems.push(`"${e.subDisposition}": active must be true or false`);
  }
  return problems;
}
