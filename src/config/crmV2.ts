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
  readonly code = "CRM_V2_FOUNDATION_DISABLED";
  constructor(feature: string) {
    super(`${feature} requires ${CRM_V2_FOUNDATION_ENV}=true`);
    this.name = "CrmV2DisabledError";
  }
}
