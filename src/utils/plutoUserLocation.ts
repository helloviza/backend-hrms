// apps/backend/src/utils/plutoUserLocation.ts
//
// What the system knows about WHERE the user is, for Pluto — and the rules
// for using it. See docs/audits/pluto-office-location-2026-11-09.md.
//
// Two different facts, never confused with each other:
//
//   OFFICE  — User.jobLocation (fallback Employee.location). HR/onboarding
//             maintained, shown to the user in My Space as "Base location".
//             Used when the user SAYS "my office" — and the reply always
//             says that the profile is where the city came from.
//
//   CURRENT — the request IP through services/location.service.ts (MaxMind).
//             Where the DEVICE appears to be. Only ever offered as a one-tap
//             SUGGESTION the user must confirm; never filled in silently, and
//             never used as the office.
//
// Both resolve through the same STRICT ladder (curated destinationLookup →
// `tbocities` exact-name match). Anything that does not land on exactly ONE
// city — "Head Office", "Remote", a typo, a name shared by several cities —
// is treated as "unknown" and the caller asks. No LLM normalisation here: a
// profile string like "Head Office" must never be steered into some city.

import mongoose from "mongoose";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import { lookupDestination, countryFor } from "../data/destinationLookup.js";
import { normalizeSearch } from "../jobs/static-data-refresh.js";
import { findCatalogMatches, pickCatalogCity, cityNameVariants } from "./plutoHotelDestination.js";
import { resolveCityFromIpBounded } from "../services/location.service.js";

/* ───────── Phrase detection ───────── */

// The words that stand for "my office" once the possessive is stripped.
const OFFICE_WORDS = new Set([
  "office", "head office", "workplace", "work place", "work", "office city", "work city",
]);

const OFFICE_ENDPOINT = String.raw`(?:my\s+|our\s+|the\s+)?(?:head\s+)?(?:office\s+city|work\s+city|office|workplace|work\s+place|work)\b`;

/**
 * The original flight ask with the user's answer put where the missing city
 * was: "from my office" → "from Pune"; no origin at all → "… from Pune".
 */
export function spliceFlightAnswer(original: string, need: "origin" | "destination", city: string): string {
  const prep = need === "origin" ? "from" : "to";
  const re = new RegExp(String.raw`\b${prep}\s+${OFFICE_ENDPOINT}`, "i");
  if (re.test(original)) return original.replace(re, `${prep} ${city}`);
  return `${original.trim()} ${prep} ${city}`;
}

/**
 * Does this hotel/flight ask refer to the user's office as a PLACE?
 *
 * Deliberately narrow: "work trip", "office hours", "office party" are not a
 * place. "work" only counts after a locational preposition ("near work",
 * "from work"), never on its own.
 */
export function mentionsOffice(prompt: string): boolean {
  if (!prompt) return false;
  const p = prompt.toLowerCase();
  const NOT_PLACE_AFTER = String.raw`(?!\s*(?:trip|trips|travel|hours|party|parties|visit|meeting|meetings|timings?)\b)`;
  const possessive = new RegExp(
    String.raw`\b(?:my|our|the)\s+(?:head\s+)?(?:office|workplace|work\s+place)\b` + NOT_PLACE_AFTER,
  );
  const locational = new RegExp(
    String.raw`\b(?:near|around|close\s+to|next\s+to|walking\s+distance\s+(?:from|to)|by|from|to|at)\s+(?:my\s+|our\s+|the\s+)?(?:head\s+)?(?:office|workplace|work\s+place|work)\b` +
      NOT_PLACE_AFTER,
  );
  return possessive.test(p) || locational.test(p);
}

/** Is this captured endpoint ("my office", "office", "work") the office? */
export function isOfficePlace(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const k = String(raw)
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:my|our|the)\s+/, "");
  return OFFICE_WORDS.has(k);
}

/** "hotels near me", "around here", "nearby", "tonight here", "where I am". */
export function mentionsNearMe(prompt: string): boolean {
  if (!prompt) return false;
  return /\b(?:near\s+me|near\s+here|around\s+me|around\s+here|close\s+to\s+me|close\s+by|nearby|near\s+by|where\s+i\s+am(?:\s+now)?|here\s+tonight|tonight\s+here|in\s+this\s+city)\b/i.test(
    prompt,
  );
}

/* ───────── Strict city resolution ───────── */

export interface StrictCity {
  cityName: string;
  countryCode: string | null;
  /** TBO CityCode. Null only when the curated table knows the city but the
   * catalog could not be read (no DB) — fine for flights, not for hotels. */
  cityCode: string | null;
}

