// Unit coverage for Phase 10b's single checklist resolver — pure functions,
// no DB. Covers the task brief's explicit tests: a legacy rule and an
// equivalent group-based rule produce identical checklists; appliesWhen
// filters correctly; an old (documentGroups-less) ruleSnapshot still
// renders in full.
import { describe, it, expect } from "vitest";
import {
  resolveVisaChecklistItems,
  getReferencedApplicantAttributeFields,
  resolveVisaChecklistWithExclusions,
} from "./visaChecklistResolver.js";

describe("resolveVisaChecklistItems — legacy vs group-based equivalence", () => {
  const legacySource = {
    documentRequirements: [
      { docCode: "DOC-01", requirement: "REQUIRED" as const },
      { docCode: "DOC-04", requirement: "CONDITIONAL" as const, condition: "If self-employed or a business owner" },
    ],
  };

  const groupSource = {
    documentGroups: [
      { key: "DOC-01", label: "Passport", requirement: "REQUIRED" as const, docTypeCodes: ["DOC-01"] },
      {
        key: "DOC-04",
        label: "Income Tax Return",
        requirement: "CONDITIONAL" as const,
        appliesWhen: [{ field: "employmentStatus" as const, in: ["SELF_EMPLOYED"] }],
        docTypeCodes: ["DOC-04"],
      },
    ],
  };

  it("produces the same shape for both sources when no applicant is known yet (screen 2 preview)", () => {
    const legacyItems = resolveVisaChecklistItems(legacySource);
    const groupItems = resolveVisaChecklistItems(groupSource);

    expect(legacyItems).toHaveLength(2);
    expect(groupItems).toHaveLength(2);
    expect(legacyItems.map((i) => i.docTypeCodes)).toEqual(groupItems.map((i) => i.docTypeCodes));
    expect(legacyItems.map((i) => i.requirement)).toEqual(groupItems.map((i) => i.requirement));
  });

  it("uses documentGroups when present, never falling back to legacy even if both are populated", () => {
    const both = { ...legacySource, documentGroups: groupSource.documentGroups };
    const items = resolveVisaChecklistItems(both);
    expect(items).toHaveLength(2);
    // Group-sourced items carry a structured appliesWhen; legacy items never do —
    // this is only possible if the GROUP path was used, not the legacy one.
    expect(items.find((i) => i.key === "DOC-04")?.appliesWhen).toBeDefined();
  });
});

describe("resolveVisaChecklistItems — appliesWhen filtering", () => {
  const source = {
    documentGroups: [
      { key: "ALWAYS", label: "Passport", requirement: "REQUIRED" as const, docTypeCodes: ["PASSPORT_ORIGINAL"] },
      {
        key: "SELF_EMPLOYED_ONLY",
        label: "Income Tax Return",
        requirement: "CONDITIONAL" as const,
        appliesWhen: [{ field: "employmentStatus" as const, in: ["SELF_EMPLOYED"] }],
        docTypeCodes: ["INCOME_TAX_RETURN"],
      },
    ],
  };

  it("bypasses filtering entirely when no applicant is known yet (undefined profile) — full preview", () => {
    const items = resolveVisaChecklistItems(source, undefined);
    expect(items.map((i) => i.key)).toEqual(["ALWAYS", "SELF_EMPLOYED_ONLY"]);
  });

  it("filters out a conditional group when the applicant's profile doesn't match", () => {
    const items = resolveVisaChecklistItems(source, { employmentStatus: "EMPLOYED" });
    expect(items.map((i) => i.key)).toEqual(["ALWAYS"]);
  });

  it("includes a conditional group when the applicant's profile matches", () => {
    const items = resolveVisaChecklistItems(source, { employmentStatus: "SELF_EMPLOYED" });
    expect(items.map((i) => i.key)).toEqual(["ALWAYS", "SELF_EMPLOYED_ONLY"]);
  });

  it("filters with an empty-but-real profile object (real applicant, nothing answered yet)", () => {
    const items = resolveVisaChecklistItems(source, {});
    expect(items.map((i) => i.key)).toEqual(["ALWAYS"]);
  });

  it("turns a rule's larger requirement set into the smaller set that applies to this person", () => {
    const bigSource = {
      documentGroups: [
        { key: "A", label: "A", requirement: "REQUIRED" as const, docTypeCodes: ["A"] },
        { key: "B", label: "B", requirement: "REQUIRED" as const, docTypeCodes: ["B"] },
        {
          key: "C",
          label: "C",
          requirement: "CONDITIONAL" as const,
          appliesWhen: [{ field: "maritalStatus" as const, equals: "MARRIED" }],
          docTypeCodes: ["C"],
        },
        {
          key: "D",
          label: "D",
          requirement: "CONDITIONAL" as const,
          appliesWhen: [{ field: "holdsUsVisa" as const, equals: true }],
          docTypeCodes: ["D"],
        },
      ],
    };
    const items = resolveVisaChecklistItems(bigSource, { maritalStatus: "SINGLE", holdsUsVisa: true });
    expect(items.map((i) => i.key)).toEqual(["A", "B", "D"]);
  });
});

