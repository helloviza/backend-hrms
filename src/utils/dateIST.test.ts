// The "what day is it in IST" helpers — the foundation for the attendance P0
// fix and the later date-site sweep. Pure functions; every case stands on a
// fixed instant so the process timezone is irrelevant.
import { describe, it, expect } from "vitest";
import { todayIST, istDateString, startOfTodayIST, endOfTodayIST, addDaysIST, parseISTStart, parseISTEnd, istRangeStart, istRangeEnd } from "./dateIST.js";

// 2026-09-19T18:30:00Z is exactly 2026-09-20 00:00 IST — the boundary.
const IST_MIDNIGHT_UTC = Date.UTC(2026, 8, 19, 18, 30, 0, 0);
const MIN = 60_000;

describe("todayIST / istDateString — the IST calendar day across midnight", () => {
  it("the UTC day and the IST day disagree for the first 5½ hours of every IST day", () => {
    // 00:30 IST on the 20th is still the 19th in UTC.
    const at = IST_MIDNIGHT_UTC + 30 * MIN;
    expect(new Date(at).toISOString().slice(0, 10)).toBe("2026-09-19"); // the bug's answer
    expect(todayIST(at)).toBe("2026-09-20"); // the right one
  });
  it("flips exactly at 18:30Z, one millisecond either side", () => {
    expect(todayIST(IST_MIDNIGHT_UTC - 1)).toBe("2026-09-19");
    expect(todayIST(IST_MIDNIGHT_UTC)).toBe("2026-09-20");
  });
  it("agrees with the UTC day from 05:30 IST until midnight IST (normal hours unchanged)", () => {
    const tenAmIst = Date.UTC(2026, 8, 20, 4, 30); // 10:00 IST
    expect(todayIST(tenAmIst)).toBe("2026-09-20");
    expect(new Date(tenAmIst).toISOString().slice(0, 10)).toBe("2026-09-20");
    const elevenPmIst = Date.UTC(2026, 8, 20, 17, 30); // 23:00 IST
    expect(todayIST(elevenPmIst)).toBe("2026-09-20");
  });
  it("crosses month and year boundaries correctly", () => {
    expect(todayIST(Date.UTC(2026, 8, 30, 19, 0))).toBe("2026-10-01"); // 00:30 IST Oct 1
    expect(todayIST(Date.UTC(2026, 11, 31, 20, 0))).toBe("2027-01-01"); // 01:30 IST Jan 1
  });
  it("accepts a Date or a number and defaults to now", () => {
    const d = new Date(IST_MIDNIGHT_UTC + 60 * MIN);
    expect(istDateString(d)).toBe("2026-09-20");
    expect(istDateString(d.getTime())).toBe("2026-09-20");
    expect(todayIST()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("startOfTodayIST / endOfTodayIST — instants that bracket the IST day", () => {
  it("are 00:00:00.000+05:30 and 23:59:59.999+05:30 of the IST day, whichever side of UTC midnight now is", () => {
    const at = IST_MIDNIGHT_UTC + 30 * MIN; // 00:30 IST Sep 20
    expect(startOfTodayIST(at).toISOString()).toBe("2026-09-19T18:30:00.000Z");
    expect(endOfTodayIST(at).toISOString()).toBe("2026-09-20T18:29:59.999Z");
    expect(startOfTodayIST(at).getTime()).toBe(parseISTStart("2026-09-20").getTime());
    expect(endOfTodayIST(at).getTime()).toBe(parseISTEnd("2026-09-20").getTime());
  });
});

describe("addDaysIST — pure calendar arithmetic", () => {
  it("adds and subtracts whole IST days, across month ends and the year", () => {
    expect(addDaysIST("2026-09-20", -30)).toBe("2026-08-21");
    expect(addDaysIST("2026-09-01", -1)).toBe("2026-08-31");
    expect(addDaysIST("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIST("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysIST("2026-09-20", 0)).toBe("2026-09-20");
  });
});

describe("istRangeStart / istRangeEnd — dateFrom/dateTo params as whole IST days", () => {
  it("a YYYY-MM-DD names that IST day (new Date(\"YYYY-MM-DD\") would be UTC midnight = 05:30 IST)", () => {
    expect(istRangeStart("2026-09-23")!.toISOString()).toBe("2026-09-22T18:30:00.000Z");
    expect(istRangeEnd("2026-09-23")!.toISOString()).toBe("2026-09-23T18:29:59.999Z");
  });
  it("a full timestamp names the IST day containing it (the dashboard sends browser-IST midnight)", () => {
    expect(istRangeStart("2026-09-22T18:30:00.000Z")!.toISOString()).toBe("2026-09-22T18:30:00.000Z");
    expect(istRangeEnd("2026-09-23T18:29:59.999Z")!.toISOString()).toBe("2026-09-23T18:29:59.999Z");
    // 00:30 IST on the 23rd is still the 22nd in UTC — the bound is still the 23rd.
    expect(istRangeStart("2026-09-22T19:00:00.000Z")!.toISOString()).toBe("2026-09-22T18:30:00.000Z");
  });
  it("absent or unparseable → null (no bound); an impossible day is refused, not rolled over (the old new Date() read 2026-02-31 as Mar 3)", () => {
    for (const bad of [undefined, null, "", "not-a-date", "2026-02-31"]) {
      expect(istRangeStart(bad)).toBeNull();
      expect(istRangeEnd(bad)).toBeNull();
    }
  });
});
