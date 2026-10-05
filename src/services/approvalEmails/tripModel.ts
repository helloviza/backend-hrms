// apps/backend/src/services/approvalEmails/tripModel.ts
//
// Reads a request's cart items (the shapes in services/approvalItemRules.ts:
// flight, hotel, visa, cab, forex, esim, holiday, mice) into what the email
// layout shows: the TRIP SUMMARY card for the main item, the item count for
// the summary strip, and one ITINERARY row per item.
//
// The main item is the first flight, else the first item. Its dates,
// travellers and picked option are in the summary card; its itinerary row
// carries only what the card doesn't (preferences, notes), so nothing is said
// twice. Every text is price-stripped and HTML-escaped here; passports, PANs,
// dates of birth and contact details are never read.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { stripPriceText } from "../../routes/approvals.security.js";
import { escapeHtml } from "../../routes/approvals.email.js";
import { legList, placeBlock, routeBlock, tripSummary, type Fact, type ItineraryRow } from "./layout.js";
import { caseCode } from "./links.js";

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();
/** Customer-safe text: price-stripped and escaped. */
export const safe = (v: any) => escapeHtml(stripPriceText(str(v)));

/* ───────────────────────── lookups ───────────────────────── */

let AIRPORTS: Map<string, string> | null = null;
/** IATA code → city ("BOM" → "Mumbai"), from src/data/airports.json. */
export function airportCity(code: any): string {
  const c = str(code).toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return "";
  if (!AIRPORTS) {
    AIRPORTS = new Map();
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const rows: AnyObj[] = JSON.parse(fs.readFileSync(path.join(here, "../../data/airports.json"), "utf8"));
      for (const r of rows) if (r?.code && r?.city) AIRPORTS.set(String(r.code).toUpperCase(), String(r.city));
    } catch {
      /* no lookup: codes are shown alone */
    }
  }
  return AIRPORTS.get(c) || "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-12" (or an ISO date-time) → "12 Oct 2026"; no time-zone shift. */
