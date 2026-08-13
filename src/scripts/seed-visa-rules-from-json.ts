// apps/backend/src/scripts/seed-visa-rules-from-json.ts
//
// Loads visa rules AND their document requirements from a single JSON file
// (docs/visa/visa-rules-stampmyvisa.json) into VisaRule in one pass — the
// rule row and its nested documentGroups are written together, so there is
// no export-the-ids-and-come-back second step (which is what routes/
// admin.visa.rules.importExport.ts's spreadsheet path forces, since a
// REQUIREMENTS sheet can only reference a rule id that already exists).
//
// ── WHAT THIS TOUCHES ─────────────────────────────────────────────────
// VisaRule (collection `visarules`), inserts only. That is the complete
// list. It is the only model imported here, ALLOWED_MODELS is a
// single-entry list, and assertOnlyWritesVisaRule() re-reads this file's
// own source to prove no other model is written to and that this script
// contains no delete/drop call at all. VisaDestinationContent, VisaRequest,
// VisaApplication, VisaDocument, VisaTemplate, VisaQuestion, Counter and
// everything else are unreachable by construction.
//
// ── fileRuleId IS NOT A DATABASE ID ───────────────────────────────────
// The source values are fabricated (see the file's own _meta.note). Every
// rule gets a fresh Mongo _id; fileRuleId is never written anywhere. It is
// carried through this script only as a label in the reports, so a row in
// the output can be found again in the JSON. The requirements are already
// NESTED under their rule in this format, so nothing is joined on it at
// all — two rules even share a fileRuleId in the current file, harmlessly.
//
// ── GUARDS, IN THE ORDER THEY RUN ─────────────────────────────────────
//   1. assertOnlyWritesVisaRule() — self-scan of this file's source before
//      anything connects. Same convention as scripts/
//      delete-all-visa-rules.ts's assertOnlyDeletesVisaRule() and routes/
//      admin.visa.rules.importExport.ts's assertNeverSetsPublishedStatus().
//   2. assertModelScope() — only VisaRule may be registered with mongoose.
//   3. DRY RUN unless --confirm. The default run reads the JSON, validates
//      every row against the real schema, resolves collisions against LIVE
//      data, prints the full plan, and writes NOTHING.
//   4. --confirm additionally requires the target database NAME typed at an
//      interactive prompt. No --yes escape hatch, TTY only.
//
// ── NEVER PUBLISHES ───────────────────────────────────────────────────
// status is taken from the file but constrained to ALLOWED_STATUSES
// (DRAFT/RETIRED) — a row carrying anything else is reported as a
// validation failure, never coerced. assertNeverWritesPublished() backs
// that with the same self-scanning source check the import route uses.
//
// Run (dry run, safe, read-only):
//   pnpm -C apps/backend exec tsx src/scripts/seed-visa-rules-from-json.ts
// Run (the real write — prompts for the database name):
//   pnpm -C apps/backend exec tsx src/scripts/seed-visa-rules-from-json.ts --confirm
// Optional: --file=<path to an alternative JSON in the same shape>
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";

const ALLOWED_MODELS = ["VisaRule"];

// Provenance marker — scripts/purge-visa-seed.ts's `<source>@<year-month>`
// convention, its own distinct value so these rows are separable from the
// checklist-PDF import's and the spreadsheet import's.
const SEED_SOURCE = "stampmyvisa-json@2026-08";

// The JSON carries no nationality field at all; its _meta says "IN — confirm
// in seed". VisaRule.nationality is REQUIRED, and it is the first field of
// the six-field unique key, so it is set here explicitly rather than left to
// any default (the schema has none for it). Every row in this file is an
// Indian-passport corridor.
const NATIONALITY = "IN";

// Also absent from the JSON and also schema-required (enum
// VISA_PRODUCT_CLASSES). Every row in this source is an ordinary visa
// product; ARRIVAL_CARD/FORM_SERVICE/APPOINTMENT_SERVICE rows would have to
// come from a source that actually distinguishes them.
const PRODUCT_CLASS = "VISA";

// A blank/None/absent Entry Type maps to the schema's own "not stated"
// member. UNSPECIFIED is a real enum value, not a null — entryType is
// required AND part of the unique key, so it can never be left unset.
const ENTRY_TYPE_WHEN_BLANK = "UNSPECIFIED";

