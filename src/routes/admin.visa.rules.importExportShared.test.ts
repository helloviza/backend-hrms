// Unit coverage for admin.visa.rules.importExportShared.ts — the
// serialize/deserialize functions the round-trip-losslessness property
// depends on. No DB connection needed; every function here is pure.
import { describe, it, expect } from "vitest";
import {
  numberIn,
  numberOut,
  stringIn,
  stringOut,
  appliesWhenIn,
  appliesWhenOut,
  docCodesIn,
  docCodesOut,
  resolveRuleRow,
  resolveRequirementRow,
  mapSheetRow,
  RULES_HEADER_FIELD_MAP,
} from "./admin.visa.rules.importExportShared.js";

describe("cell primitives", () => {
  it("numberIn: blank -> absent, valid -> parsed, tolerates thousands separators", () => {
    expect(numberIn("", "X")).toEqual({});
    expect(numberIn("  ", "X")).toEqual({});
    expect(numberIn("1,499", "X")).toEqual({ value: 1499 });
    expect(numberIn("0", "X")).toEqual({ value: 0 }); // zero is a real value, not "blank"
  });

  it("numberIn: rejects negative or non-numeric", () => {
    expect(numberIn("-5", "Fee")).toEqual({ error: "Fee must be a non-negative number" });
    expect(numberIn("abc", "Fee")).toEqual({ error: "Fee must be a non-negative number" });
  });

  it("numberOut: null/undefined -> blank cell, else the raw number", () => {
    expect(numberOut(null)).toBe("");
    expect(numberOut(undefined)).toBe("");
    expect(numberOut(0)).toBe(0);
    expect(numberOut(42)).toBe(42);
  });

  it("stringIn/stringOut round-trip a blank cell to undefined and back to blank", () => {
    expect(stringIn("")).toBeUndefined();
    expect(stringIn("  ")).toBeUndefined();
    expect(stringIn(" hello ")).toBe("hello");
    expect(stringOut(undefined)).toBe("");
    expect(stringOut(null)).toBe("");
    expect(stringOut("hello")).toBe("hello");
  });

  it("appliesWhenIn/Out round-trip a real predicate", () => {
    const predicate = [{ field: "employmentStatus", equals: "SELF_EMPLOYED" }];
    const cell = appliesWhenOut(predicate as any);
    const back = appliesWhenIn(cell);
    expect(back.value).toEqual(predicate);
  });

  it("appliesWhenOut: empty/absent -> blank cell; appliesWhenIn: blank -> absent", () => {
    expect(appliesWhenOut(undefined)).toBe("");
    expect(appliesWhenOut([])).toBe("");
    expect(appliesWhenIn("")).toEqual({});
  });

  it("appliesWhenIn rejects invalid JSON, non-array, unknown field, and a condition with neither equals nor in", () => {
    expect(appliesWhenIn("not json").error).toMatch(/not valid JSON/);
    expect(appliesWhenIn('{"field":"x"}').error).toMatch(/must be a JSON array/);
    expect(appliesWhenIn('[{"field":"notARealField","equals":"x"}]').error).toMatch(/valid "field"/);
    expect(appliesWhenIn('[{"field":"employmentStatus"}]').error).toMatch(/needs either "equals" or "in"/);
  });

  it("docCodesIn/Out round-trip a code list, preserving order", () => {
    const codes = ["PASSPORT_ORIGINAL", "PHOTOGRAPH", "INVITATION_LETTER"];
    const cell = docCodesOut(codes);
    expect(cell).toBe("PASSPORT_ORIGINAL, PHOTOGRAPH, INVITATION_LETTER");
    expect(docCodesIn(cell).value).toEqual(codes);
  });

  it("docCodesIn rejects an empty list and an unknown code", () => {
    expect(docCodesIn("").error).toMatch(/at least one document code/);
    expect(docCodesIn("NOT_A_REAL_CODE").error).toMatch(/not a known document type code/);
  });
});

describe("mapSheetRow", () => {
  it("maps normalised headers to internal field names and flags unrecognised ones", () => {
    const { mapped, unrecognized } = mapSheetRow(
      { "Rule Id": "abc", "Visa Category": "STICKER", "Some Random Column": "x" },
      RULES_HEADER_FIELD_MAP,
    );
    expect(mapped).toEqual({ ruleId: "abc", visaCategory: "STICKER" });
    expect(unrecognized).toEqual(["Some Random Column"]);
  });
});

describe("resolveRuleRow", () => {
  const validId = "6a6f465ca047564c66c96805";

  it("requires a Rule Id, and it must be a valid ObjectId shape", () => {
    expect(resolveRuleRow({}, 2)).toEqual({ ok: false, reason: "Rule Id is required" });
    const bad = resolveRuleRow({ ruleId: "not-an-id" }, 2);
    expect(bad.ok).toBe(false);
    if (bad.ok === false) expect(bad.reason).toMatch(/not a valid id/);
  });

  it("rejects an invalid visaCategory", () => {
    const result = resolveRuleRow({ ruleId: validId, visaCategory: "NOT_REAL" }, 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/Visa Category/);
  });

  it("rejects an invalid etaBasis", () => {
    const result = resolveRuleRow({ ruleId: validId, etaBasis: "LUNAR" }, 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/ETA Basis/);
  });

  it("rejects etaMinDays present without etaMaxDays", () => {
    const result = resolveRuleRow({ ruleId: validId, etaMinDays: "3" }, 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/must both be present or both be blank/);
  });

  it("rejects etaMinDays greater than etaMaxDays", () => {
    const result = resolveRuleRow({ ruleId: validId, etaMinDays: "10", etaMaxDays: "5" }, 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/greater than/);
  });

  it("resolves a fully blank editable set to an edit with every field undefined (a true no-op)", () => {
    const result = resolveRuleRow({ ruleId: validId }, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edit).toEqual({
        ruleId: validId,
        visaCategory: undefined,
        etaMinDays: undefined,
        etaMaxDays: undefined,
        etaBasis: undefined,
        embassyFeeInr: undefined,
        vfsFeeInr: undefined,
        plumtripsServiceFeeInr: undefined,
        indicativeVisaCostInr: undefined,
        priceNote: undefined,
        opsNotes: undefined,
      });
    }
  });
});

describe("resolveRequirementRow", () => {
  const validId = "6a6f465ca047564c66c96805";

  it("requires Rule Id, Group Label, and a valid Requirement level", () => {
    expect(resolveRequirementRow({}, 2).ok).toBe(false);
    expect(resolveRequirementRow({ ruleId: validId }, 2).ok).toBe(false);
    const badLevel = resolveRequirementRow({ ruleId: validId, groupLabel: "X", requirement: "MAYBE" }, 2);
    expect(badLevel.ok).toBe(false);
  });

  it("requires at least one valid document code", () => {
    const result = resolveRequirementRow({ ruleId: validId, groupLabel: "Passport", requirement: "REQUIRED" }, 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/document code/);
  });

  it("auto-generates a group key from the label when blank", () => {
    const result = resolveRequirementRow(
      { ruleId: validId, groupLabel: "Valid Passport", requirement: "REQUIRED", documentCodes: "PASSPORT_ORIGINAL" },
      2,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.group.key).toBe("VALID_PASSPORT");
  });

  it("preserves an explicit group key verbatim (uppercased)", () => {
    const result = resolveRequirementRow(
      { ruleId: validId, groupKey: "my_key", groupLabel: "X", requirement: "REQUIRED", documentCodes: "PASSPORT_ORIGINAL" },
      2,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.group.key).toBe("MY_KEY");
  });
});
