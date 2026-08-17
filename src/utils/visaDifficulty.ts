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
// 3. A NUMBER MAY ONLY COME FROM `SOURCED_APPROVAL`, and every entry carries
//    its citation in the same object — so a figure physically cannot be copied
//    out of here without the source that justifies it. Every other country
//    gets one of three fixed strings. There is no default numeric branch, no
//    interpolation, no estimate. public.visa.test.ts asserts that no iso2
//    outside this map ever carries a digit.
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

export interface SourcedApproval {
  /** Rendered verbatim as `approvalChances`. Carries its own scope. */
  label: string;
  /** Drives the >20% difficulty escalation. The published refusal rate. */
  refusalRatePct: number;
  /** WHY we are allowed to print `label`. Never optional. */
  citation: string;
  /* ── The citation, split into the parts a footnote needs ────────────
   * `citation` is one sentence written for a human reading a code file.
   * The panel's Sources block needs the same facts as FIELDS, so it can
   * set them in its own voice ("~78% — issued, FY25. Source: …") without
   * a frontend parsing an English sentence to find the year in it.
   *
   * These are DERIVED FROM the citation above, not new claims, and they
   * are on the same object for the reason rule 3 in this file's header
   * gives: a figure cannot be copied out of here without the provenance
   * that justifies it, and now it cannot be copied out without the
   * provenance a reader will actually be shown either. */
  /**
   * The construct the published statistic actually measures. NOT
   * interchangeable words — "issued" is a count of visas granted,
   * "granted" is the destination's own term for the same, "approved" is
   * a decision rate. The US figure is the complement of an ADJUSTED
   * REFUSAL rate and is therefore the loosest of the three; it is still
   * "issued" rather than "approved" because that is what the State
   * Department's number counts.
   */
  metricType: "issued" | "granted" | "approved";
  /** The publication period, as the publisher labels it. */
  year: string;
  /** The publishing body, short enough to end a footnote sentence. */
  sourceName: string;
}

/**
 * The one sentence that has to accompany EVERY approval figure.
 *
 * It is a constant rather than per-country copy because it is not a fact
 * about any destination — it is the boundary of what the number can be
 * read to mean, and that boundary is identical for all 31. See rule 2 in
 * this file's header: "~78% of Indian applicants were approved" is a fact
 * about the US State Department; "you have a 78% chance" is a lie about a
 * person we know nothing about.
 */
export const APPROVAL_OUTCOME_DISCLAIMER =
  "Historical destination outcome rate for Indian applicants, not a prediction of any individual's result.";

/**
 * THE ONLY PLACE A NUMBER MAY LIVE. 31 entries: US, GB, and the 29 Schengen
 * members.
 *
 * The Schengen figure is the EU Commission AGGREGATE across Schengen states,
 * not a per-state rate — labelled "(India, 2024)" and cited as such. It is not
 * a claim about Liechtenstein specifically.
 */
export const SOURCED_APPROVAL: Readonly<Record<string, SourcedApproval>> = Object.freeze({
  US: {
    label: "~78% (India, FY25)",
    refusalRatePct: 22.0,
    citation: "US State Department, adjusted refusal rate 22.0% (FY25)",
    metricType: "issued",
    year: "FY25",
    sourceName: "US State Department",
  },
  GB: {
    label: "~93% (India)",
    refusalRatePct: 7,
    citation: "UK Home Office, under 7% rejection for Indian applicants",
    /* No year, and that is the honest answer rather than a gap. The Home
     * Office figure we hold is undated in its own publication, which is
     * why `label` says "(India)" and not "(India, 2024)". The footnote
     * omits the period rather than inventing one — see approvalSourceFor,
     * which treats an empty year as "no period to state". */
    metricType: "issued",
    year: "",
    sourceName: "UK Home Office",
  },
  ...Object.fromEntries(
    SCHENGEN_MEMBERS.map((iso2) => [
      iso2,
      {
        label: "~85% (India, 2024)",
        refusalRatePct: 15,
        citation: "European Commission, ~15% Schengen visa rejection for Indian applicants (2024 aggregate)",
        metricType: "issued" as const,
        year: "2024",
        /* "(Schengen aggregate)" is load-bearing and is NOT decoration.
         * This figure is the Commission's number across all Schengen
         * states, not a rate for the country whose panel it appears on,
         * and the footnote is the only place a reader can learn that.
         * Dropping the qualifier would turn one honest aggregate into 29
         * per-country claims we do not hold. */
        sourceName: "European Commission (Schengen aggregate)",
      },
    ]),
  ),
});

