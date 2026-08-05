/**
 * apps/backend/src/services/flightService.ts
 * -------------------------------------------
 * Uses FlightAware AeroAPI for real-time flight status.
 * Returns fully structured data matching FlightStatusCard expected shape.
 *
 * AeroAPI Docs: https://flightaware.com/aeroapi/portal/documentation
 * Endpoint: GET /flights/{ident}
 *
 * CRITICAL: AeroAPI uses ICAO idents (e.g. IGO6788), NOT IATA codes (e.g. 6E6788).
 * The website URL confirms this: flightaware.com/live/flight/IGO6788
 * Sending 6E6788 returns empty flights[] even though the flight exists.
 */
import axios from "axios";

const FLIGHTAWARE_KEY = process.env.FLIGHTAWARE_API_KEY;
const AEROAPI_BASE = "https://aeroapi.flightaware.com/aeroapi";

export interface EnhancedFlightInfo {
  flight_status: string;
  airline: { name: string; iata: string };
  flight: { iata: string; number: string };
  departure: {
    iata: string;
    airport: string;
    city: string;
    terminal: string;
    gate: string;
    scheduled: string | null;
    actual: string | null;
  };
  arrival: {
    iata: string;
    airport: string;
    city: string;
    terminal: string;
    gate: string;
    scheduled: string | null;
    estimated: string | null;
  };
  progress_percent?: number;
  source: string;
}

/* ─────────────────────────────────────────────────────────────
 * IATA → ICAO airline prefix map
 * AeroAPI requires ICAO ident. FlightAware website confirms:
 * 6E6788 on site = IGO6788, 6E = IndiGo = ICAO prefix IGO
 * ──────────────────────────────────────────────────────────── */
const IATA_TO_ICAO: Record<string, string> = {
  // India
  "6E": "IGO",   // IndiGo
  "AI": "AIC",   // Air India
  "SG": "SEJ",   // SpiceJet
  "QP": "AKJ",   // Akasa Air
  "UK": "VTI",   // Vistara
  "IX": "IAD",   // Air India Express
  "G8": "GOW",   // GoFirst
  "I5": "IAD",   // Air Asia India
  "S5": "LKD",   // Star Air
  // Southeast Asia
  "VJ": "VJC",   // VietJet
  "VN": "HVN",   // Vietnam Airlines
  "AK": "AXM",   // AirAsia
  "FD": "AIQ",   // Thai AirAsia
  "TG": "THA",   // Thai Airways
  "MH": "MAS",   // Malaysia Airlines
  "TR": "TGW",   // Scoot
  "GA": "GIA",   // Garuda Indonesia
  "JT": "LNI",   // Lion Air
  "PR": "PAL",   // Philippine Airlines
  "5J": "CEB",   // Cebu Pacific
  // Middle East
  "EK": "UAE",   // Emirates
  "QR": "QTR",   // Qatar Airways
  "EY": "ETD",   // Etihad
  "FZ": "FDB",   // flydubai
  "G9": "ABY",   // Air Arabia
  "WY": "OMA",   // Oman Air
  // Europe
  "BA": "BAW",   // British Airways
  "LH": "DLH",   // Lufthansa
  "AF": "AFR",   // Air France
  "KL": "KLM",   // KLM
  "LX": "SWR",   // Swiss
  "OS": "AUA",   // Austrian
  "IB": "IBE",   // Iberia
  "FR": "RYR",   // Ryanair
  "U2": "EZY",   // easyJet
  // Americas
  "AA": "AAL",   // American
  "UA": "UAL",   // United
  "DL": "DAL",   // Delta
  "WN": "SWA",   // Southwest
  "B6": "JBU",   // JetBlue
  "AC": "ACA",   // Air Canada
  // Asia Pacific
  "SQ": "SIA",   // Singapore Airlines
  "CX": "CPA",   // Cathay Pacific
  "JL": "JAL",   // Japan Airlines
  "NH": "ANA",   // ANA
  "KE": "KAL",   // Korean Air
  "OZ": "AAR",   // Asiana
  "QF": "QFA",   // Qantas
  "NZ": "ANZ",   // Air New Zealand
};

