// apps/backend/src/utils/passportCrossCheck.ts
//
// Pure, deterministic comparison between the two zones read off a
// passport's bio-data page: the MRZ (check-digit verified, utils/mrz.ts)
// and the VIZ (unverified, services/extractPassportGemini.ts). No I/O.
//
// This does NOT decide who's "right" — MRZ already wins for the stored
// value (services/visaPassportExtraction.ts), and check digits are the only
// real authority here anyway. This only surfaces a disagreement: a printed
// page whose own VIZ contradicts its own MRZ means either a bad read (in
// either zone) or a document a human should look at — never auto-rejected,
// just flagged (task brief: "Surface it; never auto-reject").
import { resolveMrzDate, type ParsedMrz } from "./mrz.js";
import { normaliseToIso2 } from "./countryCodes.js";
import { mrzSexFromGender } from "./mrzCompose.js";
import type { PassportVizFields } from "../services/extractPassportGemini.js";

export type PassportCrossCheckField =
  | "surname"
  | "givenNames"
  | "documentNumber"
  | "dateOfBirth"
  | "dateOfExpiry"
  | "sex"
  | "nationality";

export interface PassportCrossCheckMismatch {
  field: PassportCrossCheckField;
  mrzValue: string;
  vizValue: string;
}

function normaliseText(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, " ");
}

// MRZ document numbers are already filler-stripped (utils/mrz.ts); VIZ may
// print spaces or hyphens in the number that the MRZ never carries.
function normaliseDocumentNumber(s: string): string {
  return s.trim().toUpperCase().replace(/[\s-]/g, "");
}

function normaliseSex(s: string): string {
  const c = s.trim().toUpperCase();
  if (c.startsWith("M")) return "M";
  if (c.startsWith("F")) return "F";
  return c;
}

/**
 * Compares every field the MRZ and VIZ both claim to have read. A field
 * where the VIZ came back null/empty is skipped — there is nothing to
 * cross-check, not a mismatch. Dates compare in resolved "YYYY-MM-DD" form
 * (MRZ dates are raw YYMMDD strings on ParsedMrz; VIZ dates are already
 * ISO per extractPassportGemini.ts's prompt). Nationality compares via
 * normaliseToIso2 since the VIZ commonly prints a demonym ("INDIAN") where
 * the MRZ carries an ISO3 code ("IND") — a literal string compare would
 * misreport agreement as a mismatch on every passport.
 */
export function crossCheckPassportFields(mrz: ParsedMrz, viz: PassportVizFields): PassportCrossCheckMismatch[] {
  const mismatches: PassportCrossCheckMismatch[] = [];

  function compare(field: PassportCrossCheckField, mrzValue: string, vizValue: string | null, normalise: (s: string) => string) {
    if (!vizValue || !vizValue.trim()) return;
    if (!mrzValue || !mrzValue.trim()) return;
    if (normalise(mrzValue) !== normalise(vizValue)) {
      mismatches.push({ field, mrzValue, vizValue });
    }
  }

  compare("surname", mrz.surname, viz.surname, normaliseText);
  compare("givenNames", mrz.givenNames, viz.givenNames, normaliseText);
  compare("documentNumber", mrz.documentNumber, viz.documentNumber, normaliseDocumentNumber);
  compare("sex", mrz.sex, viz.sex, normaliseSex);

  // MRZ dates don't resolve to a real calendar date if the MRZ itself is
  // malformed — skip the compare rather than reporting a bogus mismatch;
  // mrz.ts's own check digits are the authority on whether the MRZ date is
  // broken, not this cross-check.
  const mrzDob = resolveMrzDate(mrz.dateOfBirth, "dob");
  if (mrzDob) compare("dateOfBirth", mrzDob, viz.dateOfBirth, (s) => s);

  const mrzExpiry = resolveMrzDate(mrz.dateOfExpiry, "expiry");
  if (mrzExpiry) compare("dateOfExpiry", mrzExpiry, viz.dateOfExpiry, (s) => s);

  if (viz.nationality && viz.nationality.trim()) {
    const mrzIso2 = normaliseToIso2(mrz.nationality);
    const vizIso2 = normaliseToIso2(viz.nationality);
    if (mrzIso2 && vizIso2 && mrzIso2 !== vizIso2) {
      mismatches.push({ field: "nationality", mrzValue: mrz.nationality, vizValue: viz.nationality });
    }
  }

  return mismatches;
}

