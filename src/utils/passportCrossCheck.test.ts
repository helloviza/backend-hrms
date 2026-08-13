// Unit coverage for the pure MRZ-vs-VIZ comparison (utils/passportCrossCheck.ts).
// Uses a real-shaped Indian passport (not the ICAO worked example from
// mrz.test.ts) so nationality normalisation ("IND" vs "INDIAN") has a real
// country to resolve against.
import { describe, it, expect } from "vitest";
import { crossCheckPassportFields, crossCheckPassportIdentity, type TravellerIdentityProfile } from "./passportCrossCheck.js";
import type { ParsedMrz } from "./mrz.js";
import type { PassportVizFields } from "../services/extractPassportGemini.js";

function mrz(overrides: Partial<ParsedMrz> = {}): ParsedMrz {
  return {
    documentType: "P",
    issuingState: "IND",
    surname: "JHA",
    givenNames: "SAURABH KUMAR",
    documentNumber: "C4097478",
    nationality: "IND",
    dateOfBirth: "930111", // -> 1993-01-11
    sex: "M",
    dateOfExpiry: "341112", // -> 2034-11-12
    checks: [],
    ...overrides,
  };
}

function viz(overrides: Partial<PassportVizFields> = {}): PassportVizFields {
  return {
    surname: "JHA",
    givenNames: "SAURABH KUMAR",
    dateOfBirth: "1993-01-11",
    documentNumber: "C4097478",
    dateOfExpiry: "2034-11-12",
    sex: "M",
    nationality: "INDIAN",
    dateOfIssue: "2024-11-13",
    placeOfBirth: "PATNA",
    placeOfIssue: "NEW DELHI",
    ...overrides,
  };
}

describe("crossCheckPassportFields", () => {
  it("reports no mismatches when every overlapping field agrees, even across format differences (demonym vs ISO3)", () => {
    expect(crossCheckPassportFields(mrz(), viz())).toEqual([]);
  });

  it("flags a genuine documentNumber mismatch", () => {
    expect(crossCheckPassportFields(mrz(), viz({ documentNumber: "C4097479" }))).toEqual([
      { field: "documentNumber", mrzValue: "C4097478", vizValue: "C4097479" },
    ]);
  });

  it("does not flag a documentNumber difference that's purely spacing/hyphen formatting", () => {
    expect(crossCheckPassportFields(mrz(), viz({ documentNumber: "C 409-7478" }))).toEqual([]);
  });

  it("flags a surname mismatch", () => {
    expect(crossCheckPassportFields(mrz(), viz({ surname: "SHARMA" }))).toEqual([
      { field: "surname", mrzValue: "JHA", vizValue: "SHARMA" },
    ]);
  });

  it("flags a givenNames mismatch", () => {
    expect(crossCheckPassportFields(mrz(), viz({ givenNames: "SAURABH" }))).toEqual([
      { field: "givenNames", mrzValue: "SAURABH KUMAR", vizValue: "SAURABH" },
    ]);
  });

  it("flags a dateOfBirth mismatch after resolving the MRZ's raw YYMMDD to YYYY-MM-DD", () => {
    expect(crossCheckPassportFields(mrz(), viz({ dateOfBirth: "1993-01-12" }))).toEqual([
      { field: "dateOfBirth", mrzValue: "1993-01-11", vizValue: "1993-01-12" },
    ]);
  });

  it("flags a dateOfExpiry mismatch", () => {
    expect(crossCheckPassportFields(mrz(), viz({ dateOfExpiry: "2034-11-13" }))).toEqual([
      { field: "dateOfExpiry", mrzValue: "2034-11-12", vizValue: "2034-11-13" },
    ]);
  });

  it("flags a sex mismatch", () => {
    expect(crossCheckPassportFields(mrz(), viz({ sex: "F" }))).toEqual([
      { field: "sex", mrzValue: "M", vizValue: "F" },
    ]);
  });

  it("flags a nationality mismatch across genuinely different countries, even through demonym normalisation", () => {
    expect(crossCheckPassportFields(mrz(), viz({ nationality: "AMERICAN" }))).toEqual([
      { field: "nationality", mrzValue: "IND", vizValue: "AMERICAN" },
    ]);
  });

  it("skips a field entirely when the VIZ read came back empty for it — that's a miss, not a mismatch", () => {
    expect(crossCheckPassportFields(mrz(), viz({ documentNumber: null, nationality: null }))).toEqual([]);
  });

  it("skips the nationality compare when either side doesn't resolve to a recognised country (no false mismatch on ICAO's fictional test country)", () => {
    expect(crossCheckPassportFields(mrz({ nationality: "UTO" }), viz({ nationality: "UTOPIAN" }))).toEqual([]);
  });

  it("returns no mismatches at all when every VIZ field is empty (a total VIZ miss)", () => {
    const empty: PassportVizFields = {
      surname: null,
      givenNames: null,
      dateOfBirth: null,
      documentNumber: null,
      dateOfExpiry: null,
      sex: null,
      nationality: null,
      dateOfIssue: null,
      placeOfBirth: null,
      placeOfIssue: null,
    };
    expect(crossCheckPassportFields(mrz(), empty)).toEqual([]);
  });
});

