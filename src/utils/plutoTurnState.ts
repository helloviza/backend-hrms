// apps/backend/src/utils/plutoTurnState.ts
//
// Pluto conversation state v2 (design: docs/design/pluto-conversation-state-
// 2026-11-10.md). Everything here is PURE — no I/O, no clock reads except
// where `now` is passed in — so each matcher is unit-testable on its own and
// the route only wires them.
//
// Behind PLUTO_STATE_V2 (default off). With the flag off nothing in this file
// is reached from a turn.

import { resolveIATA } from "./plutoIata.js";
import { lookupDestination } from "../data/destinationLookup.js";

export function isStateV2Enabled(): boolean {
  const v = String(process.env.PLUTO_STATE_V2 ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

/** Stored flight rows stay filterable — and bookable on their own TraceId —
 *  for this long after the search (design §8 Q1: 12 minutes). */
export const FLIGHT_ROWS_FRESH_MS = 12 * 60 * 1000;

/* ───────────────────────── Flight filters ───────────────────────── */

export type DepartWindow = "morning" | "afternoon" | "evening" | "night";

export interface FlightFilters {
  maxStops?: 0 | 1;
  sort?: "price" | "duration";
  maxFare?: number;
  /** Departure window — "morning", "evening flights" (design §8 Q2). */
  departWindow?: DepartWindow;
  departAfter?: string; // "HH:MM"
  departBefore?: string; // "HH:MM"
  /** ARRIVAL — "arrive / reach / be there by …" (design §8 Q2). */
  arriveBy?: string; // "HH:MM", on the leg's own date
  airlinesInclude?: string[]; // airline codes
  airlinesExclude?: string[];
  refundableOnly?: boolean;
}

// [start, end) in minutes after midnight; night wraps past midnight.
const WINDOWS: Record<DepartWindow, { from: number; to: number; label: string }> = {
  morning: { from: 5 * 60, to: 12 * 60, label: "05:00–11:59" },
  afternoon: { from: 12 * 60, to: 17 * 60, label: "12:00–16:59" },
  evening: { from: 17 * 60, to: 21 * 60, label: "17:00–20:59" },
  night: { from: 21 * 60, to: 5 * 60, label: "21:00–04:59" },
};
// "be there by morning" → arrive before the window closes.
const WINDOW_END: Record<DepartWindow, string> = {
  morning: "12:00",
  afternoon: "17:00",
  evening: "21:00",
  night: "05:00",
};

function minutesOf(hhmm: string | undefined | null): number | null {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function hhmm(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** "10", "10am", "6:30 pm", "noon" → "HH:MM" (24h). Bare numbers 1–6 read as pm. */
function clockOf(h: string, min?: string, ampm?: string): string | null {
  let hour = parseInt(h, 10);
  const minute = min ? parseInt(min, 10) : 0;
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  const ap = (ampm || "").toLowerCase();
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  if (!ap && hour >= 1 && hour <= 6) hour += 12;
  return hhmm(hour * 60 + minute);
}

const WINDOW_RX = /\b(morning|afternoon|evening|night|red[\s-]?eye|late[\s-]night)\b/i;
function windowOf(word: string): DepartWindow {
  const w = word.toLowerCase();
  if (w === "morning") return "morning";
  if (w === "afternoon") return "afternoon";
  if (w === "evening") return "evening";
  return "night";
}

const ARRIVE_CUE = String.raw`(?:arrive|arriving|arrival|reach|reaching|land|landing|be\s+there|get\s+there|be\s+in\s+[a-z]+)`;

/**
 * Read flight refinements from a message. `rows` are the stored results, used
 * only to recognise airline names that are actually in them. Returns null when
 * the message carries no refinement at all; `{ clear: true }` for "clear
 * filters" / "show all".
 */
export function parseFlightRefinement(
  prompt: string,
  rows: any[] = [],
): { clear: true } | { clear?: false; filters: FlightFilters } | null {
  const t = String(prompt ?? "");
  if (!t.trim()) return null;

  if (/\b(?:clear|reset|remove)\s+(?:all\s+|the\s+)?filters?\b|\bshow\s+(?:me\s+)?all(?:\s+(?:the\s+)?flights)?\b|\bno\s+filters?\b/i.test(t)) {
    return { clear: true };
  }

  const f: FlightFilters = {};

  if (/\bnon[\s-]?stops?\b|\bdirect(?:\s+flights?)?\b|\bno\s+(?:layovers?|stops?|connections?)\b/i.test(t)) f.maxStops = 0;
  else if (/\bfewer\s+stops\b|\b(?:max(?:imum)?|at\s+most|up\s+to)\s+(?:1|one)\s+stop\b|\bone[\s-]stop\b/i.test(t)) f.maxStops = 1;

  if (/\bcheap(?:er|est)?\b|\blow(?:er|est)\s+(?:fare|price)s?\b|\bless\s+expensive\b|\bbudget\b/i.test(t)) f.sort = "price";
  else if (/\bfast(?:er|est)\b|\bshort(?:er|est)\b|\bquick(?:er|est)\b/i.test(t)) f.sort = "duration";

  const fare = t.match(/\b(?:under|below|less\s+than|max(?:imum)?|within)\s*(?:₹|rs\.?\s*|inr\s*)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\b/i);
  if (fare) {
    const n = parseFloat(fare[1].replace(/,/g, "")) * (fare[2] ? 1000 : 1);
    if (n >= 1000) f.maxFare = Math.round(n);
  }

  // ARRIVAL cue first, so "be there by morning" is never also a departure window.
  // "(?!…month)" — "be in Mumbai by 20 Nov" is a date, never 20:00.
  const NOT_A_DATE = String.raw`(?!\s*(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\s*[\/-]\d)`;
  const arrive =
    t.match(new RegExp(String.raw`\b${ARRIVE_CUE}\s+(?:by|before)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b${NOT_A_DATE}`, "i")) ||
    null;
  const arriveWord = arrive
    ? null
    : t.match(new RegExp(String.raw`\b${ARRIVE_CUE}\s+(?:by|before)\s+(?:the\s+)?(noon|midday|morning|afternoon|evening|night)\b`, "i"));
  if (arrive) {
    const c = clockOf(arrive[1], arrive[2], arrive[3]);
    if (c) f.arriveBy = c;
  } else if (arriveWord) {
    const w = arriveWord[1].toLowerCase();
    f.arriveBy = w === "noon" || w === "midday" ? "12:00" : WINDOW_END[windowOf(w)];
  }

  if (!f.arriveBy) {
    const win = t.match(WINDOW_RX);
    if (win) f.departWindow = windowOf(win[1]);
  }
  // A clock needs am/pm or ":mm" here — "after 3 days" is not 15:00.
  const after = t.match(/\bafter\s+(\d{1,2})(?:(?::(\d{2}))\s*(am|pm)?|\s*(am|pm))\b/i);
  if (after && !f.departWindow) {
    const c = clockOf(after[1], after[2], after[3] || after[4]);
    if (c) f.departAfter = c;
  }
  const before = !f.arriveBy && t.match(/\b(?:depart(?:ing|ure)?|leav(?:e|ing))\s+before\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (before) {
    const c = clockOf(before[1], before[2], before[3]);
    if (c) f.departBefore = c;
  }

  if (/\brefundable\b|\bfree\s+cancell?ation\b|\bcancell?able\b/i.test(t) && !/\bnon[\s-]?refundable\b/i.test(t)) {
    f.refundableOnly = true;
  }

  // Airlines — only names present in the stored rows, longest first, so
  // "Air India Express" is never also read as "Air India".
  const names = new Map<string, string>(); // lower name → code
  for (const r of rows || []) {
    const name = String(r?.airline?.name || "").trim();
    const code = String(r?.airline?.code || "").trim();
    if (name && code) names.set(name.toLowerCase(), code);
  }
  let rest = t.toLowerCase();
  const include: string[] = [];
  const exclude: string[] = [];
  for (const name of [...names.keys()].sort((a, b) => b.length - a.length)) {
    const idx = rest.indexOf(name);
    if (idx < 0) continue;
    const before = rest.slice(Math.max(0, idx - 24), idx);
    const code = names.get(name) as string;
    if (/\b(?:no|not|avoid|except|without|exclude|excluding|skip)\b[\w\s]*$/.test(before)) exclude.push(code);
    else include.push(code);
    rest = rest.slice(0, idx) + " ".repeat(name.length) + rest.slice(idx + name.length);
  }
  if (include.length) f.airlinesInclude = [...new Set(include)];
  if (exclude.length) f.airlinesExclude = [...new Set(exclude)];

  return Object.keys(f).length ? { filters: f } : null;
}

/** A later refinement adds to (or overrides) the earlier ones (design §8 Q4). */
export function mergeFlightFilters(prev: FlightFilters | undefined, next: FlightFilters): FlightFilters {
  const out: FlightFilters = { ...(prev || {}), ...next };
  if (next.departWindow) { delete out.departAfter; delete out.departBefore; }
  if (next.departAfter || next.departBefore) delete out.departWindow;
  const inc = new Set([...(prev?.airlinesInclude || []), ...(next.airlinesInclude || [])]);
  const exc = new Set([...(prev?.airlinesExclude || []), ...(next.airlinesExclude || [])]);
  for (const c of next.airlinesInclude || []) exc.delete(c);
  for (const c of next.airlinesExclude || []) inc.delete(c);
  if (inc.size) out.airlinesInclude = [...inc]; else delete out.airlinesInclude;
  if (exc.size) out.airlinesExclude = [...exc]; else delete out.airlinesExclude;
  return out;
}

function fareOf(r: any): number {
  const n = Number(r?.fare?.offered ?? r?.fare?.published ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}
function durOf(r: any): number {
  const n = Number(r?.durationMin);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

/**
 * Apply filters to one leg's rows. Time filters (departure window, after /
 * before, arrive-by) apply to the OUTBOUND leg only; stops, fare, airline and
 * refundability apply to both. Never mutates the input.
 */
export function applyFlightFilters(
  rows: any[],
  f: FlightFilters,
  opts: { leg: "out" | "in"; legDate?: string | null } = { leg: "out" },
): any[] {
  const timed = opts.leg === "out";
  const out = (rows || []).filter((r: any) => {
    if (f.maxStops !== undefined && Number(r?.stops ?? 99) > f.maxStops) return false;
    if (f.maxFare !== undefined && !(fareOf(r) <= f.maxFare)) return false;
    if (f.refundableOnly && r?.isRefundable !== true) return false;
    const code = String(r?.airline?.code || "");
    if (f.airlinesInclude?.length && !f.airlinesInclude.includes(code)) return false;
    if (f.airlinesExclude?.length && f.airlinesExclude.includes(code)) return false;
    if (timed) {
      const dep = minutesOf(r?.departure?.time);
      if (f.departWindow) {
        const w = WINDOWS[f.departWindow];
        if (dep === null) return false;
        const inWin = w.from < w.to ? dep >= w.from && dep < w.to : dep >= w.from || dep < w.to;
        if (!inWin) return false;
      }
      if (f.departAfter && !(dep !== null && dep >= (minutesOf(f.departAfter) as number))) return false;
      if (f.departBefore && !(dep !== null && dep < (minutesOf(f.departBefore) as number))) return false;
      if (f.arriveBy) {
        const arr = minutesOf(r?.arrival?.time);
        const arrDate = String(r?.arrival?.date || "");
        if (arr === null) return false;
        // Arriving the next day is never "by 10am" on the trip date.
        if (opts.legDate && arrDate && arrDate > opts.legDate) return false;
        if (!(opts.legDate && arrDate && arrDate < opts.legDate) && arr > (minutesOf(f.arriveBy) as number)) return false;
      }
    }
    return true;
  });
  if (f.sort === "price") out.sort((a, b) => fareOf(a) - fareOf(b));
  else if (f.sort === "duration") out.sort((a, b) => durOf(a) - durOf(b));
  return out;
}

const AIRLINE_LABEL = (rows: any[], code: string): string =>
  String((rows || []).find((r: any) => r?.airline?.code === code)?.airline?.name || code);

/** Human labels for the active filters, in a stable order. */
export function describeFlightFilters(f: FlightFilters, rows: any[] = []): string[] {
  const out: string[] = [];
  if (f.maxStops === 0) out.push("non-stop");
  if (f.maxStops === 1) out.push("max 1 stop");
  if (f.departWindow) out.push(`${f.departWindow} departures (${WINDOWS[f.departWindow].label})`);
  if (f.departAfter) out.push(`departing after ${f.departAfter}`);
  if (f.departBefore) out.push(`departing before ${f.departBefore}`);
  if (f.arriveBy) out.push(`arriving by ${f.arriveBy}`);
  if (f.airlinesInclude?.length) out.push(`${f.airlinesInclude.map((c) => AIRLINE_LABEL(rows, c)).join(" / ")} only`);
  if (f.airlinesExclude?.length) out.push(`no ${f.airlinesExclude.map((c) => AIRLINE_LABEL(rows, c)).join(" / ")}`);
  if (f.refundableOnly) out.push("refundable");
  if (f.maxFare) out.push(`under ₹${f.maxFare.toLocaleString("en-IN")}`);
  if (f.sort === "price") out.push("cheapest first");
  if (f.sort === "duration") out.push("fastest first");
  return out;
}

/** Words that re-create the filters inside a search prompt (for a re-search chip). */
export function flightFilterWords(f: FlightFilters): string {
  const w: string[] = [];
  if (f.maxStops === 0) w.push("non-stop");
  if (f.departWindow) w.push(f.departWindow);
  if (f.refundableOnly) w.push("refundable");
  if (f.sort === "price") w.push("cheapest");
  return w.join(" ");
}

/* ───────────────────────── "X to Y" route ───────────────────────── */

// Words that make "X to Y" something other than a flight route ask.
const NOT_A_ROUTE_RX =
  /\b(?:hotels?|stays?|staying|accommodations?|trip|trips|plan|planning|itinerary|ideas?|things|visa|weather|places|attractions|holiday|vacation|tour|tours|train|trains|bus|buses|drive|driving|cab|taxi|distance|how\s+far|how\s+long)\b/i;

function resolveCityToIATA(raw: string): string | null {
  const city = lookupDestination(raw)?.city || raw;
  return resolveIATA(city) || resolveIATA(raw) || null;
}

/**
 * "bengaluru to mumbai on 20 nov", "BLR-DEL 5 Dec", "blr → bom tomorrow,
 * morning only" — a flight route with no "flights" / "from". Both ends must
 * resolve to an airport. Returns the same ask rewritten in the form the
 * flight branch's extractors already read ("flights from X to Y …").
 */
export function matchXToYRoute(prompt: string): { origin: string; destination: string; prompt: string } | null {
  const t = String(prompt ?? "").trim();
  if (!t || t.length > 140) return null;
  if (/\bfrom\b/i.test(t)) return null; // the "from … to" form is already read
  if (NOT_A_ROUTE_RX.test(t)) return null;
  const m = t.match(
    /^(?:(?:flights?|fly|flying)\s+)?([A-Za-z][A-Za-z.]*(?:\s+[A-Za-z][A-Za-z.]*){0,2}?)\s*(?:\s+to\s+|\s*(?:→|->|–|—)\s*|-)\s*([A-Za-z][A-Za-z.]*(?:\s+[A-Za-z][A-Za-z.]*){0,2}?)(?=\s+(?:on|for|by|this|next|tomorrow|today|tonight|in|returning|return|back|morning|afternoon|evening|night|non[\s-]?stop|direct|cheapest|only|flights?)\b|\s+\d|\s*[,.!?]|\s*$)(.*)$/i,
  );
  if (!m) return null;
  const a = m[1].trim();
  const b = m[2].trim();
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return null;
  // "X to Y to Z" — never a single leg (the flight branch's multi-city
  // downgrade only sees it when it is phrased with "from").
  if (/^\s*(?:to|→|->|-)\s+[A-Za-z]/i.test(m[3])) return null;
  const oi = resolveCityToIATA(a);
  const di = resolveCityToIATA(b);
  if (!oi || !di || oi === di) return null;
  return { origin: a, destination: b, prompt: `flights from ${a} to ${b}${m[3]}` };
}

/* ───────────────────────── Park a task ───────────────────────── */

const PARK_TIME = String.raw`(?:\s+(?:for\s+now|right\s+now|now|for\s+the\s+moment|for\s+a\s+bit|for\s+a\s+while|till\s+later|until\s+later|for\s+later|for\s+today))?`;
const PARK_LEAD = String.raw`^(?:(?:ok(?:ay)?|okk+|fine|alright|cool|hmm+|no|nah|actually)[\s,.!]*)*(?:let'?s\s+|please\s+|just\s+)?`;

/**
 * "leave flights for now", "ok leave flight right now", "skip hotels",
 * "forget the hotel for now", "not now", "later". The WHOLE message must be
 * the park ask: "skip hotels, show me flights to Goa" is not (compound park is
 * slice S4). kind null = no task named ("not now").
 */
export function parseParkTask(prompt: string): { kind: "flight" | "hotel" | null } | null {
  const t = String(prompt ?? "").trim();
  if (!t || t.length > 80) return null;
  const verb = new RegExp(
    String.raw`${PARK_LEAD}(?:leave|skip|park|pause|drop|forget(?:\s+about)?|hold\s+off(?:\s+on)?|hold)\s+(?:the\s+|my\s+)?(flights?|hotels?|stays?)${PARK_TIME}[\s.!]*$`,
    "i",
  ).exec(t);
  const noun = verb || new RegExp(
    String.raw`${PARK_LEAD}(?:no\s+(flights?|hotels?)${PARK_TIME}|(flights?|hotels?)\s+can\s+wait)[\s.!]*$`,
    "i",
  ).exec(t);
  const m = verb || noun;
  if (m) {
    const word = (m[1] || m[2] || m[3] || "").toLowerCase();
    return { kind: word.startsWith("flight") ? "flight" : "hotel" };
  }
  if (new RegExp(String.raw`${PARK_LEAD}(?:not\s+now|not\s+yet|maybe\s+later|later|no\s+thanks|not\s+right\s+now)[\s.!]*$`, "i").test(t)) {
    return { kind: null };
  }
  return null;
}

/** "back to flights", "resume flights", "show the flights again". */
export function isResumeFlights(prompt: string): boolean {
  return /^\s*(?:ok(?:ay)?[\s,]*)?(?:back\s+to|resume|show(?:\s+me)?)\s+(?:the\s+|my\s+)?flights?(?:\s+again)?[\s.!]*$/i.test(String(prompt ?? ""));
}

/* ───────────────────────── Client projection ───────────────────────── */

/**
 * What the client gets back: the stored state minus the server-only parts —
 * search rows (tens of KB, already on the reply that showed them) and the
 * write bookkeeping. `pending` (including its prompt) stays: whenever a stored
 * doc exists the server ignores the client's copy anyway, and when none does
 * (a failed write, no store) the client's copy is what still lets "Pune"
 * answer "where are you flying from?" — today's behaviour.
 */
export function projectForClient(state: any): any {
  if (!state || typeof state !== "object") return state;
  const out: any = { ...state };
  const ls = state.lastSearch;
  if (ls && typeof ls === "object") {
    const strip = (s: any) => {
      if (!s || typeof s !== "object") return s;
      const { rows, shownRefs: _shown, at: _at, ...rest } = s;
      const count = Array.isArray(rows) ? rows.length : Array.isArray(rows?.flights) ? rows.flights.length : undefined;
      return { ...rest, ...(count !== undefined ? { count } : {}) };
    };
    out.lastSearch = {
      ...(ls.active ? { active: ls.active } : {}),
      ...(ls.flight ? { flight: strip(ls.flight) } : {}),
      ...(ls.hotel ? { hotel: strip(ls.hotel) } : {}),
    };
  }
  return out;
}
