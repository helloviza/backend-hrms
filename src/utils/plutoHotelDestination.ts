// apps/backend/src/utils/plutoHotelDestination.ts
//
// WHICH CITY does a hotel-led turn mean, and can we actually serve it?
//
// The hotel lane used to answer that with one nullable string, which collapsed
// three genuinely different situations into one:
//
//   RESOLVED    — we know the city AND can price it. The live lane runs.
//   UNSUPPORTED — the user NAMED somewhere we cannot search. A dead end that no
//                 further question fixes, so say so instead of asking for dates
//                 we already have and failing afterwards anyway.
//   NO_CITY     — nothing was named. Asking which city is the right reply.
//
// Conflating UNSUPPORTED with NO_CITY is what produced the "show me some hotels
// in london for same duration" turn: London extracted as null (it is not in the
// curated destination table, and the extractor also required a capital letter),
// the turn fell through to the model, and the model asked for travel dates that
// were already locked from the previous turn. Two failures in one reply — it
// lost context it held, and it asked a question that could not unblock anything.
//
// COUNTRY RESOLUTION, and why it widened. The ownership gate asked countryFor()
// — the ~280-entry curated destinationLookup built from historical bookings.
// searchHotels, meanwhile, prices against `tbocities`: 53,943 rows carrying a
// code AND a countryCode. London/GB/126632, Tokyo/JP/148251 and Paris/FR/131408
// were all sitting in the collection the search already queries, so "we cannot
// serve London" would have been false. The curated table is still consulted
// FIRST (it canonicalises spelling and is hand-checked); the catalog is the
// fallback that makes the rest of the world reachable.
//
// The honest handoff is therefore reserved for what genuinely does not resolve
// in EITHER source, which is where it is a true statement.

import mongoose from "mongoose";
import {
  TBOCity,
  TBOCountry,
  TBOHotelMaster,
  normalizeSearch,
} from "../jobs/static-data-refresh.js";
import { countryFor } from "../data/destinationLookup.js";
import { extractHotelCity, extractNamedPlaceCandidate } from "./plutoHotelSearch.js";
import { normalizeCityNameWithLLM } from "./plutoCityNormalize.js";

export type HotelDestination =
  | {
      status: "RESOLVED";
      cityName: string;
      countryCode: string;
      cityCode: string;
      /**
       * Set when the user named a COUNTRY and we picked its main city for them.
       * The reply MUST disclose it — silently turning "hotels in Qatar" into a
       * Doha result is the same class of answer-for-the-wrong-place this module
       * exists to stop, just a smaller version of it.
       */
      viaCountry?: string;
    }
  /**
   * The name matched SEVERAL real, bookable cities and nothing in the data
   * separates them — six "Santa Maria"s in six countries, fifteen
   * "Springfield"s. Picking one is a coin flip presented as an answer, which is
   * the worst thing this lane can do, so the turn asks instead.
   *
   * Deliberately NOT UNSUPPORTED: every candidate here is servable. The user
   * just has to say which.
   */
  | {
      status: "AMBIGUOUS";
      /** What the user typed / what we looked up, for the question copy. */
      query: string;
      candidates: AmbiguousCity[];
    }
  | { status: "UNSUPPORTED"; cityName: string }
  | { status: "NO_CITY" };

/** One option offered by an AMBIGUOUS result. */
export interface AmbiguousCity {
  cityName: string;
  countryCode: string;
  cityCode: string;
  /** "Illinois", "Andhra Pradesh" — the qualifier that tells them apart. */
  region?: string;
}

/** A `tbocities` row, trimmed to what resolution needs. */
export interface CatalogCity {
  code: string;
  name: string;
  countryCode: string;
}

/** How many candidates an AMBIGUOUS reply offers before it stops being a question. */
const MAX_AMBIGUOUS_CANDIDATES = 5;

/** Over-fetch per stage, then verify and rank in JS. */
const CANDIDATE_POOL = 60;

