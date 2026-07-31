// apps/backend/src/config/visaConsent.ts
//
// The representation/data-processing/terms consent shown on screen 5
// (review & submit) immediately above the submit button. Versioned
// deliberately: the wording WILL change over time, and "they agreed to
// something at some point" is not an audit record — VisaRequest stores one
// consents[] entry PER CLAUSE, each carrying its own version/acceptedAt/
// acceptedByUserId (see models/VisaRequest.ts), specifically so a stored
// acceptance always points at the exact clause and exact text that was
// accepted, not just a single blanket timestamp.
//
// Bump CURRENT_VISA_CONSENT_VERSION whenever intro/fullText/any clause label
// changes in any way that alters what the applicant is agreeing to — a typo
// fix that doesn't change meaning doesn't need a bump, a scope change does.
//
// v2 (2026-08) — replaces the single-checkbox v1 text with three distinct,
// independently-recorded clauses (representation, data processing, terms),
// reviewed copy naming the legal entity — Peachmint Trips and Planners
// Private Limited, operating under the brands PlumTrips and Helloviza.
//
// LINKS: the DATA_PROCESSING/TERMS clause text below references a "Privacy
// Policy" and "Terms of Service" by name but never links to one — neither
// page exists at a real URL in this app (checked: no /privacy or /terms
// route anywhere in apps/frontend/src/router.tsx, and the one other place
// "Terms of Service" appears in the app, SBTHotelGuests.tsx, is decorative
// unlinked text, not a real page either). Rendered as plain text until
// those pages exist for real — never link to a page that doesn't exist.

export const CURRENT_VISA_CONSENT_VERSION = "v2";

export const VISA_CONSENT_CLAUSES = [
  {
    id: "REPRESENTATION",
    label: "I authorise Peachmint Trips and Planners Private Limited to represent me for my visa application.",
  },
  {
    id: "DATA_PROCESSING",
    label:
      "I consent to the processing of my personal data in accordance with the Privacy Policy and the Digital " +
      "Personal Data Protection Act, 2023.",
  },
  {
    id: "TERMS",
    label: "I agree to the Terms of Service and Privacy Policy.",
  },
] as const;

export type VisaConsentClauseId = (typeof VISA_CONSENT_CLAUSES)[number]["id"];

export const VISA_CONSENT_CLAUSE_IDS: readonly VisaConsentClauseId[] = VISA_CONSENT_CLAUSES.map((c) => c.id);

export interface VisaConsentTextShape {
  // Summary shown above the three checkboxes — not itself a checkbox, and
  // not one of the three recorded clauses.
  intro: string;
  // The four numbered clauses, verbatim, shown behind a "Read all" expander.
  fullText: string;
  clauses: typeof VISA_CONSENT_CLAUSES;
}

export const VISA_CONSENT_TEXT: VisaConsentTextShape = {
  intro:
    "Authorise Peachmint Trips and Planners Private Limited (PlumTrips & Helloviza) and Consent to Data Processing\n" +
    "By submitting this application, you authorise us to act as your representative for this visa application and " +
    "consent to the processing of your personal data.",
  fullText:
    "By submitting this application, you:\n\n" +
    "1. Authorise Peachmint Trips and Planners Private Limited, operating under the brands PlumTrips and " +
    "Helloviza, to act as your authorised representative for your visa application. This includes preparing, " +
    "reviewing, submitting, tracking, communicating with the relevant embassy, consulate, foreign mission, visa " +
    "application centre (such as VFS Global, BLS International or other authorised service providers), and " +
    "responding to requests relating to your application.\n\n" +
    "2. Provide your free, informed, specific and unambiguous consent for Peachmint Trips and Planners Private " +
    "Limited to collect, use, store, verify, process and share your personal data solely for the purpose of " +
    "providing visa-related services, in accordance with the Digital Personal Data Protection Act, 2023 (India) " +
    "and other applicable laws.\n\n" +
    "3. Understand that your personal information, including passport details, identity documents, photographs, " +
    "travel information and supporting documents, may be shared with:\n" +
    "- Relevant embassies, consulates or foreign missions;\n" +
    "- Visa Application Centres (e.g., VFS Global, BLS International or equivalent authorised partners);\n" +
    "- Government authorities where legally required; and\n" +
    "- Trusted technology or service providers engaged by Peachmint Trips and Planners Private Limited, strictly " +
    "for processing your visa application.\n\n" +
    "4. Acknowledge that your personal data will be retained only for as long as necessary to fulfil the purposes " +
    "described above or as required under applicable law. You may exercise your rights available under " +
    "applicable data protection laws by contacting us through the details provided in our Privacy Policy.\n\n" +
    "By selecting these checkboxes and submitting your application, you confirm that you have read, understood " +
    "and agree to the Privacy Policy, Terms of Service, and this authorisation.",
  clauses: VISA_CONSENT_CLAUSES,
};
