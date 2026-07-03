import { describe, it, expect } from "vitest";
import { parseDateToISO } from "./plutoDate.js";

// Fixed "now" so future-year resolution is deterministic: 2026-07-04 (mid-year).
const NOW = new Date(2026, 6, 4); // month is 0-indexed → July

describe("parseDateToISO — dynamic future-year resolution", () => {
  it("missing-year date already passed this year → rolls to next year", () => {
    // Jan 5 is before Jul 4 2026 → 2027
    expect(parseDateToISO("5 Jan", NOW)).toBe("2027-01-05");
    expect(parseDateToISO("Jan 5", NOW)).toBe("2027-01-05");
  });

  it("missing-year date still upcoming this year → stays this year", () => {
    // Dec 20 is after Jul 4 2026 → 2026
    expect(parseDateToISO("20 Dec", NOW)).toBe("2026-12-20");
    expect(parseDateToISO("December 20", NOW)).toBe("2026-12-20");
  });

  it("boundary: today's day/month with no year → this year (not next)", () => {
    expect(parseDateToISO("4 Jul", NOW)).toBe("2026-07-04");
  });

  it("Dec → Jan rollover: near year-end, an early-month date → next year", () => {
    const dec = new Date(2026, 11, 15); // 2026-12-15
    expect(parseDateToISO("5 Jan", dec)).toBe("2027-01-05");
  });

  it("explicit 4-digit year is untouched", () => {
    expect(parseDateToISO("12th June 2026", NOW)).toBe("2026-06-12");
    expect(parseDateToISO("June 12 2026", NOW)).toBe("2026-06-12");
    // An explicit PAST year stays past — no future coercion.
    expect(parseDateToISO("12th June 2020", NOW)).toBe("2020-06-12");
  });

  it("explicit 2-digit year expands to 20xx (unchanged)", () => {
    expect(parseDateToISO("12 Jun 26", NOW)).toBe("2026-06-12");
  });

  it("already-ISO date is returned as-is", () => {
    expect(parseDateToISO("2026-05-20", NOW)).toBe("2026-05-20");
  });

  it("DD/MM/YYYY (Indian standard) unchanged", () => {
    expect(parseDateToISO("20/05/2026", NOW)).toBe("2026-05-20");
    expect(parseDateToISO("20-05-26", NOW)).toBe("2026-05-20");
  });

  it("empty / unparseable input → empty string", () => {
    expect(parseDateToISO("", NOW)).toBe("");
    expect(parseDateToISO(null, NOW)).toBe("");
    expect(parseDateToISO("sometime soon", NOW)).toBe("");
  });
});
