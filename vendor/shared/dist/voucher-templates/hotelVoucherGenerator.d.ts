import type { OfferItem } from "./ticketGenerator.js";
import { parseTBODate, isCancelDateValid as _isCancelDateValid } from "./cancellationPolicy.js";
export declare const parseCancelDate: typeof parseTBODate;
export declare const isCancelDateValid: typeof _isCancelDateValid;
export declare function formatCancelDate(dateStr: string | null | undefined): string;
export declare function fmtDateShort(d: string): string;
export declare function fmtDayOfWeek(d: string): string;
export declare function extractFirstName(fullName: string): string;
export declare function parseHotelPolicies(raw: unknown): {
    checkInTime: string | null;
    checkOutTime: string | null;
    minimumAge: string | null;
} | null;
export declare function parseAdditionalConditions(raw: unknown): {
    optionalFees: string | null;
    cardsAccepted: string | null;
    earlyCheckOutNote: string;
} | null;
export interface HotelVoucherParams {
    hotelName: string;
    hotelAddress: string;
    supportEmail?: string;
    checkIn: string;
    checkOut: string;
    roomName: string;
    bookingId: string;
    confirmationNo: string;
    bookingRefNo: string;
    invoiceNumber?: string;
    tboReferenceNo?: string | null;
    roomDescription?: string | null;
    rateConditions?: string[];
    amenities?: string[];
    guestFirstName: string;
    leadGuestName: string;
    /**
     * Everyone staying on the booking, lead included, in whatever order the
     * source document listed them. Optional: when absent or when it names only
     * the lead, the voucher renders exactly as it did before.
     */
    allGuestNames?: string[];
    inclusions: string[];
    cancelPolicies: any[];
    displayVoucherStatus: string;
    totalFare?: number;
    qrUrl: string;
    logoBodyBase64?: string;
    offers?: OfferItem[];
    hotelPolicies?: {
        checkInTime?: string | null;
        checkOutTime?: string | null;
        minimumAge?: string | null;
    } | null;
    additionalConditions?: {
        optionalFees?: string | null;
        cardsAccepted?: string | null;
        earlyCheckOutNote?: string | null;
    } | null;
    reconciled: boolean;
    showPrintButton?: boolean;
    isDemo?: boolean;
    /**
     * Where the booking data came from. "sbt" (default): our own TBO booking —
     * rendered exactly as before. "extracted": read off a third party's voucher
     * in /admin/vouchers — the template then claims nothing the document didn't
     * state (cancellation wording, fixed policy lines, ID labels, section names).
     */
    source?: "sbt" | "extracted";
    /** Hotel phone as printed on the source voucher; rendered under the address. */
    hotelPhone?: string | null;
    /** Stay facts as stated on the source; each part prints only when present. */
    stayFacts?: {
        nights?: number | null;
        adults?: number | null;
        children?: number | null;
        /** Head count when the source gives only a total. */
        guests?: number | null;
        rooms?: number | null;
    } | null;
    specialRequests?: string | null;
    /**
     * Extracted only: the cancellation deadline as the source states it.
     * With no cancellation tiers it prints as a neutral line (a deadline alone
     * doesn't make cancelling before it free); with a free tier and a date-only
     * deadline it names the free chip's end so the date printed is the date
     * stated ("before 21 Jun 2026", not "until 20 Jun 2026 23:59").
     */
    cancellationDeadline?: {
        stated: string;
        dateOnly: boolean;
    } | null;
}
export declare function generateHotelVoucherHTML(params: HotelVoucherParams): Promise<string>;
