import { describe, it, expect } from "vitest";
import { computeEstimatedDecisionWindow, assessProcessingRisk } from "./visaEta.js";

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

describe("assessProcessingRisk", () => {
  // Monday 2026-08-03.
  const NOW = new Date("2026-08-03T00:00:00.000Z");

  it("returns null when there is no travel date", () => {
    expect(assessProcessingRisk(null, 10, "CALENDAR", NOW)).toBeNull();
    expect(assessProcessingRisk(undefined, 10, "CALENDAR", NOW)).toBeNull();
  });

  it("returns null when the rule snapshot carries no etaMaxDays", () => {
    expect(assessProcessingRisk(new Date("2026-08-20"), null, "CALENDAR", NOW)).toBeNull();
    expect(assessProcessingRisk(new Date("2026-08-20"), undefined, "CALENDAR", NOW)).toBeNull();
  });

  it("CALENDAR basis: not at risk when calendar runway exceeds etaMaxDays", () => {
    // 2026-08-03 -> 2026-08-20 is 17 calendar days; etaMaxDays 15 fits.
    const result = assessProcessingRisk(new Date("2026-08-20T00:00:00.000Z"), 15, "CALENDAR", NOW);
    expect(result).toEqual({ atRisk: false, availableDays: 17, etaMaxDays: 15, marginDays: 2 });
  });

  it("CALENDAR basis: at risk when calendar runway is short of etaMaxDays", () => {
    // 2026-08-03 -> 2026-08-10 is 7 calendar days; etaMaxDays 15 does not fit.
    const result = assessProcessingRisk(new Date("2026-08-10T00:00:00.000Z"), 15, "CALENDAR", NOW);
    expect(result).toEqual({ atRisk: true, availableDays: 7, etaMaxDays: 15, marginDays: -8 });
  });

  it("BUSINESS basis: counts only Mon-Fri, so the same travel date can flip at-risk vs CALENDAR", () => {
    // 2026-08-03 (Mon) -> 2026-08-17 (Mon) is 14 calendar days but only 10
    // business days (two weekends excluded) — etaMaxDays 12 fits under
    // CALENDAR but not under BUSINESS.
    const travelDate = new Date("2026-08-17T00:00:00.000Z");
    const calendar = assessProcessingRisk(travelDate, 12, "CALENDAR", NOW);
    const business = assessProcessingRisk(travelDate, 12, "BUSINESS", NOW);
    expect(calendar!.atRisk).toBe(false);
    expect(calendar!.availableDays).toBe(14);
    expect(business!.atRisk).toBe(true);
    expect(business!.availableDays).toBe(10);
  });

  it("treats a missing/unrecognised basis as CALENDAR, not BUSINESS", () => {
    const travelDate = new Date("2026-08-17T00:00:00.000Z");
    const withoutBasis = assessProcessingRisk(travelDate, 12, undefined, NOW);
    const calendar = assessProcessingRisk(travelDate, 12, "CALENDAR", NOW);
    expect(withoutBasis).toEqual(calendar);
  });

  it("a travel date already in the past is always at risk, with a negative margin", () => {
    const result = assessProcessingRisk(new Date("2026-07-20T00:00:00.000Z"), 5, "CALENDAR", NOW);
    expect(result!.atRisk).toBe(true);
    expect(result!.availableDays).toBeLessThan(0);
    expect(result!.marginDays).toBeLessThan(0);
  });

  it("margin of exactly zero (runway equals etaMaxDays) is NOT at risk", () => {
    // 2026-08-03 -> 2026-08-18 is exactly 15 calendar days.
    const result = assessProcessingRisk(new Date("2026-08-18T00:00:00.000Z"), 15, "CALENDAR", NOW);
    expect(result).toEqual({ atRisk: false, availableDays: 15, etaMaxDays: 15, marginDays: 0 });
  });
});
