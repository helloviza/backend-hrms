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
// reads those keys. Two importers, deliberately:
//   1. config/env.ts imports this as ITS first line (2026-08-04) — this is
//      the one that matters for standalone scripts (src/scripts/*, run via
//      `tsx path/to/script.ts`, never through server.ts): anything that
//      reads a bundle-only secret via `env.X` now gets the unpack for free,
//      with no per-script import needed. Before this, only server.ts
//      triggered the unpack, so every standalone script silently saw ""
//      for a bundle-only secret (see fetch-visa-destination-images.ts,
//      first one to hit it — 2026-08-04).
//   2. server.ts ALSO imports this directly, as its own literal first
//      line — kept for the handful of places that read a secret straight
//      off `process.env` instead of through `env` (routes/places.ts,
//      utils/mailer.ts, a few others — a separate, known inconsistency).
// ES modules cache by resolved path, so importing this from both places in
// the same process runs its body exactly once, not twice.
// It loads .env first (so individual vars take precedence) and only
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
