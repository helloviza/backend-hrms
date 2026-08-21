// apps/backend/src/plugins/fieldEncryption.plugin.ts
//
// Encrypts declared paths on write, decrypts them on read, under the
// subject's own data key (security/subjectKeys.ts). Same shape as
// plugins/workspaceScope.plugin.ts — a schema opts in with one line and
// every query method behaves.
//
//     MySchema.plugin(fieldEncryptionPlugin, {
//       subject: (doc) => ({ subjectType: "CONSUMER", subjectId: doc.consumerId }),
//       fields: [
//         { path: "contact.mobile" },                       // String
//         { path: "personal.dateOfBirth", type: "date" },   // see TRAP 2
//         { path: "passports.$.number" },                   // every array element
//         { path: "coTravellers.$.dateOfBirth", type: "date" },
//       ],
//     });
//
// `$` in a path means "every element of this array". Consumer PII is
// array-shaped in the places that matter most (passports, coTravellers),
// so a plugin that could only reach flat paths could not encrypt the single
// highest-value field in the codebase.
//
// ══ THE DUAL-READ MIGRATION WINDOW ═══════════════════════════════════
// A stored value that is NOT one of our envelopes is legacy plaintext and
// is passed through untouched. This is what lets encryption be switched on
// for a collection that already holds rows: existing rows keep working,
// each save rewrites that document's fields as ciphertext, and a backfill
// script can convert the rest at its own pace. Every read reports which
// paths decrypted and which fell through — read it with the exported
// PII_READ_REPORT symbol — so "is this collection fully migrated yet" is a
// question with a real answer rather than an assumption.
//
// ══ TRAP 1 — SETTER ORDERING ═════════════════════════════════════════
// ConsumerProfile declares `number: { type: String, trim: true, uppercase:
// true }`. Mongoose applies those normalising setters at ASSIGNMENT time,
// and it does so EVERY time — including inside a pre('save') hook.
//
// Two consequences, and the second one is the trap:
//
//   1. Encrypting in a custom `set` function would run BEFORE
//      uppercase/trim and hand them a ciphertext to normalise. So
//      encryption happens in pre('save') instead, by which point the value
//      is already normalised: what gets encrypted is the UPPERCASED,
//      TRIMMED string, and that is what comes back on read.
//
//   2. Being in pre('save') is not enough on its own. `doc.x = ciphertext`
//      there STILL runs uppercase, which turns `penc.1.aB-c...` into
//      `PENC.1.AB-C...` — silent, total corruption that only surfaces as a
//      decryption failure much later. Verified against mongoose 8 directly,
//      including the two obvious escapes: neither `doc.set(path, v,
//      { setters: false })` nor `doc.$set(path, v, undefined,
//      { setters: false })` bypasses it.
//
// So every write this plugin performs goes through rawWrite() below, which
// assigns into the document's internal `_doc` store and then marks the path
// modified by hand. That is the one write that reaches the field without
// passing a schema setter. Proven in fieldEncryption.plugin.test.ts
// ("stores ciphertext, reads back the UPPERCASED plaintext").
//
// ══ TRAP 2 — NON-STRING FIELDS ═══════════════════════════════════════
// `dateOfBirth` is a Date. A ciphertext is a string. Assigning a string to
// a Date path makes Mongoose cast it — `new Date("penc.1.aB...")` is
// Invalid Date — and the write either throws or stores garbage.
//
// The rule: a path declared `{ type: "date" }` here MUST be declared
// `Schema.Types.Mixed` on the schema, and this plugin ASSERTS that at
// attach time, naming the path in the error. Mixed is what lets the same
// path hold a real Date (a legacy row, untouched — its BSON stays a BSON
// date, nothing rewrites it) and a ciphertext string (an encrypted row)
// without either one being cast into the other. The plugin owns the
// conversion Mongoose no longer does: Date -> ISO-8601 string before
// encrypting, `new Date(iso)` after decrypting, so callers still get a
// Date object. Invalid input is rejected on write rather than stored.
//
// Mixed also means Mongoose cannot see in-place mutations, so every write
// this plugin performs is followed by markModified() on the concrete path.
//
// ══ WHAT THIS PLUGIN DELIBERATELY REFUSES ════════════════════════════
// updateOne/updateMany/findOneAndUpdate that touch an encrypted path THROW
// (see the pre-hook at the bottom). Those go straight to the database as a
// $set, with no document in the middle to run pre('save') on, so honouring
// them would mean writing plaintext into a column everything else assumes
// is ciphertext — a leak with no error, no log, and nothing to notice it
// by. Encrypted fields are written through a loaded document and .save(),
// full stop. Note for Stage 2: routes/consumer.profile.ts already saves
// through documents almost everywhere, but its first-read upsert
// (findOneAndUpdate) and the two ConsumerProfile.updateOne calls that write
// passport document references will need converting.
import mongoose, { type Schema } from "mongoose";
import { type PiiSubjectType } from "../models/SubjectKey.js";
import { decryptField, encryptField, isEncryptedEnvelope } from "../security/fieldCrypto.js";
import { getOrCreateSubjectDek, getSubjectDek } from "../security/subjectKeys.js";

