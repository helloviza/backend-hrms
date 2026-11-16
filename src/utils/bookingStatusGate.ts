// apps/backend/src/utils/bookingStatusGate.ts
//
// The "real booking" fields of a manual booking are gated on its STATUS, for
// every booking (decision 2026-11-16 — this generalises the rule partner lead
// bookings already had, services/partnerLeadBooking.ts):
//
//   - Supplier Name, Given By and a hotel's Check-out date are OPTIONAL while
//     the booking is PENDING or WIP — an enquiry, a lead being worked, a
//     booking parked before the supplier is known;
//   - they are REQUIRED on the TRANSITION into CONFIRMED (Done) — a create
//     at Confirmed, or an edit that moves a row from any other status to
//     Confirmed — regardless of Option B, because a row born without them
//     (public intake, an admin enquiry) must not reach Done without them;
//   - on later saves of a row that is ALREADY Confirmed, Option B applies
//     (routes/manualBookings.ts validateBookingRequiredForUpdate): only an
//     edit that REMOVES a value that was there is refused, so a legacy Done
//     row missing them stays editable (decision 2026-11-16, second pass);
//   - CANCELLED never requires them (Supplier PNR is not checked server
//     side at any status — the form gates it the same way);
//   - SBT-sourced rows (SBT / SBT_AUTO — booked online, imported or mirrored)
//     are never asked for Given By: nobody "gave" them, the import paths are
//     already given-by exempt, and the attachment gate exempts the same
//     sources. Their Supplier Name is still required at Confirmed.
//
// NC leads never reach this function (routes check isNcLead first, see
// utils/ncLead.ts). The frontend mirror is pages/admin/manualBookingPartnerRule.ts.

export const HOTEL_TYPES = ["HOTEL", "DUMMY_HOTEL"];

export const SUPPLIER_NAME_REQUIRED = "Supplier Name is required";
export const GIVEN_BY_REQUIRED = "Given By is required";
export const CHECKOUT_REQUIRED = "Check-out (return) date is required for hotel bookings";

const GATED = new Set([SUPPLIER_NAME_REQUIRED, GIVEN_BY_REQUIRED, CHECKOUT_REQUIRED]);
const OPEN = new Set(["PENDING", "WIP"]);
const GIVEN_BY_EXEMPT_SOURCES = new Set(["SBT", "SBT_AUTO"]);

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();

/**
 * Adjusts a base rule set's errors (validateBookingRequired on create,
 * validateBookingRequiredForUpdate on edit) for the booking's status.
 * `booking` is the booking-to-be on create, the merged document on edit;
 * `previousStatus` is the stored status on edit (omit on create).
 * Output order is stable: supplier, given by, then the remaining base errors
 * (hotel city …), then check-out — the order the base validator uses.
 */
export function statusGatedRequiredErrors(errors: string[], booking: AnyObj, previousStatus?: string): string[] {
  const status = str(booking?.status || "PENDING").toUpperCase();
  if (OPEN.has(status) || status === "CANCELLED") return errors.filter((e) => !GATED.has(e));
  if (status !== "CONFIRMED") return errors;
  // Already Done before this save: the base (Option B) answer stands.
  if (str(previousStatus).toUpperCase() === "CONFIRMED") return errors;

  const isHotel = HOTEL_TYPES.includes(str(booking?.type).toUpperCase());
  const out: string[] = [];
  if (!str(booking?.supplierName)) out.push(SUPPLIER_NAME_REQUIRED);
  const givenByExempt = GIVEN_BY_EXEMPT_SOURCES.has(str(booking?.source).toUpperCase());
  if (!givenByExempt && !str(booking?.givenBy)) out.push(GIVEN_BY_REQUIRED);
  out.push(...errors.filter((e) => !GATED.has(e)));
  if (isHotel && !booking?.returnDate) out.push(CHECKOUT_REQUIRED);
  return out;
}
