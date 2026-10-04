// apps/backend/src/services/approvalItemRules.ts
// ── SHARED RULES: everything below this line is byte-identical to
// apps/frontend/src/lib/approvalItemRules.ts (approvalItemRules.parity.test.ts
// fails if they drift). No imports, so both builds compile it as is.
//
// What an approval request's cart items must contain, per service, and what
// the server derives itself. The request form (ApprovalNew) runs these before
// Add / Submit; POST and PUT /api/approvals/requests run the same functions
// and refuse what they flag, so a bypassed client gets the same answer.
//
// Travellers per service (Imran, 2026-10-04):
//   flight, hotel, visa, cab  — full details; international adds DOB, passport
//                               number, expiry and nationality, and the passport
//                               must still be valid on the last day of the trip
//   forex                     — one traveller (name) + their PAN
//   esim                      — names + phone or email for each traveller
//   holiday, mice             — no traveller list: a lead contact + head count
// Head counts for flight / hotel / visa / cab / esim come from the traveller
// list (deriveCounts); holiday people and MICE attendees are typed.

export type ServiceKey = "flight" | "hotel" | "visa" | "cab" | "forex" | "esim" | "holiday" | "mice";
export const SERVICE_KEYS: ServiceKey[] = ["flight", "hotel", "visa", "cab", "forex", "esim", "holiday", "mice"];

export type TravellerRule = "full" | "pan" | "contact" | "lead";
export const TRAVELLER_RULE: Record<ServiceKey, TravellerRule> = {
  flight: "full",
  hotel: "full",
  visa: "full",
  cab: "full",
  forex: "pan",
  esim: "contact",
  holiday: "lead",
  mice: "lead",
};

/** Always international: there is no domestic visa, foreign currency or roaming eSIM. */
export const ALWAYS_INTERNATIONAL: ServiceKey[] = ["visa", "forex", "esim"];

export const PRIORITIES = ["Normal", "High", "Urgent"];
export const CABIN_CLASSES = ["Economy", "Premium Economy", "Business", "First"];
export const FLIGHT_TIMES = ["Any", "Early morning (before 8am)", "Morning (8am–12pm)", "Afternoon (12–5pm)", "Evening (5–9pm)", "Night (after 9pm)"];
export const HOTEL_TYPES = ["Business", "Boutique", "Luxury", "Budget", "Serviced Apartment"];
export const STAR_RATINGS = ["Any", "3 Star", "4 Star", "5 Star"];
export const ROOM_TYPES = ["Standard", "Deluxe", "Executive", "Suite"];
export const MEAL_PLANS = ["Breakfast", "Half Board", "Full Board", "No Meals"];
export const VISA_TYPES: Array<[string, string]> = [["eVisa", "eVisa"], ["sticker", "Sticker visa"], ["stamp", "Visa on arrival"]];
export const VISA_PURPOSES = ["Business", "Conference", "Tourism", "Transit"];
export const VISA_SPEEDS = ["Standard", "Express", "Super Express"];
export const CAB_TRIP_TYPES: Array<[string, string]> = [["oneway", "One way"], ["roundtrip", "Round trip"], ["hourly", "Hourly rental"]];
export const VEHICLE_TYPES = ["Sedan", "SUV", "Innova / MPV", "Tempo Traveller"];
export const LUGGAGE = ["Light", "Medium", "Heavy"];
export const FOREX_DELIVERY = ["Cash", "Forex Card", "Cash + Forex Card"];
export const FOREX_PURPOSES = ["Business travel", "Conference", "Client visit", "Other"];
export const ESIM_PACKS = ["1 GB", "3 GB", "5 GB", "10 GB", "20 GB", "Unlimited"];
export const BUDGET_BANDS = ["Value", "Premium", "Luxury", "Ultra Luxury"];
export const HOLIDAY_HOTEL_CLASSES = ["3 Star", "4 Star", "5 Star", "Villas"];
export const MICE_MODES = ["Offsite", "Onsite", "Conference", "Incentive trip"];
export const MICE_TRAVEL_MODES = ["Flights", "Train", "Bus", "Self Drive", "Not Required"];
export const MICE_HOTEL_TYPES = ["3 Star", "4 Star", "5 Star", "Resort", "Villa / Private"];
export const FOOD_PREFS = ["Veg", "Non-Veg", "Veg + Non-Veg", "Vegan", "Jain"];

export const MAX_LEGS = 6;
export const MAX_NOTES = 1000;
export const MAX_COMMENT = 1000;