export type EncryptedFieldType = "string" | "date";

export interface EncryptedFieldSpec {
  /** Dotted path. `$` means "every element of this array". */
  path: string;
  /** Defaults to "string". See TRAP 2 for what "date" requires. */
  type?: EncryptedFieldType;
}

export interface SubjectRef {
  subjectType: PiiSubjectType;
  subjectId: mongoose.Types.ObjectId | string;
}

export interface FieldEncryptionOptions {
  fields: EncryptedFieldSpec[];
  /**
   * Resolve the erasure subject this document's PII belongs to. Returning
   * null means "cannot tell from what is loaded" — normally a projection
   * that excluded the subject key. That is only fatal if the document
   * actually carries ciphertext; see readDocument().
   */
  subject: (doc: any) => SubjectRef | null;
}

/**
 * Per-read report, attached to every document the read path touches.
 * A Symbol so it never lands in JSON.stringify, an API response, or a
 * subsequent write.
 */
export const PII_READ_REPORT = Symbol("piiReadReport");

export interface PiiReadReport {
  /** Paths that held ciphertext and decrypted successfully. */
  decrypted: string[];
  /** Paths that held legacy plaintext and were passed through untouched. */
  legacy: string[];
  /** Paths blanked because the subject's key was destroyed (crypto-shredded). */
  shredded: string[];
}

export class SubjectUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubjectUnresolvedError";
  }
}

export class OrphanedCiphertextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrphanedCiphertextError";
  }
}

export class EncryptedFieldUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptedFieldUpdateError";
  }
}

/** The tombstone a crypto-shredded field reads back as. */
const SHREDDED_VALUE = null;

/* ─────────────────────────────────────────────────────────────────────
 * Path walking. A spec path is resolved against a CONCRETE document into
 * zero or more slots — one per array element when the path contains `$`.
 * ───────────────────────────────────────────────────────────────────── */

interface Slot {
  holder: any;
  key: string;
  /** The path with `$` replaced by real indices — what markModified() needs. */
  concretePath: string;
}

function collectSlots(node: any, segments: string[], prefix: string[]): Slot[] {
  if (node == null) return [];
  const [segment, ...rest] = segments;

  if (segment === "$") {
    if (!Array.isArray(node)) return [];
    return node.flatMap((element, index) => collectSlots(element, rest, [...prefix, String(index)]));
  }

  if (rest.length === 0) {
    return [{ holder: node, key: segment, concretePath: [...prefix, segment].join(".") }];
  }

  return collectSlots(node[segment], rest, [...prefix, segment]);
}

function slotsFor(doc: any, spec: EncryptedFieldSpec): Slot[] {
  return collectSlots(doc, spec.path.split("."), []);
}

/**
 * Normalise an UPDATE key's array addressing to the `$` a spec path uses, so
 * the refusal below compares like with like. Mongo has three spellings for
 * "an element of this array" and an update can use any of them:
 *
 *   passports.$[front].frontDocumentId   (arrayFilters — live in this codebase,
 *   passports.$.number                    routes/consumer.profile.ts:678/687)
 *   passports.0.number                   (a literal index)
 *
 * Without this, a `$set` of `passports.$[x].number` matched no spec and
 * sailed straight past the guard into the database as plaintext — the exact
 * leak the guard exists to stop. Found while auditing the two arrayFilters
 * `$unset` calls in consumer.profile.ts (which are themselves harmless —
 * they target document references, not encrypted fields).
 */