/**
 * Convert IATA flight code to ICAO ident for AeroAPI
 * "6E6788" → "IGO6788"
 * "6E-2582" → "IGO2582"
 * If no mapping found, returns original (some airlines use same IATA/ICAO prefix)
 */
function toAeroApiIdent(flightIata: string): string {
  const clean = flightIata.replace(/[-\s]/g, "").toUpperCase();
  // Extract airline prefix (1-2 chars that may start with digit: 6E, AI, SG, QP etc.)
  const match = clean.match(/^(\d?[A-Z]{1,2})(\d{2,4})$/);
  if (!match) return clean;
  const [, iataPrefix, flightNum] = match;
  const icaoPrefix = IATA_TO_ICAO[iataPrefix];
  if (icaoPrefix) {

    return `${icaoPrefix}${flightNum}`;
  }
  // No mapping — try sending as-is (some carriers use same prefix)
  console.warn(`[FlightService] No ICAO mapping for IATA prefix "${iataPrefix}", sending as-is`);
  return clean;
}

/* ─────────────────────────────────────────────────────────────
 * OCCURRENCE SELECTION
 *
 * AeroAPI /flights/{ident} returns MANY occurrences of the same daily flight —
 * confirmed live for AIC4305: 14 rows, ordered NEWEST FIRST, spanning ~10 days
 * back to ~2 days forward. The previous implementation sent no start/end and
 * then took `flights.find(f => f.status !== "Cancelled") || flights[0]`, i.e.
 * the head of a newest-first list — so it always answered with the flight two
 * days from now. Every occurrence is now (a) fetched inside an explicit window
 * and (b) chosen by an explicit rule, and carries its own servedDate so a wrong
 * pick can never again be silent.
 * ──────────────────────────────────────────────────────────── */

/** One occurrence of a flight, with the date it is actually FOR. */
export interface FlightOccurrence extends EnhancedFlightInfo {
  /** Departure date in the ORIGIN airport's local zone (YYYY-MM-DD). */
  servedDate: string;
  /** IANA zones straight off AeroAPI — the card renders each side in its own. */
  originTz: string | null;
  destinationTz: string | null;
  /** Set when nothing upcoming existed and we fell back to a completed flight. */
  isPast?: boolean;
  /** Currently between actual-off and actual-on. */
  isAirborne?: boolean;
}

export interface FlightOccurrencesResult {
  ok: true;
  ident: string;
  /** YYYY-MM-DD the caller asked for, or null when they asked for "next". */
  requestedDate: string | null;
  occurrences: FlightOccurrence[];
}

/** Same not-found shape the card's error state already renders. */
export interface FlightLookupError {
  error: string;
  flight: { iata: string; number: string };
  message: string;
  links: ReturnType<typeof buildFallbackLinks>;
}

export function isFlightLookupError(r: any): r is FlightLookupError {
  return Boolean(r && r.error);
}

const MS_HOUR = 3600_000;
const MS_DAY = 86400_000;

/**
 * AeroAPI refuses an `end` bound more than 2 days ahead:
 *   HTTP 400 {"detail":"Invalid end bound: time is too far in the future (limit: 2 days)"}
 * 47h sits just inside that, leaving an hour of slack for clock skew between us
 * and FlightAware (a hard 48h would 400 intermittently, which is worse than a
 * consistent failure because it looks like flakiness).
 */
export const AEROAPI_MAX_FORWARD_MS = 47 * MS_HOUR;

/**
 * AeroAPI's bounds parser rejects fractional seconds outright:
 *   HTTP 400 {"detail":"Invalid start bound: type is incorrect"}
 * Date#toISOString() always emits them. Applied at the single outbound choke
 * point (fetchOccurrences) rather than at each call site, so a future caller
 * cannot reintroduce it by passing a raw toISOString().
 */
export function toAeroBound(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z");
}

