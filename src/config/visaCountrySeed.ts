// apps/backend/src/config/visaCountrySeed.ts
//
// THE ALL-COUNTRY VISA SEED — every country an Indian passport can be held
// against (196), independent of which corridors Plumtrips actually serves.
// The public map is drawn from THIS file; `VisaRule` only decides whether the
// CTA says "Apply" or "Request".
//
// ── WHY readFileSync AND NOT AN IMPORT ───────────────────────────────────
// `tsc` does not copy .json. This file reaches the App Runner container ONLY
// because apps/backend/package.json's build script runs
//
//     tsc -p tsconfig.json && cp -r src/data src/fonts dist/
//
// so the JSON is read at RUN time, from `../data` relative to __dirname —
// byte-for-byte the pattern routes/sbt.flights.ts:221-225 (`loadJson()`) uses
// for airports.json, which that copy step already carries into production and
// which the live flight autocomplete proves every day.
//
// `import seed from "../data/visa-country-seed.json" with { type: "json" }`
// would resolve through the module loader instead: fine under tsx and vitest,
// and then either inlined at build time or unresolvable in dist/. That is the
// "works locally, 404s in prod" failure mode, and it is the reason this module
// looks the way it does. Do not convert it to an import.
//
// ── WHY A FAILED SEED DOES NOT CRASH THE SERVER ──────────────────────────
// Validation runs at STARTUP (module evaluation) and is deliberately strict:
// a structurally bad seed is never partially served, never repaired, never
// filtered down to "the good rows". But it throws INTO this module, not out of
// it. Letting it escape would fail server.ts's module graph and take down the
// entire API — every B2B route with it — over a marketing map, and the thing
// most likely to go wrong here is the `cp` step above, i.e. exactly the case
// where the whole container is already suspect. The visa module's 2026-08-14
// deploy was lost to precisely this shape of boot-time crash.
//
// So: refusing to serve IS the assertion. `isSeedReady()` goes false, the two
// public endpoints answer 503, and the rest of the API is untouched.
//
// `reviewNeeded` entries are a different thing entirely — flagged for ops
// review, not invalid — so they warn and serve normally.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import logger from "../utils/logger.js";

const seedLogger = logger.child({ module: "visaCountrySeed" });

/**
 * The six categories the seed is allowed to use.
 *
 * NOT the same list as `VisaRule.VISA_CATEGORIES`. The two lists overlap but
 * neither contains the other, and that is deliberate:
 *
 *   · the seed has no `STAMP` — a distinction the catalogue draws and the
 *     world does not. The map still emits a `STAMP: 0` count so the frontend
 *     Legend's shape does not change; see routes/public.visa.ts.
 *   · the seed HAS `TRAVEL_AUTH` and `RESTRICTED`, which the catalogue does
 *     not, because both describe a corridor we cannot sell a visa for. A
 *     TDAC/ETA is a form, not a visa; a restricted corridor has no route at
 *     all. They exist here because the map's subject is where a passport can
 *     go, not what we happen to process — and drawing Thailand as a visa a
 *     traveller must apply for, when what it actually wants is an arrival
 *     card, would be wrong in the reader's favour, which is still wrong.
 *
 * Added with the v3 seed (2026-08-16): TRAVEL_AUTH (8 members) and RESTRICTED
 * (1). A category added here must also be given a floor in
 * utils/visaDifficulty.ts — `categoryFloorIndex` is exhaustive over this union
 * and will not compile until it is.
 */
export const SEED_VISA_CATEGORIES = [
  "VISA_FREE",
  "E_VISA",
  "VOA",
  "TRAVEL_AUTH",
  "STICKER",
  "RESTRICTED",
] as const;
export type SeedVisaCategory = (typeof SEED_VISA_CATEGORIES)[number];

export interface SeedCountry {
  iso2: string;
  countryName: string;
  visaCategory: SeedVisaCategory;
  /** Conditional/dual-path regimes ops should confirm before launch. */
  reviewNeeded: boolean;
  /**
   * One of `regions.continents`, verbatim. Validated against that list rather
   * than against a continent table of our own — the seed is the authority on
   * where it has placed transcontinental countries (RU/TR/GE/AM/AZ/KZ/CY/EG),
   * and a second opinion in code would silently overrule it.
   */
  continent: string;
  /**
   * Curated visa-grouping membership (SCHENGEN / GCC / ASEAN), verbatim from
   * the seed. Empty for most countries. NOT derived from the continent.
   */
  groups: readonly string[];
  /** Why this country's category is not the whole story. Optional, ops copy. */
  categoryNote?: string;
}

/** A named visa grouping — one entry of the seed's `regions.groups`. */
export interface SeedRegionGroup {
  /** The seed's own key: SCHENGEN / GCC / ASEAN. */
  key: string;
  label: string;
  members: readonly string[];
  note: string;
}

