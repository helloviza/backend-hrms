// apps/backend/src/utils/visaChecklistResolver.ts
//
// Phase 10b — THE single function that decides what checklist a rule (or a
// frozen VisaApplication.ruleSnapshot — same shape, see below) actually
// shows. Phase 10a added `documentGroups` alongside the legacy flat
// `documentRequirements` on VisaRule, but nothing ever decided which one to
// render — this is that decision, made exactly once, here.
//
// Rule: groups when present, legacy otherwise, NEVER both — a rule/snapshot
// either has `documentGroups` populated (the 10a migration did this for
// all seven existing rules) or it doesn't, and the two are mutually
// exclusive sources for a single resolve call. Output shape
// (ResolvedChecklistItem) is identical either way, so no consumer branches
// on which era the source rule came from.
//
// ruleSnapshot compatibility: VisaRuleSnapshotSchema has no `documentGroups`
// field on any application created BEFORE this phase (and every
// application's ruleSnapshot is immutable history — never rewritten, see
// models/VisaApplication.ts's file header), so an old snapshot simply has
// `documentGroups: undefined` and falls through to the legacy branch below
// exactly like a rule that was never migrated would. No special-casing
// needed — "old-shape snapshot" and "legacy-only rule" are the same case.
import {
  evaluateApplicantPredicate,
  evaluateApplicantCondition,
  type VisaApplicantAttributeField,
  type VisaApplicantPredicate,
  type VisaApplicantPredicateCondition,
  type VisaApplicantProfile,
} from "../models/visaAttributes.js";
import { getVisaDocumentCodeDef } from "../config/visaDocumentCodes.js";

export interface VisaChecklistSourceDocumentRequirement {
  docCode: string;
  requirement: "REQUIRED" | "CONDITIONAL";
  condition?: string;
}

export interface VisaChecklistSourceDocumentGroup {
  key: string;
  label: string;
  requirement: "REQUIRED" | "CONDITIONAL";
  appliesWhen?: VisaApplicantPredicate | null;
  docTypeCodes: string[];
  specification?: string;
  templateCode?: string;
  legacyConditionNote?: string;
}

// What both VisaRule (documentGroups + documentRequirements) and
// VisaRuleSnapshot (documentRequirements only, documentGroups always
// undefined pre-Phase-10b) have in common — the only shape this resolver
// needs to know about either source.
export interface VisaChecklistSource {
  documentGroups?: VisaChecklistSourceDocumentGroup[] | null;
  documentRequirements?: VisaChecklistSourceDocumentRequirement[] | null;
}

export interface ResolvedChecklistItem {
  key: string; // stable within the source: group.key, or the legacy docCode itself
  label: string; // display label — group.label, or the doc type's own name for a legacy item
  requirement: "REQUIRED" | "CONDITIONAL";
  // Present only for a group-sourced item that declared one. A legacy item
  // never has one — legacy `condition` strings are free text with no
  // established way to evaluate them structurally (unchanged from before
  // this phase; Phase 10a's migration structured the one exception it
  // could, "If self-employed or a business owner", directly into the
  // derived group's appliesWhen).
  appliesWhen?: VisaApplicantPredicate;
  condition?: string; // free-text, display-only (legacy `condition` or the group's legacyConditionNote)
  specification?: string;
  templateCode?: string;
  docTypeCodes: string[]; // 1 for a legacy-derived item, N for a real multi-document group
}

/**
 * Resolves a rule/snapshot + an applicant profile into the checklist to
 * display or check completeness against.
 *
 * `applicantProfile` has two distinct modes:
 *  - `undefined`/`null` ("no applicant known yet") — every item is
 *    returned regardless of `appliesWhen`. This is screen 2's pre-traveller
 *    preview (GET /rules, GET /rules/:id): nobody has been selected, so
 *    there is nothing legitimate to filter by, and hiding a conditional
 *    item would just make the preview look incomplete.
 *  - a real object (even `{}`) — `appliesWhen` is evaluated for real
 *    (models/visaAttributes.ts's evaluateApplicantPredicate). This is every
 *    per-application consumer (screen 4/5/6/7, completeness): a real
 *    VisaApplication.applicantProfile always exists (schema default `{}`),
 *    so a rule's ~22 requirements become the ~10 that apply to THIS
 *    traveller. Every existing (pre-Phase-10b) ruleSnapshot has no
 *    `documentGroups` at all, so this mode degrades to "show everything"
 *    for them too, by construction — there's nothing to filter without
 *    structured `appliesWhen` data to filter against.
 */
