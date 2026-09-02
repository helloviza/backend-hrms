// apps/backend/src/config/visaScoreRuleset.ts
//
// THE VISA PROFILE SCORE RULESET — versioned data, loaded once, frozen.
//
// ══════════════════════════════════════════════════════════════════════
// WHY A FILE AND NOT A COLLECTION
// ══════════════════════════════════════════════════════════════════════
// A score has to be reproducible: if someone asks in six months why they
// were shown 712, the answer has to be "ruleset 2.0.0 said so", and that
// only holds if the ruleset is deployed rather than edited underneath the
// history. A Mongo collection would make every score a statement about
// whatever the weights happened to be at read time, and there is no ops
// editor today that would justify paying that price.
//
// When an editor does arrive, the migration is: this loader keeps its
// signature, reads a pinned version from the collection instead of the
// file, and every stored score keeps naming the version that produced it.
//
// ══════════════════════════════════════════════════════════════════════
// SERVER-SIDE ONLY. THIS MUST NOT REACH A BROWSER.
// ══════════════════════════════════════════════════════════════════════
// The deltas ARE the model. Anyone holding them can read off exactly what
// each answer is worth and reverse the questionnaire, which is both the
// commercial asset and an invitation to game the assessment. Nothing in
// apps/frontend imports this module, and Phase 2's route layer must return
// the computed OUTPUT (score, band, factors, citations) and never the
// weights behind it. The file's own `serverSideOnly` flag is asserted by
// the test suite so a future edit cannot quietly flip the intent.
//
// ── WHY readFileSync AND NOT AN IMPORT ────────────────────────────────
// The same reason config/visaCountrySeed.ts and utils/visaDifficulty.ts
// spell out at length: `tsc` does not copy .json, and this file reaches
// the container only via the build script's `cp -r src/data dist/`. An
// `import ... with { type: "json" }` resolves through the module loader
// instead — fine under tsx and vitest, then inlined or unresolvable in
// dist/. That is the "works locally, 404s in prod" failure mode.
//
// ── WHY A BAD FILE THROWS HERE (UNLIKE visaDifficulty) ────────────────
// visaDifficulty degrades to "Varies by profile" because a missing map
// number is a smaller harm than a dead API. The opposite holds here: a
// half-parsed ruleset would score real people against partial weights and
// print a confident number derived from nothing. There is no honest
// degraded score, so this throws at boot and the deploy fails loudly.
// Nothing imports it on the server's critical boot path yet (Phase 1 is
// engine + tests only), so the blast radius is the score feature itself.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULESET_FILE = path.join(__dirname, "../data/visa-score-ruleset.v2.json");

export type ScoreDimension = "stability" | "history" | "financial" | "trip";
export type FlagSeverity = "critical" | "warning" | "info";
export type HardStopAction = "cap" | "suppress";
export type ConfidenceGrade = "high" | "medium" | "low";

export interface RulesetOption {
  label: string;
  points: number;
}

export interface RulesetQuestion {
  id: string;
  dim: ScoreDimension;
  cite: string;
  text: string;
  silent?: boolean;
  /** Present only on route-conditional questions (today: schdays/SCHENGEN). */
  appliesTo?: string[];
  options: RulesetOption[];
}

export interface RulesetHardStop {
  code: string;
  question: string;
  optionIndex: number;
  action: HardStopAction;
  capAt?: number;
  severity: FlagSeverity;
  message: string;
}

export interface RulesetBand {
  min: number;
  name: string;
  hex: string;
  note: string;
}

export interface VisaScoreRuleset {
  version: string;
  effectiveFrom: string;
  serverSideOnly: boolean;
  transform: {
    K: number;
    envelope: { min: number; max: number };
    scoreBase: number;
    scoreSpan: number;
    scoreFloor: number;
    scoreCap: number;
    clampBaseBeforeLogit: boolean;
  };
  baseRate: { defaultMode: "a3" | "a5"; modes: string[] };
  schengen: {
    code: string;
    name: string;
    members: string[];
    precision: number;
  };
  firstTimer: {
    triggerQuestion: string;
    triggerOptionIndex: number;
    skipQuestions: string[];
    boostQuestions: string[];
    boostMultiplier: number;
  };
  heldVisas: {
    enabled: boolean;
    pointsPerVisa: number;
    cap: number;
    excludeTargetCountry: boolean;
    excludeDuplicates: boolean;
    eligible: string[];
  };
  bands: RulesetBand[];
  /** Bands over the corridor's approval RATE (0..1), not over a score. */
  climateBands: RulesetBand[];
  confidence: {
    grades: Record<ConfidenceGrade, { halfWidthPp: number; label: string; note: string }>;
  };
  hardStops: RulesetHardStop[];
  warningThreshold: number;
  disclaimer: string;
  questions: RulesetQuestion[];
}

/**
 * Validates the shape this module promises its callers, and throws with a
 * list rather than on the first problem — a ruleset with three mistakes
 * should surface three, not turn into three deploys.
 *
 * This is deliberately a STRUCTURAL check, not a judgement about the
 * weights: it asserts that a question has options and that a hard stop
 * points at a real option index, and says nothing about whether -45 is the
 * right number for a misrepresentation finding. That is the ruleset
 * author's call, and encoding it here would make the validator a second,
 * quieter copy of the model.
 */
