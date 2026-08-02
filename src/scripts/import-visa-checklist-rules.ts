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
// this script has no source data for.
//
// A checklist entry the extracted JSON couldn't fully resolve (no
// destinationIso2, no purpose, or — always, today — no visaCategory, since
// no checklist PDF states it) is SKIPPED and reported, never guessed. A
// rule that already exists but is no longer DRAFT (ops promoted it, or
// retired it) is also skipped on re-run — this script only ever creates a
// brand-new DRAFT or updates one still sitting in DRAFT, never silently
// overwrites something ops has since finalised.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/scripts/import-visa-checklist-rules.ts                          # dry-run, every extracted file
//   pnpm exec tsx src/scripts/import-visa-checklist-rules.ts --file=Laos-document-checklist.json
//   pnpm exec tsx src/scripts/import-visa-checklist-rules.ts --apply                  # write
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule, {
  VISA_CATEGORIES,
  type VisaCategory,
  type VisaDocumentRequirementGroup,
  type VisaRuleQuestionRef,
} from "../models/VisaRule.js";
import type { ExtractedVisaChecklistFile } from "./extract-visa-checklists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTRACTED_DIR = path.join(REPO_ROOT, "docs", "data", "visa-checklists", "extracted");

export const SEED_SOURCE = "visa-checklist-extraction@2026-08";

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
  visaCategory: VisaCategory;
  documentGroups: VisaDocumentRequirementGroup[];
  questions: VisaRuleQuestionRef[];
  seedSource: string;
}

export interface SkippedChecklist {
  sourceFile: string;
  purposeLabel: string;
  variantLabel: string | null;
  reason: string;
}

/**
 * Builds the DRAFT-rule candidate for one extracted checklist entry, or a
 * skip reason when a required field the PDF never states (destinationIso2,
 * purpose, visaCategory) is still unresolved. Pure — no DB access — so
 * this is unit-testable without a connection.
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
  if (!checklist.visaCategory || !VISA_CATEGORIES.includes(checklist.visaCategory as VisaCategory)) {
    return {
      ok: false,
      reason: `visaCategory not set — no checklist PDF states it; set it in the JSON (one of ${VISA_CATEGORIES.join(", ")}) before importing`,
    };
  }

  let droppedDocumentCount = 0;
  const documentGroups: VisaDocumentRequirementGroup[] = [];
  for (const g of checklist.requirementGroups) {
    const docTypeCodes = g.documents.map((d) => d.matchedCode).filter((c): c is string => c !== null);
    const dropped = g.documents.length - docTypeCodes.length;
    droppedDocumentCount += dropped;

    // A group with NOTHING matched would import as an empty-docTypeCodes
    // requirement — vacuously "satisfied" by having nothing to upload,
    // which is worse than not importing it at all (task brief §3: never
    // invent, and an empty group silently misrepresents a real
    // requirement as already complete). Skip it; the unmatched documents
    // are still fully visible in the source JSON for ops to resolve, then
    // re-run.
    if (docTypeCodes.length === 0) continue;

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
    documentGroups.push(group);
  }

  // Only MATCHED questions become real questionCode refs — an unmatched
  // question is a shared-bank gap for ops to fill (task brief §5), never
  // silently smuggled in as a rule-specific inline question.
  const questions: VisaRuleQuestionRef[] = checklist.questions
    .filter((q) => q.matchedQuestionCode)
    .map((q) => ({ questionCode: q.matchedQuestionCode as string }));

  const candidate: RuleCandidate = {
    nationality: file.nationality,
    destinationIso2: file.destinationIso2,
    destinationName: file.destinationName,
    purpose: checklist.purpose,
    entryType: checklist.entryType,
    serviceTier: checklist.serviceTier,
    variantKey: checklist.variantKey,
    productClass: checklist.productClass,
    visaCategory: checklist.visaCategory as VisaCategory,
    documentGroups,
    questions,
    seedSource: SEED_SOURCE,
  };
  if (checklist.variantLabel) candidate.variantLabel = checklist.variantLabel;
  if (checklist.applicability) candidate.applicability = checklist.applicability;

  return { ok: true, candidate, droppedDocumentCount };
}

export interface ImportSummary {
  checklistsScanned: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  skipped: SkippedChecklist[];
  // Rows that exist but are no longer DRAFT — never touched by this script.
  skippedNotDraft: { destinationIso2: string; purpose: string; variantKey: string; status: string }[];
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
function candidateFields(c: RuleCandidate) {
  return {
    destinationName: c.destinationName,
    productClass: c.productClass,
    visaCategory: c.visaCategory,
    variantLabel: c.variantLabel,
    applicability: c.applicability,
    documentGroups: c.documentGroups,
    questions: c.questions,
    seedSource: c.seedSource,
  };
}

export async function importVisaChecklistRules(
  files: ExtractedVisaChecklistFile[],
  dryRun: boolean,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    checklistsScanned: 0,
    toCreate: 0,
    toUpdate: 0,
    unchanged: 0,
    skipped: [],
    skippedNotDraft: [],
  };

  for (const file of files) {
    for (const checklist of file.checklists) {
      summary.checklistsScanned += 1;

      const built = buildRuleCandidate(file, checklist);
      if (built.ok === false) {
        summary.skipped.push({
          sourceFile: file.sourceFile,
          purposeLabel: checklist.purposeLabel,
          variantLabel: checklist.variantLabel,
          reason: built.reason,
        });
        continue;
      }

      const { candidate } = built;
      const existing = await VisaRule.findOne(candidateKey(candidate)).lean();

      if (!existing) {
        summary.toCreate += 1;
        if (!dryRun) {
          await VisaRule.create({ ...candidateKey(candidate), ...candidateFields(candidate), status: "DRAFT" });
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
        continue;
      }

      const fields = candidateFields(candidate);
      const changed =
        JSON.stringify((existing as any).documentGroups || []) !== JSON.stringify(fields.documentGroups) ||
        JSON.stringify((existing as any).questions || []) !== JSON.stringify(fields.questions) ||
        (existing as any).destinationName !== fields.destinationName ||
        (existing as any).visaCategory !== fields.visaCategory ||
        (existing as any).productClass !== fields.productClass;

      if (!changed) {
        summary.unchanged += 1;
        continue;
      }

      summary.toUpdate += 1;
      if (!dryRun) {
        await VisaRule.updateOne({ _id: (existing as any)._id }, { $set: fields });
      }
    }
  }

  return summary;
}

/* ─────────────────────────────────────────────────────────────────────
 * Entry point.
 * ───────────────────────────────────────────────────────────────────── */
function loadExtractedFiles(fileFilter: string | null): ExtractedVisaChecklistFile[] {
  const names = readdirSync(EXTRACTED_DIR).filter((f) => f.endsWith(".json"));
  const selected = fileFilter ? names.filter((f) => f === fileFilter) : names;
  return selected.map((f) => JSON.parse(readFileSync(path.join(EXTRACTED_DIR, f), "utf8")));
}

async function main() {
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
    const summary = await importVisaChecklistRules(files, dryRun);
    console.log("");
    console.log(
      `checklistsScanned=${summary.checklistsScanned} toCreate=${summary.toCreate} toUpdate=${summary.toUpdate} ` +
        `unchanged=${summary.unchanged} skipped=${summary.skipped.length} skippedNotDraft=${summary.skippedNotDraft.length}`,
    );
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