/**
 * Catalog names are not display copy: TBO stores things like
 * "Bangkok,   Bangkok" (duplicated, padded). Take the part before the comma and
 * collapse the whitespace so the reply reads "Hotels in Bangkok". Trimming
 * presentation only — the CODE we search with is untouched.
 */
export function tidyCatalogCityName(raw: string): string {
  const first = String(raw || "").split(",")[0];
  return first.replace(/\s+/g, " ").trim() || String(raw || "").trim();
}

/* ── The matching ladder ────────────────────────────────────────────────────
 *
 * WHY THIS REPLACED exact-then-prefix. `searchName` is normalizeSearch(name),
 * which turns every separator into a space — so TBO's real row
 * "Vizag/Visakhapatnam,   Andhra Pradesh" becomes the flat string
 * "vizag visakhapatnam andhra pradesh" with no marker of where the name ends.
 * A prefix query can only ever see the FIRST token, so the city's actual name
 * never matched and Visakhapatnam read as "not in our inventory" despite 305
 * bookable hotels. That shape is not a one-off: 156 catalog rows carry an
 * alternate lead name (Bengaluru/Bangalore, Kolkata/Calcutta, Mumbai/Bombay,
 * Gurugram/Gurgaon, Puducherry/Pondicherry …), and those are among the highest
 * traffic cities we serve.
 *
 * The ladder is exact → prefix → $text-with-token-verification, taking ALL
 * matches at the first stage that produces any. $text is RECALL ONLY: its
 * relevance score is unusable as confidence here (measured on this collection:
 * six "Santa Maria" rows all score exactly 1.5, and for "delhi" the compound
 * row "New Delhi / Delhi, DELHI" scores 1.53 — ABOVE Canada's exact "Delhi" at
 * 1.10 — because textScore rewards term repetition). Precision comes from
 * whole-word token verification in JS, applied to what the index returned.
 *
 * Same hybrid shape as searchLocalCatalog in routes/sbt.hotels.ts, which has
 * served the SBT autocomplete against these two indexes for a while. This is
 * that pattern brought to the concierge, plus an ambiguity guard it does not
 * need (autocomplete SHOWS a list; a chat turn has to pick one or ask).
 * ────────────────────────────────────────────────────────────────────────── */

/** A catalog row plus the fields the ranker needs. */
interface CatalogRow {
  code: string;
  name: string;
  countryCode: string;
  searchName: string;
}

function toRow(r: any): CatalogRow | null {
  if (!r?.code || !r?.countryCode) return null;
  return {
    code: String(r.code),
    name: String(r.name ?? ""),
    countryCode: String(r.countryCode),
    searchName: String(r.searchName ?? ""),
  };
}

/** "abbotsford british columbia" → ["abbotsford","british","columbia"] */
function tokensOf(key: string): string[] {
  return key.split(" ").filter(Boolean);
}

/**
 * The NAMES a row actually goes by, normalised.
 *
 * TBO packs the city part before the first comma and separates alternates with
 * a slash: "Vizag/Visakhapatnam,   Andhra Pradesh" → ["vizag","visakhapatnam"].
 * "New Delhi / Delhi,   DELHI" → ["new delhi","delhi"]. A row with no comma and
 * no slash yields its single name. This is what makes "is this row THIS city?"
 * a precise question rather than a substring guess.
 */
export function cityNameVariants(rawName: string): string[] {
  const cityPart = String(rawName || "").split(",")[0];
  return cityPart
    .split("/")
    .map((v) => normalizeSearch(v))
    .filter(Boolean);
}

/**
 * The name to SHOW for a row, given the name that matched it.
 *
 * A compound row's tidied name is the whole alternate pair — "Hotels in
 * Vizag/Visakhapatnam" is not something a person would write. When the query
 * matched one specific variant, show THAT variant: asking for Visakhapatnam
 * gets "Hotels in Visakhapatnam", asking for Vizag gets "Hotels in Vizag".
 * Presentation only; the cityCode we search with is untouched either way.
 *
 * Falls back to the tidied full name when nothing matched a single variant, so
 * a non-compound row behaves exactly as before.
 */
