import { describe, it, expect, vi, beforeEach } from "vitest";

// axios is the only external edge — stub it so selection is tested deterministically.
const H = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("axios", () => ({
  default: { get: H.get, isAxiosError: () => false },
  isAxiosError: () => false,
}));

process.env.FLIGHTAWARE_API_KEY = "test-key";

const { getFlightOccurrences, getFlightOccurrenceForDate, isFlightLookupError } =
  await import("./flightService.js");

/**
 * Shaped exactly like the live AIC4305 response confirmed during diagnosis:
 * NEWEST FIRST, ~10 days back to +2 days forward, daily 15:15Z DEL→DXB.
 * "now" in these tests is 2026-08-03T12:00:00Z.
 */
function aiRow(dateYMD: string, over: Record<string, any> = {}) {
  return {
    ident: "AIC4305",
    flight_number: "4305",
    status: "Scheduled",
    scheduled_out: `${dateYMD}T15:15:00Z`,
    scheduled_in: `${dateYMD}T19:00:00Z`,
    origin: { code_iata: "DEL", name: "Indira Gandhi Intl", city: "Delhi", timezone: "Asia/Kolkata" },
    destination: { code_iata: "DXB", name: "Dubai Intl", city: "Dubai", timezone: "Asia/Dubai" },
    terminal_origin: "3",
    terminal_destination: "1",
    ...over,
  };
}

const NOW = new Date("2026-08-03T12:00:00Z");

const NEWEST_FIRST = [
  aiRow("2026-08-05"),
  aiRow("2026-08-04"),
  aiRow("2026-08-03"),
  aiRow("2026-08-02", { status: "Arrived / Gate Arrival" }),
  aiRow("2026-08-01", { status: "Arrived / Gate Arrival" }),
  aiRow("2026-07-31", { status: "Arrived / Delayed" }),
];

beforeEach(() => {
  H.get.mockReset();
  H.get.mockResolvedValue({ data: { flights: NEWEST_FIRST } });
});

describe("getFlightOccurrences — the regression that started this", () => {
  it("does NOT return the +2-day window head; today's occurrence comes first", async () => {
    const res: any = await getFlightOccurrences("AI4305", { now: NOW });
    expect(isFlightLookupError(res)).toBe(false);
    // The old code returned flights[0] === 2026-08-05. That is the bug.
    expect(res.occurrences[0].servedDate).toBe("2026-08-03");
    expect(res.occurrences[0].servedDate).not.toBe("2026-08-05");
  });

  it("bounds the AeroAPI request with start/end instead of an unbounded max_pages", async () => {
    await getFlightOccurrences("AI4305", { now: NOW });
    const params = H.get.mock.calls[0][1].params;
    expect(params.start).toBeTruthy();
    expect(params.end).toBeTruthy();
    expect(Date.parse(params.start)).toBeLessThan(NOW.getTime());
    expect(Date.parse(params.end)).toBeGreaterThan(NOW.getTime());
  });

  it("converts IATA → ICAO for the AeroAPI ident", async () => {
    await getFlightOccurrences("AI4305", { now: NOW });
    expect(H.get.mock.calls[0][0]).toContain("/flights/AIC4305");
  });
});

