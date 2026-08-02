// apps/backend/src/migrations/2026-08-03-recover-unmatched-documents.ts
//
// scripts/import-visa-checklist-rules.ts's buildDocumentGroupFromExtracted
// used to compute droppedDocumentCount (how many of a group's documents
// failed to match a catalogue code) and then never surface it anywhere — a
// group that listed four documents and matched three imported looking
// complete, with the fourth document's name gone with no trace. Fixed in
// the same commit as this migration: a group with SOME (not necessarily
// ALL) unmatched documents now gets needsCatalogueMapping set and
// unmatchedDocumentNames populated with every unmatched name, the same
// treatment migrations/2026-08-03-recover-dropped-requirement-groups.ts
// already gave a WHOLLY-unmatched group (docTypeCodes empty). That sibling
// migration's own discovery only counts a group as "dropped" when it's
// entirely absent from the rule — a partially-matched group was never
// dropped (it's already sitting on the rule, real docTypeCodes and all),
// so it's untouched by that migration's "already present" skip. This one
// is the counterpart: it backfills the flag/names onto a group that
// ALREADY EXISTS on its rule, without touching docTypeCodes, label, or
// anything else about it.
//
// Scope is deliberately PARTIAL matches only (docTypeCodes.length > 0 AND
// at least one unmatched document) — a wholly-unmatched group is
// 2026-08-03-recover-dropped-requirement-groups.ts's job, not this one's,
// so the two migrations' reports don't double-count the same group.
//
// Idempotent, only-ever-sets: skips (reports alreadySet) a group whose
// unmatchedDocumentNames is already non-empty — never overwrites a value a
// prior run of this migration, or an ops edit via the REQUIREMENTS-sheet
// import, already put there.
//
// Ledger (Phase 10d) — dry-run by default, --apply to write, recorded via
// migrations/lib/migrationRunner.ts; a second --apply is refused unless
// --force.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/migrations/2026-08-03-recover-unmatched-documents.ts              # dry-run
//   pnpm exec tsx src/migrations/2026-08-03-recover-unmatched-documents.ts --apply       # write
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";
import { mergeSharedBaseChecklists, buildDocumentGroupFromExtracted } from "../scripts/import-visa-checklist-rules.js";
import type { ExtractedVisaChecklistFile } from "../scripts/extract-visa-checklists.js";
import { runMigration } from "./lib/migrationRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTRACTED_DIR = path.join(REPO_ROOT, "docs", "data", "visa-checklists", "extracted");

export interface PartialMatchSite {
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
  groupKey: string;
  unmatchedDocumentNames: string[];
}

export interface ByCountry {
  destinationIso2: string;
  count: number;
}

export interface DiscoverPartialMatchesResult {
  totalGroupsScanned: number; // groups in checklists that resolved to an imported rule
  totalPartial: number; // groups with SOME but not all documents matched
  byCountry: ByCountry[];
  sites: PartialMatchSite[];
}

/**
 * Pure discovery pass — no DB access. Re-derives, via the SAME
 * mergeSharedBaseChecklists + buildDocumentGroupFromExtracted the import
 * script itself uses, every group that has real docTypeCodes AND at least
 * one unmatched document.
 */
export function discoverPartialMatches(files: ExtractedVisaChecklistFile[]): DiscoverPartialMatchesResult {
  const sites: PartialMatchSite[] = [];
  let totalGroupsScanned = 0;
  const countByIso2 = new Map<string, number>();

  for (const rawFile of files) {
    const { file } = mergeSharedBaseChecklists(rawFile);
    if (!file.destinationIso2) continue;

    for (const checklist of file.checklists) {
      if (!checklist.purpose) continue;

      for (const g of checklist.requirementGroups) {
        totalGroupsScanned += 1;
        const { group } = buildDocumentGroupFromExtracted(g);
        const isPartial = group.docTypeCodes.length > 0 && (group.unmatchedDocumentNames?.length ?? 0) > 0;
        if (!isPartial) continue;

        countByIso2.set(file.destinationIso2, (countByIso2.get(file.destinationIso2) || 0) + 1);
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
          groupKey: group.key,
          unmatchedDocumentNames: group.unmatchedDocumentNames as string[],
        });
      }
    }
  }

  const byCountry: ByCountry[] = [...countByIso2.entries()]
    .map(([destinationIso2, count]) => ({ destinationIso2, count }))
    .sort((a, b) => b.count - a.count || a.destinationIso2.localeCompare(b.destinationIso2));

  return { totalGroupsScanned, totalPartial: sites.length, byCountry, sites };
}

