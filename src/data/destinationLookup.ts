/**
 * destinationLookup.ts — canonical city / country resolution for the
 * TravelBooking "cities only" Top Destinations panel.
 *
 * Built by hand from the REAL distinct `destination` values that appear in the
 * travelbookings collection (enumerated read-only in the profiling pass,
 * 2026-05-23). Keyed by the raw value, case-insensitive (see `normKey`).
 *
 * Each entry resolves to { city, country (ISO-2), international }:
 *   - city          canonical city name (variants/IATA collapse to ONE name)
 *   - country       ISO-3166-1 alpha-2, or null if unknown
 *   - international  derived: null if country unknown, else country !== "IN"
 *
 * EXPLICIT UNRESOLVED PATH (decision A1 — never guess a city):
 *   - Any value NOT present here returns null from lookupDestination().
 *   - Hotel/property names are deliberately ABSENT → they resolve to null.
 *   - Some entries carry { city: null, country: "XX" }: the value names a
 *     country/state/region (e.g. "Vietnam", "Odisha"), so a country is known
 *     but no honest city can be assigned → excluded from the city ranking.
 *
 * LOW_CONFIDENCE lists values placed tentatively (or deliberately left out)
 * that a human should adjudicate — see export at the bottom.
 */

export type DestinationEntry = {
  city: string | null;
  country: string | null; // ISO-2
  international: boolean | null;
};

/** Factory: derive `international` from country so it never drifts. */
function e(city: string | null, country: string | null): DestinationEntry {
  return { city, country, international: country == null ? null : country !== "IN" };
}

/**
 * Normalize a raw value to a lookup key:
 *  - decode the one HTML entity seen in data (&amp;)
 *  - lowercase, trim, collapse internal whitespace
 *  - strip surrounding quotes
 */