/**
 * Calendar date of an instant in a given IANA zone. "en-CA" formats as
 * YYYY-MM-DD, which is exactly the shape we compare against. Falls back to the
 * UTC date when the zone is unknown — never to the SERVER's local zone, which
 * would reintroduce the very class of bug this fixes.
 */
function localDateIn(iso: string | null | undefined, tz?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  if (!tz) return String(iso).slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return String(iso).slice(0, 10);
  }
}

/** Map one raw AeroAPI flight into our occurrence shape. */
function mapOccurrence(f: any, cleanIata: string): FlightOccurrence {
  const originTz = f?.origin?.timezone || null;
  const destinationTz = f?.destination?.timezone || null;
  const depScheduled = f.scheduled_out || f.scheduled_off || null;
  const airborne = Boolean((f.actual_out || f.actual_off) && !(f.actual_in || f.actual_on));

  return {
    flight_status: normalizeStatus(f.status),
    airline: {
      name: extractAirlineName(cleanIata),
      iata: cleanIata.replace(/\d+/g, ""),
    },
    flight: {
      iata: cleanIata,
      number: f.flight_number || cleanIata.replace(/^\d?[A-Z]+/i, ""),
    },
    departure: {
      iata: f.origin?.code_iata || f.origin?.code || "—",
      airport: f.origin?.name || "Unknown Airport",
      city: f.origin?.city || "",
      terminal: f.terminal_origin || "N/A",
      gate: f.gate_origin || "TBD",
      scheduled: depScheduled,
      actual: f.actual_out || f.actual_off || null,
    },
    arrival: {
      iata: f.destination?.code_iata || f.destination?.code || "—",
      airport: f.destination?.name || "Unknown Airport",
      city: f.destination?.city || "",
      terminal: f.terminal_destination || "N/A",
      gate: f.gate_destination || "TBD",
      scheduled: f.scheduled_in || f.scheduled_on || null,
      estimated: f.estimated_in || f.estimated_on || null,
    },
    progress_percent: f.progress_percent || null,
    source: "flightaware_aeroapi",
    servedDate: localDateIn(depScheduled, originTz),
    originTz,
    destinationTz,
    isAirborne: airborne,
  };
}

/** Bounded AeroAPI fetch. Throws on transport/auth; returns [] on a clean miss. */
async function fetchOccurrences(
  aeroIdent: string,
  startISO: string,
  endISO: string,
): Promise<any[]> {
  const response = await axios.get(`${AEROAPI_BASE}/flights/${aeroIdent}`, {
    headers: {
      "x-apikey": FLIGHTAWARE_KEY as string,
      Accept: "application/json; charset=UTF-8",
    },
    // start/end bound the search to the window we actually care about, instead
    // of accepting AeroAPI's default ~10-day-back window and trusting its head.
    // toAeroBound strips the fractional seconds AeroAPI rejects — see its note.
    params: { start: toAeroBound(startISO), end: toAeroBound(endISO), max_pages: 1 },
    timeout: 10000,
  });
  const flights = response.data?.flights;
  return Array.isArray(flights) ? flights : [];
}

function notFound(cleanIata: string, detail?: string): FlightLookupError {
  return {
    error: "Flight not found",
    flight: { iata: cleanIata, number: cleanIata },
    message:
      detail || `No flight data found for ${cleanIata}. It may not be operating on that date.`,
    links: buildFallbackLinks(cleanIata),
  };
}

