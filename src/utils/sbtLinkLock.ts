// apps/backend/src/utils/sbtLinkLock.ts
//
// Pure helpers for the SBT → Manual Booking link (docs/specs/sbt-to-manual-booking-spec.md
// §3.1 / §3.3), kept OUT of models/ManualBooking.ts on purpose: many route
// tests replace that model module with a vi.mock factory listing its exports,
// so anything a route or service imports from here must not live there.
// The model imports these too (its save / query guards).

/** Name of the unique partial index on ManualBooking.sbtLink.bookingId. */
export const SBT_LINK_INDEX_NAME = "sbtLink_bookingId_unique";

export const PRICE_LOCKED_CODE = "PRICE_LOCKED";

export class PriceLockedError extends Error {
  code = PRICE_LOCKED_CODE;
  constructor(public fields: string[]) {
    super(`This booking's price comes from SBT and is locked (${fields.join(", ")})`);
  }
}

/** Which locked fields `doc` (as it would be saved) differs on. [] = none or not locked. */
export function lockedPricingChanges(doc: any): string[] {
  const lock = doc?.pricingLocked;
  if (!lock) return [];
  const p = doc.pricing || {};
  const out: string[] = [];
  const money = (a: unknown, b: unknown) => Math.abs((Number(a) || 0) - (Number(b) || 0)) > 0.005;
  if (money(p.actualPrice, lock.actualPrice)) out.push("actualPrice");
  if (money(p.quotedPrice, lock.quotedPrice)) out.push("quotedPrice");
  if ((p.gstMode ?? "ON_MARKUP") !== lock.gstMode) out.push("gstMode");
  if (Number(p.gstPercent ?? 18) !== Number(lock.gstPercent)) out.push("gstPercent");
  if (String(p.currency ?? "INR") !== String(lock.currency)) out.push("currency");
  if (String(doc.type ?? "") !== String(lock.type)) out.push("type");
  if (Array.isArray(doc.lineItems) && doc.lineItems.length > 0) out.push("lineItems");
  return out;
}

/** True for a duplicate-key error on bookingRef (not on any other index). */
export function isBookingRefCollision(err: any): boolean {
  if (err?.code !== 11000) return false;
  const key = err?.keyPattern || err?.keyValue || {};
  return Object.prototype.hasOwnProperty.call(key, "bookingRef") || /bookingRef/.test(String(err?.message || ""));
}

/**
 * Insert a NEW ManualBooking document, retrying when another create took the
 * same bookingRef in the same instant (the ref is count-of-month + 1, see the
 * model's pre-save hook, which reads $locals.bookingRefBump). Any other error —
 * including a duplicate on another unique index — is thrown at once.
 */
export async function saveWithBookingRefRetry(doc: any, attempts = 3): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      return await doc.save();
    } catch (err) {
      if (!isBookingRefCollision(err) || i >= attempts - 1) throw err;
      doc.bookingRef = undefined;
      doc.$locals.bookingRefBump = (Number(doc.$locals.bookingRefBump) || 0) + 1;
    }
  }
}
