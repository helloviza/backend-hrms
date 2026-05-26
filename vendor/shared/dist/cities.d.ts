/**
 * Shared hotel city catalog.
 * Single source of truth for both frontend (search UI popular
 * cities) and backend (startup hotel-code index).
 *
 * When adding a city:
 *  - preIndexed: true  → backend preloads hotel codes at startup
 *  - preIndexed: false → frontend shows it, backend fetches on demand
 */
export interface HotelCity {
    cityId: string;
    cityName: string;
    countryCode: string;
    countryName: string;
    preIndexed: boolean;
}
export declare const HOTEL_CITIES: readonly HotelCity[];
/** All cities — used by frontend popular-cities grid. */
export declare const POPULAR_CITIES: readonly HotelCity[];
/** Cities the backend preloads at startup. */
export declare const HOTEL_INDEX_CITIES: readonly HotelCity[];