/** Shared error translation — identical semantics to the previous implementation. */
function translateAeroError(error: any, cleanIata: string): FlightLookupError {
  console.error("[FlightService] Error:", error?.message);
  if (axios.isAxiosError(error)) {
    console.error("[FlightService] HTTP:", error.response?.status);
    console.error("[FlightService] Body:", JSON.stringify(error.response?.data));
    if (error.response?.status === 401) {
      throw new Error("Invalid FlightAware API key — check FLIGHTAWARE_API_KEY in .env");
    }
    if (error.response?.status === 404) {
      return notFound(cleanIata, `${cleanIata} was not found. It may not be operating today.`);
    }
    if (error.response?.status === 429) {
      throw new Error("FlightAware API rate limit reached — try again shortly");
    }
    // 400 means WE built a bad request (malformed bound, window past AeroAPI's
    // 2-day forward cap) — the service was reached and answered. Carrying the
    // upstream `detail` into the thrown message is the whole point: the generic
    // fall-through below reported this as "couldn't reach the flight-tracking
    // service", which sent us hunting a missing API key while every 400 body in
    // the logs was already naming the real fault.
    if (error.response?.status === 400) {
      const body: any = error.response?.data;
      const detail = body?.detail || body?.title || "no detail returned";
      throw new Error(`AeroAPI rejected the request (400): ${detail}`);
    }
  }
  throw new Error(error?.message || "Failed to fetch flight data");
}

/**
 * INTERACTIVE lookup.
 *
 *  - `date` given  → the occurrence departing on that ORIGIN-LOCAL date. The
 *    window is widened a day either side and then filtered on servedDate,
 *    because a local departure date straddles two UTC dates.
 *  - no `date`     → up to `limit` UPCOMING occurrences (scheduled_out >= now),
 *    soonest first, with a currently-airborne flight promoted to the front.
 *  - nothing upcoming → the most recently departed occurrence, `isPast: true`.
 */
export async function getFlightOccurrences(
  flightIata: string,
  opts: { date?: string | null; limit?: number; now?: Date } = {},
): Promise<FlightOccurrencesResult | FlightLookupError> {
  const cleanIata = flightIata.replace(/[-\s]/g, "").toUpperCase();
  if (!FLIGHTAWARE_KEY) {
    console.error("[FlightService] FLIGHTAWARE_API_KEY is missing from environment!");
    throw new Error("Flight API key not configured");
  }

  const aeroIdent = toAeroApiIdent(flightIata);
  const now = opts.now ?? new Date();
  const limit = Math.max(1, opts.limit ?? 3);
  const requestedDate = opts.date || null;

  // Window: a dated ask brackets that day ±1; an undated ask looks back 6h (to
  // catch a flight already airborne) and forward as far as AeroAPI permits.
  //
  // The forward edge is CLAMPED to AEROAPI_MAX_FORWARD_MS. Both branches used to
  // overshoot the 2-day cap the header note at "OCCURRENCE SELECTION" already
  // recorded — the undated ask asked for +3d unconditionally, and the dated ask
  // asks for date+2d, which is past the cap for any future date. Every such
  // lookup came back 400 and was reported to the user as a service outage.
  const start = requestedDate
    ? new Date(Date.parse(`${requestedDate}T00:00:00Z`) - MS_DAY)
    : new Date(now.getTime() - 6 * MS_HOUR);
  const requestedEnd = requestedDate
    ? new Date(Date.parse(`${requestedDate}T00:00:00Z`) + 2 * MS_DAY)
    : new Date(now.getTime() + 3 * MS_DAY);
  const maxEnd = new Date(now.getTime() + AEROAPI_MAX_FORWARD_MS);
  const end = requestedEnd > maxEnd ? maxEnd : requestedEnd;

  // A date far enough ahead that even its widened start sits past the clamped
  // end is simply outside AeroAPI's horizon. Sending it would produce a start
  // >= end request and a second, differently-worded 400. Say so honestly
  // instead: schedules that far out are not published to this API yet.
  // Deliberately NOT logged: tripWatchWorker polls every 15 min and a watch on
  // a departure more than two days out hits this on every pass. That is the
  // steady state, not an anomaly — warning about it would emit 4 lines/hour per
  // watch and train everyone to ignore this logger. The returned message
  // carries the reason to the one caller that shows it.
  if (start >= end) {
    return notFound(
      cleanIata,
      `Flight schedules for ${cleanIata} aren't published that far ahead yet — live status is available from about two days before departure.`,
    );
  }

  let raw: any[];
  try {
    raw = await fetchOccurrences(aeroIdent, start.toISOString(), end.toISOString());
  } catch (err: any) {
    return translateAeroError(err, cleanIata);
  }

  if (raw.length === 0) {
    console.warn("[FlightService] No occurrences in window for:", aeroIdent, start.toISOString(), end.toISOString());
    return notFound(cleanIata);
  }

  const mapped = raw
    .map((f) => mapOccurrence(f, cleanIata))
    .filter((o) => o.departure.scheduled);

  if (requestedDate) {
    const onDate = mapped.filter((o) => o.servedDate === requestedDate);
    if (onDate.length === 0) {
      // Do NOT silently serve a different day — the caller reports the gap.
      return { ok: true, ident: cleanIata, requestedDate, occurrences: [] };
    }
    return { ok: true, ident: cleanIata, requestedDate, occurrences: onDate.slice(0, 1) };
  }

  const nowMs = now.getTime();
  const byDeparture = (a: FlightOccurrence, b: FlightOccurrence) =>
    Date.parse(a.departure.scheduled as string) - Date.parse(b.departure.scheduled as string);

  const upcoming = mapped
    .filter((o) => Date.parse(o.departure.scheduled as string) >= nowMs)
    .sort(byDeparture);
  const airborne = mapped.filter((o) => o.isAirborne).sort(byDeparture);

  if (upcoming.length > 0 || airborne.length > 0) {
    const seen = new Set<string>();
    const ordered: FlightOccurrence[] = [];
    for (const o of [...airborne, ...upcoming]) {
      const key = String(o.departure.scheduled);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(o);
      if (ordered.length >= limit) break;
    }
    return { ok: true, ident: cleanIata, requestedDate: null, occurrences: ordered };
  }

  // Nothing upcoming — answer with the most recent past occurrence, LABELLED.
  const past = mapped
    .filter((o) => Date.parse(o.departure.scheduled as string) < nowMs)
    .sort(byDeparture);
  const latest = past[past.length - 1];
  if (!latest) return notFound(cleanIata);
  return {
    ok: true,
    ident: cleanIata,
    requestedDate: null,
    occurrences: [{ ...latest, isPast: true }],
  };
}

