// apps/backend/src/security/cstepSmtpKey.ts
//
// The key that encrypts a CSTEP workspace's SMTP password at rest
// (CstepNotificationSettings.smtpPassEnc, via security/fieldCrypto.ts). Its
// own key, not PII_MASTER_KEY: that one only ever wraps per-subject data keys
// (see piiMasterKey.ts's header), and a mail credential is not PII.
//
// Threaded exactly like PII_MASTER_KEY:
//   - production: `CSTEP_SMTP_KEY` (base64 of 32 random bytes) inside the
//     `plumtrips/backend/secrets` bundle; bootstrap/loadSecrets.ts back-fills
//     process.env from APP_SECRETS. Absent or malformed THROWS — at first
//     use, never at boot — so a save cannot store a value no real key reads.
//   - anywhere else: a DETERMINISTIC dev key derived from a public literal,
//     so a password saved on one `pnpm dev` boot still decrypts on the next.
//     It has no secrecy value. A malformed key that IS set always throws.
// Read live off process.env on every call, so tests can pin each state.
import crypto from "node:crypto";
import { KEY_BYTES } from "./fieldCrypto.js";

export class CstepSmtpKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CstepSmtpKeyError";
  }
}

const DEV_FALLBACK_LABEL = "plumtrips.cstep.smtp-key.local-development-only";
const DEV_FALLBACK_SALT = "plumtrips.cstep.smtp.dev.salt.v1";

let devFallbackWarned = false;

/** The AAD binding a ciphertext to its workspace's settings row. */
export function cstepSmtpAad(workspaceId: unknown): string {
  return `cstep-smtp:${String(workspaceId)}`;
}

export function resolveCstepSmtpKey(): { key: Buffer; source: "secret" | "dev-fallback" } {
  const raw = (process.env.CSTEP_SMTP_KEY || "").trim();

  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length !== KEY_BYTES) {
      throw new CstepSmtpKeyError(
        `CSTEP_SMTP_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
          `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    return { key, source: "secret" };
  }

  if (process.env.NODE_ENV === "production") {
    throw new CstepSmtpKeyError(
      "CSTEP_SMTP_KEY is not set. In production it is mandatory — add it to the " +
        "plumtrips/backend/secrets bundle (APP_SECRETS). CSTEP SMTP passwords cannot be saved or read without it.",
    );
  }

  if (!devFallbackWarned) {
    devFallbackWarned = true;
    console.warn("[cstepSmtpKey] CSTEP_SMTP_KEY is not set — using the deterministic LOCAL DEV key (not secret).");
  }
  return { key: crypto.scryptSync(DEV_FALLBACK_LABEL, DEV_FALLBACK_SALT, KEY_BYTES), source: "dev-fallback" };
}
