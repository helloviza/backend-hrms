export declare const CABIN_MAP: Record<number, string>;
export interface OfferItem {
    enabled: boolean;
    title: string;
    description: string;
    ctaText: string;
    ctaUrl: string;
    bgColor: string;
    imageUrl: string;
}
/** @deprecated use OfferItem */
export type OfferConfig = OfferItem;
/**
 * One row of the passenger manifest.
 *
 * The optional fields carry values that genuinely vary per passenger on a real
 * ticket. They are optional so existing callers (the SBT booking flow) keep
 * rendering exactly as before; when a field is absent the manifest falls back to
 * the booking-level value and then to the template's own default.
 */
export interface TicketPassenger {
    title: string;
    firstName: string;
    lastName: string;
    paxType: string;
    isLead: boolean;
    /** Per-passenger e-ticket number; falls back to the booking-level ticketId. */
    ticketNumber?: string | null;
    /** Allowances exactly as printed on the source document ("25 Kgs/adult", "1PC"). */
    checkInBaggage?: string | null;
    cabinBaggage?: string | null;
    seat?: string | null;
    meal?: string | null;
}
export interface TicketBooking {
    pnr: string;
    bookingId: string;
    ticketId: string;
    status: string;
    origin: {
        code: string;
        city: string;
    };
    destination: {
        code: string;
        city: string;
    };
    departureTime: string;
    arrivalTime: string;
    airlineCode: string;
    airlineName: string;
    flightNumber: string;
    cabin: number;
    passengers: TicketPassenger[];
    /**
     * Leg-level allowance, used when a passenger carries no value of its own.
     * Allowance is a property of the segment + fare, so it differs between legs.
     */
    checkInBaggage?: string | null;
    cabinBaggage?: string | null;
    /**
     * How this leg is titled on its own page: "Return" (default), "Onward", or
     * "Connecting". Reads into "<label> Journey" / "<label> E-Ticket" /
     * "<label> Flight", so it must be a bare adjective, not a sentence.
     */
    legLabel?: string | null;
    baseFare: number;
    taxes: number;
    extras: number;
    totalFare: number;
    currency: string;
    isLCC: boolean;
    bookedAt?: string;
    createdAt: string;
    isDemo?: boolean;
}
export declare function getWebCheckInUrl(airline: string, pnr: string): string;
export declare function generateFlightSection(b: TicketBooking, segmentLabel: string): string;
/**
 * One extra page for a leg beyond the first. `opts` lets a 3+ leg itinerary
 * title each page and number it correctly; the defaults reproduce the original
 * two-page round-trip wording exactly.
 */
export declare function generateReturnPageHTML(rb: TicketBooking, logoUrl?: string, opts?: {
    pageIndex?: number;
    totalPages?: number;
}): Promise<string>;
export declare function generateTicketHTML(b: TicketBooking, offers?: OfferItem[], returnBooking?: TicketBooking | TicketBooking[], logoUrl?: string, showPrintButton?: boolean): Promise<string>;
