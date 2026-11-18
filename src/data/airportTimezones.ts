// apps/backend/src/data/airportTimezones.ts
//
// Time zone of a departure airport, so a departure time printed on a foreign
// ticket (local time) can be converted to IST for Travel Spend's departure
// time panel (Phase B additions, 2026-11-18). India departures need nothing:
// the printed time is already IST.
//
// Countries with ONE time zone map by country (COUNTRY_TZ). Countries with
// several (US, CA, AU, RU, BR, MX, ID, KZ, and the Spanish/Portuguese
// islands) map per airport (AIRPORT_TZ); an airport there that isn't listed
// returns null and the caller skips it rather than guess.

/** Single-zone countries, ISO-2 → IANA zone. */
export const COUNTRY_TZ: Record<string, string> = {
  AE: "Asia/Dubai", AM: "Asia/Yerevan", AR: "America/Argentina/Buenos_Aires", AT: "Europe/Vienna", AZ: "Asia/Baku",
  BD: "Asia/Dhaka", BE: "Europe/Brussels", BG: "Europe/Sofia", BH: "Asia/Bahrain", BT: "Asia/Thimphu",
  CH: "Europe/Zurich", CN: "Asia/Shanghai", CY: "Asia/Nicosia", CZ: "Europe/Prague", DE: "Europe/Berlin",
  DK: "Europe/Copenhagen", EE: "Europe/Tallinn", EG: "Africa/Cairo", ES: "Europe/Madrid", ET: "Africa/Addis_Ababa",
  FI: "Europe/Helsinki", FR: "Europe/Paris", GB: "Europe/London", GE: "Asia/Tbilisi", GR: "Europe/Athens",
  HK: "Asia/Hong_Kong", HR: "Europe/Zagreb", HU: "Europe/Budapest", IE: "Europe/Dublin", IL: "Asia/Jerusalem",
  IQ: "Asia/Baghdad", IR: "Asia/Tehran", IS: "Atlantic/Reykjavik", IT: "Europe/Rome", JO: "Asia/Amman",
  JP: "Asia/Tokyo", KE: "Africa/Nairobi", KH: "Asia/Phnom_Penh", KR: "Asia/Seoul", KW: "Asia/Kuwait",
  LA: "Asia/Vientiane", LK: "Asia/Colombo", LT: "Europe/Vilnius", LU: "Europe/Luxembourg", LV: "Europe/Riga",
  MA: "Africa/Casablanca", MM: "Asia/Yangon", MO: "Asia/Macau", MT: "Europe/Malta", MU: "Indian/Mauritius",
  MV: "Indian/Maldives", MY: "Asia/Kuala_Lumpur", NG: "Africa/Lagos", NL: "Europe/Amsterdam", NO: "Europe/Oslo",
  NP: "Asia/Kathmandu", NZ: "Pacific/Auckland", OM: "Asia/Muscat", PH: "Asia/Manila", PK: "Asia/Karachi",
  PL: "Europe/Warsaw", PT: "Europe/Lisbon", QA: "Asia/Qatar", RO: "Europe/Bucharest", RS: "Europe/Belgrade",
  RW: "Africa/Kigali", SA: "Asia/Riyadh", SC: "Indian/Mahe", SE: "Europe/Stockholm", SG: "Asia/Singapore",
  SI: "Europe/Ljubljana", SK: "Europe/Bratislava", TH: "Asia/Bangkok", TR: "Europe/Istanbul", TW: "Asia/Taipei",
  TZ: "Africa/Dar_es_Salaam", UG: "Africa/Kampala", UZ: "Asia/Tashkent", VN: "Asia/Ho_Chi_Minh", ZA: "Africa/Johannesburg",
  IN: "Asia/Kolkata",
};

/** Countries with more than one zone — only the airports listed below resolve. */
export const MULTI_TZ_COUNTRIES = new Set(["US", "CA", "AU", "RU", "BR", "MX", "ID", "KZ", "CL"]);