/* ISO 3166-1 alpha-2 (code:name). */
const COUNTRY_LIST =
  "AF:Afghanistan|AL:Albania|DZ:Algeria|AD:Andorra|AO:Angola|AG:Antigua and Barbuda|AR:Argentina|AM:Armenia|AU:Australia|AT:Austria|AZ:Azerbaijan|BS:Bahamas|BH:Bahrain|BD:Bangladesh|BB:Barbados|BY:Belarus|BE:Belgium|BZ:Belize|BJ:Benin|BT:Bhutan|BO:Bolivia|BA:Bosnia and Herzegovina|BW:Botswana|BR:Brazil|BN:Brunei|BG:Bulgaria|BF:Burkina Faso|BI:Burundi|CV:Cabo Verde|KH:Cambodia|CM:Cameroon|CA:Canada|CF:Central African Republic|TD:Chad|CL:Chile|CN:China|CO:Colombia|KM:Comoros|CG:Congo|CD:Congo (DR)|CR:Costa Rica|CI:Côte d'Ivoire|HR:Croatia|CU:Cuba|CY:Cyprus|CZ:Czechia|DK:Denmark|DJ:Djibouti|DM:Dominica|DO:Dominican Republic|EC:Ecuador|EG:Egypt|SV:El Salvador|GQ:Equatorial Guinea|ER:Eritrea|EE:Estonia|SZ:Eswatini|ET:Ethiopia|FJ:Fiji|FI:Finland|FR:France|GA:Gabon|GM:Gambia|GE:Georgia|DE:Germany|GH:Ghana|GR:Greece|GD:Grenada|GT:Guatemala|GN:Guinea|GW:Guinea-Bissau|GY:Guyana|HT:Haiti|HN:Honduras|HK:Hong Kong|HU:Hungary|IS:Iceland|IN:India|ID:Indonesia|IR:Iran|IQ:Iraq|IE:Ireland|IL:Israel|IT:Italy|JM:Jamaica|JP:Japan|JO:Jordan|KZ:Kazakhstan|KE:Kenya|KI:Kiribati|KW:Kuwait|KG:Kyrgyzstan|LA:Laos|LV:Latvia|LB:Lebanon|LS:Lesotho|LR:Liberia|LY:Libya|LI:Liechtenstein|LT:Lithuania|LU:Luxembourg|MO:Macao|MG:Madagascar|MW:Malawi|MY:Malaysia|MV:Maldives|ML:Mali|MT:Malta|MH:Marshall Islands|MR:Mauritania|MU:Mauritius|MX:Mexico|FM:Micronesia|MD:Moldova|MC:Monaco|MN:Mongolia|ME:Montenegro|MA:Morocco|MZ:Mozambique|MM:Myanmar|NA:Namibia|NR:Nauru|NP:Nepal|NL:Netherlands|NZ:New Zealand|NI:Nicaragua|NE:Niger|NG:Nigeria|KP:North Korea|MK:North Macedonia|NO:Norway|OM:Oman|PK:Pakistan|PW:Palau|PS:Palestine|PA:Panama|PG:Papua New Guinea|PY:Paraguay|PE:Peru|PH:Philippines|PL:Poland|PT:Portugal|QA:Qatar|RO:Romania|RU:Russia|RW:Rwanda|KN:Saint Kitts and Nevis|LC:Saint Lucia|VC:Saint Vincent and the Grenadines|WS:Samoa|SM:San Marino|ST:Sao Tome and Principe|SA:Saudi Arabia|SN:Senegal|RS:Serbia|SC:Seychelles|SL:Sierra Leone|SG:Singapore|SK:Slovakia|SI:Slovenia|SB:Solomon Islands|SO:Somalia|ZA:South Africa|KR:South Korea|SS:South Sudan|ES:Spain|LK:Sri Lanka|SD:Sudan|SR:Suriname|SE:Sweden|CH:Switzerland|SY:Syria|TW:Taiwan|TJ:Tajikistan|TZ:Tanzania|TH:Thailand|TL:Timor-Leste|TG:Togo|TO:Tonga|TT:Trinidad and Tobago|TN:Tunisia|TR:Türkiye|TM:Turkmenistan|TV:Tuvalu|UG:Uganda|UA:Ukraine|AE:United Arab Emirates|GB:United Kingdom|US:United States|UY:Uruguay|UZ:Uzbekistan|VU:Vanuatu|VA:Vatican City|VE:Venezuela|VN:Vietnam|YE:Yemen|ZM:Zambia|ZW:Zimbabwe";

