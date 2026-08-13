// apps/backend/src/migrations/2026-08-03-recover-unmatched-questions.ts
//
// scripts/import-visa-checklist-rules.ts used to build questions[] from
// ONLY the matched entries of an extracted checklist's questions[] — an
// unmatched question (no matchedQuestionCode) was dropped entirely, with no
// flag and no preserved prompt text. Fixed in the same commit as this
// migration: buildUnmatchedInlineQuestions() now turns every unmatched
// question into a VisaRuleInlineQuestion, flagged needsCatalogueMapping,
// with the original sourcePrompt preserved verbatim — the same treatment
// migrations/2026-08-03-recover-dropped-requirement-groups.ts and
// 2026-08-03-recover-unmatched-documents.ts already gave dropped/partial
// document groups.
//
// This migration recovers the ones already dropped: for every checklist
// that DID resolve to an imported rule, it appends any unmatched question
// missing from that rule's additionalQuestions[] — matched by `code`
// (derived deterministically from the prompt via slugifyChecklistLabel, so
// re-deriving it here always agrees with what a fresh import would
// produce). Never duplicates an already-present code, never touches a rule
// that's no longer DRAFT.
//
// A checklist whose destinationIso2/purpose never resolved has no rule to
// attach a recovered question to — reported, not an error, same posture as
// the sibling group-recovery migrations.
//
// Ledger (Phase 10d) — dry-run by default, --apply to write, recorded via
// migrations/lib/migrationRunner.ts; a second --apply is refused unless
// --force.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/migrations/2026-08-03-recover-unmatched-questions.ts              # dry-run
//   pnpm exec tsx src/migrations/2026-08-03-recover-unmatched-questions.ts --apply       # write
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule, { type VisaRuleInlineQuestion } from "../models/VisaRule.js";
import { mergeSharedBaseChecklists, buildUnmatchedInlineQuestions } from "../scripts/import-visa-checklist-rules.js";
import type { ExtractedVisaChecklistFile } from "../scripts/extract-visa-checklists.js";
import { runMigration } from "./lib/migrationRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTRACTED_DIR = path.join(REPO_ROOT, "docs", "data", "visa-checklists", "extracted");

export interface UnmatchedQuestionSite {
  sourceFile: string;
  destinationIso2: string;
  purposeLabel: string;
  ruleKey: {
    nationality: string;
    destinationIso2: string;
    purpose: string;
    entryType: string;
    serviceTier: string;
    variantKey: string;
  };
  question: VisaRuleInlineQuestion;
}

export interface ByCountry {
  destinationIso2: string;
  count: number;
}

export interface DiscoverUnmatchedQuestionsResult {
  totalQuestionsScanned: number;
  totalUnmatched: number;
  byCountry: ByCountry[];
  sites: UnmatchedQuestionSite[];
}

/**
 * Pure discovery pass — no DB access. Re-derives, via the SAME
 * mergeSharedBaseChecklists + buildUnmatchedInlineQuestions the import
 * script itself uses, every question that never matched the shared bank.
 */
export function discoverUnmatchedQuestions(files: ExtractedVisaChecklistFile[]): DiscoverUnmatchedQuestionsResult {
  const sites: UnmatchedQuestionSite[] = [];
  let totalQuestionsScanned = 0;
  const countByIso2 = new Map<string, number>();

  for (const rawFile of files) {
    const { file } = mergeSharedBaseChecklists(rawFile);
    if (!file.destinationIso2) continue;

    for (const checklist of file.checklists) {
      if (!checklist.purpose) continue;

      totalQuestionsScanned += checklist.questions.length;
      const unmatched = buildUnmatchedInlineQuestions(checklist.questions);
      if (unmatched.length === 0) continue;

      countByIso2.set(file.destinationIso2, (countByIso2.get(file.destinationIso2) || 0) + unmatched.length);
      for (const question of unmatched) {
        sites.push({
          sourceFile: file.sourceFile,
          destinationIso2: file.destinationIso2,
          purposeLabel: checklist.purposeLabel,
          ruleKey: {
            nationality: file.nationality,
            destinationIso2: file.destinationIso2,
            purpose: checklist.purpose,
            entryType: checklist.entryType,
            serviceTier: checklist.serviceTier,
            variantKey: checklist.variantKey,
          },
          question,
        });
      }
    }
  }

  const byCountry: ByCountry[] = [...countByIso2.entries()]
    .map(([destinationIso2, count]) => ({ destinationIso2, count }))
    .sort((a, b) => b.count - a.count || a.destinationIso2.localeCompare(b.destinationIso2));

  return { totalQuestionsScanned, totalUnmatched: sites.length, byCountry, sites };
}