export function displayNameFor(rawName: string, key: string): string {
  const normKey = normalizeSearch(key);
  const cityPart = String(rawName || "").split(",")[0];
  for (const segment of cityPart.split("/")) {
    if (normalizeSearch(segment) === normKey) {
      const shown = segment.replace(/\s+/g, " ").trim();
      if (shown) return shown;
    }
  }
  return tidyCatalogCityName(rawName);
}

/** The qualifier after the comma — "Illinois", "Andhra Pradesh". For display. */
export function regionOf(rawName: string): string | undefined {
  const parts = String(rawName || "").split(",");
  if (parts.length < 2) return undefined;
  const region = parts.slice(1).join(",").replace(/\s+/g, " ").trim();
  return region || undefined;
}

/** Every query token present as a WHOLE WORD in the row's searchName. */
function verifyTokens(row: CatalogRow, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return false;
  const rowTokens = new Set(tokensOf(row.searchName));
  return queryTokens.every((t) => rowTokens.has(t));
}

/**
 * Stage 1: every catalog row that genuinely matches `key`, from the first
 * stage of the ladder that yields anything. Empty array when nothing matches.
 */
export async function findCatalogMatches(name: string): Promise<CatalogRow[]> {
  const key = normalizeSearch(name);
  if (!key) return [];

  // No live connection → do NOT issue the query. Mongoose would buffer it for
  // its 10s default and the chat turn would hang behind a database that is not
  // there, which is a far worse answer than the honest handoff this returns.
  if (mongoose.connection?.readyState !== 1) return [];

  const queryTokens = tokensOf(key);
  const sel = "code name countryCode searchName";

  try {
    // 1+2. EXACT ∪ PREFIX RANGE, as ONE stage.
    //
    //   They must not be sequential. The range {$gte: key, $lt: key+￿}
    //   already CONTAINS the exact row, so returning early on an exact hit
    //   throws away every same-named city that carries a qualifier: "Springfield"
    //   matched the bare NZ row and never saw Springfield Illinois / Missouri /
    //   Massachusetts / Ohio, so an ambiguous name looked confident. Unioning
    //   them is what lets the guard below see the real field of candidates.
    //
    //   The exact query is still issued alongside rather than trusting the range
    //   alone: the range is capped at CANDIDATE_POOL and unsorted, so on a very
    //   common prefix the exact row is not guaranteed to be inside the cap.
    //
    //   find(), not findOne(): six rows share searchName "santa maria", and
    //   findOne returned an arbitrary one of them — a live silent-wrong-city
    //   bug. Duplicates now reach the ambiguity guard.
    const [exact, prefixed] = await Promise.all([
      (TBOCity as any).find({ searchName: key }).select(sel).limit(CANDIDATE_POOL).lean(),
      (TBOCity as any)
        .find({ searchName: { $gte: key, $lt: key + "￿" } })
        .select(sel)
        .limit(CANDIDATE_POOL)
        .lean(),
    ]);
    const byCode = new Map<string, CatalogRow>();
    for (const r of [...(exact || []), ...(prefixed || [])]) {
      const row = toRow(r);
      if (row) byCode.set(row.code, row);
    }
    if (byCode.size) return [...byCode.values()];

    // 3. $text RECALL, then token VERIFY.
    //    Phrase-quoted when the query is multi-word: unquoted, Mongo ORs the
    //    terms, so "santa maria" returns 237 rows (anything with "santa" OR
    //    "maria") against 43 for the phrase. The quote is the difference
    //    between a recall net and a dragnet.
    const search = queryTokens.length > 1 ? `"${key}"` : key;
    const texted = await (TBOCity as any)
      .find({ $text: { $search: search } })
      .select(sel)
      .limit(CANDIDATE_POOL)
      .lean()
      .catch(() => [] as any[]);
    const textRows = (Array.isArray(texted) ? texted : [])
      .map(toRow)
      .filter(Boolean)
      .filter((r) => verifyTokens(r as CatalogRow, queryTokens)) as CatalogRow[];
    if (textRows.length) return textRows;
  } catch {
    // A catalog outage must not turn into a fabricated city. Fall through to
    // empty and let the caller hand off honestly.
  }
  return [];
}

