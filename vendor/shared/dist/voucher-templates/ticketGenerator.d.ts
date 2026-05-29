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
    passengers: {
        title: string;
        firstName: string;
        lastName: string;
        paxType: string;
        isLead: boolean;
    }[];
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
export declare function generateReturnPageHTML(rb: TicketBooking, logoUrl?: string): Promise<string>;
export declare function generateTicketHTML(b: TicketBooking, offers?: OfferItem[], returnBooking?: TicketBooking, logoUrl?: string, showPrintButton?: boolean): Promise<string>;
