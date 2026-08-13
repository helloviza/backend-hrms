// apps/backend/src/migrations/2026-08-02-visa-checklist-model-v2.ts
//
// Phase 10a — rolls out the redesigned visa-rule checklist model onto the
// live database:
//   1. Seeds the new VisaDocumentType catalogue (config/
//      visaDocumentTypeCatalogue.ts) — idempotent upsert by code.
//   2. Seeds a starter VisaQuestion bank (marital status, employment
//      history, prior visa refusal + its 3 follow-ups, who is funding the
//      trip, countries visited, parents' details — task brief §7's own
//      list) — idempotent upsert by code.
//   3. For every existing VisaRule row: sets `variantKey` to "DEFAULT" (if
//      not already set) and derives `documentGroups` from the legacy flat
//      `documentRequirements` array. Never touches `documentRequirements`
//      itself, VisaDocument rows, or any VisaApplication.ruleSnapshot — see
//      models/VisaRule.ts's file-header note on why the legacy docCode
//      values are never rewritten in place.
//   4. Widens VisaRule's unique index from the 5-field natural key to the
//      new 6-field one (adding `variantKey`) — creates the new index before
//      dropping the old one, so there is never a window with no uniqueness
//      guarantee at all.
//
// Idempotent: every step re-checks the LIVE state before writing (deep
// value comparison for the catalogue/rule updates; index presence for the
// index step) and reports "no change" rather than re-writing identical
// data. Dry-run by default; --apply writes.
//
// Ledger (Phase 10d) — this migration ran on production BEFORE the ledger
// existed (discovered un-run only when an unrelated import failed on the
// stale index it was supposed to have widened — see MigrationRun's own file
// header). That historical run is backfilled into MigrationRun by
// migrations/backfill-ledger-2026-08-02-audit.ts, NOT by this file. Every
// run of THIS script from now on (dry-run, apply, or a thrown failure) is
// recorded via lib/migrationRunner.ts. Once a successful --apply run is
// recorded (the backfilled one counts), running --apply again is refused
// unless --force is also passed. Check current status with migrations/
// status.ts.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-08-02-visa-checklist-model-v2.ts           # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-08-02-visa-checklist-model-v2.ts --apply    # write
//   pnpm -C apps/backend tsx src/migrations/2026-08-02-visa-checklist-model-v2.ts --apply --force  # re-apply despite a recorded success
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { isDeepStrictEqual } from "node:util";
import { env } from "../config/env.js";
import VisaRule, { type VisaDocumentRequirement, type VisaDocumentRequirementGroup } from "../models/VisaRule.js";
import VisaDocumentType from "../models/VisaDocumentType.js";
import VisaQuestion, { type VisaQuestionAnswerType, type VisaQuestionFollowUp } from "../models/VisaQuestion.js";
import {
  VISA_DOCUMENT_TYPE_CATALOGUE,
  canonicalizeVisaDocumentCode,
} from "../config/visaDocumentTypeCatalogue.js";
import { VISA_QUESTION_BANK_SEED } from "../config/visaQuestionBankSeed.js";
import { runMigration } from "./lib/migrationRunner.js";
import type { VisaApplicantPredicate } from "../models/visaAttributes.js";

const SEED_SOURCE = "visa-checklist-model-v2@2026-08";

/* ─────────────────────────────────────────────────────────────────────
 * 1. VisaDocumentType catalogue seed.
 * ───────────────────────────────────────────────────────────────────── */
export interface CatalogueSeedSummary {
  toCreate: number;
  toUpdate: number;
  unchanged: number;
}

function docTypeComparable(v: {
  name: string;
  category: string;
  defaultDescription: string;
  aliases: string[];
  ocrExtractable: boolean;
  legacyCode?: string | null;
}) {
  return {
    name: v.name,
    category: v.category,
    defaultDescription: v.defaultDescription,
    aliases: [...(v.aliases || [])].sort(),
    ocrExtractable: v.ocrExtractable,
    legacyCode: v.legacyCode ?? undefined,
  };
}