/**
 * The provenance for the figure `approvalChancesFor` WILL RETURN — or
 * null when that figure is not a sourced number.
 *
 * ── WHY THIS TAKES THE CATEGORY AND NOT JUST THE ISO2 ────────────────
 * Because SOURCED_APPROVAL having an entry is NOT the same question as
 * the panel showing that entry. `approvalChancesFor` short-circuits on
 * category first: a VISA_FREE country returns "Not required" and an
 * E_VISA/VOA/TRAVEL_AUTH country returns "Very High" BEFORE the sourced
 * map is ever consulted. So a country can be in the map and still be
 * displaying a fixed string.
 *
 * Answering "is there a row for this code?" would put a State-Department
 * citation under the words "Very High", which is precisely the failure
 * rule 3 of this file's header exists to prevent — a citation next to a
 * figure it does not justify. This function instead asks the SAME
 * question in the SAME order the display does, so the credit and the
 * number can never disagree.
 *
 * Pure, like everything else here: no clock, no database, no request.
 */
export interface ApprovalProvenance {
  /** The exact string the panel is showing. Echoed so the footnote can
   *  lead with it and a reader can see the credit belongs to it. */
  value: string;
  metricType: SourcedApproval["metricType"];
  /** Empty string when the publication is undated — see GB above. */
  year: string;
  sourceName: string;
  /** The full sentence, for a title attribute. */
  citation: string;
  /** Identical on every country; carried here so one payload is enough. */
  disclaimer: string;
}

export function approvalSourceFor(
  iso2: string,
  category: SeedVisaCategory,
): ApprovalProvenance | null {
  const value = approvalChancesFor(iso2, category);
  const sourced = SOURCED_APPROVAL[iso2.toUpperCase()];
  // The identity check, not a category re-test: the credit is attached
  // only when the displayed string IS the sourced label. If the two ever
  // stop matching, this returns null and the panel simply shows no
  // credit — the safe direction to fail in.
  if (!sourced || value !== sourced.label) return null;
  return {
    value,
    metricType: sourced.metricType,
    year: sourced.year,
    sourceName: sourced.sourceName,
    citation: sourced.citation,
    disclaimer: APPROVAL_OUTCOME_DISCLAIMER,
  };
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
 *   3. +1 if a SOURCED refusal rate exceeds 20%, or the destination is known
 *      high-friction
 *   4. capped at "Very Hard"
 *
 * Most countries come out at their floor. Only the known-harder set escalates.
 */
export function difficultyFor(iso2: string, category: SeedVisaCategory): DifficultyBand {
  const code = iso2.toUpperCase();
  let index = categoryFloorIndex(category);

  if (index < STICKER_FLOOR_INDEX && KNOWN_BIOMETRIC_OR_INTERVIEW.includes(code)) {
    index += 1;
  }

  const sourced = SOURCED_APPROVAL[code];
  if ((sourced && sourced.refusalRatePct > 20) || KNOWN_HIGH_FRICTION.includes(code)) {
    index += 1;
  }

  return DIFFICULTY_BANDS[Math.min(index, DIFFICULTY_BANDS.length - 1)];
}

/**
 * THE COUNTRY'S historical approval rate for Indian applicants — never the
 * caller's odds. Four possible answers, three of them fixed strings.
 */
export function approvalChancesFor(iso2: string, category: SeedVisaCategory): string {
  if (category === "VISA_FREE") return "Not required";
  // TRAVEL_AUTH joins e-visa and on-arrival at "Very High" rather than getting
  // a fifth string. An arrival card is granted on submission — if anything it
  // is MORE certain than an e-visa — and inventing new copy for it would put a
  // fourth honest string in a vocabulary the frontend renders by exact match.
  if (category === "E_VISA" || category === "VOA" || category === "TRAVEL_AUTH") return "Very High";
  // STICKER and RESTRICTED, from here down. RESTRICTED deliberately falls
  // through to the same "Varies by profile" rather than getting a string that
  // sounds like a refusal statistic: we hold no rate for a corridor with no
  // route, and the seed's own categoryNote is what actually explains it.
  return SOURCED_APPROVAL[iso2.toUpperCase()]?.label ?? "Varies by profile";
}
