// apps/backend/src/migrations/2026-08-02-recover-template-references.ts
//
// The checklist-import pipeline (scripts/import-visa-checklist-rules.ts)
// left every one of the 606 imported requirement groups' templateCode
// unset — VisaTemplate was never seeded (its own file header: "Nothing
// uploads templates yet"), so utils/visaChecklistCatalogueMatcher.ts's
// matchTemplate() had nothing to match against at extraction time, and a
// group with an unmatched template reference imports with templateCode
// simply absent (never invented, never guessed — same posture as an
// unmatched document code). The reference text itself wasn't lost,
// though — it's still sitting in docs/data/visa-checklists/extracted/'s
// own requirementGroups[].templateReference field, verbatim.
//
// This migration re-derives what should have matched, in two passes:
//   1. Scan every extraction file for a templateReference that reads as a
//      well-formed template name — ending in the literal word "Template",
//      matching the extraction schema's own worked examples (services/
//      extractVisaChecklistGemini.ts's system prompt: "Employer NOC
//      Template", "Cover Letter Template") and VisaTemplate.ts's own file
//      header claim of "eleven distinct templates" from the original
//      task brief. A form number ("Form 1229"), a one-off "Sample" label,
//      or a garbled concatenation (Singapore's extraction visibly
//      double-references two location variants with no separator) is NOT
//      a well-formed template reference in the sense this registry
//      models — narrowing, never inventing, same posture as every other
//      matcher in this pipeline. Seed one VisaTemplate row per distinct
//      reference found this way — code, name, description, no s3Key.
//      IMPORTANT: this pass finds 12 distinct references, not the 11 the
//      task brief and VisaTemplate.ts's own header both expect — see
//      TEMPLATE_DESCRIPTIONS' own comment and this file's printed report.
//   2. For every requirement group that carried one of those 12
//      references, find its already-imported VisaRule (by natural key)
//      and its documentGroups entry (by group key), and set templateCode
//      — but only when that group doesn't already have one, so this
//      never overwrites an ops-made edit (there IS a path for that now:
//      routes/admin.visa.rules.importExport.ts's REQUIREMENTS-sheet
//      import).
//
// A group whose rule was never imported (its checklist's purpose stayed
// unresolved — South Africa's Family/Children/Medical, Cambodia,
// Indonesia, Laos) or whose specific group got dropped at import (zero
// matched document codes) has nothing to relink to — reported as
// unmatched, never treated as an error.
//
// Ledger (Phase 10d) — dry-run by default, --apply to write, recorded via
// migrations/lib/migrationRunner.ts; a second --apply is refused unless
// --force.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/migrations/2026-08-02-recover-template-references.ts              # dry-run
//   pnpm exec tsx src/migrations/2026-08-02-recover-template-references.ts --apply       # write
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";
import VisaTemplate from "../models/VisaTemplate.js";
import { slugifyChecklistLabel } from "../utils/visaChecklistCatalogueMatcher.js";
import type { ExtractedVisaChecklistFile } from "../scripts/extract-visa-checklists.js";
import { runMigration } from "./lib/migrationRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTRACTED_DIR = path.join(REPO_ROOT, "docs", "data", "visa-checklists", "extracted");

// Curated once, by hand, keyed by the EXACT verbatim templateReference
// text — VisaTemplate.description is a required schema field with
// nothing in the extraction JSON to derive it from (the PDFs name a
// template, they never describe it). A reference this migration finds
// but that ISN'T in this map is reported as missing a description and
// left unseeded, rather than seeded with an invented one.
const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  "Cover Letter Template": "Template for the applicant's own cover letter explaining the purpose of travel.",
  "Employer NOC Template": "Template for an employer's No-Objection Certificate releasing the applicant for travel.",
  "Sponsorship Letter Template": "Template for a sponsor's letter confirming they are funding the applicant's trip.",
  "Invitation Letter Template": "Template for a host's letter inviting the applicant to visit.",
  "Company Sponsorship Letter Template": "Template for a company's letter sponsoring an employee's trip.",
  "Business Invitation Letter Template": "Template for a business invitation letter for a corporate visit.",
  "Company Cover Letter Template": "Template for a company-issued cover letter supporting the application.",
  "Applicant Cover Letter Template": "Template for the applicant's own personal cover letter.",
  "Itinerary Template": "Template for the applicant's day-by-day travel itinerary.",
  "Authorization Letter Template": "Template for a letter authorising someone to act or submit documents on the applicant's behalf.",
  "School NOC Template": "Template for a school's No-Objection Certificate releasing a student for travel.",
  "NOC from Parent Consent Letter Template": "Template for a parent's consent/no-objection letter for a minor's travel.",
};

