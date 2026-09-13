// apps/backend/src/models/crmDisposition.ts
//
// THE calling-disposition vocabulary (Phase 1 / disposition slice). A leaf
// module with no imports, like crmTaxonomy.ts, so the CrmPipeline model, the
// disposition service, the routes and the tests read one copy of:
//
//   • the four derived enums a lead carries (dispositionStatus / dispositionStage)
//   • the shape of one row of a pipeline's disposition set
//   • the seed set for the ONE pipeline that exists today, "Corporate Calling",
//     transcribed EXACTLY from the calling sheet.
//
// The set is DATA on the pipeline row (models/CrmPipeline.ts): adding a second
// pipeline with its own dispositions is an insert, not a schema change. This
// file only holds the vocabulary and the seed.
//
// A rep picks a SUB-disposition. Everything else on the row is derived from
// the matching entry — the rep never sets stage or status directly.

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
   *  and reports still read. */
  leadStatus: "NEW" | "ASSIGNED" | "CONTACTED" | "ENGAGED" | "QUALIFIED" | "CONVERTED" | "NURTURE" | "LOST";
  legacyStage: "new" | "email_sent" | "contacted" | "demo_scheduled" | "proposal_sent" | "negotiation" | "follow_up" | "won" | "lost";
}

/* ─────────────── Corporate Calling — the seed set (from the sheet) ───────────────
 * Disposition → Sub-disposition → derived Stage / Status:
 *   Call Back      → Call Back Time Given / Call Back Time Not Given            → In-progress / Open
 *   Interested     → 8 subs                                           → In-progress / Open  (ALL fire the opportunity)
 *   Not Interested → 9 subs                                           → Lost / Lost
 *   Not Connected  → Number Does not Exist → Lost/Lost · Switched off → NC/Open
 *                    Ringing Only → NC/Open · Temp out of Service → Lost/Lost
 *   Onboarded      → Onboarded                                        → Won / Won
 */
const IP_OPEN = { stage: "In-progress", status: "Open" } as const;
const LOST = { stage: "Lost", status: "Lost" } as const;
const NC_OPEN = { stage: "NC", status: "Open" } as const;