export interface RecoverPartialMatchesSummary {
  totalGroupsScanned: number;
  totalPartial: number;
  byCountry: ByCountry[];
  recovered: number;
  alreadySet: number; // group's unmatchedDocumentNames already non-empty — never overwritten
  ruleNotFound: { sourceFile: string; purposeLabel: string; groupKey: string }[];
  ruleNotDraft: { sourceFile: string; purposeLabel: string; groupKey: string; status: string }[];
  groupNotFound: { sourceFile: string; purposeLabel: string; groupKey: string }[];
}

export async function recoverPartialMatches(
  files: ExtractedVisaChecklistFile[],
  dryRun: boolean,
): Promise<RecoverPartialMatchesSummary> {
  const { totalGroupsScanned, totalPartial, byCountry, sites } = discoverPartialMatches(files);

  const summary: RecoverPartialMatchesSummary = {
    totalGroupsScanned,
    totalPartial,
    byCountry,
    recovered: 0,
    alreadySet: 0,
    ruleNotFound: [],
    ruleNotDraft: [],
    groupNotFound: [],
  };

  for (const site of sites) {
    const rule = await VisaRule.findOne(site.ruleKey);
    if (!rule) {
      summary.ruleNotFound.push({ sourceFile: site.sourceFile, purposeLabel: site.purposeLabel, groupKey: site.groupKey });
      continue;
    }
    if (rule.status !== "DRAFT") {
      summary.ruleNotDraft.push({ sourceFile: site.sourceFile, purposeLabel: site.purposeLabel, groupKey: site.groupKey, status: rule.status });
      continue;
    }

    const group = (rule.documentGroups || []).find((g: any) => g.key === site.groupKey);
    if (!group) {
      summary.groupNotFound.push({ sourceFile: site.sourceFile, purposeLabel: site.purposeLabel, groupKey: site.groupKey });
      continue;
    }

    if ((group.unmatchedDocumentNames?.length ?? 0) > 0) {
      summary.alreadySet += 1;
      continue;
    }

    summary.recovered += 1;
    if (!dryRun) {
      group.needsCatalogueMapping = true;
      group.unmatchedDocumentNames = site.unmatchedDocumentNames;
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
  console.log("=== Recover unmatched documents inside otherwise-matched groups ===");
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
      migrationName: "2026-08-03-recover-unmatched-documents",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await recoverPartialMatches(files, dryRun);

        console.log(`Groups scanned (checklists that resolved to an imported rule): ${summary.totalGroupsScanned}`);
        console.log(`Partially matched (some documents unmatched, group otherwise imported fine): ${summary.totalPartial}`);
        console.log("\nBy destination (most-affected first):");
        for (const d of summary.byCountry) {
          console.log(`  ${d.destinationIso2}: ${d.count}`);
        }

        console.log(
          `\nRecovery: ${summary.recovered} ${dryRun ? "would be " : ""}backfilled, ${summary.alreadySet} already set (untouched), ` +
            `${summary.ruleNotFound.length} rule not found, ${summary.ruleNotDraft.length} rule no longer DRAFT, ${summary.groupNotFound.length} group not found`,
        );
        if (summary.ruleNotFound.length) {
          console.log("\nNo imported rule to backfill (checklist itself never imported):");
          for (const r of summary.ruleNotFound) console.log(`  ${r.sourceFile} — "${r.purposeLabel}" / ${r.groupKey}`);
        }
        if (summary.ruleNotDraft.length) {
          console.log("\nRule exists but is no longer DRAFT — left untouched:");
          for (const r of summary.ruleNotDraft) console.log(`  ${r.sourceFile} — "${r.purposeLabel}" / ${r.groupKey}: currently ${r.status}`);
        }
        if (summary.groupNotFound.length) {
          console.log("\nRule exists but this group key isn't on it (likely edited since import):");
          for (const r of summary.groupNotFound) console.log(`  ${r.sourceFile} — "${r.purposeLabel}" / ${r.groupKey}`);
        }

        if (dryRun) {
          console.log("\nRe-run with --apply to write these changes.");
        }

        return {
          outcome: "SUCCESS",
          summary:
            `totalGroupsScanned=${summary.totalGroupsScanned} totalPartial=${summary.totalPartial} recovered=${summary.recovered} ` +
            `alreadySet=${summary.alreadySet} ruleNotFound=${summary.ruleNotFound.length} ruleNotDraft=${summary.ruleNotDraft.length} groupNotFound=${summary.groupNotFound.length}`,
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
    console.error("Recover unmatched documents failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
