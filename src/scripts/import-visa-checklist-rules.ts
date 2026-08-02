// apps/backend/src/scripts/import-visa-checklist-rules.ts
//
// Phase 10c (checklist-PDF extraction), step 2 of 2 — imports the
// human-reviewed JSON at docs/data/visa-checklists/extracted/ (written by
// scripts/extract-visa-checklists.ts, and edited by ops before this runs)
// as DRAFT VisaRule rows in the Phase 10a schema. Dry-run by default,
// --apply to write, idempotent (upsert on the natural key, including
// variantKey), stamped seedSource so scripts/purge-visa-seed.ts's sibling
// could find and remove exactly these rows the same way it already does
// for scripts/seed-visa-rules.ts's.
//
// Never sets status to PUBLISHED — every row this writes is DRAFT (the
// schema's own default) and this script never touches `status` again on
// an update either. Fees are NEVER set here — none of these PDFs carry fee
// information (task brief: "Fees are not in these PDFs and must come from
// the fee master") — embassyFeeInr/vfsFeeInr/plumtripsServiceFeeInr/
// indicativeVisaCostInr are left entirely unset, same as every other field
// this script has no source data for. assertNeverPublishesLiteral() below
// backs this with a structural check, not just this comment.
//
// visaCategory is ALSO left unset here (always, today — no checklist PDF
// ever states it) — VisaRule.ts's schema made this field optional
// specifically so this DRAFT can still be created; ops sets it later via
// the fee/rule UI (PATCH /rules/:id), and POST /rules/:id/publish
// independently refuses to publish a rule still missing it. A
// visaCategory that IS present in the JSON but not one of VISA_CATEGORIES
// (a typo'd edit) still SKIPS the row, since that's a real data error, not
// an absence.
//
// A checklist entry the extracted JSON couldn't fully resolve (no
// destinationIso2, no purpose) is SKIPPED and reported, never guessed. A
// rule that already exists but is no longer DRAFT (ops promoted it, or
// retired it) is also skipped on re-run — this script only ever creates a
// brand-new DRAFT or updates one still sitting in DRAFT, never silently
// overwrites something ops has since finalised.
//
// Two more things this pass guards against, both report-and-skip rather
// than guess: (1) a "shared base" checklist — a purpose-null entry whose
// label reads as a general/common/shared document list, sitting alongside
// other checklists in the same file (South Africa's "General
// Requirements" is the only one in this batch) — has its requirement
// groups merged into each sibling checklist (deduplicated against
// documents the sibling already lists) and is then dropped as a
// standalone entry, never imported as its own rule; see
// mergeSharedBaseChecklists(). (2) two checklists that resolve to the
// IDENTICAL natural key (nationality/destinationIso2/purpose/entryType/
// serviceTier/variantKey) — always within one file in practice, since
// destinationIso2 alone rules out any cross-file collision — are BOTH
// skipped and reported rather than letting the second one silently
// overwrite the first mid-run; see the intra-batch collision check in
// importVisaChecklistRules().
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/scripts/import-visa-checklist-rules.ts                          # dry-run, every extracted file
//   pnpm exec tsx src/scripts/import-visa-checklist-rules.ts --file=Laos-document-checklist.json
//   pnpm exec tsx src/scripts/import-visa-checklist-rules.ts --apply                  # write
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import VisaRule, {
  VISA_CATEGORIES,
  type VisaCategory,
  type VisaDocumentRequirementGroup,
  type VisaRuleQuestionRef,
  type VisaRuleInlineQuestion,
} from "../models/VisaRule.js";
import VisaRuleAudit, { type VisaRuleFieldChange } from "../models/VisaRuleAudit.js";
import User from "../models/User.js";
import { getCountryByIso2 } from "../utils/countryCodes.js";
import { slugifyChecklistLabel } from "../utils/visaChecklistCatalogueMatcher.js";
import type { ExtractedVisaChecklistFile } from "./extract-visa-checklists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTRACTED_DIR = path.join(REPO_ROOT, "docs", "data", "visa-checklists", "extracted");

export const SEED_SOURCE = "visa-checklist-extraction@2026-08";

