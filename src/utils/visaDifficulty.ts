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
}

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
  },
  GB: {
    label: "~93% (India)",
    refusalRatePct: 7,
    citation: "UK Home Office, under 7% rejection for Indian applicants",
  },
  ...Object.fromEntries(
    SCHENGEN_MEMBERS.map((iso2) => [
      iso2,
      {
        label: "~85% (India, 2024)",
        refusalRatePct: 15,
        citation: "European Commission, ~15% Schengen visa rejection for Indian applicants (2024 aggregate)",
      },
    ]),
  ),
});

/** VISA_FREE/VOA → Easy · E_VISA → Moderate · STICKER → Hard. */
function categoryFloorIndex(category: SeedVisaCategory): number {
  switch (category) {
    case "VISA_FREE":
    case "VOA":
      return 0; // Easy
    case "E_VISA":
      return 1; // Moderate
    case "STICKER":
      return 2; // Hard
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
  if (category === "E_VISA" || category === "VOA") return "Very High";
  // STICKER, from here down.
  return SOURCED_APPROVAL[iso2.toUpperCase()]?.label ?? "Varies by profile";
}
