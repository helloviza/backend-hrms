// apps/backend/src/utils/bookingLegs.ts
//
// Read-side helpers over ManualBooking.itinerary.legs[] (Step 4, Piece 3),
// shared by the staff export (routes/manualBookings.ts bookingToRow), the
// customer export (routes/myBookings.ts customerBookingFields) and the
// invoice sub-description (utils/invoiceLineItems.ts) so all three print a
// multi-leg trip the same way. Pure; no model import.
//
// Legacy rows have NO legs path (undefined under .lean(), [] on a hydrated
// doc) — every helper here returns "" / [] for them, so the appended export
// columns are blank and the invoice falls back to the flat fields exactly
// as before. Nothing here ever explodes a booking into per-leg rows or
// lines: money stays one-row-per-booking.

export interface BookingLegLike {
  origin?: string | null;
  destination?: string | null;
  flightNo?: string | null;
  airline?: string | null;
  departDate?: Date | string | null;
}

/** The legs array, or [] when absent/empty — the one guard every reader uses. */
export function bookingLegs(b: any): BookingLegLike[] {
  const legs = b?.itinerary?.legs;
  return Array.isArray(legs) && legs.length ? legs : [];
}

/** ONE_WAY | ROUND_TRIP | MULTI_CITY, or "" for non-flight / legacy rows. */
export function bookingTripType(b: any): string {
  return bookingLegs(b).length ? String(b?.itinerary?.tripType ?? "") : "";
}

const code = (v: unknown) => String(v ?? "").trim().toUpperCase();

/**
 * Every airport in order, joined with `sep`: "DEL→BOM→DEL". A leg whose
 * origin doesn't chain from the previous destination (a surface break in a
 * multi-city trip) prints both codes so nothing is hidden: "DEL→BOM / GOI→BLR"
 * becomes "DEL→BOM→GOI→BLR" only when BOM===GOI. Empty for legacy rows.
 */
export function bookingLegRoute(b: any, sep = "→"): string {
  const legs = bookingLegs(b);
  if (!legs.length) return "";
  const out: string[] = [code(legs[0].origin)];
  for (let i = 0; i < legs.length; i++) {
    const o = code(legs[i].origin);
    const d = code(legs[i].destination);
    if (i > 0 && o && o !== out[out.length - 1]) out.push(o);
    out.push(d);
  }
  return out.filter(Boolean).join(sep);
}

/** Distinct carriers + flight numbers in leg order: "Air India AI302 / Air India AI303". */
export function bookingLegCarriers(b: any): string {
  return bookingLegs(b)
    .map((l) => [String(l.airline ?? "").trim(), String(l.flightNo ?? "").trim()].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" / ");
}

function fmtDMY(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return "";
  return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
}

/**
 * One cell, one leg per numbered entry, same convention as the export's
 * "Line Items" column (flattened into ONE cell, never extra rows):
 *   "1. DEL→BOM AI302 Air India 15/10/2026 | 2. BOM→DEL AI303 Air India 20/10/2026"
 * Dates use the exports' dd/mm/yyyy. Empty for legacy rows.
 */
export function bookingLegDetail(b: any): string {
  return bookingLegs(b)
    .map((l, i) => {
      const bits = [
        `${code(l.origin)}→${code(l.destination)}`,
        String(l.flightNo ?? "").trim(),
        String(l.airline ?? "").trim(),
        fmtDMY(l.departDate),
      ].filter(Boolean);
      return `${i + 1}. ${bits.join(" ")}`;
    })
    .join(" | ");
}
