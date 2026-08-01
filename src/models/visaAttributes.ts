// apps/backend/src/models/visaAttributes.ts
//
// Shared applicant-attribute vocabulary for the visa module (Phase 10a).
// These are FACTS ABOUT THE APPLICANT — employment, sponsorship, marital
// status, prior-visa history — that repeat across every country's
// checklist and drive both which VisaRule variant applies (VisaRule.ts's
// `applicability`) and which document-requirement groups within a rule
// apply (VisaRule.ts's `VisaDocumentRequirementGroup.appliesWhen`). One
// vocabulary, reused by both predicate sites, so a condition written once
// ("employmentStatus == SELF_EMPLOYED") means the same thing everywhere it
// appears instead of each call site inventing its own comparison.
//
// Deliberately NOT a Mongoose model on its own — this is embedded into
// VisaApplication.applicantProfile (models/VisaApplication.ts) and read by
// VisaRule.ts's applicability/appliesWhen predicates. No collection of its
// own.
import { Schema } from "mongoose";

export const VISA_EMPLOYMENT_STATUSES = [
  "EMPLOYED", "SELF_EMPLOYED", "RETIRED", "STUDENT", "UNEMPLOYED",
] as const;
export type VisaEmploymentStatus = (typeof VISA_EMPLOYMENT_STATUSES)[number];

export const VISA_SPONSOR_TYPES = ["EMPLOYER", "FAMILY", "SELF", "THIRD_PARTY"] as const;
export type VisaSponsorType = (typeof VISA_SPONSOR_TYPES)[number];

// Who invited/hosts the traveller — distinct from sponsorType (who PAYS):
// an employer can pay (sponsorType) while a government body issues the
// invitation (invitationSource), e.g. a conference delegate.
export const VISA_INVITATION_SOURCES = [
  "BUSINESS_HOST", "FAMILY_OR_FRIEND", "GOVERNMENT_OR_INSTITUTION", "EVENT_ORGANIZER", "NONE",
] as const;
export type VisaInvitationSource = (typeof VISA_INVITATION_SOURCES)[number];

export const VISA_MARITAL_STATUSES = ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"] as const;
export type VisaMaritalStatus = (typeof VISA_MARITAL_STATUSES)[number];

// The full set of applicant facts a predicate (applicability / appliesWhen)
// may condition on. Kept as a single source of truth — VisaRule.ts's
// predicate types reference this same union rather than re-listing it.
export const VISA_APPLICANT_ATTRIBUTE_FIELDS = [
  "employmentStatus", "isMinor", "isSponsored", "sponsorType",
  "invitationSource", "maritalStatus", "holdsUsVisa", "holdsSchengenVisa",
] as const;
export type VisaApplicantAttributeField = (typeof VISA_APPLICANT_ATTRIBUTE_FIELDS)[number];

export interface VisaApplicantProfile {
  employmentStatus?: VisaEmploymentStatus;
  isMinor?: boolean;
  isSponsored?: boolean;
  sponsorType?: VisaSponsorType;
  invitationSource?: VisaInvitationSource;
  maritalStatus?: VisaMaritalStatus;
  holdsUsVisa?: boolean;
  holdsSchengenVisa?: boolean;
}

/**
 * One condition in a predicate: "field equals this exact value" or "field
 * is one of these values". Both are optional on the type so a condition
 * object can carry either shape, but exactly one should be set — see
 * evaluateApplicantPredicate's handling of a condition with neither.
 */
export interface VisaApplicantPredicateCondition {
  field: VisaApplicantAttributeField;
  equals?: string | boolean;
  in?: (string | boolean)[];
}

// A predicate is an implicit AND across every condition. An empty array or
// undefined/null predicate matches EVERY applicant — this is what makes a
// VisaRule with no `applicability`, or a document-requirement group with no
// `appliesWhen`, the universal fallback (VisaRule.ts §5's Canada case: the
// 20-document rule has no predicate and matches whoever the 5-document,
// holdsUsVisa:true variant doesn't).
export type VisaApplicantPredicate = VisaApplicantPredicateCondition[];

export const VisaApplicantPredicateConditionSchema = new Schema<VisaApplicantPredicateCondition>(
  {
    field: { type: String, enum: VISA_APPLICANT_ATTRIBUTE_FIELDS, required: true },
    equals: { type: Schema.Types.Mixed },
    in: { type: [Schema.Types.Mixed] },
  },
  { _id: false },
);

export const VisaApplicantProfileSchema = new Schema<VisaApplicantProfile>(
  {
    employmentStatus: { type: String, enum: VISA_EMPLOYMENT_STATUSES },
    isMinor: { type: Boolean },
    isSponsored: { type: Boolean },
    sponsorType: { type: String, enum: VISA_SPONSOR_TYPES },
    invitationSource: { type: String, enum: VISA_INVITATION_SOURCES },
    maritalStatus: { type: String, enum: VISA_MARITAL_STATUSES },
    holdsUsVisa: { type: Boolean },
    holdsSchengenVisa: { type: Boolean },
  },
  { _id: false },
);

