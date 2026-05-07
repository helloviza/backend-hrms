import { mkdir, writeFile, readdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_ROOT = path.resolve(__dirname, "../../logs/tbo");

/**
 * Log a TBO API call.
 *
 * Output destinations:
 *  1. stdout (CloudWatch on App Runner) — single JSON line with [TBO] tag and TraceId.
 *  2. Local file at logs/tbo/<traceId>/<method>_<ts>.json (preserved for local dev only;
 *     ephemeral on App Runner, do not rely on for production diagnostics).
 *
 * Stdout payload is the production source of truth. CloudWatch query pattern:
 *   `[TBO]` literal + traceId + method
 * For example: filter @message like /\[TBO\].*<traceId>/
 */
export async function logTBOCall(opts: {
  method: string;
  traceId?: string;
  clientReferenceId?: string;
  bookingId?: string | number;
  request: unknown;
  response: unknown;
  durationMs?: number;
}): Promise<void> {
  const traceId = opts.traceId || "no-trace";
  const ts = new Date().toISOString();

  // 1. Structured stdout line — one JSON object per call so CloudWatch parses cleanly.
  // Wrapped in [TBO] tag for fast text-grep when TraceId is unknown.
  try {
    const stdoutPayload = {
      tag: "[TBO]",
      method: opts.method,
      traceId,
      clientReferenceId: opts.clientReferenceId ?? null,
      bookingId: opts.bookingId ?? null,
      durationMs: opts.durationMs ?? null,
      timestamp: ts,
      request: opts.request,
      response: opts.response,
    };
    // Single line — CloudWatch breaks on newlines, JSON.stringify default is single-line.
    console.log(`[TBO] ${JSON.stringify(stdoutPayload)}`);
  } catch (stdoutErr) {
    // Fall back to a minimal marker so we at least know the call happened.
    console.log(
      `[TBO] ${opts.method} traceId=${traceId} stdout-stringify-failed=${
        (stdoutErr as Error)?.message ?? "unknown"
      }`,
    );
  }

  // 2. File logging — local dev convenience only. Never depend on this in production.
  try {
    const folder = traceId;
    const dir = path.join(LOGS_ROOT, folder);
    await mkdir(dir, { recursive: true });

    const safeName = `${opts.method}_${ts.replace(/[:.]/g, "-")}`;
    const filePath = path.join(dir, `${safeName}.json`);

    const filePayload = {
      method: opts.method,
      traceId,
      clientReferenceId: opts.clientReferenceId ?? null,
      bookingId: opts.bookingId ?? null,
      timestamp: ts,
      durationMs: opts.durationMs ?? null,
      request: opts.request,
      response: opts.response,
    };

    await writeFile(filePath, JSON.stringify(filePayload, null, 2), "utf-8");
  } catch {
    // File logging is best-effort. Stdout is the truth.
  }
}

/**
 * List all log files for a given traceId.
 * Returns an array of { method, timestamp, filename } objects sorted by time.
 */
export async function listTBOLogs(
  traceId: string,
): Promise<{ method: string; timestamp: string; filename: string }[]> {
  const dir = path.join(LOGS_ROOT, traceId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  return files
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      // Filename pattern: {Method}_{ISO-timestamp}.json
      const base = f.replace(/\.json$/, "");
      const firstUnderscore = base.indexOf("_");
      const method = firstUnderscore > 0 ? base.slice(0, firstUnderscore) : base;
      const tsRaw = firstUnderscore > 0 ? base.slice(firstUnderscore + 1) : "";
      // Restore colons/dots: 2025-03-13T10-30-00-000Z → 2025-03-13T10:30:00.000Z
      const timestamp = tsRaw
        .replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, "$1:$2:$3.$4");
      return { method, timestamp, filename: f };
    });
}

/**
 * Read a single TBO log file and return its parsed JSON contents.
 */
export async function readTBOLog(
  traceId: string,
  filename: string,
): Promise<unknown> {
  const { readFile } = await import("fs/promises");
  const filePath = path.join(LOGS_ROOT, traceId, filename);
  const data = await readFile(filePath, "utf-8");
  return JSON.parse(data);
}