// ─────────────────────────────────────────────────────────────────────────
// Identity cross-check — does the passport that was just read belong to the
// traveller it was UPLOADED against? A completely different problem from
// the MRZ-vs-VIZ compare above (that's "does this document agree with
// itself"; this is "does this document agree with the person the applicant
// says it belongs to"). Compared against the MRZ result specifically —
// check-digit verified, and the exact value that gets written back to the
// profile on confirmation — never the unverified VIZ.
//
// Two severities, deliberately different:
//   - MISMATCH (surname/givenNames/dateOfBirth) — the strong "wrong
//     person's document" signal. Names tolerate real-world variation
//     (initials, missing middle name, reordering, punctuation, case — see
//     namesTolerantMatch); dates do not (a birth date either matches or it
//     doesn't).
//   - DIFFERS_FROM_FILE (documentNumber only) — people renew passports, so
//     a different number is routine, not evidence of a wrong document. Only
//     compared when the profile already HAS a passport number on file (a
//     first-ever upload has nothing to differ from).
export type PassportIdentityField = "surname" | "givenNames" | "dateOfBirth" | "documentNumber";
export type PassportIdentitySeverity = "MISMATCH" | "DIFFERS_FROM_FILE";

export interface PassportIdentityMismatch {
  field: PassportIdentityField;
  severity: PassportIdentitySeverity;
  passportValue: string;
  profileValue: string;
}

// Only the fields relevant to identity — TravellerProfile.ts's own shape,
// not re-imported as a type dependency (this module stays a pure utility
// with no model coupling; the caller passes exactly the fields it needs).
export interface TravellerIdentityProfile {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  dob?: string | null; // "YYYY-MM-DD"
  passportNo?: string | null;
}

// Unicode-aware: strips punctuation (periods, hyphens, apostrophes, commas,
// etc.) while keeping letters from any script, so a transliterated name
// isn't mangled into an empty token. Periods/hyphens become SPACE rather
// than being deleted outright — deleting would collapse "S.K." into the
// single token "SK", which would then fail to match "SAURABH KUMAR" token
// by token; turning it into a space keeps "S" and "K" as separate initial
// tokens, which is what makes the initials case actually work below.
function normaliseNameTokens(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[.\-']/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

// Two tokens "match" if they're identical, or if the shorter one is a
// single-letter initial that's the first letter of the longer one — this
// is what lets "S" stand in for "SAURABH".
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [shortTok, longTok] = a.length <= b.length ? [a, b] : [b, a];
  return shortTok.length === 1 && longTok.startsWith(shortTok);
}

// True when every token in the SHORTER token list finds a distinct match
// (greedy, order-independent) somewhere in the longer list. Extra tokens on
// the longer side are simply ignored — that's precisely what tolerates a
// middle name present on only one side: whichever side has fewer tokens
// just needs full coverage, not an exact-length match.
function allTokensCovered(shorter: string[], longer: string[]): boolean {
  const remaining = [...longer];
  for (const tok of shorter) {
    const idx = remaining.findIndex((t) => tokensMatch(tok, t));
    if (idx === -1) return false;
    remaining.splice(idx, 1);
  }
  return true;
}

// Order-independent, initials-tolerant, middle-name-tolerant name compare.
// Empty on either side is treated as "nothing to compare" (true) by the
// caller's own guards, never reached here with an empty list in practice.
function namesTolerantMatch(a: string, b: string): boolean {
  const tokensA = normaliseNameTokens(a);
  const tokensB = normaliseNameTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return true;
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return allTokensCovered(shorter, longer);
}

/**
 * Compares the MRZ-derived passport identity against the TravellerProfile
 * the application belongs to. Only compares fields the profile actually
 * has a value for (task brief: DOB and passport number are conditional on
 * the profile already holding one) — an absent profile field is "nothing
 * to check", never a mismatch by omission. Surname/given names are always
 * compared since TravellerProfile.firstName/lastName are required fields.
 */
export function crossCheckPassportIdentity(
  mrz: ParsedMrz,
  profile: TravellerIdentityProfile,
): PassportIdentityMismatch[] {
  const mismatches: PassportIdentityMismatch[] = [];

  const profileLastName = (profile.lastName || "").trim();
  if (profileLastName && mrz.surname && mrz.surname.trim()) {
    if (!namesTolerantMatch(mrz.surname, profileLastName)) {
      mismatches.push({
        field: "surname",
        severity: "MISMATCH",
        passportValue: mrz.surname,
        profileValue: profileLastName,
      });
    }
  }

  // Given names on the profile are firstName + middleName combined — the
  // MRZ's givenNames field routinely carries a middle name that
  // TravellerProfile keeps in its own separate field (or vice versa: a
  // profile with no middleName on file against an MRZ that has one). This
  // combine, together with the tolerant subset compare, is exactly what
  // makes "middle name present on one side only" a non-issue rather than a
  // false mismatch.
  const profileGivenNames = [profile.firstName, profile.middleName]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" ");
  if (profileGivenNames && mrz.givenNames && mrz.givenNames.trim()) {
    if (!namesTolerantMatch(mrz.givenNames, profileGivenNames)) {
      mismatches.push({
        field: "givenNames",
        severity: "MISMATCH",
        passportValue: mrz.givenNames,
        profileValue: profileGivenNames,
      });
    }
  }

  const profileDob = (profile.dob || "").trim();
  if (profileDob) {
    const mrzDob = resolveMrzDate(mrz.dateOfBirth, "dob");
    if (mrzDob && mrzDob !== profileDob) {
      mismatches.push({ field: "dateOfBirth", severity: "MISMATCH", passportValue: mrzDob, profileValue: profileDob });
    }
  }

  // Renewal is the ordinary explanation for a changed passport number —
  // never treated as an identity red flag, just surfaced as a fact for the
  // user to notice (task brief: "NOT necessarily wrong").
  const profilePassportNo = (profile.passportNo || "").trim();
  if (profilePassportNo && mrz.documentNumber && mrz.documentNumber.trim()) {
    if (normaliseDocumentNumber(mrz.documentNumber) !== normaliseDocumentNumber(profilePassportNo)) {
      mismatches.push({
        field: "documentNumber",
        severity: "DIFFERS_FROM_FILE",
        passportValue: mrz.documentNumber,
        profileValue: profilePassportNo,
      });
    }
  }

  return mismatches;
}