function validate(r: any): asserts r is VisaScoreRuleset {
  const problems: string[] = [];
  const req = (cond: boolean, msg: string) => { if (!cond) problems.push(msg); };

  req(typeof r?.version === "string" && r.version.length > 0, "version is missing");
  req(typeof r?.effectiveFrom === "string", "effectiveFrom is missing");
  req(r?.serverSideOnly === true, "serverSideOnly must be true — this file must never be shipped to a browser");

  const t = r?.transform;
  req(typeof t?.K === "number", "transform.K is missing");
  req(typeof t?.envelope?.min === "number" && typeof t?.envelope?.max === "number", "transform.envelope is malformed");
  req(t?.envelope?.min > 0 && t?.envelope?.max < 1, "transform.envelope must sit strictly inside (0,1) — the clamp exists to keep logit finite");
  req(t?.clampBaseBeforeLogit === true, "transform.clampBaseBeforeLogit must be true — turning it off restores the reference's logit-pin bug");
  req(typeof t?.scoreFloor === "number" && typeof t?.scoreCap === "number" && t.scoreFloor < t.scoreCap, "transform score bounds are malformed");

  req(Array.isArray(r?.questions) && r.questions.length > 0, "questions[] is empty");
  const byId = new Map<string, RulesetQuestion>();
  for (const [i, q] of (r?.questions ?? []).entries()) {
    const at = `questions[${i}]`;
    req(typeof q?.id === "string" && q.id.length > 0, `${at}: id is missing`);
    req(typeof q?.cite === "string" && q.cite.length > 0, `${at} (${q?.id}): cite is missing — every question must name what it is assessed under`);
    req(Array.isArray(q?.options) && q.options.length > 1, `${at} (${q?.id}): needs at least two options`);
    for (const [oi, o] of (q?.options ?? []).entries()) {
      req(typeof o?.points === "number" && Number.isFinite(o.points), `${at} (${q?.id}).options[${oi}]: points must be a finite number`);
      req(typeof o?.label === "string" && o.label.length > 0, `${at} (${q?.id}).options[${oi}]: label is missing`);
    }
    if (q?.id) {
      req(!byId.has(q.id), `${at}: duplicate question id "${q.id}"`);
      byId.set(q.id, q);
    }
  }

  for (const [i, h] of (r?.hardStops ?? []).entries()) {
    const at = `hardStops[${i}]`;
    const q = byId.get(h?.question);
    req(Boolean(q), `${at}: references unknown question "${h?.question}"`);
    if (q) req(h?.optionIndex >= 0 && h.optionIndex < q.options.length, `${at}: optionIndex ${h?.optionIndex} is out of range for "${h?.question}"`);
    req(h?.action === "cap" || h?.action === "suppress", `${at}: action must be "cap" or "suppress"`);
    if (h?.action === "cap") req(typeof h?.capAt === "number", `${at}: a "cap" hard stop needs capAt`);
  }

  req(Array.isArray(r?.bands) && r.bands.length > 0, "bands[] is empty");
  // Bands are scanned top-down by the engine, so a mis-ordered array would
  // silently return the wrong band rather than fail. Assert the order here.
  for (let i = 1; i < (r?.bands ?? []).length; i++) {
    req(r.bands[i - 1].min > r.bands[i].min, `bands[${i}] is not in descending min order — the engine takes the first match`);
  }
  req((r?.bands ?? []).at(-1)?.min === 0, "the last band must have min 0 so every score matches something");

  /* climateBands are read by GET /visa-score/routes and band a PROBABILITY,
   * so they carry the same descending-order requirement as bands[] and the
   * additional one that they live in 0..1 — a climate band with min 800
   * would silently match nothing and every corridor would fall through to
   * the last entry. */
  req(Array.isArray(r?.climateBands) && r.climateBands.length > 0, "climateBands[] is empty");
  for (let i = 1; i < (r?.climateBands ?? []).length; i++) {
    req(r.climateBands[i - 1].min > r.climateBands[i].min, `climateBands[${i}] is not in descending min order`);
  }
  for (const [i, b] of (r?.climateBands ?? []).entries()) {
    req(b?.min >= 0 && b?.min <= 1, `climateBands[${i}].min must be a probability in 0..1, not a score`);
  }
  req((r?.climateBands ?? []).at(-1)?.min === 0, "the last climate band must have min 0");

  for (const g of ["high", "medium", "low"] as const) {
    req(typeof r?.confidence?.grades?.[g]?.halfWidthPp === "number", `confidence.grades.${g}.halfWidthPp is missing`);
  }

  const ft = r?.firstTimer;
  req(byId.has(ft?.triggerQuestion), `firstTimer.triggerQuestion "${ft?.triggerQuestion}" is not a question`);
  for (const id of ft?.skipQuestions ?? []) req(byId.has(id), `firstTimer.skipQuestions names unknown question "${id}"`);
  for (const id of ft?.boostQuestions ?? []) req(byId.has(id), `firstTimer.boostQuestions names unknown question "${id}"`);

  if (problems.length) {
    throw new Error(`[visaScoreRuleset] ${RULESET_FILE} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
}

function load(): VisaScoreRuleset {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(RULESET_FILE, "utf-8"));
  } catch (err: any) {
    throw new Error(`[visaScoreRuleset] cannot read ${RULESET_FILE}: ${err?.message ?? err}`);
  }
  validate(raw);
  return Object.freeze(raw) as VisaScoreRuleset;
}

/** The active ruleset. Frozen at module init; the engine never mutates it. */
export const VISA_SCORE_RULESET: VisaScoreRuleset = load();

/** Question lookup by id, built once. */
export const RULESET_QUESTIONS_BY_ID: ReadonlyMap<string, RulesetQuestion> = new Map(
  VISA_SCORE_RULESET.questions.map((q) => [q.id, q]),
);
