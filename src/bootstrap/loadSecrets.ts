// apps/backend/src/bootstrap/loadSecrets.ts
//
// Startup secrets-bundle parser.
//
// To stay under App Runner's 50 env-var cap, several secrets are consolidated
// into ONE AWS Secrets Manager secret, injected as a SINGLE env var named
// APP_SECRETS holding JSON:
//   { "SMTP_PASS": "...", "SMTP_USER": "...", "GOOGLE_PLACES_API_KEY": "...", "PIXABAY_API_KEY": "..." }
//
// This module back-fills process.env from that bundle so the existing
// `process.env.SMTP_PASS` / `SMTP_USER` / `GOOGLE_PLACES_API_KEY` /
// `PIXABAY_API_KEY` reads elsewhere keep working once the individual plaintext
// vars are removed from App Runner.
//
// IMPORTANT — execution order: this MUST run before config/env.ts (or anything)
// reads those keys. It is imported as the FIRST line of server.ts (the entry
// point). It loads .env first (so individual vars take precedence) and only
// back-fills keys that are not already set — the individual env var always wins,
// which keeps local dev working unchanged.

import dotenv from "dotenv";

// Load .env FIRST so individual vars populate process.env before the back-fill.
// dotenv never overrides already-set keys, and config/env.ts calling
// dotenv.config() again later is a harmless no-op.
dotenv.config();

try {
  const raw = process.env.APP_SECRETS;
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    let filled = 0;
    for (const [key, value] of Object.entries(parsed)) {
      // Individual env var (if already present) wins — keeps local dev working.
      if (process.env[key] === undefined && value != null) {
        process.env[key] = String(value);
        filled++;
      }
    }
    console.log(
      `[loadSecrets] APP_SECRETS parsed; back-filled ${filled} key(s) (${Object.keys(parsed).length} present in bundle).`
    );
  } else {
    console.log(
      "[loadSecrets] APP_SECRETS not set — relying on individual env vars (expected for local dev)."
    );
  }
} catch (err) {
  // Missing/malformed bundle must NOT crash boot — local dev still works via
  // individual .env vars.
  console.warn(
    `[loadSecrets] Failed to parse APP_SECRETS; continuing with individual env vars. ${
      err instanceof Error ? err.message : String(err)
    }`
  );
}
