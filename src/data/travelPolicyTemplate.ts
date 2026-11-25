// apps/backend/src/data/travelPolicyTemplate.ts
//
// The Plumtrips DEFAULT travel-policy template (decision D4: a code constant,
// changed by merge request). It is ONLY ever copied into a workspace's new
// DRAFT ("Start from template") and, once, into an empty city list. It is
// never read when deciding what a workspace's policy is: a workspace with no
// published version is "Not configured", full stop.
//
// Every amount is INR (D10). Tiers ship with NO designation/band mapping —
// each company maps its own hierarchy.

import type { Cabin, CityClass, Rule, Tier } from "../services/travelPolicy/core.js";

export const TEMPLATE_VERSION = "2026-11-19";

export const TEMPLATE_TIERS: Tier[] = [
  { tierKey: "leadership", name: "Leadership", code: "LDR", description: "CEO, CXO, Directors", sortOrder: 0, active: true, designationIds: [], bandNumbers: [] },
  { tierKey: "senior", name: "Senior", code: "SNR", description: "VP, AVP, General Manager", sortOrder: 1, active: true, designationIds: [], bandNumbers: [] },
  { tierKey: "mid", name: "Mid-Level", code: "MID", description: "Managers, Team Leads", sortOrder: 2, active: true, designationIds: [], bandNumbers: [] },
  { tierKey: "junior", name: "Junior", code: "JNR", description: "Executives, Associates", sortOrder: 3, active: true, designationIds: [], bandNumbers: [] },
];

type Amounts = {
  cabins: Cabin[];
  fareDom: number;
  fareIntl: number;
  advDom: number;
  advIntl: number;
  hotel: Record<CityClass, number>;
  stars: number;
  forexDay: number;
  forexTrip: number;
  visaFee: number;
  visaService: number;
  esim: number;
};

const PER_TIER: Record<string, Amounts> = {
  leadership: {
    cabins: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS"],
    fareDom: 35000, fareIntl: 150000, advDom: 3, advIntl: 7,
    hotel: { METRO: 15000, TIER2: 10000, OTHER: 8000, INTERNATIONAL: 25000 },
    stars: 5, forexDay: 15000, forexTrip: 200000, visaFee: 25000, visaService: 5000, esim: 5000,
  },
  senior: {
    cabins: ["ECONOMY", "PREMIUM_ECONOMY"],
    fareDom: 25000, fareIntl: 90000, advDom: 5, advIntl: 10,
    hotel: { METRO: 10000, TIER2: 7500, OTHER: 6000, INTERNATIONAL: 18000 },
    stars: 4, forexDay: 10000, forexTrip: 150000, visaFee: 20000, visaService: 3000, esim: 3500,
  },
  mid: {
    cabins: ["ECONOMY"],
    fareDom: 15000, fareIntl: 60000, advDom: 7, advIntl: 14,
    hotel: { METRO: 7000, TIER2: 5500, OTHER: 4500, INTERNATIONAL: 12000 },
    stars: 4, forexDay: 7500, forexTrip: 100000, visaFee: 15000, visaService: 2000, esim: 2500,
  },
  junior: {
    cabins: ["ECONOMY"],
    fareDom: 10000, fareIntl: 45000, advDom: 10, advIntl: 21,
    hotel: { METRO: 5000, TIER2: 4000, OTHER: 3000, INTERNATIONAL: 9000 },
    stars: 3, forexDay: 5000, forexTrip: 75000, visaFee: 12000, visaService: 1500, esim: 1500,
  },
};

