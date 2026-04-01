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

export const getDelightfulFlightStatus = async (
  flightIata: string
): Promise<EnhancedFlightInfo | any> => {
  try {

    if (!FLIGHTAWARE_KEY) {
      console.error("[FlightService] FLIGHTAWARE_API_KEY is missing from environment!");
      throw new Error("Flight API key not configured");
    }

    // Normalize IATA → ICAO ident for AeroAPI
    const aeroIdent = toAeroApiIdent(flightIata);
    const cleanIata = flightIata.replace(/[-\s]/g, "").toUpperCase();

    // ✅ FlightAware AeroAPI — /flights/{ident}
    const response = await axios.get(`${AEROAPI_BASE}/flights/${aeroIdent}`, {
      headers: {
        "x-apikey": FLIGHTAWARE_KEY,
        "Accept": "application/json; charset=UTF-8",
      },
      params: {
        max_pages: 1,
      },
      timeout: 10000,
    });


    const flights = response.data?.flights;

    if (!flights || flights.length === 0) {
      console.warn("[FlightService] No flights found for:", aeroIdent);
      return {
        error: "Flight not found",
        flight: { iata: cleanIata, number: cleanIata },
        message: `No flight data found for ${cleanIata}. It may not be operating today.`,
        links: buildFallbackLinks(cleanIata),
      };
    }

    // Take the most recent / currently active flight
    const f = flights.find((fl: any) => fl.status !== "Cancelled") || flights[0];


    return {
      flight_status: normalizeStatus(f.status),
      airline: {
        name: extractAirlineName(cleanIata),
        iata: cleanIata.replace(/\d+/g, ""),
      },
      flight: {
        iata: cleanIata,   // return original IATA code for display
        number: f.flight_number || cleanIata.replace(/^\d?[A-Z]+/i, ""),
      },
      departure: {
        iata: f.origin?.code_iata || f.origin?.code || "—",
        airport: f.origin?.name || "Unknown Airport",
        city: f.origin?.city || "",
        terminal: f.terminal_origin || "N/A",
        gate: f.gate_origin || "TBD",
        scheduled: f.scheduled_out || f.scheduled_off || null,
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
    };
  } catch (error: any) {
    console.error("[FlightService] Error:", error?.message);

    if (axios.isAxiosError(error)) {
      console.error("[FlightService] HTTP:", error.response?.status);
      console.error("[FlightService] Body:", JSON.stringify(error.response?.data));

      if (error.response?.status === 401) {
        throw new Error("Invalid FlightAware API key — check FLIGHTAWARE_API_KEY in .env");
      }

      if (error.response?.status === 404) {
        const cleanFlight = flightIata.replace(/[-\s]/g, "").toUpperCase();
        return {
          error: "Flight not found",
          flight: { iata: cleanFlight, number: cleanFlight },
          message: `${cleanFlight} was not found. It may not be operating today.`,
          links: buildFallbackLinks(cleanFlight),
        };
      }

      if (error.response?.status === 429) {
        throw new Error("FlightAware API rate limit reached — try again shortly");
      }
    }

    throw new Error(error?.message || "Failed to fetch flight data");
  }
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