export async function seedVisaDocumentTypes(dryRun: boolean): Promise<CatalogueSeedSummary> {
  const summary: CatalogueSeedSummary = { toCreate: 0, toUpdate: 0, unchanged: 0 };

  for (const seed of VISA_DOCUMENT_TYPE_CATALOGUE) {
    const existing = await VisaDocumentType.findOne({ code: seed.code }).lean();
    const desired = {
      code: seed.code,
      name: seed.name,
      category: seed.category,
      defaultDescription: seed.defaultDescription,
      aliases: [...seed.aliases],
      ocrExtractable: seed.ocrExtractable,
      legacyCode: seed.legacyCode,
    };

    if (!existing) {
      summary.toCreate += 1;
      if (!dryRun) await VisaDocumentType.create({ ...desired, seedSource: SEED_SOURCE });
      continue;
    }

    if (isDeepStrictEqual(docTypeComparable(existing as any), docTypeComparable(desired))) {
      summary.unchanged += 1;
      continue;
    }

    summary.toUpdate += 1;
    if (!dryRun) await VisaDocumentType.updateOne({ _id: (existing as any)._id }, { $set: desired });
  }

  return summary;
}

/* ─────────────────────────────────────────────────────────────────────
 * 2. VisaQuestion shared bank seed — task brief §7's own list of repeated
 * questions: marital status, employment history, prior refusals (+ its
 * conditional country/date/reason follow-ups), who is funding the trip,
 * countries visited, parents' details. Seed data itself now lives in
 * config/visaQuestionBankSeed.ts (Phase 10c — see that file's header for
 * why); re-exported here for this module's own test file.
 * ───────────────────────────────────────────────────────────────────── */
export { VISA_QUESTION_BANK_SEED };

function questionComparable(v: {
  prompt: string;
  answerType: string;
  options?: string[];
  category?: string;
  followUps: VisaQuestionFollowUp[];
}) {
  return {
    prompt: v.prompt,
    answerType: v.answerType,
    options: [...(v.options || [])],
    category: v.category ?? undefined,
    followUps: v.followUps || [],
  };
}

export async function seedVisaQuestionBank(dryRun: boolean): Promise<CatalogueSeedSummary> {
  const summary: CatalogueSeedSummary = { toCreate: 0, toUpdate: 0, unchanged: 0 };

  for (const seed of VISA_QUESTION_BANK_SEED) {
    const existing = await VisaQuestion.findOne({ code: seed.code }).lean();
    const desired = {
      code: seed.code,
      prompt: seed.prompt,
      answerType: seed.answerType,
      options: seed.options || [],
      category: seed.category,
      followUps: seed.followUps,
      isActive: true,
    };

    if (!existing) {
      summary.toCreate += 1;
      if (!dryRun) await VisaQuestion.create({ ...desired, seedSource: SEED_SOURCE });
      continue;
    }

    if (isDeepStrictEqual(questionComparable(existing as any), questionComparable(desired))) {
      summary.unchanged += 1;
      continue;
    }

    summary.toUpdate += 1;
    if (!dryRun) await VisaQuestion.updateOne({ _id: (existing as any)._id }, { $set: desired });
  }

  return summary;
}

/* ─────────────────────────────────────────────────────────────────────
 * 3. VisaRule: variantKey + documentGroups derivation.
 * ───────────────────────────────────────────────────────────────────── */

// Deterministic, hand-curated mapping from known legacy `condition` free
// text (scripts/seed-visa-rules.ts's own seed data — the only source of
// `condition` strings that exist in production today) to a structured
// applicant-attribute predicate. Deliberately NOT a heuristic/NLP guess: an
// unmapped condition keeps its original text as `legacyConditionNote`
// rather than risk fabricating a wrong predicate. See structureLegacyCondition's
// own export for how this is applied.
const KNOWN_LEGACY_CONDITIONS: Readonly<Record<string, VisaApplicantPredicate>> = {
  "If self-employed or a business owner": [{ field: "employmentStatus", in: ["SELF_EMPLOYED"] }],
};

