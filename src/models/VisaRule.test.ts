// Unit coverage for Phase 10a's VisaRule additions: variantKey/applicability
// defaults (schema-level, no DB connection needed — same convention as
// models/VisaApplication.test.ts) and selectApplicableVisaRule's
// most-specific-wins selection, re-exported from models/visaAttributes.ts.
import { describe, it, expect } from "vitest";
import VisaRule, { selectApplicableVisaRule } from "./VisaRule.js";

function minimalRuleAttrs(overrides: Record<string, any> = {}) {
  return {
    nationality: "in",
    destinationIso2: "de",
    purpose: "TOURIST",
    entryType: "MULTIPLE",
    serviceTier: "STANDARD",
    destinationName: "Germany",
    productClass: "VISA",
    visaCategory: "STICKER",
    ...overrides,
  };
}

describe("VisaRule schema — Phase 10a fields", () => {
  it("defaults variantKey to 'DEFAULT' — every rule created through the existing admin CRUD is unaffected", () => {
    const rule = new VisaRule(minimalRuleAttrs());
    expect(rule.variantKey).toBe("DEFAULT");
    expect(rule.validateSync()).toBeUndefined();
  });

  it("defaults documentGroups, questions, additionalQuestions to empty arrays", () => {
    const rule = new VisaRule(minimalRuleAttrs());
    expect(rule.documentGroups).toEqual([]);
    expect(rule.questions).toEqual([]);
    expect(rule.additionalQuestions).toEqual([]);
  });

  it("leaves applicability undefined by default (the fallback/no-predicate case)", () => {
    const rule = new VisaRule(minimalRuleAttrs());
    expect(rule.applicability).toBeUndefined();
  });

  it("accepts an explicit variantKey + applicability for a rule variant", () => {
    const rule = new VisaRule(
      minimalRuleAttrs({
        destinationIso2: "ca",
        variantKey: "us-visa-holder",
        applicability: [{ field: "holdsUsVisa", equals: true }],
      }),
    );
    expect(rule.validateSync()).toBeUndefined();
    expect(rule.variantKey).toBe("US-VISA-HOLDER");
    expect(rule.applicability).toHaveLength(1);
  });

  it("accepts a documentGroups entry with appliesWhen, specification, and templateCode", () => {
    const rule = new VisaRule(
      minimalRuleAttrs({
        documentGroups: [
          {
            key: "PROOF_OF_OCCUPATION",
            label: "Proof of occupation (if employed)",
            requirement: "CONDITIONAL",
            appliesWhen: [{ field: "employmentStatus", equals: "EMPLOYED" }],
            docTypeCodes: ["SALARY_SLIPS", "EMPLOYMENT_CONTRACT", "EMPLOYER_NOC", "FORM_16"],
            specification: "Last 3 months, on company letterhead",
            templateCode: "france_occupation_form",
          },
        ],
      }),
    );
    expect(rule.validateSync()).toBeUndefined();
    expect(rule.documentGroups[0].docTypeCodes).toHaveLength(4);
    expect(rule.documentGroups[0].templateCode).toBe("FRANCE_OCCUPATION_FORM");
  });
});

describe("selectApplicableVisaRule — the Canada case (task brief §5)", () => {
  const fallback = { applicability: undefined, variantKey: "DEFAULT", documentCount: 20 };
  const usVisaVariant = {
    applicability: [{ field: "holdsUsVisa" as const, equals: true }],
    variantKey: "US_VISA_HOLDER",
    documentCount: 5,
  };

  it("picks the 5-document variant for an applicant holding a valid US visa", () => {
    const picked = selectApplicableVisaRule([fallback, usVisaVariant], { holdsUsVisa: true });
    expect(picked?.documentCount).toBe(5);
  });

  it("picks the 20-document fallback for an applicant without one", () => {
    const picked = selectApplicableVisaRule([fallback, usVisaVariant], { holdsUsVisa: false });
    expect(picked?.documentCount).toBe(20);
  });
});