/**
 * WATCHER lookup — the single occurrence a TripWatch is actually watching.
 *
 * The watcher has always known its flight's departDate but never passed it, so
 * it diffed against whatever sat at the head of the unbounded response (the
 * +2-day occurrence). It now asks for the exact date it is watching.
 */
export async function getFlightOccurrenceForDate(
  flightIata: string,
  departDate: Date | string,
): Promise<FlightOccurrence | FlightLookupError> {
  const d = typeof departDate === "string" ? new Date(departDate) : departDate;
  if (!d || isNaN(d.getTime())) {
    return notFound(flightIata.replace(/[-\s]/g, "").toUpperCase(), "No usable departure date for this watch.");
  }
  const iso = d.toISOString().slice(0, 10);
  const res = await getFlightOccurrences(flightIata, { date: iso, limit: 1 });
  if (isFlightLookupError(res)) return res;
  if (res.occurrences.length === 0) {
    return notFound(res.ident, `No ${res.ident} occurrence found for ${iso}.`);
  }
  return res.occurrences[0];
}

/**
 * DEAD as of 0.3 — no in-repo caller except controllers/flightController.ts,
 * which is itself marked dead. Kept compiling and DELEGATING to the corrected
 * selection so that any unknown external caller gets the right occurrence
 * rather than the old +2-day window head. Remove with the controller once
 * access logs confirm nothing external hits /v1/flights/status.
 */
export const getDelightfulFlightStatus = async (
  flightIata: string,
): Promise<EnhancedFlightInfo | any> => {
  const res = await getFlightOccurrences(flightIata, { limit: 1 });
  if (isFlightLookupError(res)) return res;
  return res.occurrences[0] ?? notFound(res.ident);
};

/* ─────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────── */

