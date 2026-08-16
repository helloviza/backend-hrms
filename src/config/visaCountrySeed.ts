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
 * The four categories the seed is allowed to use.
 *
 * NOT the same list as `VisaRule.VISA_CATEGORIES`, which has five — the seed
 * has no `STAMP` member. The map still emits a `STAMP: 0` count so the
 * frontend Legend's shape does not change; see routes/public.visa.ts.
 */
export const SEED_VISA_CATEGORIES = ["VISA_FREE", "E_VISA", "VOA", "STICKER"] as const;
export type SeedVisaCategory = (typeof SEED_VISA_CATEGORIES)[number];

export interface SeedCountry {
  iso2: string;
  countryName: string;
  visaCategory: SeedVisaCategory;
  /** Conditional/dual-path regimes ops should confirm before launch. */
  reviewNeeded: boolean;
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
let failure: string | null = null;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing or not a non-empty string`);
  }
  return value.trim();
}

function load(): void {
  const raw = JSON.parse(readFileSync(SEED_FILE, "utf-8"));

  if (!Array.isArray(raw?.countries) || raw.countries.length === 0) {
    throw new Error("seed has no `countries` array");
  }

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

    if (!/^[A-Z]{2}$/.test(iso2)) problems.push(`${at}: iso2 "${String(e?.iso2)}" is not ISO 3166-1 alpha-2`);
    if (!countryName) problems.push(`${at} (${iso2}): countryName is missing`);
    if (!SEED_VISA_CATEGORIES.includes(visaCategory)) {
      problems.push(`${at} (${iso2}): visaCategory "${String(visaCategory)}" is not one of ${SEED_VISA_CATEGORIES.join("/")}`);
    }
    if (iso2 && seen.has(iso2)) problems.push(`${at}: duplicate iso2 ${iso2}`);
    seen.add(iso2);

    parsed.push({ iso2, countryName, visaCategory, reviewNeeded: e?.reviewNeeded === true });
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

export function findSeedCountry(iso2: string | null | undefined): SeedCountry | undefined {
  if (!iso2) return undefined;
  return byIso2.get(iso2.trim().toUpperCase());
}
