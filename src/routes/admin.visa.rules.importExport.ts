// apps/backend/src/routes/admin.visa.rules.importExport.ts
//
// Bulk export/import for the fee-and-rule master (routes/admin.visa.
// rules.ts). The 43 checklist-import DRAFT rules can only be reviewed one
// at a time in RuleEditorModal — this lets ops see everything at once in a
// spreadsheet and edit many rules (pricing, ETA, visaCategory) in one pass.
// Mounted at the same /api/admin/visa prefix as the other four visa
// routers (server.ts) — a fifth alongside adminVisaRouter/
// adminVisaRulesRouter/adminVisaReportsRouter/adminVisaDashboardRouter.
// FULL-gated throughout, matching admin.visa.rules.ts exactly (editing
// prices is a different authority than working a case day-to-day).
//
// EXPORT — reuses ExcelJS + csvRow (utils/exportHelpers.ts), same as
// admin.visa.reports.ts. Filterable identically to GET /rules (destination,
// purpose, status, schengenOnly). XLSX gets two sheets, RULES and
// REQUIREMENTS; CSV is RULES only — a CSV round-trip has no way to carry
// requirement groups, and silently dropping them on a CSV export would be
// worse than not offering CSV at all (task brief §1). The frontend says so
// next to the CSV option; nothing here pretends otherwise either.
//
// IMPORT — update on a matched Rule Id, create on a blank one, never publish:
//   - A non-blank Rule Id matches on that id alone. A row whose id doesn't
//     resolve to a real VisaRule is reported, never used to create one — a
//     spreadsheet typo must never become a new catalogue entry.
//   - A BLANK Rule Id (2026-08-04) creates a new DRAFT rule instead of being
//     rejected outright — ops works in Excel and the catalogue is heading
//     past 110 countries, so adding new rows the same way existing ones are
//     edited is the right workflow, with validation instead of a ban. Only
//     Destination (name/ISO2/ISO3, via countryCodes.ts) and Purpose are
//     required; Entry Type/Service Tier default to UNSPECIFIED/STANDARD
//     when blank (scripts/extract-visa-checklists.ts's own defaults).
//     visaCategory/ETA/cost are NOT required at create — those are
//     publish-time requirements (POST /rules/:id/publish), same as every
//     other DRAFT-creating path in this codebase. A row whose natural key
//     (destination/purpose/entryType/serviceTier) already exists as a real
//     rule is rejected, not silently turned into an update — see
//     resolveCreateRuleRow/processImport's own comments. Every created rule
//     is seedSource-stamped (scripts/purge-visa-seed.ts's marker) so it's
//     distinguishable and purgeable, and starts with NO document checklist
//     (a REQUIREMENTS row can never reference an id that doesn't exist yet)
//     — reported explicitly per created rule, not discovered by a customer
//     later.
//   - status is never read from the file at all, for either an update OR a
//     create row (see RULES_CONTEXT_FIELDS in the shared module) —
//     publishing stays POST /rules/:id/publish's job, and every created row
//     is hardcoded to DRAFT regardless of anything in the file.
//     assertNeverSetsPublishedStatus() below backs that with a structural,
//     self-scanning guard (same convention scripts/
//     import-visa-checklist-rules.ts's assertNeverPublishesLiteral() and
//     migrations/2026-08-02-merge-visa-price-list.ts's
//     assertNeverSetsCategory() already use), not just this comment.
//   - Editable: visaCategory, ETA fields, fee components, priceNote,
//     opsNotes, and documentGroups (the REQUIREMENTS sheet) — reusing
//     routes/admin.visa.rules.ts's own diffFields/writeRuleAudit so the
//     SAME comparison and audit-write logic backs both surfaces, not two
//     copies that could drift. NOT reusing that file's EDITABLE_FIELDS/
//     validateRuleFields, though — those cover a different field set
//     (documentRequirements, not documentGroups; opsNotes is explicitly
//     NOT in that file's EDITABLE_FIELDS) with different rules
//     (requireIdentity, a mandatory effectiveFrom for a revenue-term
//     change). This surface's own field list and validation are
//     deliberately independent — see admin.visa.rules.importExportShared.ts.
//   - effectiveFrom is untouched — the task brief's own RULES-sheet column
//     list never mentions it, and these are largely un-published DRAFT
//     rows with no live term yet to date an edit against. A future ask to
//     make bulk pricing edits carry a deliberate effective date (matching
//     PATCH /rules/:id and POST /rules/bulk's own requirement) would need
//     its own column and its own decision — flagged, not silently assumed.
//   - PREVIEW BEFORE WRITING: POST .../import/preview computes the full
//     field-by-field diff without writing anything; POST .../import/commit
//     re-parses the SAME re-uploaded file and re-resolves against LIVE
//     data (never trusting the client's cached preview) — same two-step
//     discipline routes/workspace.travellers.ts's own bulk/preview +
//     bulk/commit pair already established for this codebase.
//   - Reports gaps in every direction the task brief asks for: rows
//     matching nothing, columns this doesn't recognise, and (uniquely to
//     the requirements sheet) a row whose rule id doesn't exist at all —
//     see orphanedRequirementRows below and this file's own tests.
//
// AUDIT — one VisaRuleAudit entry per rule that actually changed, action
// "IMPORT" (VisaRuleAudit.ts's own enum addition) so a reviewer can tell a
// spreadsheet-driven change from a hand-edit in the console.
import { Router } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import multer from "multer";
import ExcelJS from "exceljs";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import VisaRule, { VISA_PURPOSES, type VisaPurpose } from "../models/VisaRule.js";
import { diffFields, writeRuleAudit } from "./admin.visa.rules.js";
import { csvRow } from "../utils/exportHelpers.js";
import { parseCsvWithHeader } from "../utils/simpleCsv.js";
import {
  RULES_COLUMNS,
  REQUIREMENTS_COLUMNS,
  RULES_HEADER_FIELD_MAP,
  REQUIREMENTS_HEADER_FIELD_MAP,
  serializeRuleRow,
  serializeRequirementRow,
  resolveRuleRow,
  resolveCreateRuleRow,
  resolveRequirementRow,
  mapSheetRow,
  cellToString,
  type ResolvedRuleEdit,
  type ResolvedRuleCreate,
  type ResolvedRequirementGroup,
} from "./admin.visa.rules.importExportShared.js";