/* ═══════════════════════════════════════════════════════════════════════
 * PASSPORT & MRZ VAULT — the Database Mismatch Check (2026-08-11, Tab 2)
 *
 * THE WHOLE POINT OF THIS BLOCK IS THAT IT COMPARES TWO DIFFERENT SOURCES.
 *
 * Source 1 is what a human TYPED into the traveller profile.
 * Source 2 is an MRZ actually READ OFF AN UPLOADED SCAN — VisaDocument
 * .extractedFields, produced by services/visaPassportExtraction.ts and
 * check-digit verified by utils/mrz.ts before it was ever stored.
 *
 * Those are genuinely independent, so agreement between them is real
 * evidence and disagreement is a real finding. That is what separates this
 * from the two things the design doc forbids:
 *
 *   - "checksum verified" over an MRZ WE composed from our own fields
 *     (utils/mrzCompose.ts's header) — our arithmetic vs our arithmetic;
 *   - a "100% match" panel rendered when only ONE source exists — a value
 *     compared to itself, which cannot fail.
 *
 * This function therefore does NOT decide whether to render anything. It
 * compares whatever it is given, and the CALLER counts sources and decides
 * (routes/workspace.travellers.ts's resolvePassportVault). The counting is
 * kept out of here so this stays a pure comparator with no notion of "how
 * many sources are enough" baked into it.
 *
 * Distinct from crossCheckPassportIdentity above, which answers "does this
 * scan belong to this person" and returns MISMATCHES ONLY. This one returns
 * a row per field INCLUDING the agreements, because the panel shows the
 * whole comparison — and because a percentage needs a denominator that only
 * exists if matches are counted too.
 * ═══════════════════════════════════════════════════════════════════════ */

export type PassportSourceField =
  | "surname"
  | "givenNames"
  | "dateOfBirth"
  | "documentNumber"
  | "dateOfExpiry"
  | "sex"
  | "nationality"
  | "issuingState";

/**
 * NOT_COMPARABLE is a first-class outcome, not a failure. A field only one
 * source holds has nothing to check — reporting it as a match would invent
 * agreement, and reporting it as a mismatch would invent a discrepancy.
 * It is excluded from BOTH halves of the percentage.
 */
export type PassportSourceStatus = "MATCH" | "MISMATCH" | "NOT_COMPARABLE";

