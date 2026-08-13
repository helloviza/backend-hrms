// apps/backend/src/migrations/2026-08-02-merge-visa-price-list.ts
//
// Phase 10d follow-up — the 43 DRAFT VisaRule rows imported from checklist
// PDFs (scripts/import-visa-checklist-rules.ts) carry documents but no
// visaCategory, no ETA, and no cost — none of which any checklist PDF
// states. This merges in the ONE piece of that gap that DOES exist on
// paper: docs/data/visa-price-list.csv, an indicative-cost-and-ETA price
// list (64 rows / 46 destinations) ops is exporting from the original
// source document.
//
// CSV shape this reads (header row required, case-insensitive, exact
// column names below):
//   destination            — plain country name (e.g. "United Arab
//                             Emirates", "South Africa", "Turkey") or
//                             ISO2/ISO3/demonym/alias — resolved via
//                             utils/countryCodes.ts's normaliseToIso2, the
//                             SAME resolver scripts/extract-visa-
//                             checklists.ts already used, so a destination
//                             this file can't resolve is a destination that
//                             extraction couldn't have resolved either.
//   purpose                 — "Tourist"/"Business"/"Transit"/a combined
//                             phrase like "Tourist or Business" or "B1/B2"
//                             — resolved via utils/
//                             visaChecklistCatalogueMatcher.ts's
//                             matchPurposeLabel, the SAME resolver the
//                             checklist extraction's purpose classification
//                             falls back to.
//   serviceTier              — optional, default "Standard". One of
//                             Standard/Express/Superfast/Priority/Super
//                             Priority.
//   variantKey               — optional, default "DEFAULT" (matches the
//                             DRAFT rule's own default). ONLY needed when a
//                             destination+purpose has more than one DRAFT
//                             variant with genuinely different pricing
//                             (Turkey's e-visa vs. sticker visa, Canada's
//                             US-visa-holder variant, South Africa's
//                             official/diplomatic variant) — leave blank
//                             for everything else; a blank row is NEVER
//                             applied to a non-DEFAULT variant, so an
//                             e-visa and a sticker visa never silently
//                             share one price.
//   indicativeVisaCostInr    — required. Plain number, INR, no currency
//                             symbol (commas tolerated).
//   etaMinDays / etaMaxDays  — optional, but must both be present or both
//                             absent, and min must not exceed max.
//   etaBasis                 — optional, default "Business". "Business" or
//                             "Calendar".
//   priceNote                — optional free text, carried onto the rule
//                             verbatim.
//
// visaCategory is NEVER touched here — most price-list rows don't state it
// confidently, and it's an ops decision made through the fee/rule UI, not
// something this merge infers from a cost figure. assertNeverSetsCategory()
// below backs that with a structural check, same posture scripts/
// import-visa-checklist-rules.ts's assertNeverPublishesLiteral() already
// takes for its own "never PUBLISHED" guarantee.
//
// Only ever touches a DRAFT rule from the checklist-extraction seed
// (VisaRule.seedSource === scripts/import-visa-checklist-rules.ts's
// SEED_SOURCE) — never a PUBLISHED/RETIRED rule, never a rule from any
// other source. Rules stay DRAFT; nothing here ever sets status.
//
// Reports gaps in BOTH directions, never silently:
//   - a price-list row with no matching VisaRule at all (destination/
//     purpose/tier this platform has no checklist-derived rule for yet)
//   - a price-list row that matches a rule that is no longer DRAFT (ops
//     already promoted or retired it — never overwritten)
//   - a DRAFT checklist-import rule that, after this run, STILL has no
//     price (no price-list row ever matched it)
//   - two price-list rows that resolve to the IDENTICAL natural key (same
//     destination/purpose/tier/variant) — both skipped and reported,
//     mirroring scripts/import-visa-checklist-rules.ts's own intra-batch
//     collision handling, never one silently overwriting the other.
//
// Ledger (Phase 10d) — every run (dry-run, apply, or a thrown failure) is
// recorded via migrations/lib/migrationRunner.ts. Once a successful --apply
// run is recorded, running --apply again is refused unless --force is also
// passed (re-running with an UPDATED price list is a normal, expected
// operation, so pass --force deliberately when that's what's happening).
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/migrations/2026-08-02-merge-visa-price-list.ts                 # dry-run
//   pnpm exec tsx src/migrations/2026-08-02-merge-visa-price-list.ts --apply          # write
//   pnpm exec tsx src/migrations/2026-08-02-merge-visa-price-list.ts --apply --force  # re-apply despite a recorded success
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule, { VISA_SERVICE_TIERS, VISA_ETA_BASES, type VisaPurpose, type VisaServiceTier, type VisaEtaBasis } from "../models/VisaRule.js";
import { matchPurposeLabel } from "../utils/visaChecklistCatalogueMatcher.js";
import { normaliseToIso2 } from "../utils/countryCodes.js";
import { parseCsvWithHeader } from "../utils/simpleCsv.js";
import { SEED_SOURCE as CHECKLIST_SEED_SOURCE } from "../scripts/import-visa-checklist-rules.js";
import { runMigration } from "./lib/migrationRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DEFAULT_CSV_PATH = path.join(REPO_ROOT, "docs", "data", "visa-price-list.csv");