function normaliseUpdateKey(key: string): string {
  return key
    .replace(/\.\$\[[^\]]*\]/g, ".$") // .$[front] -> .$
    .replace(/\.\d+(?=\.|$)/g, ".$"); // .0        -> .$
}

/* ─────────────────────────────────────────────────────────────────────
 * Type conversion — the Date half of TRAP 2.
 * ───────────────────────────────────────────────────────────────────── */

function toPlaintext(value: unknown, spec: EncryptedFieldSpec): string {
  if ((spec.type ?? "string") === "date") {
    const date = value instanceof Date ? value : new Date(value as any);
    if (Number.isNaN(date.getTime())) {
      throw new TypeError(`Cannot encrypt "${spec.path}": value is not a valid date (${String(value)}).`);
    }
    return date.toISOString();
  }
  return String(value);
}

function fromPlaintext(plaintext: string, spec: EncryptedFieldSpec): string | Date {
  if ((spec.type ?? "string") === "date") {
    const date = new Date(plaintext);
    if (Number.isNaN(date.getTime())) {
      throw new TypeError(`Decrypted value for "${spec.path}" is not a valid date (${plaintext}).`);
    }
    return date;
  }
  return plaintext;
}

/* ─────────────────────────────────────────────────────────────────────
 * Attach-time schema validation — the other half of TRAP 2, enforced
 * before a single row can be written wrongly.
 * ───────────────────────────────────────────────────────────────────── */

function resolveSchemaType(schema: any, segments: string[]): any | null {
  let current: any = schema;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "$") continue; // the array itself was resolved on the previous step
    const path = current.path?.(segment);
    if (!path) return null;
    if (i === segments.length - 1) return path;
    const nested = path.schema ?? path.caster?.schema;
    if (!nested) return null;
    current = nested;
  }
  return null;
}

