// The shared "booking that counts" rule. Shapes are asserted here; the route
// tests assert each figure actually uses them against real (raw-inserted) rows.
import { describe, it, expect } from "vitest";
import {
  BOOKING_STATUSES,
  COUNTED_STATUSES,
  isDemoSession,
  demoClause,
  liveBookingMatch,
  parseStatusFilter,
  InvalidStatusFilterError,
  countedStatusClause,
  countedBookingMatch,
  countsInMetrics,
} from "./bookingMetrics.js";

describe("bookingMetrics", () => {
  it("counts CONFIRMED + INVOICED by default", () => {
    expect([...COUNTED_STATUSES]).toEqual(["CONFIRMED", "INVOICED"]);
    expect(countedStatusClause()).toEqual({ status: { $in: ["CONFIRMED", "INVOICED"] } });
    expect(countedStatusClause("")).toEqual({ status: { $in: ["CONFIRMED", "INVOICED"] } });
  });

  it("an explicit status filter replaces the default", () => {
    expect(countedStatusClause("CANCELLED")).toEqual({ status: "CANCELLED" });
    expect(countedStatusClause({ $in: ["PENDING", "WIP"] })).toEqual({ status: { $in: ["PENDING", "WIP"] } });
  });

  it("demo is session-aware", () => {
    expect(isDemoSession(undefined)).toBe(false);
    expect(isDemoSession({ isDemoUser: true })).toBe(true);
    expect(isDemoSession({ _demoImpersonation: true })).toBe(true);
    expect(demoClause()).toEqual({ isDemo: { $ne: true } });
    expect(demoClause({ roles: ["ADMIN"] })).toEqual({ isDemo: { $ne: true } });
    expect(demoClause({ isDemoUser: true })).toEqual({ isDemo: true });
  });

  it("live = not deleted (missing isActive is live) + demo side", () => {
    expect(liveBookingMatch()).toEqual({ isActive: { $ne: false }, isDemo: { $ne: true } });
    expect(countedBookingMatch({ isDemoUser: true }, "WIP")).toEqual({
      isActive: { $ne: false },
      isDemo: true,
      status: "WIP",
    });
  });

  it("validates the status param against the enum", () => {
    expect(parseStatusFilter(undefined)).toBeUndefined();
    expect(parseStatusFilter("  ")).toBeUndefined();
    expect(parseStatusFilter("cancelled")).toBe("CANCELLED");
    for (const s of BOOKING_STATUSES) expect(parseStatusFilter(s)).toBe(s);
    expect(() => parseStatusFilter("FAILED")).toThrow(InvalidStatusFilterError);
    expect(() => parseStatusFilter({ $ne: "X" })).toThrow(InvalidStatusFilterError);
  });

  it("countsInMetrics mirrors the $match for rows in memory", () => {
    expect(countsInMetrics({ status: "CONFIRMED" }, false)).toBe(true);
    expect(countsInMetrics({ status: "INVOICED" }, false)).toBe(true);
    for (const s of ["PENDING", "WIP", "CANCELLED"]) expect(countsInMetrics({ status: s }, false)).toBe(false);
    expect(countsInMetrics({ status: "CONFIRMED", isActive: false }, false)).toBe(false);
    expect(countsInMetrics({ status: "CANCELLED" }, true)).toBe(true);
    expect(countsInMetrics({ status: "CANCELLED", isActive: false }, true)).toBe(false);
  });
});
