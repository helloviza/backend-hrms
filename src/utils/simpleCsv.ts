// apps/backend/src/utils/simpleCsv.ts
//
// A small, dependency-free RFC 4180-ish CSV reader — no library dependency
// exists in this repo yet, and the one caller (migrations/
// 2026-08-02-merge-visa-price-list.ts) needs only "parse a small, known,
// human-edited spreadsheet export", not a general-purpose CSV toolkit.
// Handles quoted fields (so a priceNote containing a comma or a literal
// quote survives), doubled-quote escaping (""), and both CRLF and LF line
// endings. Does NOT support alternate delimiters — every caller here is a
// plain comma-separated export.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  // A final row with no trailing newline still needs to be flushed.
  if (field.length > 0 || row.length > 0) pushRow();

  // A trailing newline produces one wholly-empty row at the end — drop it,
  // it's a file-formatting artefact, not a data row.
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Parses a CSV whose first row is a header, into one plain object per data
 * row, keyed by the header cell LOWERCASED and trimmed (so callers can
 * write `row["etamindays"]` regardless of how the source file capitalised
 * "etaMinDays"). Fully-blank rows (every cell empty after trimming) are
 * skipped — a common artefact of spreadsheet exports.
 */
export function parseCsvWithHeader(text: string): Record<string, string>[] {
  const table = parseCsv(text);
  if (table.length === 0) return [];

  const header = table[0].map((h) => h.trim().toLowerCase());
  return table
    .slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => {
        obj[h] = (r[i] ?? "").trim();
      });
      return obj;
    });
}
