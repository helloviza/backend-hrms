// apps/backend/src/utils/codeSequence.ts
//
// PREFIX-YYYY-NNNN display codes from the atomic Counter — never
// countDocuments()+1. That scheme reissued an existing number after any
// delete (a gap) and collided on concurrent creates, so the unique sparse
// index on the code field threw E11000 and the create 500'd (audit #6).
//
// One counter doc per prefix+year, _id "PREFIX-YYYY" (e.g. "LEAD-2026"), in
// the same `counters` collection invoices/tickets/opportunities already use.
//
// FIRST USE for a prefix+year with no counter doc: the counter is SEEDED to
// the current max numeric suffix among that prefix+year's existing codes
// (one scan, parsed numerically — legacy rows carry both "302" and "0210"),
// so it can never hand out a code that already exists. Never seeded from a
// count. Existing rows keep their codes; this is code + a counter doc, not
// a migration.
//
// nextCode() additionally skips a code that is already taken out-of-band (a
// manually assigned code sitting ahead of the counter) by drawing again, a
// bounded number of times. Concurrent creates are safe by construction:
// each draws its own $inc.

import type { Model } from "mongoose";
import Counter from "../models/Counter.js";

const MAX_DRAWS = 5;

export function counterId(prefix: string, year: number): string {
  return `${prefix}-${year}`;
}

export function formatCode(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
}

/** Max numeric suffix among existing `PREFIX-YYYY-N…` codes on `field`, or 0. */
export async function currentMaxSequence(model: Model<any>, field: string, prefix: string, year: number): Promise<number> {
  const re = new RegExp(`^${prefix}-${year}-(\\d+)$`);
  const rows = (await model.find({ [field]: re }, { [field]: 1, _id: 0 }).lean()) as Array<Record<string, string>>;
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r[field] || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

async function seedIfMissing(model: Model<any>, field: string, prefix: string, year: number): Promise<void> {
  const _id = counterId(prefix, year);
  if (await Counter.exists({ _id })) return;
  const max = await currentMaxSequence(model, field, prefix, year);
  try {
    // $setOnInsert: if two first-callers race, the second upsert is a no-op
    // (or an E11000 on _id, which means the first one won — same thing).
    await Counter.updateOne({ _id }, { $setOnInsert: { seq: max } }, { upsert: true });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
  }
}

/**
 * Atomically draw the next sequence number for prefix+year. Pass `seed`
 * (the model + code field) so a missing counter is seeded from existing
 * codes before the first draw.
 */
export async function getNextSequence(
  prefix: string,
  year: number,
  seed?: { model: Model<any>; field: string },
): Promise<number> {
  if (seed) await seedIfMissing(seed.model, seed.field, prefix, year);
  const doc = await Counter.findOneAndUpdate(
    { _id: counterId(prefix, year) },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  ).lean();
  return doc!.seq;
}

/** The next free `PREFIX-YYYY-NNNN` for `model.field`. Throws only if
 *  MAX_DRAWS consecutive draws were all taken out-of-band. */
export async function nextCode(
  model: Model<any>,
  field: string,
  prefix: string,
  year: number = new Date().getFullYear(),
): Promise<string> {
  for (let i = 0; i < MAX_DRAWS; i++) {
    const seq = await getNextSequence(prefix, year, { model, field });
    const code = formatCode(prefix, year, seq);
    if (!(await model.exists({ [field]: code }))) return code;
    // taken by a code assigned outside the counter — draw again
  }
  throw new Error(`${prefix}-${year}: no free code after ${MAX_DRAWS} draws`);
}
