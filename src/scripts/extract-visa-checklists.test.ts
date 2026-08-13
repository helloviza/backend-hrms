// Unit coverage for buildExtractedFile — the pure orchestration between a
// RAW Gemini extraction and the reviewable JSON shape. Fixtures below
// mirror real text read from the Laos/France/Canada pilot PDFs, not
// invented examples.
import { describe, it, expect } from "vitest";
import { buildExtractedFile } from "./extract-visa-checklists.js";

describe("buildExtractedFile — Laos (single checklist, no questionnaire)", () => {
  const extraction = {
    raw: {
      destinationName: "Laos",
      checklists: [
        {
          purposeLabel: "Tourist",
          variantLabel: null,
          requirementGroups: [
            {
              label: "Passport Front Page",
              requirement: "REQUIRED",
              conditionText: null,
              specificationText: "Clear picture of passport front page",
              templateReference: null,
              documents: [
                {
                  name: "Passport Front Page",
                  description: null,
                  documentTypeCode: null,
                  documentTypeConfidence: null,
                  documentTypeReasoning: "Ambiguous whether this is the bio-data page or a different page",
                },
              ],
            },
            {
              label: "Photograph",
              requirement: "REQUIRED",
              conditionText: null,
              specificationText: "Clear scanned copy of your photograph",
              templateReference: null,
              documents: [
                {
                  name: "Photograph",
                  description: null,
                  documentTypeCode: "PHOTOGRAPH",
                  documentTypeConfidence: "HIGH",
                  documentTypeReasoning: "Exact name match",
                },
              ],
            },
          ],
          questions: [],
        },
      ],
    },
    model: "gemini-2.5-flash",
  };

  it("resolves the destination ISO2 via the country-code lookup, never a guess", () => {
    const file = buildExtractedFile("Laos-document-checklist.pdf", [], extraction, "2026-08-02T00:00:00Z");
    expect(file.destinationIso2).toBe("LA");
    expect(file.nationality).toBe("IN");
  });

  it("yields exactly one checklist (one rule) for a single-table PDF", () => {
    const file = buildExtractedFile("Laos-document-checklist.pdf", [], extraction, "2026-08-02T00:00:00Z");
    expect(file.checklists).toHaveLength(1);
    expect(file.checklists[0].purpose).toBe("TOURIST");
    expect(file.checklists[0].variantKey).toBe("DEFAULT");
  });

  it("matches Photograph but leaves the ambiguous 'Passport Front Page' unmatched, with a suggestion", () => {
    const file = buildExtractedFile("Laos-document-checklist.pdf", [], extraction, "2026-08-02T00:00:00Z");
    const [passportGroup, photoGroup] = file.checklists[0].requirementGroups;
    expect(passportGroup.documents[0].matchedCode).toBeNull();
    expect(passportGroup.allDocumentsMatched).toBe(false);
    expect(photoGroup.documents[0].matchedCode).toBe("PHOTOGRAPH");
    expect(photoGroup.allDocumentsMatched).toBe(true);
  });
});

describe("buildExtractedFile — Canada (standard + US-visa-holder variant + questionnaire)", () => {
  const extraction = {
    raw: {
      destinationName: "Canada",
      checklists: [
        {
          purposeLabel: "Tourist",
          variantLabel: null,
          requirementGroups: [
            {
              label: "Leave Approval Letter",
              requirement: "REQUIRED",
              conditionText: null,
              specificationText: null,
              templateReference: "Employer NOC Template",
              documents: [
                {
                  name: "Leave Approval Letter",
                  description: null,
                  documentTypeCode: "EMPLOYER_NOC",
                  documentTypeConfidence: "HIGH",
                  documentTypeReasoning: "Leave Approval Letter is a known alias of Employer NOC",
                },
              ],
            },
          ],
          questions: [
            {
              prompt:
                "Have you ever been refused a visa or permit, denied entry or ordered to leave Canada or any other country or territory?",
              detailsText: "If Yes, Provide Details",
            },
          ],
        },
        {
          purposeLabel: "Tourist",
          variantLabel: "For USA visa holder",
          requirementGroups: [
            {
              label: "USA Valid Visa Copy",
              requirement: "REQUIRED",
              conditionText: null,
              specificationText: "Clear USA Valid Visa Copy",
              templateReference: null,
              documents: [{ name: "USA Valid Visa Copy", description: null }],
            },
          ],
          questions: [],
        },
      ],
    },
    model: "gemini-2.5-flash",
  };

  it("yields TWO rules from one PDF — the standard checklist and the US-visa-holder variant", () => {
    const file = buildExtractedFile("Canada-document-checklist.pdf", [], extraction, "2026-08-02T00:00:00Z");
    expect(file.checklists).toHaveLength(2);
  });

  it("structures the variant condition into holdsUsVisa applicability, not a separate purpose", () => {
    const file = buildExtractedFile("Canada-document-checklist.pdf", [], extraction, "2026-08-02T00:00:00Z");
    const variant = file.checklists[1];
    expect(variant.purpose).toBe("TOURIST"); // same purpose as the standard checklist
    expect(variant.variantKey).not.toBe("DEFAULT");
    expect(variant.applicability).toEqual([{ field: "holdsUsVisa", equals: true }]);
  });

  it("matches the Employer NOC alias 'Leave Approval Letter' but leaves its template reference unmatched (VisaTemplate is unseeded)", () => {
    const file = buildExtractedFile("Canada-document-checklist.pdf", [], extraction, "2026-08-02T00:00:00Z");
    const group = file.checklists[0].requirementGroups[0];
    expect(group.documents[0].matchedCode).toBe("EMPLOYER_NOC");
    expect(group.templateReference).toBe("Employer NOC Template");
    expect(group.matchedTemplateCode).toBeNull();
  });

  it("leaves Canada's broader refusal question unmatched against the bank's narrower PRIOR_VISA_REFUSAL, but suggests it", () => {
    const file = buildExtractedFile("Canada-document-checklist.pdf", [], extraction, "2026-08-02T00:00:00Z");
    const question = file.checklists[0].questions[0];
    expect(question.matchedQuestionCode).toBeNull();
    expect(question.suggestions.some((s) => s.code === "PRIOR_VISA_REFUSAL")).toBe(true);
  });
});

