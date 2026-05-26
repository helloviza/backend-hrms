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
}
export declare function generateHotelVoucherHTML(params: HotelVoucherParams): Promise<string>;
