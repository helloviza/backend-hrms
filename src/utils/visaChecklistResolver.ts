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
  type VisaApplicantAttributeField,
  type VisaApplicantPredicate,
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
export function resolveVisaChecklistItems(
  source: VisaChecklistSource,
  applicantProfile?: Partial<VisaApplicantProfile> | null,
): ResolvedChecklistItem[] {
  const groups = source.documentGroups;
  const bypassFiltering = applicantProfile === undefined || applicantProfile === null;

  if (Array.isArray(groups) && groups.length > 0) {
    return groups
      .filter((g) => bypassFiltering || evaluateApplicantPredicate(g.appliesWhen, applicantProfile))
      .map((g) => {
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
      });
  }

  return (source.documentRequirements || []).map((r) => {
    const item: ResolvedChecklistItem = {
      key: r.docCode,
      label: getVisaDocumentCodeDef(r.docCode)?.name ?? r.docCode,
      requirement: r.requirement,
      docTypeCodes: [r.docCode],
    };
    if (r.condition) item.condition = r.condition;
    return item;
  });
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