/**
 * The seed's `regions` block: the continent vocabulary and the curated
 * groupings, both used by the public map's region rail to fit and filter.
 *
 * It lives in the seed and not in the frontend for the same reason the
 * country list does: a hardcoded "these are the Schengen 29" in a React file
 * is a second source of truth that starts drifting the day a country joins.
 */
export interface SeedRegions {
  continents: readonly string[];
  groups: readonly SeedRegionGroup[];
}

/** Provenance, surfaced verbatim on both public endpoints. Never restated in code. */
export interface SeedMeta {
  nationality: string;
  source: string;
  sourceUrl: string;
  lastVerified: string;
  disclaimer: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(__dirname, "../data/visa-country-seed.json");

let meta: SeedMeta | null = null;
let countries: readonly SeedCountry[] = [];
let byIso2: ReadonlyMap<string, SeedCountry> = new Map();
let regions: SeedRegions | null = null;
let failure: string | null = null;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing or not a non-empty string`);
  }
  return value.trim();
}

/**
 * The `regions` block, parsed before the countries are — because a country's
 * `continent` and `groups` are validated AGAINST it, and a vocabulary that
 * arrives after the words it defines cannot check them.
 */
function parseRegions(raw: any): SeedRegions {
  const continents = raw?.regions?.continents;
  if (!Array.isArray(continents) || continents.length === 0) {
    throw new Error("seed has no `regions.continents` array");
  }
  for (const [i, c] of continents.entries()) {
    if (typeof c !== "string" || !c.trim()) {
      throw new Error(`regions.continents[${i}] is not a non-empty string`);
    }
  }

  const rawGroups = raw?.regions?.groups;
  if (!rawGroups || typeof rawGroups !== "object" || Array.isArray(rawGroups)) {
    throw new Error("seed has no `regions.groups` object");
  }

  const groups: SeedRegionGroup[] = [];
  for (const [key, value] of Object.entries(rawGroups as Record<string, any>)) {
    const at = `regions.groups.${key}`;
    if (!Array.isArray(value?.members) || value.members.length === 0) {
      throw new Error(`${at}.members is missing or empty`);
    }
    const members = value.members.map((m: unknown, i: number) => {
      if (typeof m !== "string" || !/^[A-Z]{2}$/.test(m.trim().toUpperCase())) {
        throw new Error(`${at}.members[${i}] "${String(m)}" is not ISO 3166-1 alpha-2`);
      }
      return m.trim().toUpperCase();
    });
    groups.push({
      key,
      label: requireString(value?.label, `${at}.label`),
      members: Object.freeze(members),
      // A note is editorial and may be blank; the other three may not.
      note: typeof value?.note === "string" ? value.note.trim() : "",
    });
  }

  return {
    continents: Object.freeze(continents.map((c: string) => c.trim())),
    groups: Object.freeze(groups),
  };
}

function load(): void {
  const raw = JSON.parse(readFileSync(SEED_FILE, "utf-8"));

  if (!Array.isArray(raw?.countries) || raw.countries.length === 0) {
    throw new Error("seed has no `countries` array");
  }

  const parsedRegions = parseRegions(raw);
  const knownContinents = new Set(parsedRegions.continents);
  const knownGroups = new Set(parsedRegions.groups.map((g) => g.key));

  // Every entry is checked before ANY entry is accepted — a half-valid seed
  // draws a half-wrong map, which is worse than drawing none.
  const problems: string[] = [];
  const parsed: SeedCountry[] = [];
  const seen = new Set<string>();

  for (const [i, entry] of (raw.countries as unknown[]).entries()) {
    const at = `countries[${i}]`;
    const e = entry as Record<string, unknown>;
    const iso2 = typeof e?.iso2 === "string" ? e.iso2.trim().toUpperCase() : "";
    const countryName = typeof e?.countryName === "string" ? e.countryName.trim() : "";
    const visaCategory = e?.visaCategory as SeedVisaCategory;
    const continent = typeof e?.continent === "string" ? e.continent.trim() : "";
    const rawGroups = Array.isArray(e?.groups) ? (e.groups as unknown[]) : [];

    if (!/^[A-Z]{2}$/.test(iso2)) problems.push(`${at}: iso2 "${String(e?.iso2)}" is not ISO 3166-1 alpha-2`);
    if (!countryName) problems.push(`${at} (${iso2}): countryName is missing`);
    if (!SEED_VISA_CATEGORIES.includes(visaCategory)) {
      problems.push(`${at} (${iso2}): visaCategory "${String(visaCategory)}" is not one of ${SEED_VISA_CATEGORIES.join("/")}`);
    }
    // A country with no continent is a country the region rail cannot place,
    // and a rail that silently drops one is the bug this check exists for.
    if (!knownContinents.has(continent)) {
      problems.push(
        `${at} (${iso2}): continent "${String(e?.continent)}" is not one of regions.continents (${parsedRegions.continents.join("/")})`,
      );
    }
    const groups: string[] = [];
    for (const [gi, g] of rawGroups.entries()) {
      const key = typeof g === "string" ? g.trim().toUpperCase() : "";
      if (!knownGroups.has(key)) {
        problems.push(`${at} (${iso2}): groups[${gi}] "${String(g)}" is not a key of regions.groups`);
        continue;
      }
      groups.push(key);
    }
    if (iso2 && seen.has(iso2)) problems.push(`${at}: duplicate iso2 ${iso2}`);
    seen.add(iso2);

    parsed.push({
      iso2,
      countryName,
      visaCategory,
      reviewNeeded: e?.reviewNeeded === true,
      continent,
      groups: Object.freeze(groups),
      ...(typeof e?.categoryNote === "string" && e.categoryNote.trim()
        ? { categoryNote: e.categoryNote.trim() }
        : {}),
    });
  }

  /* The membership lists are the OTHER half of the same fact, and the two
   * halves are allowed to disagree in the file. They must not disagree in
   * memory: "Schengen" as the rail computes it (countries carrying the group)
   * and "Schengen" as regions.groups lists it have to be the same 29, or the
   * count under the button contradicts the countries lit on the map. */
  const byGroupFromCountries = new Map<string, Set<string>>();
  for (const c of parsed) {
    for (const g of c.groups) {
      if (!byGroupFromCountries.has(g)) byGroupFromCountries.set(g, new Set());
      byGroupFromCountries.get(g)!.add(c.iso2);
    }
  }
  for (const group of parsedRegions.groups) {
    const fromCountries = byGroupFromCountries.get(group.key) ?? new Set<string>();
    const missing = group.members.filter((m) => !fromCountries.has(m));
    const extra = [...fromCountries].filter((m) => !group.members.includes(m));
    if (missing.length || extra.length) {
      problems.push(
        `regions.groups.${group.key}: membership disagrees with the countries carrying it` +
          (missing.length ? ` — listed but not tagged: ${missing.join(",")}` : "") +
          (extra.length ? ` — tagged but not listed: ${extra.join(",")}` : ""),
      );
    }
  }

  if (problems.length) {
    throw new Error(`${problems.length} invalid entr${problems.length === 1 ? "y" : "ies"}: ${problems.join("; ")}`);
  }

  meta = {
    nationality: requireString(raw.nationality, "nationality"),
    source: requireString(raw.source, "source"),
    sourceUrl: requireString(raw.sourceUrl, "sourceUrl"),
    lastVerified: requireString(raw.lastVerified, "lastVerified"),
    disclaimer: requireString(raw.disclaimer, "disclaimer"),
  };
  countries = Object.freeze(parsed);
  byIso2 = new Map(parsed.map((c) => [c.iso2, c]));
  regions = parsedRegions;

  // NOT a failure. A flagged entry is a real country with a real category that
  // ops wants to look at again before launch — it is served like any other.
  const flagged = parsed.filter((c) => c.reviewNeeded);
  if (flagged.length) {
    seedLogger.warn("visa country seed — entries still flagged reviewNeeded", {
      count: flagged.length,
      iso2s: flagged.map((c) => c.iso2),
    });
  }

  seedLogger.info("visa country seed loaded", {
    countries: parsed.length,
    lastVerified: meta.lastVerified,
    reviewNeeded: flagged.length,
    continents: parsedRegions.continents.length,
    groups: parsedRegions.groups.map((g) => `${g.key}:${g.members.length}`),
  });
}

try {
  load();
} catch (err: any) {
  failure = err?.message ?? String(err);
  // Loud, immediate, and contained. See the header: this must not escape.
  seedLogger.error("visa country seed FAILED to load — the public visa endpoints will answer 503", {
    file: SEED_FILE,
    error: failure,
  });
}

/** False when the seed could not be loaded or validated. Endpoints must 503. */
export function isSeedReady(): boolean {
  return failure === null;
}

/** Why the seed failed, for logging. Null when healthy. */
export function seedFailureReason(): string | null {
  return failure;
}

export function getSeedMeta(): SeedMeta {
  if (!meta) throw new Error(`visa country seed unavailable: ${failure}`);
  return meta;
}

export function listSeedCountries(): readonly SeedCountry[] {
  return countries;
}

/** The continent vocabulary and the curated groupings. Throws when unhealthy. */
export function getSeedRegions(): SeedRegions {
  if (!regions) throw new Error(`visa country seed unavailable: ${failure}`);
  return regions;
}

export function findSeedCountry(iso2: string | null | undefined): SeedCountry | undefined {
  if (!iso2) return undefined;
  return byIso2.get(iso2.trim().toUpperCase());
}