// This script may write these lifecycle states and no others.
const ALLOWED_STATUSES = ["DRAFT", "RETIRED"];

/* ─────────────────────────────────────────────────────────────────────
 * Guard 1 — self-scan. Patterns are ASSEMBLED from fragments so this
 * function can never match its own definition and "pass" by finding
 * itself.
 * ───────────────────────────────────────────────────────────────────── */
const WRITE_CALL_PATTERN = new RegExp(
  "(\\w+)\\s*\\.\\s*(?:" + "create" + "|" + "insert" + "(?:One|Many)|" + "bulk" + "Write|" + "update" + "(?:One|Many)|" + "replace" + "One)\\s*\\(",
  "g",
);
const FORBIDDEN_APIS = [
  "delete" + "One(", "delete" + "Many(", "drop" + "Database", "drop" + "Collection", "collection" + ".drop",
  "find" + "OneAndDelete", "find" + "OneAndUpdate", "remove" + "(",
];
const FORBIDDEN_STATUS_WRITE = new RegExp("(?:status\\s*:|\\.status\\s*=)\\s*[\"']" + "PUBLISHED" + "[\"']");

function assertOnlyWritesVisaRule(): void {
  const selfPath = fileURLToPath(import.meta.url);
  const source = readFileSync(selfPath, "utf8");

  const receivers = [...source.matchAll(WRITE_CALL_PATTERN)].map((m) => m[1]);
  const foreign = receivers.filter((name) => name !== "VisaRule");
  if (foreign.length > 0) {
    console.error(
      `Refusing to run: this script may only write to VisaRule, but its own source writes to: ` +
        `${[...new Set(foreign)].join(", ")}.`,
    );
    process.exit(1);
  }
  if (receivers.length === 0) {
    console.error("Refusing to run: this script's own source contains no VisaRule write call — the self-check is broken.");
    process.exit(1);
  }

  const found = FORBIDDEN_APIS.filter((api) => source.includes(api));
  if (found.length > 0) {
    console.error(
      `Refusing to run: this script's own source uses a forbidden API: ${found.join(", ")}. ` +
        `This script inserts rules; it never deletes, drops or bulk-updates anything.`,
    );
    process.exit(1);
  }

  const published = source.match(FORBIDDEN_STATUS_WRITE);
  if (published) {
    console.error(`Refusing to run: this script must never write a PUBLISHED status, but its source contains "${published[0]}".`);
    process.exit(1);
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Guard 2 — model scope.
 * ───────────────────────────────────────────────────────────────────── */
function assertModelScope(): void {
  const registered = mongoose.modelNames();
  const unexpected = registered.filter((name) => !ALLOWED_MODELS.includes(name));
  if (unexpected.length > 0) {
    console.error(
      `Refusing to run: this script may only touch ${ALLOWED_MODELS.join(", ")}, but ` +
        `additional model(s) are registered: ${unexpected.join(", ")}.`,
    );
    process.exit(1);
  }
}

function targetInfo(): { host: string; db: string } {
  const url = new URL(env.MONGO_URI);
  return { host: url.hostname, db: url.pathname.replace(/^\//, "") || "(default)" };
}

function argValue(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

// The FIXED file, not the original conversion — 2026-08-13. The original
// carries 14 truncated-variantKey collisions and 12 visaCategory values
// outside the model's enum, all of which the dry run reported and the
// FIXED file resolves. Defaulting to it means a --confirm run cannot
// silently load the stale one; --file= still overrides for a re-run of a
// subset.
function defaultInputPath(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  // apps/backend/src/scripts -> repo root
  return resolve(scriptDir, "../../../../docs/visa/visa-rules-stampmyvisa.FIXED.json");
}

/* ─────────────────────────────────────────────────────────────────────
 * TRANSFORM — the JSON's flat requirement rows into the model's nested
 * documentGroups sub-documents (VisaDocumentRequirementGroupSchema).
 *
 *   groupKey                   -> key                        (required)
 *   groupLabel                 -> label                      (required)
 *   requirement                -> requirement                (REQUIRED|CONDITIONAL)
 *   documentCodes  "A, B"      -> docTypeCodes ["A","B"]     (comma-split, trimmed)
 *   appliesWhen                -> appliesWhen                (omitted when null)
 *   specification              -> specification              (omitted when null)
 *   templateCode               -> templateCode               (omitted when null)
 *   legacyConditionNote        -> legacyConditionNote        (omitted when null)
 *   needsCatalogueMapping      -> needsCatalogueMapping      (null -> false)
 *   unmatchedDocumentNames     -> unmatchedDocumentNames     (STRING -> [string])
 *   unmatchedTemplateReference -> unmatchedTemplateReference (omitted when null)
 *
 * unmatchedDocumentNames is a single string in this source and a string[]
 * on the model. It is wrapped as a ONE-element array, never comma-split:
 * the source values are verbatim checklist lines that themselves contain
 * commas ("Two copies of the Visa Application Forms, fully completed,
 * typed online, and signed"), so splitting would shred one requirement
 * into fragments that were never separate documents.
 *
 * A null/absent optional is OMITTED rather than written as null — a
 * trimmed String path given null would store null where "unset" is meant,
 * and `needsCatalogueMapping` has its own schema default of false.
 * ───────────────────────────────────────────────────────────────────── */
function buildDocumentGroup(raw: any): Record<string, any> {
  const group: Record<string, any> = {
    key: String(raw?.groupKey ?? "").trim(),
    label: String(raw?.groupLabel ?? "").trim(),
    requirement: String(raw?.requirement ?? "").trim().toUpperCase(),
    docTypeCodes: String(raw?.documentCodes ?? "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean),
  };

  if (raw?.appliesWhen != null) group.appliesWhen = raw.appliesWhen;
  if (raw?.specification != null && String(raw.specification).trim()) group.specification = String(raw.specification).trim();
  if (raw?.templateCode != null && String(raw.templateCode).trim()) group.templateCode = String(raw.templateCode).trim();
  if (raw?.legacyConditionNote != null && String(raw.legacyConditionNote).trim()) {
    group.legacyConditionNote = String(raw.legacyConditionNote).trim();
  }
  if (raw?.needsCatalogueMapping) group.needsCatalogueMapping = true;
  if (raw?.unmatchedDocumentNames != null) {
    const v = raw.unmatchedDocumentNames;
    const names = Array.isArray(v) ? v.map((s: any) => String(s).trim()).filter(Boolean) : [String(v).trim()].filter(Boolean);
    if (names.length) group.unmatchedDocumentNames = names;
  }
  if (raw?.unmatchedTemplateReference != null && String(raw.unmatchedTemplateReference).trim()) {
    group.unmatchedTemplateReference = String(raw.unmatchedTemplateReference).trim();
  }
  return group;
}

/* ─────────────────────────────────────────────────────────────────────
 * TRANSFORM — a JSON rule into a VisaRule document.
 * Identity/required fields not present in the source are set from the
 * explicit constants above (nationality, productClass), never left to a
 * schema default that doesn't exist. Fields the source doesn't carry at
 * all — isSchengen, validityDays, maxStayDays, appointmentRequired,
 * biometricsRequired, variantLabel, applicability, questions,
 * additionalQuestions, documentRequirements (the LEGACY flat field),
 * effectiveFrom — are deliberately left to the schema's own defaults
 * rather than invented here. displayMode is never set: VisaRule's own
 * pre-validate hook derives it from the fee fields.
 * ───────────────────────────────────────────────────────────────────── */
function buildRuleDoc(raw: any): Record<string, any> {
  const entryTypeRaw = String(raw?.entryType ?? "").trim().toUpperCase();
  const entryType = !entryTypeRaw || entryTypeRaw === "NONE" ? ENTRY_TYPE_WHEN_BLANK : entryTypeRaw;

  const doc: Record<string, any> = {
    nationality: NATIONALITY,
    destinationIso2: String(raw?.destinationIso2 ?? "").trim().toUpperCase(),
    destinationName: String(raw?.destinationName ?? "").trim(),
    purpose: String(raw?.purpose ?? "").trim().toUpperCase(),
    entryType,
    serviceTier: String(raw?.serviceTier ?? "").trim().toUpperCase(),
    variantKey: String(raw?.variantKey ?? "").trim().toUpperCase(),
    productClass: PRODUCT_CLASS,
    status: String(raw?.status ?? "").trim().toUpperCase(),
    documentGroups: (raw?.requirements ?? []).map(buildDocumentGroup),
    seedSource: SEED_SOURCE,
  };

  if (raw?.visaCategory != null && String(raw.visaCategory).trim()) doc.visaCategory = String(raw.visaCategory).trim();
  if (raw?.etaBasis != null && String(raw.etaBasis).trim()) doc.etaBasis = String(raw.etaBasis).trim();
  for (const f of ["etaMinDays", "etaMaxDays", "embassyFeeInr", "vfsFeeInr", "plumtripsServiceFeeInr", "indicativeVisaCostInr"]) {
    if (typeof raw?.[f] === "number") doc[f] = raw[f];
  }
  if (raw?.priceNote != null && String(raw.priceNote).trim()) doc.priceNote = String(raw.priceNote).trim();
  if (raw?.opsNotes != null && String(raw.opsNotes).trim()) doc.opsNotes = String(raw.opsNotes).trim();
  if (raw?.lastReviewedAt) doc.lastReviewedAt = new Date(raw.lastReviewedAt);

  return doc;
}

function naturalKey(doc: Record<string, any>): string {
  return [doc.nationality, doc.destinationIso2, doc.purpose, doc.entryType, doc.serviceTier, doc.variantKey].join("|");
}

function describe(raw: any, doc: Record<string, any>): string {
  return `${doc.destinationIso2} ${doc.purpose}/${doc.entryType}/${doc.serviceTier} [${doc.variantKey}] (fileRuleId ${raw?.fileRuleId ?? "?"})`;
}

interface Candidate {
  index: number;
  raw: any;
  doc: Record<string, any>;
  key: string;
}

interface Plan {
  totalInFile: number;
  toCreate: Candidate[];
  requirementsInFile: number;
  requirementsAttached: number;
  rulesWithNoRequirements: number;
  validationFailures: { row: number; what: string; reason: string }[];
  inFileDuplicates: { row: number; what: string; keptRow: number; key: string }[];
  existingCollisions: { row: number; what: string; existingId: string; key: string }[];
  unknownDocCodes: Map<string, number>;
}

/**
 * Validates against the REAL schema by instantiating a (never-saved)
 * document and running validateSync() — so "would the model reject this"
 * is answered by the model itself (enums, required fields, min:0 on fees,
 * the nested documentGroups sub-schema), not by a hand-written copy of its
 * rules that could drift.
 */
function validationErrors(doc: Record<string, any>): string[] {
  const instance = new VisaRule(doc as any);
  const err = instance.validateSync();
  if (!err) return [];
  return Object.entries(err.errors).map(([path, e]: [string, any]) => `${path}: ${e?.message ?? "invalid"}`);
}

async function buildPlan(rules: any[], catalogueCodes: Set<string> | null): Promise<Plan> {
  const plan: Plan = {
    totalInFile: rules.length,
    toCreate: [],
    requirementsInFile: 0,
    requirementsAttached: 0,
    rulesWithNoRequirements: 0,
    validationFailures: [],
    inFileDuplicates: [],
    existingCollisions: [],
    unknownDocCodes: new Map(),
  };

  // Every live rule's natural key, so the plan reflects what the unique
  // index will actually do rather than assuming an empty collection.
  const existing = await VisaRule.find({})
    .select("_id nationality destinationIso2 purpose entryType serviceTier variantKey")
    .lean();
  const existingByKey = new Map<string, any>(existing.map((r: any) => [naturalKey(r), r]));

  const seenInFile = new Map<string, number>(); // key -> row number that claimed it

  rules.forEach((raw, i) => {
    const row = i + 1;
    const doc = buildRuleDoc(raw);
    const key = naturalKey(doc);
    plan.requirementsInFile += (raw?.requirements ?? []).length;

    for (const g of doc.documentGroups as any[]) {
      for (const code of g.docTypeCodes as string[]) {
        if (catalogueCodes && !catalogueCodes.has(code)) {
          plan.unknownDocCodes.set(code, (plan.unknownDocCodes.get(code) ?? 0) + 1);
        }
      }
    }

    if (!ALLOWED_STATUSES.includes(doc.status)) {
      plan.validationFailures.push({
        row, what: describe(raw, doc),
        reason: `status "${doc.status}" is not one of ${ALLOWED_STATUSES.join(", ")} — this script never writes any other lifecycle state`,
      });
      return;
    }

    const errors = validationErrors(doc);
    if (errors.length) {
      plan.validationFailures.push({ row, what: describe(raw, doc), reason: errors.join("; ") });
      return;
    }

    const existingRule = existingByKey.get(key);
    if (existingRule) {
      plan.existingCollisions.push({ row, what: describe(raw, doc), existingId: String(existingRule._id), key });
      return;
    }

    const claimedBy = seenInFile.get(key);
    if (claimedBy !== undefined) {
      plan.inFileDuplicates.push({ row, what: describe(raw, doc), keptRow: claimedBy, key });
      return;
    }

    seenInFile.set(key, row);
    if (!doc.documentGroups.length) plan.rulesWithNoRequirements += 1;
    plan.requirementsAttached += doc.documentGroups.length;
    plan.toCreate.push({ index: row, raw, doc, key });
  });

  return plan;
}

function printPlan(target: { host: string; db: string }, plan: Plan, countBefore: number): void {
  console.log("──────────────────────────────────────────────────────");
  console.log(`Target host:       ${target.host}`);
  console.log(`Target database:   ${target.db}`);
  console.log(`Collection:        ${VisaRule.collection.name}  (the ONLY collection this script can touch)`);
  console.log(`Rules already in the collection: ${countBefore}`);
  console.log("──────────────────────────────────────────────────────");
  console.log(`Rules in file:              ${plan.totalInFile}`);
  console.log(`Requirement rows in file:   ${plan.requirementsInFile}`);
  console.log("");
  console.log(`WOULD CREATE:               ${plan.toCreate.length} rules`);
  console.log(`  with requirement groups:  ${plan.requirementsAttached} attached`);
  console.log(`  rules with NO checklist:  ${plan.rulesWithNoRequirements}`);
  console.log(`SKIPPED (duplicate key, in file):   ${plan.inFileDuplicates.length}`);
  console.log(`SKIPPED (duplicate key, already in DB): ${plan.existingCollisions.length}`);
  console.log(`VALIDATION FAILURES:        ${plan.validationFailures.length}`);
  console.log("──────────────────────────────────────────────────────");

  if (plan.inFileDuplicates.length) {
    console.log("");
    console.log("SKIPPED (duplicate key) — the 6-field natural key is already claimed by an earlier row in this");
    console.log("same file. The unique index would reject these; the first row of each key is kept.");
    for (const d of plan.inFileDuplicates) {
      console.log(`  row ${String(d.row).padStart(3)}  ${d.what}`);
      console.log(`         key ${d.key}  — already claimed by row ${d.keptRow}`);
    }
  }

  if (plan.existingCollisions.length) {
    console.log("");
    console.log("SKIPPED (duplicate key) — a rule with this natural key ALREADY EXISTS in the database:");
    for (const c of plan.existingCollisions) {
      console.log(`  row ${String(c.row).padStart(3)}  ${c.what}`);
      console.log(`         key ${c.key}  — existing rule ${c.existingId}`);
    }
  }

  if (plan.validationFailures.length) {
    console.log("");
    console.log("VALIDATION FAILURES — the model rejects these rows; they are NOT created and nothing else is affected:");
    for (const f of plan.validationFailures) {
      console.log(`  row ${String(f.row).padStart(3)}  ${f.what}`);
      console.log(`         ${f.reason}`);
    }
  }

  if (plan.unknownDocCodes.size) {
    console.log("");
    console.log("WARNING — document codes used by the file that are NOT in config/visaDocumentTypeCatalogue.ts.");
    console.log("The model does not validate docTypeCodes, so these WOULD be written as-is and would not resolve");
    console.log("to a document type in the checklist UI. Nothing here rewrites or guesses a mapping for them:");
    for (const [code, count] of [...plan.unknownDocCodes.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)} x  ${code}`);
    }
  }
  console.log("──────────────────────────────────────────────────────");
}

async function confirmDatabaseName(expectedDb: string): Promise<void> {
  if (!rlInput.isTTY) {
    console.error(
      "Refusing to run: --confirm requires typing the database name at an interactive terminal, " +
        "and stdin is not a TTY. Run this yourself in a shell.",
    );
    process.exit(1);
  }
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const answer = await rl.question(`Type the database name ("${expectedDb}") to WRITE these rules: `);
    if (answer.trim() !== expectedDb) {
      console.error("Aborted: input did not match the database name. Nothing was written.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000 || err?.code === 11001 || /E11000/.test(String(err?.message ?? ""));
}

async function run() {
  assertOnlyWritesVisaRule();

  const confirmed = process.argv.includes("--confirm");
  const inputPath = argValue("--file") ?? defaultInputPath();

  const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
  const rules: any[] = Array.isArray(parsed?.rules) ? parsed.rules : [];
  if (!rules.length) {
    console.error(`Refusing to run: ${inputPath} has no rules[] array.`);
    process.exit(1);
  }

  // Loaded only to REPORT unresolvable document codes — never used to
  // rewrite one. Kept optional so a missing/renamed catalogue module
  // degrades the report rather than blocking the seed.
  let catalogueCodes: Set<string> | null = null;
  try {
    const mod = await import("../config/visaDocumentTypeCatalogue.js");
    catalogueCodes = new Set((mod.VISA_DOCUMENT_TYPE_CATALOGUE as any[]).map((d) => d.code));
  } catch {
    catalogueCodes = null;
  }

  console.log(`Input: ${inputPath}`);
  if (parsed?._meta) {
    console.log(`_meta: ruleCount=${parsed._meta.ruleCount} requirementCount=${parsed._meta.requirementCount} source=${parsed._meta.source}`);
  }

  await connectDb();
  assertModelScope();

  const target = targetInfo();
  const countBefore = await VisaRule.countDocuments({});
  const plan = await buildPlan(rules, catalogueCodes);
  printPlan(target, plan, countBefore);

  if (!confirmed) {
    console.log("DRY RUN — nothing was written.");
    console.log("Re-run with --confirm (and type the database name at the prompt) to create these rules.");
    process.exit(0);
  }

  if (!plan.toCreate.length) {
    console.log("Nothing to create — every row was skipped or failed validation. Nothing was written.");
    process.exit(0);
  }

  console.log("");
  console.log(`!! This will insert ${plan.toCreate.length} new DRAFT rules into ${target.db}.${VisaRule.collection.name}.`);
  console.log("!! No existing rule is modified or deleted. No other collection is touched.");
  await confirmDatabaseName(target.db);

  // One row at a time, each in its own try/catch: a duplicate-key rejection
  // from the index (a key that appeared between the plan and the write, or
  // any collision the plan couldn't foresee) skips THAT row and is reported
  // — it never aborts the run and is never swallowed.
  let created = 0;
  let attached = 0;
  const skippedAtWrite: { row: number; what: string; reason: string }[] = [];

  for (const candidate of plan.toCreate) {
    try {
      await VisaRule.create(candidate.doc as any);
      created += 1;
      attached += (candidate.doc.documentGroups as any[]).length;
    } catch (err: any) {
      skippedAtWrite.push({
        row: candidate.index,
        what: describe(candidate.raw, candidate.doc),
        reason: isDuplicateKeyError(err) ? `duplicate key (${candidate.key})` : `write failed: ${err?.message ?? err}`,
      });
    }
  }

  const countAfter = await VisaRule.countDocuments({});

  console.log("──────────────────────────────────────────────────────");
  console.log(`Count before: ${countBefore}`);
  console.log(`Created:      ${created} rules, ${attached} requirement groups attached`);
  console.log(`Count after:  ${countAfter}`);
  if (skippedAtWrite.length) {
    console.log("");
    console.log(`SKIPPED (duplicate key) at write time: ${skippedAtWrite.length}`);
    for (const s of skippedAtWrite) console.log(`  row ${String(s.row).padStart(3)}  ${s.what}\n         ${s.reason}`);
  }
  console.log("──────────────────────────────────────────────────────");
  process.exit(0);
}

run().catch((err) => {
  console.error("seed-visa-rules-from-json failed:", err);
  process.exit(1);
});
