// apps/backend/src/bootstrap/ensureSbtManualLinkIndexes.ts
//
// Boot step for the SBT → Manual Booking link (docs/specs/sbt-to-manual-booking-spec.md
// §3.1). Same shape as ensureInvoiceReissueIndexes.ts: an AWAITED build of the
// one index the link depends on, then a CHECK from the live collection.
//
// The index — unique on ManualBooking.sbtLink.bookingId, partial on that field
// existing — is what makes "one SBT booking, one ManualBooking" hold when the
// save hook, the Razorpay webhook path, the sweep and a staff import race.
// While it is not verified, services/sbtManualLink.ts refuses to create a link
// (fails closed, recorded on the SBT doc, retried by the sweep). Re-checked at
// most once a minute, so building it by hand re-enables linking without a
// restart. Log-and-continue: boot never crashes on it.
//
// Only this index is built here (not ManualBooking.createIndexes()): the
// booking collection is large and its other indexes are Mongoose autoIndex's
// business, as before.
import ManualBooking from "../models/ManualBooking.js";
import { SBT_LINK_INDEX_NAME } from "../utils/sbtLinkLock.js";

export const SBT_LINK_INDEX_FIX =
  `db.manualbookings.createIndex({ "sbtLink.bookingId": 1 }, { unique: true, partialFilterExpression: { "sbtLink.bookingId": { $exists: true } }, name: "${SBT_LINK_INDEX_NAME}" })`;

/** Matched on key + options, not on name, so a hand-built index counts. */
export function isSbtLinkUniqueIndex(ix: any): boolean {
  const key = ix?.key || {};
  const pfe = ix?.partialFilterExpression || {};
  return (
    Object.keys(key).length === 1 && key["sbtLink.bookingId"] === 1 &&
    ix.unique === true &&
    Object.keys(pfe).length === 1 && pfe["sbtLink.bookingId"]?.$exists === true
  );
}

export const SBT_LINK_INDEX_RECHECK_MS = 60_000;

let verified: boolean | null = null;
let checkedAt = 0;
let inFlight: Promise<boolean> | null = null;

async function checkIndex(log: Pick<Console, "error" | "log"> = console): Promise<boolean> {
  let present = false;
  try {
    present = (await ManualBooking.collection.indexes()).some(isSbtLinkUniqueIndex);
  } catch (e: any) {
    if (e?.code !== 26) log.error(`[SBT-LINK INDEX] ✖ could not list indexes on manualbookings: ${e?.message || e}`);
  }
  if (verified === false && present) log.log("[SBT-LINK INDEX] link index found — SBT → Manual Booking linking re-enabled.");
  if (verified === true && !present) log.error(`[SBT-LINK INDEX] ✖ link index has gone — linking disabled. Build it with: ${SBT_LINK_INDEX_FIX}`);
  verified = present;
  checkedAt = Date.now();
  return present;
}

/** May a link be created? Fails closed; re-checks when the answer is a minute old. */
export async function sbtLinkIndexAvailable(): Promise<boolean> {
  if (verified !== null && Date.now() - checkedAt < SBT_LINK_INDEX_RECHECK_MS) return verified;
  inFlight ??= checkIndex().finally(() => { inFlight = null; });
  return inFlight;
}

export function resetSbtLinkIndexCheck(): void {
  verified = null;
  checkedAt = 0;
}

export async function ensureSbtManualLinkIndexes(
  log: Pick<Console, "error" | "log"> = console,
): Promise<{ built: boolean; present: boolean }> {
  let built = false;
  try {
    await ManualBooking.collection.createIndex(
      { "sbtLink.bookingId": 1 },
      { unique: true, partialFilterExpression: { "sbtLink.bookingId": { $exists: true } }, name: SBT_LINK_INDEX_NAME },
    );
    built = true;
  } catch (e: any) {
    log.error(`[SBT-LINK INDEX] ✖ createIndex FAILED: ${e?.message || e}`);
  }
  resetSbtLinkIndexCheck();
  const present = await checkIndex(log);
  if (!present) {
    log.error(`[SBT-LINK INDEX] ✖ unique index on manualbookings {sbtLink.bookingId:1} is MISSING — SBT → Manual Booking linking is disabled until it is built. Build it with: ${SBT_LINK_INDEX_FIX}`);
  }
  log.log(`[SBT-LINK INDEX] link index ${present ? "present" : "MISSING"}.`);
  return { built, present };
}