export interface PassportSourceRow {
  field: PassportSourceField;
  status: PassportSourceStatus;
  /** Exactly as held, never case-forced — the comparison normalises, the display does not. */
  profileValue: string | null;
  /** The value read off the scan, resolved to display form (dates as YYYY-MM-DD). */
  extractedValue: string | null;
}

export interface PassportSourceComparison {
  rows: PassportSourceRow[];
  /** Fields both sources hold — the percentage's denominator. */
  comparedCount: number;
  matchedCount: number;
  mismatchedCount: number;
  /**
   * null when comparedCount is 0. A "0 of 0" comparison has no percentage,
   * and rendering 100% (or 0%) for it would be exactly the fabricated
   * assurance this whole block exists to avoid.
   */
  matchPercent: number | null;
}

/** The profile side — TravellerProfile's own keys, no model import. */
export interface PassportSourceProfile {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  gender?: string | null;
  dob?: string | null; // "YYYY-MM-DD"
  nationality?: string | null;
  passportNo?: string | null;
  passportExpiry?: string | null; // "YYYY-MM-DD"
  passportIssueCountry?: string | null;
}

/**
 * The extraction side — VisaDocument.extractedFields flattened to a map.
 * Only the MRZ-derived keys are read; the `viz_`, `check_` and
 * `identity_mismatch_` families that share that array are ignored, since
 * they are not passport field values.
 *
 * Dates arrive as RAW YYMMDD here (ParsedMrz keeps them unresolved — see
 * its own type comment), which is why every date below goes through
 * resolveMrzDate before it is compared or displayed. Comparing "740812"
 * against "1974-08-12" as strings would report every single passport as a
 * mismatch.
 */
export interface PassportSourceExtraction {
  surname?: string;
  givenNames?: string;
  documentNumber?: string;
  nationality?: string;
  issuingState?: string;
  dateOfBirth?: string; // raw "YYMMDD"
  sex?: string; // "M" | "F" | "<"
  dateOfExpiry?: string; // raw "YYMMDD"
}

/** Pull the MRZ field values out of a VisaDocument.extractedFields array. */
export function readPassportExtraction(
  extractedFields: ReadonlyArray<{ key: string; value: string }> | null | undefined,
): PassportSourceExtraction {
  const map = new Map<string, string>();
  for (const f of extractedFields ?? []) {
    if (f && typeof f.key === "string" && typeof f.value === "string") map.set(f.key, f.value);
  }
  const pick = (k: string) => {
    const v = (map.get(k) || "").trim();
    return v || undefined;
  };
  return {
    surname: pick("surname"),
    givenNames: pick("givenNames"),
    documentNumber: pick("documentNumber"),
    nationality: pick("nationality"),
    issuingState: pick("issuingState"),
    dateOfBirth: pick("dateOfBirth"),
    sex: pick("sex"),
    dateOfExpiry: pick("dateOfExpiry"),
  };
}

/**
 * True when this extraction carries enough MRZ data to be a second source
 * at all. A VisaDocument whose extraction FAILED still has an
 * extractedFields array — it holds `failureCategory` and `error` — and
 * treating that as a source would produce a comparison panel with every row
 * NOT_COMPARABLE, which reads as "we checked and found nothing wrong".
 *
 * The document number is the anchor: it is the field the whole comparison
 * hangs on, and an MRZ read without one isn't a passport read.
 */
export function isUsablePassportExtraction(extraction: PassportSourceExtraction): boolean {
  return Boolean(extraction.documentNumber);
}

/**
 * Compare typed profile fields against an MRZ extracted from a scan.
 *
 * Every comparison uses the SAME normalisation the rest of this module
 * already established — tolerant name matching (initials, middle names,
 * ordering), punctuation-insensitive document numbers, ISO-2 country
 * folding — so a real-world-equivalent pair is not reported as a
 * discrepancy. A mismatch here should mean something.
 */
