// apps/backend/src/utils/csv.ts
//
// Minimal shared CSV parser. Supports quoted values with embedded commas,
// escaped quotes ("") inside quoted fields, and CRLF/CR line endings.
//
// Returns raw headers + an array of row records keyed by header name.
// Callers are responsible for any column-name normalization or alias mapping.

export function parseCsv(csv: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const text = String(csv || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return { headers: [], rows: [] };

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { headers: lines.length === 1 ? splitCsvLine(lines[0]).map((h) => h.trim()) : [], rows: [] };

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => (row[h] = (cols[idx] ?? "").trim()));
    rows.push(row);
  }

  return { headers, rows };
}

export function splitCsvLine(line: string): string[] {
  const s = String(line || "");
  const out: string[] = [];
  let cur = "";
  let inQ = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQ && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