const router = Router();
router.use(requireAuth);

/* ─────────────────────────────────────────────────────────────────────
 * Structural guard, run ONCE at module load (this is a long-running
 * server process, not a per-invocation CLI script — computing this on
 * every request would be pure waste). Reads this file's own source and
 * refuses to even START the process if it finds an actual object-property
 * or assignment writing the PUBLISHED status literal onto `status`.
 * Shape-restricted, not a blind substring check, and deliberately never
 * spelled out in assignment shape anywhere in this file's own prose —
 * same convention as this codebase's other "never X" guards.
 * ───────────────────────────────────────────────────────────────────── */
const FORBIDDEN_STATUS_WRITE = /(?:status\s*:|\.status\s*=)\s*["']PUBLISHED["']/;

function assertNeverSetsPublishedStatus(): void {
  const selfPath = fileURLToPath(import.meta.url);
  const source = readFileSync(selfPath, "utf8");
  const match = source.match(FORBIDDEN_STATUS_WRITE);
  if (match) {
    throw new Error(
      `admin.visa.rules.importExport.ts must never write a PUBLISHED status, but its own source contains ` +
        `a status-literal assignment ("${match[0]}"). This import must never publish a rule.`,
    );
  }
}
assertNeverSetsPublishedStatus();

function actorId(req: any): any {
  return req.user?._id ?? req.user?.id ?? req.user?.sub;
}

function isIso2(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z]{2}$/.test(v.trim());
}

// The full field set this surface compares/writes — reused for both the
// diff (preview + audit) and the actual $set/save. documentGroups is
// appended only when a REQUIREMENTS sheet was present in the uploaded
// file at all (see processImport below).
const IMPORT_EXPORT_FIELDS = [
  "visaCategory",
  "etaMinDays",
  "etaMaxDays",
  "etaBasis",
  "embassyFeeInr",
  "vfsFeeInr",
  "plumtripsServiceFeeInr",
  "indicativeVisaCostInr",
  "priceNote",
  "opsNotes",
  "documentGroups",
] as const;

