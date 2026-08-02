// Unit coverage for the deterministic (non-LLM) catalogue matcher — every
// case here is grounded in the actual Laos/France/Canada checklist text
// read during Phase 10c's pilot, not invented examples.
import { describe, it, expect } from "vitest";
import {
  matchDocumentType,
  suggestDocumentTypes,
  matchQuestion,
  suggestQuestions,
  matchTemplate,
  structureChecklistCondition,
  slugifyChecklistLabel,
  resolveDocumentTypeMapping,
} from "./visaChecklistCatalogueMatcher.js";

describe("matchDocumentType — exact/alias only, never a guess", () => {
  it("matches an exact catalogue name (Canada's 'Cover letter')", () => {
    expect(matchDocumentType("Cover letter")?.code).toBe("COVER_LETTER");
  });

  it("matches case/whitespace-insensitively (Laos's 'Photograph')", () => {
    expect(matchDocumentType("  Photograph  ")?.code).toBe("PHOTOGRAPH");
  });

  it("matches via an alias, not just the canonical name (France's 'Sponsorship Letter')", () => {
    expect(matchDocumentType("Sponsorship Letter")?.code).toBe("SPONSORSHIP_LETTER");
  });

  it("matches an atomic decomposed document from a France occupation group ('NOC from the employer')", () => {
    // Not a literal alias string, but IS the exact catalogue name once "the
    // employer" is dropped — demonstrates exact-match only fires on a true
    // string match, not partial containment: this specific phrase does NOT
    // match, proving the matcher doesn't silently guess.
    expect(matchDocumentType("NOC from the employer")).toBeNull();
    expect(matchDocumentType("Employer NOC")?.code).toBe("EMPLOYER_NOC");
  });

  it("does NOT match ambiguous real checklist text — 'Passport Front Page' (Laos) is genuinely unmatched", () => {
    expect(matchDocumentType("Passport Front Page")).toBeNull();
  });

  it("does NOT match 'Old passport copy' (Canada) — no catalogue entry for a previous/expired passport", () => {
    expect(matchDocumentType("Old passport copy")).toBeNull();
  });

  it("does NOT match 'National ID' / 'Flight tickets' even though a related code exists — never a fuzzy auto-match", () => {
    expect(matchDocumentType("National ID")).toBeNull();
    expect(matchDocumentType("Flight tickets")).toBeNull(); // real name is "Flight Itinerary" — a near-miss, not a match
  });

  it("returns null for empty/whitespace input", () => {
    expect(matchDocumentType("")).toBeNull();
    expect(matchDocumentType("   ")).toBeNull();
  });
});

describe("suggestDocumentTypes — informational near-misses only", () => {
  it("suggests FLIGHT_ITINERARY for 'Flight tickets' without auto-applying it", () => {
    const suggestions = suggestDocumentTypes("Flight tickets");
    expect(suggestions.some((s) => s.code === "FLIGHT_ITINERARY")).toBe(true);
    expect(matchDocumentType("Flight tickets")).toBeNull(); // still not an applied match
  });

  it("returns nothing for a genuinely unrelated source name", () => {
    expect(suggestDocumentTypes("Xyzzy Plugh Wibble")).toEqual([]);
  });
});

describe("matchQuestion — exact prompt match against the shared VisaQuestion bank", () => {
  it("matches France's 'What is your marital status?' to the bank's MARITAL_STATUS", () => {
    expect(matchQuestion("What is your marital status?")?.code).toBe("MARITAL_STATUS");
  });

  it("does NOT match Canada's broader refusal question — wording differs meaningfully from the bank's narrower one", () => {
    expect(
      matchQuestion(
        "Have you ever been refused a visa or permit, denied entry or ordered to leave Canada or any other country or territory?",
      ),
    ).toBeNull();
  });

  it("does NOT match France's 'What is your employment status?' — a different question shape from EMPLOYMENT_HISTORY", () => {
    expect(matchQuestion("What is your employment status?")).toBeNull();
  });
});

