// apps/backend/src/config/crmV2.ts
//
// CRM_V2_FOUNDATION — the ship-dark switch for Phase 1 / Slice 1 of the
// Plumbox CRM rebuild (docs/crm/PLUMBOX_ARCHITECTURE_GAP_ANALYSIS.md).
//
// OFF (default, unset, anything but "true"): every CRM route behaves byte-for-
// byte as before this slice. The new CRMCompany account fields exist on the
// schema (they are inert — nothing writes them, and their defaults only
// materialise on rows that are saved for some other reason) and the
// crmassociations collection is never written.
//
// ON ("true"):
//   • CRMCompany.nameNormalized is set on every save from the shared key
//     (utils/companyName.ts) — POST /crm/companies, PUT /:id rename, and any
//     other .save() path.
//   • POST /crm/companies dedupes on nameNormalized the same way lead-side
//     resolve-or-create does: an existing match is RETURNED (200), not
//     duplicated and not rejected.
//   • POST/PUT accept the Company Account fields (accountType, lifecycleStatus,
//     accountTier, accountManagerId, customerId, customerWorkspaceId) through
//     an allow-list instead of the legacy body spread.
//   • services/crmAssociations.ts is enabled.
//
// Read live from process.env on every call (same pattern as
// config/visaScreening.ts) so a test can pin either state without re-importing
// and the switch can be flipped at runtime without a rebuild.

export const CRM_V2_FOUNDATION_ENV = "CRM_V2_FOUNDATION";

export function isCrmV2FoundationEnabled(): boolean {
  return String(process.env[CRM_V2_FOUNDATION_ENV] || "").trim().toLowerCase() === "true";
}

export class CrmV2DisabledError extends Error {
  readonly code: string;
  constructor(feature: string, flagEnv: string = CRM_V2_FOUNDATION_ENV) {
    super(`${feature} requires ${flagEnv}=true`);
    this.name = "CrmV2DisabledError";
    this.code = `${flagEnv}_DISABLED`;
  }
}

// ── CRM_V2_OPPORTUNITY — Phase 1 / Slice 2 (Lead → Lead + Opportunity) ──
//
// Independent of CRM_V2_FOUNDATION: Slice 2 has its own switch so the
// opportunity split can be dark while the account fields are live (or vice
// versa during a rollback).
//
// OFF (default): Lead routes behave byte-for-byte as before this slice. The
// new Lead paths (status, sourceChannel, enquiryType, travelRequirement,
// opportunityId) exist on the schema but nothing derives or writes them; the
// opportunities collection is never written; Sales Pulse and the owner-status
// report keep the legacy 9-stage vocabulary; task automation fires the
// legacy lead.stage_* keys.
//
// ON ("true"):
//   • Lead.status is kept coherent with Lead.stage by the model hook
//     (models/crmTaxonomy.ts is the one transition table).
//   • PUT /leads/:id/stage, /win, /lose, /convert route the legacy stage
//     value through services/leadSplit.ts: proposal_sent / negotiation / won
//     create-or-advance the lead's Opportunity; demo_scheduled logs a demo
//     activity; lost closes the Opportunity if one exists, else the Lead.
//   • Sales Pulse + owner-status report read the new taxonomy (tolerant of
//     legacy history rows — they are never rewritten).
//   • Task automation fires the new lead.status_* / opportunity.* keys, with
//     the legacy keys as aliases so existing TaskAutomation rows keep working.
//
// The migration script (scripts/migrate-lead-opportunity.ts) does NOT consult
// this flag: it is the thing that moves the data, and it is run deliberately.

export const CRM_V2_OPPORTUNITY_ENV = "CRM_V2_OPPORTUNITY";

export function isCrmV2OpportunityEnabled(): boolean {
  return String(process.env[CRM_V2_OPPORTUNITY_ENV] || "").trim().toLowerCase() === "true";
}
