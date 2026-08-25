// apps/backend/src/utils/visaDifficulty.ts
//
// TWO PURE FUNCTIONS: how hard a visa is, and how often the destination says
// yes to Indian applicants. Both derive from named constants in this file and
// nothing else — no database, no clock, no request. Same inputs, same answer,
// forever.
//
// ── THE HONESTY RULES THIS FILE EXISTS TO ENFORCE ────────────────────────
// 1. `difficulty` is HELLOVIZA'S ASSESSMENT, never a statistic. It returns a
//    band. It must never return, imply, or be rendered as a percentage.
// 2. `approvalChances` is THE COUNTRY'S HISTORICAL RATE for Indian applicants,
//    never a personal prediction. "~78% of Indian applicants were approved" is
//    a fact about the US State Department. "You have a 78% chance" is a lie
//    about a person we know nothing about. The strings here are written so the
//    second reading is not available.
// 3. A NUMBER MAY ONLY COME FROM `SOURCED_APPROVAL`, which is built from one
//    dataset and nothing else. There is no default numeric branch, no
//    interpolation, no per-country estimate invented here.
//
//    This rule USED to end "...and every entry carries its citation in the
//    same object". It no longer can: the dataset is aggregated from many
//    public sources — government portals, EU visa statistics, and modelled
//    estimates where neither exists — so no single publisher can be named
//    for any one number, and attaching a per-country credit would be a
//    fabrication of exactly the kind this rule exists to stop.
//
//    The guarantee moved to the surface instead. Every figure is shown
//    beside APPROVAL_ESTIMATE_DISCLAIMER, which says plainly what the
//    numbers are, and the frontend renders the two from one component so
//    they cannot come apart. "No number without its citation" became "no
//    number without that sentence on the same surface".
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SeedVisaCategory } from "../config/visaCountrySeed.js";

/** Ordered easiest → hardest. The index IS the band arithmetic. */
export const DIFFICULTY_BANDS = ["Easy", "Moderate", "Hard", "Very Hard"] as const;
export type DifficultyBand = (typeof DIFFICULTY_BANDS)[number];

/**
 * The Schengen area, enumerated rather than derived. 29 members, including
 * Bulgaria and Romania (full accession 2025-01-01).
 *
 * `CY` and `IE` are EU but NOT Schengen and are deliberately absent — an
 * Irish visa is its own application with its own rate, and giving it the
 * Schengen figure would be exactly the fabrication this file forbids.
 */
export const SCHENGEN_MEMBERS: readonly string[] = [
  "AT", "BE", "BG", "HR", "CZ", "DK", "EE", "FI", "FR", "DE",
  "GR", "HU", "IS", "IT", "LV", "LI", "LT", "LU", "MT", "NL",
  "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "CH",
];

/**
 * Destinations that fingerprint or interview Indian applicants in person.
 *
 * ⚠ READ BEFORE ADDING: this set does NOT escalate a country that is already
 * at the STICKER floor — see `difficultyFor`. The seed's own legend defines
 * STICKER as "apply in advance, usually in person", so biometrics is already
 * priced into that floor and counting it twice would put the UK (our single
 * highest sourced approval rate, ~93%) in the same band as the US at ~78%.
 *
 * Consequence, stated so nobody "fixes" it by accident: every member below is
 * STICKER in today's seed, so this constant currently escalates NOTHING. It is
 * kept because it is the correct place to record the fact, it is tested as a
 * pure rule, and it starts biting the moment a biometrics-requiring E_VISA or
 * VOA destination is added here (Australia is the likely first — flagged
 * reviewNeeded in the seed today).
 */
export const KNOWN_BIOMETRIC_OR_INTERVIEW: readonly string[] = ["US", "CN", "GB", ...SCHENGEN_MEMBERS];

/**
 * Destinations whose process is materially harder than their category implies,
 * for reasons no refusal rate we hold captures — appointment scarcity,
 * mandatory interview, documentary depth.
 *
 * CN is here and deliberately NOT in SOURCED_APPROVAL: we hold no sourced
 * Chinese approval rate. It is therefore "Very Hard" AND "Varies by profile"
 * at the same time. Difficulty and approval are independent and are allowed to
 * disagree; inventing a Chinese percentage to make them agree is the failure
 * this file is built to prevent.
 */
