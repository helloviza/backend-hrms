/**
 * Parse a TBO date string into a JavaScript Date.
 *
 * TBO returns dates in DD-MM-YYYY HH:mm:ss format (e.g., "28-06-2026 23:59:59").
 * Native new Date() cannot parse this format — produces Invalid Date.
 *
 * Returns null if the input is null/undefined/empty/unparseable.
 * Returns a valid Date object otherwise.
 */
export function parseTBODate(input: string | null | undefined): Date | null {
  if (!input || typeof input !== "string" || !input.trim()) {
    return null;
  }

  // Match DD-MM-YYYY with optional HH:mm:ss
  const match = input
    .trim()
    .match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (!match) {
    // Fallback: try native Date as last resort (handles ISO strings if TBO ever changes format)
    const fallback = new Date(input);
    return isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, day, month, year, hour = "00", minute = "00", second = "00"] = match;

  // Construct ISO format YYYY-MM-DDTHH:mm:ss (interpreted as local time by Date constructor)
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const parsed = new Date(iso);

  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format a Date back to TBO's DD-MM-YYYY HH:mm:ss format for outbound TBO calls.
 */
export function formatTBODate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
