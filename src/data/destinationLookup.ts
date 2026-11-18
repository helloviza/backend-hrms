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

/**
 * Travel Spend ONLY (Phase B, 2026-11-18, audit N3) — used by the
 * TravelBooking mirror through the travel* functions below. Kept OUT of
 * DESTINATION_LOOKUP on purpose: Pluto (hotel destination, places, user
 * location, panel city) and services/location.service.ts read that table and
 * treat "in the table" as meaningful (e.g. a hotel city Pluto can serve), so
 * adding London or Thane there would change their behaviour.
 */
export const TRAVEL_SPEND_EXTRA: Record<string, DestinationEntry> = {
  // ════ Phase B additions (2026-11-18, Travel Spend audit N3) ════
  // Built from the unresolved values in confirmed rows since July 2026.
  // Approved: NMI → Mumbai (Navi Mumbai Intl, same merge as "navi mumbai"),
  // DXN → Noida (Noida Intl, Jewar). Every key of 3 letters or fewer is
  // EXACT-match only (see fuzzyEligible) — "sea" must never match
  // "Blue Sea Beach Resort".

  // ── IATA airport / city codes ──
  "nmi": e("Mumbai", "IN"),
  "dxn": e("Noida", "IN"),
  "ixs": e("Silchar", "IN"),
  "ixb": e("Siliguri", "IN"),
  "hsr": e("Rajkot", "IN"),
  "raj": e("Rajkot", "IN"),
  "vns": e("Varanasi", "IN"),
  "udr": e("Udaipur", "IN"),
  "atq": e("Amritsar", "IN"),
  "goi": e("Goa", "IN"),
  "gox": e("Goa", "IN"),
  "ixm": e("Madurai", "IN"),
  "dib": e("Dibrugarh", "IN"),
  "ccj": e("Kozhikode", "IN"),
  "stv": e("Surat", "IN"),
  "trv": e("Thiruvananthapuram", "IN"),
  "dmu": e("Dimapur", "IN"),
  "rdp": e("Durgapur", "IN"),
  "knu": e("Kanpur", "IN"),
  "ixa": e("Agartala", "IN"),
  "tcr": e("Thoothukudi", "IN"),
  "ixe": e("Mangaluru", "IN"),
  "hbx": e("Hubballi", "IN"),
  "pny": e("Puducherry", "IN"),
  "sdw": e("Sindhudurg", "IN"),
  "hdo": e("Ghaziabad", "IN"),
  "tir": e("Tirupati", "IN"),
  "ixj": e("Jammu", "IN"),
  "bhj": e("Bhuj", "IN"),
  "ixd": e("Prayagraj", "IN"),
  "jlr": e("Jabalpur", "IN"),
  "bdq": e("Vadodara", "IN"),
  "imf": e("Imphal", "IN"),
  "ixu": e("Aurangabad", "IN"),
  "gop": e("Gorakhpur", "IN"),
  "dhm": e("Dharamshala", "IN"),
  "ixz": e("Port Blair", "IN"),
  "ixl": e("Leh", "IN"),
  "gay": e("Gaya", "IN"),
  "mnl": e("Manila", "PH"),
  "syd": e("Sydney", "AU"),
  "cmb": e("Colombo", "LK"),
  "mel": e("Melbourne", "AU"),
  "avv": e("Melbourne", "AU"),
  "auh": e("Abu Dhabi", "AE"),
  "doh": e("Doha", "QA"),
  "ist": e("Istanbul", "TR"),
  "saw": e("Istanbul", "TR"),
  "waw": e("Warsaw", "PL"),
  "kul": e("Kuala Lumpur", "MY"),
  "hkg": e("Hong Kong", "HK"),
  "lux": e("Luxembourg", "LU"),
  "lhr": e("London", "GB"),
  "lcy": e("London", "GB"),
  "ltn": e("London", "GB"),
  "lgw": e("London", "GB"),
  "stn": e("London", "GB"),
  "vno": e("Vilnius", "LT"),
  "kun": e("Kaunas", "LT"),
  "mco": e("Orlando", "US"),
  "jed": e("Jeddah", "SA"),
  "bkk": e("Bangkok", "TH"),
  "dmk": e("Bangkok", "TH"),
  "bhx": e("Birmingham", "GB"),
  "dus": e("Düsseldorf", "DE"),
  "dusseldorf": e("Düsseldorf", "DE"),
  // Ticket departure airports (Phase B additions, 2026-11-18)
  "add": e("Addis Ababa", "ET"),
  "addis ababa": e("Addis Ababa", "ET"),
  "her": e("Heraklion", "GR"),
  "heraklion": e("Heraklion", "GR"),
  "akl": e("Auckland", "NZ"),
  "auckland": e("Auckland", "NZ"),
  "san": e("San Diego", "US"),
  "szx": e("Shenzhen", "CN"),
  "cmn": e("Casablanca", "MA"),
  "sez": e("Mahé", "SC"),
  "ruh": e("Riyadh", "SA"),
  "muc": e("Munich", "DE"),
  "dmm": e("Dammam", "SA"),
  "hkt": e("Phuket", "TH"),
  "bos": e("Boston", "US"),
  "phx": e("Phoenix", "US"),
  "sea": e("Seattle", "US"),
  "dal": e("Dallas", "US"),
  "dfw": e("Dallas", "US"),
  "msp": e("Minneapolis", "US"),
  "phl": e("Philadelphia", "US"),
  "cai": e("Cairo", "EG"),
  "cpt": e("Cape Town", "ZA"),
  "jnb": e("Johannesburg", "ZA"),
  "bne": e("Brisbane", "AU"),
  "mad": e("Madrid", "ES"),
  "ath": e("Athens", "GR"),
  "zrh": e("Zurich", "CH"),
  "jfk": e("New York", "US"),
  "lga": e("New York", "US"),
  "ewr": e("New York", "US"),
  "nbo": e("Nairobi", "KE"),
  "scl": e("Santiago", "CL"),
  "lis": e("Lisbon", "PT"),
  "fra": e("Frankfurt", "DE"),
  "str": e("Stuttgart", "DE"),
  "pkx": e("Beijing", "CN"),
  "pek": e("Beijing", "CN"),
  "fco": e("Rome", "IT"),
  "rom": e("Rome", "IT"),
  "bna": e("Nashville", "US"),
  "can": e("Guangzhou", "CN"),
  "dps": e("Bali", "ID"),
  "msy": e("New Orleans", "US"),
  "gru": e("São Paulo", "BR"),
  "cdg": e("Paris", "FR"),
  "ory": e("Paris", "FR"),
  "kbv": e("Krabi", "TH"),
  "ala": e("Almaty", "KZ"),
  "hel": e("Helsinki", "FI"),
  "nrt": e("Tokyo", "JP"),
  "hnd": e("Tokyo", "JP"),
  "kef": e("Reykjavik", "IS"),
  "ord": e("Chicago", "US"),
  "jtr": e("Santorini", "GR"),
  "shj": e("Sharjah", "AE"),
  "bgy": e("Milan", "IT"),
  "mxp": e("Milan", "IT"),
  "alc": e("Alicante", "ES"),
  "cor": e("Cordoba", "AR"),
  "was": e("Washington", "US"),
  "iad": e("Washington", "US"),
  "sfo": e("San Francisco", "US"),
  "lax": e("Los Angeles", "US"),
  "yyz": e("Toronto", "CA"),
  "mct": e("Muscat", "OM"),
  "bah": e("Bahrain", "BH"),
  "kwi": e("Kuwait City", "KW"),
  "cgk": e("Jakarta", "ID"),
  "ktm": e("Kathmandu", "NP"),
  "dac": e("Dhaka", "BD"),
  "mle": e("Male", "MV"),
  "icn": e("Seoul", "KR"),
  "gva": e("Geneva", "CH"),
  "man": e("Manchester", "GB"),
  "edi": e("Edinburgh", "GB"),
  "dub": e("Dublin", "IE"),
  "cph": e("Copenhagen", "DK"),
  "arn": e("Stockholm", "SE"),
  "osl": e("Oslo", "NO"),
  "prg": e("Prague", "CZ"),
  "bud": e("Budapest", "HU"),
  "rvn": e("Rovaniemi", "FI"),

  // ── city, hotel-district, state and country names ──
  "agr": e("Agra", "IN"),
  "manila": e("Manila", "PH"),
  "abu dhabi": e("Abu Dhabi", "AE"),
  "london": e("London", "GB"),
  "luxembourg": e("Luxembourg", "LU"),
  "ghent": e("Ghent", "BE"),
  "gent": e("Ghent", "BE"),
  "riyadh": e("Riyadh", "SA"),
  "hong kong": e("Hong Kong", "HK"),
  "hongkong": e("Hong Kong", "HK"),
  "istanbul": e("Istanbul", "TR"),
  "birmingham": e("Birmingham", "GB"),
  "sandton": e("Johannesburg", "ZA"),
  "rovaniemi": e("Rovaniemi", "FI"),
  "casablanca": e("Casablanca", "MA"),
  "seattle": e("Seattle", "US"),
  "shenzhen": e("Shenzhen", "CN"),
  "helsinki": e("Helsinki", "FI"),
  "colombo": e("Colombo", "LK"),
  "orlando": e("Orlando", "US"),
  "pasay": e("Manila", "PH"),
  "makati": e("Manila", "PH"),
  "paranaque": e("Manila", "PH"),
  "araneta city": e("Manila", "PH"),
  "rome": e("Rome", "IT"),
  "jeddah": e("Jeddah", "SA"),
  "jedah": e("Jeddah", "SA"),
  "krabi": e("Krabi", "TH"),
  "karabi": e("Krabi", "TH"),
  "doha": e("Doha", "QA"),
  "sao paulo": e("São Paulo", "BR"),
  "santiago": e("Santiago", "CL"),
  "prague": e("Prague", "CZ"),
  "frankfurt": e("Frankfurt", "DE"),
  "lisbon": e("Lisbon", "PT"),
  "dammam": e("Dammam", "SA"),
  "phoenix": e("Phoenix", "US"),
  "des moines": e("Des Moines", "US"),
  "macquarie park": e("Sydney", "AU"),
  "schipol": e("Amsterdam", "NL"),
  "schiphol": e("Amsterdam", "NL"),
  "karmelava": e("Kaunas", "LT"),
  "karmėlava": e("Kaunas", "LT"),
  "stryków": e("Strykow", "PL"),
  "strykow": e("Strykow", "PL"),
  "reston": e("Reston", "US"),
  "moulineaux": e("Paris", "FR"),
  "archena": e("Archena", "ES"),
  "brisbane": e("Brisbane", "AU"),
  "warsaw": e("Warsaw", "PL"),
  "vilnius": e("Vilnius", "LT"),
  "bangkok": e("Bangkok", "TH"),
  "paris": e("Paris", "FR"),
  "munich": e("Munich", "DE"),
  "tokyo": e("Tokyo", "JP"),
  "goa": e("Goa", "IN"),
  "anjuna": e("Goa", "IN"),
  "patiala": e("Patiala", "IN"),
  "rajkot": e("Rajkot", "IN"),
  "solapur": e("Solapur", "IN"),
  "gwalior": e("Gwalior", "IN"),
  "gangtok": e("Gangtok", "IN"),
  "pondicherry": e("Puducherry", "IN"),
  "puducherry": e("Puducherry", "IN"),
  "jhansi": e("Jhansi", "IN"),
  "noida": e("Noida", "IN"),
  "ludhiana": e("Ludhiana", "IN"),
  "dibrugarh": e("Dibrugarh", "IN"),
  "madurai": e("Madurai", "IN"),
  "jabalpur": e("Jabalpur", "IN"),
  "bhubneshwar": e("Bhubaneswar", "IN"),
  "jaydev vihar": e("Bhubaneswar", "IN"),
  "sagar": e("Sagar", "IN"),
  "jammu": e("Jammu", "IN"),
  "thiruvananthapuram": e("Thiruvananthapuram", "IN"),
  "trivandrum": e("Thiruvananthapuram", "IN"),
  "namchi": e("Namchi", "IN"),
  "roorkee": e("Roorkee", "IN"),
  "roorkie": e("Roorkee", "IN"),
  "gauwhati": e("Guwahati", "IN"),
  "kanpur": e("Kanpur", "IN"),
  "gandhi nagar": e("Gandhinagar", "IN"),
  "gandhinagar": e("Gandhinagar", "IN"),
  "dimapur": e("Dimapur", "IN"),
  "shimla": e("Shimla", "IN"),
  "hydrabad": e("Hyderabad", "IN"),
  "howrah": e("Howrah", "IN"),
  "hamirpur": e("Hamirpur", "IN"),
  "faridabaad": e("Faridabad", "IN"),
  "gonda": e("Gonda", "IN"),
  "rameshwaram": e("Rameswaram", "IN"),
  "yavatmal": e("Yavatmal", "IN"),
  "thane": e("Thane", "IN"),
  "balrampur": e("Balrampur", "IN"),
  "balampur": e("Balrampur", "IN"),
  "siliguri": e("Siliguri", "IN"),
  "pratapgarh": e("Pratapgarh", "IN"),
  "gomti nagar": e("Lucknow", "IN"),
  "ananthapuramu": e("Anantapur", "IN"),
  "anantapur": e("Anantapur", "IN"),
  "kadapa": e("Kadapa", "IN"),
  "kurnool": e("Kurnool", "IN"),
  "aurangabad": e("Aurangabad", "IN"),
  "karjat": e("Karjat", "IN"),
  "agartala": e("Agartala", "IN"),
  "satellite": e("Ahmedabad", "IN"),
  "ghansoli": e("Mumbai", "IN"),
  "lalitpur": e("Lalitpur", "IN"),
  "coorg": e("Coorg", "IN"),
  "chitrakoot dham": e("Chitrakoot", "IN"),
  "chitrakoot": e("Chitrakoot", "IN"),
  "sitabuldi": e("Nagpur", "IN"),
  "badaun": e("Budaun", "IN"),
  "farukhabad": e("Farrukhabad", "IN"),
  "banglore": e("Bengaluru", "IN"),
  "visakapatnam": e("Visakhapatnam", "IN"),
  "ujjain": e("Ujjain", "IN"),
  "ghazipur": e("Ghazipur", "IN"),
  "gorakhpur": e("Gorakhpur", "IN"),
  "azamgarh": e("Azamgarh", "IN"),
  "neemuch": e("Neemuch", "IN"),
  "guna": e("Guna", "IN"),
  "khalapur": e("Khalapur", "IN"),
  "indukurpet": e("Indukurpet", "IN"),
  "ajabgarh": e("Ajabgarh", "IN"),
  "amritsar": e("Amritsar", "IN"),
  "surat": e("Surat", "IN"),
  "vadodara": e("Vadodara", "IN"),
  "mangalore": e("Mangaluru", "IN"),
  "mangaluru": e("Mangaluru", "IN"),
  "mysore": e("Mysuru", "IN"),
  "mysuru": e("Mysuru", "IN"),
  "agra": e("Agra", "IN"),
  "ghaziabad": e("Ghaziabad", "IN"),
  "prayagraj": e("Prayagraj", "IN"),
  "allahabad": e("Prayagraj", "IN"),
  "mumabi": e("Mumbai", "IN"),
  "uae": e(null, "AE"),
  "united arab emirates": e(null, "AE"),
  "philippines": e(null, "PH"),
  "england": e(null, "GB"),
  "uk": e(null, "GB"),
  "united kingdom": e(null, "GB"),
  "belgium": e(null, "BE"),
  "brazil": e(null, "BR"),
  "lithuania": e(null, "LT"),
  "usa": e(null, "US"),
  "united states": e(null, "US"),
  "maldives": e(null, "MV"),
  "queensland": e(null, "AU"),
  "greece": e(null, "GR"),
  "jordan": e(null, "JO"),
  "saudi arabia": e(null, "SA"),
  "germany": e(null, "DE"),
  "france": e(null, "FR"),
  "new zealand": e(null, "NZ"),
  "turkey": e(null, "TR"),
  "turkiye": e(null, "TR"),
  "portugal": e(null, "PT"),
  "italy": e(null, "IT"),
  "japan": e(null, "JP"),
  "canada": e(null, "CA"),
  "thailand": e(null, "TH"),
  "malaysia": e(null, "MY"),
  "indonesia": e(null, "ID"),
  "sri lanka": e(null, "LK"),
  "nepal": e(null, "NP"),
  "india": e(null, "IN"),
  "up": e(null, "IN"),
  "uttar pradesh": e(null, "IN"),
  "assam": e(null, "IN"),
  "gujarat": e(null, "IN"),
  "punjab": e(null, "IN"),
  "madhya pradesh": e(null, "IN"),
  "karnataka": e(null, "IN"),
  "odhisa": e(null, "IN"),
  "rajasthan": e(null, "IN"),
  "kerala": e(null, "IN"),
  "maharashtra": e(null, "IN"),
  "sikkim": e(null, "IN"),
  "krishnanagar": e("Krishnanagar", "IN"),
  "shillong": e("Shillong", "IN"),
  "silchar": e("Silchar", "IN"),
  "nairobi": e("Nairobi", "KE"),
  "nashville": e("Nashville", "US"),
  "plano": e("Plano", "US"),
  "tallinn": e("Tallinn", "EE"),
  "haberfield": e("Sydney", "AU"),
  "bensalem": e("Philadelphia", "US"),
  "bensalem philadelphia": e("Philadelphia", "US"),
  "philadelphia": e("Philadelphia", "US"),
  "kadiri": e("Kadiri", "IN"),
  "yelagiri": e("Yelagiri", "IN"),
  "madanapalle": e("Madanapalle", "IN"),
  "cuddalore": e("Cuddalore", "IN"),
  "virar east": e("Virar", "IN"),
  "virar": e("Virar", "IN"),
  "kaushambi": e("Kaushambi", "IN"),
  "robertsganj": e("Robertsganj", "IN"),
  "kannauj": e("Kannauj", "IN"),
  "mathura": e("Mathura", "IN"),
  "panaji": e("Goa", "IN"),
  "mainpuri": e("Mainpuri", "IN"),
  "ajmer": e("Ajmer", "IN"),
  "hubballi": e("Hubballi", "IN"),
  "hubli": e("Hubballi", "IN"),
  "kota": e("Kota", "IN"),
  "balangir": e("Balangir", "IN"),
  "barwani": e("Barwani", "IN"),
  "sambalpur": e("Sambalpur", "IN"),
  "davanagere": e("Davanagere", "IN"),
  "etah": e("Etah", "IN"),
  "ashram road": e("Ahmedabad", "IN"),
  "bihar": e(null, "IN"),
  "tamil nadu": e(null, "IN"),
  "west bengal": e(null, "IN"),
  "andhra pradesh": e(null, "IN"),
  "telangana": e(null, "IN"),
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
 * Canonicalize a STRUCTURED city field (SBT flight/hotel `destination.city` /
 * `cityName` — Tiers 1/2, an authoritative source field, not free text): if
 * the lookup table knows a canonical spelling, use it; otherwise trust the
 * source value as-is rather than discarding it. Shared by the live SBT
 * flight mirror-sync and the historical backfill script so both resolve a
 * given city the same way.
 */
export function canonicalCity(name: unknown): string | null {
  const s = String(name ?? "").trim();
  if (!s) return null;
  const hit = lookupDestination(s);
  if (hit?.city) return hit.city;
  return s;
}

/**
 * First candidate (in order) whose lookup entry carries a known country —
 * e.g. `countryFor(destination.code, destination.city)` tries the IATA code
 * first, falls back to the city name. Shared by the live SBT flight
 * mirror-sync and the historical backfill script.
 */
export function countryFor(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const hit = lookupDestination(c);
    if (hit?.country) return hit.country;
  }
  return null;
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

/* ────────────────────────────────────────────────────────────────────────
 * Travel Spend lookups (Phase B) — DESTINATION_LOOKUP + TRAVEL_SPEND_EXTRA.
 * Only the TravelBooking mirror builders (services/travelMirrorAnalytics.ts,
 * models/SBTBooking.ts, models/SBTHotelBooking.ts) use these.
 * ──────────────────────────────────────────────────────────────────────── */
export const TRAVEL_SPEND_LOOKUP: Record<string, DestinationEntry> = { ...DESTINATION_LOOKUP, ...TRAVEL_SPEND_EXTRA };

/**
 * Keys of 3 letters or fewer (IATA codes, "kl") are EXACT-match only in the
 * travel fuzzy tiers (decision 2026-11-18): inside free text they are
 * ordinary words — "sea" in "Blue Sea Beach Resort", "man", "can", "was".
 * "goa" is a city name, not a code, so it stays fuzzy.
 */
const SHORT_FUZZY_ALLOW = new Set(["goa"]);
const fuzzyEligible = (k: string) => k.length > 3 || SHORT_FUZZY_ALLOW.has(k);

const TRAVEL_CITY_KEYS = Object.keys(TRAVEL_SPEND_LOOKUP)
  .filter((k) => TRAVEL_SPEND_LOOKUP[k].city != null && fuzzyEligible(k))
  .sort((a, b) => b.length - a.length);

/** Country / state / region keys (no city), 3+ letters ("usa", "uae"; never "up", "uk"). */
const TRAVEL_COUNTRY_KEYS = Object.keys(TRAVEL_SPEND_LOOKUP)
  .filter((k) => TRAVEL_SPEND_LOOKUP[k].city == null && TRAVEL_SPEND_LOOKUP[k].country != null && k.length >= 3)
  .sort((a, b) => b.length - a.length);

// Letters incl. accented Latin, so "karmėlava" is one word.
const WORD = "a-z\\u00C0-\\u024F";
function containsWord(haystack: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^${WORD}])${esc}([^${WORD}]|$)`, "i").test(haystack);
}

/** Exact lookup over the Travel Spend table. */
export function travelLookup(raw: unknown): DestinationEntry | null {
  const k = normKey(raw);
  if (!k) return null;
  return TRAVEL_SPEND_LOOKUP[k] ?? null;
}

/** Exact first, then whole-word city containment (keys of 4+ letters, plus "goa"). */
export function travelLookupFuzzy(raw: unknown): DestinationEntry | null {
  const exact = travelLookup(raw);
  if (exact) return exact;
  const k = normKey(raw);
  if (!k) return null;
  for (const ck of TRAVEL_CITY_KEYS) if (containsWord(k, ck)) return TRAVEL_SPEND_LOOKUP[ck];
  return null;
}

/**
 * Country-only fuzzy tier (T5): exact first, then whole-word containment of a
 * country / state / region name ("Balangir, Odisha" → IN, "Phoenix , USA" →
 * US). Never assigns a city.
 */
export function travelCountryFuzzy(raw: unknown): string | null {
  const exact = travelLookup(raw);
  if (exact?.country) return exact.country;
  const k = normKey(raw);
  if (!k) return null;
  for (const ck of TRAVEL_COUNTRY_KEYS) if (containsWord(k, ck)) return TRAVEL_SPEND_LOOKUP[ck].country;
  return null;
}

/** Country of a single airport / city code or name — null when unknown. */
export function travelCountryOf(raw: unknown): string | null {
  return travelLookup(raw)?.country ?? null;
}

/** canonicalCity over the Travel Spend table. */
export function travelCanonicalCity(name: unknown): string | null {
  const s = String(name ?? "").trim();
  if (!s) return null;
  return travelLookup(s)?.city ?? s;
}

/** countryFor over the Travel Spend table. */
export function travelCountryFor(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const hit = travelLookup(c);
    if (hit?.country) return hit.country;
  }
  return null;
}

/**
 * Visa rows (Phase B decision): `itinerary.visaCountry` names a COUNTRY — a
 * "Dubai" visa is a UAE visa — so a visa row gets a country and NEVER a city.
 * Free-text noise is stripped first: "(super fast)", "e-visa", "visa",
 * "expedite charge", "2 year", a trailing "NA".
 */
export const VISA_COUNTRY: Record<string, string> = {
  "dubai": "AE", "uae": "AE", "australia": "AU", "jordan": "JO", "usa": "US", "us": "US",
  "singapore": "SG", "china": "CN", "saudi arabia": "SA", "uk": "GB", "united kingdom": "GB",
  "germany": "DE", "spain": "ES", "greece": "GR", "france": "FR", "new zealand": "NZ",
  "vietnam": "VN", "thailand": "TH", "japan": "JP", "canada": "CA",
  "uk to usa": "US", // approved 2026-11-18: a US visa applied for from the UK
};

export function normVisaCountry(raw: unknown): string {
  return normKey(raw)
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(e-?visa|visa|expedite|charges?|super fast|\d+ years?|na)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function visaCountryCode(raw: unknown): string | null {
  const k = normVisaCountry(raw);
  if (!k) return null;
  if (k in VISA_COUNTRY) return VISA_COUNTRY[k];
  return travelCountryFuzzy(k);
}

/**
 * Indian Railways station codes — TRAIN rows ONLY. They collide with IATA
 * (BRC is Bariloche, CNB Coonabarabran), so they never join the main table.
 */
export const RAIL_STATIONS: Record<string, string> = {
  "ndls": "Delhi", "nzm": "Delhi", "anvt": "Delhi", "dli": "Delhi", "rnc": "Ranchi", "ju": "Jodhpur",
  "ldh": "Ludhiana", "cnb": "Kanpur", "sc": "Hyderabad", "secundrabad": "Hyderabad", "secunderabad": "Hyderabad",
  "bnz": "Lucknow", "lko": "Lucknow", "vglj": "Jhansi", "sbib": "Ahmedabad", "adi": "Ahmedabad",
  "ghy": "Guwahati", "dmv": "Dimapur", "brc": "Vadodara", "roorkee": "Roorkee", "bct": "Mumbai",
  "csmt": "Mumbai", "hwh": "Kolkata", "sbc": "Bengaluru", "ypr": "Bengaluru",
};

export function railStationCity(raw: unknown): string | null {
  return RAIL_STATIONS[normKey(raw)] ?? null;
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