export const KNOWN_HIGH_FRICTION: readonly string[] = ["US", "CN"];



/**
 * The period the figures describe, rendered into the label's scope tag.
 *
 * KEPT deliberately while the citation machinery was removed. "(India,
 * 2026)" is not a credit — it is the two things a reader needs to read the
 * number correctly: whose applications it counts, and when. Both are true
 * of the dataset regardless of which source any single row came from.
 */
export const FIGURES_YEAR = "2026";

export interface SourcedApproval {
  /** Rendered verbatim as `approvalChances`. Carries its own scope. */
  label: string;
  /**
   * `100 - y2026`, from the REAL figure (never the clamped one).
   *
   * Derived metadata only. It drove a >20% difficulty escalation until the
   * approval data was made display-only; difficultyFor no longer reads it.
   */
  refusalRatePct: number;
  /**
   * The three readings the surfaces render, as integer percentages.
   *
   * `label` above is DERIVED from `y2026` and kept only so anything still
   * reading a single string keeps working — see buildSourcedApproval. This
   * object is the canonical shape.
   */
  figures: ApprovalFigures;
}

/**
 * THE DISPLAY CLAMP. 1–99, and it is a rendering decision, not a data one.
 *
 * ── WHY ─────────────────────────────────────────────────────────────
 * A card asserting a flat 100% is the least credible thing this feature can
 * print. It reads as "guaranteed", which is precisely the claim rule 2 of
 * this file forbids — no aggregate over real applications is ever exactly
 * everyone, and a reader who has been refused once knows that better than
 * we do. 0% has the mirror problem: it reads as "impossible", which for a
 * corridor we list as a destination is a claim we cannot support either.
 *
 * The dataset holds 56 values at 100 and one country at 0 (PS, which is not
 * a map destination). Those stay exactly as they are — this shifts the last
 * point of the scale in the OUTPUT so the surface stops making an absolute
 * claim, and nothing upstream is edited to make it look tidier.
 *
 * ── WHY IT LIVES HERE AND NOT IN THE RENDER COMPONENT ───────────────
 * The obvious home is ApprovalTriplet, where the "~NN%" string is built.
 * But the headline label — "~82% (India, 2026)" — is assembled HERE, at
 * build time, and it must clamp too or a 100% country would show "~99%" on
 * three lines beneath a "~100%" heading.
 *
 * A frontend clamp would therefore mean either two implementations, or the
 * frontend regex-rewriting a percentage out of a string the server sent.
 * Applying it at the one boundary both display paths flow through — the
 * label, and approvalFiguresFor's return — makes inconsistency structurally
 * impossible instead of merely unlikely.
 *
 * SOURCED_APPROVAL.figures keeps the REAL values, so a test or a future
 * consumer that wants the data can still have it.
 */
export function clampDisplayPct(pct: number): number {
  if (pct >= 100) return 99;
  if (pct <= 0) return 1;
  return pct;
}

/** The three figures with the display clamp applied to each, independently. */
function clampFigures(f: ApprovalFigures): ApprovalFigures {
  return {
    avg5: clampDisplayPct(f.avg5),
    avg3: clampDisplayPct(f.avg3),
    y2026: clampDisplayPct(f.y2026),
  };
}

/**
 * Three readings of the same corridor, all India-origin, all integer
 * percentages. Never null here: an entry with no usable 2026 figure is not
 * built at all, so "has an entry" continues to mean "has a number we may
 * print" — rule 3 of this file's header.
 */
export interface ApprovalFigures {
  /** Last 5 years, averaged. */
  avg5: number;
  /** Last 3 years, averaged. */
  avg3: number;
  /** 2026, in progress. The headline the label is derived from. */
  y2026: number;
}