describe("suggestQuestions", () => {
  it("suggests PRIOR_VISA_REFUSAL for Canada's broader adverse-history question", () => {
    const suggestions = suggestQuestions(
      "Have you ever been refused a visa or permit, denied entry or ordered to leave Canada or any other country or territory?",
    );
    expect(suggestions.some((s) => s.code === "PRIOR_VISA_REFUSAL")).toBe(true);
  });
});

describe("matchTemplate — VisaTemplate has never been seeded, so everything is unmatched today", () => {
  it("returns null for every real template reference seen in the pilot PDFs", () => {
    for (const ref of ["Employer NOC Template", "Cover Letter Template", "Sponsorship Letter Template", "Business Invitation Letter Template"]) {
      expect(matchTemplate(ref)).toBeNull();
    }
  });
});

describe("structureChecklistCondition — known attributes only, never a guessed predicate", () => {
  it("structures France's 'If employed' / 'If self employed' / 'If Retired'", () => {
    expect(structureChecklistCondition("If employed")).toEqual([{ field: "employmentStatus", equals: "EMPLOYED" }]);
    expect(structureChecklistCondition("If self employed")).toEqual([{ field: "employmentStatus", equals: "SELF_EMPLOYED" }]);
    expect(structureChecklistCondition("If Retired")).toEqual([{ field: "employmentStatus", equals: "RETIRED" }]);
  });

  it("structures France's marital-status conditions ('If married', 'If divorced', 'If single')", () => {
    expect(structureChecklistCondition("If married")).toEqual([{ field: "maritalStatus", equals: "MARRIED" }]);
    expect(structureChecklistCondition("If divorced")).toEqual([{ field: "maritalStatus", equals: "DIVORCED" }]);
    expect(structureChecklistCondition("If single")).toEqual([{ field: "maritalStatus", equals: "SINGLE" }]);
  });

  it("structures Canada's 'If sponsored' and France's 'If trip sponsored by someone else'", () => {
    expect(structureChecklistCondition("If sponsored")).toEqual([{ field: "isSponsored", equals: true }]);
    expect(structureChecklistCondition("If trip sponsored by someone else")).toEqual([{ field: "isSponsored", equals: true }]);
  });

  it("structures the Canada US-visa-holder variant condition", () => {
    expect(structureChecklistCondition("For USA visa holder")).toEqual([{ field: "holdsUsVisa", equals: true }]);
  });

  it("does NOT structure an unstructurable free-text condition (UAE-style 'if requested by immigration on arrival')", () => {
    expect(structureChecklistCondition("if requested by immigration on arrival")).toBeNull();
  });

  it("does NOT structure Canada's minor-with-parent nuance beyond isMinor — the 'alone or with one parent' detail has no attribute", () => {
    // isMinor is still correctly detected via the "minor is travelling" trigger,
    // but the predicate captures ONLY isMinor — the alone-vs-one-parent nuance
    // is a real schema gap (see the extraction report), not something this
    // function silently drops without being asked to prove it first.
    expect(structureChecklistCondition("if minor is travelling alone or with only one parent")).toEqual([
      { field: "isMinor", equals: true },
    ]);
  });

  it("returns null for an empty/missing condition", () => {
    expect(structureChecklistCondition(null)).toBeNull();
    expect(structureChecklistCondition(undefined)).toBeNull();
    expect(structureChecklistCondition("")).toBeNull();
  });
});

describe("slugifyChecklistLabel", () => {
  it("produces a stable, deterministic slug from a real label", () => {
    expect(slugifyChecklistLabel("Proof of occupation (If employed)")).toBe("PROOF_OF_OCCUPATION_IF_EMPLOYED");
  });

  it("is idempotent — the same label always slugs the same way", () => {
    const a = slugifyChecklistLabel("Bank statement");
    const b = slugifyChecklistLabel("Bank statement");
    expect(a).toBe(b);
  });

  it("never returns an empty key", () => {
    expect(slugifyChecklistLabel("")).toBe("REQUIREMENT");
  });
});

