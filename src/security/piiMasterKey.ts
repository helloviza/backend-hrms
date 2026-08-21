// apps/backend/src/security/piiMasterKey.ts
//
// The ONE master key. It never encrypts a field — it only wraps and
// unwraps the per-subject data keys in security/subjectKeys.ts. That
// indirection is the whole point of the design: rotating this key means
// re-wrapping N small DEK rows, not re-encrypting every passport number in
// the database, and destroying a subject means destroying their DEK while
// this key stays exactly where it is.
//
// ── HOW THE SECRET GETS IN (production) ───────────────────────────────
// Identical threading to every other bundled secret — see
// bootstrap/loadSecrets.ts's header for the full story:
//
//   1. Add `PII_MASTER_KEY` (base64 of 32 random bytes) as a key inside the
//      AWS Secrets Manager secret `plumtrips/backend/secrets`.
//   2. App Runner injects that whole secret as the SINGLE env var
//      APP_SECRETS (this is what keeps us under App Runner's 50-var cap —
//      no new App Runner configuration is needed, and no new env var
//      appears in the service config).
//   3. bootstrap/loadSecrets.ts parses APP_SECRETS at startup and back-fills
//      process.env.PII_MASTER_KEY from it — and because config/env.ts
//      imports loadSecrets.ts as its own first line, standalone scripts
//      under src/scripts/* get the same unpack for free, with no per-script
//      wiring. That matters here specifically: the erasure scripts must be
//      able to reach the master key, and they never boot through server.ts.
//   4. An individual `PII_MASTER_KEY` env var, if one is ever set, WINS over
//      the bundle (loadSecrets only back-fills keys that are unset) — which
//      is how a break-glass or a migration run can pin a specific key.
//
// Read LIVE off process.env on every call rather than captured into
// config/env.ts's frozen object, following config/visaScreening.ts's
// precedent: it keeps each test able to pin the exact key state it needs
// (missing / wrong / correct) without module-cache surgery.
//
// ── AND IN LOCAL DEV (the documented behaviour) ───────────────────────
// The secret is NOT present locally. Three options were on the table:
//
//   (a) throw always — correct but unusable: every developer, every test,
//       and every `tsx src/scripts/*.ts` run would have to source a key
//       before touching an encrypted collection at all.
//   (b) a RANDOM per-process dev key — the worst option, and worth naming
//       so nobody proposes it later: data written on one `pnpm dev` boot
//       silently stops decrypting on the next, which reads to a developer
//       as database corruption rather than as a missing secret.
//   (c) a DETERMINISTIC dev key, derived from a fixed literal in this file,
//       used ONLY when NODE_ENV is not "production", announced with a loud
//       one-time warning, and never reachable from a production process.
//
// (c) is what this does. The key is derived, not written out as a base64
// constant, purely so it cannot be copy-pasted into a real environment and
// mistaken for a provisioned secret; it has no secrecy value and is not
// meant to. In PRODUCTION an absent or malformed PII_MASTER_KEY THROWS —
// see resolveMasterKey().
//
// The throw is at FIRST USE, not at boot. A boot-time assertion would take
// down the whole service (every route, including the ones that touch no PII
// at all) over a secret that only the encrypted collections need — this
// codebase has already had one boot-crash outage of exactly that shape.
// First-use failure keeps the blast radius to the reads and writes that
// genuinely cannot proceed without the key.
import crypto from "node:crypto";
import { KEY_BYTES } from "./fieldCrypto.js";

export class PiiMasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiiMasterKeyError";
  }
}

export type MasterKeySource = "secret" | "dev-fallback";

export interface ResolvedMasterKey {
  key: Buffer;
  source: MasterKeySource;
}

/**
 * The dev-fallback derivation. A fixed, PUBLIC salt and label — this is
 * documented-in-source by design (see the header): its purpose is
 * determinism across restarts on a developer's machine, not secrecy.
 */
const DEV_FALLBACK_LABEL = "plumtrips.pii.master-key.local-development-only";
const DEV_FALLBACK_SALT = "plumtrips.pii.dev.salt.v1";

let devFallbackWarned = false;

function deriveDevFallbackKey(): Buffer {
  // scryptSync, not a bare sha256, only so that the derivation is visibly a
  // KDF and nobody later mistakes the output for "just a hash of a string
  // we could also compute elsewhere".
  return crypto.scryptSync(DEV_FALLBACK_LABEL, DEV_FALLBACK_SALT, KEY_BYTES);
}

/**
 * Resolve the master key for this process.
 *
 * @throws PiiMasterKeyError in production when PII_MASTER_KEY is absent, or
 *         in ANY environment when it is present but not a base64-encoded
 *         32-byte value. A malformed key is always an error, never a
 *         reason to quietly fall back to the dev key — falling back there
 *         would mean a production-shaped misconfiguration produces
 *         plausible-looking ciphertext that no real key can ever read.
 */
export function resolveMasterKey(): ResolvedMasterKey {
  const raw = (process.env.PII_MASTER_KEY || "").trim();

  if (raw) {
    let key: Buffer;
    try {
      key = Buffer.from(raw, "base64");
    } catch {
      throw new PiiMasterKeyError("PII_MASTER_KEY is not valid base64.");
    }
    if (key.length !== KEY_BYTES) {
      throw new PiiMasterKeyError(
        `PII_MASTER_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
          `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    return { key, source: "secret" };
  }

  if (process.env.NODE_ENV === "production") {
    throw new PiiMasterKeyError(
      "PII_MASTER_KEY is not set. In production this key is mandatory — add it to the " +
        "plumtrips/backend/secrets bundle (APP_SECRETS). Encrypted fields cannot be read or written without it.",
    );
  }

  if (!devFallbackWarned) {
    devFallbackWarned = true;
    console.warn(
      [
        "",
        "!".repeat(78),
        "!!  PII_MASTER_KEY is not set — using the DETERMINISTIC LOCAL DEV KEY.",
        "!!  Every encrypted field written by this process is readable by anyone",
        "!!  with a checkout of this repository. Never point a process using this",
        "!!  key at production data.",
        "!".repeat(78),
        "",
      ].join("\n"),
    );
  }

  return { key: deriveDevFallbackKey(), source: "dev-fallback" };
}

/**
 * Test-only reset for the once-per-process warning latch. Exported rather
 * than reached at via module internals so a test asserting the warning does
 * not depend on test file ordering.
 */
export function resetMasterKeyWarningForTests(): void {
  devFallbackWarned = false;
}