export interface RecoverUnmatchedQuestionsSummary {
  totalQuestionsScanned: number;
  totalUnmatched: number;
  byCountry: ByCountry[];
  recovered: number;
  alreadyPresent: number; // code already on the rule's additionalQuestions — never duplicated
  ruleNotFound: { sourceFile: string; purposeLabel: string; code: string }[];
  ruleNotDraft: { sourceFile: string; purposeLabel: string; code: string; status: string }[];
}

export async function recoverUnmatchedQuestions(
  files: ExtractedVisaChecklistFile[],
  dryRun: boolean,
): Promise<RecoverUnmatchedQuestionsSummary> {
  const { totalQuestionsScanned, totalUnmatched, byCountry, sites } = discoverUnmatchedQuestions(files);

  const summary: RecoverUnmatchedQuestionsSummary = {
    totalQuestionsScanned,
    totalUnmatched,
    byCountry,
    recovered: 0,
    alreadyPresent: 0,
    ruleNotFound: [],
    ruleNotDraft: [],
  };

  for (const site of sites) {
    const rule = await VisaRule.findOne(site.ruleKey);
    if (!rule) {
      summary.ruleNotFound.push({ sourceFile: site.sourceFile, purposeLabel: site.purposeLabel, code: site.question.code });
      continue;
    }
    if (rule.status !== "DRAFT") {
      summary.ruleNotDraft.push({ sourceFile: site.sourceFile, purposeLabel: site.purposeLabel, code: site.question.code, status: rule.status });
      continue;
    }

    const alreadyThere = (rule.additionalQuestions || []).some((q: any) => q.code === site.question.code);
    if (alreadyThere) {
      summary.alreadyPresent += 1;
      continue;
    }

    summary.recovered += 1;
    if (!dryRun) {
      rule.additionalQuestions.push(site.question);
      await rule.save();
    }
  }

  return summary;
}

/* ─────────────────────────────────────────────────────────────────────
 * Entry point.
 * ───────────────────────────────────────────────────────────────────── */
function loadExtractedFiles(): ExtractedVisaChecklistFile[] {
  return readdirSync(EXTRACTED_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(EXTRACTED_DIR, f), "utf8")));
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  console.log("=== Recover unmatched questions ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log("");

  const files = loadExtractedFiles();
  console.log(`Loaded ${files.length} extracted file(s) from ${EXTRACTED_DIR}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    await runMigration({
      migrationName: "2026-08-03-recover-unmatched-questions",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await recoverUnmatchedQuestions(files, dryRun);

        console.log(`Questions scanned (checklists that resolved to an imported rule): ${summary.totalQuestionsScanned}`);
        console.log(`Unmatched (no shared-bank code): ${summary.totalUnmatched}`);
        console.log("\nBy destination (most-affected first):");
        for (const d of summary.byCountry) {
          console.log(`  ${d.destinationIso2}: ${d.count}`);
        }

        console.log(
          `\nRecovery: ${summary.recovered} ${dryRun ? "would be " : ""}appended, ${summary.alreadyPresent} already present (untouched), ` +
            `${summary.ruleNotFound.length} rule not found, ${summary.ruleNotDraft.length} rule no longer DRAFT`,
        );
        if (summary.ruleNotFound.length) {
          console.log("\nNo imported rule to attach to (checklist itself never imported):");
          for (const r of summary.ruleNotFound) console.log(`  ${r.sourceFile} — "${r.purposeLabel}" / ${r.code}`);
        }
        if (summary.ruleNotDraft.length) {
          console.log("\nRule exists but is no longer DRAFT — left untouched:");
          for (const r of summary.ruleNotDraft) console.log(`  ${r.sourceFile} — "${r.purposeLabel}" / ${r.code}: currently ${r.status}`);
        }

        if (dryRun) {
          console.log("\nRe-run with --apply to write these changes.");
        }

        return {
          outcome: "SUCCESS",
          summary:
            `totalQuestionsScanned=${summary.totalQuestionsScanned} totalUnmatched=${summary.totalUnmatched} recovered=${summary.recovered} ` +
            `alreadyPresent=${summary.alreadyPresent} ruleNotFound=${summary.ruleNotFound.length} ruleNotDraft=${summary.ruleNotDraft.length}`,
        };
      },
    });
  } finally {
    await mongoose.connection.close();
  }
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Recover unmatched questions failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
