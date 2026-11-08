// resolveRelativeDate — "today / tomorrow / next week / this weekend" → a
// concrete IST date, with the rule stated so the reply can say it back.
import { describe, it, expect } from "vitest";
import { resolveRelativeDate, parseDateToISO } from "./plutoDate.js";

// 2026-11-09 is a Monday. Noon IST = 06:30Z.
const MON = new Date("2026-11-09T06:30:00Z");
const SAT = new Date("2026-11-14T06:30:00Z");
const SUN = new Date("2026-11-15T06:30:00Z");

describe("resolveRelativeDate", () => {
  it("'next week' on a Monday → the Monday of next week (+7)", () => {
    const r = resolveRelativeDate("Find flights to Mumbai next week", MON);
    expect(r).toMatchObject({ iso: "2026-11-16", display: "16 Nov 2026", phrase: "next week" });
    expect(r?.rule).toBe("the Monday of next week — Monday 16 Nov 2026");
  });
  it("'next week' on a Sunday → tomorrow (next week starts Monday)", () =>
    expect(resolveRelativeDate("next week", SUN)?.iso).toBe("2026-11-16"));
  it("'tomorrow' → +1", () => expect(resolveRelativeDate("flights tomorrow", MON)?.iso).toBe("2026-11-10"));
  it("'day after tomorrow' → +2 (not read as 'tomorrow')", () =>
    expect(resolveRelativeDate("day after tomorrow", MON)).toMatchObject({ iso: "2026-11-11", phrase: "day after tomorrow" }));
  it("'today' / 'tonight' → today", () => {
    expect(resolveRelativeDate("today", MON)?.iso).toBe("2026-11-09");
    expect(resolveRelativeDate("tonight", MON)?.phrase).toBe("tonight");
  });
  it("'this weekend' on a Monday → coming Saturday", () =>
    expect(resolveRelativeDate("this weekend", MON)?.iso).toBe("2026-11-14"));
  it("'this weekend' on a Saturday → today", () => expect(resolveRelativeDate("this weekend", SAT)?.iso).toBe("2026-11-14"));
  it("'this weekend' on a Sunday → today (still the weekend)", () =>
    expect(resolveRelativeDate("this weekend", SUN)?.iso).toBe("2026-11-15"));
  it("'next weekend' on a Monday → Saturday of next week", () =>
    expect(resolveRelativeDate("next weekend", MON)?.iso).toBe("2026-11-21"));
  it("'next weekend' on a Sunday → the following Saturday (+6)", () =>
    expect(resolveRelativeDate("next weekend", SUN)?.iso).toBe("2026-11-21"));
  it("uses the IST calendar day, not UTC: 20:00Z Monday is already Tuesday in IST", () =>
    expect(resolveRelativeDate("today", new Date("2026-11-09T20:00:00Z"))?.iso).toBe("2026-11-10"));
  it("no relative phrase → null", () => expect(resolveRelativeDate("flights to Mumbai on 20 Nov", MON)).toBeNull());
  it("display round-trips through parseDateToISO unchanged", () => {
    const r = resolveRelativeDate("next week", MON)!;
    expect(parseDateToISO(r.display, MON)).toBe(r.iso);
  });
});
