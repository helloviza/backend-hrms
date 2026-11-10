// Place facts computed in code, never by the model (state v2 S3, design §4.6
// and QC F-19, F-24).
//
//  • Time zones: IANA zones from the bundled airport data (the same file the
//    carbon seed reads), evaluated AT THE TRIP DATE so daylight saving is
//    right. Prod F-24: the model said Dubai is 1.5 h AHEAD of Bengaluru; it is
//    1 h 30 m BEHIND (UTC+4 v UTC+5:30).
//  • Proper city names: titles and the trip pill used the user's casing
//    ("bengaluru → mumbai", F-19).
//  • stripTzSentences: removes any model sentence that states an offset.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupDestination } from "../data/destinationLookup.js";
import { resolveIATA } from "./plutoIata.js";

interface AirportRow { iata?: string; city?: string; country?: string; timezone?: string }

let byIata: Map<string, AirportRow> | null = null;
let byCity: Map<string, AirportRow> | null = null;

/** The bundled airport table (src/data → dist/data at build). Lazy, once. */
function airports(): { byIata: Map<string, AirportRow>; byCity: Map<string, AirportRow> } {
  if (byIata && byCity) return { byIata, byCity };
  byIata = new Map();
  byCity = new Map();
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rows: AirportRow[] = JSON.parse(
      readFileSync(path.join(here, "..", "data", "carbon", "openflights-airports.json"), "utf8"),
    );
    for (const r of rows) {
      if (!r?.timezone) continue;
      if (r.iata) byIata.set(r.iata.toUpperCase(), r);
      const c = String(r.city || "").toLowerCase();
      if (c && !byCity.has(c)) byCity.set(c, r);
    }
  } catch {
    // No table → no time-zone facts; every caller degrades to saying nothing.
  }
  return { byIata, byCity };
}

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());

/**
 * The proper name for a city the user typed ("bengaluru" → "Bengaluru").
 * The curated table first, then the airport table when it names the same
 * city; otherwise the user's own word with its casing fixed. Never a rename.
 */
export function properCityName(raw: string | null | undefined): string {
  const s = String(raw || "").trim();
  if (!s) return s;
  const curated = lookupDestination(s)?.city;
  if (curated) return curated;
  const iata = resolveIATA(s);
  const row = iata ? airports().byIata.get(iata) : undefined;
  if (row?.city && row.city.toLowerCase() === s.toLowerCase()) return row.city;
  if (/^[A-Z]{3}$/.test(s)) return s; // an airport code stays a code
  return s === s.toLowerCase() ? titleCase(s) : s;
}

/** IANA zone for a place: its IATA code, else its city name. */
export function timeZoneFor(place: { iata?: string | null; name?: string | null }): string | null {
  const { byIata: I, byCity: C } = airports();
  const code = place.iata ? String(place.iata).toUpperCase() : null;
  if (code && I.get(code)?.timezone) return I.get(code)!.timezone!;
  const name = String(place.name || "").trim();
  if (!name) return null;
  const viaCode = resolveIATA(name);
  if (viaCode && I.get(viaCode)?.timezone) return I.get(viaCode)!.timezone!;
  return C.get(name.toLowerCase())?.timezone || null;
}

/** UTC offset of `tz`, in minutes, at noon UTC on `isoDate` (DST-aware). */
export function offsetMinutes(tz: string, isoDate: string): number | null {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? new Date(`${isoDate}T12:00:00Z`) : new Date();
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value || "";
    if (part === "GMT") return 0;
    const m = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return null;
    const mins = parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0);
    return m[1] === "-" ? -mins : mins;
  } catch {
    return null;
  }
}

/** "1h 30m", "5h", "45m" for a positive minute count. */
export function hoursLabel(mins: number): string {
  const a = Math.abs(mins);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || "0m";
}

/**
 * Minutes `b` is ahead of `a` (negative = behind) on `isoDate`. By IATA code,
 * falling back to city names. null when either zone is unknown.
 * tzDifference("BLR", "LHR", "2026-11-16") → -330; in July → -270 (BST).
 */
