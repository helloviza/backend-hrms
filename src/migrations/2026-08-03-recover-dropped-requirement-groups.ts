// apps/backend/src/migrations/2026-08-03-recover-dropped-requirement-groups.ts
//
// scripts/import-visa-checklist-rules.ts used to skip a requirement group
// entirely whenever NONE of its documents matched a real VisaDocumentType —
// "vacuously satisfied" looked worse than missing (see that script's own
// git history). That was silent data loss: a group with zero matched
// documents is still a real requirement the source checklist listed, and
// dropping it left the imported rule looking complete when it wasn't. Six
// of these were only found by accident, as a side effect of
// 2026-08-02-recover-template-references.ts's group-not-found report — this
// migration is the direct fix: scripts/import-visa-checklist-rules.ts's
// buildRuleCandidate() (see its own buildDocumentGroupFromExtracted helper,
// added in the same commit as this migration) no longer drops these groups
// on NEW imports; this migration recovers the ones already dropped onto the
// rules that already exist.
//
// Scope: a requirement group whose PARENT CHECKLIST never resolved to an
// imported rule at all (destinationIso2 or purpose unresolved — already
// reported by import-visa-checklist-rules.ts's own `skipped` summary, e.g.
// South Africa's Family/Children/Medical, Cambodia, Indonesia, Laos'
// General-only entries) is NOT this migration's concern — there is no rule
// to attach a recovered group to, and that failure mode is a different,
// already-visible one. This migration only recovers groups whose checklist
// DID import successfully but which themselves got silently dropped.
//
// Idempotent, additive only: for a group whose key doesn't already exist on
// the matching DRAFT rule's documentGroups, this APPENDS it (using the
// exact same buildDocumentGroupFromExtracted() shape a fresh import would
// produce) — it never touches a group that's already there. Deliberately
// does NOT just re-run import-visa-checklist-rules.ts --apply: that script
// replaces documentGroups wholesale on any change, which would blow away
// 2026-08-02-recover-template-references.ts's relinked templateCode values
// (matchedTemplateCode is always null in the extraction JSON — see that
// migration's own report — so a fresh candidate's documentGroups never
// carries templateCode at all). Appending surgically, by key, is the only
// way to recover these groups without regressing that migration's work —
// see this file's own report for what else a wholesale re-run would put at
// risk (§5 of the task this migration answers).
//
// A rule that's since been promoted to PUBLISHED or RETIRED is left
// completely untouched, same posture as every other script/migration in
// this pipeline — recovering a dropped group is a DRAFT-review concern, not
// something to silently retrofit onto a rule ops has already finalised.
//
// Ledger (Phase 10d) — dry-run by default, --apply to write, recorded via
// migrations/lib/migrationRunner.ts; a second --apply is refused unless
// --force.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/migrations/2026-08-03-recover-dropped-requirement-groups.ts              # dry-run
//   pnpm exec tsx src/migrations/2026-08-03-recover-dropped-requirement-groups.ts --apply       # write
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule, { type VisaDocumentRequirementGroup } from "../models/VisaRule.js";
import { mergeSharedBaseChecklists, buildDocumentGroupFromExtracted } from "../scripts/import-visa-checklist-rules.js";
import type { ExtractedVisaChecklistFile } from "../scripts/extract-visa-checklists.js";
import { runMigration } from "./lib/migrationRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTRACTED_DIR = path.join(REPO_ROOT, "docs", "data", "visa-checklists", "extracted");

export interface DroppedGroupSite {
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
  group: VisaDocumentRequirementGroup;
}

export interface DroppedByCountry {
  destinationIso2: string;
  count: number;
}

export interface DiscoverDroppedGroupsResult {
  // Every requirementGroup scanned across checklists whose destinationIso2
  // AND purpose both resolved (i.e. checklists that DID import) — the
  // denominator "compare the groups in the JSON against the groups on the
  // imported rules" is measured against.
  totalGroupsScanned: number;
  totalDropped: number;
  droppedByCountry: DroppedByCountry[]; // sorted, most-affected first
  sites: DroppedGroupSite[];
}

/**
 * Pure discovery pass over the (already-loaded) extraction files — no DB
 * access, so unit-testable without a connection. Re-derives, via the SAME
 * mergeSharedBaseChecklists + buildDocumentGroupFromExtracted the import
 * script itself uses, exactly which requirement groups came back with
 * needsCatalogueMapping (i.e. were silently dropped before this fix).
 */