/* ─────────────────────────────────────────────────────────────────────
 * Shared-base checklist merge (task brief §1). A "shared base" checklist
 * — South Africa's "General Requirements" is the only one in this batch,
 * see the report this script prints for the other 27 files checked and
 * cleared — isn't its own visa category; it's a document baseline the
 * source PDF repeats across every purpose-specific checklist. Rather than
 * import it as an eighth/ninth rule of its own, this merges its
 * requirement groups into every SIBLING checklist in the same file —
 * skipping a group entirely once every document it matches is already
 * listed somewhere on that sibling ("Deduplicate where a category already
 * lists the same document") — then drops the shared-base entry so it's
 * never imported standalone.
 *
 * Detection is generic (label pattern + purpose:null + siblings present
 * in the same file), not hardcoded to South Africa, so a future
 * extraction with the same shape is handled identically without a code
 * change. A SINGLETON checklist that happens to match the label (Laos's
 * "General") is deliberately left alone: with no siblings there's nothing
 * to merge it into, and dropping it would just delete Laos's only
 * checklist — checklists.length < 2 short-circuits before the label
 * check ever runs.
 * ───────────────────────────────────────────────────────────────────── */
const SHARED_BASE_LABEL_PATTERN = /general|shared|common|all\s*visa\s*categor/i;

type ExtractedChecklist = ExtractedVisaChecklistFile["checklists"][number];
type ExtractedRequirementGroup = ExtractedChecklist["requirementGroups"][number];

export interface SharedBaseMergeTargetSummary {
  purposeLabel: string;
  groupsMergedIn: number;
  groupsDeduped: number;
}

export interface SharedBaseMergeReport {
  sourceFile: string;
  sharedBaseLabels: string[];
  targets: SharedBaseMergeTargetSummary[];
}

function matchedCodesOf(group: ExtractedRequirementGroup): string[] {
  return group.documents.map((d) => d.matchedCode).filter((c): c is string => c !== null);
}

function matchedQuestionCodeSetOf(checklist: ExtractedChecklist): Set<string> {
  return new Set(checklist.questions.map((q) => q.matchedQuestionCode).filter((c): c is string => c !== null));
}

export function mergeSharedBaseChecklists(
  file: ExtractedVisaChecklistFile,
): { file: ExtractedVisaChecklistFile; report: SharedBaseMergeReport | null } {
  if (file.checklists.length < 2) return { file, report: null };

  const sharedBases = file.checklists.filter(
    (c) => c.purpose === null && SHARED_BASE_LABEL_PATTERN.test(c.purposeLabel),
  );
  if (sharedBases.length === 0) return { file, report: null };

  const sharedBaseSet = new Set(sharedBases);
  const targets = file.checklists.filter((c) => !sharedBaseSet.has(c));

  const targetSummaries: SharedBaseMergeTargetSummary[] = [];
  const mergedTargets = targets.map((target) => {
    // Dedup universe starts as the target's OWN matched documents, then
    // grows as shared-base groups are folded in — so a second shared-base
    // group covering the same document as one just merged from the first
    // is deduped too, not just against the target's original list.
    const existingCodes = new Set<string>(target.requirementGroups.flatMap(matchedCodesOf));
    const existingQuestionCodes = matchedQuestionCodeSetOf(target);

    let groupsMergedIn = 0;
    let groupsDeduped = 0;
    const mergedInGroups: ExtractedRequirementGroup[] = [];
    for (const base of sharedBases) {
      for (const group of base.requirementGroups) {
        const codes = matchedCodesOf(group);
        // A group with unmatched documents (codes.length === 0, or a mix)
        // always merges in — there's nothing yet to call it a duplicate
        // OF, and dropping it here would hide those unmatched documents
        // from ops entirely once the standalone shared-base entry is gone.
        if (codes.length > 0 && codes.every((c) => existingCodes.has(c))) {
          groupsDeduped += 1;
          continue;
        }
        mergedInGroups.push(group);
        groupsMergedIn += 1;
        for (const c of codes) existingCodes.add(c);
      }
    }

    const mergedQuestions = [...target.questions];
    for (const base of sharedBases) {
      for (const q of base.questions) {
        if (q.matchedQuestionCode && existingQuestionCodes.has(q.matchedQuestionCode)) continue;
        mergedQuestions.push(q);
        if (q.matchedQuestionCode) existingQuestionCodes.add(q.matchedQuestionCode);
      }
    }

    targetSummaries.push({ purposeLabel: target.purposeLabel, groupsMergedIn, groupsDeduped });

    // Merged-in baseline groups first (foundational: application form,
    // passport, fee, photos), then the target's own purpose-specific
    // groups after — mirrors how a real checklist reads.
    return { ...target, requirementGroups: [...mergedInGroups, ...target.requirementGroups], questions: mergedQuestions };
  });

  return {
    file: { ...file, checklists: mergedTargets },
    report: {
      sourceFile: file.sourceFile,
      sharedBaseLabels: sharedBases.map((c) => c.purposeLabel),
      targets: targetSummaries,
    },
  };
}