const TEMPLATE_SUFFIX_PATTERN = /\btemplate$/i;

export interface DiscoveredTemplate {
  name: string;
  count: number;
  applicableCountries: string[];
}

export interface RelinkTarget {
  ruleKey: {
    nationality: string;
    destinationIso2: string;
    purpose: string;
    entryType: string;
    serviceTier: string;
    variantKey: string;
  };
  groupKey: string;
  templateName: string;
  sourceFile: string;
  purposeLabel: string;
}

/**
 * Pure discovery pass over the (already-loaded) extraction files — no DB
 * access, so unit-testable without a connection. Returns every distinct
 * well-formed template reference (with its use count and the destinations
 * that use it) plus every individual requirement-group site that needs
 * relinking.
 */
export function discoverTemplateReferences(files: ExtractedVisaChecklistFile[]): {
  discovered: DiscoveredTemplate[];
  relinkTargets: RelinkTarget[];
} {
  const byName = new Map<string, { count: number; countries: Set<string> }>();
  const relinkTargets: RelinkTarget[] = [];

  for (const file of files) {
    if (!file.destinationIso2) continue;

    for (const checklist of file.checklists) {
      for (const group of checklist.requirementGroups) {
        const ref = group.templateReference;
        if (!ref || !TEMPLATE_SUFFIX_PATTERN.test(ref.trim())) continue;
        const name = ref.trim();

        const entry = byName.get(name) || { count: 0, countries: new Set<string>() };
        entry.count += 1;
        entry.countries.add(file.destinationIso2);
        byName.set(name, entry);

        // A checklist whose purpose never resolved was never imported at
        // all — nothing to relink to, but the reference itself still
        // counts above (it's real, it's just orphaned).
        if (!checklist.purpose) continue;

        relinkTargets.push({
          ruleKey: {
            nationality: file.nationality,
            destinationIso2: file.destinationIso2,
            purpose: checklist.purpose,
            entryType: checklist.entryType,
            serviceTier: checklist.serviceTier,
            variantKey: checklist.variantKey,
          },
          groupKey: group.key,
          templateName: name,
          sourceFile: file.sourceFile,
          purposeLabel: checklist.purposeLabel,
        });
      }
    }
  }

  const discovered: DiscoveredTemplate[] = [...byName.entries()]
    .map(([name, e]) => ({ name, count: e.count, applicableCountries: [...e.countries].sort() }))
    .sort((a, b) => b.count - a.count);

  return { discovered, relinkTargets };
}

export interface RecoverTemplatesSummary {
  discovered: DiscoveredTemplate[];
  missingDescription: string[]; // discovered but no curated description — not seeded
  templatesSeeded: number;
  templatesUpdated: number; // already existed, applicableCountries widened
  templatesUnchanged: number;
  relinkAttempted: number;
  relinkApplied: number;
  relinkAlreadySet: number; // group already had a templateCode — never overwritten
  relinkRuleNotFound: { sourceFile: string; purposeLabel: string; groupKey: string }[];
  relinkGroupNotFound: { sourceFile: string; purposeLabel: string; groupKey: string }[];
}

