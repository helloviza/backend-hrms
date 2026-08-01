// Unit coverage for the Phase 10a compatibility bridge that lets an
// OLD-SHAPE VisaApplication.ruleSnapshot.documentRequirements (still
// carrying "DOC-NN" codes — ruleSnapshot is immutable history, never
// rewritten by the migration) keep rendering without ever mutating the
// snapshot itself.
import { describe, it, expect, vi } from "vitest";

vi.mock("../models/VisaDocumentType.js", () => ({
  default: { findOne: () => ({ lean: () => Promise.resolve(null) }) },
}));

import { resolveVisaDocumentType, resolveVisaDocumentRequirements } from "./visaDocumentTypeResolver.js";

describe("resolveVisaDocumentRequirements — old-shape snapshot rendering", () => {
  it("hydrates a legacy-shape documentRequirements array (old DOC-NN codes) without touching the input", () => {
    const legacySnapshot = [
      { docCode: "DOC-01", requirement: "REQUIRED" as const },
      { docCode: "DOC-03", requirement: "REQUIRED" as const },
      { docCode: "DOC-04", requirement: "CONDITIONAL" as const, condition: "If self-employed or a business owner" },
    ];
    const frozenCopy = JSON.parse(JSON.stringify(legacySnapshot));

    const hydrated = resolveVisaDocumentRequirements(legacySnapshot);

    expect(hydrated).toHaveLength(3);
    expect(hydrated[0]).toMatchObject({ docCode: "DOC-01", resolvedCode: "PASSPORT_ORIGINAL", resolvedName: "Passport" });
    expect(hydrated[1]).toMatchObject({ docCode: "DOC-03", resolvedCode: "APPLICANT_BANK_STATEMENT", resolvedName: "Bank Statement" });
    expect(hydrated[2]).toMatchObject({ docCode: "DOC-04", resolvedCode: "INCOME_TAX_RETURN" });

    // Never mutates the original snapshot — ruleSnapshot is immutable history.
    expect(legacySnapshot).toEqual(frozenCopy);
  });

  it("degrades an unknown docCode to the raw code as its own display name, rather than orphaning it", () => {
    const hydrated = resolveVisaDocumentRequirements([{ docCode: "DOC-77", requirement: "REQUIRED" }]);
    expect(hydrated[0].resolvedCode).toBeNull();
    expect(hydrated[0].resolvedName).toBe("DOC-77");
  });

  it("also hydrates an already-new-shape (semantic-code) requirements array identically", () => {
    const hydrated = resolveVisaDocumentRequirements([{ docCode: "PASSPORT_ORIGINAL", requirement: "REQUIRED" }]);
    expect(hydrated[0].resolvedCode).toBe("PASSPORT_ORIGINAL");
    expect(hydrated[0].resolvedName).toBe("Passport");
  });

  it("returns an empty array for a missing/undefined requirements list", () => {
    expect(resolveVisaDocumentRequirements(undefined)).toEqual([]);
    expect(resolveVisaDocumentRequirements(null)).toEqual([]);
  });
});

describe("resolveVisaDocumentType — DB-first, catalogue fallback", () => {
  it("falls back to the static catalogue when the DB has no row yet, resolving an old legacy code", async () => {
    const resolved = await resolveVisaDocumentType("DOC-05");
    expect(resolved).toMatchObject({ code: "EMPLOYER_NOC", name: "Employer NOC", queriedCode: "DOC-05" });
  });

  it("returns null for a code with no catalogue entry at all", async () => {
    expect(await resolveVisaDocumentType("NOT_A_REAL_CODE")).toBeNull();
  });
});
