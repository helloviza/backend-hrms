// Coverage for utils/mrzCompose.ts — TD3 MRZ composition FROM stored
// profile fields (the inverse of utils/mrz.ts, which parses one off a scan).
//
// The check-digit assertions here are anchored on the ICAO 9303 specimen
// passport (Anna Maria Eriksson, document L898902C3, born 1974-08-12,
// expiring 2012-04-15, F) whose published MRZ is:
//
//   P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<
//   L898902C36UTO7408122F1204159ZE184226B<<<<<10
//
// The three FIELD check digits in that published line — 6 (document
// number), 2 (date of birth), 9 (date of expiry) — are computed by ICAO,
// not by us, so asserting our composition reproduces them is a real
// external check rather than a restatement of our own arithmetic.
//
// (The composite digit is deliberately NOT compared against the specimen's
// "0": that digit covers the optional-data field, and the specimen carries a
// personal number "ZE184226B" where we hold none. The composite is covered
// instead by round-tripping through parseTD3Mrz — an independently written
// parser in a different module — and asserting every check passes there.)
//
// Issuing state differs from the specimen too (UTO is ICAO's fictional
// "Utopia" and is not a real country in countryCodes.ts, correctly), which
// is irrelevant to all three of those digits: none of them covers line 1 or
// the nationality field.
import { describe, it, expect } from "vitest";
import {
  composeTD3Mrz,
  icaoCountryCode,
  mrzDateFromIso,
  mrzNamePart,
  mrzSexFromGender,
} from "./mrzCompose.js";
import { parseTD3Mrz } from "./mrz.js";

/** The ICAO specimen's data, with a real (Indian) issuing state/nationality. */
const SPECIMEN = {
  firstName: "Anna",
  middleName: "Maria",
  lastName: "Eriksson",
  gender: "Female",
  dob: "1974-08-12",
  nationality: "IN",
  passportNo: "L898902C3",
  passportExpiry: "2012-04-15",
  passportIssueCountry: "IN",
};

function composed(input: Partial<typeof SPECIMEN> = {}) {
  const result = composeTD3Mrz({ ...SPECIMEN, ...input });
  if (!result.ok) throw new Error(`expected composition to succeed, gaps: ${JSON.stringify(result.gaps)}`);
  return result.mrz;
}

describe("mrzSexFromGender", () => {
  it("maps the UI's three options", () => {
    expect(mrzSexFromGender("Male")).toBe("M");
    expect(mrzSexFromGender("Female")).toBe("F");
    // "Other" is NOT guessed into M or F — "<" is TD3's own code for
    // unspecified, and it is the only honest answer here.
    expect(mrzSexFromGender("Other")).toBe("<");
  });

  it("is case- and whitespace-insensitive, and accepts the bare codes", () => {
    expect(mrzSexFromGender("  male ")).toBe("M");
    expect(mrzSexFromGender("FEMALE")).toBe("F");
    expect(mrzSexFromGender("m")).toBe("M");
    expect(mrzSexFromGender("F")).toBe("F");
  });

  it("maps absent/unknown to '<' rather than defaulting to a sex", () => {
    expect(mrzSexFromGender("")).toBe("<");
    expect(mrzSexFromGender(null)).toBe("<");
    expect(mrzSexFromGender(undefined)).toBe("<");
    expect(mrzSexFromGender("Non-binary")).toBe("<");
    // Deliberately not a prefix match: "MX" is not male.
    expect(mrzSexFromGender("Mx")).toBe("<");
  });
});

describe("icaoCountryCode", () => {
  it("resolves ISO-2 (what CountryPicker stores) to the ICAO 3-letter code", () => {
    expect(icaoCountryCode("IN")).toBe("IND");
    expect(icaoCountryCode("US")).toBe("USA");
    expect(icaoCountryCode("GB")).toBe("GBR");
  });

  it("resolves names, demonyms and ISO-3 too, since country fields hold all of them", () => {
    expect(icaoCountryCode("India")).toBe("IND");
    expect(icaoCountryCode("Indian")).toBe("IND");
    expect(icaoCountryCode("IND")).toBe("IND");
    expect(icaoCountryCode("  united arab emirates ")).toBe("ARE");
  });

  it("applies the ICAO deviation for Germany — 'D', never 'DEU'", () => {
    // ICAO 9303 Part 3: German passports carry "D" in the issuing-state
    // field. countryCodes.ts holds the ISO alpha-3 "DEU" (correct for its
    // own uses); emitting that here would produce a line no real German
    // passport matches.
    expect(icaoCountryCode("DE")).toBe("D");
    expect(icaoCountryCode("Germany")).toBe("D");
    expect(icaoCountryCode("German")).toBe("D");
  });

  it("returns null for an unmapped country rather than guessing three letters", () => {
    expect(icaoCountryCode("Narnia")).toBeNull();
    expect(icaoCountryCode("")).toBeNull();
    expect(icaoCountryCode(null)).toBeNull();
    expect(icaoCountryCode(undefined)).toBeNull();
  });
});