export const CORPORATE_CALLING_SET: DispositionEntry[] = [
  // Call Back
  { disposition: "Call Back", subDisposition: "Call Back Time Given", ...IP_OPEN, nextTouch: true, opportunityEffect: "none", leadStatus: "CONTACTED", legacyStage: "follow_up" },
  { disposition: "Call Back", subDisposition: "Call Back Time Not Given", ...IP_OPEN, nextTouch: false, opportunityEffect: "none", leadStatus: "CONTACTED", legacyStage: "contacted" },
  // Interested — every sub fires / syncs the shadow opportunity
  { disposition: "Interested", subDisposition: "Follow up Required", ...IP_OPEN, nextTouch: true, opportunityEffect: "open", opportunityStage: "qualified", leadStatus: "CONVERTED", legacyStage: "follow_up" },
  { disposition: "Interested", subDisposition: "Introduction Email Sent", ...IP_OPEN, nextTouch: false, opportunityEffect: "open", opportunityStage: "qualified", leadStatus: "CONVERTED", legacyStage: "email_sent" },
  { disposition: "Interested", subDisposition: "Proposal Mail Required", ...IP_OPEN, nextTouch: false, opportunityEffect: "open", opportunityStage: "discovery", leadStatus: "CONVERTED", legacyStage: "contacted" },
  { disposition: "Interested", subDisposition: "Proposal Mail Sent", ...IP_OPEN, nextTouch: false, opportunityEffect: "open", opportunityStage: "proposal", leadStatus: "CONVERTED", legacyStage: "proposal_sent" },
  { disposition: "Interested", subDisposition: "Demo Scheduled", ...IP_OPEN, nextTouch: false, opportunityEffect: "open", opportunityStage: "discovery", leadStatus: "CONVERTED", legacyStage: "demo_scheduled" },
  { disposition: "Interested", subDisposition: "Negotiation in Progress", ...IP_OPEN, nextTouch: false, opportunityEffect: "open", opportunityStage: "negotiation", leadStatus: "CONVERTED", legacyStage: "negotiation" },
  { disposition: "Interested", subDisposition: "Agreement in Progress", ...IP_OPEN, nextTouch: false, opportunityEffect: "open", opportunityStage: "negotiation", leadStatus: "CONVERTED", legacyStage: "negotiation" },
  { disposition: "Interested", subDisposition: "NDA in Progress", ...IP_OPEN, nextTouch: false, opportunityEffect: "open", opportunityStage: "negotiation", leadStatus: "CONVERTED", legacyStage: "negotiation" },
  // Not Interested — all Lost / Lost
  { disposition: "Not Interested", subDisposition: "Stopped Answering Call", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  { disposition: "Not Interested", subDisposition: "Not Interested for Services", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  { disposition: "Not Interested", subDisposition: "Other Vendor onboarded", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  { disposition: "Not Interested", subDisposition: "Working with other vendors", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  { disposition: "Not Interested", subDisposition: "Trust Issue", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  { disposition: "Not Interested", subDisposition: "Not A right party contact", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  { disposition: "Not Interested", subDisposition: "Travel Desk Not Required", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  { disposition: "Not Interested", subDisposition: "Visa Services Not Required", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  { disposition: "Not Interested", subDisposition: "No Use Case Available", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  // Not Connected
  { disposition: "Not Connected", subDisposition: "Number Does not Exist", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  { disposition: "Not Connected", subDisposition: "Switched off", ...NC_OPEN, nextTouch: false, opportunityEffect: "none", leadStatus: "CONTACTED", legacyStage: "contacted" },
  { disposition: "Not Connected", subDisposition: "Ringing Only", ...NC_OPEN, nextTouch: false, opportunityEffect: "none", leadStatus: "CONTACTED", legacyStage: "contacted" },
  { disposition: "Not Connected", subDisposition: "Temp out of Service", ...LOST, nextTouch: false, opportunityEffect: "lost", leadStatus: "LOST", legacyStage: "lost" },
  // Onboarded
  { disposition: "Onboarded", subDisposition: "Onboarded", stage: "Onboarded", status: "Won", nextTouch: false, opportunityEffect: "won", leadStatus: "CONVERTED", legacyStage: "won" },
];

/** Pipeline seed for the one calling pipeline that exists today. */
export const CORPORATE_CALLING_PIPELINE = {
  key: "corporate_calling",
  name: "Corporate Calling",
  kind: "calling",
  opportunityPipeline: "corporate",
  isDefault: true,
} as const;

/** Structural check a set must pass before it is stored (and the seed must
 *  pass in tests): unique sub-dispositions, valid enums, opportunityStage
 *  present exactly when the effect is "open". */
export function validateDispositionSet(set: DispositionEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of set) {
    if (!e.disposition?.trim() || !e.subDisposition?.trim()) problems.push("blank disposition / sub-disposition");
    if (seen.has(e.subDisposition)) problems.push(`duplicate sub-disposition "${e.subDisposition}"`);
    seen.add(e.subDisposition);
    if (!(DISPOSITION_STAGES as readonly string[]).includes(e.stage)) problems.push(`"${e.subDisposition}": bad stage ${e.stage}`);
    if (!(DISPOSITION_STATUSES as readonly string[]).includes(e.status)) problems.push(`"${e.subDisposition}": bad status ${e.status}`);
    if (!(OPPORTUNITY_EFFECTS as readonly string[]).includes(e.opportunityEffect)) problems.push(`"${e.subDisposition}": bad effect`);
    if (e.opportunityEffect === "open" && !e.opportunityStage) problems.push(`"${e.subDisposition}": effect open needs opportunityStage`);
    if (e.opportunityEffect !== "open" && e.opportunityStage) problems.push(`"${e.subDisposition}": opportunityStage only valid with effect open`);
  }
  return problems;
}
