// apps/backend/src/utils/piiMask.ts
// Shared last-4 masking for passport/PAN-shaped identifiers — used by any
// list/export view that must not hand out full numbers to every reader with
// READ access (see docs/audits/traveller-profiles-scoping.md §4.3).
export function maskTailId(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return value as any;
  const str = String(value);
  return str.length <= 4 ? "*".repeat(str.length) : "*".repeat(str.length - 4) + str.slice(-4);
}