describe("mrzDateFromIso", () => {
  it("converts the stored YYYY-MM-DD to the MRZ's YYMMDD", () => {
    expect(mrzDateFromIso("1974-08-12")).toBe("740812");
    expect(mrzDateFromIso("2012-04-15")).toBe("120415");
    expect(mrzDateFromIso("2004-01-02")).toBe("040102");
  });

  it("rejects malformed and calendar-invalid dates instead of emitting six characters", () => {
    expect(mrzDateFromIso("")).toBeNull();
    expect(mrzDateFromIso(null)).toBeNull();
    expect(mrzDateFromIso("12-04-15")).toBeNull();
    expect(mrzDateFromIso("2012/04/15")).toBeNull();
    expect(mrzDateFromIso("2012-04-15T00:00:00Z")).toBeNull();
    // Real format, impossible day — must not silently roll over to 3 March.
    expect(mrzDateFromIso("2011-02-30")).toBeNull();
    expect(mrzDateFromIso("2012-13-01")).toBeNull();
  });
});

describe("mrzNamePart", () => {
  it("uppercases and turns spaces into filler", () => {
    expect(mrzNamePart("Anna Maria")).toBe("ANNA<MARIA");
  });

  it("applies the ICAO multi-character transliterations", () => {
    // Ä -> AE, not A: dropping the diacritic outright would lose a letter
    // the issuing state actually prints.
    expect(mrzNamePart("Müller")).toBe("MUELLER");
    expect(mrzNamePart("Ärnström")).toBe("AERNSTROEM");
    expect(mrzNamePart("Åkesson")).toBe("AAKESSON");
    expect(mrzNamePart("Løken")).toBe("LOEKEN");
  });

  it("folds ordinary accents onto their base letter", () => {
    expect(mrzNamePart("Éric")).toBe("ERIC");
    expect(mrzNamePart("Françoise")).toBe("FRANCOISE");
  });

  it("turns punctuation into filler and never leaves a stray run", () => {
    expect(mrzNamePart("O'Neill")).toBe("O<NEILL");
    expect(mrzNamePart("Smith-Jones")).toBe("SMITH<JONES");
    expect(mrzNamePart("  Anna   Maria  ")).toBe("ANNA<MARIA");
    expect(mrzNamePart("J. R. Smith")).toBe("J<R<SMITH");
  });
});

describe("composeTD3Mrz — the composed lines", () => {
  it("produces two lines of exactly 44 characters in the MRZ charset", () => {
    const mrz = composed();
    expect(mrz.line1).toHaveLength(44);
    expect(mrz.line2).toHaveLength(44);
    expect(mrz.line1).toMatch(/^[A-Z0-9<]+$/);
    expect(mrz.line2).toMatch(/^[A-Z0-9<]+$/);
  });

  it("lays out line 1 as P< + issuing state + SURNAME<<GIVEN<NAMES, filler-padded", () => {
    const mrz = composed();
    expect(mrz.line1).toBe("P<INDERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<");
    expect(mrz.line1.slice(0, 2)).toBe("P<");
    expect(mrz.line1.slice(2, 5)).toBe("IND");
  });

  it("reproduces the ICAO specimen's published FIELD check digits", () => {
    const mrz = composed();
    // Document number: specimen prints 6 at position [9].
    expect(mrz.line2.slice(0, 9)).toBe("L898902C3");
    expect(mrz.line2[9]).toBe("6");
    // Date of birth: specimen prints 2 at position [19].
    expect(mrz.line2.slice(13, 19)).toBe("740812");
    expect(mrz.line2[19]).toBe("2");
    // Date of expiry: specimen prints 9 at position [27].
    expect(mrz.line2.slice(21, 27)).toBe("120415");
    expect(mrz.line2[27]).toBe("9");
  });

  it("places sex and nationality where TD3 says", () => {
    const mrz = composed();
    expect(mrz.line2.slice(10, 13)).toBe("IND");
    expect(mrz.line2[20]).toBe("F");
    expect(mrz.sex).toBe("F");
    expect(composed({ gender: "Other" }).line2[20]).toBe("<");
  });

  it("leaves optional data as filler with a '<' check character, as a passport with no personal number does", () => {
    const mrz = composed();
    expect(mrz.line2.slice(28, 42)).toBe("<".repeat(14));
    expect(mrz.line2[42]).toBe("<");
  });

  it("uses ICAO's 'D' for a German passport", () => {
    const mrz = composed({ passportIssueCountry: "DE", nationality: "DE" });
    // "D" padded to three characters — exactly what a German passport prints.
    expect(mrz.line1.slice(2, 5)).toBe("D<<");
    expect(mrz.line2.slice(10, 13)).toBe("D<<");
    expect(mrz.issuingState).toBe("D");
  });

  it("pads a short passport number to the 9-character field before checking it", () => {
    const mrz = composed({ passportNo: "Z999999" });
    expect(mrz.line2.slice(0, 9)).toBe("Z999999<<");
  });

  it("strips spaces and hyphens from a passport number typed with them", () => {
    expect(composed({ passportNo: "l89-8902 c3" }).line2.slice(0, 9)).toBe("L898902C3");
  });

  /* ── The round trip ───────────────────────────────────────────────────
   * Composition is verified here by parsing the result with parseTD3Mrz —
   * a separately written parser in another module — and requiring every
   * check digit to pass and every field to come back as it went in.
   *
   * This is a TEST-ONLY check and it is NOT what the UI renders. Shipping
   * this same "all check digits pass" result as a green tick over a
   * self-composed MRZ is exactly what the design doc forbids (§7.2b): in
   * production both halves are our own arithmetic over our own fields, so
   * it can never fail and therefore tells a user nothing. Here it has real
   * value, because it is checking that two independent implementations
   * agree on a fixed known input.
   * ─────────────────────────────────────────────────────────────────── */
  it("round-trips through the independent parser with every check digit passing", () => {
    const mrz = composed();
    const parsed = parseTD3Mrz(mrz.line1, mrz.line2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.result.checks.every((c) => c.passed)).toBe(true);
    expect(parsed.result.surname).toBe("ERIKSSON");
    expect(parsed.result.givenNames).toBe("ANNA MARIA");
    expect(parsed.result.documentNumber).toBe("L898902C3");
    expect(parsed.result.dateOfBirth).toBe("740812");
    expect(parsed.result.dateOfExpiry).toBe("120415");
    expect(parsed.result.sex).toBe("F");
    expect(parsed.result.issuingState).toBe("IND");
    expect(parsed.result.nationality).toBe("IND");
  });

  it("round-trips for a name carrying transliterations and punctuation", () => {
    const mrz = composed({ firstName: "Jean-Éric", middleName: "", lastName: "Müller" });
    const parsed = parseTD3Mrz(mrz.line1, mrz.line2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.checks.every((c) => c.passed)).toBe(true);
    expect(parsed.result.surname).toBe("MUELLER");
    expect(parsed.result.givenNames).toBe("JEAN ERIC");
  });
});

