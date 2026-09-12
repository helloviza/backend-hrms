// apps/backend/src/models/crmTaxonomy.ts
//
// THE vocabulary for Phase 1 / Slice 2 of the Plumbox CRM rebuild — the
// Lead → (Lead + Opportunity) split (docs/crm/PLUMBOX_ARCHITECTURE_GAP_ANALYSIS.md
// §4, docs/crm/PLUMBOX_MIGRATION_PLAN.md). A leaf module with NO imports so
// the Lead model, the Opportunity model, the LeadActivity model, the split
// service, the migration script, Sales Pulse and the task-automation config
// all read exactly one copy of:
//
//   • the new Lead status taxonomy (PRD Section E),
//   • the source_channel / enquiry_type split (PRD Section E/O),
//   • the three pipelines and their stage tables with probabilities (PRD H),
//   • the shared travel-service vocabulary (mirrors TravelBooking.service —
//     asserted equal by models/Opportunity.test.ts so the two cannot drift),
//   • the legacy 9-stage → new taxonomy transition table, and
//   • the read-side alias table that labels EVERY vocabulary (legacy stage,
//     lead status, opportunity stage) so history rows are never rewritten.
//
// Nothing here consults the feature flag. Callers decide whether to act.

/* ───────────────────────────── Lead status ───────────────────────────── */

export const LEAD_STATUSES = [
  "NEW",        // created, no human action yet
  "ASSIGNED",   // owner known (reserved for the router; migration never emits it)
  "CONTACTED",  // ≥1 attempt logged
  "ENGAGED",    // prospect replied / demo held / requirement captured
  "QUALIFIED",  // need, timing, buyer known — Opportunity due same day (reserved)
  "CONVERTED",  // commercial process lives on an Opportunity; lead kept for attribution
  "NURTURE",    // fit but not now (reserved; requires a reason)
  "LOST",       // unqualified / invalid / declined at LEAD grain (reason required)
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: "New",
  ASSIGNED: "Assigned",
  CONTACTED: "Contacted",
  ENGAGED: "Engaged",
  QUALIFIED: "Qualified",
  CONVERTED: "Converted",
  NURTURE: "Nurture",
  LOST: "Lost",
};

/** A lead in one of these is no longer "open" at the lead grain. */
export const CLOSED_LEAD_STATUSES: readonly LeadStatus[] = ["CONVERTED", "LOST"];
export function isClosedLeadStatus(s: string | null | undefined): boolean {
  return (CLOSED_LEAD_STATUSES as readonly string[]).includes(String(s || ""));
}

/* ───────────────────── source_channel / enquiry_type ────────────────────
 * PRD E: "Use two fields rather than a single overloaded source". The legacy
 * Lead.source values are a strict subset of SOURCE_CHANNELS so the migration
 * copies them 1:1 (sourceChannel ← source) with nothing to guess. */

export const SOURCE_CHANNELS = [
  // legacy Lead.source values — kept verbatim so the copy is lossless
  "manual", "website", "linkedin", "facebook", "instagram", "referral",
  "cold_call", "email", "other",
  // PRD additions
  "whatsapp", "phone", "existing_customer", "travel_partner", "agent",
  "campaign", "walk_in", "api",
] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

export const ENQUIRY_TYPES = [
  "corporate_account",
  "flight",
  "hotel",
  "visa",
  "airport_transfer",
  "holiday_package",
  "business_travel_support",
  "combined",
  "partnership",
  "other",
] as const;
export type EnquiryType = (typeof ENQUIRY_TYPES)[number];