export interface RuleCandidate {
  nationality: string;
  destinationIso2: string;
  destinationName: string;
  purpose: string;
  entryType: string;
  serviceTier: string;
  variantKey: string;
  variantLabel?: string;
  applicability?: any;
  productClass: string;
  // Absent when the PDF never states it (always, today) — never guessed.
  visaCategory?: VisaCategory;
  documentGroups: VisaDocumentRequirementGroup[];
  questions: VisaRuleQuestionRef[];
  additionalQuestions: VisaRuleInlineQuestion[];
  seedSource: string;
  // Ops-authored free text carried onto VisaRule.opsNotes — see
  // ExtractedChecklistEntry.opsNotes's own comment.
  opsNotes?: string;
}

export interface SkippedChecklist {
  sourceFile: string;
  purposeLabel: string;
  variantLabel: string | null;
  reason: string;
}

/**
 * Turns ONE extracted requirement-group entry into the VisaRule shape,
 * whether or not any (or all) of its documents matched a catalogue code.
 * Shared by buildRuleCandidate (first import) and migrations/
 * 2026-08-03-recover-dropped-requirement-groups.ts /
 * 2026-08-03-recover-unmatched-documents.ts (re-deriving the exact same
 * group shape for a group whose flag needed recovering after the fact) —
 * one implementation, so none of these can ever drift on what a
 * "recovered" group looks like versus a freshly-imported one.
 *
 * 2026-08-03 — three silent-drop bugs, same root cause, fixed together:
 *   1. A group with NOTHING matched used to be skipped entirely
 *      ("vacuously satisfied" looked worse than missing) — six were only
 *      discovered by accident, via the template-relink migration's own
 *      group-not-found report. Fixed: imported anyway, flagged.
 *   2. A group with SOME documents matched and some not (docTypeCodes
 *      non-empty) imported "successfully" but silently threw away the
 *      unmatched ones' names — a group listing four documents that only
 *      matched three looked complete when it wasn't, with nothing for ops
 *      to see. Fixed the same way: needsCatalogueMapping is set and
 *      unmatchedDocumentNames carries every unmatched name whenever
 *      there's at least one, whether the group is wholly or partially
 *      unmapped — `docTypeCodes.length` distinguishes the two cases for
 *      anything that needs to (the console, the export).
 *   3. (audit finding F5) A group's raw templateReference text had no
 *      schema field to land in at all when it never resolved to a real
 *      VisaTemplate.code — utils/visaChecklistCatalogueMatcher.ts's
 *      KNOWN_VISA_TEMPLATES is empty today, so g.matchedTemplateCode is
 *      always null at extraction time; every templateReference-bearing
 *      group built HERE is flagged unmatchedTemplateReference. That's
 *      correct for a brand-new candidate — there's no DB state yet to
 *      compare against. It is NOT correct to treat as "still unmatched"
 *      for an EXISTING rule whose group already has templateCode set via
 *      migrations/2026-08-02-recover-template-references.ts's own
 *      curated relink (a separate, DB-side resolution step this function
 *      has no visibility into) — see migrations/2026-08-03-recover-
 *      unmatched-template-references.ts's own header for how the recovery
 *      migration reconciles the two instead of trusting this blindly.
 */
export function buildDocumentGroupFromExtracted(
  g: ExtractedRequirementGroup,
): { group: VisaDocumentRequirementGroup; droppedDocumentCount: number } {
  const docTypeCodes = g.documents.map((d) => d.matchedCode).filter((c): c is string => c !== null);
  const unmatchedDocumentNames = g.documents.filter((d) => d.matchedCode === null).map((d) => d.sourceName);
  const droppedDocumentCount = unmatchedDocumentNames.length;

  const group: VisaDocumentRequirementGroup = {
    key: g.key,
    label: g.label,
    requirement: g.requirement,
    docTypeCodes,
  };
  if (g.appliesWhen) group.appliesWhen = g.appliesWhen;
  if (g.specification) group.specification = g.specification;
  if (g.matchedTemplateCode) group.templateCode = g.matchedTemplateCode;
  // Preserve the unstructured condition text ONLY when there's no
  // structured appliesWhen — mirrors migrations/
  // 2026-08-02-visa-checklist-model-v2.ts's own posture for the same field.
  if (g.conditionText && !g.appliesWhen) group.legacyConditionNote = g.conditionText;

  if (unmatchedDocumentNames.length > 0) {
    group.needsCatalogueMapping = true;
    group.unmatchedDocumentNames = unmatchedDocumentNames;
  }
  if (g.templateReference && !group.templateCode) {
    group.needsCatalogueMapping = true;
    group.unmatchedTemplateReference = g.templateReference;
  }

  return { group, droppedDocumentCount };
}