/* ISO 4217 currencies a traveller can buy (code:name). INR is not forex. */
const CURRENCY_LIST =
  "USD:US Dollar|EUR:Euro|GBP:British Pound|AED:UAE Dirham|SGD:Singapore Dollar|AUD:Australian Dollar|CAD:Canadian Dollar|CHF:Swiss Franc|JPY:Japanese Yen|CNY:Chinese Yuan|HKD:Hong Kong Dollar|NZD:New Zealand Dollar|SAR:Saudi Riyal|QAR:Qatari Riyal|OMR:Omani Rial|KWD:Kuwaiti Dinar|BHD:Bahraini Dinar|THB:Thai Baht|MYR:Malaysian Ringgit|IDR:Indonesian Rupiah|VND:Vietnamese Dong|PHP:Philippine Peso|KRW:South Korean Won|TWD:New Taiwan Dollar|LKR:Sri Lankan Rupee|NPR:Nepalese Rupee|BDT:Bangladeshi Taka|MVR:Maldivian Rufiyaa|ZAR:South African Rand|EGP:Egyptian Pound|KES:Kenyan Shilling|MUR:Mauritian Rupee|TRY:Turkish Lira|RUB:Russian Ruble|SEK:Swedish Krona|NOK:Norwegian Krone|DKK:Danish Krone|PLN:Polish Zloty|CZK:Czech Koruna|HUF:Hungarian Forint|ILS:Israeli Shekel|JOD:Jordanian Dinar|MXN:Mexican Peso|BRL:Brazilian Real|ARS:Argentine Peso|CLP:Chilean Peso|GEL:Georgian Lari|KZT:Kazakhstani Tenge|UZS:Uzbekistani Som|AZN:Azerbaijani Manat|AMD:Armenian Dram|MAD:Moroccan Dirham|TZS:Tanzanian Shilling|FJD:Fijian Dollar|KHR:Cambodian Riel|LAK:Lao Kip|MMK:Myanmar Kyat|MNT:Mongolian Tugrik|ISK:Icelandic Krona|RON:Romanian Leu";

function parseList(list: string): Array<[string, string]> {
  return list.split("|").map((p) => {
    const i = p.indexOf(":");
    return [p.slice(0, i), p.slice(i + 1)] as [string, string];
  });
}

export const COUNTRIES: Array<[string, string]> = parseList(COUNTRY_LIST).sort((a, b) => a[1].localeCompare(b[1]));
export const CURRENCIES: Array<[string, string]> = parseList(CURRENCY_LIST);
const COUNTRY_NAME: Record<string, string> = {};
for (const [c, n] of COUNTRIES) COUNTRY_NAME[c] = n;
const CURRENCY_NAME: Record<string, string> = {};
for (const [c, n] of CURRENCIES) CURRENCY_NAME[c] = n;

export function countryName(code: any): string {
  return COUNTRY_NAME[str(code).toUpperCase()] || "";
}
export function currencyName(code: any): string {
  return CURRENCY_NAME[str(code).toUpperCase()] || "";
}

/* ───────────────────────── helpers ───────────────────────── */

export type RuleTraveller = {
  travellerId?: string;
  kind?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  dob?: string;
  gender?: string;
  nationality?: string;
  passportNumber?: string;
  passportExpiry?: string;
  phone?: string;
  email?: string;
};

export type RuleItem = { type?: string; title?: string; description?: string; qty?: number; price?: number; meta?: any };

/** One problem with one field. `field` is a meta key ("departDate", "legs.1.origin", "travellers", "traveller:<id>"). */
export type Issue = { field: string; code: string; message: string; missing?: string[] };

export function str(v: any): string {
  return String(v ?? "").trim();
}