function groupToItem(g: VisaChecklistSourceDocumentGroup): ResolvedChecklistItem {
  const item: ResolvedChecklistItem = {
    key: g.key,
    label: g.label,
    requirement: g.requirement,
    docTypeCodes: [...g.docTypeCodes],
  };
  if (g.appliesWhen && g.appliesWhen.length > 0) item.appliesWhen = g.appliesWhen;
  if (g.legacyConditionNote) item.condition = g.legacyConditionNote;
  if (g.specification) item.specification = g.specification;
  if (g.templateCode) item.templateCode = g.templateCode;
  return item;
}

function legacyRequirementToItem(r: VisaChecklistSourceDocumentRequirement): ResolvedChecklistItem {
  const item: ResolvedChecklistItem = {
    key: r.docCode,
    label: getVisaDocumentCodeDef(r.docCode)?.name ?? r.docCode,
    requirement: r.requirement,
    docTypeCodes: [r.docCode],
  };
  if (r.condition) item.condition = r.condition;
  return item;
}

export function resolveVisaChecklistItems(
  source: VisaChecklistSource,
  applicantProfile?: Partial<VisaApplicantProfile> | null,
): ResolvedChecklistItem[] {
  const groups = source.documentGroups;
  const bypassFiltering = applicantProfile === undefined || applicantProfile === null;

  if (Array.isArray(groups) && groups.length > 0) {
    return groups
      .filter((g) => bypassFiltering || evaluateApplicantPredicate(g.appliesWhen, applicantProfile))
      .map(groupToItem);
  }

  return (source.documentRequirements || []).map(legacyRequirementToItem);
}

/**
 * Whether a resolved item should count toward completeness/"outstanding"
 * calculations — REQUIRED items always do; a CONDITIONAL item only does
 * once its applicability was structurally VERIFIED against a real
 * applicant profile (it has an `appliesWhen`, which — by construction, see
 * resolveVisaChecklistItems — only ever survives onto the output when it
 * matched). A CONDITIONAL item with no structured `appliesWhen` at all
 * (free text only, e.g. "if requested by immigration on arrival") is
 * shown but never counted — the same conservative posture completeness
 * always took before this phase, for exactly the cases nothing can
 * evaluate as true/false.
 */
export function itemCountsTowardCompleteness(item: ResolvedChecklistItem): boolean {
  return item.requirement === "REQUIRED" || !!item.appliesWhen;
}

/**
 * Which applicant-attribute fields the SELECTED rule actually depends on —
 * task brief §3: "ask the rest only when some requirement in the selected
 * rule actually depends on it". Scans every group's `appliesWhen`
 * conditions; legacy-only rules (no documentGroups) reference nothing
 * structurally, so this is always `[]` for them — there is nothing to ask
 * beyond the corporate defaults.
 */
export function getReferencedApplicantAttributeFields(
  source: VisaChecklistSource,
): VisaApplicantAttributeField[] {
  const groups = source.documentGroups;
  if (!Array.isArray(groups) || groups.length === 0) return [];

  const fields = new Set<VisaApplicantAttributeField>();
  for (const g of groups) {
    for (const cond of g.appliesWhen || []) fields.add(cond.field);
  }
  return [...fields];
}

/**
 * Phase 10c (console checklist gap) — a requirement the resolver left OUT
 * of resolveVisaChecklistItems() because its `appliesWhen` didn't match
 * this applicant, plus WHY: the specific attribute(s) that excluded it and
 * this applicant's actual value for each. An agent working the console
 * needs to know a requirement was deliberately skipped rather than
 * missing/forgotten — this is the data behind that distinction.
 */
export interface ExcludedChecklistItem {
  key: string;
  label: string;
  docTypeCodes: string[];
  excludedBy: { field: VisaApplicantAttributeField; actualValue: unknown; expected: string }[];
  // Human-readable, e.g. "traveller's employment status is EMPLOYED, not
  // SELF_EMPLOYED" — assembled from excludedBy, never hand-written per case.
  reason: string;
}

