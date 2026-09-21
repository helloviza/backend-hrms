// maskPassportVault — the deep masker the ops dossier applies to
// resolvePassportVault()'s payload when the caller lacks travellerIdentityPII.
import { describe, it, expect } from "vitest";
import { maskMrzLine2, maskPassportVault } from "./piiMask.js";

const LINE2 = "Z12345678IND9004121F3101017<<<<<<<<<<<<<<<<6"; // 44 chars, doc field = "Z12345678"

describe("maskMrzLine2", () => {
  it("masks all but the last 4 of the 9-character document field and keeps the rest", () => {
    const out = maskMrzLine2(LINE2) as string;
    expect(out).toHaveLength(44);
    expect(out.slice(0, 9)).toBe("*****5678");
    expect(out.slice(9)).toBe(LINE2.slice(9));
  });
  it("passes non-strings through", () => {
    expect(maskMrzLine2(null)).toBeNull();
    expect(maskMrzLine2(undefined)).toBeUndefined();
  });
});

describe("maskPassportVault", () => {
  const vault = {
    mrz: { available: true, line1: "P<INDRAO<<ANITA<<<<<", line2: LINE2, nationality: "IND", corroboration: { state: "CORROBORATED", comparedCount: 3, mismatchedCount: 0 } },
    scan: { surname: "RAO", givenNames: "ANITA", documentNumber: "Z1234567", nationality: "IND", dateOfBirth: "1990-04-12", extractionStatus: "extracted" },
    mismatch: {
      sourceCount: 2, hasTypedPassport: true, hasExtraction: true,
      comparison: {
        comparedCount: 3, mismatchedCount: 1,
        fields: [
          { field: "surname", typedValue: "Rao", extractedValue: "RAO", status: "MATCH" },
          { field: "documentNumber", typedValue: "Z1234567", extractedValue: "Z1234568", status: "MISMATCH" },
        ],
        differsFromFile: [{ field: "documentNumber", passportValue: "Z1234568", profileValue: "Z1234567" }],
      },
    },
  };

  it("masks every echo of the number and nothing else", () => {
    const out = maskPassportVault(vault);
    expect(out.mrz.line2.slice(0, 9)).toBe("*****5678");
    expect(out.mrz.line1).toBe(vault.mrz.line1);
    expect(out.scan.documentNumber).toBe("****4567");
    expect(out.scan.surname).toBe("RAO");
    expect(out.scan.dateOfBirth).toBe("1990-04-12");
    expect(out.mismatch.comparison.fields[0]).toEqual(vault.mismatch.comparison.fields[0]); // surname row untouched
    expect(out.mismatch.comparison.fields[1].typedValue).toBe("****4567");
    expect(out.mismatch.comparison.fields[1].extractedValue).toBe("****4568");
    expect(out.mismatch.comparison.differsFromFile[0]).toEqual({ field: "documentNumber", passportValue: "****4568", profileValue: "****4567" });
    expect(JSON.stringify(out)).not.toContain("Z1234567");
    expect(JSON.stringify(out)).not.toContain("Z1234568");
  });

  it("does not mutate the input and tolerates null / unavailable vaults", () => {
    const before = JSON.stringify(vault);
    maskPassportVault(vault);
    expect(JSON.stringify(vault)).toBe(before);
    expect(maskPassportVault(null as any)).toBeNull();
    expect(maskPassportVault({ mrz: { available: false, gaps: ["passportNo"] }, scan: null, mismatch: { sourceCount: 0 } })).toEqual({ mrz: { available: false, gaps: ["passportNo"] }, scan: null, mismatch: { sourceCount: 0 } });
  });
});