describe("buildExtractedFile — France (conditional group with a structured condition)", () => {
  it("structures 'If self employed' into employmentStatus=SELF_EMPLOYED and matches GST/company docs partially", () => {
    const extraction = {
      raw: {
        destinationName: "France",
        checklists: [
          {
            purposeLabel: "Tourist",
            variantLabel: null,
            requirementGroups: [
              {
                label: "Proof of occupation (If self employed)",
                requirement: "CONDITIONAL",
                conditionText: "If self employed",
                specificationText: null,
                templateReference: null,
                documents: [
                  { name: "GST certificate", description: null },
                  { name: "Company registration proof", description: null },
                  { name: "Company bank statement", description: null },
                  { name: "Company ITR", description: null },
                ],
              },
            ],
            questions: [],
          },
        ],
      },
      model: "gemini-2.5-flash",
    };

    const file = buildExtractedFile("France-document-checklist.pdf", ["France-document-checklist (1).pdf"], extraction, "2026-08-02T00:00:00Z");
    const group = file.checklists[0].requirementGroups[0];
    expect(group.appliesWhen).toEqual([{ field: "employmentStatus", equals: "SELF_EMPLOYED" }]);
    // This fixture simulates the model ALSO declining to map any of these
    // four (no documentTypeCode set) — a genuine "nothing matched" result,
    // still correctly surfacing string-matcher suggestions as a residual
    // aid (GST certificate, "Company registration proof" vs.
    // BUSINESS_REGISTRATION's "Company Registration Certificate" alias).
    // See the next test for the case this phase actually improves: the
    // model DOES map something the string matcher alone never could.
    expect(group.documents.map((d) => d.matchedCode)).toEqual([null, null, null, null]);
    expect(group.documents[1].suggestions.some((s) => s.code === "BUSINESS_REGISTRATION")).toBe(true);
    expect(group.allDocumentsMatched).toBe(false);
    expect(file.duplicateOfSourceFiles).toEqual(["France-document-checklist (1).pdf"]);
  });

  it("bridges what the string matcher alone cannot — a source typo, via the model's own catalogue mapping", () => {
    const extraction = {
      raw: {
        destinationName: "France",
        checklists: [
          {
            purposeLabel: "Tourist",
            variantLabel: null,
            requirementGroups: [
              {
                label: "Proof of occupation (If employed)",
                requirement: "CONDITIONAL",
                conditionText: "If employed",
                specificationText: null,
                templateReference: "Employer NOC Template",
                documents: [
                  {
                    name: "Employement contract", // verbatim source typo, real PDF text
                    description: null,
                    documentTypeCode: "EMPLOYMENT_CONTRACT",
                    documentTypeConfidence: "HIGH",
                    documentTypeReasoning: "Source typo for 'Employment' — same document as Employment Contract",
                  },
                  {
                    name: "NOC from the employer", // verbatim source wording, real PDF text
                    description: null,
                    documentTypeCode: "EMPLOYER_NOC",
                    documentTypeConfidence: "HIGH",
                    documentTypeReasoning: "Same document as Employer NOC, different word order",
                  },
                ],
              },
            ],
            questions: [],
          },
        ],
      },
      model: "gemini-2.5-flash",
    };

    const file = buildExtractedFile("France-document-checklist.pdf", [], extraction, "2026-08-02T00:00:00Z");
    const group = file.checklists[0].requirementGroups[0];
    expect(group.documents.map((d) => d.matchedCode)).toEqual(["EMPLOYMENT_CONTRACT", "EMPLOYER_NOC"]);
    expect(group.allDocumentsMatched).toBe(true);
    // The string matcher alone finds neither — confirming these are real
    // disagreements the LLM resolved, not cases it merely agreed on.
    expect(group.documents.every((d) => !d.matchesAgree)).toBe(true);
  });
});

describe("buildExtractedFile — unresolvable purpose/destination degrade to null, never a guess", () => {
  it("leaves purpose null for an unrecognised purposeLabel", () => {
    const extraction = {
      raw: {
        destinationName: "Laos",
        checklists: [{ purposeLabel: "Diplomatic", variantLabel: null, requirementGroups: [], questions: [] }],
      },
      model: "gemini-2.5-flash",
    };
    const file = buildExtractedFile("x.pdf", [], extraction, "2026-08-02T00:00:00Z");
    expect(file.checklists[0].purpose).toBeNull();
  });

  it("leaves destinationIso2 null for an unresolvable destination name", () => {
    const extraction = {
      raw: { destinationName: "Neverland", checklists: [] },
      model: "gemini-2.5-flash",
    };
    const file = buildExtractedFile("x.pdf", [], extraction, "2026-08-02T00:00:00Z");
    expect(file.destinationIso2).toBeNull();
  });
});
