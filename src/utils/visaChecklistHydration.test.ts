// Unit coverage for Phase 10b's checklist hydration + completeness —
// covers the task brief's "completeness counts groups as one requirement,
// not N" test explicitly, plus the wire-shape/legacy-code guarantees.
import { describe, it, expect } from "vitest";
import { hydrateVisaChecklist, computeOutstandingRequirements } from "./visaChecklistHydration.js";

describe("hydrateVisaChecklist — documents (flat, per physical document)", () => {
  it("produces the same per-document wire shape for a legacy item as before this phase", () => {
    const source = { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" as const }] };
    const { documents } = hydrateVisaChecklist(source);
    expect(documents).toEqual([
      {
        docCode: "DOC-01",
        name: "Passport",
        category: "IDENTITY",
        notes: expect.any(String),
        requirement: "REQUIRED",
        satisfiedByBooking: false,
        conciergeArrangeable: false,
      },
    ]);
  });

  it("flattens a multi-document group into one row per physical document, all sharing the group's requirement/condition", () => {
    const source = {
      documentGroups: [
        {
          key: "PROOF_OF_OCCUPATION",
          label: "Proof of occupation (if employed)",
          requirement: "CONDITIONAL" as const,
          docTypeCodes: ["SALARY_SLIPS", "EMPLOYMENT_CONTRACT", "EMPLOYER_NOC", "FORM_16"],
          legacyConditionNote: "if employed",
        },
      ],
    };
    const { documents } = hydrateVisaChecklist(source);
    expect(documents).toHaveLength(4);
    expect(documents.every((d) => d.requirement === "CONDITIONAL")).toBe(true);
    expect(documents.every((d) => d.condition === "if employed")).toBe(true);
    expect(documents.map((d) => d.docCode)).toEqual(["SALARY_SLIPS", "EMPLOYMENT_CONTRACT", "EMPLOYER_NOC", "FORM_16"]);
  });

  it("overrides the doc type's default description with the group's own specification", () => {
    const source = {
      documentGroups: [
        {
          key: "PHOTO",
          label: "Photograph",
          requirement: "REQUIRED" as const,
          docTypeCodes: ["PHOTOGRAPH"],
          specification: "35x45mm, white background",
        },
      ],
    };
    const { documents } = hydrateVisaChecklist(source);
    expect(documents[0].notes).toBe("35x45mm, white background");
  });

  it("marks satisfiedByBooking/conciergeArrangeable using legacy codes exactly as before", () => {
    const source = {
      documentRequirements: [
        { docCode: "DOC-07", requirement: "REQUIRED" as const },
        { docCode: "DOC-08", requirement: "REQUIRED" as const },
        { docCode: "DOC-09", requirement: "REQUIRED" as const },
      ],
    };
    const { documents } = hydrateVisaChecklist(source, { linkedServices: new Set(["HOTEL"]) });
    const byCode = Object.fromEntries(documents.map((d) => [d.docCode, d]));
    expect(byCode["DOC-07"]).toMatchObject({ satisfiedByBooking: true, conciergeArrangeable: true });
    expect(byCode["DOC-08"]).toMatchObject({ satisfiedByBooking: false, conciergeArrangeable: true });
    expect(byCode["DOC-09"]).toMatchObject({ satisfiedByBooking: false, conciergeArrangeable: true });
  });

  it("also recognises the NEW semantic codes for linking/concierge-arrangeability (forward-compat)", () => {
    const source = {
      documentGroups: [{ key: "HOTEL", label: "Hotel Booking", requirement: "REQUIRED" as const, docTypeCodes: ["HOTEL_BOOKING"] }],
    };
    const { documents } = hydrateVisaChecklist(source, { linkedServices: new Set(["HOTEL"]) });
    expect(documents[0]).toMatchObject({ satisfiedByBooking: true, conciergeArrangeable: true });
  });
});

describe("hydrateVisaChecklist — documentGroups (one entry per logical requirement)", () => {
  it("collapses a 4-document group into ONE documentGroups entry", () => {
    const source = {
      documentGroups: [
        {
          key: "PROOF_OF_OCCUPATION",
          label: "Proof of occupation (if employed)",
          requirement: "CONDITIONAL" as const,
          docTypeCodes: ["SALARY_SLIPS", "EMPLOYMENT_CONTRACT", "EMPLOYER_NOC", "FORM_16"],
        },
      ],
    };
    const { documentGroups } = hydrateVisaChecklist(source);
    expect(documentGroups).toHaveLength(1);
    expect(documentGroups[0].docCodes).toHaveLength(4);
  });

  it("flags countsTowardCompleteness so the frontend never needs to know about appliesWhen itself", () => {
    const source = {
      documentGroups: [
        { key: "REQ", label: "Passport", requirement: "REQUIRED" as const, docTypeCodes: ["PASSPORT_ORIGINAL"] },
        {
          key: "MATCHED_COND",
          label: "ITR",
          requirement: "CONDITIONAL" as const,
          appliesWhen: [{ field: "employmentStatus" as const, in: ["SELF_EMPLOYED"] }],
          docTypeCodes: ["INCOME_TAX_RETURN"],
        },
        {
          key: "UNVERIFIABLE_COND",
          label: "Bank Statement",
          requirement: "CONDITIONAL" as const,
          legacyConditionNote: "If requested by immigration",
          docTypeCodes: ["APPLICANT_BANK_STATEMENT"],
        },
      ],
    };
    const { documentGroups } = hydrateVisaChecklist(source, { applicantProfile: { employmentStatus: "SELF_EMPLOYED" } });
    const byKey = Object.fromEntries(documentGroups.map((g) => [g.key, g]));
    expect(byKey.REQ.countsTowardCompleteness).toBe(true);
    expect(byKey.MATCHED_COND.countsTowardCompleteness).toBe(true);
    expect(byKey.UNVERIFIABLE_COND.countsTowardCompleteness).toBe(false);
  });
});

describe("computeOutstandingRequirements — counts groups as ONE requirement, not N", () => {
  const groupSource = {
    documentGroups: [
      {
        key: "PROOF_OF_OCCUPATION",
        label: "Proof of occupation",
        requirement: "REQUIRED" as const,
        docTypeCodes: ["SALARY_SLIPS", "EMPLOYMENT_CONTRACT", "EMPLOYER_NOC", "FORM_16"],
      },
      { key: "PASSPORT", label: "Passport", requirement: "REQUIRED" as const, docTypeCodes: ["PASSPORT_ORIGINAL"] },
    ],
  };

  it("counts the 4-document group as ONE outstanding requirement when nothing is uploaded", () => {
    const outstanding = computeOutstandingRequirements(groupSource, {}, {
      uploadedDocCodes: new Set(),
      linkedServices: new Set(),
    });
    expect(outstanding).toHaveLength(2); // PROOF_OF_OCCUPATION (1) + PASSPORT (1) — never 5
  });

  it("only clears the group once EVERY one of its documents is uploaded — 3 of 4 is still outstanding", () => {
    const outstanding = computeOutstandingRequirements(groupSource, {}, {
      uploadedDocCodes: new Set(["SALARY_SLIPS", "EMPLOYMENT_CONTRACT", "EMPLOYER_NOC", "PASSPORT_ORIGINAL"]),
      linkedServices: new Set(),
    });
    expect(outstanding.map((i) => i.key)).toEqual(["PROOF_OF_OCCUPATION"]);
  });

  it("clears the group once all 4 documents are uploaded", () => {
    const outstanding = computeOutstandingRequirements(groupSource, {}, {
      uploadedDocCodes: new Set(["SALARY_SLIPS", "EMPLOYMENT_CONTRACT", "EMPLOYER_NOC", "FORM_16", "PASSPORT_ORIGINAL"]),
      linkedServices: new Set(),
    });
    expect(outstanding).toEqual([]);
  });

  it("never counts a CONDITIONAL item with no structured appliesWhen (unverifiable free text) — same posture as before", () => {
    const source = {
      documentGroups: [
        {
          key: "MAYBE",
          label: "Bank Statement",
          requirement: "CONDITIONAL" as const,
          legacyConditionNote: "If requested by immigration on arrival",
          docTypeCodes: ["APPLICANT_BANK_STATEMENT"],
        },
      ],
    };
    const outstanding = computeOutstandingRequirements(source, {}, { uploadedDocCodes: new Set(), linkedServices: new Set() });
    expect(outstanding).toEqual([]);
  });

  it("DOES count a CONDITIONAL item once its structured appliesWhen has matched (it already passed the resolver's filter)", () => {
    const source = {
      documentGroups: [
        {
          key: "ITR",
          label: "Income Tax Return",
          requirement: "CONDITIONAL" as const,
          appliesWhen: [{ field: "employmentStatus" as const, in: ["SELF_EMPLOYED"] }],
          docTypeCodes: ["INCOME_TAX_RETURN"],
        },
      ],
    };
    const forSelfEmployed = computeOutstandingRequirements(source, { employmentStatus: "SELF_EMPLOYED" }, {
      uploadedDocCodes: new Set(),
      linkedServices: new Set(),
    });
    expect(forSelfEmployed.map((i) => i.key)).toEqual(["ITR"]);

    const forEmployed = computeOutstandingRequirements(source, { employmentStatus: "EMPLOYED" }, {
      uploadedDocCodes: new Set(),
      linkedServices: new Set(),
    });
    expect(forEmployed).toEqual([]); // doesn't apply to this person at all — never asked for
  });

  it("an old-shape ruleSnapshot (no documentGroups) still computes completeness correctly", () => {
    const oldSnapshot = {
      documentRequirements: [
        { docCode: "DOC-01", requirement: "REQUIRED" as const },
        { docCode: "DOC-04", requirement: "CONDITIONAL" as const, condition: "If self-employed" },
      ],
    };
    const outstanding = computeOutstandingRequirements(oldSnapshot, undefined, {
      uploadedDocCodes: new Set(),
      linkedServices: new Set(),
    });
    // Only the REQUIRED passport counts — the free-text CONDITIONAL ITR
    // never did (pre-Phase-10b behaviour, preserved for old data).
    expect(outstanding.map((i) => i.key)).toEqual(["DOC-01"]);
  });

  it("a linked booking satisfies its requirement without an upload", () => {
    const source = {
      documentGroups: [{ key: "HOTEL", label: "Hotel Booking", requirement: "REQUIRED" as const, docTypeCodes: ["DOC-07"] }],
    };
    const outstanding = computeOutstandingRequirements(source, {}, {
      uploadedDocCodes: new Set(),
      linkedServices: new Set(["HOTEL"]),
    });
    expect(outstanding).toEqual([]);
  });
});
