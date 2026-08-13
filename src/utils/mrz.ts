// apps/backend/src/utils/mrz.ts
//
// Pure, deterministic parser + validator for a passport's ICAO 9303 TD3
// Machine Readable Zone (two lines, 44 characters each). No I/O, no
// network, no Mongoose — this module never touches Gemini, S3, or the DB;
// see services/extractPassportGemini.ts (gets the raw MRZ lines from the
// model) and services/visaPassportExtraction.ts (orchestrates the two).
//
// Why two stages: a raw MRZ read has FIVE check digits built into the
// format (document number, date of birth, date of expiry, the optional
// data field, and a composite over all of them, each using the standard
// 7-3-1 weighting). Asking a vision model to output structured fields
// directly throws that verification away — there's no way to tell a
// correct read from a plausible-looking hallucination. Asking for the
// raw lines and validating check digits HERE means a correct read is
// provably correct, and a wrong one is provably wrong, deterministically,
// with zero network calls.
//
// TD3 layout (0-indexed character positions):
//   Line 1 (44 chars):
//     [0:2)   document type (e.g. "P<", "PD")
//     [2:5)   issuing state, ISO 3166-1 alpha-3, "<"-padded
//     [5:44)  name: SURNAME<<GIVEN<NAMES<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
//   Line 2 (44 chars):
//     [0:9)   document (passport) number, "<"-padded
//     [9]     check digit — document number
//     [10:13) nationality, ISO 3166-1 alpha-3
//     [13:19) date of birth, YYMMDD
//     [19]    check digit — date of birth
//     [20]    sex — "M" | "F" | "<" (unspecified)
//     [21:27) date of expiry, YYMMDD
//     [27]    check digit — date of expiry
//     [28:42) optional data (personal number), "<"-padded
//     [42]    check digit — optional data ("<" if the field is all "<")
//     [43]    composite check digit, over positions [0:10)+[13:20)+[21:28)+[28:43)
//
// Repair follow-up (2026-07-30): the original fix here (right-pad a short
// line 1, unconditionally, within a tolerance) was diagnosed from 3 FAILED
// extractions that all happened to be short-by-a-little on line 1 only.
// Once fixed, the SAME image started failing again on a later attempt —
// this time line 1 came back short (43) AND line 2 came back long (45).
// Gemini's transcription of "<" filler runs is genuinely non-deterministic
// across calls on the same image; the errors are consistently confined to
// filler counting, never to a data character. `parseTD3Mrz` below is back
// to a STRICT exact-length parser (no padding) — the old blind pad was
// also unverifiable by construction, since line 1 carries no check digit
// of its own. Recovery now lives in `parseTD3MrzWithRepair`: a small set
// of candidate repairs (pad/truncate line 1's filler-only tail, adjust
// line 2's optional-data filler run), each candidate re-parsed and
// accepted ONLY if every check digit on it passes. Five passing check
// digits on a wrongly-repaired string is not a realistic coincidence, so
// requiring a full pass (not just "parses") is what makes guessing safe.

export type MrzCheckField = "documentNumber" | "dateOfBirth" | "dateOfExpiry" | "optionalData" | "composite";

export interface MrzCheckResult {
  field: MrzCheckField;
  expected: number | null; // null only for optionalData when the field is legitimately unused ("<" check char)
  actual: string; // the character found at the check-digit position
  passed: boolean;
}

export interface ParsedMrz {
  documentType: string;
  issuingState: string; // ISO3, raw from the MRZ — NOT normalised here (see routes/visa.ts write-back)
  surname: string;
  givenNames: string;
  documentNumber: string;
  nationality: string; // ISO3, raw from the MRZ
  dateOfBirth: string; // raw "YYMMDD" — NOT century-resolved here (see resolveMrzDate)
  sex: string; // "M" | "F" | "<"
  dateOfExpiry: string; // raw "YYMMDD"
  checks: MrzCheckResult[];
}

export type MrzParseError =
  | { type: "invalid_length"; message: string }
  | { type: "invalid_charset"; message: string }
  | { type: "invalid_document_type"; message: string };

export type MrzParseResult = { ok: true; result: ParsedMrz } | { ok: false; error: MrzParseError };

const TD3_LINE_LENGTH = 44;
const MRZ_CHARSET_RE = /^[A-Z0-9<]+$/;