/**
 * THE ONE SENTENCE THAT ACCOMPANIES EVERY APPROVAL FIGURE.
 *
 * ── WHY THIS REPLACED PER-COUNTRY CITATIONS ─────────────────────────
 * Rule 3 of this file's header demanded a citation per number, and while
 * the sourced set was 31 hand-entered countries that was both possible and
 * right. The dataset behind these figures is not that: it is aggregated
 * from many public sources — government portals, the EU visa statistics,
 * and modelled estimates where neither exists — and NO SINGLE PUBLISHER
 * can be named for any one number.
 *
 * The honest response is to say so once, plainly, rather than to attach a
 * fabricated per-country credit to 194 rows. So the machinery that carried
 * `citation` / `sourceName` / `metricType` is gone, and this sentence is
 * what the surfaces show instead.
 *
 * It does two jobs the old wording did not. "Indicative estimates" is the
 * accurate description of a mixed-provenance aggregate — it does not claim
 * to be a published statistic. And the second clause keeps rule 2 intact:
 * the figure is about the corridor, never a prediction about the reader.
 *
 * The invariant moved rather than weakened: it was "no number without its
 * citation", it is now "no number without this disclaimer on the same
 * surface". The frontend enforces it structurally — the component that
 * renders the figures renders this line, so there is no arrangement of
 * props that produces one without the other.
 */
export const APPROVAL_ESTIMATE_DISCLAIMER =
  "Indicative estimates from public sources — actual approval depends on your individual profile.";



/**
 * The dataset behind every number on this surface.
 *
 * ── WHY readFileSync AND NOT AN IMPORT ──────────────────────────────
 * The same reason config/visaCountrySeed.ts spells out at length: `tsc`
 * does not copy .json, and this file reaches the container only via the
 * build script's `cp -r src/data dist/`. An `import … with { type: "json" }`
 * resolves through the module loader instead — fine under tsx and vitest,
 * then inlined or unresolvable in dist/. That is the "works locally, 404s
 * in prod" failure mode. Do not convert it to an import.
 *
 * ── WHY A BAD FILE DOES NOT THROW ───────────────────────────────────
 * This module sits in server.ts's import graph through routes/public.visa.ts.
 * Throwing here would take the whole API down over a marketing map — the
 * exact shape of boot crash the visa module's 2026-08-14 deploy was lost
 * to. Degrading instead is also the SAFE direction for this particular
 * file: with no dataset, every country falls back to "Varies by profile"
 * and no unsourced number can reach a reader.
 */
interface RawApprovalRow {
  name?: unknown;
  avg5?: unknown;
  avg3?: unknown;
  y2026?: unknown;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPROVAL_FILE = path.join(__dirname, "../data/approval_by_iso2.json");

/** Integer percentage in 0..100, or null for anything else. */
function pct(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100 ? v : null;
}

function buildSourcedApproval(): Readonly<Record<string, SourcedApproval>> {
  let raw: Record<string, RawApprovalRow>;
  try {
    raw = JSON.parse(readFileSync(APPROVAL_FILE, "utf-8"));
  } catch (err: any) {
    // Not a console.error loop: one line, at boot, then honest fallbacks.
    console.warn(`[visaDifficulty] approval dataset unreadable — every country will fall back to "Varies by profile": ${err?.message ?? err}`);
    return Object.freeze({});
  }

  const out: Record<string, SourcedApproval> = {};
  for (const [key, row] of Object.entries(raw ?? {})) {
    const iso2 = String(key).toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2)) continue;

    const avg5 = pct(row?.avg5);
    const avg3 = pct(row?.avg3);
    const y2026 = pct(row?.y2026);

    /* ALL THREE OR NONE. India is the case this exists for — it is
     * India-origin data, so India-into-India is not a corridor and its
     * three figures are null. Skipping the row entirely (rather than
     * storing nulls) means `SOURCED_APPROVAL[iso2]` keeps its old meaning
     * — "there is a number here we are allowed to print" — and every
     * consumer's existing null-check keeps working unchanged. */
    if (avg5 === null || avg3 === null || y2026 === null) continue;

    out[iso2] = {
      // Derived, NOT authored: the single-string form is y2026 rendered the
      // way splitApproval() expects (a leading percentage, then a scope
      // tag). Anything still reading one string gets the headline number.
      // CLAMPED, like the three lines beneath it — see clampDisplayPct. The
      // figures object below keeps the real values.
      label: `~${clampDisplayPct(y2026)}% (India, ${FIGURES_YEAR})`,
      // The escalation input. 2026 is the live year, so it is the one that
      // should move a band — see difficultyFor.
      refusalRatePct: 100 - y2026,
      figures: { avg5, avg3, y2026 },
    };
  }
  return Object.freeze(out);
}

