// apps/backend/src/utils/mrzCompose.ts
//
// Composes an ICAO 9303 TD3 Machine Readable Zone FROM the passport fields
// we hold on a TravellerProfile. Pure, deterministic, no I/O.
//
// THE DIRECTION MATTERS, AND IT IS THE OPPOSITE OF utils/mrz.ts.
// mrz.ts PARSES an MRZ read off a scan and verifies its five check digits —
// that verification is real, because the digits were printed by the issuing
// authority and we are checking someone else's arithmetic.
//
// This module goes the other way: it BUILDS the two lines from fields a
// human typed into our form. The output is a RENDERING of data we already
// hold, not evidence about a document. Two consequences, both load-bearing:
//
//   1. This module returns lines. It does NOT return check results, and it
//      must never grow a `verified: true` / `checksPassed` field. Computing
//      the check digits here and then "verifying" them would be checking our
//      own arithmetic against itself — it passes by construction, and a
//      green tick that cannot fail is worse than no tick, because a reader
//      takes it as confirmation the passport data is correct. It confirms
//      nothing of the kind: every digit here is derived from what was typed,
//      so a transposed passport number produces a perfectly "valid" MRZ of
//      the wrong document.
//      See infra/design/traveller-profile-tabs-2026-08-11.md §7.2(b).
//
//   2. The only real check available on this tab is against a SECOND source
//      — an MRZ actually extracted from an uploaded scan. That lives in
//      utils/passportCrossCheck.ts (comparePassportSources), not here.
//
// What this IS good for: visa forms and check-in desks ask for the MRZ
// line, airlines' DOCS fields are MRZ-shaped, and seeing the composed lines
// makes a mistyped passport number visible in a way a form field does not.
//
// TD3 layout is documented in full at the top of utils/mrz.ts; this file
// writes the same 2×44 grid that file reads.
import { computeCheckDigit } from "./mrz.js";
import { getCountryByIso2, normaliseToIso2 } from "./countryCodes.js";

const TD3_LINE_LENGTH = 44;
const TD3_NAME_FIELD_LENGTH = 39; // line 1, [5:44)
const TD3_DOCUMENT_NUMBER_LENGTH = 9; // line 2, [0:9)
const TD3_OPTIONAL_DATA_LENGTH = 14; // line 2, [28:42)

/* ─────────────────────────────────────────────────────────────────────
 * SEX — TD3 position [20] on line 2.
 *
 * ICAO 9303 permits exactly three values: "M", "F", and "<" for
 * unspecified. Our `gender` is a free string on the schema with a
 * Male/Female/Other UI, so the mapping has to be explicit rather than a
 * first-character grab — and "Other" maps to "<", the code that genuinely
 * means "the document does not state one", not to a guess between M and F.
 *
 * An ABSENT gender also maps to "<", and that is honest rather than a
 * fallback: "<" is TD3's own way of saying the field is unspecified, which
 * is exactly our state when we hold nothing. It is the one field on the
 * whole line that has a real "we don't know" encoding, so it does not need
 * to block composition the way an unmapped country does.
 * ───────────────────────────────────────────────────────────────────── */
export type MrzSex = "M" | "F" | "<";

export function mrzSexFromGender(gender: string | null | undefined): MrzSex {
  const g = (gender || "").trim().toUpperCase();
  if (!g) return "<";
  if (g === "M" || g === "MALE") return "M";
  if (g === "F" || g === "FEMALE") return "F";
  // "Other", "Non-binary", "X", or anything unrecognised. Deliberately NOT
  // a prefix match on M/F — "MX" is not male.
  return "<";
}