export function structureLegacyCondition(condition: string | undefined): {
  appliesWhen?: VisaApplicantPredicate;
  legacyConditionNote?: string;
} {
  if (!condition) return {};
  const structured = KNOWN_LEGACY_CONDITIONS[condition];
  return structured ? { appliesWhen: structured, legacyConditionNote: condition } : { legacyConditionNote: condition };
}

/**
 * Derives the new group-based `documentGroups` from a rule's legacy flat
 * `documentRequirements` — one group per legacy entry (a 1:1 wrap, not a
 * re-bundling: the seven existing rows never expressed France-style
 * multi-document groups, so there is nothing to merge). Pure and
 * deterministic — same input always produces the same output, which is
 * what makes migrateVisaRulesToV2 idempotent.
 */
export function buildDocumentGroupsFromLegacyRequirements(
  requirements: VisaDocumentRequirement[] | null | undefined,
): VisaDocumentRequirementGroup[] {
  return (requirements || []).map((req, index) => {
    const canonicalCode = canonicalizeVisaDocumentCode(req.docCode);
    const seed = VISA_DOCUMENT_TYPE_CATALOGUE.find((d) => d.code === canonicalCode);
    const { appliesWhen, legacyConditionNote } = structureLegacyCondition(req.condition);

    const group: VisaDocumentRequirementGroup = {
      key: `${canonicalCode}_${index}`,
      label: seed?.name ?? req.docCode,
      requirement: req.requirement,
      docTypeCodes: [canonicalCode],
    };
    if (appliesWhen) group.appliesWhen = appliesWhen;
    if (legacyConditionNote) group.legacyConditionNote = legacyConditionNote;
    return group;
  });
}

export interface RuleMigrationSummary {
  rulesScanned: number;
  rulesUpdated: number;
  rulesAlreadyMigrated: number;
}

export async function migrateVisaRulesToV2(dryRun: boolean): Promise<RuleMigrationSummary> {
  const summary: RuleMigrationSummary = { rulesScanned: 0, rulesUpdated: 0, rulesAlreadyMigrated: 0 };

  const rules = await VisaRule.find({}).lean();
  for (const rule of rules as any[]) {
    summary.rulesScanned += 1;

    const desiredVariantKey = rule.variantKey || "DEFAULT";
    const desiredGroups = buildDocumentGroupsFromLegacyRequirements(rule.documentRequirements);

    const variantKeyChanged = rule.variantKey !== desiredVariantKey;
    const groupsChanged = !isDeepStrictEqual(rule.documentGroups || [], desiredGroups);

    if (!variantKeyChanged && !groupsChanged) {
      summary.rulesAlreadyMigrated += 1;
      continue;
    }

    summary.rulesUpdated += 1;
    if (!dryRun) {
      await VisaRule.updateOne(
        { _id: rule._id },
        { $set: { variantKey: desiredVariantKey, documentGroups: desiredGroups } },
      );
    }
  }

  return summary;
}

/* ─────────────────────────────────────────────────────────────────────
 * 4. Rule-key unique index widening — not unit tested (no other migration
 * in this directory unit-tests raw index create/drop either; it requires a
 * real Mongo connection). Creates the new 6-field unique index BEFORE
 * dropping the old 5-field one, so writes are never briefly unprotected —
 * safe because the new key is a strict widening (adds variantKey), so it
 * can never reject a document the old index would have accepted.
 * ───────────────────────────────────────────────────────────────────── */
const OLD_UNIQUE_INDEX_KEY = { nationality: 1, destinationIso2: 1, purpose: 1, entryType: 1, serviceTier: 1 };
const NEW_UNIQUE_INDEX_KEY = {
  nationality: 1, destinationIso2: 1, purpose: 1, entryType: 1, serviceTier: 1, variantKey: 1,
};