/**
 * THE ONLY PLACE A NUMBER MAY LIVE.
 *
 * Built from data/approval_by_iso2.json — 194 countries with figures, plus
 * India carrying nulls and therefore no entry at all.
 *
 * This REPLACED a hand-written 31-entry table (US, GB and the 29 Schengen
 * members, the latter all sharing one EU Commission aggregate labelled
 * "~85% (India, 2024)"). One aggregate standing in for 29 countries is
 * exactly what per-country data removes: Portugal and Germany no longer
 * claim the same rate as each other, and the countries that had no figure
 * at all stop reading "Varies by profile" when a figure exists.
 */
export const SOURCED_APPROVAL: Readonly<Record<string, SourcedApproval>> = buildSourcedApproval();

/**
 * The three figures the surfaces render — or null when this corridor is
 * not showing a number at all.
 *
 * ── IT ASKS THE SAME QUESTION IN THE SAME ORDER AS THE DISPLAY ───────
 * A VISA_FREE country returns "Not required" without consulting its
 * figures, so it can be in the dataset and still be showing a fixed
 * string. Returning figures on "is there a row?" would print "Last 5 Yr
 * Avg ~95%" directly beneath the words "Not required" — three numbers
 * answering a question the reader was just told does not apply.
 *
 * That is the only divergence left. Every other category now shows its
 * figures whenever they exist, so for those this check simply agrees with
 * the display — which is why it is written as the identity test it is,
 * rather than re-deriving the rule and risking the two drifting.
 *
 * So: figures come back only when the string the panel is showing IS the
 * sourced label. If the two ever stop matching this returns null and the
 * surface falls back to the one honest string — the safe direction.
 */
export function approvalFiguresFor(
  iso2: string,
  category: SeedVisaCategory,
): ApprovalFigures | null {
  const sourced = SOURCED_APPROVAL[iso2.toUpperCase()];
  if (!sourced) return null;
  if (approvalChancesFor(iso2, category) !== sourced.label) return null;
  // Clamped HERE rather than in the stored entry, so the data keeps its real
  // values and only what a reader sees is bounded.
  return clampFigures(sourced.figures);
}

/**
 * VISA_FREE/VOA/TRAVEL_AUTH → Easy · E_VISA → Moderate · STICKER → Hard ·
 * RESTRICTED → Very Hard.
 *
 * The two floors added with the v3 seed (2026-08-16), and why they sit where
 * they do. NO EXISTING FLOOR MOVED — the four original categories band exactly
 * as they did before, and visaDifficulty.test.ts still asserts every one.
 *
 *   · TRAVEL_AUTH is EASY, the same floor as visa-free. A TDAC or an ETA is a
 *     form submitted before you fly with no adjudication behind it: nobody
 *     assesses your ties to India, and nobody refuses you for your bank
 *     balance. Banding it with E_VISA would say the two involve the same kind
 *     of work, and they do not. It is one step of friction above nothing,
 *     which the band vocabulary has no room for — and of the two neighbours,
 *     "Easy" is the true one.
 *   · RESTRICTED is VERY HARD, the ceiling, and it is the only category that
 *     starts there. It does not mean a hard visa; it means there is no
 *     ordinary tourist route at all. The band system cannot say that, so it
 *     says the hardest thing it can and the country's own note carries the
 *     rest. This is the honest floor: anything softer would read as "difficult
 *     but doable", which for Pakistan on an Indian passport is not true.
 */
function categoryFloorIndex(category: SeedVisaCategory): number {
  switch (category) {
    case "VISA_FREE":
    case "VOA":
    case "TRAVEL_AUTH":
      return 0; // Easy
    case "E_VISA":
      return 1; // Moderate
    case "STICKER":
      return 2; // Hard
    case "RESTRICTED":
      return 3; // Very Hard
  }
}

const STICKER_FLOOR_INDEX = 2;