/* ─────────────────────────────────────────────────────────────────────
 * CREATE path constants (2026-08-04) — a blank-Rule-Id row.
 * ───────────────────────────────────────────────────────────────────── */
// nationality is low-cardinality today, always "IN" (VisaRule.ts's own
// natural-key comment) — there is no Nationality column on the RULES sheet
// at all, so every created rule gets this fixed value, same as it would if
// created by hand through the ordinary admin form.
const CREATE_NATIONALITY = "IN";
// variantKey isn't read from the sheet for a create either (no column, and
// not asked for) — every created rule gets the schema's own default by
// simply never setting the field, same as ordinary admin-form creates.
const CREATE_VARIANT_KEY = "DEFAULT";
// productClass is schema-required with no column on the RULES sheet at all
// — defaulted the same way scripts/extract-visa-checklists.ts defaults it
// for its own downstream create path.
const CREATE_PRODUCT_CLASS = "VISA";
// scripts/purge-visa-seed.ts's own marker convention (`<source>@<year-month>`)
// — matches SEED_SOURCE in scripts/import-visa-checklist-rules.ts and
// scripts/seed-visa-rules.ts, but its own distinct value so a reviewer (or
// that purge script's own report) can tell "created via the spreadsheet
// rules-import" apart from "created via the checklist-PDF import."
const CREATE_SEED_SOURCE = "visa-rules-spreadsheet-import@2026-08";
// Audited on create — the identity fields a create actually sets, plus the
// same editable set IMPORT_EXPORT_FIELDS already covers (NOT admin.visa.
// rules.ts's own AUDITABLE_FIELDS — that list excludes opsNotes/
// documentGroups, which this surface DOES carry; see that file's own
// comment on why its field set is deliberately independent).
const CREATE_AUDIT_FIELDS = [
  "nationality", "destinationIso2", "destinationName", "purpose", "entryType", "serviceTier",
  "productClass", "status",
  ...IMPORT_EXPORT_FIELDS,
] as const;

function ruleNaturalKey(destinationIso2: string, purpose: string, entryType: string, serviceTier: string): string {
  return [CREATE_NATIONALITY, destinationIso2, purpose, entryType, serviceTier, CREATE_VARIANT_KEY].join("|");
}

/* ═════════════════════════════════════════════════════════════════════
 * EXPORT
 * ═════════════════════════════════════════════════════════════════════ */
router.get("/rules/export", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";

    const filter: any = {};
    if (req.query.destination != null) {
      const destination = String(req.query.destination).trim().toUpperCase();
      if (!isIso2(destination)) return res.status(400).json({ error: "destination must be a 2-letter ISO country code" });
      filter.destinationIso2 = destination;
    }
    if (req.query.purpose != null) {
      const purpose = String(req.query.purpose).trim().toUpperCase();
      if (!VISA_PURPOSES.includes(purpose as VisaPurpose)) {
        return res.status(400).json({ error: `purpose must be one of ${VISA_PURPOSES.join(", ")}` });
      }
      filter.purpose = purpose;
    }
    if (req.query.status != null) {
      const status = String(req.query.status).trim().toUpperCase();
      if (!["DRAFT", "PUBLISHED", "RETIRED"].includes(status)) {
        return res.status(400).json({ error: "status must be one of DRAFT, PUBLISHED, RETIRED" });
      }
      filter.status = status;
    }
    if (String(req.query.schengenOnly).toLowerCase() === "true") {
      filter.isSchengen = true;
    }

    const rules = await VisaRule.find(filter)
      .sort({ destinationIso2: 1, purpose: 1, entryType: 1, serviceTier: 1, variantKey: 1 })
      .lean();

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="visa-rules.csv"');
      res.write(csvRow(RULES_COLUMNS as unknown as string[]));
      for (const r of rules) res.write(csvRow(serializeRuleRow(r)));
      res.end();
      return;
    }

    const workbook = new ExcelJS.Workbook();

    const rulesSheet = workbook.addWorksheet("RULES");
    rulesSheet.views = [{ state: "frozen", ySplit: 1 }];
    const rulesHeaderRow = rulesSheet.addRow(RULES_COLUMNS as unknown as string[]);
    rulesHeaderRow.font = { bold: true };
    rulesHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };
    for (const r of rules) rulesSheet.addRow(serializeRuleRow(r));

    const reqSheet = workbook.addWorksheet("REQUIREMENTS");
    reqSheet.views = [{ state: "frozen", ySplit: 1 }];
    const reqHeaderRow = reqSheet.addRow(REQUIREMENTS_COLUMNS as unknown as string[]);
    reqHeaderRow.font = { bold: true };
    reqHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };
    for (const r of rules) {
      for (const g of (r as any).documentGroups || []) {
        reqSheet.addRow(serializeRequirementRow(String(r._id), g));
      }
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="visa-rules.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    console.error("[admin visa rules export GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to export visa rules" });
  }
});

