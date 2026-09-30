// apps/backend/src/utils/publicAppUrl.ts
import logger from "./logger.js";

/**
 * The ONE public URL of the Plumbox web app, for links that go out in emails
 * (password reset, customer invite). Moved here from routes/customerUsers.ts.
 *
 * PUBLIC_APP_URL is the dedicated single-URL setting. FRONTEND_ORIGIN is the
 * fallback, but it doubles as the CORS allow-list and is parsed as a
 * comma-separated list there (config/cors.ts) — pasted whole into a link it
 * yields "https://a,https://b/reset-password". So a list is resolved to the
 * plumbox.plumtrips.com entry, else the first entry, with a one-time warning.
 */
const PLUMBOX_HOST = "plumbox.plumtrips.com";

let warnedAboutList = false;

export function publicAppUrl(): string {
  const raw = String(process.env.PUBLIC_APP_URL || process.env.FRONTEND_ORIGIN || "http://localhost:5173").trim();

  let url = raw;
  if (raw.includes(",")) {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    url = list.find((o) => o.includes(PLUMBOX_HOST)) || list[0] || "";
    if (!warnedAboutList) {
      warnedAboutList = true;
      logger.warn("[publicAppUrl] app URL env holds a comma-separated list; using one entry for email links. Set PUBLIC_APP_URL to a single URL.", {
        chosen: url,
      });
    }
  }

  return url.replace(/\/+$/, "");
}