/** Bookable-hotel count per cityCode — the same signal findPrimaryCityForCountry trusts. */
async function inventoryByCityCode(codes: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!codes.length || mongoose.connection?.readyState !== 1) return out;
  try {
    const rows = await (TBOHotelMaster as any).aggregate([
      { $match: { cityCode: { $in: codes } } },
      { $group: { _id: "$cityCode", n: { $sum: 1 } } },
    ]);
    for (const r of rows || []) out.set(String(r._id), Number(r.n) || 0);
  } catch {
    /* no inventory signal — the caller then treats it as "cannot separate". */
  }
  return out;
}

export type CatalogPick =
  | { kind: "ONE"; city: CatalogCity }
  | { kind: "MANY"; candidates: AmbiguousCity[] }
  | { kind: "NONE" };

/**
 * Stage 1b: turn the matched rows into a decision.
 *
 * The tie-breaks are ordered by how much EVIDENCE they carry, and the ladder
 * deliberately stops before the cosmetic ones. Sorting by "shortest name" or
 * alphabetically will always produce a unique winner, which is exactly how the
 * old code picked the wrong Springfield without ever admitting a choice was
 * made. Those are presentation orderings, not evidence, so here they only order
 * the QUESTION — they never answer it.
 */
export async function pickCatalogCity(
  rows: CatalogRow[],
  key: string,
  opts: { curatedCountry?: string | null } = {},
): Promise<CatalogPick> {
  if (!rows.length) return { kind: "NONE" };

  const normKey = normalizeSearch(key);

  // EVIDENCE 1 — the row IS this city: one of its own names equals the query.
  // "Springfield, Illinois" qualifies for "springfield"; "East Springfield"
  // does not, which is the whole point of matching on variants rather than
  // on substrings.
  const named = rows.filter((r) => cityNameVariants(r.name).includes(normKey));
  let candidates = named.length ? named : rows;

  // EVIDENCE 2 — the hand-verified curated table already told us the country.
  if (opts.curatedCountry) {
    const inCountry = candidates.filter(
      (r) => r.countryCode.toUpperCase() === String(opts.curatedCountry).toUpperCase(),
    );
    if (inCountry.length) candidates = inCountry;
  }

  const asCity = (r: CatalogRow): CatalogCity => ({
    code: r.code,
    name: displayNameFor(r.name, normKey),
    countryCode: r.countryCode,
  });

  if (candidates.length === 1) return { kind: "ONE", city: asCity(candidates[0]) };

  // EVIDENCE 3 — bookability. If exactly one candidate actually has hotels,
  // the others are not real alternatives and asking about them is noise.
  const inv = await inventoryByCityCode(candidates.map((r) => r.code));
  if (inv.size) {
    const withInventory = candidates.filter((r) => (inv.get(r.code) ?? 0) > 0);
    if (withInventory.length === 1) return { kind: "ONE", city: asCity(withInventory[0]) };
    if (withInventory.length > 1) candidates = withInventory;
  }

  // Genuinely several real cities. Ask. Order the OPTIONS by inventory (the
  // likeliest intent first) then by name length, purely so the list reads well.
  const ordered = [...candidates].sort((a, b) => {
    const ia = inv.get(a.code) ?? 0;
    const ib = inv.get(b.code) ?? 0;
    if (ia !== ib) return ib - ia;
    if (a.searchName.length !== b.searchName.length) return a.searchName.length - b.searchName.length;
    return a.searchName.localeCompare(b.searchName);
  });

  return {
    kind: "MANY",
    candidates: ordered.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((r) => ({
      cityName: tidyCatalogCityName(r.name),
      countryCode: r.countryCode,
      cityCode: r.code,
      region: regionOf(r.name),
    })),
  };
}

/**
 * Back-compat single-city lookup. Returns the confident match only — an
 * ambiguous name yields null here, so any caller that has not been taught about
 * AMBIGUOUS degrades to "not found" rather than to a coin flip.
 */