function buildRules(): Rule[] {
  const rules: Rule[] = [];
  for (const t of TEMPLATE_TIERS) {
    const a = PER_TIER[t.tierKey];
    rules.push({
      ruleKey: `${t.tierKey}-flight`, category: "FLIGHT", tierKey: t.tierKey, scope: { kind: "DEFAULT", value: null }, currency: "INR", notes: "",
      params: {
        allowedCabins: a.cabins, maxFareDomestic: a.fareDom, maxFareInternational: a.fareIntl,
        minAdvanceDaysDomestic: a.advDom, minAdvanceDaysInternational: a.advIntl, fareLimitBasis: "ONE_WAY",
      },
    });
    for (const cls of ["METRO", "TIER2", "OTHER", "INTERNATIONAL"] as CityClass[]) {
      rules.push({
        ruleKey: `${t.tierKey}-hotel-${cls.toLowerCase()}`, category: "HOTEL", tierKey: t.tierKey, scope: { kind: "CITY_CLASS", value: cls }, currency: "INR", notes: "",
        params: { maxPerNight: a.hotel[cls], taxesIncluded: true, maxStarRating: a.stars },
      });
    }
    rules.push({
      ruleKey: `${t.tierKey}-forex`, category: "FOREX", tierKey: t.tierKey, scope: { kind: "DEFAULT", value: null }, currency: "INR", notes: "",
      params: { eligible: true, perTripMax: a.forexTrip, perDayMax: a.forexDay, allowedCurrencies: [], appliesTo: "INTERNATIONAL" },
    });
    rules.push({
      ruleKey: `${t.tierKey}-visa`, category: "VISA", tierKey: t.tierKey, scope: { kind: "DEFAULT", value: null }, currency: "INR", notes: "",
      params: { eligible: true, applicationFeeMax: a.visaFee, serviceFeeMax: a.visaService, requirement: "OPTIONAL", reimbursable: true },
    });
    rules.push({
      ruleKey: `${t.tierKey}-esim`, category: "ESIM", tierKey: t.tierKey, scope: { kind: "DEFAULT", value: null }, currency: "INR", notes: "",
      params: { eligible: true, maxCost: a.esim, limitBasis: "PER_TRIP" },
    });
  }
  return rules;
}

export const TEMPLATE_RULES: Rule[] = buildRules();

export interface TemplateCity {
  name: string;
  code: string; // IATA city code where one exists, else ""
  state: string;
  country: "IN";
  category: CityClass;
}

