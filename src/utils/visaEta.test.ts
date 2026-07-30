import { describe, it, expect } from "vitest";
import { computeEstimatedDecisionWindow } from "./visaEta.js";

describe("computeEstimatedDecisionWindow", () => {
  it("returns null when not yet lodged", () => {
    expect(computeEstimatedDecisionWindow(null, 5, 10, "BUSINESS")).toBeNull();
    expect(computeEstimatedDecisionWindow(undefined, 5, 10, "BUSINESS")).toBeNull();
  });

  it("returns null when the rule snapshot carries no ETA", () => {
    expect(computeEstimatedDecisionWindow(new Date("2026-08-03"), null, 10, "BUSINESS")).toBeNull();
    expect(computeEstimatedDecisionWindow(new Date("2026-08-03"), 5, null, "BUSINESS")).toBeNull();
  });

  it("adds calendar days when etaBasis is CALENDAR", () => {
    // Monday 2026-08-03 + 5/10 calendar days
    const result = computeEstimatedDecisionWindow(new Date("2026-08-03T00:00:00.000Z"), 5, 10, "CALENDAR");
    expect(result).toEqual({
      minDate: new Date("2026-08-08T00:00:00.000Z").toISOString(),
      maxDate: new Date("2026-08-13T00:00:00.000Z").toISOString(),
    });
  });

  it("skips weekends when etaBasis is BUSINESS", () => {
    // Monday 2026-08-03 + 5 business days = Monday 2026-08-10 (skips the
    // weekend of 8/9); + 10 business days = Monday 2026-08-17 (skips both
    // weekends in between).
    const result = computeEstimatedDecisionWindow(new Date("2026-08-03T00:00:00.000Z"), 5, 10, "BUSINESS");
    expect(result).toEqual({
      minDate: new Date("2026-08-10T00:00:00.000Z").toISOString(),
      maxDate: new Date("2026-08-17T00:00:00.000Z").toISOString(),
    });
  });

  it("treats a missing/unrecognised basis as calendar days, not business", () => {
    const withoutBasis = computeEstimatedDecisionWindow(new Date("2026-08-03T00:00:00.000Z"), 5, 5, undefined);
    const calendar = computeEstimatedDecisionWindow(new Date("2026-08-03T00:00:00.000Z"), 5, 5, "CALENDAR");
    expect(withoutBasis).toEqual(calendar);
  });

  it("a 0-day minimum resolves to the lodged date itself", () => {
    const result = computeEstimatedDecisionWindow(new Date("2026-08-03T00:00:00.000Z"), 0, 3, "CALENDAR");
    expect(result?.minDate).toBe(new Date("2026-08-03T00:00:00.000Z").toISOString());
  });
});