export async function findCatalogCity(name: string): Promise<CatalogCity | null> {
  const rows = await findCatalogMatches(name);
  const pick = await pickCatalogCity(rows, name);
  return pick.kind === "ONE" ? pick.city : null;
}

/* Country lookups are static reference data refreshed by a daily job, so both
 * are memoised for the process. A country-only turn is rare; the aggregate
 * behind findPrimaryCityForCountry should not run twice for it. */
const countryCache = new Map<string, { code: string; name: string } | null>();
const primaryCityCache = new Map<string, CatalogCity | null>();

/** "Qatar" → { code: "QA" }. Name only — no ISO guessing, no abbreviations. */
export async function findCountryByName(
  name: string,
): Promise<{ code: string; name: string } | null> {
  const key = normalizeSearch(name);
  if (!key) return null;
  if (countryCache.has(key)) return countryCache.get(key) ?? null;
  if (mongoose.connection?.readyState !== 1) return null;
  try {
    const row = await (TBOCountry as any)
      .findOne({ searchName: key })
      .select("code name")
      .lean();
    const hit = row?.code ? { code: String(row.code), name: String(row.name) } : null;
    countryCache.set(key, hit);
    return hit;
  } catch {
    return null;
  }
}

/**
 * A country's main city, ranked by HOW MANY BOOKABLE HOTELS the catalog holds
 * there.
 *
 * Deliberately not "the capital": capital-ness is not in this data and would
 * have to come from a new dependency, and it is the wrong question anyway — we
 * are choosing where a hotel search will actually find inventory. The signal is
 * emphatic where it matters (QA: Doha 296 and nothing else; TH: Bangkok 5,232
 * vs 2; AE: Dubai 4,905 vs Abu Dhabi 341), so this is a ranking, not a guess.
 * Null when the country has no cities carrying hotels, and then the caller
 * hands off honestly rather than inventing a destination.
 */
