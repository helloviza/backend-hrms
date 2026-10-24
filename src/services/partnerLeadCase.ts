// apps/backend/src/services/partnerLeadCase.ts
//
// What marks an approval request as a partner lead case, and the system
// identity those cases are raised by. Small and import-free on purpose: the
// email dispatcher, the booking sync and the routes all read it, and none of
// them should pull in the intake service to do so.
//
//   meta.source = "PARTNER_LINK" — set once by services/partnerIntake.create.ts,
//   together with meta.partnerLead (immutable, models/ApprovalRequest.ts).
//   No existing request carries it, so every branch keyed on it leaves
//   existing requests alone.

type AnyObj = Record<string, any>;

export const PARTNER_LINK_SOURCE = "PARTNER_LINK";

/** The one global requester of partner lead cases (scripts/seed-partner-intake-identity.ts). No login. */
export const PARTNER_INTAKE_EMAIL = "system-partner-intake@plumtrips.com";
export const PARTNER_INTAKE_NAME = "Partner Intake";
export const PARTNER_INTAKE_ROLE = "SYSTEM_PARTNER_INTAKE";

export function isPartnerLeadCase(ar: AnyObj | null | undefined): boolean {
  return String(ar?.meta?.source || "") === PARTNER_LINK_SOURCE;
}