function normalizeStatus(status: string): string {
  if (!status) return "Unknown";
  const s = status.toLowerCase();
  if (s.includes("cancel")) return "Cancelled";
  if (s.includes("divert")) return "Diverted";
  if (s.includes("land")) return "Landed";
  if (s.includes("active") || s.includes("en route") || s.includes("enroute")) return "Departed";
  if (s.includes("scheduled")) return "Scheduled";
  if (s.includes("depart")) return "Departed";
  if (s.includes("delay")) return "Delayed";
  if (s.includes("board")) return "Boarding";
  return status;
}

function extractAirlineName(flightCode: string): string {
  const prefix = flightCode.replace(/[-\s]/g, "").match(/^(\d?[A-Z]{1,2})/i)?.[1]?.toUpperCase() || "";

  const airlines: Record<string, string> = {
    "6E": "IndiGo", "AI": "Air India", "SG": "SpiceJet", "QP": "Akasa Air",
    "UK": "Vistara", "IX": "Air India Express", "G8": "GoFirst",
    "S5": "Star Air", "I5": "Air Asia India",
    "VJ": "VietJet Air", "VN": "Vietnam Airlines", "QH": "Bamboo Airways",
    "AK": "AirAsia", "FD": "Thai AirAsia", "TG": "Thai Airways",
    "SL": "Thai Lion Air", "MH": "Malaysia Airlines", "TR": "Scoot",
    "GA": "Garuda Indonesia", "JT": "Lion Air", "PR": "Philippine Airlines",
    "5J": "Cebu Pacific",
    "EK": "Emirates", "QR": "Qatar Airways", "EY": "Etihad Airways",
    "FZ": "flydubai", "G9": "Air Arabia", "WY": "Oman Air",
    "BA": "British Airways", "LH": "Lufthansa", "AF": "Air France",
    "KL": "KLM", "LX": "Swiss Air", "OS": "Austrian Airlines",
    "IB": "Iberia", "SK": "SAS", "AY": "Finnair", "FR": "Ryanair",
    "U2": "easyJet", "W6": "Wizz Air",
    "AA": "American Airlines", "UA": "United Airlines", "DL": "Delta Airlines",
    "WN": "Southwest Airlines", "B6": "JetBlue", "AS": "Alaska Airlines",
    "AC": "Air Canada",
    "SQ": "Singapore Airlines", "CX": "Cathay Pacific", "JL": "Japan Airlines",
    "NH": "ANA", "KE": "Korean Air", "OZ": "Asiana Airlines",
    "CI": "China Airlines", "BR": "EVA Air", "QF": "Qantas",
    "NZ": "Air New Zealand",
  };

  return airlines[prefix] || "Unknown Airline";
}

function buildFallbackLinks(flightCode: string) {
  return {
    flightaware: `https://www.flightaware.com/live/flight/${flightCode}`,
    flightradar: `https://www.flightradar24.com/${flightCode}`,
    ...(flightCode.startsWith("6E") && {
      indigo: "https://www.goindigo.in/flight-status.html",
    }),
  };
}

/* ─────────────────────────────────────────────────────────────
 * FLIGHT ROUTE SEARCH — SerpAPI Google Flights Engine
 *
 * UNUSED-BY-CONCIERGE: searchFlightRoutes() below has no callers on the
 * concierge (Pluto) path — chat flight search uses TBO via
 * utils/plutoFlightSearch.searchFlightsForChat. Left intact pending a separate
 * decision on whether to keep the SerpAPI engine at all.
 * ──────────────────────────────────────────────────────────── */

export interface FlightResult {
  airline:     string;
  airlineCode: string;
  flightNo:    string;
  logoUrl:     string;
  departure:   { time: string; airport: string; iata: string };
  arrival:     { time: string; airport: string; iata: string };
  duration:    string;
  stops:       number;
  stopDetail:  string;
  price:       string;
  priceINR:    string;
  cabin:       string;
  bookUrl:     string;
}

export interface FlightRouteSearchResult {
  origin:      { city: string; iata: string };
  destination: { city: string; iata: string };
  date:        string;
  flights:     FlightResult[];
  cheapest:    FlightResult | null;
  fastest:     FlightResult | null;
  currency:    string;
  source:      string;
}