function assertPathIsEncryptable(schema: Schema, spec: EncryptedFieldSpec): void {
  const type = (spec.type ?? "string") as EncryptedFieldType;
  const schemaType = resolveSchemaType(schema, spec.path.split("."));

  if (!schemaType) {
    throw new Error(`fieldEncryptionPlugin: path "${spec.path}" does not exist on this schema.`);
  }

  if (type === "string" && schemaType.instance !== "String") {
    throw new Error(
      `fieldEncryptionPlugin: path "${spec.path}" is declared { type: "string" } but the schema declares it as ` +
        `${schemaType.instance}. A ciphertext is a string; declare the field as String, or declare the spec's ` +
        `type and make the schema path Schema.Types.Mixed.`,
    );
  }

  if (type !== "string" && schemaType.instance !== "Mixed") {
    throw new Error(
      `fieldEncryptionPlugin: path "${spec.path}" is declared { type: "${type}" }, so the schema path must be ` +
        `Schema.Types.Mixed — it has to hold either a real ${type} (a legacy row, never rewritten) or a ` +
        `ciphertext string (an encrypted row), and Mongoose would cast the ciphertext into an invalid ` +
        `${type} otherwise. Schema currently declares it as ${schemaType.instance}.`,
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * The read path. Shared by hydrated documents and `.lean()` results —
 * post('find') receives whichever the query produced, and both are just
 * objects to the walker above.
 * ───────────────────────────────────────────────────────────────────── */

async function readDocument(doc: any, options: FieldEncryptionOptions): Promise<void> {
  if (!doc || typeof doc !== "object") return;

  const report: PiiReadReport = { decrypted: [], legacy: [], shredded: [] };
  const pending: Array<{ slot: Slot; spec: EncryptedFieldSpec }> = [];

  for (const spec of options.fields) {
    for (const slot of slotsFor(doc, spec)) {
      const value = slot.holder[slot.key];
      if (value == null || value === "") continue;
      if (isEncryptedEnvelope(value)) {
        pending.push({ slot, spec });
      } else {
        report.legacy.push(slot.concretePath);
      }
    }
  }

  if (pending.length === 0) {
    attachReport(doc, report);
    return;
  }

  // Only now does the subject have to be resolvable. A projection that
  // dropped the subject key but also dropped every encrypted field is a
  // perfectly ordinary query and must not fail.
  const subject = options.subject(doc);
  if (!subject || !subject.subjectId) {
    throw new SubjectUnresolvedError(
      `Cannot decrypt ${pending.length} field(s) on this document: its encryption subject could not be resolved ` +
        `(paths: ${pending.map((p) => p.slot.concretePath).join(", ")}). A projection that excludes the subject ` +
        `key must also exclude the encrypted fields — returning ciphertext to the caller is not an option.`,
    );
  }

  const lookup = await getSubjectDek(subject.subjectType, subject.subjectId);

  if (lookup.status === "missing") {
    // Ciphertext with no key row at all: not "legacy plaintext", not
    // "erased" — an inconsistency somebody has to look at.
    throw new OrphanedCiphertextError(
      `Document carries encrypted fields but no SubjectKey row exists for ` +
        `${subject.subjectType}/${String(subject.subjectId)}. This data cannot be read and was never shredded.`,
    );
  }

  if (lookup.status === "destroyed") {
    for (const { slot } of pending) {
      writeSlot(doc, slot, SHREDDED_VALUE);
      report.shredded.push(slot.concretePath);
    }
    attachReport(doc, report);
    return;
  }

  for (const { slot, spec } of pending) {
    const plaintext = decryptField(slot.holder[slot.key], lookup.dek, spec.path);
    writeSlot(doc, slot, fromPlaintext(plaintext, spec));
    report.decrypted.push(slot.concretePath);
  }

  attachReport(doc, report);
}

/**
 * The one write that reaches a field without passing a schema setter — see
 * TRAP 1. `_doc` is Mongoose's internal value store; a hydrated document or
 * subdocument has one, a `.lean()` object does not, in which case a plain
 * assignment is already setter-free.
 *
 * markModified() is unconditional here because it is needed twice over: a
 * Mixed path (TRAP 2) is invisible to Mongoose's change tracking, and a
 * `_doc` write is invisible to it regardless of the path's type.
 */
function rawWrite(doc: any, slot: Slot, value: unknown): void {
  const store = slot.holder?._doc ?? slot.holder;
  store[slot.key] = value;
  doc.markModified?.(slot.concretePath);
}

function writeSlot(doc: any, slot: Slot, value: unknown): void {
  rawWrite(doc, slot, value);
  // A READ must not leave the document looking dirty. pre('save')
  // re-encrypts unconditionally (see encryptDocument), so nothing depends
  // on these flags surviving.
  doc.unmarkModified?.(slot.concretePath);
}

function attachReport(doc: any, report: PiiReadReport): void {
  try {
    Object.defineProperty(doc, PII_READ_REPORT, {
      value: report,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen or exotic object — the report is diagnostic, never load-bearing.
  }
}

/** Read the dual-read report a query attached to a document. */
export function getPiiReadReport(doc: any): PiiReadReport | undefined {
  return doc?.[PII_READ_REPORT];
}

/* ─────────────────────────────────────────────────────────────────────
 * The write path.
 * ───────────────────────────────────────────────────────────────────── */

interface CapturedPlaintext {
  slot: Slot;
  value: unknown;
}

async function encryptDocument(doc: any, options: FieldEncryptionOptions): Promise<CapturedPlaintext[]> {
  const targets: Array<{ slot: Slot; spec: EncryptedFieldSpec }> = [];

  for (const spec of options.fields) {
    for (const slot of slotsFor(doc, spec)) {
      const value = slot.holder[slot.key];
      if (value == null || value === "") continue;
      // Already an envelope: a document saved twice without an intervening
      // read, or a value copied from another row. Never double-encrypt.
      if (isEncryptedEnvelope(value)) continue;
      targets.push({ slot, spec });
    }
  }

  if (targets.length === 0) return [];

  const subject = options.subject(doc);
  if (!subject || !subject.subjectId) {
    throw new SubjectUnresolvedError(
      `Cannot encrypt ${targets.length} field(s): this document's encryption subject could not be resolved. ` +
        `A document holding PII must know whose PII it is before it can be written.`,
    );
  }

  const dek = await getOrCreateSubjectDek(subject.subjectType, subject.subjectId);

  const captured: CapturedPlaintext[] = [];
  for (const { slot, spec } of targets) {
    const plain = slot.holder[slot.key];
    captured.push({ slot, value: plain });
    rawWrite(doc, slot, encryptField(toPlaintext(plain, spec), dek, spec.path));
  }
  return captured;
}

/* ─────────────────────────────────────────────────────────────────────
 * The plugin.
 * ───────────────────────────────────────────────────────────────────── */

export function fieldEncryptionPlugin(schema: Schema, options: FieldEncryptionOptions): void {
  if (!options?.fields?.length) {
    throw new Error("fieldEncryptionPlugin: `fields` is required and must not be empty.");
  }
  if (typeof options.subject !== "function") {
    throw new Error("fieldEncryptionPlugin: `subject` resolver is required.");
  }
  for (const spec of options.fields) assertPathIsEncryptable(schema, spec);

  /* ── write ─────────────────────────────────────────────────────────
   * EVERY non-empty declared value is re-encrypted on every save, not
   * only the ones Mongoose reports as modified. Re-encrypting an
   * unchanged field costs a fresh IV and an oplog entry; MISSING a
   * changed one writes a passport number in clear text. The two failure
   * modes are not comparable, so this does not consult isModified().
   * ────────────────────────────────────────────────────────────────── */
  schema.pre("save", async function (this: any) {
    this.$locals.piiCaptured = await encryptDocument(this, options);
  });

  // Hand the caller back the document they saved, not the ciphertext it
  // became. Without this, `await profile.save()` followed by reading
  // profile.contact.mobile returns an envelope.
  schema.post("save", function (this: any, doc: any) {
    const captured: CapturedPlaintext[] = this.$locals?.piiCaptured ?? [];
    for (const { slot, value } of captured) writeSlot(doc, slot, value);
    this.$locals.piiCaptured = [];
  });

  /* ── read ──────────────────────────────────────────────────────────
   * Query middleware rather than post('init'), for two reasons: init
   * hooks are synchronous and decryption needs an awaited key lookup,
   * and init does not fire at all for `.lean()` — which would hand
   * ciphertext straight to the ~40 lean() call sites in the routes.
   * post('find') receives lean objects and hydrated documents alike.
   *
   * NOT covered, and Stage 2 must know it: Model.aggregate() and
   * Model.distinct() bypass this entirely. Neither is used against these
   * fields today; an aggregate over an encrypted path would return
   * envelopes.
   * ────────────────────────────────────────────────────────────────── */
  schema.post("find", async function (docs: any[]) {
    if (!Array.isArray(docs)) return;
    for (const doc of docs) await readDocument(doc, options);
  });

  for (const method of ["findOne", "findOneAndUpdate", "findOneAndDelete"] as const) {
    schema.post(method, async function (doc: any) {
      if (doc) await readDocument(doc, options);
    });
  }

  /* ── the refusal ───────────────────────────────────────────────────
   * See the file header. A direct update that touches an encrypted path
   * would store plaintext silently.
   * ────────────────────────────────────────────────────────────────── */
  const encryptedPrefixes = options.fields.map((f) => f.path.split(".$.")[0].split(".$")[0]);

  for (const method of ["updateOne", "updateMany", "findOneAndUpdate"] as const) {
    schema.pre(method, function (this: any) {
      const update = this.getUpdate?.();
      if (!update || Array.isArray(update)) return; // aggregation-pipeline update: not inspected, see header
      const touched = new Set<string>();
      for (const [operator, payload] of Object.entries(update)) {
        const keys = operator.startsWith("$")
          ? Object.keys((payload ?? {}) as Record<string, unknown>)
          : [operator];
        for (const key of keys) {
          const normalised = normaliseUpdateKey(key);
          for (const spec of options.fields) {
            // Three ways an update key can reach an encrypted path: it IS
            // the path, it is INSIDE the path, or it is an ANCESTOR that
            // replaces the path wholesale (a $set of "contact", or of the
            // whole "passports" array).
            if (
              normalised === spec.path ||
              normalised.startsWith(`${spec.path}.`) ||
              spec.path.startsWith(`${normalised}.`)
            ) {
              touched.add(spec.path);
            }
          }
        }
      }
      if (touched.size > 0) {
        throw new EncryptedFieldUpdateError(
          `${method}() would write ${[...touched].join(", ")} straight to the database, bypassing encryption. ` +
            `Load the document and .save() instead. (Encrypted roots on this model: ${[
              ...new Set(encryptedPrefixes),
            ].join(", ")}.)`,
        );
      }
    });
  }
}