export async function recoverTemplateReferences(
  files: ExtractedVisaChecklistFile[],
  dryRun: boolean,
): Promise<RecoverTemplatesSummary> {
  const { discovered, relinkTargets } = discoverTemplateReferences(files);

  const summary: RecoverTemplatesSummary = {
    discovered,
    missingDescription: [],
    templatesSeeded: 0,
    templatesUpdated: 0,
    templatesUnchanged: 0,
    relinkAttempted: relinkTargets.length,
    relinkApplied: 0,
    relinkAlreadySet: 0,
    relinkRuleNotFound: [],
    relinkGroupNotFound: [],
  };

  // Pass 1 — seed (or widen) VisaTemplate.
  for (const d of discovered) {
    const description = TEMPLATE_DESCRIPTIONS[d.name];
    if (!description) {
      summary.missingDescription.push(d.name);
      continue;
    }

    const code = slugifyChecklistLabel(d.name);
    const existing = await VisaTemplate.findOne({ code }).lean();

    if (!existing) {
      summary.templatesSeeded += 1;
      if (!dryRun) {
        await VisaTemplate.create({
          code,
          name: d.name,
          description,
          s3Key: null,
          applicableCountries: d.applicableCountries,
        });
      }
      continue;
    }

    const existingCountries = new Set((existing as any).applicableCountries || []);
    const merged = new Set([...existingCountries, ...d.applicableCountries]);
    if (merged.size === existingCountries.size) {
      summary.templatesUnchanged += 1;
      continue;
    }
    summary.templatesUpdated += 1;
    if (!dryRun) {
      await VisaTemplate.updateOne({ _id: (existing as any)._id }, { $set: { applicableCountries: [...merged].sort() } });
    }
  }

  // Pass 2 — relink templateCode onto each matching rule's documentGroups.
  // Never overwrites a group that already has ANY templateCode — ops may
  // have since set one directly (routes/admin.visa.rules.importExport.ts).
  for (const target of relinkTargets) {
    if (!TEMPLATE_DESCRIPTIONS[target.templateName]) continue; // not seeded above — nothing to link to

    const rule = await VisaRule.findOne(target.ruleKey);
    if (!rule) {
      summary.relinkRuleNotFound.push({ sourceFile: target.sourceFile, purposeLabel: target.purposeLabel, groupKey: target.groupKey });
      continue;
    }

    const group = (rule.documentGroups || []).find((g: any) => g.key === target.groupKey);
    if (!group) {
      summary.relinkGroupNotFound.push({ sourceFile: target.sourceFile, purposeLabel: target.purposeLabel, groupKey: target.groupKey });
      continue;
    }

    if (group.templateCode) {
      summary.relinkAlreadySet += 1;
      continue;
    }

    summary.relinkApplied += 1;
    if (!dryRun) {
      group.templateCode = slugifyChecklistLabel(target.templateName);
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
  console.log("=== Recover template references ===");
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
      migrationName: "2026-08-02-recover-template-references",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await recoverTemplateReferences(files, dryRun);

        console.log(
          `Distinct well-formed ("...Template") references found: ${summary.discovered.length}` +
            (summary.discovered.length !== 11 ? ` (task brief/VisaTemplate.ts's header both say 11 — this run finds ${summary.discovered.length})` : ""),
        );
        for (const d of summary.discovered) {
          console.log(`  "${d.name}" — ${d.count} requirement group(s) across ${d.applicableCountries.join(", ")}`);
        }
        if (summary.missingDescription.length) {
          console.log(`\nFound but NOT seeded (no curated description yet): ${summary.missingDescription.join(", ")}`);
        }

        console.log(
          `\nVisaTemplate: ${summary.templatesSeeded} created, ${summary.templatesUpdated} updated (applicableCountries widened), ${summary.templatesUnchanged} unchanged`,
        );
        console.log(
          `Relink: ${summary.relinkAttempted} attempted, ${summary.relinkApplied} applied, ${summary.relinkAlreadySet} already set (untouched), ` +
            `${summary.relinkRuleNotFound.length} rule not found, ${summary.relinkGroupNotFound.length} group not found`,
        );
        if (summary.relinkRuleNotFound.length) {
          console.log("\nRequirement groups with no imported rule to relink to (checklist never imported):");
          for (const r of summary.relinkRuleNotFound) console.log(`  ${r.sourceFile} — "${r.purposeLabel}" / ${r.groupKey}`);
        }
        if (summary.relinkGroupNotFound.length) {
          console.log("\nRequirement groups whose rule exists but this group key isn't on it (likely dropped at import — zero matched documents):");
          for (const r of summary.relinkGroupNotFound) console.log(`  ${r.sourceFile} — "${r.purposeLabel}" / ${r.groupKey}`);
        }

        if (dryRun) {
          console.log("\nRe-run with --apply to write these changes.");
        }

        return {
          outcome: "SUCCESS",
          summary:
            `discovered=${summary.discovered.length} seeded=${summary.templatesSeeded} updated=${summary.templatesUpdated} ` +
            `relinkApplied=${summary.relinkApplied} relinkAlreadySet=${summary.relinkAlreadySet} ` +
            `relinkRuleNotFound=${summary.relinkRuleNotFound.length} relinkGroupNotFound=${summary.relinkGroupNotFound.length}`,
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
    console.error("Recover template references failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