/**
 * Turns the UNMATCHED entries of an extracted checklist's questions[] into
 * rule-specific VisaRuleInlineQuestion rows — flagged needsCatalogueMapping,
 * original prompt text preserved verbatim. A matched question is handled
 * separately (buildRuleCandidate turns it into a VisaRuleQuestionRef instead
 * — a reference into the shared bank, not a copy).
 *
 * 2026-08-03 — an unmatched question used to be dropped entirely here, with
 * no flag and no preserved prompt (task brief §5's "shared-bank gap for ops
 * to fill" was true in spirit but false in practice: nothing ever recorded
 * that the gap existed once the source PDF was gone). Same fix shape as
 * buildDocumentGroupFromExtracted's needsCatalogueMapping.
 */
export function buildUnmatchedInlineQuestions(questions: ExtractedChecklist["questions"]): VisaRuleInlineQuestion[] {
  return questions
    .filter((q) => !q.matchedQuestionCode)
    .map((q) => ({
      code: slugifyChecklistLabel(q.sourcePrompt),
      prompt: q.sourcePrompt,
      needsCatalogueMapping: true,
    }));
}

/**
 * Builds the DRAFT-rule candidate for one extracted checklist entry, or a
 * skip reason when a required field the PDF never states (destinationIso2,
 * purpose) is still unresolved, or when visaCategory is present but not a
 * real VisaCategory value. visaCategory itself being simply absent is NOT
 * a skip reason — the candidate is built with it left unset. Pure — no DB
 * access — so this is unit-testable without a connection.
 */
export function buildRuleCandidate(
  file: ExtractedVisaChecklistFile,
  checklist: ExtractedVisaChecklistFile["checklists"][number],
): { ok: true; candidate: RuleCandidate; droppedDocumentCount: number } | { ok: false; reason: string } {
  if (!file.destinationIso2) {
    return { ok: false, reason: `destinationIso2 unresolved for destinationName "${file.destinationName}"` };
  }
  if (!checklist.purpose) {
    return { ok: false, reason: `purpose unresolved for purposeLabel "${checklist.purposeLabel}"` };
  }
  // Absent (null/undefined) is expected — no checklist PDF states this,
  // and this pass never guesses it; the row imports as DRAFT with
  // visaCategory unset, for ops to fill in later. A PRESENT-but-invalid
  // value (a typo'd hand-edit) is a real data error and still skips.
  if (checklist.visaCategory != null && !VISA_CATEGORIES.includes(checklist.visaCategory as VisaCategory)) {
    return {
      ok: false,
      reason: `visaCategory is set to an invalid value "${checklist.visaCategory}" — must be one of ${VISA_CATEGORIES.join(", ")} or left null`,
    };
  }

  let droppedDocumentCount = 0;
  const documentGroups: VisaDocumentRequirementGroup[] = [];
  for (const g of checklist.requirementGroups) {
    const { group, droppedDocumentCount: d } = buildDocumentGroupFromExtracted(g);
    droppedDocumentCount += d;
    documentGroups.push(group);
  }

  // Only MATCHED questions become real questionCode refs into the shared
  // bank; an unmatched one is kept too, but as a flagged inline question
  // (buildUnmatchedInlineQuestions) rather than a questionCode ref — it
  // isn't a confirmed shared-bank question, so it must never be smuggled in
  // as if it were one.
  const questions: VisaRuleQuestionRef[] = checklist.questions
    .filter((q) => q.matchedQuestionCode)
    .map((q) => ({ questionCode: q.matchedQuestionCode as string }));
  const additionalQuestions: VisaRuleInlineQuestion[] = buildUnmatchedInlineQuestions(checklist.questions);

  // Resolved from countryCodes.ts's own canonical name for this ISO2 —
  // NEVER the PDF/Gemini's own destinationName text. Two PDFs for the
  // same country can (and did — "United States" vs "United States of
  // America") word their own title differently; destinationName is a
  // denormalised display copy of what destinationIso2 already identifies,
  // so it must always agree with the one canonical source, not whatever
  // this particular source document happened to say. destinationIso2
  // already resolved successfully above (via normaliseToIso2, same
  // lookup), so getCountryByIso2 is guaranteed to find it — the fallback
  // to file.destinationName is unreachable in practice, kept only so a
  // lookup that somehow fails still produces SOME name rather than none.
  const destinationName = getCountryByIso2(file.destinationIso2)?.name ?? file.destinationName;

  const candidate: RuleCandidate = {
    nationality: file.nationality,
    destinationIso2: file.destinationIso2,
    destinationName,
    purpose: checklist.purpose,
    entryType: checklist.entryType,
    serviceTier: checklist.serviceTier,
    variantKey: checklist.variantKey,
    productClass: checklist.productClass,
    documentGroups,
    questions,
    additionalQuestions,
    seedSource: SEED_SOURCE,
  };
  if (checklist.visaCategory != null) candidate.visaCategory = checklist.visaCategory as VisaCategory;
  if (checklist.variantLabel) candidate.variantLabel = checklist.variantLabel;
  if (checklist.applicability) candidate.applicability = checklist.applicability;
  if (checklist.opsNotes) candidate.opsNotes = checklist.opsNotes;

  return { ok: true, candidate, droppedDocumentCount };
}

