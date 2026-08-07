// Unit coverage for visaAttributes.ts's predicate evaluator, most-specific
// rule selection, DOB->age derivation, and the corporate-defaults deriver.
// All pure functions — no DB, no mongoose connection needed.
import { describe, it, expect } from "vitest";
import {
  evaluateApplicantPredicate,
  selectMostSpecificRule,
  computeAgeFromDob,
  deriveCorporateApplicantProfileDefaults,
} from "./visaAttributes.js";

describe("evaluateApplicantPredicate", () => {
  it("matches everyone when the predicate is empty, undefined, or null (the fallback case)", () => {
    expect(evaluateApplicantPredicate(undefined, {})).toBe(true);
    expect(evaluateApplicantPredicate(null, { employmentStatus: "EMPLOYED" })).toBe(true);
    expect(evaluateApplicantPredicate([], { employmentStatus: "EMPLOYED" })).toBe(true);
  });

  it("matches on a single `equals` condition", () => {
    const predicate = [{ field: "holdsUsVisa" as const, equals: true }];
    expect(evaluateApplicantPredicate(predicate, { holdsUsVisa: true })).toBe(true);
    expect(evaluateApplicantPredicate(predicate, { holdsUsVisa: false })).toBe(false);
    expect(evaluateApplicantPredicate(predicate, {})).toBe(false);
  });

  it("matches on an `in` condition", () => {
    const predicate = [{ field: "employmentStatus" as const, in: ["SELF_EMPLOYED", "RETIRED"] }];
    expect(evaluateApplicantPredicate(predicate, { employmentStatus: "SELF_EMPLOYED" })).toBe(true);
    expect(evaluateApplicantPredicate(predicate, { employmentStatus: "STUDENT" })).toBe(false);
  });

  it("ANDs multiple conditions — all must match", () => {
    const predicate = [
      { field: "holdsUsVisa" as const, equals: true },
      { field: "maritalStatus" as const, equals: "MARRIED" },
    ];
    expect(evaluateApplicantPredicate(predicate, { holdsUsVisa: true, maritalStatus: "MARRIED" })).toBe(true);
    expect(evaluateApplicantPredicate(predicate, { holdsUsVisa: true, maritalStatus: "SINGLE" })).toBe(false);
  });

  it("never matches a malformed condition (neither equals nor in) — fails closed", () => {
    const predicate = [{ field: "holdsUsVisa" as const }];
    expect(evaluateApplicantPredicate(predicate, { holdsUsVisa: true })).toBe(false);
  });

  it("still matches an `equals` condition once Mongoose has round-tripped it (in: [] present, not undefined)", () => {
    // Reproduces the real shape read back from the DB: the schema's `in`
    // path is an array type, so Mongoose defaults it to [] on every
    // condition even when only `equals` was ever authored — an `equals`
    // condition arrives with BOTH fields set, not just `equals`. Found live
    // via /visa/requirements browser verification (2026-08-07): every
    // `equals`-only appliesWhen condition in the DB was permanently
    // unsatisfiable before this fix, regardless of applicant profile.
    const predicate = [{ field: "maritalStatus" as const, equals: "MARRIED", in: [] }];
    expect(evaluateApplicantPredicate(predicate, { maritalStatus: "MARRIED" })).toBe(true);
    expect(evaluateApplicantPredicate(predicate, { maritalStatus: "SINGLE" })).toBe(false);
  });
});

