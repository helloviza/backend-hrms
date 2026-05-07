// Centralised guard for TBO REST responses. TBO occasionally returns plain-text
// or HTML error bodies (e.g. "Method Not Allowed", upstream 502 pages) which
// crash res.json() with cryptic JSON-parse errors. Use this helper between
// fetch() and res.json() to convert non-2xx responses into a structured log
// line and let the caller fall back gracefully.
import logger from "./logger.js";

export async function tboFetchFailed(
  endpoint: string,
  url: string,
  res: Response,
): Promise<boolean> {
  if (res.ok) return false;
  const bodyText = await res.text().catch(() => "");
  logger.error(
    `[TBO] ${endpoint} fetch failed: HTTP ${res.status} ${res.statusText}`,
    { url, body: bodyText.slice(0, 500) },
  );
  return true;
}