export function day(v: any): string {
  const m = str(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
const hm = (iso: any) => str(iso).match(/T(\d{2}:\d{2})/)?.[1] || "";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const join = (parts: any[], sep = " · ") => parts.map(str).filter(Boolean).join(sep);

/* ───────────────────────── items ───────────────────────── */

export const SERVICE_LABEL: Record<string, string> = {
  flight: "Flight",
  hotel: "Hotel",
  visa: "Visa",
  cab: "Cab",
  forex: "Forex",
  esim: "eSIM",
  holiday: "Holiday",
  mice: "MICE",
  other: "Service",
};

export function serviceOf(it: AnyObj): string {
  const t = str(it?.type || it?.service || it?.category).toLowerCase();
  if (SERVICE_LABEL[t] && t !== "other") return t;
  if (t.includes("flight") || t.includes("air")) return "flight";
  if (t.includes("hotel") || t.includes("stay")) return "hotel";
  if (t.includes("visa")) return "visa";
  if (t.includes("cab") || t.includes("taxi") || t.includes("transfer")) return "cab";
  if (t.includes("forex")) return "forex";
  if (t.includes("esim") || t.includes("sim")) return "esim";
  if (t.includes("holiday") || t.includes("package")) return "holiday";
  if (t.includes("mice") || t.includes("event") || t.includes("conference")) return "mice";
  return "other";
}

const metaOf = (it: AnyObj): AnyObj => (it?.meta && typeof it.meta === "object" ? it.meta : {});
const itemsOf = (ar: AnyObj): AnyObj[] => (Array.isArray(ar?.cartItems) ? ar.cartItems.filter((x: any) => x && typeof x === "object") : []);

/** Traveller names (never any other traveller field). */
export function travellerNames(m: AnyObj): string[] {
  const list = Array.isArray(m?.travellers) ? m.travellers : [];
  return list
    .map((t: AnyObj) => join([t?.firstName, t?.middleName, t?.lastName], " "))
    .filter(Boolean);
}

function travellersFact(m: AnyObj, fallbackCount?: number, label = "Travellers"): Fact | null {
  const names = travellerNames(m);
  if (names.length) return { label, value: safe(names.join(", ")) };
  if (fallbackCount && fallbackCount > 0) return { label, value: escapeHtml(String(fallbackCount)) };
  return null;
}

/* ── flight ── */

type Leg = { origin: string; destination: string; date: string };

function flightLegs(m: AnyObj): Leg[] {
  const trip = str(m.tripType).toLowerCase();
  if (trip === "multicity" && Array.isArray(m.legs) && m.legs.length) {
    return m.legs.map((l: AnyObj) => ({ origin: str(l?.origin).toUpperCase(), destination: str(l?.destination).toUpperCase(), date: str(l?.date) }));
  }
  const out: Leg[] = [{ origin: str(m.origin).toUpperCase(), destination: str(m.destination).toUpperCase(), date: str(m.departDate) }];
  if (trip === "roundtrip") out.push({ origin: out[0].destination, destination: out[0].origin, date: str(m.returnDate) });
  return out;
}

/** Where a multi-city trip goes: the last stop, or the one before it when the trip ends back home. */
function farStop(legs: Leg[]): string {
  const last = legs[legs.length - 1]?.destination || "";
  if (last && last !== legs[0]?.origin) return last;
  return legs[legs.length - 2]?.destination || last;
}

type PickedLeg = { direction: string; line: string; detail: string; fromCity: string; toCity: string };

const duration = (min: any) => {
  const n = Number(min) || 0;
  return n ? `${Math.floor(n / 60)}h ${String(n % 60).padStart(2, "0")}m` : "";
};
const refund = (v: any, cancelBy?: any) =>
  v === true ? (cancelBy ? `Refundable · free cancellation before ${day(cancelBy)}` : "Refundable") : v === false ? "Non-refundable" : "";

/**
 * Per picked leg (outbound first), plain text:
 *   line   "IndiGo 6E 2134 · 06:10–08:25"
 *   detail "2h 15m · Non-stop · Economy · 15 kg + 7 kg cabin · Saver · Refundable"
 */
export function pickedFlights(m: AnyObj): PickedLeg[] {
  const s = m?.selection;
  if (!s || s.kind !== "flight" || !Array.isArray(s.legs)) return [];
  return s.legs
    .map((leg: AnyObj) => {
      const segs: AnyObj[] = Array.isArray(leg?.segments) ? leg.segments : [];
      const f = segs[0];
      const l = segs[segs.length - 1];
      if (!f || !l) return null;
      const numbers = segs.map((x) => join([x.airlineCode, x.flightNumber], " ")).join(" + ");
      const stops = Number(leg?.stopCount) > 0 ? plural(Number(leg.stopCount), "stop") : "Non-stop";
      const times = hm(f.departAt) && hm(l.arriveAt) ? `${hm(f.departAt)}–${hm(l.arriveAt)}` : "";
      const bag = join([f.baggage?.checkIn, f.baggage?.cabin ? `${str(f.baggage.cabin)} cabin` : ""], " + ");
      return {
        direction: str(leg?.direction) === "back" ? "back" : "out",
        line: stripPriceText(join([`${str(f.airlineName)} ${numbers}`.trim(), times])),
        detail: stripPriceText(join([duration(leg?.journeyMin), stops, f.cabin, bag, leg?.productLabel, refund(leg?.refundable)])),
        fromCity: str(f.from?.city),
        toCity: str(l.to?.city),
      };
    })
    .filter(Boolean) as PickedLeg[];
}

function paxCount(m: AnyObj): number {
  return (Number(m.adults) || 0) + (Number(m.children) || 0) + (Number(m.infants) || 0);
}

function flightSummary(m: AnyObj, code: string) {
  const legs = flightLegs(m);
  const trip = str(m.tripType).toLowerCase();
  const picked = pickedFlights(m);
  const out = picked.find((p) => p.direction === "out");
  const back = picked.find((p) => p.direction === "back");
  const first = legs[0];
  const last = legs[legs.length - 1];
  const to = trip === "roundtrip" ? first.destination : trip === "multicity" ? farStop(legs) : last.destination;
  const top = routeBlock(
    { code: first.origin, city: out?.fromCity || airportCity(first.origin) },
    { code: to, city: (trip === "multicity" ? "" : out?.toCity) || airportCity(to) },
  );

  const facts: Fact[] = [];
  let legsHtml = "";
  if (trip === "multicity") {
    legsHtml = legList(
      legs.map((l) => ({
        route: `${escapeHtml(l.origin)} → ${escapeHtml(l.destination)}`,
        detail: escapeHtml(join([day(l.date), airportCity(l.destination)])),
      })),
    );
  } else {
    facts.push({ label: trip === "roundtrip" ? "Depart" : "Date", value: escapeHtml(day(first.date) || "—") });
    if (trip === "roundtrip") facts.push({ label: "Return", value: escapeHtml(day(legs[1]?.date) || "—") });
  }
  if (out) facts.push({ label: back ? "Outbound flight" : "Flight", value: escapeHtml(out.line) });
  if (back) facts.push({ label: "Return flight", value: escapeHtml(back.line) });
  if (str(m.cabinClass)) facts.push({ label: "Cabin", value: safe(m.cabinClass) });
  const tf = travellersFact(m, paxCount(m));
  if (tf) facts.push(tf);
  return tripSummary({ top, legs: legsHtml, facts, code });
}

/* ── other services ── */

function hotelName(m: AnyObj) {
  const s = m?.selection?.kind === "hotel" ? m.selection : null;
  return str(s?.name) || str(m.hotelName);
}
function hotelCity(m: AnyObj) {
  const s = m?.selection?.kind === "hotel" ? m.selection : null;
  return str(s?.city) || str(m.cityName) || str(m.city);
}
function nights(a: any, b: any): number {
  const x = Date.parse(`${str(a).slice(0, 10)}T00:00:00Z`);
  const y = Date.parse(`${str(b).slice(0, 10)}T00:00:00Z`);
  const n = Math.round((y - x) / 86400000);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 2000 → "2,000". The requested foreign-currency amount: not a price, kept for customers (approvals.security FOREX_META_KEEP). */
function forexAmount(v: any): string {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : str(v);
}

function placeSummary(service: string, m: AnyObj, code: string) {
  const facts: Fact[] = [];
  const add = (label: string, v: any) => {
    const s = str(v);
    if (s) facts.push({ label, value: safe(s) });
  };
  let title = "";
  let sub = "";
  switch (service) {
    case "hotel": {
      const name = hotelName(m);
      const city = hotelCity(m);
      const stars = Number(m?.selection?.kind === "hotel" ? m.selection.stars : 0);
      title = safe(`${name || city || "Hotel stay"}${name && stars > 0 ? ` (${stars}★)` : ""}`);
      sub = name && city ? safe(city) : "";
      const n = nights(m.checkIn, m.checkOut);
      add("Check-in", day(m.checkIn));
      add("Check-out", day(m.checkOut) ? `${day(m.checkOut)}${n ? ` (${plural(n, "night")})` : ""}` : "");
      const guests = (Number(m.adults) || 0) + (Number(m.children) || 0);
      add("Rooms & guests", join([Number(m.rooms) ? plural(Number(m.rooms), "room") : "", guests ? plural(guests, "guest") : ""]));
      if (m?.selection?.kind === "hotel") {
        add("Room", join([m.selection.roomName, m.selection.mealPlan]));
        add("Cancellation", refund(m.selection.refundable, m.selection.cancelBy));
      }
      break;
    }
    case "visa":
      title = safe(m.destinationCountry ? `${str(m.destinationCountry)} visa` : "Visa");
      sub = safe(join([m.visaType === "stamp" ? "Visa on arrival" : m.visaType === "sticker" ? "Sticker visa" : m.visaType, m.purpose]));
      add("Travel date", day(m.travelDate));
      add("Return", day(m.returnDate));
      add("Processing", m.processingSpeed);
      break;
    case "cab": {
      const hourly = str(m.tripType) === "hourly";
      title = safe(hourly ? `${str(m.city) || "Cab"} · ${str(m.hours)} hr` : join([m.pickup, m.drop], " → ") || "Cab");
      sub = safe(join([hourly ? "Hourly rental" : str(m.tripType) === "roundtrip" ? "Round trip" : "One way", hourly ? "" : m.city]));
      add("Pickup", join([day(m.pickupDate), m.pickupTime]));
      add("Return", day(m.returnDate));
      add("Vehicle", m.vehicleType);
      break;
    }
    case "forex":
      title = escapeHtml(join([str(m.currency).toUpperCase(), forexAmount(m.amount)], " ") || "Forex");
      sub = safe(join([m.deliveryMode, m.city]));
      add("Needed by", day(m.requiredBy));
      add("Purpose", m.purpose);
      break;
    case "esim":
      title = safe(m.country ? `${str(m.country)} eSIM` : "eSIM");
      sub = safe(m.dataPack);
      add("Starts", day(m.startDate));
      add("Days", m.days);
      break;
    case "holiday":
      title = safe(m.destination ? `${str(m.destination)} holiday` : "Holiday");
      sub = safe(join([m.budgetBand, m.hotelClass]));
      add("Starts", day(m.startDate));
      add("Nights", m.days);
      add("People", m.people);
      break;
    case "mice":
      title = safe(join([m.mode || "Event", m.location]));
      sub = safe(join([m.travelMode, m.hotelType]));
      add("Dates", join([day(m.startDate), day(m.endDate)], " – "));
      add("Attendees", m.attendees);
      break;
    default:
      title = safe(m.title || "Travel service");
  }
  const counts: Record<string, number> = { hotel: 0, visa: Number(m.travelers) || 0, cab: Number(m.passengers) || 0, esim: Number(m.numberOfTravellers) || 0 };
  const tf = travellersFact(m, counts[service], service === "forex" ? "For" : "Travellers");
  if (tf) facts.push(tf);
  return tripSummary({ top: placeBlock(service, title, sub), facts, code });
}

/* ───────────────────────── itinerary rows ───────────────────────── */

function preferenceLines(service: string, m: AnyObj): string[] {
  const prefs: string[] = [];
  if (service === "flight") {
    const picked = pickedFlights(m);
    for (const p of picked) if (p.detail) prefs.push(`${picked.length > 1 ? (p.direction === "back" ? "Return: " : "Outbound: ") : ""}${p.detail}`);
    if (str(m.preferredTime) && str(m.preferredTime) !== "Any") prefs.push(`Preferred time: ${str(m.preferredTime)}`);
  }
  if (service === "hotel") {
    const p = join([m.roomType, m.starRating !== "Any" ? m.starRating : "", m.hotelType, m.mealPlan]);
    if (p) prefs.push(p);
  }
  if (service === "cab") {
    const p = join([m.luggage ? `${str(m.luggage)} luggage` : ""]);
    if (p) prefs.push(p);
  }
  if (service === "holiday" && Array.isArray(m.inclusions) && m.inclusions.length) prefs.push(`Includes: ${m.inclusions.map(str).join(", ")}`);
  if (service === "mice") {
    const p = join([m.foodPref, Array.isArray(m.addOns) && m.addOns.length ? `Add-ons: ${m.addOns.map(str).join(", ")}` : ""]);
    if (p) prefs.push(p);
  }
  if (str(m.notes)) prefs.push(`Note: ${str(m.notes)}`);
  return prefs.map(safe).filter(Boolean);
}

/** Everything about an item that is not in the summary card (all of it for a non-main item). */
function detailLines(service: string, m: AnyObj): string[] {
  const lines: string[] = [];
  const names = travellerNames(m);
  if (service === "flight") {
    const legs = flightLegs(m);
    const trip = str(m.tripType).toLowerCase();
    lines.push(
      safe(
        trip === "roundtrip"
          ? `Depart ${day(legs[0].date)} · Return ${day(legs[1]?.date)}`
          : legs.map((l) => `${l.origin} → ${l.destination} ${day(l.date)}`).join(" · "),
      ),
    );
    for (const p of pickedFlights(m)) lines.push(escapeHtml(join([p.line, p.detail])));
    const extra = join([m.cabinClass, names.length ? names.join(", ") : ""]);
    if (extra) lines.push(safe(extra));
  } else if (service === "hotel") {
    lines.push(safe(join([day(m.checkIn) && `Check-in ${day(m.checkIn)}`, day(m.checkOut) && `Check-out ${day(m.checkOut)}`])));
    lines.push(safe(join([Number(m.rooms) ? plural(Number(m.rooms), "room") : "", names.join(", ")])));
  } else if (service === "visa") {
    lines.push(safe(join([m.purpose, day(m.travelDate) && `Travel ${day(m.travelDate)}`, m.processingSpeed])));
    if (names.length) lines.push(safe(names.join(", ")));
  } else if (service === "cab") {
    lines.push(safe(join([day(m.pickupDate) && `Pickup ${day(m.pickupDate)}`, m.vehicleType])));
    if (names.length) lines.push(safe(names.join(", ")));
  } else if (service === "forex") {
    // The requested foreign-currency amount (not a price; kept for customers).
    if (str(m.currency) || str(m.amount)) lines.push(escapeHtml(join([str(m.currency).toUpperCase(), forexAmount(m.amount)], " ")));
    lines.push(safe(join([m.deliveryMode, day(m.requiredBy) && `Needed by ${day(m.requiredBy)}`, names.join(", ")])));
  } else if (service === "esim") {
    lines.push(safe(join([m.dataPack, day(m.startDate) && `From ${day(m.startDate)}`, m.days && `${str(m.days)} days`])));
    if (names.length) lines.push(safe(names.join(", ")));
  } else if (service === "holiday") {
    lines.push(safe(join([day(m.startDate) && `From ${day(m.startDate)}`, m.days && `${str(m.days)} nights`, m.people && `${str(m.people)} people`])));
  } else if (service === "mice") {
    lines.push(safe(join([join([day(m.startDate), day(m.endDate)], " – "), m.attendees && `${str(m.attendees)} attendees`])));
  }
  return lines.filter(Boolean);
}

function rowTitle(service: string, it: AnyObj, m: AnyObj): string {
  const label = SERVICE_LABEL[service];
  if (service === "flight") {
    const trip = str(m.tripType).toLowerCase();
    const legs = flightLegs(m);
    const kind = trip === "roundtrip" ? "Round trip" : trip === "multicity" ? "Multi-city" : "One way";
    const route = trip === "multicity" ? [legs[0].origin, ...legs.map((l) => l.destination)].join(" → ") : `${legs[0].origin} → ${legs[0].destination}`;
    return safe(`${label} · ${route} · ${kind}`);
  }
  if (service === "hotel") return safe(hotelName(m) ? `${hotelName(m)}, ${hotelCity(m)}` : `Hotel in ${hotelCity(m) || "—"}`);
  return safe(`${label} · ${stripPriceText(str(it?.title)) || label}`);
}

/* ───────────────────────── the model ───────────────────────── */

export type TripModel = {
  /** Number of items and their kinds: "2 (Flight + Hotel)". Escaped. */
  itemsLabel: string;
  /** "Mumbai", "United Arab Emirates" — the main destination, plain text, "" if unknown. */
  destination: string;
  /** "trip", or "forex request" / "eSIM request" when that is all it is. */
  noun: string;
  /** The TRIP SUMMARY card HTML ("" when the request has no items). */
  summaryHtml: string;
  itinerary: ItineraryRow[];
};

function destinationOf(service: string, m: AnyObj): string {
  if (service === "flight") {
    const legs = flightLegs(m);
    const trip = str(m.tripType).toLowerCase();
    const code = trip === "multicity" ? farStop(legs) : legs[0].destination;
    const picked = pickedFlights(m).find((p) => p.direction === "out");
    return (trip !== "multicity" && picked?.toCity) || airportCity(code) || code;
  }
  if (service === "hotel") return hotelCity(m);
  if (service === "visa") return str(m.destinationCountry);
  if (service === "cab") return str(m.city) || str(m.drop);
  if (service === "esim") return str(m.country);
  if (service === "holiday") return str(m.destination);
  if (service === "mice") return str(m.location);
  return "";
}

export function tripModel(ar: AnyObj): TripModel {
  const items = itemsOf(ar);
  if (!items.length) return { itemsLabel: "—", destination: "", noun: "trip", summaryHtml: "", itinerary: [] };
  const services = items.map(serviceOf);
  const mainIdx = Math.max(0, services.indexOf("flight"));
  const main = items[mainIdx];
  const mainService = services[mainIdx];
  const mainMeta = metaOf(main);

  const kinds = Array.from(new Set(services)).map((s) => SERVICE_LABEL[s]);
  const itemsLabel = escapeHtml(`${items.length} (${kinds.join(" + ")})`);

  const onlyService = new Set(services).size === 1 ? services[0] : "";
  const noun = onlyService === "forex" ? "forex request" : onlyService === "esim" ? "eSIM request" : onlyService === "mice" ? "event" : "trip";

  const code = caseCode(ar);
  const summaryHtml = mainService === "flight" ? flightSummary(mainMeta, code) : placeSummary(mainService, mainMeta, code);

  const itinerary: ItineraryRow[] = items.map((it, i) => {
    const s = services[i];
    const m = metaOf(it);
    const lines = i === mainIdx ? preferenceLines(s, m) : [...detailLines(s, m), ...preferenceLines(s, m)];
    return { service: SERVICE_LABEL[s] ? s : "other", title: rowTitle(s, it, m), lines };
  });

  return {
    itemsLabel,
    destination: stripPriceText(destinationOf(mainService, mainMeta)),
    noun,
    summaryHtml,
    itinerary,
  };
}
