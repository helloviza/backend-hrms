// apps/backend/src/utils/plutoTripEdit.ts
//
// Pluto conversation state v2, slice S2 (design: docs/design/pluto-conversation-
// state-2026-11-10.md §3.3, §3.7, §9.2 Q6). PURE — no I/O; `now` is passed in.
//
//   stripFiller        "ok", "pls", "thanks", "hi Pluto", "[QC3]", emoji … off
//                      both ends, so whole-message parsers still match
//   parseTripEdit      "change to 21 Nov", "a day later", "round trip back on
//                      the 2nd", "one way", "2 of us, business class", "3 nights"
//   parseStayAnswer    the answer to "how many nights?" / "which dates?"
//   resolveStayWindow  the hotel check-in/check-out from the prompt and the trip
//   roomsFor           rooms = ceil(adults / 2) unless separate rooms (Q6)

import { parseDateToISO, extractPromptDateRange } from "./plutoDate.js";

/* ───────────────────────── filler ───────────────────────── */

const EMOJI_RX = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;
// No bare "k": "under 12 k" must keep its k.
const FILLER_WORD = String.raw`(?:ok(?:ay)?|okk+|please|pls|plz|thanks|thank\s+you|thx|ty|hey|hi|hello|hiya)(?:\s+pluto)?`;
const LEAD_RX = new RegExp(String.raw`^(?:\[[^\]]{0,40}\]|${FILLER_WORD}\b|pluto\b)[\s,.!:;~\-–—]*`, "i");
const TRAIL_RX = new RegExp(String.raw`[\s,.!:;~\-–—]*(?:\b${FILLER_WORD}|\bpluto|\[[^\]]{0,40}\])$`, "i");
const EDGE_PUNCT_RX = /^[\s,.…!?:;~\-–—]+|[\s,.…!?:;~\-–—]+$/g;

/**
 * The message without the polite / tagging noise around it: a leading
 * "[QC3]" tag, "ok", "okay", "please", "pls", "thanks", "hey", "hi Pluto",
 * emoji, and punctuation at either end. The middle is never touched, so
 * "skip hotels, show me flights" keeps its comma.
 */
export function stripFiller(prompt: string): string {
  let t = String(prompt ?? "").replace(EMOJI_RX, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 8; i++) {
    const before = t;
    t = t.replace(EDGE_PUNCT_RX, "").replace(LEAD_RX, "").replace(TRAIL_RX, "").trim();
    if (t === before) break;
  }
  return t;
}

/* ───────────────────────── dates ───────────────────────── */