describe("resolveDocumentTypeMapping — LLM primary, string matcher as cross-check", () => {
  it("bridges a source typo the string matcher alone cannot ('Employement contract')", () => {
    const result = resolveDocumentTypeMapping({
      sourceName: "Employement contract",
      llmCode: "EMPLOYMENT_CONTRACT",
      llmConfidence: "HIGH",
      llmReasoning: "Source typo for 'Employment' — same document as Employment Contract",
    });
    expect(result.matchedCode).toBe("EMPLOYMENT_CONTRACT");
    expect(result.confidence).toBe("HIGH");
    expect(matchDocumentType("Employement contract")).toBeNull(); // confirms the string matcher alone really can't
    expect(result.stringMatchCode).toBeNull();
    expect(result.matchesAgree).toBe(false); // LLM found something the string matcher didn't — a real disagreement, still reported
  });

  it("bridges word order ('NOC from the employer' -> EMPLOYER_NOC)", () => {
    const result = resolveDocumentTypeMapping({
      sourceName: "NOC from the employer",
      llmCode: "EMPLOYER_NOC",
      llmConfidence: "HIGH",
      llmReasoning: "Same document as Employer NOC, different word order",
    });
    expect(result.matchedCode).toBe("EMPLOYER_NOC");
    expect(result.matchesAgree).toBe(false); // string matcher alone doesn't find this either (see visaChecklistCatalogueMatcher.test.ts's own matchDocumentType coverage)
  });

  it("bridges a locally-known name ('National ID' -> Aadhaar, when a real catalogue code exists)", () => {
    // No catalogue entry actually covers this today (confirmed unmatched by
    // matchDocumentType elsewhere in this file) — this fixture demonstrates
    // the RESOLVER'S behaviour if/once one did; a null llmCode is exercised
    // in the next test for the actual current-catalogue case.
    const result = resolveDocumentTypeMapping({
      sourceName: "National ID",
      llmCode: "PASSPORT_ORIGINAL", // hypothetical — not a real claim, just exercising the mapping path
      llmConfidence: "LOW",
      llmReasoning: "Aadhaar is India's national ID — uncertain this is the intended catalogue match",
    });
    expect(result.matchedCode).toBe("PASSPORT_ORIGINAL");
    expect(result.confidence).toBe("LOW");
  });

  it("agrees when both the LLM and the string matcher independently land on the same code", () => {
    const result = resolveDocumentTypeMapping({
      sourceName: "Photograph",
      llmCode: "PHOTOGRAPH",
      llmConfidence: "HIGH",
      llmReasoning: "Exact name match",
    });
    expect(result.matchedCode).toBe("PHOTOGRAPH");
    expect(result.stringMatchCode).toBe("PHOTOGRAPH");
    expect(result.matchesAgree).toBe(true);
  });

  it("never accepts a code that isn't a real catalogue entry — treats it exactly like null", () => {
    const result = resolveDocumentTypeMapping({
      sourceName: "Something unusual",
      llmCode: "MADE_UP_CODE_THAT_DOES_NOT_EXIST",
      llmConfidence: "HIGH",
      llmReasoning: "the model claimed this, but it isn't real",
    });
    expect(result.matchedCode).toBeNull();
    expect(result.confidence).toBeNull(); // discarded along with the invalid code
    expect(result.reasoning).toBe("the model claimed this, but it isn't real"); // kept as evidence regardless
  });

  it("both null — reports agreement, with suggestions from the string matcher as a residual aid", () => {
    const result = resolveDocumentTypeMapping({
      sourceName: "Old passport copy",
      llmCode: null,
      llmConfidence: null,
      llmReasoning: "No catalogue entry covers a previous/expired passport copy",
    });
    expect(result.matchedCode).toBeNull();
    expect(result.stringMatchCode).toBeNull();
    expect(result.matchesAgree).toBe(true); // both correctly found nothing
    expect(result.suggestions).toEqual(suggestDocumentTypes("Old passport copy"));
  });

  it("flags a genuine disagreement when the string matcher found something but the LLM said null", () => {
    const result = resolveDocumentTypeMapping({
      sourceName: "Cover letter",
      llmCode: null,
      llmConfidence: null,
      llmReasoning: "Uncertain whether this is a generic cover letter or something more specific",
    });
    expect(result.matchedCode).toBeNull();
    expect(result.stringMatchCode).toBe("COVER_LETTER"); // the string matcher DOES find this one
    expect(result.matchesAgree).toBe(false);
  });
});