/* ─────────────────────────────────────────────────────────────────────
 * ISSUING STATE / NATIONALITY — TD3 line 1 [2:5) and line 2 [10:13).
 *
 * Three letters. utils/countryCodes.ts already carries `iso3` for every
 * country the visa module knows, and its own comment states that field is
 * the "ISO 3166-1 alpha-3 / ICAO MRZ issuing-state code" — so that table is
 * the lookup, not a second one built here.
 *
 * ICAO Doc 9303 Part 3 does deviate from ISO 3166-1 alpha-3 in a handful of
 * places, and the deviations are enumerated below rather than assumed away.
 * Germany is the one that affects a country we actually hold: German
 * passports carry "D" (padded to "D<<"), never "DEU". Emitting DEU would
 * produce a line that no real German passport matches.
 *
 * countryCodes.ts is NOT edited to hold "D" instead: its iso3 is used
 * elsewhere as a genuine ISO alpha-3 (checklist data, rule matching), and
 * an MRZ-specific deviation belongs in the MRZ module.
 *
 * UNMAPPED COUNTRY => null => NO MRZ AT ALL. Guessing three letters from a
 * country name ("Switzerland" -> "SWI", which is wrong; it is CHE) would
 * put a fabricated issuing state into a rendered passport artifact. The
 * design doc calls this out directly (§7.2a): an unmapped country renders
 * no MRZ rather than a guessed code.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * ICAO 9303 codes that differ from the ISO 3166-1 alpha-3 code in
 * countryCodes.ts, keyed by ISO-2. Kept explicit and tiny — every entry is
 * a documented deviation, and the absence of an entry means "ISO alpha-3 is
 * the ICAO code", which is true for the rest of the table.
 */
const ICAO_CODE_OVERRIDES: Readonly<Record<string, string>> = {
  // ICAO 9303 Part 3, the one deviation in our country set: Germany is "D".
  DE: "D",
};

/**
 * Resolve anything we might hold in a country field — an ISO-2 code (what
 * CountryPicker stores), an ISO-3, a country name, or a demonym off an OCR
 * read — to the 3-character ICAO issuing-state code, UNPADDED.
 *
 * Returns null for anything the country table doesn't recognise. Callers
 * must treat null as "cannot compose", never as "use a default".
 */
export function icaoCountryCode(input: string | null | undefined): string | null {
  const iso2 = normaliseToIso2(input);
  if (!iso2) return null;

  const override = ICAO_CODE_OVERRIDES[iso2];
  if (override) return override;

  const entry = getCountryByIso2(iso2);
  return entry?.iso3 ?? null;
}

/* ─────────────────────────────────────────────────────────────────────
 * NAMES — TD3 line 1 [5:44), 39 characters.
 *
 * Format: PRIMARY<<SECONDARY, with "<" for every space between name
 * components and "<" filling the remainder of the field.
 *
 * Transliteration follows ICAO 9303 Part 3's table for the characters it
 * actually specifies (the German/Nordic expansions, where a diacritic
 * becomes TWO letters and dropping it would be wrong: Ä -> AE, not A).
 * Everything else is folded to its base Latin letter via Unicode NFD, which
 * is the correct treatment for the accents that merely decorate a letter
 * (É -> E).
 *
 * Punctuation — space, hyphen, apostrophe, period — becomes "<". This
 * matches how this codebase ALREADY compares names: passportCrossCheck.ts's
 * normaliseNameTokens turns exactly `.-'` into separators before token
 * matching, so "O'NEILL" tokenises to O + NEILL there and composes to
 * "O<NEILL" here — the two agree, and a name that round-trips through
 * parseTD3Mrz (which turns "<" back into a space) lands on the same tokens
 * it started with.
 * ───────────────────────────────────────────────────────────────────── */

// ICAO 9303 Part 3 multi-character transliterations. These MUST run before
// the NFD fold, or "Ä" would decompose to "A" + combining diaeresis and
// lose the "E".
const ICAO_TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Ä/g, "AE"],
  [/Ö/g, "OE"],
  [/Ü/g, "UE"],
  [/ß/g, "SS"],
  [/Å/g, "AA"],
  [/Æ/g, "AE"],
  [/Ø/g, "OE"],
  [/Ñ/g, "N"],
  [/Ð/g, "D"],
  [/Þ/g, "TH"],
];