const APPLICANT_FIELD_LABELS: Record<VisaApplicantAttributeField, string> = {
  employmentStatus: "employment status",
  isMinor: "age",
  isSponsored: "sponsorship",
  sponsorType: "sponsor type",
  invitationSource: "invitation source",
  maritalStatus: "marital status",
  holdsUsVisa: "US visa status",
  holdsSchengenVisa: "Schengen visa status",
};

function describeExpected(cond: VisaApplicantPredicateCondition): string {
  // `equals` checked first, and `in` guarded on length — same ordering, and
  // for the same reason, as evaluateApplicantCondition (models/visaAttributes.ts,
  // which carries the full explanation): a condition read back through
  // Mongoose has `in: []` even when only `equals` was ever set, because
  // VisaApplicantPredicateConditionSchema's `in` is an array-type path and
  // array paths default to []. Testing `cond.in !== undefined` first (as this
  // used to) matched that empty default and rendered the exclusion reason as
  // "Expected: one of " with nothing after it — the concierge console's
  // explanation of WHY a requirement was excluded, reduced to a dangling
  // phrase, for every equals-gated rule loaded from the DB. Display-only, so
  // it never affected which documents were resolved, but an agent reading it
  // could not tell what the rule actually wanted.
  if (cond.equals !== undefined) return String(cond.equals);
  if (cond.in !== undefined && cond.in.length > 0) return `one of ${cond.in.join(", ")}`;
  // Neither set (or `in` only as an empty default with no `equals`) — the same
  // condition evaluateApplicantCondition returns false for. Say so rather than
  // emitting "undefined".
  return "(no expected value set)";
}

function describeActual(value: unknown): string {
  if (value === undefined || value === null) return "not answered";
  return String(value);
}

function buildExclusionReason(
  failingConditions: VisaApplicantPredicateCondition[],
  profile: Partial<VisaApplicantProfile> | null | undefined,
): { excludedBy: ExcludedChecklistItem["excludedBy"]; reason: string } {
  const excludedBy = failingConditions.map((cond) => ({
    field: cond.field,
    actualValue: (profile as any)?.[cond.field] ?? null,
    expected: describeExpected(cond),
  }));
  const reason = excludedBy
    .map(
      (e) =>
        `traveller's ${APPLICANT_FIELD_LABELS[e.field]} is ${describeActual(e.actualValue)}, not ${e.expected}`,
    )
    .join(" and ");
  return { excludedBy, reason };
}

/**
 * Same resolution as resolveVisaChecklistItems, but ALSO returns the groups
 * that were excluded (appliesWhen didn't match this applicant) with a
 * reason each — never computed when applicantProfile is undefined/null (the
 * "no applicant known yet" preview mode has nothing to exclude by
 * definition — see resolveVisaChecklistItems), and never anything for a
 * legacy-only source (no structured appliesWhen exists to exclude on).
 */
export function resolveVisaChecklistWithExclusions(
  source: VisaChecklistSource,
  applicantProfile: Partial<VisaApplicantProfile> | null | undefined,
): { included: ResolvedChecklistItem[]; excluded: ExcludedChecklistItem[] } {
  const groups = source.documentGroups;
  const bypassFiltering = applicantProfile === undefined || applicantProfile === null;

  if (!Array.isArray(groups) || groups.length === 0 || bypassFiltering) {
    return { included: resolveVisaChecklistItems(source, applicantProfile), excluded: [] };
  }

  const included: ResolvedChecklistItem[] = [];
  const excluded: ExcludedChecklistItem[] = [];

  for (const g of groups) {
    const failing = (g.appliesWhen || []).filter((cond) => !evaluateApplicantCondition(cond, applicantProfile));
    if (failing.length === 0) {
      included.push(groupToItem(g));
    } else {
      const { excludedBy, reason } = buildExclusionReason(failing, applicantProfile);
      excluded.push({ key: g.key, label: g.label, docTypeCodes: [...g.docTypeCodes], excludedBy, reason });
    }
  }

  return { included, excluded };
}