// D7 (2026-11-19): Metro = Delhi NCR (Delhi, Gurugram, Noida, Ghaziabad,
// Faridabad), Mumbai (incl. Navi Mumbai, Thane), Bengaluru, Chennai, Kolkata,
// Hyderabad, Pune, Ahmedabad. Tier-2 as proposed in the audit. Both lists are
// copied per workspace and editable there; every other Indian city is OTHER
// and every other country INTERNATIONAL without needing a row.
export const TEMPLATE_CITIES: TemplateCity[] = [
  { name: "Delhi", code: "DEL", state: "Delhi", country: "IN", category: "METRO" },
  { name: "Gurugram", code: "", state: "Haryana", country: "IN", category: "METRO" },
  { name: "Noida", code: "", state: "Uttar Pradesh", country: "IN", category: "METRO" },
  { name: "Ghaziabad", code: "", state: "Uttar Pradesh", country: "IN", category: "METRO" },
  { name: "Faridabad", code: "", state: "Haryana", country: "IN", category: "METRO" },
  { name: "Mumbai", code: "BOM", state: "Maharashtra", country: "IN", category: "METRO" },
  { name: "Navi Mumbai", code: "NMI", state: "Maharashtra", country: "IN", category: "METRO" },
  { name: "Thane", code: "", state: "Maharashtra", country: "IN", category: "METRO" },
  { name: "Bengaluru", code: "BLR", state: "Karnataka", country: "IN", category: "METRO" },
  { name: "Chennai", code: "MAA", state: "Tamil Nadu", country: "IN", category: "METRO" },
  { name: "Kolkata", code: "CCU", state: "West Bengal", country: "IN", category: "METRO" },
  { name: "Hyderabad", code: "HYD", state: "Telangana", country: "IN", category: "METRO" },
  { name: "Pune", code: "PNQ", state: "Maharashtra", country: "IN", category: "METRO" },
  { name: "Ahmedabad", code: "AMD", state: "Gujarat", country: "IN", category: "METRO" },

  { name: "Jaipur", code: "JAI", state: "Rajasthan", country: "IN", category: "TIER2" },
  { name: "Lucknow", code: "LKO", state: "Uttar Pradesh", country: "IN", category: "TIER2" },
  { name: "Kochi", code: "COK", state: "Kerala", country: "IN", category: "TIER2" },
  { name: "Chandigarh", code: "IXC", state: "Chandigarh", country: "IN", category: "TIER2" },
  { name: "Goa", code: "GOI", state: "Goa", country: "IN", category: "TIER2" },
  { name: "Indore", code: "IDR", state: "Madhya Pradesh", country: "IN", category: "TIER2" },
  { name: "Bhopal", code: "BHO", state: "Madhya Pradesh", country: "IN", category: "TIER2" },
  { name: "Nagpur", code: "NAG", state: "Maharashtra", country: "IN", category: "TIER2" },
  { name: "Surat", code: "STV", state: "Gujarat", country: "IN", category: "TIER2" },
  { name: "Vadodara", code: "BDQ", state: "Gujarat", country: "IN", category: "TIER2" },
  { name: "Rajkot", code: "HSR", state: "Gujarat", country: "IN", category: "TIER2" },
  { name: "Coimbatore", code: "CJB", state: "Tamil Nadu", country: "IN", category: "TIER2" },
  { name: "Madurai", code: "IXM", state: "Tamil Nadu", country: "IN", category: "TIER2" },
  { name: "Tiruchirappalli", code: "TRZ", state: "Tamil Nadu", country: "IN", category: "TIER2" },
  { name: "Visakhapatnam", code: "VTZ", state: "Andhra Pradesh", country: "IN", category: "TIER2" },
  { name: "Vijayawada", code: "VGA", state: "Andhra Pradesh", country: "IN", category: "TIER2" },
  { name: "Bhubaneswar", code: "BBI", state: "Odisha", country: "IN", category: "TIER2" },
  { name: "Patna", code: "PAT", state: "Bihar", country: "IN", category: "TIER2" },
  { name: "Ranchi", code: "IXR", state: "Jharkhand", country: "IN", category: "TIER2" },
  { name: "Raipur", code: "RPR", state: "Chhattisgarh", country: "IN", category: "TIER2" },
  { name: "Guwahati", code: "GAU", state: "Assam", country: "IN", category: "TIER2" },
  { name: "Thiruvananthapuram", code: "TRV", state: "Kerala", country: "IN", category: "TIER2" },
  { name: "Kozhikode", code: "CCJ", state: "Kerala", country: "IN", category: "TIER2" },
  { name: "Mysuru", code: "MYQ", state: "Karnataka", country: "IN", category: "TIER2" },
  { name: "Mangaluru", code: "IXE", state: "Karnataka", country: "IN", category: "TIER2" },
  { name: "Nashik", code: "ISK", state: "Maharashtra", country: "IN", category: "TIER2" },
  { name: "Aurangabad", code: "IXU", state: "Maharashtra", country: "IN", category: "TIER2" },
  { name: "Varanasi", code: "VNS", state: "Uttar Pradesh", country: "IN", category: "TIER2" },
  { name: "Kanpur", code: "KNU", state: "Uttar Pradesh", country: "IN", category: "TIER2" },
  { name: "Agra", code: "AGR", state: "Uttar Pradesh", country: "IN", category: "TIER2" },
  { name: "Amritsar", code: "ATQ", state: "Punjab", country: "IN", category: "TIER2" },
  { name: "Ludhiana", code: "LUH", state: "Punjab", country: "IN", category: "TIER2" },
  { name: "Dehradun", code: "DED", state: "Uttarakhand", country: "IN", category: "TIER2" },
  { name: "Jodhpur", code: "JDH", state: "Rajasthan", country: "IN", category: "TIER2" },
  { name: "Udaipur", code: "UDR", state: "Rajasthan", country: "IN", category: "TIER2" },
  { name: "Jammu", code: "IXJ", state: "Jammu and Kashmir", country: "IN", category: "TIER2" },
  { name: "Srinagar", code: "SXR", state: "Jammu and Kashmir", country: "IN", category: "TIER2" },
];