export function discoverDroppedGroups(files: ExtractedVisaChecklistFile[]): DiscoverDroppedGroupsResult {
  const sites: DroppedGroupSite[] = [];
  let totalGroupsScanned = 0;
  const countByIso2 = new Map<string, number>();

  for (const rawFile of files) {
    const { file } = mergeSharedBaseChecklists(rawFile);
    if (!file.destinationIso2) continue; // whole file never imported — already reported elsewhere, not this migration's concern

    for (const checklist of file.checklists) {
      if (!checklist.purpose) continue; // whole checklist never imported — same

      for (const g of checklist.requirementGroups) {
        totalGroupsScanned += 1;
        const { group } = buildDocumentGroupFromExtracted(g);
        if (!group.needsCatalogueMapping) continue;

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
          group,
        });
      }
    }
  }

  const droppedByCountry: DroppedByCountry[] = [...countByIso2.entries()]
    .map(([destinationIso2, count]) => ({ destinationIso2, count }))
    .sort((a, b) => b.count - a.count || a.destinationIso2.localeCompare(b.destinationIso2));

  return { totalGroupsScanned, totalDropped: sites.length, droppedByCountry, sites };
}

export interface RecoverDroppedGroupsSummary {
  totalGroupsScanned: number;
  totalDropped: number;
  droppedByCountry: DroppedByCountry[];
  recovered: number;
  alreadyPresent: number; // group key already on the rule — never duplicated
  ruleNotFound: { sourceFile: string; purposeLabel: string; groupKey: string }[];
  ruleNotDraft: { sourceFile: string; purposeLabel: string; groupKey: string; status: string }[];
}

export async function recoverDroppedRequirementGroups(
  files: ExtractedVisaChecklistFile[],
  dryRun: boolean,
): Promise<RecoverDroppedGroupsSummary> {
  const { totalGroupsScanned, totalDropped, droppedByCountry, sites } = discoverDroppedGroups(files);

  const summary: RecoverDroppedGroupsSummary = {
    totalGroupsScanned,
    totalDropped,
    droppedByCountry,
    recovered: 0,
    alreadyPresent: 0,
    ruleNotFound: [],
    ruleNotDraft: [],
  };

  for (const site of sites) {
    const rule = await VisaRule.findOne(site.ruleKey);
    if (!rule) {
      summary.ruleNotFound.push({ sourceFile: site.sourceFile, purposeLabel: site.purposeLabel, groupKey: site.group.key });
      continue;
    }

    if (rule.status !== "DRAFT") {
      summary.ruleNotDraft.push({
        sourceFile: site.sourceFile,
        purposeLabel: site.purposeLabel,
        groupKey: site.group.key,
        status: rule.status,
      });
      continue;
    }

    const alreadyThere = (rule.documentGroups || []).some((g: any) => g.key === site.group.key);
    if (alreadyThere) {
      summary.alreadyPresent += 1;
      continue;
    }

    summary.recovered += 1;
    if (!dryRun) {
      rule.documentGroups.push(site.group);
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
  console.log("=== Recover dropped requirement groups ===");
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
      migrationName: "2026-08-03-recover-dropped-requirement-groups",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await recoverDroppedRequirementGroups(files, dryRun);

        console.log(`Requirement groups scanned (checklists that resolved to an imported rule): ${summary.totalGroupsScanned}`);
        console.log(`Dropped (zero matched documents): ${summary.totalDropped}`);
        console.log("\nBy destination (most-affected first):");
        for (const d of summary.droppedByCountry) {
          console.log(`  ${d.destinationIso2}: ${d.count}`);
        }

        console.log(
          `\nRecovery: ${summary.recovered} ${dryRun ? "would be " : ""}appended, ${summary.alreadyPresent} already present (untouched), ` +
            `${summary.ruleNotFound.length} rule not found, ${summary.ruleNotDraft.length} rule no longer DRAFT`,
        );
        if (summary.ruleNotFound.length) {
          console.log("\nNo imported rule to attach to (checklist itself never imported):");
          for (const r of summary.ruleNotFound) console.log(`  ${r.sourceFile} — "${r.purposeLabel}" / ${r.groupKey}`);
        }
        if (summary.ruleNotDraft.length) {
          console.log("\nRule exists but is no longer DRAFT — left untouched:");
          for (const r of summary.ruleNotDraft) console.log(`  ${r.sourceFile} — "${r.purposeLabel}" / ${r.groupKey}: currently ${r.status}`);
        }

        if (dryRun) {
          console.log("\nRe-run with --apply to write these changes.");
        }

        return {
          outcome: "SUCCESS",
          summary:
            `totalGroupsScanned=${summary.totalGroupsScanned} totalDropped=${summary.totalDropped} recovered=${summary.recovered} ` +
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
    console.error("Recover dropped requirement groups failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
