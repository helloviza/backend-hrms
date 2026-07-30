// apps/backend/src/config/visaConsent.ts
//
// The representation-and-processing consent shown on screen 5 (review &
// submit) immediately above the submit button. Versioned deliberately: the
// wording WILL change over time, and "they agreed to something at some
// point" is not an audit record — VisaRequest stores consentVersion
// alongside consentAcceptedAt/consentAcceptedByUserId (see
// models/VisaRequest.ts) specifically so a stored acceptance always points
// at the exact text that was accepted, not just a timestamp.
//
// Bump CURRENT_VISA_CONSENT_VERSION whenever VISA_CONSENT_TEXT changes in
// any way that alters what the applicant is agreeing to — a typo fix that
// doesn't change meaning doesn't need a bump, a scope change does.

export const CURRENT_VISA_CONSENT_VERSION = "v1";

export const VISA_CONSENT_TEXT =
  "By submitting, you authorise Helloviza to act as the applicant's representative before the relevant " +
  "foreign mission or consulate for this visa application — including preparing, lodging and following up " +
  "the file on the applicant's behalf. You confirm that the passport and identity data submitted with this " +
  "application will be stored by Helloviza, and that application documents will be shared with the mission " +
  "and, where required, its visa service partner (e.g. VFS Global or the equivalent outsourcing partner) to " +
  "process the application.";
