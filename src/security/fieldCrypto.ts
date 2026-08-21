// apps/backend/src/security/fieldCrypto.ts
//
// THE CRYPTO CORE. Pure, key-in/key-out, no database, no environment, no
// Mongoose — everything stateful lives in security/piiMasterKey.ts (the
// secret) and security/subjectKeys.ts (the per-subject data keys). This file
// is the only place in the codebase that calls node:crypto for field
// encryption, and it is deliberately small enough to read in one sitting.
//
// ── THE ENVELOPE ──────────────────────────────────────────────────────
// A ciphertext is a SELF-DESCRIBING string, never a raw buffer or a
// bag of sibling fields:
//
//     penc.1.<iv>.<authTag>.<ciphertext>
//     │    │  │    │         └ AES-256-GCM ciphertext, base64url
//     │    │  │    └ 16-byte GCM authentication tag, base64url
//     │    │  └ 12-byte random IV, base64url
//     │    └ encVersion — bumped when the ALGORITHM or the framing changes,
//     │      never for a key rotation (that's the DEK's job, see
//     │      subjectKeys.ts). A reader that meets a version it does not
//     │      know REFUSES, it does not guess.
//     └ a fixed marker, so isEncryptedEnvelope() can tell "this is our
//       ciphertext" from "this is a legacy plaintext value that happens to
//       look base64-ish". This is what makes the dual-read migration window
//       possible at all — see plugins/fieldEncryption.plugin.ts.
//
// base64url, not base64: the standard alphabet's `+` and `/` are fine but
// `=` padding plus a `.` delimiter invites the kind of split/rejoin bug that
// only shows up on one value in ten thousand. base64url is padding-free here
// (Node emits no `=`) and contains no `.`.
//
// ── RANDOMIZED, NOT DETERMINISTIC ─────────────────────────────────────
// A fresh random IV per call, so the same passport number encrypted twice
// produces two different envelopes. This is the decided design (see the
// PII audit): it costs the ability to query by an encrypted value — you
// cannot do `find({ "passports.number": "X1234567" })` any more — and buys
// the guarantee that an attacker holding the collection cannot tell which
// two consumers share a passport number, a date of birth, or an address.
//
// ── FAILS CLOSED, ALWAYS ──────────────────────────────────────────────
// Every failure path here THROWS FieldDecryptionError. There is no code
// path in this file that returns a value when decryption did not fully
// succeed — no "best effort", no partial plaintext, no returning the input
// unchanged. A wrong key, a truncated envelope, a flipped ciphertext byte
// and an unknown version all land in the same place: an exception the
// caller has to deal with.
import crypto from "node:crypto";

/** The literal that marks one of our envelopes. */
export const PII_ENVELOPE_PREFIX = "penc";

/**
 * Current envelope version. Bump ONLY for an algorithm/framing change.
 * decryptField() accepts any version it has an explicit branch for, which
 * is what makes a future migration a read-both/write-new exercise rather
 * than a flag day.
 */
export const PII_ENVELOPE_VERSION = 1;

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit, the GCM-recommended size
const AUTH_TAG_BYTES = 16;

/** AES-256 — the DEK and the master key are both exactly this long. */
export const KEY_BYTES = 32;

export class FieldDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldDecryptionError";
  }
}

export class FieldEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldEncryptionError";
  }
}

function assertKey(key: Buffer, what: string): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new FieldEncryptionError(
      `${what} must be a ${KEY_BYTES}-byte Buffer (got ${Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key}).`,
    );
  }
}

/** A fresh 32-byte data key. The only place DEKs are born. */
export function generateDataKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

/**
 * True when `value` is one of our envelopes. Deliberately CHEAP and
 * PREFIX-ONLY: this runs on every field of every read, and its job is to
 * separate "ours" from "legacy plaintext", not to validate. A malformed
 * value that starts with the marker is still ours — and decryptField() will
 * reject it loudly, which is the correct outcome. Treating a corrupt
 * envelope as legacy plaintext and handing it back to a caller is exactly
 * the silent-garbage failure this module refuses to have.
 */
export function isEncryptedEnvelope(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${PII_ENVELOPE_PREFIX}.`);
}

/**
 * Encrypt one field value.
 *
 * `aad` (additional authenticated data) is covered by the auth tag but not
 * stored in the envelope — the caller must supply the same string to
 * decrypt. plugins/fieldEncryption.plugin.ts passes the FIELD PATH, which
 * binds a ciphertext to the field it was written for: a passport number
 * copied out of `passports.$.number` and pasted into `contact.mobile` no
 * longer decrypts. The path is used rather than the subject id deliberately
 * — a path is immutable for the life of a document, whereas a subject
 * reference can legitimately be re-pointed or nulled (see
 * VisaApplication.travellerProfileId after an erasure), and binding to a
 * value that can change would turn a routine data fix into permanent
 * data loss.
 */
export function encryptField(plaintext: string, key: Buffer, aad?: string): string {
  assertKey(key, "encryption key");
  if (typeof plaintext !== "string") {
    throw new FieldEncryptionError(`encryptField expects a string plaintext (got ${typeof plaintext}).`);
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    PII_ENVELOPE_PREFIX,
    String(PII_ENVELOPE_VERSION),
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt one envelope. Throws FieldDecryptionError on ANY failure —
 * wrong key, wrong aad, unknown version, malformed framing, tampered
 * ciphertext. Never returns a value it could not authenticate.
 */
export function decryptField(envelope: string, key: Buffer, aad?: string): string {
  assertKey(key, "decryption key");
  if (!isEncryptedEnvelope(envelope)) {
    throw new FieldDecryptionError("Value is not an encrypted envelope.");
  }

  const parts = envelope.split(".");
  if (parts.length !== 5) {
    throw new FieldDecryptionError(`Malformed envelope: expected 5 segments, got ${parts.length}.`);
  }

  const [, versionRaw, ivRaw, tagRaw, ctRaw] = parts;
  const version = Number(versionRaw);
  if (version !== PII_ENVELOPE_VERSION) {
    // Refuse, never guess. When version 2 exists this becomes a switch.
    throw new FieldDecryptionError(
      `Unsupported envelope version "${versionRaw}" (this build understands ${PII_ENVELOPE_VERSION}).`,
    );
  }

  const iv = Buffer.from(ivRaw, "base64url");
  const authTag = Buffer.from(tagRaw, "base64url");
  const ciphertext = Buffer.from(ctRaw, "base64url");

  if (iv.length !== IV_BYTES) {
    throw new FieldDecryptionError(`Malformed envelope: IV is ${iv.length} bytes, expected ${IV_BYTES}.`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new FieldDecryptionError(
      `Malformed envelope: auth tag is ${authTag.length} bytes, expected ${AUTH_TAG_BYTES}.`,
    );
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    // node's GCM failure is "Unsupported state or unable to authenticate
    // data" — accurate but opaque at a call site. Re-thrown as our own type
    // so callers can distinguish "this did not decrypt" from any other
    // error without string-matching node's message.
    throw new FieldDecryptionError(
      `Authenticated decryption failed (wrong key, wrong context, or tampered ciphertext): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