export function mrzNamePart(input: string): string {
  let s = (input || "").toUpperCase();
  for (const [pattern, replacement] of ICAO_TRANSLITERATIONS) s = s.replace(pattern, replacement);

  return s
    // Fold remaining diacritics onto their base letter (É -> E). The range
    // is written as escapes, not literal combining marks — a combining
    // character in source is invisible and the next editor would delete it
    // by accident.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Separators — see the block comment. Collapsed below, so a double
    // space or a " - " never produces a run of empty components.
    .replace(/[\s.\-']+/g, "<")
    // Anything still not in the MRZ charset (digits are legal in the
    // charset but never appear in a name; genuinely foreign scripts that
    // survived NFD) is dropped rather than guessed at.
    .replace(/[^A-Z<]/g, "")
    .replace(/<+/g, "<")
    .replace(/^<|<$/g, "");
}

/**
 * The 39-character name field. Truncation is reported, never silent: a
 * truncated MRZ is still the correct format (ICAO specifies truncation for
 * long names) but the reader should know the line is not the whole name.
 */
function composeNameField(surname: string, givenNames: string): { field: string; truncated: boolean } {
  const primary = mrzNamePart(surname);
  const secondary = mrzNamePart(givenNames);
  const joined = secondary ? `${primary}<<${secondary}` : primary;

  if (joined.length > TD3_NAME_FIELD_LENGTH) {
    return { field: joined.slice(0, TD3_NAME_FIELD_LENGTH), truncated: true };
  }
  return { field: joined.padEnd(TD3_NAME_FIELD_LENGTH, "<"), truncated: false };
}

/* ─────────────────────────────────────────────────────────────────────
 * DATES — "YYYY-MM-DD" (how TravellerProfile stores every date) to the
 * "YYMMDD" the MRZ carries.
 *
 * Returns null for anything that isn't a real calendar date, so a malformed
 * stored value blocks composition rather than producing six characters that
 * happen to fit. The inverse of utils/mrz.ts's resolveMrzDate.
 * ───────────────────────────────────────────────────────────────────── */
export function mrzDateFromIso(iso: string | null | undefined): string | null {
  const s = (iso || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;

  const [, yyyy, mm, dd] = m;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);

  // Round-trip through a real Date to reject 31 February and friends —
  // same guard, and the same reasoning, as resolveMrzDate.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }

  return `${yyyy.slice(2)}${mm}${dd}`;
}

// MRZ document numbers carry no spaces or hyphens; a passport number typed
// as "A 1234567" is the same number.
function normaliseDocumentNumber(s: string): string {
  return (s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/* ─────────────────────────────────────────────────────────────────────
 * COMPOSE
 * ───────────────────────────────────────────────────────────────────── */

/** Exactly the TravellerProfile keys this needs — no model import. */
export interface MrzComposeInput {
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
 * Which profile field is missing or unusable, and why — in the field names
 * the UI already labels, so the surface can say "add your issuing country"
 * instead of "MRZ unavailable".
 */
export interface MrzComposeGap {
  field: keyof MrzComposeInput;
  reason: string;
}

export interface ComposedTD3Mrz {
  line1: string; // exactly 44 characters
  line2: string; // exactly 44 characters
  /** The 3-char codes actually used, so the UI can show what was derived. */
  issuingState: string;
  nationality: string;
  sex: MrzSex;
  /** The name did not fit TD3's 39 characters and was cut. */
  nameTruncated: boolean;
}

/**
 * Each variant declares the OTHER variant's key as optional-undefined. That
 * is not decoration: this package compiles with `strictNullChecks: false`
 * (apps/backend/tsconfig.json, "compatibility mode"), which weakens
 * discriminated-union narrowing enough that `if (result.ok) {} else {}` does
 * not reliably expose `gaps` in the else branch. Spelling both keys on both
 * members means callers can read either without a cast, and the `ok`
 * discriminant still says which one is meaningful.
 */
export type MrzComposeResult =
  | { ok: true; mrz: ComposedTD3Mrz; gaps?: undefined }
  | { ok: false; gaps: MrzComposeGap[]; mrz?: undefined };

/**
 * Build the two TD3 lines, or explain what is missing.
 *
 * ALL-OR-NOTHING. A partial MRZ is not a useful artifact — it is a
 * passport-shaped string with holes in it, and the holes are invisible once
 * it's rendered in a monospace box. Every gap is reported at once (not
 * first-failure) so the surface can list everything the person needs to
 * fill rather than making them discover the fields one save at a time.
 *
 * Note what is NOT returned: any notion of validity, verification, or
 * check-digit success. See this file's header — the check digits are
 * computed here as part of BUILDING the line, and re-reading them back as
 * a "verified" result would be circular.
 */
export function composeTD3Mrz(input: MrzComposeInput): MrzComposeResult {
  const gaps: MrzComposeGap[] = [];

  const surname = (input.lastName || "").trim();
  if (!mrzNamePart(surname)) {
    gaps.push({ field: "lastName", reason: "Surname is needed for the MRZ name field" });
  }
  const givenNames = [input.firstName, input.middleName]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" ");
  if (!mrzNamePart(givenNames)) {
    gaps.push({ field: "firstName", reason: "Given names are needed for the MRZ name field" });
  }

  const issuingState = icaoCountryCode(input.passportIssueCountry);
  if (!issuingState) {
    gaps.push({
      field: "passportIssueCountry",
      reason: (input.passportIssueCountry || "").trim()
        ? // Named explicitly rather than folded into "missing": the person
          // HAS filled the field, and telling them it's blank would send
          // them to re-enter something that is already there.
          `We don't hold an ICAO code for "${String(input.passportIssueCountry).trim()}"`
        : "Issuing country is needed for the MRZ",
    });
  }

  const nationality = icaoCountryCode(input.nationality);
  if (!nationality) {
    gaps.push({
      field: "nationality",
      reason: (input.nationality || "").trim()
        ? `We don't hold an ICAO code for "${String(input.nationality).trim()}"`
        : "Nationality is needed for the MRZ",
    });
  }

  const documentNumber = normaliseDocumentNumber(input.passportNo || "");
  if (!documentNumber) {
    gaps.push({ field: "passportNo", reason: "Passport number is needed for the MRZ" });
  } else if (documentNumber.length > TD3_DOCUMENT_NUMBER_LENGTH) {
    // TD3's document-number field is 9 characters. ICAO does define an
    // overflow mechanism that spills the remainder into the optional-data
    // field, and it is NOT implemented here — but truncating to 9 would
    // render a passport number that isn't this person's, in the one place
    // on the page that looks authoritative. Refusing is the honest answer.
    gaps.push({
      field: "passportNo",
      reason: `Passport numbers longer than ${TD3_DOCUMENT_NUMBER_LENGTH} characters don't fit the TD3 format we compose`,
    });
  }

  const dob = mrzDateFromIso(input.dob);
  if (!dob) {
    gaps.push({
      field: "dob",
      reason: (input.dob || "").trim() ? "Date of birth isn't a valid date" : "Date of birth is needed for the MRZ",
    });
  }

  const expiry = mrzDateFromIso(input.passportExpiry);
  if (!expiry) {
    gaps.push({
      field: "passportExpiry",
      reason: (input.passportExpiry || "").trim()
        ? "Passport expiry isn't a valid date"
        : "Passport expiry is needed for the MRZ",
    });
  }

  if (gaps.length) return { ok: false, gaps };

  // Every value below is non-null — the gap checks above are exhaustive
  // over exactly these.
  const sex = mrzSexFromGender(input.gender);
  const name = composeNameField(surname, givenNames);

  const line1 = `P<${issuingState!.padEnd(3, "<")}${name.field}`;

  const documentNumberField = documentNumber.padEnd(TD3_DOCUMENT_NUMBER_LENGTH, "<");
  const documentNumberCheck = String(computeCheckDigit(documentNumberField));
  const dobCheck = String(computeCheckDigit(dob!));
  const expiryCheck = String(computeCheckDigit(expiry!));

  // We hold no personal number, so the optional-data field is entirely
  // filler. ICAO allows the check character to be "<" in exactly that case,
  // and utils/mrz.ts's parser accepts "<" ONLY when the field is all filler
  // — which it is. A computed "0" here would also parse, but "<" is what a
  // real passport with no personal number prints.
  const optionalData = "<".repeat(TD3_OPTIONAL_DATA_LENGTH);
  const optionalDataCheck = "<";

  const compositeInput =
    documentNumberField +
    documentNumberCheck +
    dob! +
    dobCheck +
    expiry! +
    expiryCheck +
    optionalData +
    optionalDataCheck;
  const compositeCheck = String(computeCheckDigit(compositeInput));

  const line2 =
    documentNumberField +
    documentNumberCheck +
    nationality!.padEnd(3, "<") +
    dob! +
    dobCheck +
    sex +
    expiry! +
    expiryCheck +
    optionalData +
    optionalDataCheck +
    compositeCheck;

  // Structural guard, not a data claim: if either line isn't 44 characters
  // the bug is in this function, and emitting a malformed line is worse
  // than emitting none. Reported as a gap on the field most likely to have
  // caused it rather than thrown, since callers render gaps and nothing
  // here should ever 500 a profile fetch.
  if (line1.length !== TD3_LINE_LENGTH || line2.length !== TD3_LINE_LENGTH) {
    return {
      ok: false,
      gaps: [{ field: "passportNo", reason: "The passport details on file don't compose into a valid MRZ" }],
    };
  }

  return {
    ok: true,
    mrz: {
      line1,
      line2,
      issuingState: issuingState!,
      nationality: nationality!,
      sex,
      nameTruncated: name.truncated,
    },
  };
}
