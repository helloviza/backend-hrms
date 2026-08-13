// Coverage for the Database Mismatch Check — comparePassportSources /
// readPassportExtraction / isUsablePassportExtraction in
// utils/passportCrossCheck.ts (Tab 2, 2026-08-11).
//
// The property under test throughout is that this compares TWO GENUINELY
// DIFFERENT SOURCES:
//   - what a human typed into the traveller profile, and
//   - an MRZ read off an uploaded passport scan (VisaDocument
//     .extractedFields, check-digit verified before storage).
//
// The failure mode these tests exist to prevent is a panel that claims
// agreement it never established: a match asserted where only one source
// holds the field, or a percentage over a denominator of zero. Both are
// covered explicitly below.
//
// The 0/1/2 SOURCE COUNTING itself lives in the route
// (resolvePassportVault) and is covered in
// routes/workspace.travellers.passportVault.test.ts — this file covers the
// comparator that the >=2 branch calls.
import { describe, it, expect } from "vitest";
import {
  comparePassportSources,
  readPassportExtraction,
  isUsablePassportExtraction,
  type PassportSourceExtraction,
  type PassportSourceProfile,
} from "./passportCrossCheck.js";

const PROFILE: PassportSourceProfile = {
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

// As services/visaPassportExtraction.ts actually stores it: MRZ-derived,
// dates RAW YYMMDD (ParsedMrz leaves the century unresolved), countries as
// ISO3/ICAO codes.
const EXTRACTION: PassportSourceExtraction = {
  surname: "ERIKSSON",
  givenNames: "ANNA MARIA",
  documentNumber: "L898902C3",
  nationality: "IND",
  issuingState: "IND",
  dateOfBirth: "740812",
  sex: "F",
  dateOfExpiry: "120415",
};

function statusOf(result: ReturnType<typeof comparePassportSources>, field: string) {
  return result.rows.find((r) => r.field === field)?.status;
}

describe("readPassportExtraction", () => {
  it("pulls the MRZ field values out of the stored key/value array", () => {
    const extraction = readPassportExtraction([
      { key: "surname", value: "ERIKSSON" },
      { key: "givenNames", value: "ANNA MARIA" },
      { key: "documentNumber", value: "L898902C3" },
      { key: "dateOfBirth", value: "740812" },
    ]);
    expect(extraction.surname).toBe("ERIKSSON");
    expect(extraction.documentNumber).toBe("L898902C3");
    expect(extraction.dateOfBirth).toBe("740812");
  });

  it("ignores the check_/viz_/identity_mismatch_ families that share the array", () => {
    // Those are check-digit results, unverified printed-page reads, and a
    // different cross-check's output — none of them are passport field
    // values, and treating any of them as one would compare the wrong thing.
    const extraction = readPassportExtraction([
      { key: "documentNumber", value: "L898902C3" },
      { key: "check_documentNumber", value: "passed" },
      { key: "viz_placeOfIssue", value: "BENGALURU" },
      { key: "identity_mismatch_surname_profile", value: "SHARMA" },
    ]);
    expect(extraction.documentNumber).toBe("L898902C3");
    expect(Object.values(extraction).filter(Boolean)).toEqual(["L898902C3"]);
  });

  it("survives an empty, null or malformed array", () => {
    expect(readPassportExtraction([]).documentNumber).toBeUndefined();
    expect(readPassportExtraction(null).documentNumber).toBeUndefined();
    expect(readPassportExtraction(undefined).documentNumber).toBeUndefined();
    expect(readPassportExtraction([{ key: "documentNumber", value: "   " }]).documentNumber).toBeUndefined();
  });
});

describe("isUsablePassportExtraction", () => {
  it("accepts an extraction carrying a document number", () => {
    expect(isUsablePassportExtraction(EXTRACTION)).toBe(true);
  });

  it("REJECTS a failed extraction, which still has an extractedFields array", () => {
    // markFailed writes { failureCategory, error } into the same array. If
    // that counted as a second source, the panel would render with every row
    // "not comparable" — which reads as "we checked and found nothing
    // wrong", the exact false assurance this whole feature avoids.
    const failed = readPassportExtraction([
      { key: "failureCategory", value: "NO_MRZ_FOUND" },
      { key: "error", value: "No MRZ detected in the image." },
    ]);
    expect(isUsablePassportExtraction(failed)).toBe(false);
  });
});

describe("comparePassportSources — a real two-source comparison", () => {
  it("reports every field as MATCH when the scan agrees with what was typed", () => {
    const result = comparePassportSources(PROFILE, EXTRACTION);
    expect(result.mismatchedCount).toBe(0);
    expect(result.comparedCount).toBe(8);
    expect(result.matchedCount).toBe(8);
    expect(result.matchPercent).toBe(100);
    expect(result.rows.every((r) => r.status === "MATCH")).toBe(true);
  });

  it("resolves the MRZ's raw YYMMDD before comparing dates", () => {
    // A literal string compare of "740812" against "1974-08-12" would
    // report a mismatch on every passport ever scanned.
    expect(statusOf(comparePassportSources(PROFILE, EXTRACTION), "dateOfBirth")).toBe("MATCH");
    expect(statusOf(comparePassportSources(PROFILE, EXTRACTION), "dateOfExpiry")).toBe("MATCH");
  });

  it("folds countries so ISO-2 on file matches the MRZ's ISO-3", () => {
    expect(statusOf(comparePassportSources(PROFILE, EXTRACTION), "nationality")).toBe("MATCH");
    expect(statusOf(comparePassportSources(PROFILE, EXTRACTION), "issuingState")).toBe("MATCH");
  });

  it("maps free-text gender through the MRZ sex codes", () => {
    expect(statusOf(comparePassportSources(PROFILE, EXTRACTION), "sex")).toBe("MATCH");
    expect(
      statusOf(comparePassportSources({ ...PROFILE, gender: "Male" }, EXTRACTION), "sex"),
    ).toBe("MISMATCH");
  });

  it("tolerates real-world name variation rather than reporting it as a discrepancy", () => {
    // Initials, a middle name on one side only, and reordering are all
    // ordinary — a mismatch here should mean something.
    expect(
      statusOf(comparePassportSources({ ...PROFILE, middleName: "" }, EXTRACTION), "givenNames"),
    ).toBe("MATCH");
    expect(
      statusOf(
        comparePassportSources({ ...PROFILE, firstName: "A.", middleName: "M." }, EXTRACTION),
        "givenNames",
      ),
    ).toBe("MATCH");
  });

  it("ignores spacing and hyphens in a passport number", () => {
    expect(
      statusOf(comparePassportSources({ ...PROFILE, passportNo: "L89-8902 C3" }, EXTRACTION), "documentNumber"),
    ).toBe("MATCH");
  });

  /* ── The output that actually matters ─────────────────────────────── */

  it("flags a genuinely different surname", () => {
    const result = comparePassportSources(PROFILE, { ...EXTRACTION, surname: "SHARMA" });
    expect(statusOf(result, "surname")).toBe("MISMATCH");
    expect(result.mismatchedCount).toBe(1);
    expect(result.matchPercent).toBe(88); // 7 of 8
  });

  it("flags a different date of birth", () => {
    const result = comparePassportSources(PROFILE, { ...EXTRACTION, dateOfBirth: "740811" });
    expect(statusOf(result, "dateOfBirth")).toBe("MISMATCH");
    const row = result.rows.find((r) => r.field === "dateOfBirth");
    // Both sides shown in display form so the panel can print them.
    expect(row?.profileValue).toBe("1974-08-12");
    expect(row?.extractedValue).toBe("1974-08-11");
  });

  it("flags a different passport number — the renewal case, surfaced not judged", () => {
    const result = comparePassportSources(PROFILE, { ...EXTRACTION, documentNumber: "Z9999999" });
    expect(statusOf(result, "documentNumber")).toBe("MISMATCH");
  });

  /* ── NOT_COMPARABLE — never counted as agreement ──────────────────── */

  it("marks a field only ONE source holds as NOT_COMPARABLE, never MATCH", () => {
    const result = comparePassportSources({ ...PROFILE, passportExpiry: "" }, EXTRACTION);
    expect(statusOf(result, "dateOfExpiry")).toBe("NOT_COMPARABLE");
    // Excluded from BOTH halves of the fraction — inventing agreement and
    // inventing a discrepancy are equally wrong here.
    expect(result.comparedCount).toBe(7);
    expect(result.matchedCount).toBe(7);
    expect(result.matchPercent).toBe(100);
  });

  it("treats an unspecified sex on either side as NOT_COMPARABLE, not agreement", () => {
    // "<" is the MRZ's "the document doesn't say". Two sources both saying
    // nothing is not two sources agreeing.
    expect(statusOf(comparePassportSources(PROFILE, { ...EXTRACTION, sex: "<" }), "sex")).toBe(
      "NOT_COMPARABLE",
    );
    expect(statusOf(comparePassportSources({ ...PROFILE, gender: "" }, EXTRACTION), "sex")).toBe(
      "NOT_COMPARABLE",
    );
    expect(
      statusOf(comparePassportSources({ ...PROFILE, gender: "Other" }, EXTRACTION), "sex"),
    ).toBe("NOT_COMPARABLE");
  });

  it("returns a NULL percentage when nothing was comparable at all", () => {
    // THE CENTRAL RULE. An empty profile against a real extraction shares no
    // field, so there is no fraction — and 100% (or 0%) here would be a
    // number computed from nothing. The client is required to render no
    // percentage when this is null.
    const result = comparePassportSources({}, EXTRACTION);
    expect(result.comparedCount).toBe(0);
    expect(result.matchedCount).toBe(0);
    expect(result.mismatchedCount).toBe(0);
    expect(result.matchPercent).toBeNull();
    expect(result.rows.every((r) => r.status === "NOT_COMPARABLE")).toBe(true);
  });

  it("does not report a mismatch for a country code our own table can't resolve", () => {
    // An unrecognised code is our lookup being incomplete, not evidence the
    // two sources disagree — asserting a mismatch would be a claim we can't
    // support either way.
    const result = comparePassportSources(PROFILE, { ...EXTRACTION, nationality: "XXA" });
    expect(statusOf(result, "nationality")).toBe("MATCH");
  });

  it("always returns one row per field, so the panel can't silently drop one", () => {
    const result = comparePassportSources({}, {});
    expect(result.rows.map((r) => r.field)).toEqual([
      "surname",
      "givenNames",
      "dateOfBirth",
      "documentNumber",
      "dateOfExpiry",
      "sex",
      "nationality",
      "issuingState",
    ]);
  });
});