export function tzDifference(a: string, b: string, isoDate: string): number | null {
  const za = timeZoneFor(/^[A-Z]{3}$/.test(a) ? { iata: a } : { name: a });
  const zb = timeZoneFor(/^[A-Z]{3}$/.test(b) ? { iata: b } : { name: b });
  if (!za || !zb) return null;
  const oa = offsetMinutes(za, isoDate);
  const ob = offsetMinutes(zb, isoDate);
  if (oa === null || ob === null) return null;
  return ob - oa;
}

/** "-5h30m" / "+1h" / "0" — the compact form the tests pin. */
export function formatTzDifference(mins: number): string {
  if (mins === 0) return "0";
  return `${mins < 0 ? "-" : "+"}${hoursLabel(mins).replace(" ", "")}`;
}

function utcLabel(mins: number): string {
  if (mins === 0) return "UTC+0";
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  return `UTC${mins < 0 ? "−" : "+"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

export interface TzPlace { name: string; iata?: string | null }

/**
 * One sentence, built in code: "Dubai is 1h 30m behind Bengaluru." /
 * "Same time as Bengaluru." / "Dubai is on UTC+4." (no reference place).
 * null when the destination's zone is unknown.
 */
export function tzSentence(dest: TzPlace, ref: TzPlace | null, isoDate: string): string | null {
  const zd = timeZoneFor(dest);
  if (!zd) return null;
  const od = offsetMinutes(zd, isoDate);
  if (od === null) return null;
  const zr = ref ? timeZoneFor(ref) : null;
  const or = zr ? offsetMinutes(zr, isoDate) : null;
  if (!ref || or === null) return `${dest.name} is on ${utcLabel(od)}.`;
  const diff = od - or;
  if (diff === 0) return `Same time as ${ref.name}.`;
  return `${dest.name} is ${hoursLabel(diff)} ${diff > 0 ? "ahead of" : "behind"} ${ref.name}.`;
}

/* ── the model's own time-zone sentences ── */

const TZ_PATTERNS: RegExp[] = [
  /\b\d+(?:[.,]\d+)?\s*(?:h|hrs?|hours?)(?:\s*(?:and\s+)?\d+\s*(?:m|mins?|minutes?))?\s+(?:ahead|behind)\b/i,
  // "earlier/later" only as a comparison ("2 hours later than India"), never
  // a schedule ("arrive 3 hours earlier").
  /\b\d+(?:[.,]\d+)?\s*(?:h|hrs?|hours?)(?:\s*(?:and\s+)?\d+\s*(?:m|mins?|minutes?))?\s+(?:earlier|later)\s+than\b/i,
  /\b(?:an?|one|two|three|four|five|half\s+an?)\s+(?:and\s+a\s+half\s+)?hours?(?:\s+and\s+a\s+half)?\s+(?:ahead|behind)\b/i,
  /\b(?:GMT|UTC)\s*[+−-]\s*\d/i,
  /\btime\s+(?:difference|zone)\b[^.]*\d/i,
];

export function statesTimeOffset(sentence: string): boolean {
  return TZ_PATTERNS.some((re) => re.test(sentence));
}

/**
 * Remove every sentence that states a time offset or difference. Sentences
 * are split on . ! ? and line breaks; nothing else is touched.
 */
export function stripTzSentences(text: string): { text: string; stripped: number } {
  if (!text || typeof text !== "string") return { text, stripped: 0 };
  let stripped = 0;
  const out = text
    .split(/(\n+)/)
    .map((chunk) => {
      if (/^\n+$/.test(chunk)) return chunk;
      const parts = chunk.match(/[^.!?]+(?:[.!?]+(?=\s|$)|[.!?]*$)/g) || [chunk];
      const kept = parts.filter((p) => {
        if (statesTimeOffset(p)) {
          stripped += 1;
          return false;
        }
        return true;
      });
      return kept.join("").replace(/^\s+/, "");
    })
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: out, stripped };
}
