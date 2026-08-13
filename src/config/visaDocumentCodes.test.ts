// Unit coverage for the Phase 10a compatibility shim: legacy DOC-NN codes
// must keep resolving exactly as they did before the semantic-code
// catalogue redesign, while new semantic codes also resolve. See this
// file's own header and config/visaDocumentTypeCatalogue.ts for why the old
// codes are never rewritten in storage.
import { describe, it, expect } from "vitest";
import {
  VISA_DOCUMENT_CODES,
  VISA_DOCUMENT_CODE_SET,
  getVisaDocumentCodeDef,
  OLD_TO_NEW_DOC_CODE_MAP,
} from "./visaDocumentCodes.js";

describe("legacy DOC-NN codes still resolve", () => {
  it("VISA_DOCUMENT_CODES still lists all ten original legacy codes", () => {
    const codes = VISA_DOCUMENT_CODES.map((d) => d.code);
    for (const legacy of ["DOC-01", "DOC-02", "DOC-03", "DOC-04", "DOC-05", "DOC-06", "DOC-07", "DOC-08", "DOC-09", "DOC-10"]) {
      expect(codes).toContain(legacy);
    }
  });

  it("VISA_DOCUMENT_CODE_SET still accepts every legacy code", () => {
    for (const legacy of Object.keys(OLD_TO_NEW_DOC_CODE_MAP)) {
      expect(VISA_DOCUMENT_CODE_SET.has(legacy)).toBe(true);
    }
  });

  it("getVisaDocumentCodeDef('DOC-01') resolves to Passport, unchanged from before this phase", () => {
    const def = getVisaDocumentCodeDef("DOC-01");
    expect(def).toBeDefined();
    expect(def?.code).toBe("DOC-01");
    expect(def?.name).toBe("Passport");
    expect(def?.category).toBe("IDENTITY");
  });

  it("getVisaDocumentCodeDef returns undefined for a totally unknown code", () => {
    expect(getVisaDocumentCodeDef("DOC-99")).toBeUndefined();
  });
});

describe("new semantic codes also resolve", () => {
  it("VISA_DOCUMENT_CODE_SET accepts the new semantic codes too (superset, never a narrowing)", () => {
    expect(VISA_DOCUMENT_CODE_SET.has("PASSPORT_ORIGINAL")).toBe(true);
    expect(VISA_DOCUMENT_CODE_SET.has("EMPLOYER_NOC")).toBe(true);
    expect(VISA_DOCUMENT_CODE_SET.has("SPONSOR_BANK_STATEMENT")).toBe(true);
  });

  it("getVisaDocumentCodeDef resolves a new semantic code and echoes back the queried (semantic) form", () => {
    const def = getVisaDocumentCodeDef("PASSPORT_ORIGINAL");
    expect(def?.code).toBe("PASSPORT_ORIGINAL");
    expect(def?.name).toBe("Passport");
  });
});

describe("OLD_TO_NEW_DOC_CODE_MAP", () => {
  it("maps every one of the nine original codes to a semantic equivalent", () => {
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-01"]).toBe("PASSPORT_ORIGINAL");
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-02"]).toBe("PHOTOGRAPH");
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-03"]).toBe("APPLICANT_BANK_STATEMENT");
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-04"]).toBe("INCOME_TAX_RETURN");
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-05"]).toBe("EMPLOYER_NOC");
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-06"]).toBe("INVITATION_LETTER");
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-07"]).toBe("HOTEL_BOOKING");
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-08"]).toBe("FLIGHT_ITINERARY");
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-09"]).toBe("TRAVEL_INSURANCE");
    expect(OLD_TO_NEW_DOC_CODE_MAP["DOC-10"]).toBe("ISSUED_VISA_SCAN");
  });
});
