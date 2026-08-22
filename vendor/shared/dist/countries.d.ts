export declare const VISA_COUNTRY_REGIONS: readonly ["GULF", "MIDDLE_EAST", "SOUTHEAST_ASIA", "SCHENGEN", "EUROPE", "AMERICAS", "OCEANIA", "EAST_ASIA", "SOUTH_ASIA", "AFRICA", "CENTRAL_ASIA"];
export type VisaCountryRegion = (typeof VISA_COUNTRY_REGIONS)[number];
export interface Country {
    /** ISO 3166-1 alpha-2, e.g. "IN". The key everything else hangs off. */
    iso2: string;
    /** ISO 3166-1 name, e.g. "Viet Nam". Present on all 249. */
    name: string;
    /** Common name where it differs from `name` — see the header. 6 entries. */
    commonName?: string;
    /** ISO 3166-1 alpha-3 / ICAO MRZ issuing-state code. 120 entries. */
    iso3?: string;
    /** Primary demonym, e.g. "Indian". 120 entries. */
    demonym?: string;
    /** Destination-picker grouping. 120 entries. */
    region?: VisaCountryRegion;
    /** Additional accepted names/demonyms/abbreviations, for the resolver. */
    aliases?: string[];
}
/** All 249, in ISO-name order — the order a picker should render. */
export declare const COUNTRIES: readonly Country[];
/**
 * Resolve ISO2, ISO3, a country name, a common name, a demonym or an
 * alias to ISO 3166-1 alpha-2. Returns null for anything unrecognised —
 * never throws, since this runs on user-entered and OCR'd text.
 */
export declare function normaliseToIso2(input: string | null | undefined): string | null;
/** The full entry, or undefined for an unknown code. */
export declare function getCountryByIso2(iso2: string | null | undefined): Country | undefined;
/**
 * The country's ISO 3166-1 name — "India", "Viet Nam".
 *
 * Null for an unknown code rather than the code itself: a caller that
 * wants a fallback should say so, and returning "ZZ" from a function
 * called getCountryName would put a code on screen where a name belongs.
 */
export declare function getCountryName(iso2: string | null | undefined): string | null;
/**
 * The name a CONSUMER surface should show — "Vietnam", "South Korea",
 * "Czechia". See the header for why this is `commonName ?? name` and why
 * that is correct for CZ too.
 *
 * Separate from getCountryName() so the B2B screens, which have always
 * rendered the ISO form, do not shift under a consumer-side change.
 */
export declare function getCountryDisplayName(iso2: string | null | undefined): string | null;
/**
 * The demonym — "Indian" — falling back to the country's DISPLAY name
 * where we hold no demonym.
 *
 * The fallback is the whole point: only 120 of the 249 carry a demonym,
 * so a nationality field backed by the full list would otherwise render
 * nothing for 129 real countries. "Afghanistan" in a Nationality field is
 * slightly off register; blank is a bug.
 */
export declare function getDemonymOrName(iso2: string | null | undefined): string | null;