describe("composeTD3Mrz — refusing to compose", () => {
  function gapsFor(input: Partial<typeof SPECIMEN>) {
    const result = composeTD3Mrz({ ...SPECIMEN, ...input });
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.gaps.map((g) => g.field);
  }

  it("renders NO MRZ for a country it cannot map, rather than guessing a code", () => {
    expect(gapsFor({ passportIssueCountry: "Narnia" })).toContain("passportIssueCountry");
    expect(gapsFor({ nationality: "Narnia" })).toContain("nationality");
  });

  it("says the country is unrecognised, not missing, when the field IS filled", () => {
    const result = composeTD3Mrz({ ...SPECIMEN, passportIssueCountry: "Narnia" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const gap = result.gaps.find((g) => g.field === "passportIssueCountry");
    // Sending someone to re-enter a value that is already there would be
    // the wrong instruction.
    expect(gap?.reason).toContain("Narnia");
    expect(gap?.reason).not.toContain("is needed");
  });

  it("refuses on each missing required field", () => {
    expect(gapsFor({ passportNo: "" })).toContain("passportNo");
    expect(gapsFor({ dob: "" })).toContain("dob");
    expect(gapsFor({ passportExpiry: "" })).toContain("passportExpiry");
    expect(gapsFor({ lastName: "" })).toContain("lastName");
    // Given names are firstName + middleName combined, so BOTH must be
    // empty for the field to be missing — the gap is reported against
    // firstName as the representative key.
    expect(gapsFor({ firstName: "", middleName: "" })).toContain("firstName");
  });

  it("still composes from a middle name alone, since given names are the two combined", () => {
    // Not a loophole — TravellerProfile requires firstName at the schema
    // level, so this is defensive rather than a real state. Asserted so the
    // combining rule is explicit rather than incidental.
    const result = composeTD3Mrz({ ...SPECIMEN, firstName: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mrz.line1).toContain("ERIKSSON<<MARIA");
  });

  it("refuses rather than truncating a passport number that doesn't fit TD3", () => {
    // Truncating to 9 would render a number that is not this person's, in
    // the one place on the page that looks authoritative.
    const gaps = gapsFor({ passportNo: "ABCDEFGHIJKL" });
    expect(gaps).toContain("passportNo");
  });

  it("reports EVERY gap at once, not just the first", () => {
    const result = composeTD3Mrz({
      ...SPECIMEN,
      passportNo: "",
      dob: "",
      passportIssueCountry: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.gaps.map((g) => g.field);
    expect(fields).toEqual(expect.arrayContaining(["passportNo", "dob", "passportIssueCountry"]));
  });

  it("does NOT refuse over an absent gender — '<' is a real TD3 value", () => {
    const result = composeTD3Mrz({ ...SPECIMEN, gender: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mrz.sex).toBe("<");
    expect(result.mrz.line2[20]).toBe("<");
  });

  it("flags a name too long for the 39-character field instead of silently cutting it", () => {
    const result = composeTD3Mrz({
      ...SPECIMEN,
      lastName: "Nilavadhanananda Wongsawatkulchai",
      firstName: "Chayapa Dejthongdeun Praphaphorn",
      middleName: "Somchai",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mrz.nameTruncated).toBe(true);
    expect(result.mrz.line1).toHaveLength(44);
  });
});