export interface DuplicateKeyCollision {
  // JSON-stringified candidateKey() — stable and human-readable enough for
  // a console report; not meant to be parsed back.
  key: string;
  entries: { sourceFile: string; purposeLabel: string }[];
}

export interface ImportSummary {
  checklistsScanned: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  skipped: SkippedChecklist[];
  // Rows that exist but are no longer DRAFT — never touched by this script.
  skippedNotDraft: { destinationIso2: string; purpose: string; variantKey: string; status: string }[];
  // Two (or more) checklists that resolved to the IDENTICAL natural key
  // within this same run — ALL of them are skipped, never just the second
  // one silently overwriting the first. See importVisaChecklistRules.
  duplicateKeyCollisions: DuplicateKeyCollision[];
  // One entry per file where a shared-base checklist (task brief §1) was
  // found and merged into its siblings, then dropped as a standalone rule.
  merges: SharedBaseMergeReport[];
  // Per-destination breakdown of every candidate actually resolved against
  // the database (i.e. excluding skipped/duplicate-collision entries) —
  // the "rules per country" the dry-run report asks for.
  perCountry: Record<string, { toCreate: number; toUpdate: number; unchanged: number; skippedNotDraft: number }>;
}

// 2026-08-03 (audit finding F9) — every route-driven VisaRule edit writes a
// VisaRuleAudit entry (routes/admin.visa.rules.ts, routes/admin.visa.rules.
// importExport.ts); this script wrote none at all — a bulk import of dozens
// of rules left no trail whatsoever on a collection that controls pricing.
// VisaRuleAudit.performedByUserId is a required ref User, and there is no
// authenticated req.user for a CLI script to attribute an entry to — so,
// same precedent as scripts/seed-intake-system-identities.ts's own "System
// Intake" identity (created for the identical reason: a machine-driven
// pipeline still needs a real User row to satisfy a required ref
// elsewhere), this resolves — or creates, once — a dedicated "System
// Import" user and attributes every import-driven audit entry to it. Not a
// login-capable account in practice: the password is random and never
// disclosed anywhere.
const SYSTEM_IMPORT_EMAIL = "system-import@plumtrips.com";
// The same internal Plumtrips CustomerWorkspace scripts/seed-intake-system-
// identities.ts's own System Intake user already attaches to — User.
// workspaceId is a required ref, and there's nothing checklist-import-
// specific about which internal workspace a machine identity belongs to,
// so this reuses that one rather than inventing a second.
const SYSTEM_IMPORT_WORKSPACE_ID = "69679a7628330a58d29f2254";

export async function resolveSystemImportActorId(): Promise<mongoose.Types.ObjectId> {
  const existing = await User.findOne({ email: SYSTEM_IMPORT_EMAIL }).select("_id").lean();
  if (existing) return (existing as any)._id;

  const randomPassword = crypto.randomBytes(32).toString("hex"); // never disclosed; login not a supported path for this identity
  const passwordHash = await bcrypt.hash(randomPassword, 12);
  const created = await User.create({
    email: SYSTEM_IMPORT_EMAIL,
    officialEmail: SYSTEM_IMPORT_EMAIL,
    workspaceId: SYSTEM_IMPORT_WORKSPACE_ID,
    name: "System Import (visa checklist pipeline)",
    passwordHash,
    roles: ["SYSTEM_IMPORT"],
    status: "ACTIVE",
  });
  return created._id as mongoose.Types.ObjectId;
}

