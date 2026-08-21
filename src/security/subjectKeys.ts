// apps/backend/src/security/subjectKeys.ts
//
// THE KEY SERVICE. Turns a subject identity into a usable data key, and —
// the part that matters — takes it away again.
//
// Two-level key hierarchy, as decided in the PII audit:
//
//     PII_MASTER_KEY  (one, from AWS Secrets Manager — piiMasterKey.ts)
//            │  wraps
//            ▼
//     DEK per subject (SubjectKey.wrappedDek — models/SubjectKey.ts)
//            │  encrypts
//            ▼
//     the fields themselves (plugins/fieldEncryption.plugin.ts)
//
// Erasing a subject destroys ONE row. Rotating the master key re-wraps N
// small rows. Neither ever rewrites a passport number.
//
// ── THE THREE OUTCOMES OF A LOOKUP ────────────────────────────────────
// getSubjectDek() answers with a discriminated status, never with
// null-means-several-things:
//
//   active    — here is the key.
//   destroyed — this subject was crypto-shredded. Their ciphertext is gone
//               for good. This is a NORMAL, EXPECTED state and the caller
//               is expected to handle it (the plugin nulls the field and
//               reports it), not an error.
//   missing   — no key row exists. On a read this means the document's
//               values must be legacy plaintext; on a write it means mint
//               one.
//
// A FOURTH outcome — the master key is wrong, absent in production, or the
// wrapped DEK will not unwrap — is not a status. It THROWS. The distinction
// is deliberate and is the single most important rule in this file: a
// destroyed key is data that no longer exists, whereas an unusable master
// key is a misconfiguration, and quietly treating the second as the first
// would silently blank out every consumer's profile the moment a deploy
// shipped without the secret.
import mongoose from "mongoose";
import SubjectKey, { type PiiSubjectType } from "../models/SubjectKey.js";
import { resolveMasterKey } from "./piiMasterKey.js";
import {
  decryptField,
  encryptField,
  generateDataKey,
  FieldDecryptionError,
  PII_ENVELOPE_VERSION,
} from "./fieldCrypto.js";

export class SubjectKeyDestroyedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubjectKeyDestroyedError";
  }
}

export class SubjectKeyUnwrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubjectKeyUnwrapError";
  }
}

export type SubjectDekLookup =
  | { status: "active"; dek: Buffer }
  | { status: "destroyed"; destroyedAt: Date }
  | { status: "missing" };

/**
 * AAD for the DEK wrap. Binds a wrapped DEK to the subject it was minted
 * for, so a wrappedDek string lifted from one row and written into another
 * simply does not unwrap — an attacker with write access to this collection
 * cannot resurrect a shredded subject by copying a live neighbour's key.
 */
function wrapAad(subjectType: PiiSubjectType, subjectId: string): string {
  return `subject-dek:${subjectType}:${subjectId}`;
}

