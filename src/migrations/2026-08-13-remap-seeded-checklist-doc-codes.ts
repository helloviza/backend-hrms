// apps/backend/src/migrations/2026-08-13-remap-seeded-checklist-doc-codes.ts
//
// Re-runs the document-type matcher over the StampMyVisa-seeded rules and
// fills in docTypeCodes for groups flagged needsCatalogueMapping.
//
// ── WHY A MIGRATION IS NEEDED AT ALL ──────────────────────────────────
// The match is STORED, not resolved live. VisaRule.documentGroups[] holds
// docTypeCodes/needsCatalogueMapping as written at import time; the admin
// console's "N need mapping" counter (VisaRulesConsole.tsx's
// needsMappingCount) reads those stored flags; and utils/
// visaChecklistCatalogueMatcher.ts is imported ONLY by scripts,
// migrations and the import route — never by a request path. So adding a
// catalogue entry does nothing for an already-seeded rule until something
// re-writes that rule. This is that something.
//
// ── WHAT ACTUALLY BLOCKED THE MATCH ───────────────────────────────────
// The seed stored a COMPOSITE "<label>: <description>" string in
// unmatchedDocumentNames ("Business Registration: Business Registration",
// "Cover Letter: Upload cover letter"). matchDocumentType is exact
// name/alias only — deliberately, so it never guesses — and no catalogue
// name looks like that composite, so every one of them missed. Splitting
// on the first colon and matching the LABEL half is what unlocks them;
// the catalogue additions in the same commit cover the documents that
// genuinely had no type.
//
// Matching stays exact-or-nothing: matchDocumentType only, never
// suggestDocumentTypes' fuzzy scores. A group whose name still doesn't
// resolve keeps its flag and its verbatim name, exactly as it is now —
// this migration only ever RESOLVES; it never drops a name, never clears
// a flag it couldn't justify, and never invents a code.
//
// Idempotent: a group with no needsCatalogueMapping flag is skipped
// outright, and a re-run after a successful pass finds nothing left to do.
//
// Dry-run by default, --apply to write, ledgered via lib/migrationRunner.
//
// Usage (from apps/backend):
//   pnpm exec tsx src/migrations/2026-08-13-remap-seeded-checklist-doc-codes.ts
//   pnpm exec tsx src/migrations/2026-08-13-remap-seeded-checklist-doc-codes.ts --apply
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";
import { matchDocumentType } from "../utils/visaChecklistCatalogueMatcher.js";
import { runMigration } from "./lib/migrationRunner.js";

const MIGRATION_NAME = "2026-08-13-remap-seeded-checklist-doc-codes";
const SEED_SOURCE = "stampmyvisa-json@2026-08";

/**
 * Every candidate string worth putting to the matcher for one stored
 * name, most-specific first. The stored value is a "<label>: <detail>"
 * composite; both halves are real candidates, and so is the whole string
 * (some names carry no colon at all).
 */
function candidatesFor(name: string): string[] {
  const whole = name.trim();
  const out = [whole];
  const colon = whole.indexOf(":");
  if (colon > 0) {
    out.push(whole.slice(0, colon).trim()); // the label half
    out.push(whole.slice(colon + 1).trim()); // the detail half
  }
  return out.filter(Boolean);
}

