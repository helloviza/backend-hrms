// Centralized TBO HOTEL endpoint URLs. URLs only — auth headers, payloads,
// retry/session logic, and the no-body-TokenId contract live with their callers.
//
// Defaults equal the current sandbox URLs, so this config changes no behavior
// until the prod base-URL env vars are set. Three bases:
//   - HOTEL_SEARCH_BASE  → Search / PreBook (affiliate HotelAPI)
//   - HOTEL_BOOKING_BASE  → book / GetBookingDetail / GenerateVoucher / change-request
//   - HOTEL_STATIC_BASE  → CountryList / CityList / HotelCodeList / HotelDetails

const stripSlash = (s: string) => s.replace(/\/+$/, "");
const HOTEL_SEARCH_BASE = stripSlash(process.env.TBO_HOTEL_SEARCH_BASE_URL || "https://affiliate.tektravels.com/HotelAPI");
const HOTEL_BOOKING_BASE = stripSlash(process.env.TBO_HOTEL_BOOKING_BASE_URL || "https://hotelbe.tektravels.com/hotelservice.svc/rest");
const HOTEL_STATIC_BASE = stripSlash(process.env.TBO_HOTEL_STATIC_BASE_URL || "https://api.tbotechnology.in/TBOHolidays_HotelAPI");

export const TBO_URLS = {
  SEARCH: `${HOTEL_SEARCH_BASE}/Search`,
  PREBOOK: `${HOTEL_SEARCH_BASE}/PreBook`,
  BOOK: `${HOTEL_BOOKING_BASE}/book/`, // trailing slash REQUIRED
  GET_BOOKING_DETAIL: `${HOTEL_BOOKING_BASE}/GetBookingDetail/`, // trailing slash REQUIRED
  GENERATE_VOUCHER: `${HOTEL_BOOKING_BASE}/GenerateVoucher/`, // trailing slash REQUIRED
  SEND_CHANGE_REQUEST: `${HOTEL_BOOKING_BASE}/SendChangeRequest`, // NO trailing slash
  GET_CHANGE_REQUEST_STATUS: `${HOTEL_BOOKING_BASE}/GetChangeRequestStatus`, // NO trailing slash
  COUNTRY_LIST: `${HOTEL_STATIC_BASE}/CountryList`, // GET
  CITY_LIST: `${HOTEL_STATIC_BASE}/CityList`, // caller appends ?CountryCode=
  TBO_HOTEL_CODE_LIST: `${HOTEL_STATIC_BASE}/TBOHotelCodeList`,
  HOTEL_DETAILS: `${HOTEL_STATIC_BASE}/HotelDetails`,
} as const;
