// apps/backend/src/services/policyCompliance/regions.ts
//
// Six reporting regions for Policy Compliance, and free-text work location →
// country. Not core.ts REGIONS: those are rule scopes (SAARC, GCC …) and leave
// India out.
import { ISO_COUNTRIES } from "../../data/isoCodes.js";
import { travelCountryFuzzy, travelLookup, travelLookupFuzzy } from "../../data/destinationLookup.js";

export const COMPLIANCE_REGIONS = ["India", "Americas", "APAC", "Middle East", "Africa", "Europe"] as const;
export type ComplianceRegion = (typeof COMPLIANCE_REGIONS)[number];
/** Work location / destination missing or not recognised. Shown, never folded into a region. */
export const UNKNOWN_REGION = "Not set";
export type RegionLabel = ComplianceRegion | typeof UNKNOWN_REGION;

const COUNTRIES: Record<Exclude<ComplianceRegion, "India">, string> = {
  Americas:
    "US CA MX GT BZ SV HN NI CR PA CU DO HT JM TT BS BB AG DM GD KN LC VC AW CW SX BQ PR VI VG KY BM TC AI MS GP MQ MF BL " +
    "BR AR CL PE CO EC UY PY BO VE GY SR GF FK GL PM UM",
  APAC:
    "NP BT BD LK MV PK AF SG MY TH ID VN PH KH LA MM BN TL CN HK MO TW JP KR KP MN KZ KG TJ TM UZ " +
    "AU NZ FJ PG SB VU NC PF WS AS TO TV KI NR FM MH PW GU MP CK NU NF TK WF PN CX CC IO HM",
  "Middle East": "AE SA QA OM KW BH IL JO LB IQ IR SY YE PS",
  Africa:
    "ZA KE NG GH TZ UG RW ET EG MA TN DZ LY SD SS MU SC MG ZM ZW BW NA MZ SN CI CM CD CG GA GQ AO BI BJ BF CF TD KM CV DJ ER SZ GM GN GW " +
    "LS LR MW ML MR NE ST SL SO TG EH RE YT SH",
  Europe:
    "GB IE FR DE IT ES PT NL BE LU CH AT DK SE NO FI IS PL CZ SK HU SI HR RS BA ME MK AL GR RO BG EE LV LT MT CY TR UA MD BY RU " +
    "MC LI AD SM VA GE AM AZ GI FO AX GG JE IM SJ",
};

const BY_COUNTRY = new Map<string, ComplianceRegion>([["IN", "India"]]);
for (const [region, codes] of Object.entries(COUNTRIES)) {
  for (const c of codes.split(" ")) BY_COUNTRY.set(c, region as ComplianceRegion);
}

export function regionForCountry(iso2: unknown): RegionLabel {
  return BY_COUNTRY.get(String(iso2 ?? "").trim().toUpperCase()) ?? UNKNOWN_REGION;
}

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// "Georgia" is also a US state, so a bare name does not settle the country.
const BY_NAME = new Map<string, string>(ISO_COUNTRIES.map((c) => [norm(c.name), c.code]));
BY_NAME.delete("georgia");
for (const [name, code] of [
  ["usa", "US"],
  ["u.s.a.", "US"],
  ["united states of america", "US"],
  ["uk", "GB"],
  ["u.k.", "GB"],
  ["england", "GB"],
  ["uae", "AE"],
  ["hong kong", "HK"],
]) {
  BY_NAME.set(name, code);
}

/**
 * Country of a free-text work location ("Sydney, Australia", "Bengaluru",
 * "US"). A written country name wins; then a known city; then a place name
 * inside the text. A two-letter code counts only on its own: "San Francisco,
 * CA" is not Canada. null when nothing is recognised.
 */
export function workLocationCountry(raw: unknown): string | null {
  const text = norm(raw);
  if (!text) return null;
  if (/^[a-z]{2}$/.test(text) && BY_COUNTRY.has(text.toUpperCase())) return text.toUpperCase();
  const parts = text.split(/\s*[,/|()]\s*|\s[-–]\s/).filter(Boolean);
  for (const p of [...parts].reverse()) if (BY_NAME.has(p)) return BY_NAME.get(p)!;
  for (const p of parts) {
    if (p.length <= 2) continue;
    const hit = travelLookup(p);
    if (hit?.country) return hit.country;
  }
  return travelCountryFuzzy(text) ?? travelLookupFuzzy(text)?.country ?? null;
}

export function workLocationRegion(raw: unknown): RegionLabel {
  return regionForCountry(workLocationCountry(raw));
}