/** Per-airport zones (multi-zone countries, plus islands that differ from their country). */
export const AIRPORT_TZ: Record<string, string> = {
  // United States
  JFK: "America/New_York", EWR: "America/New_York", LGA: "America/New_York", BOS: "America/New_York",
  IAD: "America/New_York", DCA: "America/New_York", BWI: "America/New_York", PHL: "America/New_York",
  ATL: "America/New_York", MCO: "America/New_York", MIA: "America/New_York", FLL: "America/New_York",
  CLT: "America/New_York", DTW: "America/New_York", TPA: "America/New_York", RDU: "America/New_York",
  ORD: "America/Chicago", MDW: "America/Chicago", MSP: "America/Chicago", DFW: "America/Chicago",
  IAH: "America/Chicago", AUS: "America/Chicago", BNA: "America/Chicago", MSY: "America/Chicago",
  STL: "America/Chicago", MCI: "America/Chicago", DEN: "America/Denver", SLC: "America/Denver",
  PHX: "America/Phoenix", LAX: "America/Los_Angeles", SFO: "America/Los_Angeles", SAN: "America/Los_Angeles",
  SEA: "America/Los_Angeles", SJC: "America/Los_Angeles", PDX: "America/Los_Angeles", LAS: "America/Los_Angeles",
  OAK: "America/Los_Angeles", HNL: "Pacific/Honolulu", ANC: "America/Anchorage",
  // Canada
  YYZ: "America/Toronto", YUL: "America/Toronto", YOW: "America/Toronto", YVR: "America/Vancouver",
  YYC: "America/Edmonton", YEG: "America/Edmonton", YWG: "America/Winnipeg", YHZ: "America/Halifax",
  // Australia
  SYD: "Australia/Sydney", CBR: "Australia/Sydney", MEL: "Australia/Melbourne", AVV: "Australia/Melbourne",
  BNE: "Australia/Brisbane", OOL: "Australia/Brisbane", CNS: "Australia/Brisbane", PER: "Australia/Perth",
  ADL: "Australia/Adelaide", DRW: "Australia/Darwin", HBA: "Australia/Hobart",
  // Russia, Brazil, Mexico, Indonesia, Kazakhstan, Chile
  SVO: "Europe/Moscow", DME: "Europe/Moscow", VKO: "Europe/Moscow", LED: "Europe/Moscow",
  GRU: "America/Sao_Paulo", GIG: "America/Sao_Paulo", MEX: "America/Mexico_City", CUN: "America/Cancun",
  CGK: "Asia/Jakarta", DPS: "Asia/Makassar", ALA: "Asia/Almaty", NQZ: "Asia/Almaty", SCL: "America/Santiago",
  // Islands whose zone differs from the country default
  LPA: "Atlantic/Canary", TFS: "Atlantic/Canary", TFN: "Atlantic/Canary", ACE: "Atlantic/Canary", FUE: "Atlantic/Canary",
  PDL: "Atlantic/Azores",
};

/**
 * Zone for a departure airport. `code` is the IATA code from the ticket,
 * `country` the ISO-2 country it resolved to. Null when unknown — including
 * any airport in a multi-zone country that isn't listed.
 */
export function departureTimeZone(code: unknown, country: string | null | undefined): string | null {
  const c = String(code ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(c) && AIRPORT_TZ[c]) return AIRPORT_TZ[c];
  const k = String(country ?? "").toUpperCase();
  if (!k || MULTI_TZ_COUNTRIES.has(k)) return null;
  return COUNTRY_TZ[k] ?? null;
}

/** Offset of `tz` from UTC, in minutes, at the instant `utcMs`. */
export function tzOffsetMinutes(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * The UTC instant of a local wall-clock time. `dayUtcMs` is Date.UTC of the
 * local calendar date, `minutes` minutes past local midnight. DST-correct:
 * the offset is re-read at the candidate instant.
 */
export function localToUtcMs(dayUtcMs: number, minutes: number, tz: string): number {
  const wall = dayUtcMs + minutes * 60000;
  const off1 = tzOffsetMinutes(tz, wall);
  let utc = wall - off1 * 60000;
  const off2 = tzOffsetMinutes(tz, utc);
  if (off2 !== off1) utc = wall - off2 * 60000;
  return utc;
}

/** Minutes past midnight IST of a UTC instant. */
export function istMinutesOf(utcMs: number): number {
  const day = 86400000;
  return Math.floor((((utcMs + 330 * 60000) % day) + day) % day / 60000);
}
