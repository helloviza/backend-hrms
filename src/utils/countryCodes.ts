// apps/backend/src/utils/countryCodes.ts
//
// Single country reference for the Visa module. Built because three
// different representations of "which country" converge on VisaApplication:
//   - VisaRule.nationality / destinationIso2 — ISO 3166-1 alpha-2
//   - TravellerProfile.nationality — free text (OCR/manual entry commonly
//     yields the demonym, e.g. "INDIAN", not a country name or code)
//   - passport MRZ — ICAO/ISO 3166-1 alpha-3 issuing-state code
// normaliseToIso2() is the one converter all three should go through before
// they meet, rather than each call site growing its own ad-hoc mapping.
//
// Coverage: every entry in ./visa-country-codes-required.json — the
// coverage checklist (46 live catalogue destinations, 68 expansion targets,
// plus India on the nationality side; 115 total). That file carries only
// {name, iso2, tier}; this file is the source of truth for iso3/demonym/
// alias data and must keep every checklist entry resolving via
// normaliseToIso2() (see countryCodes.test.ts, which asserts this directly
// off the checklist).

// Destination-picker grouping. SCHENGEN sits alongside EUROPE deliberately —
// it's a commercially meaningful grouping (one visa, one process, one fee
// structure), not a strict geographic one: Schengen member states get
// SCHENGEN, other European countries get EUROPE. GULF is the six GCC states
// only (UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman) — an earlier
// revision of this file overloaded GULF into a broad "Gulf & Middle East"
// bucket to avoid adding a tenth value; that was wrong and has been
// reversed. MIDDLE_EAST now covers Israel, Jordan, Lebanon, Iran and Iraq.
// Türkiye and Egypt are NOT in either bucket — Türkiye is EUROPE and Egypt
// is AFRICA, per docs/design/visa-flow/'s own country dataset, which this
// file must not diverge from on the screen that dataset specifies.
// CENTRAL_ASIA was added for the Caucasus/Central Asian expansion targets
// (Armenia, Azerbaijan, Georgia, Kazakhstan, Kyrgyzstan, Tajikistan,
// Turkmenistan, Uzbekistan), which don't fit South Asia, East Asia, or Gulf.
export const VISA_COUNTRY_REGIONS = [
  "GULF", "MIDDLE_EAST", "SOUTHEAST_ASIA", "SCHENGEN", "EUROPE", "AMERICAS",
  "OCEANIA", "EAST_ASIA", "SOUTH_ASIA", "AFRICA", "CENTRAL_ASIA",
] as const;
export type VisaCountryRegion = (typeof VISA_COUNTRY_REGIONS)[number];

export interface CountryCodeEntry {
  iso2: string; // ISO 3166-1 alpha-2, e.g. "IN"
  iso3: string; // ISO 3166-1 alpha-3 / ICAO MRZ issuing-state code, e.g. "IND"
  region: VisaCountryRegion; // destination-picker grouping — see VISA_COUNTRY_REGIONS above
  name: string; // common name
  demonym: string; // primary demonym, e.g. "Indian"
  aliases?: string[]; // additional accepted names/demonyms/abbreviations
}