// 2026-08-03 (audit finding F8) — the field-by-field comparison used to be
// a hand-maintained boolean expression that had already drifted from what
// candidateFields() actually writes: variantLabel, applicability, and
// opsNotes were computed and would be $set on an update, but were never
// compared, so an edit to any of them (Turkey's variants, South Africa's
// OFFICIAL_DIPLOMATIC opsNotes) was silently classified "unchanged" and
// never written. Deriving the comparison set from Object.keys(after) — the
// SAME object that gets passed to $set — makes that drift structurally
// impossible: whatever candidateFields() decides to write IS what gets
// compared, always, with nothing to keep in sync by hand.
export function diffCandidateFields(before: Record<string, any>, after: Record<string, any>): VisaRuleFieldChange[] {
  const changes: VisaRuleFieldChange[] = [];
  for (const field of Object.keys(after)) {
    const fromVal = before[field] ?? null;
    const toVal = after[field] ?? null;
    if (!isDeepStrictEqual(fromVal, toVal)) {
      changes.push({ field, from: fromVal, to: toVal });
    }
  }
  return changes;
}

function candidateKey(c: RuleCandidate) {
  return {
    nationality: c.nationality,
    destinationIso2: c.destinationIso2,
    purpose: c.purpose,
    entryType: c.entryType,
    serviceTier: c.serviceTier,
    variantKey: c.variantKey,
  };
}

// Fields this import owns on an update — status/effectiveFrom/fees/
// lastReviewedAt/reviewedBy are deliberately excluded (never touched here).
function candidateFields(c: RuleCandidate): Record<string, any> {
  const fields: Record<string, any> = {
    destinationName: c.destinationName,
    productClass: c.productClass,
    variantLabel: c.variantLabel,
    applicability: c.applicability,
    documentGroups: c.documentGroups,
    questions: c.questions,
    additionalQuestions: c.additionalQuestions,
    seedSource: c.seedSource,
  };
  // Only ever SETS visaCategory, never clears it — if ops has since set it
  // through the fee/rule UI but this extraction still doesn't know it (the
  // PDF never states it), a re-run must not blow that value away again.
  if (c.visaCategory !== undefined) fields.visaCategory = c.visaCategory;
  // Same only-ever-sets posture for opsNotes.
  if (c.opsNotes !== undefined) fields.opsNotes = c.opsNotes;
  return fields;
}