export async function findPrimaryCityForCountry(
  countryCode: string,
): Promise<CatalogCity | null> {
  const cc = String(countryCode || "").trim().toUpperCase();
  if (!cc) return null;
  if (primaryCityCache.has(cc)) return primaryCityCache.get(cc) ?? null;
  if (mongoose.connection?.readyState !== 1) return null;
  try {
    const top = await (TBOHotelMaster as any).aggregate([
      { $match: { countryCode: cc } },
      { $group: { _id: "$cityCode", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ]);
    const cityCode = top?.[0]?._id ? String(top[0]._id) : null;
    if (!cityCode) {
      primaryCityCache.set(cc, null);
      return null;
    }
    const city = await (TBOCity as any).findOne({ code: cityCode }).select("code name").lean();
    const hit = city?.code
      ? { code: String(city.code), name: tidyCatalogCityName(String(city.name)), countryCode: cc }
      : null;
    primaryCityCache.set(cc, hit);
    return hit;
  } catch {
    return null;
  }
}

/**
 * The decision, with every lookup already done. PURE, so the split is
 * testable without a database.
 *
 * `named` is what the user actually typed (null when they named nothing), and
 * it is what decides UNSUPPORTED vs NO_CITY. Note the precedence: a place named
 * in THIS prompt outranks `lockedName`. Without that, a locked "Dubai" from an
 * earlier turn would answer a London request with Dubai hotels — silently the
 * wrong city, which is worse than either failure this module is fixing.
 */
export function classifyHotelDestination(input: {
  /** extractHotelCity — the curated table's canonical city, when it knows one. */
  tableCity: string | null;
  /** The raw place the user named, and whether they capitalised it. */
  named: { raw: string; capitalised: boolean } | null;
  /** The catalog row for whichever name we looked up, when there was one. */
  catalog: CatalogCity | null;
  /** Country for `tableCity`, when the curated table knows it. */
  tableCountry: string | null;
  /** CityCode for `tableCity` + `tableCountry`, when resolvable. */
  tableCityCode: string | null;
  /** locked.destination.name carried in from earlier turns. */
  lockedName: string | null;
  /** The country the user named, when they named one rather than a city. */
  country?: { code: string; name: string } | null;
  /** That country's main city by hotel inventory. */
  countryPrimaryCity?: CatalogCity | null;
  /** Several real cities matched and nothing separated them. */
  ambiguous?: { query: string; candidates: AmbiguousCity[] } | null;
}): HotelDestination {
  // 0. SEVERAL REAL CITIES. Answered first, deliberately: every branch below
  //    settles on ONE destination, and a name that matched six equally-real
  //    cities must never be settled — not by the curated table, not by the
  //    catalog, and above all not by a locked value from an earlier turn.
  if (input.ambiguous && input.ambiguous.candidates.length > 1) {
    return {
      status: "AMBIGUOUS",
      query: input.ambiguous.query,
      candidates: input.ambiguous.candidates,
    };
  }

  // 1. The curated table knows this city and it prices — the Dubai path.
  if (input.tableCity && input.tableCountry && input.tableCityCode) {
    return {
      status: "RESOLVED",
      cityName: input.tableCity,
      countryCode: input.tableCountry,
      cityCode: input.tableCityCode,
    };
  }

  // 2. The catalog knows it — London/Tokyo/Paris and ~54k others.
  if (input.catalog) {
    return {
      status: "RESOLVED",
      cityName: input.catalog.name,
      countryCode: input.catalog.countryCode,
      cityCode: input.catalog.code,
    };
  }

  // 3. A COUNTRY was named, not a city. Resolve it to where the inventory
  //    actually is and make the caller disclose the substitution.
  if (input.country && input.countryPrimaryCity) {
    return {
      status: "RESOLVED",
      cityName: input.countryPrimaryCity.name,
      countryCode: input.countryPrimaryCity.countryCode || input.country.code,
      cityCode: input.countryPrimaryCity.code,
      viaCountry: input.country.name,
    };
  }
  // A country we carry no hotels for is a dead end, named honestly.
  if (input.country) {
    return { status: "UNSUPPORTED", cityName: input.country.name };
  }

  // 4. Named, but in NO source — not a city, not a country.
  //
  // UNSUPPORTED regardless of capitalisation. This used to fall through to
  // NO_CITY for a lower-case word, and NO_CITY sends the turn to the model,
  // which reads locked.destination and answers about THAT city — "can you
  // confirm the hotels in qatar" came back as a page of Dubai hotels, an
  // itinerary included. A confidently wrong place is the worst output this lane
  // can produce, so once a place has been named, the turn is answered here and
  // never handed to a model holding a stale destination.
  if (input.named) {
    return { status: "UNSUPPORTED", cityName: input.named.raw };
  }

  // 4. Nothing named this turn. A destination locked earlier still counts, but
  //    only here — never ahead of something the user just said.
  if (input.tableCity || input.lockedName) {
    return { status: "UNSUPPORTED", cityName: (input.tableCity || input.lockedName) as string };
  }

  return { status: "NO_CITY" };
}

/**
 * Full resolution for a hotel-led turn: curated table → global catalog →
 * honest UNSUPPORTED / NO_CITY. Never invents a destination.
 */
export async function resolveHotelDestination(
  prompt: string,
  locked: any,
): Promise<HotelDestination> {
  const tableCity = extractHotelCity(prompt);
  const named = extractNamedPlaceCandidate(prompt);
  const lockedName = locked?.destination?.name ? String(locked.destination.name) : null;

  /* STAGE 0 — CANDIDATE KEYS, not one string.
   *
   * This is the other half of the Vizag bug, and it is an ORDERING bug rather
   * than a matching one. extractHotelCity runs the curated destinationLookup
   * first, which canonicalises "Vizag" → "Visakhapatnam" and DISCARDS the token
   * the user typed. The catalog row leads with "vizag", so the raw token would
   * have matched on the old prefix query — the curation is what broke it.
   *
   * So the catalog now gets an ordered, deduped SET of keys. The curated table
   * keeps every bit of its authority over the display NAME and the COUNTRY
   * (it is hand-checked, and branch 1 of classify still prefers it); it simply
   * stops being the only key we are allowed to look up.
   *
   * Order matters: a place named THIS turn outranks the locked destination, or
   * a request for somewhere new gets answered with the city the conversation
   * happens to be holding. */
  const candidateKeys = [tableCity, named?.raw ?? null, lockedName]
    .map((k) => (k ? String(k).trim() : ""))
    .filter(Boolean)
    .filter((k, i, arr) => arr.findIndex((o) => normalizeSearch(o) === normalizeSearch(k)) === i);

  // The curated country, when the table knows it — used to break ties between
  // same-named cities before we ever consider asking.
  const curatedCountry = tableCity ? countryFor(tableCity) ?? null : null;

  // Deliberately NOT resolveCityCodeForCountry, whose live CityList fallback
  // would put a TBO round-trip on the critical path of every hotel-led turn.
  // `tbocities` already holds 53,943 rows; when a name is not in there, a live
  // call would almost never rescue it.
  let catalog: CatalogCity | null = null;
  let ambiguous: AmbiguousCity[] | null = null;
  let ambiguousQuery = "";

  for (const key of candidateKeys) {
    const rows = await findCatalogMatches(key);
    if (!rows.length) continue;
    const pick = await pickCatalogCity(rows, key, { curatedCountry });
    if (pick.kind === "ONE") {
      catalog = pick.city;
      break;
    }
    if (pick.kind === "MANY") {
      ambiguous = pick.candidates;
      ambiguousQuery = key;
      break;
    }
  }

  /* STAGE 2 — LLM normalize, ONLY on a total miss.
   *
   * $text is not fuzzy, so a misspelling ("Vishakhapatnam") scores zero and no
   * amount of deterministic cleverness recovers it. The model returns a NAME
   * and nothing else; that name goes straight back through the same ladder and
   * is believed only if the catalog confirms it. It can steer which row we look
   * up; it can never invent a bookable destination. */
  if (!catalog && !ambiguous && candidateKeys.length) {
    const normalized = await normalizeCityNameWithLLM(named?.raw || candidateKeys[0]);
    if (normalized) {
      const rows = await findCatalogMatches(normalized);
      if (rows.length) {
        const pick = await pickCatalogCity(rows, normalized, { curatedCountry });
        if (pick.kind === "ONE") catalog = pick.city;
        else if (pick.kind === "MANY") {
          ambiguous = pick.candidates;
          ambiguousQuery = named?.raw || normalized;
        }
      }
    }
  }

  // Nothing matched as a city — is the named place a COUNTRY? ("hotels in
  // qatar": Qatar is not a city anywhere in the catalog, so every city lookup
  // above misses and the turn used to end up at the model.)
  let country: { code: string; name: string } | null = null;
  let countryPrimaryCity: CatalogCity | null = null;
  if (!catalog && !ambiguous && named?.raw) {
    country = await findCountryByName(named.raw);
    if (country) countryPrimaryCity = await findPrimaryCityForCountry(country.code);
  }

  // The curated table stays authoritative for spelling and country when it
  // knows the city; the catalog supplies the code that makes it searchable.
  // The code may now have come from ANY candidate key — for "hotels in Vizag"
  // the curated name is "Visakhapatnam" while the row was found via either
  // token, and the reply still reads with the hand-checked spelling.
  const tableCountry = tableCity ? curatedCountry ?? catalog?.countryCode ?? null : null;
  const tableCityCode = tableCity ? catalog?.code ?? null : null;

  return classifyHotelDestination({
    tableCity,
    named,
    // Consumed only when the curated table did not resolve — otherwise branch 1
    // already answered with the canonical name.
    catalog: tableCity && tableCountry && tableCityCode ? null : catalog,
    tableCountry,
    tableCityCode,
    lockedName,
    country,
    countryPrimaryCity,
    ambiguous: ambiguous
      ? { query: ambiguousQuery || named?.raw || tableCity || "", candidates: ambiguous }
      : null,
  });
}
