// apps/backend/src/bootstrap/ensureInvoiceReissueIndexes.ts
//
// Boot step for the invoice reissue collections (archived_invoices,
// invoice_number_reservations). Prod runs Mongoose's default autoIndex (ON —
// connectDb never turns it off), so these indexes would be built anyway, but
// that build is async and unawaited. This runs an AWAITED createIndexes() per
// model before traffic, the same way ensurePlutoIndexes does — idempotent,
// never drops an index.
//
// It then CHECKS, from the live collection, that the partial unique index on
// reservations exists with the right options. That index is what stops one
// invoice number being RESERVED twice. If it is missing (build failed, or an
// older index with the same key and different options is in the way) it logs
// an ERROR with the command to build it by hand. Log-and-continue: boot never
// crashes on it.
//
// The result is kept in memory. While the index is not verified, the two
// paths that depend on it — cancel-for-reissue and reuse-at-generate — fail
// closed with 503 (see reservedIndexAvailable). It is re-checked at most once
// a minute, so building the index by hand re-enables reissue without a restart.

import ArchivedInvoice from "../models/ArchivedInvoice.js";
import InvoiceNumberReservation from "../models/InvoiceNumberReservation.js";

const MODELS: Array<[string, any]> = [
  ["ArchivedInvoice", ArchivedInvoice],
  ["InvoiceNumberReservation", InvoiceNumberReservation],
];

export const RESERVED_UNIQUE_INDEX_FIX =
  'db.invoice_number_reservations.createIndex({ number: 1 }, { unique: true, partialFilterExpression: { status: "RESERVED" }, name: "number_reserved_unique" })';

/** Matched on key + options, not on name, so a hand-built index counts. */
export function isReservedUniqueIndex(ix: any): boolean {
  const key = ix?.key || {};
  const pfe = ix?.partialFilterExpression || {};
  return (
    Object.keys(key).length === 1 && key.number === 1 &&
    ix.unique === true &&
    Object.keys(pfe).length === 1 && pfe.status === "RESERVED"
  );
}

export const RESERVED_INDEX_RECHECK_MS = 60_000;
export const RESERVED_INDEX_UNAVAILABLE_MESSAGE =
  "Invoice reissue is temporarily unavailable — reservation index missing, contact SuperAdmin";

let verified: boolean | null = null; // null = not checked yet
let checkedAt = 0;
let inFlight: Promise<boolean> | null = null;

async function checkReservedIndex(log: Pick<Console, "error" | "log"> = console): Promise<boolean> {
  let present = false;
  try {
    present = (await InvoiceNumberReservation.collection.indexes()).some(isReservedUniqueIndex);
  } catch (e: any) {
    // NamespaceNotFound (26): no collection yet, so no index.
    if (e?.code !== 26) log.error(`[INVOICE INDEXES] ✖ could not list indexes on invoice_number_reservations: ${e?.message || e}`);
  }
  if (verified === false && present) log.log("[INVOICE INDEXES] reserved-number unique index found — invoice reissue re-enabled.");
  if (verified === true && !present) log.error(`[INVOICE INDEXES] ✖ reserved-number unique index has gone — invoice reissue disabled. Build it with: ${RESERVED_UNIQUE_INDEX_FIX}`);
  verified = present;
  checkedAt = Date.now();
  return present;
}

/** Whether cancel-for-reissue / reuse may run. Fails closed: re-checks the
 *  live index list when the cached answer is older than a minute (or there
 *  is none yet), and treats a failed check as "missing". */
export async function reservedIndexAvailable(): Promise<boolean> {
  if (verified !== null && Date.now() - checkedAt < RESERVED_INDEX_RECHECK_MS) return verified;
  inFlight ??= checkReservedIndex().finally(() => { inFlight = null; });
  return inFlight;
}

/** Forget the cached answer, so the next call re-checks at once. */
export function resetReservedIndexCheck(): void {
  verified = null;
  checkedAt = 0;
}

export async function ensureInvoiceReissueIndexes(
  models: Array<[string, any]> = MODELS,
  log: Pick<Console, "error" | "log"> = console,
): Promise<{ ok: string[]; failed: string[]; reservedUniqueIndex: boolean }> {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const [name, model] of models) {
    try {
      await model.createIndexes(); // idempotent; creates missing, never drops
      ok.push(name);
    } catch (e: any) {
      failed.push(name);
      log.error(`[INVOICE INDEXES] ✖ createIndexes FAILED for ${name}: ${e?.message || e}`);
    }
  }

  resetReservedIndexCheck();
  const reservedUniqueIndex = await checkReservedIndex(log);
  if (!reservedUniqueIndex) {
    log.error(
      `[INVOICE INDEXES] ✖ partial unique index on invoice_number_reservations {number:1} (status RESERVED) is MISSING — cancel-for-reissue and reuse are disabled (503) until it is built. Build it with: ${RESERVED_UNIQUE_INDEX_FIX}`,
    );
  }

  log.log(
    `[INVOICE INDEXES] ensured ${ok.length}/${models.length} model index sets${failed.length ? ` (failed: ${failed.join(", ")})` : ""}; reserved-number unique index ${reservedUniqueIndex ? "present" : "MISSING"}.`,
  );
  return { ok, failed, reservedUniqueIndex };
}