export async function importVisaChecklistRules(
  files: ExtractedVisaChecklistFile[],
  dryRun: boolean,
  // Required whenever dryRun is false — a dry run never writes, so it never
  // needs an actor to attribute a VisaRuleAudit entry to. See
  // resolveSystemImportActorId() for where main() gets this from.
  performedByUserId?: mongoose.Types.ObjectId | string,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    checklistsScanned: 0,
    toCreate: 0,
    toUpdate: 0,
    unchanged: 0,
    skipped: [],
    skippedNotDraft: [],
    duplicateKeyCollisions: [],
    merges: [],
    perCountry: {},
  };

  function countryTally(destinationIso2: string) {
    if (!summary.perCountry[destinationIso2]) {
      summary.perCountry[destinationIso2] = { toCreate: 0, toUpdate: 0, unchanged: 0, skippedNotDraft: 0 };
    }
    return summary.perCountry[destinationIso2];
  }

  // Pass 1 — merge shared-base checklists per file (task brief §1), then
  // build every candidate this batch CAN build (or record why not).
  interface BuiltCandidate {
    sourceFile: string;
    purposeLabel: string;
    candidate: RuleCandidate;
  }
  const builtCandidates: BuiltCandidate[] = [];

  for (const rawFile of files) {
    const { file, report } = mergeSharedBaseChecklists(rawFile);
    if (report) summary.merges.push(report);

    for (const checklist of file.checklists) {
      summary.checklistsScanned += 1;

      const result = buildRuleCandidate(file, checklist);
      if (result.ok === false) {
        summary.skipped.push({
          sourceFile: file.sourceFile,
          purposeLabel: checklist.purposeLabel,
          variantLabel: checklist.variantLabel,
          reason: result.reason,
        });
        continue;
      }

      builtCandidates.push({ sourceFile: file.sourceFile, purposeLabel: checklist.purposeLabel, candidate: result.candidate });
    }
  }

  // Pass 2 — two checklists resolving to the IDENTICAL natural key within
  // THIS run (e.g. South Africa's "OFFICIAL VISITOR" and "HOLIDAY
  // VISITOR/TOURIST VISITOR" both land on TOURIST/UNSPECIFIED/STANDARD/
  // DEFAULT) would otherwise have the second upsert silently overwrite the
  // first mid-run. Skip and report ALL of them instead — never guess which
  // one "wins".
  const byKey = new Map<string, BuiltCandidate[]>();
  for (const b of builtCandidates) {
    const keyStr = JSON.stringify(candidateKey(b.candidate));
    const list = byKey.get(keyStr) || [];
    list.push(b);
    byKey.set(keyStr, list);
  }

  const toProcess: RuleCandidate[] = [];
  for (const list of byKey.values()) {
    if (list.length === 1) {
      toProcess.push(list[0].candidate);
      continue;
    }
    summary.duplicateKeyCollisions.push({
      key: JSON.stringify(candidateKey(list[0].candidate)),
      entries: list.map((b) => ({ sourceFile: b.sourceFile, purposeLabel: b.purposeLabel })),
    });
  }

  // Pass 3 — resolve each surviving candidate against the database.
  for (const candidate of toProcess) {
    const existing = await VisaRule.findOne(candidateKey(candidate)).lean();
    const fields = candidateFields(candidate);

    if (!existing) {
      summary.toCreate += 1;
      countryTally(candidate.destinationIso2).toCreate += 1;
      if (!dryRun) {
        const after = { ...candidateKey(candidate), ...fields, status: "DRAFT" };
        const created = await VisaRule.create(after);
        const changes = diffCandidateFields({}, after);
        await VisaRuleAudit.create({ ruleId: created._id, action: "IMPORT", changes, performedByUserId, performedAt: new Date() });
      }
      continue;
    }

    if ((existing as any).status !== "DRAFT") {
      summary.skippedNotDraft.push({
        destinationIso2: candidate.destinationIso2,
        purpose: candidate.purpose,
        variantKey: candidate.variantKey,
        status: (existing as any).status,
      });
      countryTally(candidate.destinationIso2).skippedNotDraft += 1;
      continue;
    }

    // Derived from the SAME `fields` object that gets $set below — see
    // diffCandidateFields's own header for why this replaced a hand-listed
    // boolean expression that had already drifted (F8).
    const before: Record<string, any> = {};
    for (const key of Object.keys(fields)) before[key] = (existing as any)[key];
    const changes = diffCandidateFields(before, fields);

    if (changes.length === 0) {
      summary.unchanged += 1;
      countryTally(candidate.destinationIso2).unchanged += 1;
      continue;
    }

    summary.toUpdate += 1;
    countryTally(candidate.destinationIso2).toUpdate += 1;
    if (!dryRun) {
      await VisaRule.updateOne({ _id: (existing as any)._id }, { $set: fields });
      await VisaRuleAudit.create({ ruleId: (existing as any)._id, action: "IMPORT", changes, performedByUserId, performedAt: new Date() });
    }
  }

  return summary;
}

/* ─────────────────────────────────────────────────────────────────────
 * Structural guard, mirroring seed-visa-rules.ts's assertNoDeleteCalls —
 * reads this file's own source and refuses to run if it finds an actual
 * object-property or assignment writing the PUBLISHED status literal onto
 * `status`. Shape-restricted (via FORBIDDEN_STATUS_LITERAL below), not a
 * blind substring check, the same way assertNoDeleteCalls's own pattern
 * requires a leading "." and trailing "(" — deliberately never spelled
 * out in this comment block itself, so this guard can't trip over its own
 * prose. Every row this script writes is DRAFT (the schema default) and
 * it never touches `status` again on update either — this is a hard,
 * structural backstop for that, not just the header comment's say-so.
 * ───────────────────────────────────────────────────────────────────── */