export type StrictCityResult =
  | { status: "ONE"; city: StrictCity }
  | { status: "MANY" }
  | { status: "NONE" };

// Values seen in HR "location" fields that are not a city. Belt-and-braces:
// the exact-name rule below would reject most of these anyway.
const NON_CITY = new Set([
  "remote", "wfh", "work from home", "home", "hybrid", "field", "onsite", "on site",
  "offsite", "client site", "client location", "head office", "ho", "hq", "headquarters",
  "corporate office", "regional office", "branch", "branch office", "office", "na",
  "n a", "none", "nil", "tbd", "other", "others", "multiple", "various", "pan india",
  "india", "anywhere",
]);

async function strictOne(key: string, deps: StrictDeps): Promise<StrictCityResult> {
  const norm = normalizeSearch(key);
  if (!norm || NON_CITY.has(norm)) return { status: "NONE" };

  const curated = lookupDestination(key);
  const curatedCity = curated?.city || null;
  const curatedCountry = curatedCity ? countryFor(curatedCity) : null;

  // Catalog keys: the curated canonical name first (it is hand-checked), then
  // the text as written ("Bangalore" may be the row's lead variant).
  const keys = [curatedCity, key].filter(Boolean) as string[];
  for (const k of keys) {
    const rows = await deps.findCatalogMatches(k);
    // EXACT names only — a prefix or $text hit ("Remote" → "Remotevilla") is
    // not evidence that the profile names that city.
    const exact = rows.filter((r) => cityNameVariants(r.name).includes(normalizeSearch(k)));
    if (!exact.length) continue;
    const pick = await deps.pickCatalogCity(exact, k, { curatedCountry });
    if (pick.kind === "ONE") {
      return {
        status: "ONE",
        city: {
          cityName: curatedCity || pick.city.name,
          countryCode: curatedCountry || pick.city.countryCode,
          cityCode: pick.city.code,
        },
      };
    }
    if (pick.kind === "MANY") return { status: "MANY" };
  }

  // The curated table alone is still a single, hand-checked city — it just
  // has no catalog code (catalog unreachable / not carried).
  if (curatedCity) {
    return { status: "ONE", city: { cityName: curatedCity, countryCode: curatedCountry, cityCode: null } };
  }
  return { status: "NONE" };
}

export interface StrictDeps {
  findCatalogMatches: typeof findCatalogMatches;
  pickCatalogCity: typeof pickCatalogCity;
}

const DEFAULT_DEPS: StrictDeps = { findCatalogMatches, pickCatalogCity };

/**
 * Exactly one city, or nothing. Tries the whole text, then its first segment
 * ("Mumbai - Andheri" → "Mumbai", "Bengaluru, Koramangala" → "Bengaluru").
 */
export async function resolveCityStrict(
  text: string | null | undefined,
  deps: StrictDeps = DEFAULT_DEPS,
): Promise<StrictCityResult> {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { status: "NONE" };
  try {
    const whole = await strictOne(raw, deps);
    if (whole.status !== "NONE") return whole;
    const first = raw.split(/[,;/|()\-–—]/)[0]?.trim();
    if (first && first !== raw) return await strictOne(first, deps);
    return whole;
  } catch {
    return { status: "NONE" };
  }
}

/* ───────── OFFICE (profile) ───────── */

export type OfficeLookup =
  | { status: "RESOLVED"; city: StrictCity; raw: string; source: "jobLocation" | "employee.location" }
  | { status: "ASK"; raw: string | null; reason: "empty" | "not_a_city" | "ambiguous" };

function userIdOf(req: any): string | null {
  const u = req?.user;
  const id = u?._id || u?.id || u?.sub;
  return id ? String(id) : null;
}

/** The raw office text on the user's profile, or null. Never throws. */
export async function loadOfficeText(
  req: any,
): Promise<{ raw: string; source: "jobLocation" | "employee.location" } | null> {
  // No live DB → do not let Mongoose buffer the query for 10 s behind a turn.
  if (mongoose.connection?.readyState !== 1) return null;
  const userId = userIdOf(req);
  if (!userId || !mongoose.isValidObjectId(userId)) return null;
  try {
    const user: any = await User.findById(userId).select("jobLocation email").lean();
    const job = String(user?.jobLocation ?? "").trim();
    if (job) return { raw: job, source: "jobLocation" };

    const ws = req?.workspaceObjectId;
    if (!ws) return null;
    const or: any[] = [{ ownerId: userId }];
    if (user?.email) or.push({ email: String(user.email).toLowerCase() });
    const emp: any = await Employee.findOne({ workspaceId: ws, $or: or }).select("location").lean();
    const loc = String(emp?.location ?? "").trim();
    return loc ? { raw: loc, source: "employee.location" } : null;
  } catch {
    return null;
  }
}