export function comparePassportSources(
  profile: PassportSourceProfile,
  extraction: PassportSourceExtraction,
): PassportSourceComparison {
  const rows: PassportSourceRow[] = [];

  function push(
    field: PassportSourceField,
    profileValue: string | null,
    extractedValue: string | null,
    matches: () => boolean,
  ) {
    const hasProfile = Boolean(profileValue && profileValue.trim());
    const hasExtracted = Boolean(extractedValue && extractedValue.trim());
    if (!hasProfile || !hasExtracted) {
      rows.push({
        field,
        status: "NOT_COMPARABLE",
        profileValue: hasProfile ? profileValue : null,
        extractedValue: hasExtracted ? extractedValue : null,
      });
      return;
    }
    rows.push({
      field,
      status: matches() ? "MATCH" : "MISMATCH",
      profileValue,
      extractedValue,
    });
  }

  const profileSurname = (profile.lastName || "").trim() || null;
  const extractedSurname = extraction.surname || null;
  push("surname", profileSurname, extractedSurname, () =>
    namesTolerantMatch(extractedSurname!, profileSurname!),
  );

  // firstName + middleName, for the same reason crossCheckPassportIdentity
  // combines them: the MRZ routinely carries a middle name in givenNames
  // that we keep in its own column.
  const profileGivenNames =
    [profile.firstName, profile.middleName]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join(" ") || null;
  const extractedGivenNames = extraction.givenNames || null;
  push("givenNames", profileGivenNames, extractedGivenNames, () =>
    namesTolerantMatch(extractedGivenNames!, profileGivenNames!),
  );

  const profileDob = (profile.dob || "").trim() || null;
  const extractedDob = extraction.dateOfBirth ? resolveMrzDate(extraction.dateOfBirth, "dob") : null;
  push("dateOfBirth", profileDob, extractedDob, () => extractedDob === profileDob);

  const profilePassportNo = (profile.passportNo || "").trim() || null;
  const extractedDocumentNumber = extraction.documentNumber || null;
  push("documentNumber", profilePassportNo, extractedDocumentNumber, () =>
    normaliseDocumentNumber(extractedDocumentNumber!) === normaliseDocumentNumber(profilePassportNo!),
  );

  const profileExpiry = (profile.passportExpiry || "").trim() || null;
  const extractedExpiry = extraction.dateOfExpiry ? resolveMrzDate(extraction.dateOfExpiry, "expiry") : null;
  push("dateOfExpiry", profileExpiry, extractedExpiry, () => extractedExpiry === profileExpiry);

  // SEX is compared in MRZ terms on both sides — our free-text gender goes
  // through the same mapping the composed MRZ uses, so "Male" vs "M" is a
  // match rather than a discrepancy. An unspecified value on EITHER side
  // ("<", or an absent gender, which maps to "<") is NOT_COMPARABLE: "<"
  // means "the document doesn't say", and two sources both saying nothing
  // is not agreement.
  const profileSex = (profile.gender || "").trim() ? mrzSexFromGender(profile.gender) : null;
  const extractedSex = extraction.sex && extraction.sex !== "<" ? extraction.sex.toUpperCase() : null;
  push(
    "sex",
    profileSex === "<" ? null : (profile.gender || "").trim() || null,
    extractedSex,
    () => profileSex === extractedSex,
  );

  // Countries fold to ISO-2 on both sides — the profile stores ISO-2 from
  // CountryPicker, the MRZ carries ISO-3/ICAO. A literal compare would
  // report "IN" vs "IND" as a mismatch on every Indian passport.
  const profileNationality = (profile.nationality || "").trim() || null;
  const extractedNationality = extraction.nationality || null;
  push("nationality", profileNationality, extractedNationality, () => {
    const a = normaliseToIso2(profileNationality);
    const b = normaliseToIso2(extractedNationality);
    // An unrecognised code on either side is not evidence of disagreement —
    // it is our table being incomplete. Treated as a match-by-abstention
    // rather than a mismatch we'd be asserting without knowing.
    return !a || !b ? true : a === b;
  });

  const profileIssueCountry = (profile.passportIssueCountry || "").trim() || null;
  const extractedIssuingState = extraction.issuingState || null;
  push("issuingState", profileIssueCountry, extractedIssuingState, () => {
    const a = normaliseToIso2(profileIssueCountry);
    const b = normaliseToIso2(extractedIssuingState);
    return !a || !b ? true : a === b;
  });

  const matchedCount = rows.filter((r) => r.status === "MATCH").length;
  const mismatchedCount = rows.filter((r) => r.status === "MISMATCH").length;
  const comparedCount = matchedCount + mismatchedCount;

  return {
    rows,
    comparedCount,
    matchedCount,
    mismatchedCount,
    matchPercent: comparedCount === 0 ? null : Math.round((matchedCount / comparedCount) * 100),
  };
}