/* ═════════════════════════════════════════════════════════════════════
 * IMPORT — shared file reading + processing, used by both preview/commit.
 * ═════════════════════════════════════════════════════════════════════ */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const MAX_IMPORT_ROWS = 5000;

function readWorksheetRows(sheet: any): Record<string, string>[] {
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell: any, colNumber: number) => {
    headers[colNumber - 1] = cellToString(cell.value);
  });

  const rows: Record<string, string>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0) continue;
    const obj: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((h, idx) => {
      if (!h) return;
      const v = cellToString(row.getCell(idx + 1).value);
      if (v !== "") hasValue = true;
      obj[h] = v;
    });
    if (hasValue) rows.push(obj);
  }
  return rows;
}

interface ReadFileResult {
  ruleRows: Record<string, string>[];
  // null = no REQUIREMENTS sheet present at all (CSV always; an XLSX
  // missing that sheet) — documentGroups must never be touched in that
  // case. An empty array (sheet present, zero rows) is a REAL, different
  // signal — see processImport's own handling.
  requirementRows: Record<string, string>[] | null;
}

async function readUploadedFile(file: any): Promise<ReadFileResult> {
  const name = String(file?.originalname || "").toLowerCase();
  const looksCsv = name.endsWith(".csv") || file?.mimetype === "text/csv";

  if (looksCsv) {
    const rows = parseCsvWithHeader(file.buffer.toString("utf8"));
    return { ruleRows: rows, requirementRows: null };
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);

  const rulesSheet =
    workbook.worksheets.find((s: any) => s.name.trim().toUpperCase() === "RULES") || workbook.worksheets[0];
  const ruleRows = rulesSheet ? readWorksheetRows(rulesSheet) : [];

  const reqSheet = workbook.worksheets.find((s: any) => s.name.trim().toUpperCase() === "REQUIREMENTS");
  const requirementRows = reqSheet ? readWorksheetRows(reqSheet) : null;

  return { ruleRows, requirementRows };
}

interface RuleChangeEntry {
  ruleId: string;
  destinationName: string;
  purpose: string;
  entryType: string;
  serviceTier: string;
  variantKey: string;
  status: string;
  changes: { field: string; from: unknown; to: unknown }[];
}

// One entry per row that created a new rule. ruleId is only present after
// an actual commit — a dry-run preview creates nothing, so there is no id
// yet to report. hasChecklist is always false: a REQUIREMENTS row can never
// reference an id that doesn't exist at upload time, so a newly created
// rule can never arrive with document requirements already attached — see
// this file's own header comment. Surfaced explicitly here (task brief:
// "visible now rather than discovered by a customer later"), not left
// implicit.
interface RuleCreateEntry {
  destinationIso2: string;
  destinationName: string;
  purpose: string;
  entryType: string;
  serviceTier: string;
  hasChecklist: false;
  ruleId?: string;
}

interface ImportProcessResult {
  totalRuleRowsInFile: number;
  matchedCount: number;
  changedCount: number;
  unchangedCount: number;
  ruleChanges: RuleChangeEntry[];
  createdCount: number;
  ruleCreates: RuleCreateEntry[];
  invalidRuleRows: { rowNumber: number; ruleId: string; reason: string }[];
  unmatchedRuleRows: { rowNumber: number; ruleId: string }[];
  duplicateRuleRows: { ruleId: string; rowNumbers: number[] }[];
  hasRequirementsSheet: boolean;
  invalidRequirementRows: { rowNumber: number; reason: string }[];
  orphanedRequirementRows: { rowNumber: number; ruleId: string; reason: string }[];
  unrecognizedRuleColumns: string[];
  unrecognizedRequirementColumns: string[];
}