/**
 * Evaluates a predicate against an applicant profile. A missing/empty
 * predicate always matches (the fallback case). A malformed condition
 * (neither `equals` nor `in` set) never matches — failing closed is safer
 * than a condition that silently matches everyone by accident.
 */
export function evaluateApplicantPredicate(
  predicate: VisaApplicantPredicate | null | undefined,
  profile: Partial<VisaApplicantProfile> | null | undefined,
): boolean {
  if (!predicate || predicate.length === 0) return true;
  const p = profile || {};
  return predicate.every((cond) => evaluateApplicantCondition(cond, p));
}

/**
 * Evaluates a SINGLE condition — the building block evaluateApplicantPredicate
 * ANDs together. Exported on its own so a caller that needs to know WHICH
 * condition(s) failed (not just the overall true/false) — e.g. the
 * concierge console explaining why a requirement was excluded — can re-run
 * just the failing ones without duplicating the equals/in matching logic.
 */
export function evaluateApplicantCondition(
  cond: VisaApplicantPredicateCondition,
  profile: Partial<VisaApplicantProfile> | null | undefined,
): boolean {
  const value = (profile as any)?.[cond.field];
  if (cond.in !== undefined) return cond.in.includes(value as any);
  if (cond.equals !== undefined) return value === cond.equals;
  return false;
}

/**
 * Picks the most-specific matching rule out of a set of same-corridor
 * variants (VisaRule.ts §5) — "most specific" is simply "the most
 * conditions in its applicability predicate", since every matching
 * condition narrows the set of applicants it could apply to. A rule with
 * no predicate (empty/undefined) is the least specific — the fallback —
 * and only wins when nothing more specific also matches. Returns null if
 * NO candidate (including the fallback) matches, e.g. the corridor has no
 * fallback rule at all and the applicant doesn't satisfy any variant.
 */
export function selectMostSpecificRule<T extends { applicability?: VisaApplicantPredicate | null }>(
  candidates: T[],
  profile: Partial<VisaApplicantProfile> | null | undefined,
): T | null {
  const matching = candidates.filter((r) => evaluateApplicantPredicate(r.applicability, profile));
  if (matching.length === 0) return null;
  matching.sort((a, b) => (b.applicability?.length ?? 0) - (a.applicability?.length ?? 0));
  return matching[0];
}

/**
 * Parses a TravellerProfile.dob ("YYYY-MM-DD" string — see
 * models/TravellerProfile.ts) into an age in whole years as of `asOf`.
 * Returns null for a missing/unparseable dob rather than throwing — DOB is
 * optional on TravellerProfile, and a bad OCR/manual entry should degrade
 * to "can't derive isMinor", never crash application creation.
 */
export function computeAgeFromDob(dob: string | null | undefined, asOf: Date = new Date()): number | null {
  if (!dob) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const birth = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(birth.getTime())) return null;

  let age = asOf.getUTCFullYear() - birth.getUTCFullYear();
  const hasHadBirthdayThisYear =
    asOf.getUTCMonth() > birth.getUTCMonth() ||
    (asOf.getUTCMonth() === birth.getUTCMonth() && asOf.getUTCDate() >= birth.getUTCDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

/**
 * Corporate self-booking defaults (task brief, Phase 10a §2): "when the
 * traveller is a workspace member, default employmentStatus to EMPLOYED and
 * sponsorType to EMPLOYER. Derive isMinor from date of birth. Ask only what
 * can't be inferred." `isWorkspaceMember` means TravellerProfile.linkedMemberId
 * is set (models/TravellerProfile.ts) — a verified employee account, as
 * opposed to e.g. a family-member traveller profile with no linked account.
 * Every other attribute (isSponsored, invitationSource, maritalStatus,
 * holdsUsVisa, holdsSchengenVisa) is deliberately left undefined here —
 * none of it is safely inferable, so it stays a real question rather than a
 * fabricated default.
 */
export function deriveCorporateApplicantProfileDefaults(input: {
  isWorkspaceMember: boolean;
  dob?: string | null;
  asOf?: Date;
}): Partial<VisaApplicantProfile> {
  const defaults: Partial<VisaApplicantProfile> = {};
  if (input.isWorkspaceMember) {
    defaults.employmentStatus = "EMPLOYED";
    defaults.sponsorType = "EMPLOYER";
  }
  const age = computeAgeFromDob(input.dob, input.asOf ?? new Date());
  if (age != null) defaults.isMinor = age < 18;
  return defaults;
}