describe("selectMostSpecificRule — the Canada case (task brief §5)", () => {
  const fallback = { id: "20-doc-checklist", applicability: undefined };
  const usVisaVariant = {
    id: "5-doc-checklist",
    applicability: [{ field: "holdsUsVisa" as const, equals: true }],
  };
  const candidates = [fallback, usVisaVariant];

  it("selects the variant when the applicant matches its predicate", () => {
    const result = selectMostSpecificRule(candidates, { holdsUsVisa: true });
    expect(result?.id).toBe("5-doc-checklist");
  });

  it("selects the fallback when the applicant does NOT match the variant's predicate", () => {
    const result = selectMostSpecificRule(candidates, { holdsUsVisa: false });
    expect(result?.id).toBe("20-doc-checklist");
  });

  it("selects the fallback when the applicant profile is empty/unknown", () => {
    const result = selectMostSpecificRule(candidates, {});
    expect(result?.id).toBe("20-doc-checklist");
  });

  it("returns null when nothing matches and there is no fallback", () => {
    const result = selectMostSpecificRule([usVisaVariant], { holdsUsVisa: false });
    expect(result).toBeNull();
  });

  it("picks the MOST specific of several matching variants (more conditions wins)", () => {
    const broad = { id: "broad", applicability: [{ field: "holdsUsVisa" as const, equals: true }] };
    const narrow = {
      id: "narrow",
      applicability: [
        { field: "holdsUsVisa" as const, equals: true },
        { field: "maritalStatus" as const, equals: "MARRIED" },
      ],
    };
    const result = selectMostSpecificRule([fallback, broad, narrow], {
      holdsUsVisa: true,
      maritalStatus: "MARRIED",
    });
    expect(result?.id).toBe("narrow");
  });
});

describe("computeAgeFromDob", () => {
  it("computes whole-years age as of a given date", () => {
    expect(computeAgeFromDob("2010-06-15", new Date("2026-06-15T00:00:00Z"))).toBe(16);
  });

  it("has not yet had this year's birthday", () => {
    expect(computeAgeFromDob("2010-06-15", new Date("2026-06-14T00:00:00Z"))).toBe(15);
  });

  it("returns null for a missing dob", () => {
    expect(computeAgeFromDob(undefined)).toBeNull();
    expect(computeAgeFromDob(null)).toBeNull();
  });

  it("returns null for an unparseable dob rather than throwing", () => {
    expect(computeAgeFromDob("not-a-date")).toBeNull();
  });
});

describe("deriveCorporateApplicantProfileDefaults", () => {
  it("defaults employmentStatus=EMPLOYED and sponsorType=EMPLOYER for a workspace member", () => {
    const defaults = deriveCorporateApplicantProfileDefaults({ isWorkspaceMember: true });
    expect(defaults.employmentStatus).toBe("EMPLOYED");
    expect(defaults.sponsorType).toBe("EMPLOYER");
  });

  it("does not default employment/sponsor fields for a non-member (e.g. a family-member traveller profile)", () => {
    const defaults = deriveCorporateApplicantProfileDefaults({ isWorkspaceMember: false });
    expect(defaults.employmentStatus).toBeUndefined();
    expect(defaults.sponsorType).toBeUndefined();
  });

  it("derives isMinor from dob", () => {
    const asOf = new Date("2026-08-02T00:00:00Z");
    expect(deriveCorporateApplicantProfileDefaults({ isWorkspaceMember: false, dob: "2015-01-01", asOf }).isMinor).toBe(true);
    expect(deriveCorporateApplicantProfileDefaults({ isWorkspaceMember: false, dob: "1990-01-01", asOf }).isMinor).toBe(false);
  });

  it("leaves isMinor undefined when dob is unavailable — never guesses", () => {
    expect(deriveCorporateApplicantProfileDefaults({ isWorkspaceMember: true }).isMinor).toBeUndefined();
  });

  it("never fabricates isSponsored, invitationSource, maritalStatus, holdsUsVisa, holdsSchengenVisa — only asks what can't be inferred", () => {
    const defaults = deriveCorporateApplicantProfileDefaults({ isWorkspaceMember: true, dob: "1990-01-01" });
    expect(defaults.isSponsored).toBeUndefined();
    expect(defaults.invitationSource).toBeUndefined();
    expect(defaults.maritalStatus).toBeUndefined();
    expect(defaults.holdsUsVisa).toBeUndefined();
    expect(defaults.holdsSchengenVisa).toBeUndefined();
  });
});