export async function resolveOfficeCity(
  req: any,
  deps: StrictDeps = DEFAULT_DEPS,
  loader: typeof loadOfficeText = loadOfficeText,
): Promise<OfficeLookup> {
  const found = await loader(req);
  if (!found) return { status: "ASK", raw: null, reason: "empty" };
  const r = await resolveCityStrict(found.raw, deps);
  if (r.status === "ONE") return { status: "RESOLVED", city: r.city, raw: found.raw, source: found.source };
  return { status: "ASK", raw: found.raw, reason: r.status === "MANY" ? "ambiguous" : "not_a_city" };
}

export const OFFICE_ASK_TEXT = "I don't have your office city on file — which city is it in?";
export const OFFICE_ASK_CHIP = "Which city is your office in?";

export function officeDisclosure(city: string, mode: "hotels" | "hotels_pending" | "flight_origin" | "flight_destination"): string {
  switch (mode) {
    case "hotels":
      return `Your profile lists your office as ${city} — showing hotels in ${city} (city-wide, not sorted by distance to your office). `;
    case "hotels_pending":
      return `Your profile lists your office as ${city} — I'll search hotels in ${city} (city-wide, not sorted by distance to your office). `;
    case "flight_origin":
      return `Your profile lists your office as ${city}, so I've used ${city} as your departure city. `;
    case "flight_destination":
      return `Your profile lists your office as ${city}, so I've used ${city} as your destination. `;
  }
}

/* ───────── CURRENT LOCATION (IP) — suggestion only ───────── */

/** Kept short: a suggestion is never worth a slow turn. A cold instance's
 * first lookup downloads the geo DB and times out here — that is fine, the
 * turn simply asks the question it asked before. */
export const IP_SUGGESTION_TIMEOUT_MS = 600;

/**
 * The city the request IP points at, ONLY when the geo DB really looked it up
 * (source "ip") and the city survives the strict ladder. Read-only: uses
 * resolveCityFromIpBounded, which does NOT write an ActorLocation row.
 * Never throws, never blocks longer than the timeout.
 */
export async function suggestCurrentCity(
  req: any,
  opts: { timeoutMs?: number; deps?: StrictDeps } = {},
): Promise<StrictCity | null> {
  try {
    const loc = await resolveCityFromIpBounded(req?.ip ?? null, opts.timeoutMs ?? IP_SUGGESTION_TIMEOUT_MS);
    if (loc.source !== "ip" || !loc.city) return null;
    const r = await resolveCityStrict(loc.city, opts.deps ?? DEFAULT_DEPS);
    return r.status === "ONE" ? r.city : null;
  } catch {
    return null;
  }
}

export const OTHER_CITY_CHIP = "Other city — which one?";

/* ───────── Answers to a pending question ───────── */

/**
 * The city in a short answer to one of our questions. Handles the three ways
 * an answer arrives through the concierge's nextSteps chips:
 *   - a tapped action chip, submitted verbatim:
 *       "Flying from Bengaluru? (based on your current location)"
 *   - a question chip prefilled into the composer and completed by the user:
 *       "Other city — which one? Pune"
 *   - a plain typed reply: "Pune", "from Pune", "it's in Pune"
 * Returns null for anything longer than a short place answer, so a new
 * request typed after a question is never mistaken for an answer.
 */
export function parseCityAnswer(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = String(text).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const parts = t.split("?");
  let cand = (parts[parts.length - 1] || "").trim();
  if (!cand && parts.length > 1) cand = (parts[parts.length - 2] || "").trim();
  cand = cand
    .replace(/^(?:(?:i'?m|i\s+am|we'?re|we\s+are|it'?s|its|it\s+is)\s+)?/i, "")
    .replace(/^(?:(?:my\s+)?(?:office|workplace)\s+is\s+)?/i, "")
    .replace(/^(?:(?:flying|fly|departing|leaving|travell?ing|going|coming|based|staying)\s+)?/i, "")
    .replace(/^(?:(?:from|to|in|at|out\s+of)\s+)?/i, "")
    .replace(/[.!,;:]+$/g, "")
    .trim();
  if (!cand || !/^[A-Za-z][A-Za-z .'-]*$/.test(cand)) return null;
  if (cand.split(/\s+/).length > 4) return null;
  return cand;
}