const SERPAPI_KEY = process.env.SERPAPI_API_KEY;
const SERPAPI_BASE = "https://serpapi.com/search";

const airlineLogo = (iata: string) =>
  `https://pics.avs.io/200/200/${iata.toUpperCase()}.png`;

export async function searchFlightRoutes(
  originIATA: string,
  destinationIATA: string,
  departureDate: string
): Promise<FlightRouteSearchResult> {
  if (!SERPAPI_KEY) {
    throw new Error("SERPAPI_API_KEY not configured");
  }


  const response = await axios.get(SERPAPI_BASE, {
    params: {
      engine:          "google_flights",
      departure_id:    originIATA,
      arrival_id:      destinationIATA,
      outbound_date:   departureDate,
      currency:        "INR",
      hl:              "en",
      type:            "2",
      api_key:         SERPAPI_KEY,
    },
    timeout: 15000,
  });

  const data = response.data;

  const rawFlights = [
    ...(data?.best_flights  || []),
    ...(data?.other_flights || []),
  ];

  if (!rawFlights.length) {
    console.warn("[FlightSearch] No flights returned by SerpAPI");
    return {
      origin:      { city: originIATA, iata: originIATA },
      destination: { city: destinationIATA, iata: destinationIATA },
      date:        departureDate,
      flights:     [],
      cheapest:    null,
      fastest:     null,
      currency:    "INR",
      source:      "serpapi_google_flights",
    };
  }

  const flights: FlightResult[] = rawFlights.map((f: any) => {
    const leg         = f.flights?.[0] || {};
    const lastLeg     = f.flights?.[f.flights.length - 1] || leg;
    const airlineCode = leg.airline_logo
      ? leg.airline_logo.match(/\/([A-Z0-9]{2})\.png/i)?.[1] || "???"
      : "???";

    const stops    = (f.flights?.length || 1) - 1;
    const layovers = f.layovers?.map((l: any) => l.name || l.id).join(", ") || "";

    return {
      airline:     leg.airline     || "Unknown",
      airlineCode,
      flightNo:    leg.flight_number || "—",
      logoUrl:     leg.airline_logo  || airlineLogo(airlineCode),
      departure: {
        time:    leg.departure_airport?.time    || "—",
        airport: leg.departure_airport?.name    || originIATA,
        iata:    leg.departure_airport?.id      || originIATA,
      },
      arrival: {
        time:    lastLeg.arrival_airport?.time  || "—",
        airport: lastLeg.arrival_airport?.name  || destinationIATA,
        iata:    lastLeg.arrival_airport?.id    || destinationIATA,
      },
      duration:   f.total_duration
        ? `${Math.floor(f.total_duration / 60)}h ${f.total_duration % 60}m`
        : "—",
      stops,
      stopDetail: stops === 0 ? "Non-stop" : `${stops} stop${stops > 1 ? "s" : ""}${layovers ? " via " + layovers : ""}`,
      price:      f.price ? `₹${Number(f.price).toLocaleString("en-IN")}` : "—",
      priceINR:   f.price ? String(f.price) : "0",
      cabin:      f.type || "Economy",
      bookUrl:    `https://www.google.com/travel/flights/search?q=flights+from+${originIATA}+to+${destinationIATA}`,
    };
  });

  const withPrice = flights.filter(f => Number(f.priceINR) > 0);
  const cheapest  = withPrice.length
    ? withPrice.reduce((a, b) => Number(a.priceINR) < Number(b.priceINR) ? a : b)
    : flights[0] || null;

  const withDur  = flights.filter(f => f.duration !== "—");
  const fastest  = withDur.length
    ? withDur.reduce((a, b) => a.duration < b.duration ? a : b)
    : flights[0] || null;

  return {
    origin:      { city: originIATA, iata: originIATA },
    destination: { city: destinationIATA, iata: destinationIATA },
    date:        departureDate,
    flights:     flights.slice(0, 8),
    cheapest,
    fastest,
    currency:    "INR",
    source:      "serpapi_google_flights",
  };
}