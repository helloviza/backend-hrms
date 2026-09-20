// apps/backend/src/services/hotelAutofill.ts
//
// Hotel twin of flightAutofill.ts: turns an extracted HOTEL voucher into the
// exact fields the /admin/manual-bookings/new form can take. Pure, no I/O.
//
// The extractor already produces every field this needs — hotel_details /
// stay_details / guest_details / room_details in types/voucher.ts, filled by
// the SAME Gemini schema and normalizer the vouchers module and the sweep
// worker use. This file only MAPS; it adds nothing to the extraction contract.
//
// Field-name contract (form ⇄ voucher), verified against ManualBookingForm's
// hotel block ("HOTEL TYPE") and types/voucher.ts:
//   travelDate  ← stay_details.check_in_date        (form label "Check-in")
//   returnDate  ← stay_details.check_out_date       ("Check-out")
//   hotelName   ← hotel_details.name
//   city        ← hotel_details.city                (form label "City", bound to `sector`)
//   roomType    ← room_details.room_type
//   roomCount   ← room_details.no_of_rooms          (parsed to an integer ≥ 1)
//   nights      ← stay_details.total_nights         (parsed; the form DERIVES nights
//                                                    from the dates and shows this
//                                                    only as a cross-check)
//   supplierPNR ← booking_info.supplier_conf_no, else booking_id, else voucher_no
//                                                   (form label "Booking ID / PNR")
//   supplierName — NO source on the voucher; always null
//   guests[]    ← guest_details.all_guest_names, with primary_guest first;
//                 a hotel voucher carries no per-guest type/email/phone, so a
//                 guest row is a name only. adults/children are totals, not
//                 attributable to a name, and are not used.
import type { PlumtripsVoucher } from "../types/index.js";
import { parseTicketDate } from "./flightAutofill.js";

export interface HotelAutofillGuest {
  name: string;
}

export interface HotelAutofill {
  travelDate: string | null;
  travelDateRaw: string | null;
  returnDate: string | null;
  returnDateRaw: string | null;
  hotelName: string | null;
  city: string | null;
  roomType: string | null;
  roomCount: number | null;
  nights: number | null;
  supplierPNR: string | null;
  supplierName: null;
  guests: HotelAutofillGuest[];
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/** "2", "2 rooms", "Rooms: 2", "02" → 2. Anything without a leading integer → null. */
export function parseCount(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : null;
  const m = String(raw).match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 ? n : null;
}

/** Dedupe by case-insensitive name, keep first spelling, drop blanks. */
function uniqueNames(names: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const s = str(n);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Build the form fill from a voucher. Returns null when the voucher is not a
 * hotel or carries nothing the form could use (no hotel name, no dates, no
 * guests) — the caller then treats it as "nothing to fill".
 */
export function buildHotelAutofill(voucher: PlumtripsVoucher | null | undefined): HotelAutofill | null {
  if (!voucher || voucher.type !== "hotel") return null;

  const hotel = voucher.hotel_details;
  const stay = voucher.stay_details;
  const room = voucher.room_details;
  const guestDetails = voucher.guest_details;
  const bi = voucher.booking_info;

  const checkInRaw = str(stay?.check_in_date);
  const checkOutRaw = str(stay?.check_out_date);

  const guests = uniqueNames([
    guestDetails?.primary_guest,
    ...(Array.isArray(guestDetails?.all_guest_names) ? guestDetails!.all_guest_names : []),
  ]).map((name) => ({ name }));

  const hotelName = str(hotel?.name);
  if (!hotelName && !checkInRaw && !checkOutRaw && !guests.length) return null;

  return {
    travelDate: parseTicketDate(checkInRaw),
    travelDateRaw: checkInRaw,
    returnDate: parseTicketDate(checkOutRaw),
    returnDateRaw: checkOutRaw,
    hotelName,
    city: str(hotel?.city),
    roomType: str(room?.room_type),
    roomCount: parseCount(room?.no_of_rooms),
    nights: parseCount(stay?.total_nights),
    supplierPNR: str(bi?.supplier_conf_no) ?? str(bi?.booking_id) ?? str(bi?.voucher_no),
    supplierName: null,
    guests,
  };
}
