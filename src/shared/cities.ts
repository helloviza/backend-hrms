export interface HotelCity {
  cityId: string;        // TBO CityId
  cityName: string;      // display name
  countryCode: string;   // ISO 2-letter, e.g. "IN", "AE"
  countryName: string;   // display, e.g. "India", "UAE"
  preIndexed: boolean;   // preload on backend startup?
}

export const HOTEL_CITIES: readonly HotelCity[] = [
  // India
  { cityId: "130443", cityName: "New Delhi",  countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "144306", cityName: "Mumbai",     countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "111124", cityName: "Bengaluru",  countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "127343", cityName: "Chennai",    countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "145710", cityName: "Hyderabad",  countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "113128", cityName: "Kolkata",    countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "122175", cityName: "Jaipur",     countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "133133", cityName: "Pune",       countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "100263", cityName: "Ahmedabad",  countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "100589", cityName: "Agra",       countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "101204", cityName: "Kochi",      countryCode: "IN", countryName: "India", preIndexed: true },
  { cityId: "145086", cityName: "Udaipur",    countryCode: "IN", countryName: "India", preIndexed: true },

  // NOTE (2026-05-07): International cityIds below are CATALOG REFERENCES ONLY — the runtime
  // hotel index and POST /search both pass the city NAME to TBO's CityList API and resolve
  // the live cityId. Do not rely on the cityId values here being current. See resolveCityCode()
  // in apps/backend/src/jobs/static-data-refresh.ts.

  // International — original
  { cityId: "118924", cityName: "Dubai",         countryCode: "AE", countryName: "United Arab Emirates", preIndexed: true },
  { cityId: "102744", cityName: "Singapore",     countryCode: "SG", countryName: "Singapore",            preIndexed: true },
  { cityId: "105387", cityName: "Bangkok",       countryCode: "TH", countryName: "Thailand",             preIndexed: true },
  { cityId: "130510", cityName: "Paris",         countryCode: "FR", countryName: "France",               preIndexed: true },
  { cityId: "114615", cityName: "London",        countryCode: "GB", countryName: "United Kingdom",       preIndexed: true },
  { cityId: "132483", cityName: "New York",      countryCode: "US", countryName: "United States",        preIndexed: true },

  // GCC — CityIds sourced from sprint spec; not verifiable from existing logs
  { cityId: "100126", cityName: "Abu Dhabi",     countryCode: "AE", countryName: "UAE",                  preIndexed: true },
  { cityId: "101898", cityName: "Doha",          countryCode: "QA", countryName: "Qatar",                preIndexed: true },
  { cityId: "133391", cityName: "Riyadh",        countryCode: "SA", countryName: "Saudi Arabia",         preIndexed: true },
  { cityId: "120426", cityName: "Jeddah",        countryCode: "SA", countryName: "Saudi Arabia",         preIndexed: true },
  { cityId: "128148", cityName: "Muscat",        countryCode: "OM", countryName: "Oman",                 preIndexed: true },

  // South & Southeast Asia — CityIds sourced from sprint spec; not verifiable from existing logs
  { cityId: "118544", cityName: "Kuala Lumpur",  countryCode: "MY", countryName: "Malaysia",             preIndexed: true },
  { cityId: "101638", cityName: "Colombo",       countryCode: "LK", countryName: "Sri Lanka",            preIndexed: true },
  { cityId: "102156", cityName: "Male",          countryCode: "MV", countryName: "Maldives",             preIndexed: true },
  { cityId: "101190", cityName: "Bali",          countryCode: "ID", countryName: "Indonesia",            preIndexed: true },

  // East Asia — CityId sourced from sprint spec; not verifiable from existing logs
  { cityId: "136986", cityName: "Tokyo",         countryCode: "JP", countryName: "Japan",                preIndexed: true },

  // Europe (additional) — CityIds sourced from sprint spec; not verifiable from existing logs
  { cityId: "131048", cityName: "Amsterdam",     countryCode: "NL", countryName: "Netherlands",          preIndexed: true },
  { cityId: "131914", cityName: "Rome",          countryCode: "IT", countryName: "Italy",                preIndexed: true },
];

/** All cities — used by frontend popular-cities grid. */
export const POPULAR_CITIES: readonly HotelCity[] = HOTEL_CITIES;

/** Cities the backend preloads at startup. */
export const HOTEL_INDEX_CITIES: readonly HotelCity[] =
  HOTEL_CITIES.filter((c) => c.preIndexed);