const FORBIDDEN_STATUS_LITERAL = /(?:status\s*:|\.status\s*=)\s*["']PUBLISHED["']/;

function assertNeverPublishesLiteral(): void {
  const selfPath = fileURLToPath(import.meta.url);
  const source = readFileSync(selfPath, "utf8");
  const match = source.match(FORBIDDEN_STATUS_LITERAL);
  if (match) {
    console.error(
      `Refusing to run: this import script must never write a PUBLISHED status, but its own source ` +
        `contains a status-literal assignment ("${match[0]}"). Remove it — every row this script writes must stay DRAFT.`,
    );
    process.exit(1);
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Entry point.
 * ───────────────────────────────────────────────────────────────────── */
// Destinations that already carry a PUBLISHED seed rule (scripts/
// seed-visa-rules.ts) — informational only. A new candidate landing on
// one of these destinations is NOT a natural-key collision (entryType
// nearly always differs — the seed's real-world entryType vs. this
// extraction's UNSPECIFIED default) so it imports as its own separate
// DRAFT rule same as any other; this is just a flag for ops to compare
// the two and decide when to retire the placeholder-fee seed row.
const EXISTING_SEEDED_PUBLISHED_ISO2 = new Set(["DE", "AE", "US", "KH", "NP"]);

function loadExtractedFiles(fileFilter: string | null): ExtractedVisaChecklistFile[] {
  const names = readdirSync(EXTRACTED_DIR).filter((f) => f.endsWith(".json"));
  const selected = fileFilter ? names.filter((f) => f === fileFilter) : names;
  return selected.map((f) => JSON.parse(readFileSync(path.join(EXTRACTED_DIR, f), "utf8")));
}

async function main() {
  assertNeverPublishesLiteral();

  const dryRun = !process.argv.includes("--apply");
  const fileArg = process.argv.find((a) => a.startsWith("--file="));
  const fileFilter = fileArg ? fileArg.slice("--file=".length).trim() : null;

  console.log("=== Import visa checklist rules (Phase 10c) ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);

  const files = loadExtractedFiles(fileFilter);
  if (files.length === 0) {
    console.error(`No extracted JSON files found in ${EXTRACTED_DIR}${fileFilter ? ` matching ${fileFilter}` : ""}`);
    process.exit(1);
  }
  console.log(`Loaded ${files.length} extracted file(s) from ${EXTRACTED_DIR}`);

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);

  try {
    // Never resolved/created on a dry run — nothing gets written, so there's
    // no audit entry to attribute and no reason to touch the User collection.
    const performedByUserId = dryRun ? undefined : await resolveSystemImportActorId();
    const summary = await importVisaChecklistRules(files, dryRun, performedByUserId);
    console.log("");
    console.log(
      `checklistsScanned=${summary.checklistsScanned} toCreate=${summary.toCreate} toUpdate=${summary.toUpdate} ` +
        `unchanged=${summary.unchanged} skipped=${summary.skipped.length} skippedNotDraft=${summary.skippedNotDraft.length} ` +
        `duplicateKeyCollisions=${summary.duplicateKeyCollisions.length}`,
    );

    if (summary.merges.length) {
      console.log("\nShared-base checklist merges (task brief §1):");
      for (const m of summary.merges) {
        console.log(`  ${m.sourceFile} — dropped standalone: ${m.sharedBaseLabels.join(", ")}`);
        for (const t of m.targets) {
          console.log(`    -> "${t.purposeLabel}": +${t.groupsMergedIn} group(s) merged in, ${t.groupsDeduped} deduped (already listed)`);
        }
      }
    }

    const countries = Object.keys(summary.perCountry).sort();
    if (countries.length) {
      console.log("\nRules per country (destinationIso2 — toCreate/toUpdate/unchanged/skippedNotDraft):");
      for (const iso2 of countries) {
        const c = summary.perCountry[iso2];
        const advisory = EXISTING_SEEDED_PUBLISHED_ISO2.has(iso2)
          ? "  [existing PUBLISHED seed rule for this destination — compare before retiring]"
          : "";
        console.log(`  ${iso2}: ${c.toCreate}/${c.toUpdate}/${c.unchanged}/${c.skippedNotDraft}${advisory}`);
      }
    }

    if (summary.duplicateKeyCollisions.length) {
      console.log("\nDuplicate-key collisions WITHIN this batch (ALL entries skipped, none imported):");
      for (const dup of summary.duplicateKeyCollisions) {
        console.log(`  key=${dup.key}`);
        for (const e of dup.entries) {
          console.log(`    - ${e.sourceFile} — "${e.purposeLabel}"`);
        }
      }
    }

    if (summary.skipped.length) {
      console.log("\nSkipped (unresolved required field):");
      for (const s of summary.skipped) {
        console.log(`  ${s.sourceFile} — ${s.purposeLabel}${s.variantLabel ? ` [${s.variantLabel}]` : ""}: ${s.reason}`);
      }
    }
    if (summary.skippedNotDraft.length) {
      console.log("\nSkipped (already promoted/retired — not overwritten):");
      for (const s of summary.skippedNotDraft) {
        console.log(`  ${s.destinationIso2}/${s.purpose}/${s.variantKey}: currently ${s.status}`);
      }
    }
    if (dryRun) {
      console.log("\nRe-run with --apply to write these changes.");
    }
  } finally {
    await mongoose.connection.close();
  }
}

// See extract-visa-checklists.ts's identical guard for why this checks the
// real process entry point rather than NODE_ENV/VITEST — this file already
// exports RuleCandidate/buildRuleCandidate/importVisaChecklistRules for
// reuse, and this connects to the live database in main(), so an
// accidental import-triggered run here would be worse than the read-only
// migration import that prompted this fix.
const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Import failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