export const COUNTRY_CODES: readonly CountryCodeEntry[] = [
  // ── South Asia ──────────────────────────────────────────────────────
  { iso2: "IN", iso3: "IND", region: "SOUTH_ASIA", name: "India", demonym: "Indian" },
  { iso2: "PK", iso3: "PAK", region: "SOUTH_ASIA", name: "Pakistan", demonym: "Pakistani" },
  { iso2: "BD", iso3: "BGD", region: "SOUTH_ASIA", name: "Bangladesh", demonym: "Bangladeshi" },
  { iso2: "LK", iso3: "LKA", region: "SOUTH_ASIA", name: "Sri Lanka", demonym: "Sri Lankan" },
  { iso2: "NP", iso3: "NPL", region: "SOUTH_ASIA", name: "Nepal", demonym: "Nepali", aliases: ["Nepalese"] },
  { iso2: "BT", iso3: "BTN", region: "SOUTH_ASIA", name: "Bhutan", demonym: "Bhutanese" },
  { iso2: "MV", iso3: "MDV", region: "SOUTH_ASIA", name: "Maldives", demonym: "Maldivian" },

  // ── Gulf / Middle East ──────────────────────────────────────────────
  { iso2: "AE", iso3: "ARE", region: "GULF", name: "United Arab Emirates", demonym: "Emirati", aliases: ["UAE", "Dubai"] },
  { iso2: "SA", iso3: "SAU", region: "GULF", name: "Saudi Arabia", demonym: "Saudi" },
  { iso2: "QA", iso3: "QAT", region: "GULF", name: "Qatar", demonym: "Qatari" },
  { iso2: "KW", iso3: "KWT", region: "GULF", name: "Kuwait", demonym: "Kuwaiti" },
  { iso2: "BH", iso3: "BHR", region: "GULF", name: "Bahrain", demonym: "Bahraini" },
  { iso2: "OM", iso3: "OMN", region: "GULF", name: "Oman", demonym: "Omani" },
  { iso2: "IL", iso3: "ISR", region: "MIDDLE_EAST", name: "Israel", demonym: "Israeli" },
  { iso2: "JO", iso3: "JOR", region: "MIDDLE_EAST", name: "Jordan", demonym: "Jordanian" },
  { iso2: "LB", iso3: "LBN", region: "MIDDLE_EAST", name: "Lebanon", demonym: "Lebanese" },
  { iso2: "TR", iso3: "TUR", region: "EUROPE", name: "Türkiye", demonym: "Turkish", aliases: ["Turkey", "Turkiye"] },
  { iso2: "IR", iso3: "IRN", region: "MIDDLE_EAST", name: "Iran", demonym: "Iranian" },
  { iso2: "IQ", iso3: "IRQ", region: "MIDDLE_EAST", name: "Iraq", demonym: "Iraqi" },

  // ── South-east Asia ──────────────────────────────────────────────────
  { iso2: "SG", iso3: "SGP", region: "SOUTHEAST_ASIA", name: "Singapore", demonym: "Singaporean" },
  { iso2: "TH", iso3: "THA", region: "SOUTHEAST_ASIA", name: "Thailand", demonym: "Thai" },
  { iso2: "MY", iso3: "MYS", region: "SOUTHEAST_ASIA", name: "Malaysia", demonym: "Malaysian" },
  { iso2: "ID", iso3: "IDN", region: "SOUTHEAST_ASIA", name: "Indonesia", demonym: "Indonesian" },
  { iso2: "VN", iso3: "VNM", region: "SOUTHEAST_ASIA", name: "Vietnam", demonym: "Vietnamese" },
  { iso2: "PH", iso3: "PHL", region: "SOUTHEAST_ASIA", name: "Philippines", demonym: "Filipino", aliases: ["Filipina"] },
  { iso2: "KH", iso3: "KHM", region: "SOUTHEAST_ASIA", name: "Cambodia", demonym: "Cambodian" },
  { iso2: "LA", iso3: "LAO", region: "SOUTHEAST_ASIA", name: "Laos", demonym: "Laotian" },
  { iso2: "MM", iso3: "MMR", region: "SOUTHEAST_ASIA", name: "Myanmar", demonym: "Burmese", aliases: ["Burma"] },
  { iso2: "BN", iso3: "BRN", region: "SOUTHEAST_ASIA", name: "Brunei", demonym: "Bruneian" },

  // ── East Asia ────────────────────────────────────────────────────────
  { iso2: "JP", iso3: "JPN", region: "EAST_ASIA", name: "Japan", demonym: "Japanese" },
  { iso2: "KR", iso3: "KOR", region: "EAST_ASIA", name: "South Korea", demonym: "South Korean", aliases: ["Korea", "Republic of Korea", "Korean"] },
  { iso2: "CN", iso3: "CHN", region: "EAST_ASIA", name: "China", demonym: "Chinese" },
  { iso2: "HK", iso3: "HKG", region: "EAST_ASIA", name: "Hong Kong", demonym: "Hong Konger", aliases: ["Hong Kong SAR"] },
  { iso2: "TW", iso3: "TWN", region: "EAST_ASIA", name: "Taiwan", demonym: "Taiwanese" },
  { iso2: "MN", iso3: "MNG", region: "EAST_ASIA", name: "Mongolia", demonym: "Mongolian" },

  // ── Caucasus & Central Asia ──────────────────────────────────────────
  { iso2: "AM", iso3: "ARM", region: "CENTRAL_ASIA", name: "Armenia", demonym: "Armenian" },
  { iso2: "AZ", iso3: "AZE", region: "CENTRAL_ASIA", name: "Azerbaijan", demonym: "Azerbaijani", aliases: ["Azeri"] },
  { iso2: "GE", iso3: "GEO", region: "CENTRAL_ASIA", name: "Georgia", demonym: "Georgian" },
  { iso2: "KZ", iso3: "KAZ", region: "CENTRAL_ASIA", name: "Kazakhstan", demonym: "Kazakhstani", aliases: ["Kazakh"] },
  { iso2: "KG", iso3: "KGZ", region: "CENTRAL_ASIA", name: "Kyrgyzstan", demonym: "Kyrgyzstani", aliases: ["Kyrgyz"] },
  { iso2: "TJ", iso3: "TJK", region: "CENTRAL_ASIA", name: "Tajikistan", demonym: "Tajikistani", aliases: ["Tajik"] },
  { iso2: "TM", iso3: "TKM", region: "CENTRAL_ASIA", name: "Turkmenistan", demonym: "Turkmen", aliases: ["Turkmenistani"] },
  { iso2: "UZ", iso3: "UZB", region: "CENTRAL_ASIA", name: "Uzbekistan", demonym: "Uzbekistani", aliases: ["Uzbek"] },

  // ── Europe / Schengen ────────────────────────────────────────────────
  { iso2: "DE", iso3: "DEU", region: "SCHENGEN", name: "Germany", demonym: "German" },
  { iso2: "FR", iso3: "FRA", region: "SCHENGEN", name: "France", demonym: "French" },
  { iso2: "IT", iso3: "ITA", region: "SCHENGEN", name: "Italy", demonym: "Italian" },
  { iso2: "ES", iso3: "ESP", region: "SCHENGEN", name: "Spain", demonym: "Spanish" },
  { iso2: "NL", iso3: "NLD", region: "SCHENGEN", name: "Netherlands", demonym: "Dutch", aliases: ["Holland"] },
  { iso2: "CH", iso3: "CHE", region: "SCHENGEN", name: "Switzerland", demonym: "Swiss" },
  { iso2: "AT", iso3: "AUT", region: "SCHENGEN", name: "Austria", demonym: "Austrian" },
  { iso2: "BE", iso3: "BEL", region: "SCHENGEN", name: "Belgium", demonym: "Belgian" },
  { iso2: "PT", iso3: "PRT", region: "SCHENGEN", name: "Portugal", demonym: "Portuguese" },
  { iso2: "GR", iso3: "GRC", region: "SCHENGEN", name: "Greece", demonym: "Greek" },
  { iso2: "SE", iso3: "SWE", region: "SCHENGEN", name: "Sweden", demonym: "Swedish" },
  { iso2: "NO", iso3: "NOR", region: "SCHENGEN", name: "Norway", demonym: "Norwegian" },
  { iso2: "DK", iso3: "DNK", region: "SCHENGEN", name: "Denmark", demonym: "Danish" },
  { iso2: "FI", iso3: "FIN", region: "SCHENGEN", name: "Finland", demonym: "Finnish" },
  { iso2: "PL", iso3: "POL", region: "SCHENGEN", name: "Poland", demonym: "Polish" },
  { iso2: "CZ", iso3: "CZE", region: "SCHENGEN", name: "Czech Republic", demonym: "Czech" },
  { iso2: "HU", iso3: "HUN", region: "SCHENGEN", name: "Hungary", demonym: "Hungarian" },
  { iso2: "IE", iso3: "IRL", region: "EUROPE", name: "Ireland", demonym: "Irish" },
  { iso2: "IS", iso3: "ISL", region: "SCHENGEN", name: "Iceland", demonym: "Icelandic" },
  { iso2: "LU", iso3: "LUX", region: "SCHENGEN", name: "Luxembourg", demonym: "Luxembourgish" },
  { iso2: "MT", iso3: "MLT", region: "SCHENGEN", name: "Malta", demonym: "Maltese" },
  { iso2: "HR", iso3: "HRV", region: "SCHENGEN", name: "Croatia", demonym: "Croatian" },
  { iso2: "RO", iso3: "ROU", region: "SCHENGEN", name: "Romania", demonym: "Romanian" },
  { iso2: "BG", iso3: "BGR", region: "SCHENGEN", name: "Bulgaria", demonym: "Bulgarian" },
  { iso2: "SK", iso3: "SVK", region: "SCHENGEN", name: "Slovakia", demonym: "Slovak" },
  { iso2: "SI", iso3: "SVN", region: "SCHENGEN", name: "Slovenia", demonym: "Slovenian" },
  { iso2: "EE", iso3: "EST", region: "SCHENGEN", name: "Estonia", demonym: "Estonian" },
  { iso2: "LV", iso3: "LVA", region: "SCHENGEN", name: "Latvia", demonym: "Latvian" },
  { iso2: "LT", iso3: "LTU", region: "SCHENGEN", name: "Lithuania", demonym: "Lithuanian" },
  { iso2: "RU", iso3: "RUS", region: "EUROPE", name: "Russia", demonym: "Russian" },
  { iso2: "GB", iso3: "GBR", region: "EUROPE", name: "United Kingdom", demonym: "British", aliases: ["UK", "Britain", "England"] },
  { iso2: "AL", iso3: "ALB", region: "EUROPE", name: "Albania", demonym: "Albanian" },
  { iso2: "BA", iso3: "BIH", region: "EUROPE", name: "Bosnia and Herzegovina", demonym: "Bosnian", aliases: ["Bosnia & Herzegovina", "Bosnia"] },
  { iso2: "CY", iso3: "CYP", region: "EUROPE", name: "Cyprus", demonym: "Cypriot" },
  { iso2: "LI", iso3: "LIE", region: "SCHENGEN", name: "Liechtenstein", demonym: "Liechtensteiner", aliases: ["Liechtensteinian"] },
  { iso2: "MD", iso3: "MDA", region: "EUROPE", name: "Moldova", demonym: "Moldovan" },
  { iso2: "ME", iso3: "MNE", region: "EUROPE", name: "Montenegro", demonym: "Montenegrin" },
  { iso2: "MK", iso3: "MKD", region: "EUROPE", name: "North Macedonia", demonym: "Macedonian", aliases: ["North Macedonian"] },
  { iso2: "RS", iso3: "SRB", region: "EUROPE", name: "Serbia", demonym: "Serbian" },
  { iso2: "UA", iso3: "UKR", region: "EUROPE", name: "Ukraine", demonym: "Ukrainian" },

  // ── Americas ─────────────────────────────────────────────────────────
  { iso2: "US", iso3: "USA", region: "AMERICAS", name: "United States", demonym: "American", aliases: ["USA", "United States of America"] },
  { iso2: "CA", iso3: "CAN", region: "AMERICAS", name: "Canada", demonym: "Canadian" },
  { iso2: "MX", iso3: "MEX", region: "AMERICAS", name: "Mexico", demonym: "Mexican" },
  { iso2: "BR", iso3: "BRA", region: "AMERICAS", name: "Brazil", demonym: "Brazilian" },
  { iso2: "AR", iso3: "ARG", region: "AMERICAS", name: "Argentina", demonym: "Argentine", aliases: ["Argentinian"] },
  { iso2: "CL", iso3: "CHL", region: "AMERICAS", name: "Chile", demonym: "Chilean" },
  { iso2: "CO", iso3: "COL", region: "AMERICAS", name: "Colombia", demonym: "Colombian" },
  { iso2: "CR", iso3: "CRI", region: "AMERICAS", name: "Costa Rica", demonym: "Costa Rican" },
  { iso2: "CU", iso3: "CUB", region: "AMERICAS", name: "Cuba", demonym: "Cuban" },
  { iso2: "EC", iso3: "ECU", region: "AMERICAS", name: "Ecuador", demonym: "Ecuadorian", aliases: ["Ecuadorean"] },
  { iso2: "PA", iso3: "PAN", region: "AMERICAS", name: "Panama", demonym: "Panamanian" },
  { iso2: "PE", iso3: "PER", region: "AMERICAS", name: "Peru", demonym: "Peruvian" },
  { iso2: "UY", iso3: "URY", region: "AMERICAS", name: "Uruguay", demonym: "Uruguayan" },

  // ── Oceania ──────────────────────────────────────────────────────────
  { iso2: "AU", iso3: "AUS", region: "OCEANIA", name: "Australia", demonym: "Australian" },
  { iso2: "NZ", iso3: "NZL", region: "OCEANIA", name: "New Zealand", demonym: "New Zealander", aliases: ["Kiwi"] },
  { iso2: "FJ", iso3: "FJI", region: "OCEANIA", name: "Fiji", demonym: "Fijian" },
  { iso2: "PG", iso3: "PNG", region: "OCEANIA", name: "Papua New Guinea", demonym: "Papua New Guinean", aliases: ["PNG"] },
  { iso2: "WS", iso3: "WSM", region: "OCEANIA", name: "Samoa", demonym: "Samoan" },
  { iso2: "VU", iso3: "VUT", region: "OCEANIA", name: "Vanuatu", demonym: "Ni-Vanuatu", aliases: ["Vanuatuan"] },

  // ── Africa ───────────────────────────────────────────────────────────
  { iso2: "EG", iso3: "EGY", region: "AFRICA", name: "Egypt", demonym: "Egyptian" },
  { iso2: "ZA", iso3: "ZAF", region: "AFRICA", name: "South Africa", demonym: "South African" },
  { iso2: "KE", iso3: "KEN", region: "AFRICA", name: "Kenya", demonym: "Kenyan" },
  { iso2: "TZ", iso3: "TZA", region: "AFRICA", name: "Tanzania", demonym: "Tanzanian" },
  { iso2: "MA", iso3: "MAR", region: "AFRICA", name: "Morocco", demonym: "Moroccan" },
  { iso2: "MU", iso3: "MUS", region: "AFRICA", name: "Mauritius", demonym: "Mauritian" },
  { iso2: "SC", iso3: "SYC", region: "AFRICA", name: "Seychelles", demonym: "Seychellois" },
  { iso2: "NG", iso3: "NGA", region: "AFRICA", name: "Nigeria", demonym: "Nigerian" },
  { iso2: "ET", iso3: "ETH", region: "AFRICA", name: "Ethiopia", demonym: "Ethiopian" },
  { iso2: "GH", iso3: "GHA", region: "AFRICA", name: "Ghana", demonym: "Ghanaian" },
  { iso2: "DZ", iso3: "DZA", region: "AFRICA", name: "Algeria", demonym: "Algerian" },
  { iso2: "BW", iso3: "BWA", region: "AFRICA", name: "Botswana", demonym: "Motswana", aliases: ["Batswana", "Botswanan"] },
  { iso2: "NA", iso3: "NAM", region: "AFRICA", name: "Namibia", demonym: "Namibian" },
  { iso2: "RW", iso3: "RWA", region: "AFRICA", name: "Rwanda", demonym: "Rwandan" },
  { iso2: "TN", iso3: "TUN", region: "AFRICA", name: "Tunisia", demonym: "Tunisian" },
  { iso2: "UG", iso3: "UGA", region: "AFRICA", name: "Uganda", demonym: "Ugandan" },
  { iso2: "ZM", iso3: "ZMB", region: "AFRICA", name: "Zambia", demonym: "Zambian" },
  { iso2: "ZW", iso3: "ZWE", region: "AFRICA", name: "Zimbabwe", demonym: "Zimbabwean" },
] as const;