/* ─────────────────────────────────────────────────────────────────────
 * Check digit — standard ICAO 9303 7-3-1 weighting. Digits are their own
 * value, A-Z are 10-35, "<" is 0.
 * ───────────────────────────────────────────────────────────────────── */
function charValue(c: string): number {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55;
  return 0; // "<" and anything unexpected — MRZ check digits treat both as 0
}

const CHECK_WEIGHTS = [7, 3, 1] as const;

export function computeCheckDigit(input: string): number {
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    sum += charValue(input[i]) * CHECK_WEIGHTS[i % 3];
  }
  return sum % 10;
}

function decodeNamePart(s: string): string {
  return s.replace(/</g, " ").trim().replace(/\s+/g, " ");
}

function stripFillers(s: string): string {
  return s.replace(/</g, "");
}

/* ─────────────────────────────────────────────────────────────────────
 * parseTD3Mrz — the only exported entry point for parsing. Never throws;
 * structural problems (wrong length, disallowed characters, not a
 * passport) come back as { ok: false, error }.
 * ───────────────────────────────────────────────────────────────────── */
export function parseTD3Mrz(rawLine1: string, rawLine2: string): MrzParseResult {
  const line1 = (rawLine1 || "").trim().toUpperCase();
  const line2 = (rawLine2 || "").trim().toUpperCase();

  if (line1.length !== TD3_LINE_LENGTH || line2.length !== TD3_LINE_LENGTH) {
    return {
      ok: false,
      error: {
        type: "invalid_length",
        message: `TD3 MRZ lines must be exactly ${TD3_LINE_LENGTH} characters (got ${line1.length} and ${line2.length}).`,
      },
    };
  }

  if (!MRZ_CHARSET_RE.test(line1) || !MRZ_CHARSET_RE.test(line2)) {
    return {
      ok: false,
      error: { type: "invalid_charset", message: "MRZ lines may only contain A-Z, 0-9 and '<'." },
    };
  }

  if (line1[0] !== "P") {
    return {
      ok: false,
      error: { type: "invalid_document_type", message: `Expected a passport (document type "P"), got "${line1[0]}".` },
    };
  }

  // ── Line 1 ──
  const documentType = stripFillers(line1.slice(0, 2)) || "P";
  const issuingState = line1.slice(2, 5);
  const nameField = line1.slice(5, 44);
  const [surnamePart = "", givenPart = ""] = nameField.split("<<");
  const surname = decodeNamePart(surnamePart);
  const givenNames = decodeNamePart(givenPart);

  // ── Line 2 ──
  const documentNumberRaw = line2.slice(0, 9);
  const documentNumberCheckChar = line2[9];
  const nationality = line2.slice(10, 13);
  const dateOfBirth = line2.slice(13, 19);
  const dobCheckChar = line2[19];
  const sex = line2[20];
  const dateOfExpiry = line2.slice(21, 27);
  const expiryCheckChar = line2[27];
  const optionalData = line2.slice(28, 42);
  const optionalCheckChar = line2[42];
  const compositeCheckChar = line2[43];

  const documentNumber = stripFillers(documentNumberRaw);

  const checks: MrzCheckResult[] = [];

  const documentNumberExpected = computeCheckDigit(documentNumberRaw);
  checks.push({
    field: "documentNumber",
    expected: documentNumberExpected,
    actual: documentNumberCheckChar,
    passed: String(documentNumberExpected) === documentNumberCheckChar,
  });

  const dobExpected = computeCheckDigit(dateOfBirth);
  checks.push({
    field: "dateOfBirth",
    expected: dobExpected,
    actual: dobCheckChar,
    passed: String(dobExpected) === dobCheckChar,
  });

  const expiryExpected = computeCheckDigit(dateOfExpiry);
  checks.push({
    field: "dateOfExpiry",
    expected: expiryExpected,
    actual: expiryCheckChar,
    passed: String(expiryExpected) === expiryCheckChar,
  });

  // Optional data (personal number) — ICAO 9303 allows the check digit to
  // be "<" when the whole 14-character field is unused filler, rather than
  // a computed digit. Only treat it as N/A-and-valid when BOTH the field
  // is all filler AND the check char is literally "<" — an all-filler
  // field with a numeric check char (or vice versa) is still a real
  // mismatch, not a shrug.
  const optionalDataAllFiller = /^<+$/.test(optionalData);
  if (optionalDataAllFiller && optionalCheckChar === "<") {
    checks.push({ field: "optionalData", expected: null, actual: optionalCheckChar, passed: true });
  } else {
    const optionalExpected = computeCheckDigit(optionalData);
    checks.push({
      field: "optionalData",
      expected: optionalExpected,
      actual: optionalCheckChar,
      passed: String(optionalExpected) === optionalCheckChar,
    });
  }

  const compositeInput =
    documentNumberRaw + documentNumberCheckChar + dateOfBirth + dobCheckChar + dateOfExpiry + expiryCheckChar + optionalData + optionalCheckChar;
  const compositeExpected = computeCheckDigit(compositeInput);
  checks.push({
    field: "composite",
    expected: compositeExpected,
    actual: compositeCheckChar,
    passed: String(compositeExpected) === compositeCheckChar,
  });

  return {
    ok: true,
    result: {
      documentType,
      issuingState,
      surname,
      givenNames,
      documentNumber,
      nationality,
      dateOfBirth,
      sex,
      dateOfExpiry,
      checks,
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Candidate repair — see the "Repair follow-up" note in the file header.
 *
 * Cap: 6 characters, on the TOTAL "<" characters added/removed across BOTH
 * lines for any one candidate (not 6 per line — a candidate that fixes both
 * lines sums its two adjustments before being checked against this). Kept
 * at the same value the original line-1-only tolerance used: the diagnosed
 * real cases were off by 1-4 characters, and a handful of miscounted
 * filler characters is a plausible, bounded transcription slip; a
 * discrepancy larger than that is more likely a genuinely bad read (wrong
 * line, missed characters mid-field) that repair should surface as a
 * failure, not paper over.
 * ───────────────────────────────────────────────────────────────────── */
const FILLER_ADJUSTMENT_CAP = 6;

interface LineRepair {
  fixed: string;
  adjustment: number; // number of "<" characters added (positive) or removed — always >= 0, a count
}

// Line 1's name field ([5:44)) is itself "<"-padded to the end and carries
// NO check digit anywhere on the line — so recovering a short line 1 by
// right-padding, or trimming a long line 1 whose excess is pure filler,
// can only recover the original value, never fabricate a wrong one. This
// is candidates (b) and (c) from the task brief. Returns null when line 1
// is already exactly 44, when the discrepancy exceeds the cap, or (for an
// over-length line) when the excess isn't pure "<" — i.e. never touches a
// data character.
function repairLine1Filler(line1: string): LineRepair | null {
  if (line1.length === TD3_LINE_LENGTH) return null;

  if (line1.length < TD3_LINE_LENGTH) {
    const shortBy = TD3_LINE_LENGTH - line1.length;
    if (shortBy > FILLER_ADJUSTMENT_CAP) return null;
    return { fixed: line1.padEnd(TD3_LINE_LENGTH, "<"), adjustment: shortBy };
  }

  const longBy = line1.length - TD3_LINE_LENGTH;
  if (longBy > FILLER_ADJUSTMENT_CAP) return null;
  const excess = line1.slice(TD3_LINE_LENGTH);
  if (!/^<+$/.test(excess)) return null; // excess isn't pure filler — not safe to drop
  return { fixed: line1.slice(0, TD3_LINE_LENGTH), adjustment: longBy };
}

// Line 2's ONLY run that is both pure filler and not a check-digit
// position is the optional-data field at [28:42) — everything before it
// (document number + its check digit, nationality, DOB + check digit, sex,
// expiry + check digit — 28 characters) is taken verbatim, and the last two
// characters of the raw line are ALWAYS treated as the optional-data check
// char and the composite check char (their distance from the END of the
// line never shifts, however the middle filler run was miscounted) — also
// taken verbatim. Only the run between those two fixed regions is
// adjusted, and only by adding/removing trailing "<": the "real" content of
// that run is whatever remains after stripping ITS OWN trailing filler: if
// more than 14 characters of real content are left, the discrepancy isn't
// confined to filler and this returns null rather than guessing — this is
// candidate (d) from the task brief.
function repairLine2OptionalData(line2: string): LineRepair | null {
  if (line2.length === TD3_LINE_LENGTH) return null;

  const delta = Math.abs(line2.length - TD3_LINE_LENGTH);
  if (delta > FILLER_ADJUSTMENT_CAP) return null;
  // Need the 28-char fixed prefix plus the 2 trailing check chars, at
  // minimum, for this reconstruction to mean anything.
  if (line2.length < 30) return null;

  const prefix = line2.slice(0, 28);
  const guessedOptionalData = line2.slice(28, line2.length - 2);
  const trailingChecks = line2.slice(line2.length - 2);

  const content = guessedOptionalData.replace(/<+$/, "");
  if (content.length > 14) return null; // discrepancy isn't pure filler — reject rather than guess

  return { fixed: prefix + content.padEnd(14, "<") + trailingChecks, adjustment: delta };
}

export interface MrzRepairCandidate {
  line1: string;
  line2: string;
  adjustment: number; // total "<" characters added/removed to reach this candidate from as-received
}

// Candidates (a)-(e) from the task brief, least-invasive first: as-received,
// then line 1 alone, then line 2 alone, then both together. Deduplicated —
// a no-op fix (e.g. line 1 already exactly 44) never produces a second
// identical candidate. Every candidate here is already within
// FILLER_ADJUSTMENT_CAP individually; buildMrzRepairCandidates filters the
// COMBINED candidate (adjustment = line1 delta + line2 delta) against the
// same cap separately, since summing two individually-small fixes could
// still exceed it.
export function buildMrzRepairCandidates(rawLine1: string, rawLine2: string): MrzRepairCandidate[] {
  const line1 = (rawLine1 || "").trim().toUpperCase();
  const line2 = (rawLine2 || "").trim().toUpperCase();

  const candidates: MrzRepairCandidate[] = [];
  const seen = new Set<string>();
  function add(l1: string, l2: string, adjustment: number) {
    const key = `${l1}|${l2}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ line1: l1, line2: l2, adjustment });
  }

  add(line1, line2, 0); // (a) as-received

  const line1Fix = repairLine1Filler(line1);
  const line2Fix = repairLine2OptionalData(line2);

  if (line1Fix) add(line1Fix.fixed, line2, line1Fix.adjustment); // (b)/(c)
  if (line2Fix) add(line1, line2Fix.fixed, line2Fix.adjustment); // (d)
  if (line1Fix && line2Fix) {
    const combined = line1Fix.adjustment + line2Fix.adjustment;
    if (combined <= FILLER_ADJUSTMENT_CAP) add(line1Fix.fixed, line2Fix.fixed, combined); // (e)
  }

  return candidates;
}

export interface MrzRepairOutcome {
  result: MrzParseResult;
  // Which candidate was accepted — "as_received" when the raw transcription
  // needed no repair at all (still the common/expected case), a specific
  // repair name when a candidate was needed and its check digits validated,
  // or null when nothing validated (result is then the as-received parse,
  // exactly what parseTD3Mrz(rawLine1, rawLine2) alone would have returned
  // — "fail as now", per the task brief).
  repairedVia: "as_received" | "line1" | "line2" | "both" | null;
  adjustment: number;
}

function repairKind(candidate: MrzRepairCandidate, line1Changed: boolean, line2Changed: boolean): MrzRepairOutcome["repairedVia"] {
  if (candidate.adjustment === 0) return "as_received";
  if (line1Changed && line2Changed) return "both";
  if (line1Changed) return "line1";
  return "line2";
}

/**
 * The repair entry point — replaces the old blind line-1 padding inside
 * parseTD3Mrz. Tries each candidate from buildMrzRepairCandidates in order
 * and accepts the FIRST whose check digits ALL pass (every entry in
 * `checks`, not just the composite) — never a partial/medium-confidence
 * acceptance for a repaired candidate, since an unverified guess has no
 * business being treated as anything less than fully confirmed. If no
 * candidate validates, returns the as-received parse untouched (same
 * ok:false/low-confidence result callers already handle).
 */
export function parseTD3MrzWithRepair(rawLine1: string, rawLine2: string): MrzRepairOutcome {
  const line1 = (rawLine1 || "").trim().toUpperCase();
  const line2 = (rawLine2 || "").trim().toUpperCase();
  const candidates = buildMrzRepairCandidates(line1, line2);

  for (const candidate of candidates) {
    const result = parseTD3Mrz(candidate.line1, candidate.line2);
    if (result.ok && result.result.checks.every((c) => c.passed)) {
      return {
        result,
        repairedVia: repairKind(candidate, candidate.line1 !== line1, candidate.line2 !== line2),
        adjustment: candidate.adjustment,
      };
    }
  }

  return { result: parseTD3Mrz(line1, line2), repairedVia: null, adjustment: 0 };
}

/* ─────────────────────────────────────────────────────────────────────
 * maskMrzLine — for logging only. Replaces every alphanumeric character
 * with "X", keeping every "<" exactly where it is, so a log line shows
 * the STRUCTURE of a failed transcription (where the filler runs actually
 * fell) without ever putting a real passport number, name, or date in the
 * logs. Task brief's own example:
 *   P<INDTESTCASE<<ANANYA<<<...  ->  XXXXXXXXXXXX<<XXXXXX<<<...
 * (that example's exact output is illustrative — the real transformation
 * is a straight per-character substitution, shown precisely by the tests.)
 * ───────────────────────────────────────────────────────────────────── */
export function maskMrzLine(line: string): string {
  return (line || "").replace(/[^<]/g, "X");
}

/* ─────────────────────────────────────────────────────────────────────
 * deriveConfidence — see routes/visa.ts / build report §2: confidence is
 * ALWAYS derived from check-digit results, never reported by the model.
 *   all check digits pass          -> "high"
 *   composite fails, others pass   -> "medium"
 *   any FIELD check digit fails    -> "low" (checked first — a field
 *                                     failure almost always fails the
 *                                     composite too, so field failures
 *                                     take priority over the composite-only
 *                                     case, not the other way round)
 * ───────────────────────────────────────────────────────────────────── */
export type MrzConfidence = "high" | "medium" | "low";

export function deriveConfidence(checks: MrzCheckResult[]): MrzConfidence {
  const fieldChecks = checks.filter((c) => c.field !== "composite");
  if (fieldChecks.some((c) => !c.passed)) return "low";

  const composite = checks.find((c) => c.field === "composite");
  if (composite && !composite.passed) return "medium";

  return "high";
}

/* ─────────────────────────────────────────────────────────────────────
 * resolveMrzDate — MRZ dates are YYMMDD; converts to TravellerProfile's
 * "YYYY-MM-DD" string form, resolving the century.
 *
 * Century boundary, chosen deliberately DIFFERENT per field:
 *
 *   - dateOfBirth: a person cannot be born in the future relative to
 *     `referenceDate`. century = 2000 if (2000+YY) <= referenceYear, else
 *     1900. E.g. reference year 2026: YY=26 -> 2026 (this century, still
 *     not future); YY=30 -> candidate 2030 is in the future, so falls back
 *     to 1930. This is the standard "no future birth dates" rule used by
 *     production MRZ parsers.
 *
 *   - dateOfExpiry: ALWAYS resolved as 2000+YY (this century), full stop —
 *     no past/future comparison. Machine-readable passports only exist
 *     from the ICAO 9303 era (effectively 2000 onward); an expiry can
 *     legitimately be in the past (an expired document still being
 *     scanned) or the future, but it is never plausibly a 1900s date for
 *     a document anyone is uploading today. This is the simpler of the
 *     two rules on purpose — there is no realistic ambiguity to resolve.
 *     (Documented limitation: this assumes the system operates within the
 *     21st century — i.e. always through year 2099 — which is true for
 *     any foreseeable operating window.)
 *
 * Returns null for a structurally invalid YYMMDD (wrong length,
 * non-digits, or a calendar date that doesn't exist, e.g. day 31 in a
 * 30-day month) rather than throwing.
 * ───────────────────────────────────────────────────────────────────── */
export function resolveMrzDate(
  yymmdd: string,
  kind: "dob" | "expiry",
  referenceDate: Date = new Date(),
): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;

  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const month = parseInt(mm, 10);
  const day = parseInt(dd, 10);

  const referenceYear = referenceDate.getFullYear();
  const currentCentury = referenceYear - (referenceYear % 100);

  let year: number;
  if (kind === "dob") {
    const candidate = currentCentury + yy;
    year = candidate > referenceYear ? candidate - 100 : candidate;
  } else {
    year = currentCentury + yy;
  }

  // Round-trip through a real Date to reject calendar-invalid combinations
  // (e.g. 30th of February) rather than accepting them with silent rollover.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${mm}-${dd}`;
}