export function normKey(raw: unknown): string {
  if (raw == null) return "";
  return String(raw)
    .replace(/&amp;/gi, "&")
    .toLowerCase()
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ────────────────────────────────────────────────────────────────────────
 * THE TABLE — every distinct destination value observed, plus the sector
 * city values needed for Tier-4 hotel-row recovery.
 * ──────────────────────────────────────────────────────────────────────── */
export const DESTINATION_LOOKUP: Record<string, DestinationEntry> = {
  // ── India: metros & major cities (IATA code + name variants collapse to one) ──
  "del": e("Delhi", "IN"),
  "delhi": e("Delhi", "IN"),
  "new delhi": e("Delhi", "IN"),
  "bom": e("Mumbai", "IN"),
  "mumbai": e("Mumbai", "IN"),
  "bombay": e("Mumbai", "IN"),
  "bombay/ mumbai": e("Mumbai", "IN"),
  "ccu": e("Kolkata", "IN"),
  "kolkata": e("Kolkata", "IN"),
  "calcutta": e("Kolkata", "IN"),
  "maa": e("Chennai", "IN"),
  "chennai": e("Chennai", "IN"),
  "madras": e("Chennai", "IN"),
  "blr": e("Bengaluru", "IN"),
  "bengaluru": e("Bengaluru", "IN"),
  "bangalore": e("Bengaluru", "IN"),
  "bengalore": e("Bengaluru", "IN"), // misspelling seen in sector
  "hyd": e("Hyderabad", "IN"),
  "hyderabad": e("Hyderabad", "IN"),
  "hyderbad": e("Hyderabad", "IN"), // misspelling seen in data
  "amd": e("Ahmedabad", "IN"),
  "ahmedabad": e("Ahmedabad", "IN"),
  "ahemdabad": e("Ahmedabad", "IN"), // misspelling seen in data
  "cok": e("Kochi", "IN"),
  "kochi": e("Kochi", "IN"),
  "cochin": e("Kochi", "IN"),
  "pnq": e("Pune", "IN"),
  "pune": e("Pune", "IN"),
  "jai": e("Jaipur", "IN"),
  "jaipur": e("Jaipur", "IN"),
  "jdh": e("Jodhpur", "IN"),
  "jodhpur": e("Jodhpur", "IN"),
  "lko": e("Lucknow", "IN"),
  "lucknow": e("Lucknow", "IN"),
  "vtz": e("Visakhapatnam", "IN"),
  "vizag": e("Visakhapatnam", "IN"),
  "visakhapatnam": e("Visakhapatnam", "IN"),
  "vga": e("Vijayawada", "IN"),
  "vijayawada": e("Vijayawada", "IN"),
  "bbi": e("Bhubaneswar", "IN"),
  "bhubaneswar": e("Bhubaneswar", "IN"),
  "bhubaneshwar": e("Bhubaneswar", "IN"), // spelling variant seen in data
  "pat": e("Patna", "IN"),
  "patna": e("Patna", "IN"),
  "nag": e("Nagpur", "IN"),
  "nagpur": e("Nagpur", "IN"),
  "cjb": e("Coimbatore", "IN"),
  "coimbatore": e("Coimbatore", "IN"),
  "sxr": e("Srinagar", "IN"),
  "srinagar": e("Srinagar", "IN"),
  "ixr": e("Ranchi", "IN"),
  "ranchi": e("Ranchi", "IN"),
  "gau": e("Guwahati", "IN"),
  "guwahati": e("Guwahati", "IN"),
  "ded": e("Dehradun", "IN"),
  "dehradun": e("Dehradun", "IN"),
  "idr": e("Indore", "IN"),
  "indore": e("Indore", "IN"),
  "ixc": e("Chandigarh", "IN"),
  "chandigarh": e("Chandigarh", "IN"),
  "bho": e("Bhopal", "IN"),
  "bhopal": e("Bhopal", "IN"),
  "rpr": e("Raipur", "IN"),
  "raipur": e("Raipur", "IN"),
  "dbr": e("Darbhanga", "IN"), // IATA DBR = Darbhanga
  "darbhanga": e("Darbhanga", "IN"),
  "klh": e("Kolhapur", "IN"), // IATA KLH = Kolhapur
  "kolhapur": e("Kolhapur", "IN"),
  "kohlapur": e("Kolhapur", "IN"), // misspelling seen in data
  "isk": e("Nashik", "IN"), // IATA ISK = Nashik (LOW_CONFIDENCE)
  "nashik": e("Nashik", "IN"),
  "kqh": e("Kishangarh", "IN"), // IATA KQH = Kishangarh / Ajmer (LOW_CONFIDENCE)
  "kishangarh": e("Kishangarh", "IN"),
  "gurgaon": e("Gurugram", "IN"),
  "gurugram": e("Gurugram", "IN"),
  "faridabad": e("Faridabad", "IN"),
  "udaipur": e("Udaipur", "IN"),
  "tirupati": e("Tirupati", "IN"),
  "kakinada": e("Kakinada", "IN"),
  "kashipur": e("Kashipur", "IN"),
  "alibag": e("Alibag", "IN"),
  "silvassa": e("Silvassa", "IN"),
  "navi mumbai": e("Mumbai", "IN"), // adjudicated: merge into Mumbai metro
  "haridwar": e("Haridwar", "IN"),
  "varanasi": e("Varanasi", "IN"),
  "bikaner": e("Bikaner", "IN"),
  "koraput": e("Koraput", "IN"), // small district town (LOW_CONFIDENCE)

  // ── India: Delhi sub-localities (sector values for Tier-4 hotel recovery) ──
  "saket": e("Delhi", "IN"),
  "aerocity": e("Delhi", "IN"),
  "connaught place": e("Delhi", "IN"),
  "lajpat nagar": e("Delhi", "IN"),
  "patel nagar": e("Delhi", "IN"),

  // ── India: state / region names → country known, city NOT honestly assignable ──
  "odisha": e(null, "IN"),
  "odisa": e(null, "IN"), // misspelling seen in sector
  "kashmir": e(null, "IN"),
  "tarapith": e(null, "IN"), // small pilgrimage town, ambiguous (LOW_CONFIDENCE)

  // ── International: cities (name + IATA variants) ──
  "dubai": e("Dubai", "AE"),
  "dxb": e("Dubai", "AE"),
  "singapore": e("Singapore", "SG"),
  "sin": e("Singapore", "SG"),
  "kuala lumpur": e("Kuala Lumpur", "MY"),
  "kl": e("Kuala Lumpur", "MY"),
  "sgn": e("Ho Chi Minh City", "VN"),
  "han": e("Hanoi", "VN"),
  "pvg": e("Shanghai", "CN"),
  "shanghai": e("Shanghai", "CN"),
  "bcn": e("Barcelona", "ES"),
  "barcelona": e("Barcelona", "ES"),
  "bru": e("Brussels", "BE"),
  "brussels": e("Brussels", "BE"),
  "vie": e("Vienna", "AT"),
  "vienna": e("Vienna", "AT"),
  "ber": e("Berlin", "DE"),
  "berlin": e("Berlin", "DE"),
  "amm": e("Amman", "JO"),
  "amman": e("Amman", "JO"),
  "ams": e("Amsterdam", "NL"),
  "amsterdam": e("Amsterdam", "NL"),
  "johannesburg": e("Johannesburg", "ZA"),
  "johannesburg south africa": e("Johannesburg", "ZA"),
  "sydney": e("Sydney", "AU"),
  "melbourne": e("Melbourne", "AU"),
  "new york": e("New York", "US"),
  "gaellivare": e("Gällivare", "SE"),
  "gällivare": e("Gällivare", "SE"),
  "puoltikasvaara": e("Puoltikasvaara", "SE"), // hamlet near Gällivare (LOW_CONFIDENCE)
  "dokkas": e("Dokkas", "SE"), // hamlet near Gällivare (LOW_CONFIDENCE)

  // ── International: country / region names → country known, city NOT assignable ──
  "vietnam": e(null, "VN"),
  "china": e(null, "CN"),
  "spain": e(null, "ES"),
  "australia": e(null, "AU"),
  "south africa": e(null, "ZA"),
};

/** City keys (entries with a non-null city) for fuzzy containment, longest-first. */
const CITY_KEYS_BY_LENGTH = Object.keys(DESTINATION_LOOKUP)
  .filter((k) => DESTINATION_LOOKUP[k].city != null)
  .sort((a, b) => b.length - a.length);

/**
 * Exact (normalized) lookup. Returns null for any value not in the table —
 * including all hotel/property names. NEVER guesses.
 */
export function lookupDestination(raw: unknown): DestinationEntry | null {
  const k = normKey(raw);
  if (!k) return null;
  return DESTINATION_LOOKUP[k] ?? null;
}

/**
 * Fuzzy lookup for messy sector strings (Tier-4 only): exact first, then
 * whole-word containment of a known city key (e.g. "jodhpur, rajasthan" →
 * Jodhpur, "tarabai park 416003 kolhapur" → Kolhapur, "patel nagar new
 * delhi" → Delhi). Longest key wins to avoid short false matches. Still never
 * invents a city not in the table.
 */
export function lookupDestinationFuzzy(raw: unknown): DestinationEntry | null {
  const exact = lookupDestination(raw);
  if (exact) return exact;
  const k = normKey(raw);
  if (!k) return null;
  for (const ck of CITY_KEYS_BY_LENGTH) {
    // whole-word boundary match
    const re = new RegExp(`(^|[^a-z])${ck.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
    if (re.test(k)) return DESTINATION_LOOKUP[ck];
  }
  return null;
}

/**
 * Values placed tentatively or deliberately left UNRESOLVED — adjudicate by hand.
 * (Deliberately-omitted values are listed here so they are not silently lost.)
 */
export const LOW_CONFIDENCE: Array<{ value: string; note: string }> = [
  { value: "ISK", note: "ACCEPTED → IATA Nashik." },
  { value: "KQH", note: "ACCEPTED → IATA Kishangarh." },
  { value: "DBR", note: "ACCEPTED → IATA Darbhanga." },
  { value: "Koraput", note: "Small Odisha district town — confirm it should rank as a city." },
  { value: "Tarapith / Odisha / Odisa / Kashmir", note: "State/region/town — country set, city left null by design." },
  { value: "Puoltikasvaara / Dokkas", note: "Swedish hamlets near Gällivare (from authoritative SBT hotel cityName) — country SE confident, city kept verbatim." },
  { value: "Navi Mumbai", note: "ADJUDICATED → merged into Mumbai (navi mumbai → {Mumbai, IN})." },
  { value: "Green Park", note: "DELIBERATELY OMITTED — ambiguous (Delhi locality vs hotel name). Rows seen are hotels in Vizag; Tier-4 sector resolves them." },
  { value: "DEL,JAI", note: "DELIBERATELY OMITTED — multi-sector string, not a single destination. Left null." },
  { value: "AEP", note: "DELIBERATELY OMITTED — IATA Buenos Aires Aeroparque (AR); implausible among Indian manual rows, likely a mis-key. Left null." },
  { value: "GGN", note: "DELIBERATELY OMITTED — not a standard IATA code; possibly 'Gurgaon' shorthand but unconfirmed. Left null." },
];