// Case-insensitive, whitespace-tolerant key: strips parenthetical
// qualifiers (so "United Arab Emirates(Dubai)" resolves the same as "United
// Arab Emirates" — checklist PDFs often suffix a destination name with the
// specific emirate/city the consulate covers), strips periods (so "U.A.E."
// / "U.S.A." normalise the same as "UAE" / "USA"), then trims and collapses
// internal whitespace runs.
function normaliseKey(input: string): string {
  return input
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\./g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

const LOOKUP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const c of COUNTRY_CODES) {
    const keys = [c.iso2, c.iso3, c.name, c.demonym, ...(c.aliases ?? [])];
    for (const key of keys) {
      const nk = normaliseKey(key);
      if (!map.has(nk)) map.set(nk, c.iso2); // first entry wins on collision
    }
  }
  return map;
})();

/**
 * Resolve ISO2, ISO3, a country name, or a demonym to ISO 3166-1 alpha-2.
 * Case-insensitive and whitespace-tolerant. Returns null for anything
 * unrecognised — never throws, since this runs on user-entered/OCR'd text.
 */
export function normaliseToIso2(input: string | null | undefined): string | null {
  if (!input) return null;
  const nk = normaliseKey(input);
  if (!nk) return null;
  return LOOKUP.get(nk) ?? null;
}

export function getCountryByIso2(iso2: string | null | undefined): CountryCodeEntry | undefined {
  if (!iso2) return undefined;
  const nk = normaliseKey(iso2);
  return COUNTRY_CODES.find((c) => c.iso2 === nk);
}