function resolveName(name: string): string | null {
  for (const candidate of candidatesFor(name)) {
    const hit = matchDocumentType(candidate);
    if (hit) return hit.code;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────
 * STEP 2 PROJECTION — read-only, never written by this migration.
 *
 * "Student:", "Retired:", "Employed:", "Self-employed:" prefixes are
 * applicant CONDITIONS, not documents. The model already has the right
 * home for them (VisaDocumentRequirementGroup.appliesWhen, an
 * employmentStatus predicate), but converting them is a separate,
 * reviewable decision — this migration only COUNTS them so the report can
 * state the size of that opportunity.
 * ───────────────────────────────────────────────────────────────────── */
const CONDITION_PREFIXES: Record<string, string> = {
  student: "STUDENT",
  retired: "RETIRED",
  employed: "EMPLOYED",
  "self-employed": "SELF_EMPLOYED",
  "self employed": "SELF_EMPLOYED",
  unemployed: "UNEMPLOYED",
};

function conditionPrefixOf(name: string): string | null {
  const colon = name.indexOf(":");
  if (colon <= 0) return null;
  return CONDITION_PREFIXES[name.slice(0, colon).trim().toLowerCase()] ?? null;
}

interface Summary {
  rulesScanned: number;
  flaggedGroups: number;
  groupsFullyResolved: number;
  groupsPartiallyResolved: number;
  groupsUnresolved: number;
  codesAdded: number;
  rulesChanged: number;
  byCode: Map<string, number>;
  stillUnmatched: Map<string, number>;
  conditionPrefixed: Map<string, number>;
}

async function main(apply: boolean) {
  await mongoose.connect(env.MONGO_URI);

  const rules = await VisaRule.find({ seedSource: SEED_SOURCE });
  const s: Summary = {
    rulesScanned: rules.length,
    flaggedGroups: 0,
    groupsFullyResolved: 0,
    groupsPartiallyResolved: 0,
    groupsUnresolved: 0,
    codesAdded: 0,
    rulesChanged: 0,
    byCode: new Map(),
    stillUnmatched: new Map(),
    conditionPrefixed: new Map(),
  };

  for (const rule of rules as any[]) {
    let ruleTouched = false;

    for (const group of rule.documentGroups || []) {
      if (!group.needsCatalogueMapping) continue;
      s.flaggedGroups += 1;

      const names: string[] = (group.unmatchedDocumentNames || []).length
        ? group.unmatchedDocumentNames
        : [group.label].filter(Boolean);

      for (const n of names) {
        const cond = conditionPrefixOf(n);
        if (cond) s.conditionPrefixed.set(cond, (s.conditionPrefixed.get(cond) ?? 0) + 1);
      }

      const codes = new Set<string>(group.docTypeCodes || []);
      const unresolved: string[] = [];
      let addedHere = 0;

      for (const name of names) {
        const code = resolveName(String(name));
        if (!code) {
          unresolved.push(String(name));
          s.stillUnmatched.set(String(name), (s.stillUnmatched.get(String(name)) ?? 0) + 1);
          continue;
        }
        if (!codes.has(code)) {
          codes.add(code);
          addedHere += 1;
          s.byCode.set(code, (s.byCode.get(code) ?? 0) + 1);
        }
      }

      if (addedHere === 0 && unresolved.length === names.length) {
        s.groupsUnresolved += 1;
        continue;
      }

      s.codesAdded += addedHere;
      if (unresolved.length === 0) s.groupsFullyResolved += 1;
      else s.groupsPartiallyResolved += 1;

      if (apply) {
        group.docTypeCodes = [...codes];
        // The flag and the verbatim names come off ONLY when every name on
        // the group resolved. A partially-resolved group keeps both, with
        // the names narrowed to what is still genuinely unmapped — ops must
        // still see the leftover, not have it quietly disappear because a
        // sibling name matched.
        if (unresolved.length === 0) {
          group.needsCatalogueMapping = false;
          group.unmatchedDocumentNames = undefined;
        } else {
          group.unmatchedDocumentNames = unresolved;
        }
        ruleTouched = true;
      }
    }

    if (apply && ruleTouched) {
      rule.markModified("documentGroups");
      await rule.save();
      s.rulesChanged += 1;
    }
  }

  report(s, apply);

  // NOT closing the connection here — runMigration writes its own ledger
  // entry (MigrationRun) after this returns, and closing first makes that
  // write fail with MongoNotConnectedError. The close happens at the very
  // bottom of this file instead.
  return {
    outcome: "SUCCESS" as const,
    summary:
      `${s.rulesScanned} rules scanned, ${s.flaggedGroups} flagged groups, ` +
      `${s.groupsFullyResolved} fully resolved, ${s.groupsPartiallyResolved} partial, ` +
      `${s.groupsUnresolved} still unresolved, ${s.codesAdded} codes added`,
  };
}

function report(s: Summary, apply: boolean) {
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  console.log("──────────────────────────────────────────────────────");
  console.log(`Rules scanned (seedSource ${SEED_SOURCE}): ${s.rulesScanned}`);
  console.log(`Groups flagged "needs mapping" BEFORE:     ${s.flaggedGroups}`);
  console.log("");
  console.log(`  fully resolved (flag would clear):       ${s.groupsFullyResolved}`);
  console.log(`  partially resolved (flag stays):        ${s.groupsPartiallyResolved}`);
  console.log(`  still unresolved (untouched):           ${s.groupsUnresolved}`);
  console.log(`  document codes added:                   ${s.codesAdded}`);
  console.log(`Groups flagged AFTER:                     ${s.flaggedGroups - s.groupsFullyResolved}`);
  console.log("──────────────────────────────────────────────────────");

  console.log("Codes applied (top 25):");
  for (const [code, count] of top(s.byCode, 25)) console.log(`  ${String(count).padStart(4)} x  ${code}`);

  console.log("");
  console.log("Applicant-CONDITION prefixes seen (STEP 2 — reported only, never written here):");
  for (const [cond, count] of top(s.conditionPrefixed, 10)) console.log(`  ${String(count).padStart(4)} x  ${cond}`);

  console.log("");
  console.log(`Still unmatched, distinct names: ${s.stillUnmatched.size} (top 30 by frequency):`);
  for (const [name, count] of top(s.stillUnmatched, 30)) {
    console.log(`  ${String(count).padStart(4)} x  ${JSON.stringify(name.slice(0, 90))}`);
  }
  console.log("──────────────────────────────────────────────────────");
  console.log(apply ? "APPLIED." : "DRY RUN — nothing was written. Re-run with --apply to write.");
}

const apply = process.argv.includes("--apply");
await runMigration({
  migrationName: MIGRATION_NAME,
  mode: apply ? "APPLY" : "DRY_RUN",
  force: process.argv.includes("--force"),
  run: () => main(apply),
});
await mongoose.connection.close();