/* ─────────────────────────────────────────────────────────────────────
 * In-process cache.
 *
 * A single profile read touches a dozen encrypted paths across nested
 * subdocuments; without this, each one is a database round trip for the
 * same key. Keyed by subjectType+subjectId, holding the UNWRAPPED dek —
 * which is why it is TTL'd rather than unbounded: a destroySubjectDek()
 * performed by scripts/erase-*.ts runs in a DIFFERENT process, so the API
 * server's cache cannot be invalidated by it. The TTL is the window in
 * which a long-running server can still read a subject whose key was
 * destroyed a moment ago by an operator. Short enough not to matter for an
 * erasure SLA, long enough to collapse a request's lookups into one.
 * ───────────────────────────────────────────────────────────────────── */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  lookup: SubjectDekLookup;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(subjectType: PiiSubjectType, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

/** Test hook, and the invalidation an in-process destroy performs. */
export function clearSubjectKeyCache(): void {
  cache.clear();
}

function normaliseSubjectId(subjectId: mongoose.Types.ObjectId | string): string {
  return String(subjectId);
}

/**
 * Look up a subject's DEK. Never creates one — see getOrCreateSubjectDek().
 * This is the READ path, and a read must never mint a key: doing so would
 * turn "somebody looked at an erased profile" into "the erased profile has
 * a live key again".
 */
export async function getSubjectDek(
  subjectType: PiiSubjectType,
  subjectId: mongoose.Types.ObjectId | string,
): Promise<SubjectDekLookup> {
  const id = normaliseSubjectId(subjectId);
  const key = cacheKey(subjectType, id);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.lookup;

  const row = await SubjectKey.findOne({ subjectType, subjectId }).lean();

  let lookup: SubjectDekLookup;
  if (!row) {
    lookup = { status: "missing" };
  } else if (row.destroyedAt || !row.wrappedDek) {
    lookup = { status: "destroyed", destroyedAt: (row.destroyedAt as Date) ?? new Date(0) };
  } else {
    lookup = { status: "active", dek: unwrapDek(row.wrappedDek, subjectType, id) };
  }

  cache.set(key, { lookup, expiresAt: Date.now() + CACHE_TTL_MS });
  return lookup;
}

function unwrapDek(wrappedDek: string, subjectType: PiiSubjectType, subjectId: string): Buffer {
  const { key: masterKey } = resolveMasterKey();
  try {
    const b64 = decryptField(wrappedDek, masterKey, wrapAad(subjectType, subjectId));
    return Buffer.from(b64, "base64");
  } catch (err) {
    if (err instanceof FieldDecryptionError) {
      // The loud failure. Almost always "this process has the wrong
      // PII_MASTER_KEY" — never allowed to degrade into a missing/destroyed
      // status, because both of those look like ordinary data states to
      // every caller above.
      throw new SubjectKeyUnwrapError(
        `Could not unwrap the data key for ${subjectType}/${subjectId}. This normally means PII_MASTER_KEY ` +
          `does not match the key this row was written with. ${err.message}`,
      );
    }
    throw err;
  }
}

/**
 * The WRITE path: return this subject's DEK, minting and persisting one on
 * first use.
 *
 * @throws SubjectKeyDestroyedError if the subject has been crypto-shredded.
 *         Deliberately NOT "mint a fresh one": see models/SubjectKey.ts's
 *         "one row per subject, forever". A caller that legitimately needs
 *         to store PII for an erased subject is storing it for a NEW
 *         subject and should have a new subject id.
 */
export async function getOrCreateSubjectDek(
  subjectType: PiiSubjectType,
  subjectId: mongoose.Types.ObjectId | string,
): Promise<Buffer> {
  const id = normaliseSubjectId(subjectId);

  const existing = await getSubjectDek(subjectType, id);
  if (existing.status === "active") return existing.dek;
  if (existing.status === "destroyed") {
    throw new SubjectKeyDestroyedError(
      `The data key for ${subjectType}/${id} was destroyed at ${existing.destroyedAt.toISOString()} ` +
        `(crypto-shredded). Refusing to mint a replacement — an erased subject does not get a second key.`,
    );
  }

  const { key: masterKey } = resolveMasterKey();
  const dek = generateDataKey();
  const wrappedDek = encryptField(dek.toString("base64"), masterKey, wrapAad(subjectType, id));

  try {
    await SubjectKey.create({
      subjectType,
      subjectId: new mongoose.Types.ObjectId(id),
      wrappedDek,
      encVersion: PII_ENVELOPE_VERSION,
      destroyedAt: null,
    });
  } catch (err: any) {
    // Two concurrent first-writes for the same subject race here; the unique
    // index picks one winner. The loser must use the WINNER's key, not its
    // own — two DEKs for one subject would mean a shred that only half
    // works. Re-read (uncached: the failed create left nothing to cache).
    if (err?.code !== 11000) throw err;
    cache.delete(cacheKey(subjectType, id));
    const raced = await getSubjectDek(subjectType, id);
    if (raced.status === "active") return raced.dek;
    if (raced.status === "destroyed") {
      throw new SubjectKeyDestroyedError(
        `The data key for ${subjectType}/${id} was destroyed while this write was in flight.`,
      );
    }
    throw err;
  }

  cache.set(cacheKey(subjectType, id), {
    lookup: { status: "active", dek },
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return dek;
}

export interface DestroySubjectDekInput {
  actorEmail: string;
  reason: string;
}

export interface DestroySubjectDekResult {
  /** True when a live key was destroyed by THIS call. */
  destroyed: boolean;
  /** True when the subject had no key row at all — nothing was encrypted under it. */
  hadNoKey: boolean;
  /** True when it was already destroyed by an earlier run. Idempotent, not an error. */
  alreadyDestroyed: boolean;
}

/**
 * CRYPTO-SHRED. Tombstones the subject's key row: wrappedDek is unset, the
 * actor and reason are stamped, the row stays.
 *
 * Idempotent by design — the erasure scripts are re-runnable (see
 * scripts/lib/visaErasureCascade.ts's own conventions) and a second run
 * must report "already destroyed", not fail.
 *
 * COMPOSITION WITH THE EXISTING ERASURE FLOW (Stage 2 wiring, not done
 * here): scripts/erase-traveller-profile.ts already cascades
 * travellerProfileId -> applicationIds -> VisaDocuments + S3. This call
 * belongs at the END of that cascade — after the documents and their S3
 * objects are gone — and its result belongs in the run's
 * VisaErasureLog.counts as `subjectKeysDestroyed`. Ordering matters in one
 * direction only: destroying the key first would make the surviving
 * ciphertext unreadable to the very cascade that still has to plan against
 * it, so the key dies last.
 */
export async function destroySubjectDek(
  subjectType: PiiSubjectType,
  subjectId: mongoose.Types.ObjectId | string,
  input: DestroySubjectDekInput,
): Promise<DestroySubjectDekResult> {
  const id = normaliseSubjectId(subjectId);

  const row = await SubjectKey.findOne({ subjectType, subjectId: new mongoose.Types.ObjectId(id) });
  cache.delete(cacheKey(subjectType, id));

  if (!row) return { destroyed: false, hadNoKey: true, alreadyDestroyed: false };
  if (row.destroyedAt) return { destroyed: false, hadNoKey: false, alreadyDestroyed: true };

  row.wrappedDek = null;
  row.destroyedAt = new Date();
  row.destroyedByEmail = input.actorEmail;
  row.destroyReason = input.reason;
  await row.save();

  cache.delete(cacheKey(subjectType, id));
  return { destroyed: true, hadNoKey: false, alreadyDestroyed: false };
}
