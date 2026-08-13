// Unit coverage for visaAttributes.ts's predicate evaluator, most-specific
// rule selection, DOB->age derivation, and the corporate-defaults deriver.
// Nearly all pure functions — no DB needed. The one exception is the
// round-trip block at the bottom, which stands up a real mongod because the
// thing it pins is a shape Mongoose produces, not one we can author.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import VisaRule from "./VisaRule.js";
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

});

// The regression above (found live via /visa/requirements browser
// verification, 2026-08-07: every `equals`-only appliesWhen condition in the
// DB was permanently unsatisfiable) is about a shape Mongoose PRODUCES, not a
// shape we author. Writing that shape as a literal here would assert our
// belief about Mongoose rather than Mongoose's actual behaviour — and would
// keep passing unchanged if the defaulting ever went away, leaving a test
// that guards nothing. So this block persists a real VisaRule and evaluates
// whatever comes back out of the database.
//
// utils/visaPredicatePersistence.test.ts covers the same hazard across the
// resolver and the full production read paths; this is the evaluator's own
// round-trip, kept next to its unit tests.
describe("evaluateApplicantPredicate — against a predicate Mongoose round-tripped", () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  it("still matches an `equals` condition that was saved and read back", async () => {
    const created = await VisaRule.create({
      nationality: "IN",
      destinationIso2: "DE",
      purpose: "TOURIST",
      entryType: "SINGLE",
      serviceTier: "STANDARD",
      variantKey: "EQUALS_ROUNDTRIP",
      destinationName: "Germany",
      productClass: "VISA",
      effectiveFrom: new Date("2026-01-01"),
      // Authored with `equals` ONLY — no `in` anywhere in this payload.
      applicability: [{ field: "maritalStatus", equals: "MARRIED" }],
      documentGroups: [
        { key: "PASSPORT", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["PASSPORT_ORIGINAL"] },
      ],
    });
    const readBack: any = await VisaRule.findById(created._id).lean();
    const predicate = readBack.applicability;

    // The hazard, asserted from the database rather than assumed: Mongoose
    // gives the array-typed `in` path an implicit [] on a condition that was
    // never written with one. If this assertion ever fails, the defaulting
    // behaviour changed — the evaluator is probably still fine, but the
    // regression below no longer reproduces and this whole block needs
    // re-deriving rather than deleting.
    expect(predicate[0].equals).toBe("MARRIED");
    expect(predicate[0].in).toEqual([]);

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
