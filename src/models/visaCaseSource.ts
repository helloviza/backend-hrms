// apps/backend/src/models/visaCaseSource.ts
//
// The channel a visa case came in through. One definition, three consumers
// (VisaRequest, VisaApplication, VisaActivityLog) — a second copy of an enum
// that has to agree across collections is how they start disagreeing.
//
// ── WHY IMMUTABILITY NEEDS TWO MECHANISMS ─────────────────────────────
// Mongoose's `immutable: true` covers Model.create() and document.save().
// It does NOT cover findOneAndUpdate / updateOne / updateMany / findByIdAndUpdate
// unless the connection is configured to reject those, which this codebase
// does not do — a `$set: { source: "D2C" }` through any of them would sail
// straight through. Since findByIdAndUpdate/findOneAndUpdate are exactly how
// routes/admin.visa.ts mutates applications (PATCH /status, /assignment,
// bulk-assign), the schema flag on its own would be enforcement in name only.
//
// So: `immutable: true` on the path, AND applyVisaSourceImmutability() below
// on every update operation.
//
// It THROWS rather than silently stripping the field. A caller trying to
// change a case's channel has a bug — a stripped write would hide it and
// leave the caller believing the change landed.
import type { Schema } from "mongoose";

export const VISA_CASE_SOURCES = ["B2B", "D2C"] as const;
export type VisaCaseSource = (typeof VISA_CASE_SOURCES)[number];

/** Every case that predates the D2C channel is B2B, and so is every case a B2B path creates. */
export const DEFAULT_VISA_CASE_SOURCE: VisaCaseSource = "B2B";

/** The schema path definition, identical on VisaRequest and VisaApplication. */
export const visaCaseSourcePath = {
  type: String,
  enum: VISA_CASE_SOURCES,
  default: DEFAULT_VISA_CASE_SOURCE,
  required: true,
  // Covers save()/create(). The update-operation half is applyVisaSourceImmutability.
  immutable: true,
  index: true,
} as const;

// Update operations Mongoose routes through a query middleware hook.
// findByIdAndUpdate is NOT listed because Mongoose implements it as
// findOneAndUpdate and fires that hook — registering both would run the
// guard twice.
const GUARDED_UPDATE_OPS = [
  "findOneAndUpdate",
  "updateOne",
  "updateMany",
  "updateOne",
  "replaceOne",
] as const;

/**
 * True when an update document tries to write `source` anywhere a real
 * mutation could land.
 *
 * $setOnInsert is deliberately EXCLUDED: on an upsert that inserts, that
 * branch IS the creation, and refusing it would make an upsert-shaped
 * creation impossible. On an upsert that matches, Mongo ignores
 * $setOnInsert entirely, so it can never mutate an existing row.
 */
export function updateTouchesSource(update: any): boolean {
  if (!update || typeof update !== "object") return false;

  // { $set: { source } } — the normal shape.
  if (update.$set && Object.prototype.hasOwnProperty.call(update.$set, "source")) return true;
  // { source } — a bare replacement-style update.
  if (Object.prototype.hasOwnProperty.call(update, "source")) return true;
  // { $unset: { source } } — clearing it is a mutation too; the field is
  // `required`, so this would also corrupt the document.
  if (update.$unset && Object.prototype.hasOwnProperty.call(update.$unset, "source")) return true;

  return false;
}

const IMMUTABLE_MESSAGE =
  "source is immutable — a visa case's channel is fixed at creation and cannot be changed by an update";

/**
 * Registers the update-path half of `source` immutability on a schema.
 * Call this on every model carrying the field.
 */
export function applyVisaSourceImmutability(schema: Schema): void {
  for (const op of new Set(GUARDED_UPDATE_OPS)) {
    schema.pre(op as any, function (this: any, next: (err?: Error) => void) {
      const update = typeof this.getUpdate === "function" ? this.getUpdate() : null;
      if (updateTouchesSource(update)) {
        return next(new Error(IMMUTABLE_MESSAGE));
      }
      next();
    });
  }
}
