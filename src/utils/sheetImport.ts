// apps/backend/src/utils/sheetImport.ts
//
// Shared spreadsheet import/export plumbing, extracted unchanged from the
// traveller bulk import (routes/workspace.travellers.ts) so the CSTEP vendor
// import (routes/cstep.vendors.ts) and the later payment import run the same
// code rather than a copy of it.
//
// The shape every import follows:
//   template  — GET, the header row as CSV or XLSX (sendSheet)
//   preview   — POST multipart, parse (readUploadedSheet), run every row
//               with dryRun=true: NO writes, one outcome per row
//   commit    — POST the SAME file again, re-parse, re-run against live data
//               with dryRun=false — never trusts the client's cached preview
// Rows go through forEachSheetRow, which numbers them as the spreadsheet
// does (header = row 1) and maps headers through a per-import table. Every
// row ends in exactly one create / update / skip outcome, so a partial
// batch is never silent.

import multer from "multer";
import ExcelJS from "exceljs";
import { parseCsv } from "./csv.js";

export const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

export const MAX_SHEET_ROWS = 500;

export interface SheetRowOutcome {
  rowNumber: number;
  action: "create" | "update" | "skip";
  reason?: string;
}

/** "First Name", "first_name", " FIRSTNAME " → "firstname". */
export function normalizeHeader(h: string): string {
  return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Raw row (as parsed, keyed by the file's own headers) → internal field
 * names. A header the map doesn't know is dropped — the template IS the
 * contract, no fuzzy alias guessing beyond case/whitespace/punctuation. */
export function mapRowHeaders(raw: Record<string, any>, headerMap: Record<string, string>): Record<string, any> {
  const mapped: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const field = headerMap[normalizeHeader(key)];
    if (field) mapped[field] = value;
  }
  return mapped;
}

/** An ExcelJS / CSV cell value as a trimmed string ("" for empty, Date, or
 * an unrecognised object). */
export function cellToString(v: any): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return "";
  if (typeof v === "object") {
    if (Array.isArray((v as any).richText)) return (v as any).richText.map((t: any) => t.text).join("");
    if (typeof (v as any).text === "string") return (v as any).text;
    if ("result" in (v as any)) return String((v as any).result ?? "");
    return "";
  }
  return String(v).trim();
}

/** A date cell as YYYY-MM-DD: an Excel Date, or text already in that shape. */
export function normalizeDateField(raw: any, label: string): { value?: string; error?: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return { error: `Invalid ${label}` };
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, "0");
    const d = String(raw.getUTCDate()).padStart(2, "0");
    return { value: `${y}-${m}-${d}` };
  }
  const str = cellToString(raw);
  if (!str) return {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return { error: `${label} must be in YYYY-MM-DD format` };
  return { value: str };
}

export function csvEscape(v: any): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of an uploaded CSV or XLSX (first sheet), keyed by header text.
 * Fully blank XLSX rows are dropped. */
export async function parseUploadedRows(file: any): Promise<Record<string, any>[]> {
  const name = String(file?.originalname || "").toLowerCase();
  const looksCsv = name.endsWith(".csv") || file?.mimetype === "text/csv";
  if (looksCsv) {
    const { rows } = parseCsv(file.buffer.toString("utf8"));
    return rows;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell: any, colNumber: number) => {
    headers[colNumber - 1] = String(cell.value ?? "").trim();
  });

  const rows: Record<string, any>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0) continue;
    const obj: Record<string, any> = {};
    let hasValue = false;
    headers.forEach((h, idx) => {
      if (!h) return;
      const v = row.getCell(idx + 1).value;
      if (v !== null && v !== undefined && v !== "") hasValue = true;
      obj[h] = v;
    });
    if (hasValue) rows.push(obj);
  }
  return rows;
}

/** The preview/commit entry check: a file, at least one row, at most
 * `maxRows`. Returns the rows, or the 400 message to send. */
export async function readUploadedSheet(
  file: any,
  maxRows = MAX_SHEET_ROWS,
): Promise<{ rows: Record<string, any>[]; error?: undefined } | { rows?: undefined; error: string }> {
  if (!file?.buffer) return { error: "Missing file" };
  const rows = await parseUploadedRows(file);
  if (!rows.length) return { error: "File has no data rows" };
  if (rows.length > maxRows) {
    return { error: `File has ${rows.length} rows; the limit is ${maxRows} per import. Split into smaller files.` };
  }
  return { rows };
}

/** Runs `handle` once per row, in order, with the spreadsheet row number
 * (header = 1) and the row mapped through `headerMap`. */
export async function forEachSheetRow(
  rawRows: Record<string, any>[],
  headerMap: Record<string, string>,
  handle: (mapped: Record<string, any>, rowNumber: number) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < rawRows.length; i++) {
    await handle(mapRowHeaders(rawRows[i], headerMap), i + 2);
  }
}

/** Sends a header row plus data rows as CSV or a styled XLSX attachment.
 * `textColumns` (0-based) are formatted as Text in the XLSX, so a value like
 * "0001/1026" stays a string when someone edits the sheet and re-imports it
 * (Excel would otherwise read it as a date or drop the leading zeros).
 * `dateColumns` (0-based) get a dd-mm-yyyy format, for Date values written
 * as real date cells. */
export async function sendSheet(
  res: any,
  opts: {
    format: "csv" | "xlsx";
    filename: string;
    sheetName: string;
    columns: string[];
    rows?: any[][];
    width?: number;
    textColumns?: number[];
    dateColumns?: number[];
  },
): Promise<void> {
  const rows = opts.rows || [];
  if (opts.format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${opts.filename}.csv"`);
    const lines = [opts.columns.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
    res.send(lines.join("\n") + "\n");
    return;
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(opts.sheetName);
  sheet.columns = opts.columns.map((h) => ({ header: h, width: opts.width ?? 20 }));
  rows.forEach((r) => sheet.addRow(r));
  for (const idx of opts.textColumns || []) sheet.getColumn(idx + 1).numFmt = "@";
  for (const idx of opts.dateColumns || []) sheet.getColumn(idx + 1).numFmt = "dd-mm-yyyy";
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } };
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${opts.filename}.xlsx"`);
  res.send(buffer);
}