const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*`;
/** A date token: "21 Nov", "21st November 2026", "Nov 21", "21/11", "the 21st", "21".
 *  A bare number never counts when a unit follows it ("3 nights", "2 people"). */
const NOT_A_COUNT = String.raw`(?!\s*(?:nights?|days?|people|persons|pax|adults?|guests?|travell?ers?|rooms?|of\s+us)\b)`;
const DATE_TOK = String.raw`(?:\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}(?:\s+\d{4})?|${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{1,2}(?:st|nd|rd|th)?${NOT_A_COUNT})`;

export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function nightsBetweenISO(a: string, b: string): number {
  const n = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  return Number.isFinite(n) ? n : 0;
}

function istTodayISO(now: Date): string {
  return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * A date token → ISO. A full date uses the nearest future occurrence. A bare
 * day ("the 21st", "22nd") takes the month of `ref` and rolls to the next
 * month when it would land before `after` (design §3.3: "round trip back on
 * the 2nd" after a 22 Nov start is 2 Dec).
 */
export function resolveDateToken(tok: string, opts: { ref?: string | null; after?: string | null; now: Date }): string | null {
  const t = tok.trim().replace(/^the\s+/i, "");
  const dm = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const mon = parseInt(dm[2], 10);
    if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
    let year = dm[3] ? parseInt(dm[3].length === 2 ? `20${dm[3]}` : dm[3], 10) : new Date(istTodayISO(opts.now)).getUTCFullYear();
    let iso = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!dm[3] && iso < istTodayISO(opts.now)) {
      year += 1;
      iso = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return iso;
  }
  if (/[a-z]{3}/i.test(t)) {
    const iso = parseDateToISO(t, opts.now);
    return iso || null;
  }
  const bare = t.match(/^(\d{1,2})(?:st|nd|rd|th)?$/i);
  if (!bare) return null;
  const day = parseInt(bare[1], 10);
  if (day < 1 || day > 31) return null;
  const ref = opts.ref && /^\d{4}-\d{2}-\d{2}$/.test(opts.ref) ? opts.ref : istTodayISO(opts.now);
  let [y, m] = ref.split("-").map((x) => parseInt(x, 10));
  const floor = opts.after || istTodayISO(opts.now);
  for (let i = 0; i < 3; i++) {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const valid = new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;
    if (valid && iso >= floor) return iso;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return null;
}

/* ───────────────────────── trip edits ───────────────────────── */

export type Cabin = "Economy" | "Premium Economy" | "Business" | "First";

export interface TripEdit {
  /** New outbound / check-in date. */
  start?: string;
  /** Move the whole trip by ± days ("a day later"). */
  shiftDays?: number;
  returnDate?: string;
  oneWay?: true;
  nights?: number;
  nightsDelta?: number;
  adults?: number;
  adultsDelta?: number;
  cabin?: Cabin;
  separateRooms?: true;
}

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NUM_WORD = String.raw`(?:\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)`;
function num(w: string): number {
  const k = w.toLowerCase();
  return NUM[k] ?? parseInt(k, 10);
}

// What may remain once every edit phrase is cut out — glue, never a fact.
const GLUE = new Set([
  "and", "also", "with", "but", "instead", "please", "actually", "make", "it", "the", "a", "an",
  "change", "changed", "to", "for", "so", "then", "now", "is", "fine", "ok", "okay", "trip",
  "flight", "flights", "date", "dates", "of", "on", "just", "can", "we", "you", "do", "lets",
  "let's", "i", "want", "need", "would", "like", "me", "that", "this", "one", "class", "cabin",
  "booking", "search", "rather", "move", "shift", "us", "be", "will", "go", "travel", "travelling",
  "traveling", "fly", "our", "my", "in", "yes", "yeah", "sure", "hotel", "hotels", "stay",
  "room", "rooms", "nights", "night", "more", "only", "plus", "add", "keep", "same", "too", "as",
  "well", "could", "should", "there", "will", "it's", "its", "at", "by", "back", "trip's",
]);

/**
 * A message that ONLY edits the trip — dates, return, travellers, cabin,
 * nights. Anything else left in it (a city, a hotel name, a question) means it
 * is not a pure edit, so it returns null and the turn classifies normally:
 * "flights from Bengaluru to Mumbai on 20 Nov" is a search, "change to Goa" a
 * destination change (S3).
 */
export function parseTripEdit(
  prompt: string,
  ctx: { start?: string | null; now: Date },
): TripEdit | null {
  const t = stripFiller(prompt).toLowerCase();
  if (!t || t.length > 120) return null;
  let rest = ` ${t} `;
  const cut = (m: RegExpMatchArray | null) => {
    if (m && m[0]) rest = rest.replace(m[0], " ");
  };
  const e: TripEdit = {};
  const start = ctx.start && /^\d{4}-\d{2}-\d{2}$/.test(ctx.start) ? ctx.start : null;

  // Return leg — "round trip back on 22nd", "return on the 22nd", "coming back 22 Nov".
  const ret = rest.match(new RegExp(
    String.raw`\b(?:(?:make\s+it\s+)?(?:a\s+)?round[\s-]?trip[,\s]*(?:and\s+)?)?(?:(?:coming|come|flying|fly|getting|get)\s+back|back|return(?:ing)?)\s+(?:on\s+|by\s+)?(?:the\s+)?(${DATE_TOK})\b`,
    "i",
  ));
  if (ret) {
    const iso = resolveDateToken(ret[1], { ref: start, after: start ? addDaysISO(start, 1) : null, now: ctx.now });
    if (iso) { e.returnDate = iso; cut(ret); }
  }

  const oneWay = rest.match(/\b(?:make\s+it\s+)?(?:a\s+)?one[\s-]?way(?:\s+(?:only|trip))?\b/i);
  if (oneWay) { e.oneWay = true; cut(oneWay); }

  // New outbound date — "change to 21 Nov", "move it to the 21st", "make it 21/11", "21 Nov instead".
  const change =
    rest.match(new RegExp(
      String.raw`\b(?:change|move|shift|switch|make|push|put)\s+(?:it|the\s+(?:date|dates|flight|trip|departure|check[\s-]?in|booking))?\s*(?:to|for|on)\s+(?:the\s+)?(${DATE_TOK})\b`,
      "i",
    )) ||
    rest.match(new RegExp(String.raw`\bmake\s+it\s+(?:the\s+)?(${DATE_TOK})\b`, "i")) ||
    rest.match(new RegExp(String.raw`^\s*(?:on\s+)?(?:the\s+)?(${DATE_TOK})\s+instead\b`, "i"));
  if (change && !e.start) {
    const iso = resolveDateToken(change[1], { ref: start, now: ctx.now });
    if (iso) { e.start = iso; cut(change); }
  }

  // Shift — "a day later", "one day earlier", "push it by 2 days", "2 days later".
  const shift =
    rest.match(new RegExp(String.raw`\b(${NUM_WORD})\s+days?\s+(later|earlier|after|before)\b`, "i")) ||
    rest.match(new RegExp(String.raw`\b(?:push|move|shift)\s+(?:it\s+)?(?:back\s+|out\s+|later\s+)?by\s+(${NUM_WORD})\s+days?\b`, "i")) ||
    rest.match(new RegExp(String.raw`\b(?:bring|pull|move)\s+(?:it\s+)?(?:forward|earlier)\s+by\s+(${NUM_WORD})\s+days?\b`, "i"));
  if (shift) {
    const n = num(shift[1]);
    const back = /earlier|before|forward|bring|pull/i.test(shift[0]);
    if (n > 0 && n < 60) { e.shiftDays = back ? -n : n; cut(shift); }
  }

  // Nights — "stay 2 more nights", "3 nights", "make it 4 nights".
  const moreNights = rest.match(new RegExp(String.raw`\b(?:stay\s+)?(${NUM_WORD})\s+(?:more|extra|additional)\s+nights?\b`, "i"));
  if (moreNights) { e.nightsDelta = num(moreNights[1]); cut(moreNights); }
  const nights = rest.match(new RegExp(String.raw`\b(?:for\s+|make\s+it\s+|stay\s+(?:for\s+)?)?(${NUM_WORD})\s+nights?\b`, "i"));
  if (nights) {
    const n = num(nights[1]);
    if (n > 0 && n <= 30) { e.nights = n; cut(nights); }
  }

  // Travellers.
  const pax =
    rest.match(new RegExp(String.raw`\b(?:for\s+)?(${NUM_WORD})\s+(?:people|persons|pax|passengers|travell?ers|adults|guests)\b`, "i")) ||
    rest.match(new RegExp(String.raw`\b(${NUM_WORD})\s+of\s+us\b`, "i")) ||
    rest.match(new RegExp(String.raw`\bwe\s+are\s+(${NUM_WORD})\b`, "i"));
  if (pax) {
    const n = num(pax[1]);
    if (n >= 1 && n <= 9) { e.adults = n; cut(pax); }
  }
  const addOne = rest.match(/\b(?:add|plus|bring(?:ing)?)\s+(?:my\s+|a\s+|one\s+)?(?:colleague|friend|wife|husband|partner|spouse|person|adult|travell?er|boss|manager|teammate)\b/i);
  if (addOne && e.adults === undefined) { e.adultsDelta = 1; cut(addOne); }
  const solo = rest.match(/\b(?:just|only)\s+me\b|\bsolo\b|\bon\s+my\s+own\b/i);
  if (solo && e.adults === undefined) { e.adults = 1; cut(solo); }

  // Cabin — "business" only as a cabin ("business class", "in business"), never "business trip".
  const cabin =
    rest.match(/\bpremium\s+economy\b/i) ||
    rest.match(/\bfirst\s+class\b/i) ||
    rest.match(/\bbusiness\s+class\b|\b(?:in|fly|flying)\s+business\b|\bbusiness\s+(?:instead|please)\b|^\s*business\s*$/i) ||
    rest.match(/\beconomy(?:\s+class)?\b/i);
  if (cabin) {
    const c = cabin[0].toLowerCase();
    e.cabin = c.includes("premium") ? "Premium Economy" : c.includes("first") ? "First" : c.includes("business") ? "Business" : "Economy";
    cut(cabin);
  }

  const sep = rest.match(/\bseparate\s+rooms?\b|\b(?:a\s+)?room\s+each\b|\bone\s+room\s+(?:each|per\s+person)\b/i);
  if (sep) { e.separateRooms = true; cut(sep); }

  if (!Object.keys(e).length) return null;
  const leftover = rest
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !GLUE.has(w));
  if (leftover.length) return null;
  return e;
}

/** What the edit is called in the branch metric (the first that applies). */
export function tripEditBranch(e: TripEdit): string {
  if (e.start || e.shiftDays) return "change_dates";
  if (e.returnDate) return "add_return";
  if (e.oneWay) return "change_dates";
  if (e.nights !== undefined || e.nightsDelta !== undefined) return "change_nights";
  if (e.adults !== undefined || e.adultsDelta !== undefined || e.separateRooms) return "change_travellers";
  if (e.cabin) return "change_cabin";
  return "trip_edit";
}

/* ───────────────────────── hotel stay ───────────────────────── */

/**
 * The answer to "How many nights?" / "Which dates?":
 * "3 nights", "3", "three please", "till the 22nd", "until 19 Nov",
 * "16 to 19 nov, same as the flight", "16 Nov for 3 nights".
 * `checkIn` is the stay start already known (from the flight); null when the
 * question was for the dates.
 */
export function parseStayAnswer(
  prompt: string,
  checkIn: string | null,
  now: Date,
): { start: string; end: string; nights: number } | null {
  const t = stripFiller(prompt).toLowerCase();
  if (!t || t.length > 80) return null;

  const range = extractPromptDateRange(t, now);
  if (range?.start && range.end && range.end > range.start) {
    return { start: range.start, end: range.end, nights: nightsBetweenISO(range.start, range.end) };
  }

  const nightsM =
    t.match(new RegExp(String.raw`^(?:for\s+|just\s+|make\s+it\s+)?(${NUM_WORD})(?:\s+nights?)?(?:\s+(?:only|please|is\s+fine))?$`, "i")) ||
    t.match(new RegExp(String.raw`\b(${NUM_WORD})\s+nights?\b`, "i"));
  const startTok = t.match(new RegExp(String.raw`^(?:from\s+|check[\s-]?in\s+)?(${DATE_TOK})\s+for\s+${NUM_WORD}\s+nights?`, "i"));
  const base = startTok ? resolveDateToken(startTok[1], { ref: checkIn, now }) : checkIn;
  if (nightsM && base) {
    const n = num(nightsM[1]);
    // A bare "21" with no "nights" is more likely a date than three weeks.
    const max = /\bnights?\b/i.test(t) ? 30 : 14;
    if (n >= 1 && n <= max) return { start: base, end: addDaysISO(base, n), nights: n };
  }

  if (checkIn) {
    const till = t.match(new RegExp(String.raw`^(?:till|until|to|through|check[\s-]?out(?:\s+on)?|leaving|out\s+on)?\s*(?:the\s+)?(${DATE_TOK})$`, "i"));
    if (till) {
      const end = resolveDateToken(till[1], { ref: checkIn, after: addDaysISO(checkIn, 1), now });
      if (end && end > checkIn) return { start: checkIn, end, nights: nightsBetweenISO(checkIn, end) };
    }
  }
  return null;
}

/** "for 3 nights" inside a hotel ask. */
export function nightsInPrompt(prompt: string): number | null {
  const m = String(prompt ?? "").match(new RegExp(String.raw`\b(${NUM_WORD})\s+nights?\b`, "i"));
  if (!m) return null;
  const n = num(m[1]);
  return n >= 1 && n <= 30 ? n : null;
}

export type StayWindow =
  | { start: string; end: string; nights: number; source: "prompt" | "locked" | "nights" | "return" }
  | { start: string; end: null; nights: null; source: "start_only" };

/**
 * The stay the hotel search should use (v2). Dates typed THIS turn win over
 * the locked ones (QC F-07: the user's latest words are the newest fact);
 * then the locked start with its nights, end, or the flight's return.
 * A start alone is returned as `start_only`, so the caller ASKS for the
 * nights instead of falling through to the model.
 */
export function resolveStayWindow(prompt: string, locked: any, now: Date): StayWindow | null {
  const typed = extractPromptDateRange(prompt, now);
  const typedNights = nightsInPrompt(prompt);
  if (typed?.start && typed.end && typed.end > typed.start) {
    return { start: typed.start, end: typed.end, nights: nightsBetweenISO(typed.start, typed.end), source: "prompt" };
  }
  const ld = locked?.dates || {};
  const start: string | null = typed?.start || (typeof ld.start === "string" ? ld.start : null);
  if (!start) return null;
  if (typedNights) return { start, end: addDaysISO(start, typedNights), nights: typedNights, source: "nights" };
  if (!typed?.start) {
    if (Number(ld.nights) > 0) {
      const n = Number(ld.nights);
      return { start, end: addDaysISO(start, n), nights: n, source: "locked" };
    }
    if (typeof ld.end === "string" && ld.end > start) {
      return { start, end: ld.end, nights: nightsBetweenISO(start, ld.end), source: "locked" };
    }
    if (typeof ld.returnDate === "string" && ld.returnDate > start) {
      return { start, end: ld.returnDate, nights: nightsBetweenISO(start, ld.returnDate), source: "return" };
    }
  }
  return { start, end: null, nights: null, source: "start_only" };
}

/** Rooms for a party (design Q6): two to a room unless they asked for separate rooms. */
export function roomsFor(adults: number, separate?: boolean): number {
  const a = Math.max(1, Math.floor(adults) || 1);
  return separate ? a : Math.ceil(a / 2);
}

/** "near Burj Khalifa", "close to BKC" → the landmark label. */
export function nearLabel(prompt: string): string | null {
  const m = String(prompt ?? "").match(
    /\b(?:near|around|close\s+to|next\s+to|walking\s+distance\s+(?:to|from|of))\s+(?:the\s+)?([A-Za-z][A-Za-z.'&-]*(?:\s+[A-Za-z][A-Za-z.'&-]*){0,3}?)(?=\s+(?:for|from|on|in|with|till|until|between|and|,)\b|\s*[,.!?]|\s+\d|\s*$)/i,
  );
  const label = m?.[1]?.trim();
  if (!label || /^(?:me|here|my|the|airport)$/i.test(label)) return null;
  return label;
}

/** Display a stay: "16–19 Nov" / "30 Nov–2 Dec". */
export function stayLabel(start: string, end: string): string {
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [, sm, sd] = start.split("-").map((x) => parseInt(x, 10));
  const [, em, ed] = end.split("-").map((x) => parseInt(x, 10));
  return sm === em ? `${sd}–${ed} ${mon[em - 1]}` : `${sd} ${mon[sm - 1]}–${ed} ${mon[em - 1]}`;
}

/** "Sat 21 Nov". */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${wd} ${d.getUTCDate()} ${mon}`;
}