describe("getFlightOccurrences — no date given", () => {
  it("returns up to 3 UPCOMING occurrences, soonest first", async () => {
    const res: any = await getFlightOccurrences("AI4305", { now: NOW, limit: 3 });
    expect(res.occurrences.map((o: any) => o.servedDate)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
    expect(res.requestedDate).toBeNull();
  });

  it("never includes past occurrences when upcoming ones exist", async () => {
    const res: any = await getFlightOccurrences("AI4305", { now: NOW, limit: 3 });
    for (const o of res.occurrences) {
      expect(Date.parse(o.departure.scheduled)).toBeGreaterThanOrEqual(NOW.getTime());
      expect(o.isPast).toBeFalsy();
    }
  });

  it("honours a smaller limit", async () => {
    const res: any = await getFlightOccurrences("AI4305", { now: NOW, limit: 1 });
    expect(res.occurrences).toHaveLength(1);
    expect(res.occurrences[0].servedDate).toBe("2026-08-03");
  });

  it("promotes a currently-airborne occurrence to the front", async () => {
    // Today's flight already departed (13:00Z) and has not arrived.
    H.get.mockResolvedValue({
      data: {
        flights: [
          aiRow("2026-08-05"),
          aiRow("2026-08-04"),
          {
            ...aiRow("2026-08-03"),
            scheduled_out: "2026-08-03T11:00:00Z",
            actual_out: "2026-08-03T11:05:00Z",
            status: "En Route",
            progress_percent: 40,
          },
        ],
      },
    });
    const res: any = await getFlightOccurrences("AI4305", { now: NOW, limit: 3 });
    expect(res.occurrences[0].servedDate).toBe("2026-08-03");
    expect(res.occurrences[0].isAirborne).toBe(true);
    expect(res.occurrences[0].flight_status).toBe("Departed");
  });

  it("falls back to the most recent PAST occurrence, labelled, when nothing is upcoming", async () => {
    H.get.mockResolvedValue({
      data: {
        flights: [
          aiRow("2026-08-02", { status: "Arrived / Gate Arrival" }),
          aiRow("2026-08-01", { status: "Arrived / Gate Arrival" }),
        ],
      },
    });
    const res: any = await getFlightOccurrences("AI4305", { now: NOW });
    expect(res.occurrences).toHaveLength(1);
    expect(res.occurrences[0].servedDate).toBe("2026-08-02"); // most recent, not oldest
    expect(res.occurrences[0].isPast).toBe(true);
  });
});

describe("getFlightOccurrences — date given", () => {
  it("returns the single occurrence for that ORIGIN-LOCAL date", async () => {
    const res: any = await getFlightOccurrences("AI4305", { now: NOW, date: "2026-08-05" });
    expect(res.occurrences).toHaveLength(1);
    expect(res.occurrences[0].servedDate).toBe("2026-08-05");
    expect(res.requestedDate).toBe("2026-08-05");
  });

  it("returns EMPTY rather than a different day when that date has no departure", async () => {
    const res: any = await getFlightOccurrences("AI4305", { now: NOW, date: "2026-08-09" });
    expect(res.occurrences).toEqual([]);
    expect(res.requestedDate).toBe("2026-08-09");
  });

  it("derives servedDate in the ORIGIN zone, not UTC", async () => {
    // 20:30Z on the 3rd is 02:00 on the 4th in Asia/Kolkata (+5:30).
    H.get.mockResolvedValue({
      data: { flights: [aiRow("2026-08-03", { scheduled_out: "2026-08-03T20:30:00Z" })] },
    });
    const res: any = await getFlightOccurrences("AI4305", { now: NOW, date: "2026-08-04" });
    expect(res.occurrences).toHaveLength(1);
    expect(res.occurrences[0].servedDate).toBe("2026-08-04");
  });
});

describe("occurrence payload", () => {
  it("carries the IANA zones straight through for per-airport rendering", async () => {
    const res: any = await getFlightOccurrences("AI4305", { now: NOW, limit: 1 });
    expect(res.occurrences[0].originTz).toBe("Asia/Kolkata");
    expect(res.occurrences[0].destinationTz).toBe("Asia/Dubai");
  });

  it("returns a not-found shape when the window is empty", async () => {
    H.get.mockResolvedValue({ data: { flights: [] } });
    const res: any = await getFlightOccurrences("AI4305", { now: NOW });
    expect(isFlightLookupError(res)).toBe(true);
    expect(res.links).toBeTruthy();
  });
});

describe("getFlightOccurrenceForDate — the watcher's path", () => {
  it("selects the WATCHED occurrence, not the newest-first window head", async () => {
    const watched = new Date("2026-08-03T15:15:00Z");
    const occ: any = await getFlightOccurrenceForDate("AI4305", watched);
    expect(isFlightLookupError(occ)).toBe(false);
    expect(occ.servedDate).toBe("2026-08-03");
    expect(occ.servedDate).not.toBe("2026-08-05"); // the pre-0.3 answer
  });

  it("returns a not-found shape when the watched date has no occurrence", async () => {
    const occ: any = await getFlightOccurrenceForDate("AI4305", new Date("2026-08-09T15:15:00Z"));
    expect(isFlightLookupError(occ)).toBe(true);
  });

  it("handles an unusable departDate without throwing", async () => {
    const occ: any = await getFlightOccurrenceForDate("AI4305", "not-a-date");
    expect(isFlightLookupError(occ)).toBe(true);
  });
});