export const URGENCY_LEVELS = ["immediate", "within_7_days", "within_30_days", "flexible"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

/* ───────────────────────── Travel service vocabulary ─────────────────────
 * MUST equal TravelBooking's SERVICE_ENUM (models/TravelBooking.ts) so a
 * requirement, an opportunity's service mix and a booking share one word for
 * one service. models/Opportunity.test.ts asserts the equality. */

export const TRAVEL_SERVICES = [
  "FLIGHT", "HOTEL", "VISA", "CAB", "FOREX", "ESIM", "HOLIDAY",
  "MICE", "GIFTING", "DECOR", "TRANSFER", "TRAIN", "OTHER",
] as const;
export type TravelService = (typeof TRAVEL_SERVICES)[number];

/* ───────────────────────────── Pipelines ───────────────────────────── */

export const OPPORTUNITY_PIPELINES = ["corporate", "travel_enquiry", "partnerships"] as const;
export type OpportunityPipeline = (typeof OPPORTUNITY_PIPELINES)[number];

export interface PipelineStage {
  key: string;
  label: string;
  /** Stage-based default probability (PRD H). Overridable per opportunity. */
  probability: number;
  /** Terminal stages; everything else is open. */
  closed?: "won" | "lost";
}

// Stage keys are pipeline-scoped; the same key MAY mean the same thing in two
// pipelines (closed_won / closed_lost / new_enquiry) but nothing relies on it.
export const PIPELINE_STAGES: Record<OpportunityPipeline, readonly PipelineStage[]> = {
  corporate: [
    { key: "new_enquiry", label: "New enquiry", probability: 10 },
    { key: "qualified", label: "Qualified", probability: 25 },
    { key: "discovery", label: "Discovery / requirements", probability: 45 },
    { key: "proposal", label: "Proposal / quotation", probability: 65 },
    { key: "negotiation", label: "Negotiation / approval", probability: 80 },
    { key: "closed_won", label: "Closed Won", probability: 100, closed: "won" },
    { key: "closed_lost", label: "Closed Lost", probability: 0, closed: "lost" },
  ],
  travel_enquiry: [
    { key: "new_enquiry", label: "New enquiry", probability: 10 },
    { key: "requirement_captured", label: "Requirement captured", probability: 30 },
    { key: "options_sent", label: "Options / quote sent", probability: 55 },
    { key: "decision", label: "Decision / negotiation", probability: 75 },
    { key: "payment_pending", label: "Payment pending", probability: 90 },
    { key: "closed_won", label: "Booked / Won", probability: 100, closed: "won" },
    { key: "closed_lost", label: "Expired / Lost", probability: 0, closed: "lost" },
  ],
  partnerships: [
    { key: "identified", label: "Identified", probability: 10 },
    { key: "contacted", label: "Contacted", probability: 25 },
    { key: "fit_confirmed", label: "Fit confirmed", probability: 45 },
    { key: "terms", label: "Terms / agreement", probability: 65 },
    { key: "first_booking", label: "First booking", probability: 90 },
    { key: "active_partner", label: "Active partner", probability: 100, closed: "won" },
    { key: "closed_lost", label: "Closed Lost", probability: 0, closed: "lost" },
  ],
};

export function pipelineStage(pipeline: string, stage: string): PipelineStage | null {
  const list = PIPELINE_STAGES[pipeline as OpportunityPipeline];
  if (!list) return null;
  return list.find((s) => s.key === stage) ?? null;
}
export function isValidPipelineStage(pipeline: string, stage: string): boolean {
  return pipelineStage(pipeline, stage) !== null;
}
export function isClosedOpportunityStage(pipeline: string, stage: string): boolean {
  return !!pipelineStage(pipeline, stage)?.closed;
}
/** The one won / one lost stage of a pipeline. */
export function closedStage(pipeline: string, outcome: "won" | "lost"): string {
  const list = PIPELINE_STAGES[pipeline as OpportunityPipeline] ?? [];
  return list.find((s) => s.closed === outcome)?.key ?? (outcome === "won" ? "closed_won" : "closed_lost");
}

/* ─────────────── Legacy 9-stage Lead.stage → new taxonomy ───────────────
 * THE transition table (docs/crm/PLUMBOX_MIGRATION_PLAN.md §3). Used by the
 * migration for every existing row, and by the flagged routes for every
 * legacy stage value the unchanged frontend keeps sending. */

export const LEGACY_LEAD_STAGES = [
  "new", "email_sent", "contacted", "demo_scheduled", "proposal_sent",
  "negotiation", "follow_up", "won", "lost",
] as const;
export type LegacyLeadStage = (typeof LEGACY_LEAD_STAGES)[number];

export const LEGACY_STAGE_LABEL: Record<LegacyLeadStage, string> = {
  new: "New", email_sent: "Email Sent", contacted: "Contacted",
  demo_scheduled: "Demo Scheduled", proposal_sent: "Proposal Sent",
  negotiation: "Negotiation", follow_up: "Follow Up", won: "Won", lost: "Lost",
};

/** Legacy stages that mean "the commercial process has started" — a lead at
 *  or past one of these gets an Opportunity. demo_scheduled deliberately does
 *  NOT: a demo is engagement, not a deal (reviewer decision on gap §4.2). */
export const LEGACY_OPPORTUNITY_STAGES: readonly LegacyLeadStage[] = ["proposal_sent", "negotiation", "won"];

export interface LegacyTransition {
  /** Lead.status the row lands on. */
  leadStatus: LeadStatus;
  /** Opportunity stage to create/advance to, per pipeline; null = no Opportunity. */
  opportunityStage: null | { corporate: string; travel_enquiry: string; partnerships: string };
  /** Log a `demo` activity so "a demo happened" survives the stage retirement. */
  logDemo?: boolean;
  /** Keep Lead.nextFollowUpDate — follow_up was a flag, not a position. */
  preserveFollowUp?: boolean;
}

export const LEGACY_TRANSITIONS: Record<LegacyLeadStage, LegacyTransition> = {
  new: { leadStatus: "NEW", opportunityStage: null },
  email_sent: { leadStatus: "CONTACTED", opportunityStage: null },
  contacted: { leadStatus: "CONTACTED", opportunityStage: null },
  follow_up: { leadStatus: "CONTACTED", opportunityStage: null, preserveFollowUp: true },
  demo_scheduled: { leadStatus: "ENGAGED", opportunityStage: null, logDemo: true },
  proposal_sent: {
    leadStatus: "CONVERTED",
    opportunityStage: { corporate: "proposal", travel_enquiry: "options_sent", partnerships: "terms" },
  },
  negotiation: {
    leadStatus: "CONVERTED",
    opportunityStage: { corporate: "negotiation", travel_enquiry: "decision", partnerships: "terms" },
  },
  won: {
    leadStatus: "CONVERTED",
    opportunityStage: { corporate: "closed_won", travel_enquiry: "closed_won", partnerships: "active_partner" },
  },
  // lost is context-dependent (Opportunity lost if one was ever reached, else
  // Lead lost) — services/leadSplit.ts resolves it; this row is the
  // "no opportunity" branch.
  lost: { leadStatus: "LOST", opportunityStage: null },
};

export function legacyStageToStatus(stage: string | null | undefined): LeadStatus {
  const t = LEGACY_TRANSITIONS[String(stage || "") as LegacyLeadStage];
  return t ? t.leadStatus : "NEW";
}

/** Reverse map so the legacy `Lead.stage` column stays readable for the
 *  unchanged frontend while a flagged write sets `status`. Lossy on purpose
 *  (several legacy stages collapse into one status) — pick the mildest. */
export const STATUS_TO_LEGACY_STAGE: Record<LeadStatus, LegacyLeadStage> = {
  NEW: "new",
  ASSIGNED: "new",
  CONTACTED: "contacted",
  ENGAGED: "demo_scheduled",
  QUALIFIED: "demo_scheduled",
  CONVERTED: "proposal_sent",
  NURTURE: "follow_up",
  LOST: "lost",
};

/** Which pipeline a legacy lead's opportunity belongs to (gap §4.2 rule). */
export function pipelineForLeadType(type: string | null | undefined): OpportunityPipeline {
  return type === "individual" ? "travel_enquiry" : "corporate";
}

/* ────────────────── Read-side alias table (never rewrite rows) ──────────
 * LeadActivity.fromStage/toStage hold whichever vocabulary was current when
 * the row was written. Every consumer that prints a stage value goes through
 * stageLabel() so a 2025 "demo_scheduled" row, a 2026 "ENGAGED" row and an
 * opportunity "options_sent" row all render — PRD N append-only, risk M1. */

const OPPORTUNITY_STAGE_LABEL: Record<string, string> = {};
for (const list of Object.values(PIPELINE_STAGES)) {
  for (const s of list) if (!OPPORTUNITY_STAGE_LABEL[s.key]) OPPORTUNITY_STAGE_LABEL[s.key] = s.label;
}

export function stageLabel(value: string | null | undefined): string {
  const v = String(value || "");
  if (!v) return "";
  if (v in LEGACY_STAGE_LABEL) return LEGACY_STAGE_LABEL[v as LegacyLeadStage];
  if (v in LEAD_STATUS_LABEL) return LEAD_STATUS_LABEL[v as LeadStatus];
  if (v in OPPORTUNITY_STAGE_LABEL) return OPPORTUNITY_STAGE_LABEL[v];
  return v;
}

/* ─────────────── Milestones — the funnel spoken in both vocabularies ─────
 * Sales Pulse / owner-status count "movement into" milestones from activity
 * rows. A milestone lists every raw value that means it, across legacy lead
 * stages, new lead statuses and opportunity stages, so the counts are right
 * before, during and after the migration (risk M4/M12). */

export const MILESTONES = {
  contacted: { leadStages: ["email_sent", "contacted", "CONTACTED"], oppStages: [] as string[], activityTypes: [] as string[] },
  demo: { leadStages: ["demo_scheduled", "ENGAGED"], oppStages: [] as string[], activityTypes: ["demo"] },
  proposal: { leadStages: ["proposal_sent"], oppStages: ["proposal", "options_sent", "terms"], activityTypes: [] as string[] },
  negotiation: { leadStages: ["negotiation"], oppStages: ["negotiation", "decision", "payment_pending"], activityTypes: [] as string[] },
  won: { leadStages: ["won"], oppStages: ["closed_won", "active_partner"], activityTypes: ["won"] },
  lost: { leadStages: ["lost", "LOST"], oppStages: ["closed_lost"], activityTypes: ["lost"] },
} as const;
export type MilestoneKey = keyof typeof MILESTONES;

export interface MilestoneActivityLike {
  type: string;
  toStage?: string | null;
  toStatus?: string | null;
  subjectType?: string | null;
}

/** True when an activity row records entry into `milestone`, whatever
 *  vocabulary it was written in. */
export function activityHitsMilestone(a: MilestoneActivityLike, milestone: MilestoneKey): boolean {
  const m = MILESTONES[milestone];
  if ((m.activityTypes as readonly string[]).includes(a.type)) return true;
  if (a.type !== "stage_change") return false;
  const subject = a.subjectType || "LEAD";
  if (subject === "OPPORTUNITY") return (m.oppStages as readonly string[]).includes(String(a.toStage || ""));
  const to = String(a.toStatus || a.toStage || "");
  return (m.leadStages as readonly string[]).includes(to);
}