// Traveller-identity cross-check — does this passport belong to the
// traveller it was uploaded against? Uses the same worked-example MRZ
// (surname JHA, given names SAURABH KUMAR, dob 1993-01-11, documentNumber
// C4097478) throughout; each test varies exactly one profile field.
function profile(overrides: Partial<TravellerIdentityProfile> = {}): TravellerIdentityProfile {
  return {
    firstName: "Saurabh",
    middleName: "Kumar",
    lastName: "Jha",
    dob: "1993-01-11",
    passportNo: "C4097478",
    ...overrides,
  };
}

describe("crossCheckPassportIdentity", () => {
  it("reports no mismatches when the profile matches the passport exactly", () => {
    expect(crossCheckPassportIdentity(mrz(), profile())).toEqual([]);
  });

  it("flags a clear surname mismatch — zero token overlap between the two names", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ lastName: "Sharma" }))).toEqual([
      { field: "surname", severity: "MISMATCH", passportValue: "JHA", profileValue: "Sharma" },
    ]);
  });

  it("flags a clear given-names mismatch the same way", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ firstName: "Rohit", middleName: "Singh" }))).toEqual([
      { field: "givenNames", severity: "MISMATCH", passportValue: "SAURABH KUMAR", profileValue: "Rohit Singh" },
    ]);
  });

  it("does NOT flag initials on file against the passport's full given names ('S K' vs 'SAURABH KUMAR')", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ firstName: "S", middleName: "K" }))).toEqual([]);
  });

  it("does NOT flag a single dotted initial against the full given name ('S.' vs 'SAURABH')", () => {
    expect(
      crossCheckPassportIdentity(mrz({ givenNames: "SAURABH" }), profile({ firstName: "S.", middleName: null })),
    ).toEqual([]);
  });

  it("does NOT flag a middle name present on the passport but absent from the profile", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ firstName: "Saurabh", middleName: null }))).toEqual([]);
  });

  it("does NOT flag a middle name present on the profile but absent from the passport", () => {
    expect(
      crossCheckPassportIdentity(mrz({ givenNames: "SAURABH" }), profile({ firstName: "Saurabh", middleName: "Kumar" })),
    ).toEqual([]);
  });

  it("does NOT flag reordered given-name tokens ('Kumar Saurabh' vs 'SAURABH KUMAR')", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ firstName: "Kumar", middleName: "Saurabh" }))).toEqual([]);
  });

  it("does NOT flag case/punctuation-only differences in the surname (hyphen, apostrophe, mixed case)", () => {
    expect(crossCheckPassportIdentity(mrz({ surname: "AL-JHA" }), profile({ lastName: "al jha" }))).toEqual([]);
  });

  it("flags a date-of-birth mismatch when the profile already has one on file", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ dob: "1993-01-12" }))).toEqual([
      { field: "dateOfBirth", severity: "MISMATCH", passportValue: "1993-01-11", profileValue: "1993-01-12" },
    ]);
  });

  it("does not compare dateOfBirth at all when the profile has none on file yet", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ dob: null }))).toEqual([]);
  });

  it("a passport number differing from the one on file reads as DIFFERS_FROM_FILE, never MISMATCH", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ passportNo: "Z9999999" }))).toEqual([
      { field: "documentNumber", severity: "DIFFERS_FROM_FILE", passportValue: "C4097478", profileValue: "Z9999999" },
    ]);
  });

  it("does not flag a documentNumber difference that's purely spacing/hyphen formatting", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ passportNo: "C 409-7478" }))).toEqual([]);
  });

  it("does not compare documentNumber at all when the profile has none on file yet (first-ever upload)", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ passportNo: null }))).toEqual([]);
  });

  it("can report multiple mismatches at once, each independently", () => {
    expect(crossCheckPassportIdentity(mrz(), profile({ lastName: "Sharma", dob: "1990-01-01" }))).toEqual([
      { field: "surname", severity: "MISMATCH", passportValue: "JHA", profileValue: "Sharma" },
      { field: "dateOfBirth", severity: "MISMATCH", passportValue: "1993-01-11", profileValue: "1990-01-01" },
    ]);
  });
});