/* ─────────────────────────────────────────────────────────────────────
 * Structural guard — reads this file's own source and refuses to run if
 * it finds an actual object-property or assignment writing onto
 * `visaCategory`. Shape-restricted (a leading "." or a JS-object-literal
 * key position), not a blind substring check, so this doesn't trip over
 * its own prose describing the rule (deliberately never spelled out in
 * assignment shape in any comment in this file).
 * ───────────────────────────────────────────────────────────────────── */
const FORBIDDEN_CATEGORY_WRITE = /(?:visaCategory\s*:|\.visaCategory\s*=)/;

function assertNeverSetsCategory(): void {
  const selfPath = fileURLToPath(import.meta.url);
  const source = readFileSync(selfPath, "utf8");
  const match = source.match(FORBIDDEN_CATEGORY_WRITE);
  if (match) {
    console.error(
      `Refusing to run: this merge must never write the category field, but its own source contains ` +
        `an assignment shape ("${match[0]}"). Remove it — this migration never sets that field.`,
    );
    process.exit(1);
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Row resolution — raw CSV text in, a validated candidate or a skip
 * reason out. Pure — no DB access — so unit-testable without a
 * connection.
 * ───────────────────────────────────────────────────────────────────── */
export interface ResolvedPriceListRow {
  sourceRowNumber: number;
  destinationRaw: string;
  destinationIso2: string;
  purpose: VisaPurpose;
  serviceTier: VisaServiceTier;
  variantKey: string;
  indicativeVisaCostInr: number;
  etaMinDays?: number;
  etaMaxDays?: number;
  etaBasis: VisaEtaBasis;
  priceNote?: string;
}

const SERVICE_TIER_ALIASES: Record<string, VisaServiceTier> = {
  standard: "STANDARD",
  express: "EXPRESS",
  superfast: "SUPERFAST",
  "super fast": "SUPERFAST",
  priority: "PRIORITY",
  "super priority": "SUPER_PRIORITY",
  superpriority: "SUPER_PRIORITY",
};

function resolveServiceTier(raw: string | undefined): VisaServiceTier | null {
  if (!raw || !raw.trim()) return "STANDARD";
  const norm = raw.trim().toLowerCase();
  if ((VISA_SERVICE_TIERS as readonly string[]).includes(raw.trim().toUpperCase())) {
    return raw.trim().toUpperCase() as VisaServiceTier;
  }
  return SERVICE_TIER_ALIASES[norm] ?? null;
}

function resolveEtaBasis(raw: string | undefined): VisaEtaBasis | null {
  if (!raw || !raw.trim()) return "BUSINESS";
  const norm = raw.trim().toUpperCase();
  return (VISA_ETA_BASES as readonly string[]).includes(norm) ? (norm as VisaEtaBasis) : null;
}

function resolveVariantKey(raw: string | undefined): string {
  const trimmed = (raw || "").trim();
  return trimmed ? trimmed.toUpperCase() : "DEFAULT";
}

/** undefined = cell was empty; null = present but not a valid non-negative number; else the parsed number. */
function parseOptionalNonNegativeNumber(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.trim().replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function resolvePriceListRow(
  raw: Record<string, string>,
  rowNumber: number,
): { ok: true; row: ResolvedPriceListRow } | { ok: false; reason: string } {
  const destinationRaw = (raw.destination || "").trim();
  const destinationIso2 = normaliseToIso2(destinationRaw);
  if (!destinationIso2) {
    return { ok: false, reason: `destination "${destinationRaw}" not recognised` };
  }

  const purposeRaw = (raw.purpose || "").trim();
  const purpose = matchPurposeLabel(purposeRaw);
  if (!purpose) {
    return { ok: false, reason: `purpose "${purposeRaw}" not recognised (expected Tourist/Business/Transit, or a combined phrase like "B1/B2")` };
  }

  const serviceTier = resolveServiceTier(raw.servicetier);
  if (!serviceTier) {
    return { ok: false, reason: `serviceTier "${raw.servicetier}" not recognised` };
  }

  const etaBasis = resolveEtaBasis(raw.etabasis);
  if (!etaBasis) {
    return { ok: false, reason: `etaBasis "${raw.etabasis}" not recognised (expected Business or Calendar)` };
  }

  const cost = parseOptionalNonNegativeNumber(raw.indicativevisacostinr);
  if (cost === undefined) return { ok: false, reason: "indicativeVisaCostInr is required" };
  if (cost === null) return { ok: false, reason: `indicativeVisaCostInr "${raw.indicativevisacostinr}" is not a valid non-negative number` };

  const etaMin = parseOptionalNonNegativeNumber(raw.etamindays);
  const etaMax = parseOptionalNonNegativeNumber(raw.etamaxdays);
  if (etaMin === null) return { ok: false, reason: `etaMinDays "${raw.etamindays}" is not a valid non-negative number` };
  if (etaMax === null) return { ok: false, reason: `etaMaxDays "${raw.etamaxdays}" is not a valid non-negative number` };
  if ((etaMin === undefined) !== (etaMax === undefined)) {
    return { ok: false, reason: "etaMinDays and etaMaxDays must both be present or both be absent" };
  }
  if (etaMin !== undefined && etaMax !== undefined && etaMin > etaMax) {
    return { ok: false, reason: `etaMinDays (${etaMin}) is greater than etaMaxDays (${etaMax})` };
  }

  const priceNoteRaw = (raw.pricenote || "").trim();

  const row: ResolvedPriceListRow = {
    sourceRowNumber: rowNumber,
    destinationRaw,
    destinationIso2,
    purpose,
    serviceTier,
    variantKey: resolveVariantKey(raw.variantkey),
    indicativeVisaCostInr: cost,
    etaBasis,
    ...(etaMin !== undefined ? { etaMinDays: etaMin, etaMaxDays: etaMax as number } : {}),
    ...(priceNoteRaw ? { priceNote: priceNoteRaw } : {}),
  };
  return { ok: true, row };
}

/* ─────────────────────────────────────────────────────────────────────
 * Merge — validated rows in, DB reconciled out. The exported, testable
 * core: no file I/O, no argv parsing, just Mongoose calls, same convention
 * as every other migration's core function in this directory.
 * ───────────────────────────────────────────────────────────────────── */
function naturalKey(row: ResolvedPriceListRow) {
  return {
    nationality: "IN",
    destinationIso2: row.destinationIso2,
    purpose: row.purpose,
    entryType: "UNSPECIFIED",
    serviceTier: row.serviceTier,
    variantKey: row.variantKey,
  };
}

export interface SkippedPriceListRow {
  sourceRowNumber: number;
  destinationRaw: string;
  reason: string;
}

export interface UnmatchedPriceListRow {
  destinationIso2: string;
  purpose: string;
  serviceTier: string;
  variantKey: string;
}

export interface SkippedNotDraftRow extends UnmatchedPriceListRow {
  status: string;
}

export interface UnpricedDraftRule {
  destinationIso2: string;
  destinationName: string;
  purpose: string;
  serviceTier: string;
  variantKey: string;
}

export interface DuplicatePriceListKey {
  key: string;
  sourceRowNumbers: number[];
}

export interface PriceMergeSummary {
  rowsProcessed: number;
  toUpdate: number;
  unchanged: number;
  invalidRows: SkippedPriceListRow[];
  duplicateKeysInCsv: DuplicatePriceListKey[];
  priceListRowsUnmatched: UnmatchedPriceListRow[];
  priceListRowsSkippedNotDraft: SkippedNotDraftRow[];
  draftRulesWithNoPrice: UnpricedDraftRule[];
}

export async function mergeVisaPriceList(
  rows: ResolvedPriceListRow[],
  dryRun: boolean,
): Promise<PriceMergeSummary> {
  const summary: PriceMergeSummary = {
    rowsProcessed: rows.length,
    toUpdate: 0,
    unchanged: 0,
    invalidRows: [],
    duplicateKeysInCsv: [],
    priceListRowsUnmatched: [],
    priceListRowsSkippedNotDraft: [],
    draftRulesWithNoPrice: [],
  };

  // Pass 1 — two price-list rows resolving to the IDENTICAL natural key
  // would otherwise have the second upsert silently overwrite the first.
  // Skip and report ALL of them instead — never guess which one "wins".
  const byKey = new Map<string, { row: ResolvedPriceListRow; keyStr: string }[]>();
  for (const row of rows) {
    const keyStr = JSON.stringify(naturalKey(row));
    const list = byKey.get(keyStr) || [];
    list.push({ row, keyStr });
    byKey.set(keyStr, list);
  }

  const toProcess: ResolvedPriceListRow[] = [];
  for (const list of byKey.values()) {
    if (list.length === 1) {
      toProcess.push(list[0].row);
      continue;
    }
    summary.duplicateKeysInCsv.push({
      key: list[0].keyStr,
      sourceRowNumbers: list.map((e) => e.row.sourceRowNumber),
    });
  }

  // Pass 2 — reconcile each surviving row against the database.
  const pricedRuleIds = new Set<string>();

  for (const row of toProcess) {
    const key = naturalKey(row);
    const existing = await VisaRule.findOne(key).lean();

    if (!existing) {
      summary.priceListRowsUnmatched.push({
        destinationIso2: key.destinationIso2,
        purpose: key.purpose,
        serviceTier: key.serviceTier,
        variantKey: key.variantKey,
      });
      continue;
    }

    if ((existing as any).status !== "DRAFT") {
      summary.priceListRowsSkippedNotDraft.push({
        destinationIso2: key.destinationIso2,
        purpose: key.purpose,
        serviceTier: key.serviceTier,
        variantKey: key.variantKey,
        status: (existing as any).status,
      });
      continue;
    }

    pricedRuleIds.add(String((existing as any)._id));

    const fields: Record<string, any> = { indicativeVisaCostInr: row.indicativeVisaCostInr };
    if (row.etaMinDays !== undefined && row.etaMaxDays !== undefined) {
      fields.etaMinDays = row.etaMinDays;
      fields.etaMaxDays = row.etaMaxDays;
      fields.etaBasis = row.etaBasis;
    }
    if (row.priceNote !== undefined) fields.priceNote = row.priceNote;

    const changed = Object.keys(fields).some(
      (k) => JSON.stringify((existing as any)[k] ?? null) !== JSON.stringify(fields[k] ?? null),
    );

    if (!changed) {
      summary.unchanged += 1;
      continue;
    }

    summary.toUpdate += 1;
    if (!dryRun) {
      await VisaRule.updateOne({ _id: (existing as any)._id }, { $set: fields });
    }
  }

  // Direction 2 of the gap report — every checklist-import DRAFT rule that,
  // after this run, still has no price. Computed from indicativeVisaCostInr
  // itself (not just "was this touched this run") so a rule priced by an
  // EARLIER run of this same migration is correctly excluded too.
  const draftRules = await VisaRule.find({ status: "DRAFT", seedSource: CHECKLIST_SEED_SOURCE })
    .select("_id destinationIso2 destinationName purpose serviceTier variantKey indicativeVisaCostInr")
    .lean();

  for (const r of draftRules as any[]) {
    const nowPriced = pricedRuleIds.has(String(r._id)) || r.indicativeVisaCostInr !== undefined;
    if (nowPriced) continue;
    summary.draftRulesWithNoPrice.push({
      destinationIso2: r.destinationIso2,
      destinationName: r.destinationName,
      purpose: r.purpose,
      serviceTier: r.serviceTier,
      variantKey: r.variantKey,
    });
  }

  return summary;
}

/* ─────────────────────────────────────────────────────────────────────
 * Entry point.
 * ───────────────────────────────────────────────────────────────────── */
async function main() {
  assertNeverSetsCategory();

  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const fileArg = process.argv.find((a) => a.startsWith("--file="));
  const csvPath = fileArg ? fileArg.slice("--file=".length).trim() : DEFAULT_CSV_PATH;

  console.log("=== Merge visa price list into checklist-import DRAFT rules ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log(`Source: ${csvPath}`);
  console.log("");

  let csvText: string;
  try {
    csvText = readFileSync(csvPath, "utf8");
  } catch (err: any) {
    console.error(`Could not read ${csvPath}: ${err?.message || err}`);
    process.exit(1);
    return;
  }

  const rawRows = parseCsvWithHeader(csvText);
  console.log(`Loaded ${rawRows.length} data row(s) from the CSV.`);
  console.log("");

  const resolved: ResolvedPriceListRow[] = [];
  const invalidRows: SkippedPriceListRow[] = [];
  rawRows.forEach((raw, i) => {
    const rowNumber = i + 2; // +1 for the header row, +1 for 1-indexing
    const result = resolvePriceListRow(raw, rowNumber);
    if (result.ok === false) {
      invalidRows.push({ sourceRowNumber: rowNumber, destinationRaw: raw.destination || "", reason: result.reason });
      return;
    }
    resolved.push(result.row);
  });

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    await runMigration({
      migrationName: "2026-08-02-merge-visa-price-list",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await mergeVisaPriceList(resolved, dryRun);
        summary.invalidRows = [...invalidRows, ...summary.invalidRows];

        console.log(
          `rowsProcessed=${summary.rowsProcessed} toUpdate=${summary.toUpdate} unchanged=${summary.unchanged} ` +
            `invalidRows=${summary.invalidRows.length} duplicateKeysInCsv=${summary.duplicateKeysInCsv.length}`,
        );

        if (summary.invalidRows.length) {
          console.log("\nInvalid CSV rows (skipped):");
          for (const r of summary.invalidRows) {
            console.log(`  row ${r.sourceRowNumber} ("${r.destinationRaw}"): ${r.reason}`);
          }
        }

        if (summary.duplicateKeysInCsv.length) {
          console.log("\nDuplicate keys WITHIN the price list (ALL rows skipped, none applied):");
          for (const d of summary.duplicateKeysInCsv) {
            console.log(`  key=${d.key} — rows ${d.sourceRowNumbers.join(", ")}`);
          }
        }

        if (summary.priceListRowsUnmatched.length) {
          console.log("\nPrice-list rows with NO matching VisaRule at all:");
          for (const r of summary.priceListRowsUnmatched) {
            console.log(`  ${r.destinationIso2}/${r.purpose}/${r.serviceTier}/${r.variantKey}`);
          }
        }

        if (summary.priceListRowsSkippedNotDraft.length) {
          console.log("\nPrice-list rows matching a rule that is no longer DRAFT (not touched):");
          for (const r of summary.priceListRowsSkippedNotDraft) {
            console.log(`  ${r.destinationIso2}/${r.purpose}/${r.serviceTier}/${r.variantKey}: currently ${r.status}`);
          }
        }

        if (summary.draftRulesWithNoPrice.length) {
          console.log(`\nDRAFT checklist-import rules STILL with no price (${summary.draftRulesWithNoPrice.length}):`);
          for (const r of summary.draftRulesWithNoPrice) {
            console.log(`  ${r.destinationName} (${r.destinationIso2})/${r.purpose}/${r.serviceTier}/${r.variantKey}`);
          }
        }

        if (dryRun) {
          console.log("\nRe-run with --apply to write these changes.");
        }

        return {
          outcome: "SUCCESS",
          summary:
            `rowsProcessed=${summary.rowsProcessed} toUpdate=${summary.toUpdate} unchanged=${summary.unchanged} ` +
            `invalidRows=${summary.invalidRows.length} duplicateKeysInCsv=${summary.duplicateKeysInCsv.length} ` +
            `unmatched=${summary.priceListRowsUnmatched.length} skippedNotDraft=${summary.priceListRowsSkippedNotDraft.length} ` +
            `stillUnpriced=${summary.draftRulesWithNoPrice.length}`,
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
    console.error("Merge failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
