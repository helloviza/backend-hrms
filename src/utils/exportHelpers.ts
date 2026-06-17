// apps/backend/src/utils/exportHelpers.ts
//
// Shared tabular-export helpers. `csvRow` was previously copy-pasted into
// invoices.ts, sbt.bookingRegister.ts and adminReports.ts — lifted here so the
// expense export (and future exports) reuse one implementation.

/**
 * Render a single CSV line (with trailing newline) from an array of cell values.
 * Quotes/escapes any cell containing a comma, double-quote or newline per RFC 4180.
 */
export function csvRow(values: (string | number | undefined | null)[]): string {
  return (
    values
      .map((v) => {
        const s = v == null ? "" : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      })
      .join(",") + "\n"
  );
}