async function processImport(
  ruleRows: Record<string, string>[],
  requirementRows: Record<string, string>[] | null,
  dryRun: boolean,
  performedByUserId: any,
): Promise<ImportProcessResult> {
  const result: ImportProcessResult = {
    totalRuleRowsInFile: ruleRows.length,
    matchedCount: 0,
    changedCount: 0,
    unchangedCount: 0,
    ruleChanges: [],
    createdCount: 0,
    ruleCreates: [],
    invalidRuleRows: [],
    unmatchedRuleRows: [],
    duplicateRuleRows: [],
    hasRequirementsSheet: requirementRows !== null,
    invalidRequirementRows: [],
    orphanedRequirementRows: [],
    unrecognizedRuleColumns: [],
    unrecognizedRequirementColumns: [],
  };

  // ── Pass 1 — resolve every RULES row (structural validation only; no DB
  // yet). A blank Rule Id is a CREATE candidate, resolved via
  // resolveCreateRuleRow (its own, smaller validation surface — see that
  // function's header); a non-blank one is an UPDATE candidate, resolved
  // via resolveRuleRow exactly as before this row ever existed. ──
  const unrecognizedRuleColSet = new Set<string>();
  const resolvedRuleEdits: { rowNumber: number; edit: ResolvedRuleEdit }[] = [];
  const resolvedRuleCreates: { rowNumber: number; create: ResolvedRuleCreate }[] = [];

  ruleRows.forEach((raw, i) => {
    const rowNumber = i + 2; // header is row 1
    const { mapped, unrecognized } = mapSheetRow(raw, RULES_HEADER_FIELD_MAP);
    unrecognized.forEach((u) => unrecognizedRuleColSet.add(u));

    const ruleIdRaw = (mapped.ruleId || "").trim();
    if (!ruleIdRaw) {
      const built = resolveCreateRuleRow(mapped, rowNumber);
      if (built.ok === false) {
        result.invalidRuleRows.push({ rowNumber, ruleId: "", reason: built.reason });
        return;
      }
      resolvedRuleCreates.push({ rowNumber, create: built.create });
      return;
    }

    const built = resolveRuleRow(mapped, rowNumber);
    if (built.ok === false) {
      result.invalidRuleRows.push({ rowNumber, ruleId: ruleIdRaw, reason: built.reason });
      return;
    }
    resolvedRuleEdits.push({ rowNumber, edit: built.edit });
  });
  result.unrecognizedRuleColumns = [...unrecognizedRuleColSet];

  // ── Pass 2 — two RULES rows resolving to the IDENTICAL rule id would
  // otherwise have the second silently overwrite the first mid-run. Skip
  // and report ALL of them instead — never guess which one "wins" (same
  // posture as scripts/import-visa-checklist-rules.ts's own collision
  // handling). ──
  const byRuleId = new Map<string, { rowNumber: number; edit: ResolvedRuleEdit }[]>();
  for (const e of resolvedRuleEdits) {
    const list = byRuleId.get(e.edit.ruleId) || [];
    list.push(e);
    byRuleId.set(e.edit.ruleId, list);
  }
  const uniqueRuleEdits: { rowNumber: number; edit: ResolvedRuleEdit }[] = [];
  for (const list of byRuleId.values()) {
    if (list.length === 1) {
      uniqueRuleEdits.push(list[0]);
      continue;
    }
    result.duplicateRuleRows.push({ ruleId: list[0].edit.ruleId, rowNumbers: list.map((e) => e.rowNumber) });
  }

  // ── Pass 2b — same collision problem as Pass 2, but for CREATE rows:
  // two blank-Rule-Id rows resolving to the same destination/purpose/
  // entryType/serviceTier can't both create — the second would just hit
  // the DB's own unique index (VisaRule.ts's 6-field compound index).
  // Reject ALL of them here, before any write is attempted, rather than
  // let the second fail with a raw duplicate-key error on commit. ──
  const createsByKey = new Map<string, { rowNumber: number; create: ResolvedRuleCreate }[]>();
  for (const c of resolvedRuleCreates) {
    const key = ruleNaturalKey(c.create.destinationIso2, c.create.purpose, c.create.entryType, c.create.serviceTier);
    const list = createsByKey.get(key) || [];
    list.push(c);
    createsByKey.set(key, list);
  }
  const uniqueRuleCreates: { rowNumber: number; create: ResolvedRuleCreate }[] = [];
  for (const list of createsByKey.values()) {
    if (list.length === 1) {
      uniqueRuleCreates.push(list[0]);
      continue;
    }
    for (const c of list) {
      result.invalidRuleRows.push({
        rowNumber: c.rowNumber,
        ruleId: "",
        reason:
          `rows ${list.map((x) => x.rowNumber).join(", ")} all create the same destination/purpose/entry type/` +
          `service tier — fix the duplicate and re-upload`,
      });
    }
  }

  // ── Pass 2c — reject a create whose natural key already exists as a real
  // rule: that's an update the ops team got wrong (forgot to fill in the
  // Rule Id), not a genuine new corridor — never silently create a
  // duplicate, and never silently treat it as an edit of the existing rule
  // either (a create row carries none of that rule's current values, so
  // "helpfully" applying it as an edit would blow away whatever's there).
  // Named after the existing rule's own Rule Id, so ops can just paste that
  // in and re-upload as an update instead. Batched into one query, same
  // convention as Pass 4's own batch-fetch below. ──
  const collisionFilters = uniqueRuleCreates.map(({ create }) => ({
    nationality: CREATE_NATIONALITY,
    destinationIso2: create.destinationIso2,
    purpose: create.purpose,
    entryType: create.entryType,
    serviceTier: create.serviceTier,
    variantKey: CREATE_VARIANT_KEY,
  }));
  const collidingRules = collisionFilters.length ? await VisaRule.find({ $or: collisionFilters }).lean() : [];
  const collidingByKey = new Map(
    collidingRules.map((r: any) => [ruleNaturalKey(r.destinationIso2, r.purpose, r.entryType, r.serviceTier), r]),
  );

  const finalRuleCreates: { rowNumber: number; create: ResolvedRuleCreate }[] = [];
  for (const c of uniqueRuleCreates) {
    const key = ruleNaturalKey(c.create.destinationIso2, c.create.purpose, c.create.entryType, c.create.serviceTier);
    const existing = collidingByKey.get(key);
    if (existing) {
      result.invalidRuleRows.push({
        rowNumber: c.rowNumber,
        ruleId: "",
        reason:
          `a rule already exists for this destination/purpose/entry type/service tier (Rule Id ${existing._id}) ` +
          `— that's an update, not a create; fill in its Rule Id and re-upload instead`,
      });
      continue;
    }
    finalRuleCreates.push(c);
  }

  // ── Pass 3 — resolve every REQUIREMENTS row, grouped by rule id, only
  // if that sheet was present in the file at all. ──
  const requirementsByRuleId = new Map<string, { rowNumber: number; group: ResolvedRequirementGroup }[]>();
  if (requirementRows !== null) {
    const unrecognizedReqColSet = new Set<string>();
    requirementRows.forEach((raw, i) => {
      const rowNumber = i + 2;
      const { mapped, unrecognized } = mapSheetRow(raw, REQUIREMENTS_HEADER_FIELD_MAP);
      unrecognized.forEach((u) => unrecognizedReqColSet.add(u));

      const built = resolveRequirementRow(mapped, rowNumber);
      if (built.ok === false) {
        result.invalidRequirementRows.push({ rowNumber, reason: built.reason });
        return;
      }
      const list = requirementsByRuleId.get(built.ruleId) || [];
      list.push({ rowNumber, group: built.group });
      requirementsByRuleId.set(built.ruleId, list);
    });
    result.unrecognizedRequirementColumns = [...unrecognizedReqColSet];
  }

  // ── Pass 4 — batch-fetch every referenced rule (from either sheet) once. ──
  const idsToFetch = new Set<string>();
  for (const { edit } of uniqueRuleEdits) idsToFetch.add(edit.ruleId);
  for (const ruleId of requirementsByRuleId.keys()) idsToFetch.add(ruleId);

  const existingRules = idsToFetch.size ? await VisaRule.find({ _id: { $in: [...idsToFetch] } }) : [];
  const existingById = new Map(existingRules.map((r: any) => [String(r._id), r]));

  // A requirement row whose rule id doesn't resolve to any VisaRule at
  // all — reported, never applied, never creates anything (task brief:
  // what happens to a requirement row whose rule id doesn't exist).
  for (const [ruleId, entries] of requirementsByRuleId) {
    if (existingById.has(ruleId)) continue;
    for (const e of entries) {
      result.orphanedRequirementRows.push({ rowNumber: e.rowNumber, ruleId, reason: "No VisaRule exists with this id" });
    }
  }

  // ── Pass 5 — reconcile each RULES row against the fetched rule. ──
  const ruleIdsHandledViaRulesSheet = new Set<string>();

  for (const { rowNumber, edit } of uniqueRuleEdits) {
    ruleIdsHandledViaRulesSheet.add(edit.ruleId);
    const rule = existingById.get(edit.ruleId);
    if (!rule) {
      result.unmatchedRuleRows.push({ rowNumber, ruleId: edit.ruleId });
      continue;
    }
    result.matchedCount += 1;

    const before: Record<string, any> = {
      visaCategory: rule.visaCategory,
      etaMinDays: rule.etaMinDays,
      etaMaxDays: rule.etaMaxDays,
      etaBasis: rule.etaBasis,
      embassyFeeInr: rule.embassyFeeInr,
      vfsFeeInr: rule.vfsFeeInr,
      plumtripsServiceFeeInr: rule.plumtripsServiceFeeInr,
      indicativeVisaCostInr: rule.indicativeVisaCostInr,
      priceNote: rule.priceNote,
      opsNotes: rule.opsNotes,
      documentGroups: rule.documentGroups || [],
    };
    const after: Record<string, any> = {
      ...before,
      visaCategory: edit.visaCategory,
      etaMinDays: edit.etaMinDays,
      etaMaxDays: edit.etaMaxDays,
      etaBasis: edit.etaBasis,
      embassyFeeInr: edit.embassyFeeInr,
      vfsFeeInr: edit.vfsFeeInr,
      plumtripsServiceFeeInr: edit.plumtripsServiceFeeInr,
      indicativeVisaCostInr: edit.indicativeVisaCostInr,
      priceNote: edit.priceNote,
      opsNotes: edit.opsNotes,
    };
    // documentGroups only ever changes when the REQUIREMENTS sheet is
    // present in THIS file — its absence means "not part of this
    // import", never "clear every rule's requirements".
    if (requirementRows !== null) {
      after.documentGroups = (requirementsByRuleId.get(edit.ruleId) || []).map((e) => e.group);
    }

    const changes = diffFields(before, after, IMPORT_EXPORT_FIELDS);
    if (changes.length === 0) {
      result.unchangedCount += 1;
      continue;
    }

    result.changedCount += 1;
    result.ruleChanges.push({
      ruleId: edit.ruleId,
      destinationName: rule.destinationName,
      purpose: rule.purpose,
      entryType: rule.entryType,
      serviceTier: rule.serviceTier,
      variantKey: rule.variantKey,
      status: rule.status,
      changes,
    });

    if (!dryRun) {
      Object.assign(rule, after);
      await rule.save();
      await writeRuleAudit(rule._id, "IMPORT", changes, performedByUserId);
    }
  }

  // ── Pass 6 — a rule referenced ONLY by requirement rows (its own RULES-
  // sheet row wasn't included in this file) still gets documentGroups
  // reconciled — matched independently against live data, exactly like
  // every other row here, not gated on also appearing in the RULES sheet. ──
  if (requirementRows !== null) {
    for (const [ruleId, entries] of requirementsByRuleId) {
      if (ruleIdsHandledViaRulesSheet.has(ruleId)) continue;
      const rule = existingById.get(ruleId);
      if (!rule) continue; // already reported as orphaned above

      const before = { documentGroups: rule.documentGroups || [] };
      const after = { documentGroups: entries.map((e) => e.group) };
      const changes = diffFields(before, after, ["documentGroups"]);
      if (changes.length === 0) {
        result.unchangedCount += 1;
        continue;
      }

      result.changedCount += 1;
      result.ruleChanges.push({
        ruleId,
        destinationName: rule.destinationName,
        purpose: rule.purpose,
        entryType: rule.entryType,
        serviceTier: rule.serviceTier,
        variantKey: rule.variantKey,
        status: rule.status,
        changes,
      });

      if (!dryRun) {
        rule.documentGroups = after.documentGroups as any;
        await rule.save();
        await writeRuleAudit(rule._id, "IMPORT", changes, performedByUserId);
      }
    }
  }

  // ── Pass 7 — create every row that survived Pass 1/2b/2c. ALWAYS DRAFT,
  // regardless of anything in the file (status is never read for a create
  // row — see this file's own header), ALWAYS seedSource-stamped so it's
  // distinguishable and purgeable (scripts/purge-visa-seed.ts), and NEVER
  // published — assertNeverSetsPublishedStatus() at the top of this file
  // would refuse to even boot this module if a PUBLISHED literal ever
  // showed up in its source, so "DRAFT" here isn't just convention, it's
  // structurally the only status this code is allowed to write. No
  // documentGroups: a REQUIREMENTS row can never reference an id that
  // doesn't exist yet, so every created rule starts with an empty
  // checklist — reported via hasChecklist, not left implicit. ──
  for (const { create } of finalRuleCreates) {
    result.createdCount += 1;
    const entry: RuleCreateEntry = {
      destinationIso2: create.destinationIso2,
      destinationName: create.destinationName,
      purpose: create.purpose,
      entryType: create.entryType,
      serviceTier: create.serviceTier,
      hasChecklist: false,
    };

    if (!dryRun) {
      const rule = await VisaRule.create({
        nationality: CREATE_NATIONALITY,
        destinationIso2: create.destinationIso2,
        destinationName: create.destinationName,
        purpose: create.purpose,
        entryType: create.entryType,
        serviceTier: create.serviceTier,
        variantKey: CREATE_VARIANT_KEY,
        productClass: CREATE_PRODUCT_CLASS,
        visaCategory: create.visaCategory,
        etaMinDays: create.etaMinDays,
        etaMaxDays: create.etaMaxDays,
        etaBasis: create.etaBasis,
        embassyFeeInr: create.embassyFeeInr,
        vfsFeeInr: create.vfsFeeInr,
        plumtripsServiceFeeInr: create.plumtripsServiceFeeInr,
        indicativeVisaCostInr: create.indicativeVisaCostInr,
        priceNote: create.priceNote,
        opsNotes: create.opsNotes,
        status: "DRAFT",
        seedSource: CREATE_SEED_SOURCE,
      });
      entry.ruleId = String(rule._id);

      const after = rule.toObject();
      const changes = diffFields({}, after, CREATE_AUDIT_FIELDS);
      await writeRuleAudit(rule._id, "IMPORT", changes, performedByUserId);
    }

    result.ruleCreates.push(entry);
  }

  return result;
}