/**
 * HELLOVIZA'S ASSESSMENT of how hard this visa is to get, as a band.
 *
 *   1. floor at the category
 *   2. +1 if the destination fingerprints/interviews — but never above the
 *      STICKER floor, which already means "in person" (see the constant)
 *   3. +1 if the destination is known high-friction
 *   4. capped at "Very Hard"
 *
 * ── THE APPROVAL DATA DOES NOT REACH THIS FUNCTION. BY DECISION. ────────
 * Step 3 used to read `SOURCED_APPROVAL[code].refusalRatePct > 20` as well.
 * That term is GONE, and its absence is the point rather than an oversight:
 * the approval figures are DISPLAY-ONLY. A band is Helloviza's assessment
 * of how hard a visa is to obtain (rule 1 in this file's header); wiring a
 * published rate into it silently converts that assessment into a
 * restatement of someone else's statistic, and makes every future data
 * refresh a quiet re-banding of the map.
 *
 * The alternative was tried and measured before it was rejected. Feeding
 * `100 - y2026` into the old term moved 38 countries, all harder — Canada
 * to Very Hard, and 21 of 29 Schengen members, which put Germany and
 * France in different bands off a four-point difference in one year's
 * figure. Fourteen of the 38 turned on 21-22% refusal, i.e. on one or two
 * points either side of the threshold. A band that swings on that is not
 * an assessment.
 *
 * REMOVING THE TERM CHANGES NOTHING versus the hand-written table it
 * replaced, which is why this is a clean revert rather than a third
 * behaviour: at HEAD the only rates were US 22.0, GB 7 and one shared
 * Schengen 15, so `> 20` fired for the US alone — and the US is in
 * KNOWN_HIGH_FRICTION, which escalates it anyway. The term was already
 * doing no work; the dataset is what would have given it teeth.
 *
 * `refusalRatePct` survives on SourcedApproval as `100 - y2026`. It is
 * derived display metadata now, read by nothing in this file.
 */
export function difficultyFor(iso2: string, category: SeedVisaCategory): DifficultyBand {
  const code = iso2.toUpperCase();
  let index = categoryFloorIndex(category);

  if (index < STICKER_FLOOR_INDEX && KNOWN_BIOMETRIC_OR_INTERVIEW.includes(code)) {
    index += 1;
  }

  if (KNOWN_HIGH_FRICTION.includes(code)) {
    index += 1;
  }

  return DIFFICULTY_BANDS[Math.min(index, DIFFICULTY_BANDS.length - 1)];
}

/**
 * THE COUNTRY'S historical approval rate for Indian applicants — never the
 * caller's odds. Four possible answers, three of them fixed strings.
 */
export function approvalChancesFor(iso2: string, category: SeedVisaCategory): string {
  /* ── ONE GATE, AND IT IS NOT A CATEGORY GATE ─────────────────────────
   * VISA_FREE is the only category that suppresses a number, and it does so
   * because the number would be meaningless rather than because it might be
   * unflattering: there is no application to approve, so an approval rate is
   * an answer to a question the reader never asked.
   *
   * Everything else shows what we hold. This replaced two earlier rules in
   * turn, and both failed the same way — by deciding on a reader's behalf
   * that a corridor was easy:
   *
   *   1. E_VISA/VOA/TRAVEL_AUTH returned "Very High" unconditionally, on
   *      the reasoning that these regimes grant on submission. Written when
   *      every figure we held was STICKER, it had never met an e-visa
   *      corridor's own numbers — and when it did, Ukraine's card asserted
   *      "Very High" over a dataset entry of 3%.
   *   2. The same, but only above a 90% threshold. Honest where it fired,
   *      but it made the CARD FORMAT a function of live data: Armenia at 88%
   *      showed three numbers and would have silently reverted to two words
   *      at 90%. A reader cannot learn a layout that moves with a refresh.
   *
   * So the rule is now the plain one. If it is not visa-free and we hold
   * figures, the figures are what a reader gets, and "Very High" survives
   * ONLY as the no-data fallback it always was underneath. */
  if (category === "VISA_FREE") return "Not required";

  const sourced = SOURCED_APPROVAL[iso2.toUpperCase()];
  if (sourced) return sourced.label;

  /* ── NO DATA: the category's own honest string, unchanged ───────────
   * TRAVEL_AUTH joins e-visa and on-arrival rather than getting a fifth
   * string. An arrival card is granted on submission — if anything it is
   * MORE certain than an e-visa — and inventing new copy for it would put a
   * fourth honest string in a vocabulary the frontend renders by exact
   * match.
   *
   * STICKER and RESTRICTED fall to "Varies by profile". RESTRICTED gets the
   * same string rather than one that sounds like a refusal statistic: we
   * hold no rate for a corridor with no route, and the seed's own
   * categoryNote is what actually explains it. */
  if (category === "E_VISA" || category === "VOA" || category === "TRAVEL_AUTH") {
    return "Very High";
  }
  return "Varies by profile";
}