export function isISODate(v: any): boolean {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** A whole number typed into a field ("3", " 12 "), or null for empty / not a whole number. */
export function wholeNumber(v: any): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  const s = str(v);
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** A positive amount ("500", "250.50"), or null. */
export function positiveAmount(v: any): number | null {
  if (typeof v === "number") return v > 0 && Number.isFinite(v) ? v : null;
  const s = str(v).replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

export function ageOn(dob: any, on: string): number | null {
  if (!isISODate(dob) || !isISODate(on)) return null;
  const [by, bm, bd] = str(dob).split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

export function travellerFullName(t: RuleTraveller | null | undefined): string {
  if (!t) return "";
  return [t.firstName, t.middleName, t.lastName].map(str).filter(Boolean).join(" ");
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RX = /^\+?[\d\s()-]{7,20}$/;
const PAN_RX = /^[A-Z]{5}\d{4}[A-Z]$/;
const IATA_RX = /^[A-Z]{3}$/;
const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isEmail(v: any) {
  return EMAIL_RX.test(str(v));
}
export function isPhone(v: any) {
  return PHONE_RX.test(str(v)) && str(v).replace(/\D/g, "").length >= 7;
}
export function isPan(v: any) {
  return PAN_RX.test(str(v).toUpperCase());
}

export function serviceOf(item: RuleItem): ServiceKey | null {
  const t = str(item?.type).toLowerCase();
  return (SERVICE_KEYS as string[]).includes(t) ? (t as ServiceKey) : null;
}

export function isInternational(type: ServiceKey, meta: any): boolean {
  return ALWAYS_INTERNATIONAL.includes(type) || str(meta?.travelScope).toLowerCase() === "international";
}

export function flightTripType(meta: any): "oneway" | "roundtrip" | "multicity" {
  const t = str(meta?.tripType).toLowerCase();
  return t === "roundtrip" || t === "multicity" ? t : "oneway";
}

function legsOf(meta: any): Array<{ origin?: string; destination?: string; date?: string }> {
  return Array.isArray(meta?.legs) ? meta.legs.filter((l: any) => l && typeof l === "object") : [];
}

/**
 * First and last day of the item (ISO), "" where unknown. `travel` is false
 * for forex: its date is a delivery date, not a travel date, so need-by and
 * passport validity don't apply to it.
 */
export function itemDates(type: ServiceKey, m: any): { start: string; end: string; travel: boolean } {
  const d = (v: any) => (isISODate(v) ? str(v) : "");
  if (type === "flight") {
    const trip = flightTripType(m);
    if (trip === "multicity") {
      const legs = legsOf(m);
      return { start: d(legs[0]?.date), end: d(legs[legs.length - 1]?.date), travel: true };
    }
    return { start: d(m?.departDate), end: trip === "roundtrip" ? d(m?.returnDate) || d(m?.departDate) : d(m?.departDate), travel: true };
  }
  if (type === "hotel") return { start: d(m?.checkIn), end: d(m?.checkOut), travel: true };
  if (type === "visa") return { start: d(m?.travelDate), end: d(m?.returnDate) || d(m?.travelDate), travel: true };
  if (type === "cab") {
    const rt = str(m?.tripType) === "roundtrip";
    return { start: d(m?.pickupDate), end: (rt && d(m?.returnDate)) || d(m?.pickupDate), travel: true };
  }
  if (type === "forex") return { start: d(m?.requiredBy), end: d(m?.requiredBy), travel: false };
  if (type === "esim" || type === "holiday") {
    const start = d(m?.startDate);
    const days = wholeNumber(m?.days);
    return { start, end: start && days && days > 0 ? addDays(start, type === "esim" ? days - 1 : days) : start, travel: true };
  }
  return { start: d(m?.startDate), end: d(m?.endDate) || d(m?.startDate), travel: true };
}

/** Hotel nights between check-in and check-out, or 0. */
export function hotelNights(m: any): number {
  if (!isISODate(m?.checkIn) || !isISODate(m?.checkOut)) return 0;
  const n = daysBetween(str(m.checkIn), str(m.checkOut));
  return n > 0 ? n : 0;
}

/**
 * Head counts from the traveller list. Flights split by age on the departure
 * day (infant under 2, child under 12); hotels by age at check-in (under 12 is
 * a child). A traveller without a date of birth counts as an adult.
 */
export function deriveCounts(type: ServiceKey, meta: any, travellers: RuleTraveller[]): Record<string, number> {
  const list = Array.isArray(travellers) ? travellers : [];
  const n = list.length;
  const on = itemDates(type, meta).start;
  const ages = list.map((t) => (on ? ageOn(t?.dob, on) : null));
  if (type === "flight") {
    const infants = ages.filter((a) => a !== null && a < 2).length;
    const children = ages.filter((a) => a !== null && a >= 2 && a < 12).length;
    return { adults: n - infants - children, children, infants };
  }
  if (type === "hotel") {
    const children = ages.filter((a) => a !== null && a < 12).length;
    return { adults: n - children, children };
  }
  if (type === "visa") return { travelers: n };
  if (type === "cab") return { passengers: n };
  if (type === "esim") return { numberOfTravellers: n };
  return {};
}

function quantity(type: ServiceKey, meta: any): number {
  const pos = (v: any) => {
    const n = wholeNumber(v);
    return n && n > 0 ? n : 1;
  };
  if (type === "flight") return Math.max(1, (meta.adults || 0) + (meta.children || 0) + (meta.infants || 0));
  if (type === "hotel") return pos(meta.rooms);
  if (type === "visa") return pos(meta.travelers);
  if (type === "esim") return pos(meta.numberOfTravellers);
  if (type === "holiday") return pos(meta.people);
  return 1;
}

/** The card heading for an item: "DEL → BOM", "Dubai · 3 nights", "USD 500 forex". */
export function itemTitle(type: ServiceKey, m: any): string {
  if (type === "flight") {
    if (flightTripType(m) === "multicity") {
      const legs = legsOf(m);
      const stops = legs.length ? [str(legs[0].origin), ...legs.map((l) => str(l.destination))] : [];
      return stops.filter(Boolean).join(" → ") || "Multi-city flight";
    }
    return `${str(m.origin)} → ${str(m.destination)}`;
  }
  if (type === "hotel") {
    const nights = hotelNights(m);
    return `${str(m.hotelName) || str(m.cityName) || str(m.city)}${nights ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}`;
  }
  if (type === "visa") return `${str(m.destinationCountry)} visa`;
  if (type === "cab") return str(m.tripType) === "hourly" ? `${str(m.city)} · ${str(m.hours)} hr cab` : `${str(m.pickup)} → ${str(m.drop)}`;
  if (type === "forex") return `${str(m.currency).toUpperCase()} ${str(m.amount)} forex`;
  if (type === "esim") return `${str(m.country)} eSIM`;
  if (type === "holiday") return `${str(m.destination)} holiday`;
  return `${str(m.mode) || "MICE"} · ${str(m.location)}`;
}

/**
 * The item as stored: fixed scope for always-international services, derived
 * head counts, codes uppercased, fields that don't apply to the chosen trip
 * type removed, and no travellers on holiday / MICE. The server applies this
 * after rebuilding travellers, so counts are always the server's.
 */
export function normalizeItem(item: RuleItem): RuleItem {
  const type = serviceOf(item);
  if (!type) return item;
  const meta: any = { ...(item.meta && typeof item.meta === "object" ? item.meta : {}) };

  if (ALWAYS_INTERNATIONAL.includes(type)) meta.travelScope = "international";
  else meta.travelScope = str(meta.travelScope).toLowerCase() === "international" ? "international" : "domestic";

  if (TRAVELLER_RULE[type] === "lead") meta.travellers = [];
  const travellers: RuleTraveller[] = Array.isArray(meta.travellers) ? meta.travellers : [];

  if (type === "flight") {
    const trip = flightTripType(meta);
    meta.tripType = trip;
    if (trip !== "roundtrip") delete meta.returnDate;
    if (trip === "multicity") {
      const legs = legsOf(meta).map((l) => ({ origin: str(l.origin).toUpperCase(), destination: str(l.destination).toUpperCase(), date: str(l.date) }));
      meta.legs = legs;
      meta.origin = legs[0]?.origin || "";
      meta.destination = legs[legs.length - 1]?.destination || "";
      meta.departDate = legs[0]?.date || "";
    } else {
      delete meta.legs;
      meta.origin = str(meta.origin).toUpperCase();
      meta.destination = str(meta.destination).toUpperCase();
    }
  }
  if (type === "cab") {
    if (str(meta.tripType) !== "roundtrip") delete meta.returnDate;
    if (str(meta.tripType) !== "hourly") delete meta.hours;
    if (str(meta.tripType) === "hourly" && !str(meta.drop)) delete meta.drop;
  }
  if (type === "visa" && str(meta.destinationCountryCode)) {
    meta.destinationCountryCode = str(meta.destinationCountryCode).toUpperCase();
    meta.destinationCountry = countryName(meta.destinationCountryCode) || str(meta.destinationCountry);
  }
  if (type === "esim" && str(meta.countryCode)) {
    meta.countryCode = str(meta.countryCode).toUpperCase();
    meta.country = countryName(meta.countryCode) || str(meta.country);
  }
  if (type === "forex") {
    meta.currency = str(meta.currency).toUpperCase();
    if (str(meta.pan)) meta.pan = str(meta.pan).toUpperCase();
  }
  // Passport validity is computed from each passport's expiry, never typed.
  delete meta.passportValidityMonths;
  // Typed counts are stored as numbers once they are valid (the rules flag the rest).
  for (const k of ["rooms", "hours", "days", "people", "attendees"]) {
    const n = wholeNumber(meta[k]);
    if (n !== null) meta[k] = n;
  }
  if (type === "forex" && positiveAmount(meta.amount) !== null) meta.amount = positiveAmount(meta.amount);

  Object.assign(meta, deriveCounts(type, meta, travellers));
  return { ...item, type, title: itemTitle(type, meta), qty: quantity(type, meta), price: 0, meta };
}

/* ───────────────────────── validation ───────────────────────── */

const FIELD_LABELS: Record<string, string> = {
  firstName: "first name",
  lastName: "last name",
  dob: "date of birth",
  passportNumber: "passport number",
  passportExpiry: "passport expiry",
  nationality: "nationality",
  contact: "phone or email",
};

function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${d} ${mon} ${y}`;
}

function travellerKey(t: RuleTraveller, i: number) {
  return t?.kind === "self" ? "traveller:self" : `traveller:${str(t?.travellerId) || i}`;
}

function travellerIssues(type: ServiceKey, meta: any, end: string): Issue[] {
  const rule = TRAVELLER_RULE[type];
  if (rule === "lead") return [];
  const list: RuleTraveller[] = Array.isArray(meta?.travellers) ? meta.travellers.filter((t: any) => t && typeof t === "object") : [];
  if (!list.length) {
    return [{ field: "travellers", code: "NO_TRAVELLERS", message: "Add at least one traveller: include yourself or add a traveller." }];
  }
  const out: Issue[] = [];
  if (rule === "pan" && list.length > 1) {
    out.push({ field: "holder", code: "FOREX_ONE_TRAVELLER", message: "Forex is bought for one traveller. Choose who it's for." });
  }
  const international = rule === "full" && isInternational(type, meta);
  list.forEach((t, i) => {
    const self = t.kind === "self";
    const need = ["firstName", "lastName"];
    if (rule === "full" && (self || international)) need.push("dob");
    if (international) need.push("passportNumber", "passportExpiry", "nationality");
    const missing = need.filter((k) => !str((t as any)[k]));
    if (rule === "contact" && !isPhone(t.phone) && !isEmail(t.email)) missing.push("contact");
    const label = self ? "" : `Traveller ${i + 1}${travellerFullName(t) ? ` (${travellerFullName(t)})` : ""}`;
    if (missing.length) {
      const what = missing.map((k) => FIELD_LABELS[k] || k).join(", ");
      out.push(
        self
          ? { field: travellerKey(t, i), code: "SELF_PROFILE_INCOMPLETE", message: `Complete your profile to continue: ${what} missing in My Profile.`, missing }
          : { field: travellerKey(t, i), code: "TRAVELLER_INCOMPLETE", message: `${label}: ${what} required${international ? " for international travel" : ""}.`, missing },
      );
      return;
    }
    if (international && end && isISODate(t.passportExpiry) && str(t.passportExpiry) < end) {
      out.push({
        field: travellerKey(t, i),
        code: "PASSPORT_EXPIRES_DURING_TRIP",
        message: `${self ? "Your" : `${label}'s`} passport expires on ${fmtDay(str(t.passportExpiry))}, before the trip ends on ${fmtDay(end)}.`,
      });
    }
  });
  return out;
}

/**
 * Everything wrong with one cart item, in form order. `today` is the caller's
 * calendar day (YYYY-MM-DD): the browser's on the form, IST on the server.
 */
export function validateItem(item: RuleItem, opts: { today: string }): Issue[] {
  const type = serviceOf(item);
  if (!type) return [{ field: "type", code: "UNKNOWN_SERVICE", message: "Choose a service for this item." }];
  const m: any = item.meta && typeof item.meta === "object" ? item.meta : {};
  const today = opts.today;
  const out: Issue[] = [];
  const add = (field: string, message: string, code = "INVALID_FIELD") => out.push({ field, code, message });
  const required = (field: string, label: string) => {
    if (!str(m[field])) add(field, `${label} is required.`, "REQUIRED");
    return Boolean(str(m[field]));
  };
  const oneOf = (field: string, label: string, list: string[], need = true) => {
    const v = str(m[field]);
    if (!v) {
      if (need) add(field, `${label} is required.`, "REQUIRED");
      return;
    }
    if (!list.includes(v)) add(field, `Choose ${label.toLowerCase()} from the list.`);
  };
  /** A date that is required (or optional), valid and not in the past. */
  const date = (field: string, label: string, need = true): string => {
    const v = str(m[field]);
    if (!v) {
      if (need) add(field, `${label} is required.`, "REQUIRED");
      return "";
    }
    if (!isISODate(v)) {
      add(field, `${label} isn't a valid date.`);
      return "";
    }
    if (v < today) {
      add(field, `${label} can't be in the past.`, "DATE_IN_PAST");
      return "";
    }
    return v;
  };
  const notBefore = (field: string, label: string, v: string, ref: string, refLabel: string, strict = false) => {
    if (!v || !ref) return;
    if (strict ? v <= ref : v < ref) add(field, `${label} must be ${strict ? "after" : "on or after"} the ${refLabel}.`, "DATE_ORDER");
  };
  const count = (field: string, label: string, min: number, max: number) => {
    const n = wholeNumber(m[field]);
    if (str(m[field]) === "") add(field, `${label} is required.`, "REQUIRED");
    else if (n === null || n < min || n > max) add(field, `${label} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  const leadContact = () => {
    if (!str(m.leadName)) add("leadName", "Lead contact name is required.", "REQUIRED");
    const phone = str(m.leadPhone);
    const email = str(m.leadEmail);
    if (!phone && !email) add("leadPhone", "Add a phone number or email for the lead contact.", "REQUIRED");
    if (phone && !isPhone(phone)) add("leadPhone", "Enter a valid phone number.");
    if (email && !isEmail(email)) add("leadEmail", "Enter a valid email address.");
  };
  const tagList = (field: string, label: string) => {
    const v = m[field];
    if (v === undefined || v === null || v === "") return;
    if (!Array.isArray(v) || v.length > 20 || v.some((x: any) => typeof x !== "string" || !str(x) || str(x).length > 60)) {
      add(field, `${label}: up to 20 items, each under 60 characters.`);
    }
  };

  if (type === "flight") {
    const trip = str(m.tripType).toLowerCase();
    if (trip && !["oneway", "roundtrip", "multicity"].includes(trip)) add("tripType", "Choose one way, round trip or multi-city.");
    if (flightTripType(m) === "multicity") {
      const legs = legsOf(m);
      if (legs.length < 2) add("legs", "A multi-city trip needs at least 2 flights.");
      if (legs.length > MAX_LEGS) add("legs", `A multi-city trip can have up to ${MAX_LEGS} flights.`);
      let prev = "";
      legs.slice(0, MAX_LEGS).forEach((l, i) => {
        const n = i + 1;
        const o = str(l.origin).toUpperCase();
        const dst = str(l.destination).toUpperCase();
        if (!IATA_RX.test(o)) add(`legs.${i}.origin`, `Flight ${n}: select the origin airport from the list.`, o ? "INVALID_FIELD" : "REQUIRED");
        if (!IATA_RX.test(dst)) add(`legs.${i}.destination`, `Flight ${n}: select the destination airport from the list.`, dst ? "INVALID_FIELD" : "REQUIRED");
        else if (o === dst) add(`legs.${i}.destination`, `Flight ${n}: destination must differ from the origin.`);
        const v = str(l.date);
        if (!v) add(`legs.${i}.date`, `Flight ${n}: date is required.`, "REQUIRED");
        else if (!isISODate(v)) add(`legs.${i}.date`, `Flight ${n}: date isn't a valid date.`);
        else if (v < today) add(`legs.${i}.date`, `Flight ${n}: date can't be in the past.`, "DATE_IN_PAST");
        else {
          if (prev && v < prev) add(`legs.${i}.date`, `Flight ${n} can't be before flight ${n - 1}.`, "DATE_ORDER");
          prev = v;
        }
      });
    } else {
      const o = str(m.origin).toUpperCase();
      const dst = str(m.destination).toUpperCase();
      if (!o) add("origin", "Origin airport is required.", "REQUIRED");
      else if (!IATA_RX.test(o)) add("origin", "Select the origin airport from the list.");
      if (!dst) add("destination", "Destination airport is required.", "REQUIRED");
      else if (!IATA_RX.test(dst)) add("destination", "Select the destination airport from the list.");
      else if (o === dst) add("destination", "Destination must differ from the origin.");
      const dep = date("departDate", "Departure date");
      if (flightTripType(m) === "roundtrip") {
        const ret = date("returnDate", "Return date");
        notBefore("returnDate", "Return date", ret, dep, "departure date");
      }
    }
    oneOf("cabinClass", "Cabin class", CABIN_CLASSES, false);
    oneOf("preferredTime", "Preferred time", FLIGHT_TIMES, false);
  }

  if (type === "hotel") {
    required("city", "City or hotel");
    const ci = date("checkIn", "Check-in date");
    const co = date("checkOut", "Check-out date");
    notBefore("checkOut", "Check-out date", co, ci, "check-in date", true);
    const rooms = count("rooms", "Rooms", 1, 9);
    const guests = Array.isArray(m.travellers) ? m.travellers.length : 0;
    if (rooms && guests && rooms > guests) add("rooms", `${rooms} rooms for ${guests} guest${guests === 1 ? "" : "s"}: rooms can't outnumber guests.`);
    oneOf("hotelType", "Hotel type", HOTEL_TYPES, false);
    oneOf("starRating", "Star rating", STAR_RATINGS, false);
    oneOf("roomType", "Room type", ROOM_TYPES, false);
    oneOf("mealPlan", "Meal plan", MEAL_PLANS, false);
  }

  if (type === "visa") {
    const code = str(m.destinationCountryCode).toUpperCase();
    if (!code) add("destinationCountryCode", "Destination country is required.", "REQUIRED");
    else if (!countryName(code)) add("destinationCountryCode", "Choose the destination country from the list.");
    oneOf("visaType", "Visa type", VISA_TYPES.map((v) => v[0]));
    oneOf("purpose", "Purpose", VISA_PURPOSES);
    const go = date("travelDate", "Travel date");
    const back = date("returnDate", "Return date", false);
    notBefore("returnDate", "Return date", back, go, "travel date");
    oneOf("processingSpeed", "Processing speed", VISA_SPEEDS, false);
  }

  if (type === "cab") {
    required("city", "City");
    const trip = str(m.tripType);
    if (!trip) add("tripType", "Trip type is required.", "REQUIRED");
    else if (!CAB_TRIP_TYPES.some((t) => t[0] === trip)) add("tripType", "Choose one way, round trip or hourly rental.");
    required("pickup", "Pickup location");
    if (trip !== "hourly") required("drop", "Drop location");
    const pd = date("pickupDate", "Pickup date");
    const pt = str(m.pickupTime);
    if (!pt) add("pickupTime", "Pickup time is required.", "REQUIRED");
    else if (!TIME_RX.test(pt)) add("pickupTime", "Enter the pickup time as HH:MM.");
    if (trip === "hourly") count("hours", "Hours", 1, 24);
    if (trip === "roundtrip") {
      const rd = date("returnDate", "Return date");
      notBefore("returnDate", "Return date", rd, pd, "pickup date");
    }
    oneOf("vehicleType", "Vehicle type", VEHICLE_TYPES, false);
    oneOf("luggage", "Luggage", LUGGAGE, false);
  }

  if (type === "forex") {
    const cur = str(m.currency).toUpperCase();
    if (!cur) add("currency", "Currency is required.", "REQUIRED");
    else if (!currencyName(cur)) add("currency", "Choose the currency from the list.");
    if (!str(m.amount)) add("amount", "Amount is required.", "REQUIRED");
    else if (positiveAmount(m.amount) === null || (positiveAmount(m.amount) as number) > 10000000) add("amount", "Enter an amount above 0 (up to 2 decimals).");
    oneOf("deliveryMode", "Delivery", FOREX_DELIVERY);
    required("city", "Delivery city");
    date("requiredBy", "Needed by");
    const pan = str(m.pan).toUpperCase();
    if (!pan) add("pan", "PAN is required for forex.", "REQUIRED");
    else if (!pan.includes("*") && !PAN_RX.test(pan)) add("pan", "Enter a valid PAN (e.g. ABCDE1234F).");
    oneOf("purpose", "Purpose", FOREX_PURPOSES, false);
  }

  if (type === "esim") {
    const code = str(m.countryCode).toUpperCase();
    if (!code) add("countryCode", "Country is required.", "REQUIRED");
    else if (!countryName(code)) add("countryCode", "Choose the country from the list.");
    date("startDate", "Start date");
    count("days", "Days", 1, 365);
    oneOf("dataPack", "Data pack", ESIM_PACKS);
  }

  if (type === "holiday") {
    required("destination", "Destination");
    date("startDate", "Start date");
    count("days", "Nights", 1, 60);
    count("people", "People", 1, 999);
    oneOf("budgetBand", "Budget band", BUDGET_BANDS, false);
    oneOf("hotelClass", "Hotel class", HOLIDAY_HOTEL_CLASSES, false);
    tagList("inclusions", "Inclusions");
    leadContact();
  }

  if (type === "mice") {
    oneOf("mode", "Event type", MICE_MODES);
    required("location", "Location");
    const s = date("startDate", "Start date");
    const e = date("endDate", "End date");
    notBefore("endDate", "End date", e, s, "start date");
    count("attendees", "Attendees", 1, 5000);
    oneOf("travelMode", "Travel mode", MICE_TRAVEL_MODES, false);
    oneOf("hotelType", "Hotel type", MICE_HOTEL_TYPES, false);
    oneOf("foodPref", "Food preference", FOOD_PREFS, false);
    tagList("addOns", "Add-ons");
    leadContact();
  }

  // Request-level details carried on every item.
  oneOf("priority", "Priority", PRIORITIES, false);
  const needBy = date("needBy", "Need-by date", false);
  const { start, end, travel } = itemDates(type, m);
  if (needBy && travel && start && needBy > start) {
    add("needBy", `Need-by date can't be after the travel date (${fmtDay(start)}).`, "DATE_ORDER");
  }
  if (str(m.notes).length > MAX_NOTES) add("notes", `Notes can be up to ${MAX_NOTES} characters.`);

  return [...out, ...travellerIssues(type, m, end)];
}

/** Every item's issues, tagged with its index. */
export function validateCart(items: RuleItem[], opts: { today: string }): Array<Issue & { itemIndex: number }> {
  const out: Array<Issue & { itemIndex: number }> = [];
  (Array.isArray(items) ? items : []).forEach((it, itemIndex) => {
    for (const issue of validateItem(it, opts)) out.push({ ...issue, itemIndex });
  });
  return out;
}

/** Today's date in India (YYYY-MM-DD) — the server's "today" for date rules. */
export function todayIST(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}