async function handleImportRequest(req: any, res: any, dryRun: boolean) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing file" });

    const { ruleRows, requirementRows } = await readUploadedFile(req.file);
    if (!ruleRows.length) return res.status(400).json({ error: "File has no data rows in the RULES sheet" });
    if (ruleRows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ error: `RULES sheet has ${ruleRows.length} rows; the limit is ${MAX_IMPORT_ROWS} per import.` });
    }
    if (requirementRows && requirementRows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ error: `REQUIREMENTS sheet has ${requirementRows.length} rows; the limit is ${MAX_IMPORT_ROWS} per import.` });
    }

    const result = await processImport(ruleRows, requirementRows, dryRun, actorId(req));
    res.json({ ok: true, dryRun, ...result });
  } catch (err: any) {
    console.error(`[admin visa rules import ${dryRun ? "preview" : "commit"}]`, err?.message);
    res.status(500).json({ error: err?.message || "Failed to process visa rules import" });
  }
}

router.post(
  "/rules/import/preview",
  requirePermission("visaApplication", "FULL"),
  upload.single("file"),
  async (req: any, res: any) => handleImportRequest(req, res, true),
);

router.post(
  "/rules/import/commit",
  requirePermission("visaApplication", "FULL"),
  upload.single("file"),
  async (req: any, res: any) => handleImportRequest(req, res, false),
);

export default router;
