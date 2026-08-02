// apps/backend/src/migrations/2026-08-03-recover-unmatched-template-references.ts
//
// Audit finding F5 — a requirement group's raw templateReference text
// (e.g. "Cover Letter Template") had no schema field to land in at all when
// it never resolved to a real VisaTemplate.code: not the group's problem
// (docTypeCodes could be perfectly fine), just a separate gap nobody could
// see once the extraction JSON was archived. Same class as the
// unmatched-document/question gaps already fixed this pass — scripts/
// import-visa-checklist-rules.ts's buildDocumentGroupFromExtracted now
// flags a FRESH candidate's group with needsCatalogueMapping +
// unmatchedTemplateReference whenever it has a templateReference but no
// templateCode.
//
// Recovering the ALREADY-imported groups this affects is more than a
// re-derive-from-JSON exercise, though, because template resolution
// doesn't happen at extraction time the way document/question matching
// does — utils/visaChecklistCatalogueMatcher.ts's KNOWN_VISA_TEMPLATES is
// empty, so g.matchedTemplateCode is ALWAYS null in the frozen extraction
// JSON. Template resolution instead happened later, as its own DB-side
// step: migrations/2026-08-02-recover-template-references.ts curated 12
// descriptions and relinked templateCode onto 90 of the 96 groups that had
// a templateReference at all. So "does this group still need a
// templateReference flag" can only be answered by checking the LIVE
// stored group's templateCode — not by re-running
// buildDocumentGroupFromExtracted blind, which would (correctly, for a
// BRAND NEW candidate) flag all 96, including the 90 that are already
// correctly resolved. This migration checks live state per group and only
// backfills the 6 (or however many) that are genuinely still unresolved —
// see resolvedElsewhere in the summary for the count this correctly
// leaves alone.
//
// Idempotent, only-ever-sets: skips (reports alreadySet) a group whose
// unmatchedTemplateReference is already non-empty; skips (reports
// resolvedElsewhere) a group whose templateCode is already set by any
// means — never overwrites either.
//
// Ledger (Phase 10d) — dry-run by default, --apply to write, recorded via
// migrations/lib/migrationRunner.ts; a second --apply is refused unless
// --force.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/migrations/2026-08-03-recover-unmatched-template-references.ts              # dry-run
//   pnpm exec tsx src/migrations/2026-08-03-recover-unmatched-template-references.ts --apply       # write
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";
import { mergeSharedBaseChecklists } from "../scripts/import-visa-checklist-rules.js";
import type { ExtractedVisaChecklistFile } from "../scripts/extract-visa-checklists.js";
import { runMigration } from "./lib/migrationRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTRACTED_DIR = path.join(REPO_ROOT, "docs", "data", "visa-checklists", "extracted");

export interface TemplateReferenceSite {
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
  templateReference: string;
}

export interface ByCountry {
  destinationIso2: string;
  count: number;
}

export interface DiscoverTemplateReferenceSitesResult {
  totalGroupsScanned: number;
  totalWithReference: number;
  byCountry: ByCountry[];
  sites: TemplateReferenceSite[];
}

/**
 * Pure discovery pass — no DB access. Finds every requirement group across
 * checklists that resolved to an imported rule which carries a raw
 * templateReference at all, whether or not it has since been resolved on
 * the live rule (that reconciliation happens in recoverUnmatchedTemplate
 * References, which DOES touch the DB).
 */
export function discoverTemplateReferenceSites(files: ExtractedVisaChecklistFile[]): DiscoverTemplateReferenceSitesResult {
  const sites: TemplateReferenceSite[] = [];
  let totalGroupsScanned = 0;
  const countByIso2 = new Map<string, number>();

  for (const rawFile of files) {
    const { file } = mergeSharedBaseChecklists(rawFile);
    if (!file.destinationIso2) continue;

    for (const checklist of file.checklists) {
      if (!checklist.purpose) continue;

      for (const g of checklist.requirementGroups) {
        totalGroupsScanned += 1;
        if (!g.templateReference) continue;

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
          groupKey: g.key,
          templateReference: g.templateReference,
        });
      }
    }
  }

  const byCountry: ByCountry[] = [...countByIso2.entries()]
    .map(([destinationIso2, count]) => ({ destinationIso2, count }))
    .sort((a, b) => b.count - a.count || a.destinationIso2.localeCompare(b.destinationIso2));

  return { totalGroupsScanned, totalWithReference: sites.length, byCountry, sites };
}

export interface RecoverUnmatchedTemplateReferencesSummary {
  totalGroupsScanned: number;
  totalWithReference: number;
  byCountry: ByCountry[];
  recovered: number;
  alreadySet: number; // unmatchedTemplateReference already non-empty — never overwritten
  resolvedElsewhere: number; // templateCode already set (2026-08-02 relink or otherwise) — not actually unmatched
  ruleNotFound: { sourceFile: string; purposeLabel: string; groupKey: string }[];
  ruleNotDraft: { sourceFile: string; purposeLabel: string; groupKey: string; status: string }[];
  groupNotFound: { sourceFile: string; purposeLabel: string; groupKey: string }[];
}

export async function recoverUnmatchedTemplateReferences(
  files: ExtractedVisaChecklistFile[],
  dryRun: boolean,
): Promise<RecoverUnmatchedTemplateReferencesSummary> {
  const { totalGroupsScanned, totalWithReference, byCountry, sites } = discoverTemplateReferenceSites(files);

  const summary: RecoverUnmatchedTemplateReferencesSummary = {
    totalGroupsScanned,
    totalWithReference,
    byCountry,
    recovered: 0,
    alreadySet: 0,
    resolvedElsewhere: 0,
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

    if (group.templateCode) {
      summary.resolvedElsewhere += 1;
      continue;
    }
    if (group.unmatchedTemplateReference) {
      summary.alreadySet += 1;
      continue;
    }

    summary.recovered += 1;
    if (!dryRun) {
      group.needsCatalogueMapping = true;
      group.unmatchedTemplateReference = site.templateReference;
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
  console.log("=== Recover unmatched template references ===");
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
      migrationName: "2026-08-03-recover-unmatched-template-references",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await recoverUnmatchedTemplateReferences(files, dryRun);

        console.log(`Groups scanned (checklists that resolved to an imported rule): ${summary.totalGroupsScanned}`);
        console.log(`Carrying a templateReference at all: ${summary.totalWithReference}`);
        console.log("\nBy destination (most-affected first):");
        for (const d of summary.byCountry) {
          console.log(`  ${d.destinationIso2}: ${d.count}`);
        }

        console.log(
          `\nRecovery: ${summary.recovered} ${dryRun ? "would be " : ""}flagged, ${summary.resolvedElsewhere} already resolved via templateCode (untouched), ` +
            `${summary.alreadySet} already flagged (untouched), ${summary.ruleNotFound.length} rule not found, ` +
            `${summary.ruleNotDraft.length} rule no longer DRAFT, ${summary.groupNotFound.length} group not found`,
        );
        if (summary.ruleNotFound.length) {
          console.log("\nNo imported rule to attach to (checklist itself never imported):");
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
            `totalGroupsScanned=${summary.totalGroupsScanned} totalWithReference=${summary.totalWithReference} recovered=${summary.recovered} ` +
            `resolvedElsewhere=${summary.resolvedElsewhere} alreadySet=${summary.alreadySet} ruleNotFound=${summary.ruleNotFound.length} ` +
            `ruleNotDraft=${summary.ruleNotDraft.length} groupNotFound=${summary.groupNotFound.length}`,
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
    console.error("Recover unmatched template references failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