describe("resolveVisaChecklistItems — old-shape ruleSnapshot still renders", () => {
  it("falls back to legacy documentRequirements when documentGroups is entirely absent (pre-Phase-10b snapshot)", () => {
    const oldSnapshot = {
      documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" as const }],
      // documentGroups key literally absent — not even `undefined` set explicitly, matching a real lean() doc
    };
    const items = resolveVisaChecklistItems(oldSnapshot, { employmentStatus: "EMPLOYED" });
    expect(items).toEqual([{ key: "DOC-01", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["DOC-01"] }]);
  });

  it("does NOT fall back to legacy when documentGroups is present but EMPTY — an emptied rule has no requirements", () => {
    // The distinction this whole branch turns on: ABSENT means "this source
    // predates groups, use the legacy list"; EMPTY means "someone deliberately
    // cleared this rule's checklist". Before 2026-08-14 both took the legacy
    // path, so a rule edited down to zero groups would silently start quoting
    // whatever was left in documentRequirements. Harmless only because that
    // field is empty on every production rule today — which is not a property
    // to depend on once the console can write groups.
    const emptiedRule = {
      documentGroups: [],
      documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" as const }],
    };
    expect(resolveVisaChecklistItems(emptiedRule, { employmentStatus: "EMPLOYED" })).toEqual([]);

    // And the absent case still behaves exactly as it always did — same
    // legacy list, same output — so old ruleSnapshots are untouched.
    const oldSnapshot = { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" as const }] };
    expect(resolveVisaChecklistItems(oldSnapshot, { employmentStatus: "EMPLOYED" })).toHaveLength(1);
  });

  it("renders an old snapshot the same way regardless of applicant profile (nothing structured to filter by)", () => {
    const oldSnapshot = { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" as const }] };
    expect(resolveVisaChecklistItems(oldSnapshot, undefined)).toEqual(resolveVisaChecklistItems(oldSnapshot, { employmentStatus: "UNEMPLOYED" }));
  });

  it("handles a completely empty source without throwing", () => {
    expect(resolveVisaChecklistItems({})).toEqual([]);
  });
});

describe("getReferencedApplicantAttributeFields", () => {
  it("returns the distinct set of fields referenced by any group's appliesWhen", () => {
    const source = {
      documentGroups: [
        { key: "A", label: "A", requirement: "REQUIRED" as const, docTypeCodes: ["A"] },
        {
          key: "B",
          label: "B",
          requirement: "CONDITIONAL" as const,
          appliesWhen: [{ field: "employmentStatus" as const, in: ["SELF_EMPLOYED"] }],
          docTypeCodes: ["B"],
        },
        {
          key: "C",
          label: "C",
          requirement: "CONDITIONAL" as const,
          appliesWhen: [
            { field: "holdsUsVisa" as const, equals: true },
            { field: "maritalStatus" as const, equals: "MARRIED" },
          ],
          docTypeCodes: ["C"],
        },
      ],
    };
    expect(getReferencedApplicantAttributeFields(source).sort()).toEqual(
      ["employmentStatus", "holdsUsVisa", "maritalStatus"].sort(),
    );
  });

  it("returns an empty array for a legacy-only rule — nothing structural to reference", () => {
    const source = { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" as const }] };
    expect(getReferencedApplicantAttributeFields(source)).toEqual([]);
  });

  it("returns an empty array when no group has an appliesWhen at all", () => {
    const source = { documentGroups: [{ key: "A", label: "A", requirement: "REQUIRED" as const, docTypeCodes: ["A"] }] };
    expect(getReferencedApplicantAttributeFields(source)).toEqual([]);
  });
});

describe("resolveVisaChecklistWithExclusions — console checklist gap", () => {
  const source = {
    documentGroups: [
      { key: "PASSPORT", label: "Passport", requirement: "REQUIRED" as const, docTypeCodes: ["PASSPORT_ORIGINAL"] },
      {
        key: "ITR",
        label: "Income Tax Return",
        requirement: "CONDITIONAL" as const,
        appliesWhen: [{ field: "employmentStatus" as const, in: ["SELF_EMPLOYED"] }],
        docTypeCodes: ["INCOME_TAX_RETURN"],
      },
    ],
  };

  it("matches resolveVisaChecklistItems' included set exactly for the same profile", () => {
    const profile = { employmentStatus: "EMPLOYED" as const };
    const { included } = resolveVisaChecklistWithExclusions(source, profile);
    expect(included).toEqual(resolveVisaChecklistItems(source, profile));
  });

  it("returns the excluded group with the attribute and actual value that excluded it", () => {
    const { excluded } = resolveVisaChecklistWithExclusions(source, { employmentStatus: "EMPLOYED" });
    expect(excluded).toHaveLength(1);
    expect(excluded[0]).toMatchObject({
      key: "ITR",
      label: "Income Tax Return",
      docTypeCodes: ["INCOME_TAX_RETURN"],
      excludedBy: [{ field: "employmentStatus", actualValue: "EMPLOYED", expected: "one of SELF_EMPLOYED" }],
    });
    expect(excluded[0].reason).toBe("traveller's employment status is EMPLOYED, not one of SELF_EMPLOYED");
  });

  it("includes the ITR requirement (and excludes nothing) for a self-employed traveller", () => {
    const { included, excluded } = resolveVisaChecklistWithExclusions(source, { employmentStatus: "SELF_EMPLOYED" });
    expect(included.map((i) => i.key)).toEqual(["PASSPORT", "ITR"]);
    expect(excluded).toEqual([]);
  });

  it("reports 'not answered' when the profile never set the relevant field", () => {
    const { excluded } = resolveVisaChecklistWithExclusions(source, {});
    expect(excluded[0].excludedBy[0].actualValue).toBeNull();
    expect(excluded[0].reason).toContain("not answered");
  });

  it("returns no exclusions in preview mode (no applicant known yet)", () => {
    const { included, excluded } = resolveVisaChecklistWithExclusions(source, undefined);
    expect(included).toHaveLength(2); // full, unfiltered preview
    expect(excluded).toEqual([]);
  });

  it("returns no exclusions for a legacy-only source — nothing structural to exclude on", () => {
    const legacySource = { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" as const }] };
    const { included, excluded } = resolveVisaChecklistWithExclusions(legacySource, { employmentStatus: "EMPLOYED" });
    expect(included).toHaveLength(1);
    expect(excluded).toEqual([]);
  });

  it("an old-shape ruleSnapshot (no documentGroups) still renders via the exclusions path", () => {
    const oldSnapshot = { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" as const }] };
    const { included, excluded } = resolveVisaChecklistWithExclusions(oldSnapshot, { employmentStatus: "SELF_EMPLOYED" });
    expect(included).toEqual([{ key: "DOC-01", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["DOC-01"] }]);
    expect(excluded).toEqual([]);
  });
});
