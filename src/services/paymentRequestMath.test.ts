// Payment request arithmetic: integer paise, exact sums, ₹1 floor, PG charge.
import { describe, it, expect } from "vitest";
import {
  splitBases,
  parsePgPct,
  pgChargePaise,
  clampExpiry,
  coveredBasePaise,
  deriveRequestStatus,
  rupeesToPaise,
  MIN_EXPIRY_MS,
  DEFAULT_EXPIRY_MS,
} from "./paymentRequestMath.js";

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

describe("splitBases", () => {
  it("one link carries the whole target", () => {
    expect(splitBases(1234567, { mode: "EQUAL", parts: 1 })).toEqual({ bases: [1234567], pattern: "100" });
  });

  it("equal split floors each link and gives the remainder to the last (3-way)", () => {
    const { bases } = splitBases(100001, { mode: "EQUAL", parts: 3 });
    expect(bases).toEqual([33333, 33333, 33335]);
    expect(sum(bases)).toBe(100001);
  });

  it("percent splits 50:50, 60:40, 40:40:20 sum exactly", () => {
    for (const p of [[50, 50], [60, 40], [40, 40, 20], [33.33, 33.33, 33.34]]) {
      for (const target of [100001, 999999, 12345, 1000]) {
        const { bases } = splitBases(target, { mode: "PERCENT", percents: p });
        expect(bases.length).toBe(p.length);
        expect(sum(bases)).toBe(target);
      }
    }
    expect(splitBases(100001, { mode: "PERCENT", percents: [60, 40] }).bases).toEqual([60000, 40001]);
  });

  it("percents must add to 100", () => {
    expect(() => splitBases(10000, { mode: "PERCENT", percents: [50, 40] })).toThrow(/100%/);
  });

  it("explicit amounts must sum to the target", () => {
    expect(splitBases(10000, { mode: "AMOUNTS", amountsPaise: [6000, 4000] }).bases).toEqual([6000, 4000]);
    expect(() => splitBases(10000, { mode: "AMOUNTS", amountsPaise: [6000, 3999] })).toThrow(/add up/);
  });

  it("every link must be at least ₹1 (100 paise)", () => {
    expect(splitBases(300, { mode: "EQUAL", parts: 3 }).bases).toEqual([100, 100, 100]);
    expect(() => splitBases(299, { mode: "EQUAL", parts: 3 })).toThrow(/at least ₹1/);
    expect(() => splitBases(10000, { mode: "AMOUNTS", amountsPaise: [9901, 99] })).toThrow(/at least ₹1/);
    expect(() => splitBases(99, { mode: "EQUAL", parts: 1 })).toThrow();
  });

  it("1 to 3 links only", () => {
    expect(() => splitBases(10000, { mode: "EQUAL", parts: 4 })).toThrow();
    expect(() => splitBases(10000, { mode: "EQUAL", parts: 0 })).toThrow();
    expect(() => splitBases(10000, { mode: "PERCENT", percents: [25, 25, 25, 25] })).toThrow();
  });
});

describe("PG charge", () => {
  it("accepts 0–10 with at most two decimals", () => {
    expect(parsePgPct(undefined)).toBe(0);
    expect(parsePgPct(0)).toBe(0);
    expect(parsePgPct("2")).toBe(2);
    expect(parsePgPct(1.75)).toBe(1.75);
    expect(parsePgPct(10)).toBe(10);
    expect(() => parsePgPct(10.01)).toThrow();
    expect(() => parsePgPct(-1)).toThrow();
    expect(() => parsePgPct(1.234)).toThrow(/two decimals/);
    expect(() => parsePgPct("abc")).toThrow();
  });

  it("is round(base × pct / 100) in paise", () => {
    expect(pgChargePaise(100000, 2)).toBe(2000);
    expect(pgChargePaise(33333, 2)).toBe(667); // 666.66 → 667
    expect(pgChargePaise(12345, 1.75)).toBe(216); // 216.0375
    expect(pgChargePaise(100000, 0)).toBe(0);
    expect(pgChargePaise(100001, 10)).toBe(10000); // 10000.1
  });
});

describe("rupeesToPaise", () => {
  it("rounds float rupees to integer paise", () => {
    expect(rupeesToPaise(1234.56)).toBe(123456);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(Number.isNaN(rupeesToPaise("x"))).toBe(true);
  });
});

describe("clampExpiry", () => {
  const now = new Date("2026-10-26T10:00:00Z");
  it("defaults to +3 days", () => {
    expect(clampExpiry(undefined, now).getTime()).toBe(now.getTime() + DEFAULT_EXPIRY_MS);
  });
  it("never earlier than 15 minutes ahead", () => {
    const t = clampExpiry(new Date(now.getTime() + 60_000), now).getTime();
    expect(t).toBeGreaterThanOrEqual(now.getTime() + MIN_EXPIRY_MS);
  });
  it("never later than 6 months ahead", () => {
    const sixMonths = new Date(now);
    sixMonths.setMonth(sixMonths.getMonth() + 6);
    expect(clampExpiry(new Date("2030-01-01"), now).getTime()).toBeLessThan(sixMonths.getTime());
  });
  it("rejects garbage", () => {
    expect(() => clampExpiry("not a date", now)).toThrow();
  });
});

describe("sum rule and status", () => {
  it("covered = live + unreplaced dead links", () => {
    const links = [
      { _id: "a", basePaise: 5000, status: "PAID" },
      { _id: "b", basePaise: 5000, status: "EXPIRED" },
    ];
    expect(coveredBasePaise(links)).toBe(10000);
    const replaced = [...links, { _id: "c", basePaise: 5000, status: "CREATED", replacesLinkId: "b" }];
    expect(coveredBasePaise(replaced)).toBe(10000);
  });

  it("derives OPEN / PARTLY_PAID / PAID / CANCELLED", () => {
    expect(deriveRequestStatus([{ basePaise: 100, status: "CREATED" }], 100)).toBe("OPEN");
    expect(deriveRequestStatus([{ basePaise: 100, status: "FAILED_CREATE" }], 100)).toBe("OPEN");
    expect(deriveRequestStatus([{ basePaise: 50, status: "PAID" }, { basePaise: 50, status: "CREATED" }], 100)).toBe("PARTLY_PAID");
    expect(deriveRequestStatus([{ basePaise: 50, status: "PAID" }, { basePaise: 50, status: "EXPIRED" }], 100)).toBe("PARTLY_PAID");
    expect(deriveRequestStatus([{ basePaise: 50, status: "PAID" }, { basePaise: 50, status: "PAID" }], 100)).toBe("PAID");
    expect(deriveRequestStatus([{ basePaise: 100, status: "CANCELLED" }], 100)).toBe("CANCELLED");
    expect(deriveRequestStatus([{ basePaise: 100, status: "EXPIRED" }], 100)).toBe("CANCELLED");
  });
});