export async function migrateRuleKeyIndex(dryRun: boolean): Promise<string> {
  const indexes = await VisaRule.collection.indexes();
  const oldIndex = indexes.find((idx: any) => isDeepStrictEqual(idx.key, OLD_UNIQUE_INDEX_KEY));
  const newIndexExists = indexes.some((idx: any) => isDeepStrictEqual(idx.key, NEW_UNIQUE_INDEX_KEY));

  if (newIndexExists && !oldIndex) {
    return "already migrated — 6-field unique index present, old 5-field index absent";
  }

  if (dryRun) {
    const parts: string[] = [];
    if (!newIndexExists) parts.push("would create the new 6-field unique index (nationality/destinationIso2/purpose/entryType/serviceTier/variantKey)");
    if (oldIndex) parts.push(`would drop the old 5-field unique index ("${oldIndex.name}")`);
    return parts.join("; ") || "no change";
  }

  if (!newIndexExists) {
    await VisaRule.collection.createIndex(NEW_UNIQUE_INDEX_KEY as any, { unique: true });
  }
  if (oldIndex) {
    await VisaRule.collection.dropIndex(oldIndex.name as string);
  }
  return `created new 6-field unique index; dropped old 5-field index ${oldIndex ? `("${oldIndex.name}")` : "(none found)"}`;
}

/* ─────────────────────────────────────────────────────────────────────
 * Entry point.
 * ───────────────────────────────────────────────────────────────────── */
async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  console.log("=== Visa checklist model v2 migration (Phase 10a) ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    await runMigration({
      migrationName: "2026-08-02-visa-checklist-model-v2",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const docTypeSummary = await seedVisaDocumentTypes(dryRun);
        const docTypeLine = `VisaDocumentType catalogue: ${docTypeSummary.toCreate} to create, ${docTypeSummary.toUpdate} to update, ${docTypeSummary.unchanged} unchanged`;
        console.log(docTypeLine);

        const questionSummary = await seedVisaQuestionBank(dryRun);
        const questionLine = `VisaQuestion bank: ${questionSummary.toCreate} to create, ${questionSummary.toUpdate} to update, ${questionSummary.unchanged} unchanged`;
        console.log(questionLine);

        const ruleSummary = await migrateVisaRulesToV2(dryRun);
        const ruleLine = `VisaRule rows: ${ruleSummary.rulesScanned} scanned, ${ruleSummary.rulesUpdated} to update (variantKey/documentGroups), ${ruleSummary.rulesAlreadyMigrated} already migrated`;
        console.log(ruleLine);

        const indexResult = await migrateRuleKeyIndex(dryRun);
        const indexLine = `Rule-key unique index: ${indexResult}`;
        console.log(indexLine);

        console.log("");
        console.log("Old-code -> new-code mapping applied by this catalogue (DOC-NN codes are NOT rewritten in storage — see file header):");
        for (const seed of VISA_DOCUMENT_TYPE_CATALOGUE) {
          if (seed.legacyCode) console.log(`  ${seed.legacyCode}  ->  ${seed.code}`);
        }

        if (dryRun) {
          console.log("");
          console.log("Re-run with --apply to write these changes.");
        }

        return { outcome: "SUCCESS", summary: [docTypeLine, questionLine, ruleLine, indexLine].join(" | ") };
      },
    });
  } finally {
    await mongoose.connection.close();
  }
}

// Auto-run ONLY when this file is the actual process entry point — an
// env-var guard alone (NODE_ENV/VITEST) protects against the test runner but
// NOT against another module importing this file for its exports, which
// silently triggered main() as an import side effect (a real accidental
// dry-run against production, via VISA_QUESTION_BANK_SEED being imported
// from here — that seed now lives in its own side-effect-free
// config/visaQuestionBankSeed.ts). Comparing process.argv[1] against this
// file's own path closes that gap for good.
const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Migration failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}

export { SEED_SOURCE };
