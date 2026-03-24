import { mkdir, writeFile, readdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_ROOT = path.resolve(__dirname, "../../logs/tbo");

/**
 * Persist a TBO API call (request + response) to a JSON file.
 *
 * File layout:  logs/tbo/{traceId}/{method}_{timestamp}.json
 *
 * Never throws — errors are swallowed so logging cannot crash the booking flow.
 */
export async function logTBOCall(opts: {
  method: string;
  traceId?: string;
  request: unknown;
  response: unknown;
  durationMs?: number;
}): Promise<void> {
  try {
    const folder = opts.traceId || "auth";
    const dir = path.join(LOGS_ROOT, folder);
    await mkdir(dir, { recursive: true });

    const ts = new Date().toISOString();
    // Filename-safe timestamp: 2025-03-13T10-30-00-000Z
    const safeName = `${opts.method}_${ts.replace(/[:.]/g, "-")}`;
    const filePath = path.join(dir, `${safeName}.json`);

    const payload = {
      method: opts.method,
      timestamp: ts,
      durationMs: opts.durationMs ?? null,
      request: opts.request,
      response: opts.response,
    };

    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // Silently swallow — logging must never break the main flow
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
