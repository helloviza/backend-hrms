import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Guards the OUTBOUND request shape against AeroAPI's two documented bound
 * rules. Both were violated in production simultaneously, and because the start
 * bound is validated first, the malformed-timestamp fault masked the
 * window-too-wide fault — fixing either alone still 400'd. So these are
 * asserted independently, not through a single happy-path call.
 *
 * Confirmed live against AeroAPI during diagnosis:
 *   start with milliseconds  -> 400 "Invalid start bound: type is incorrect"
 *   end at now+3d            -> 400 "Invalid end bound: time is too far in the future (limit: 2 days)"
 */

const H = vi.hoisted(() => ({ get: vi.fn(), isAxiosError: true }));
vi.mock("axios", () => ({
  default: { get: H.get, isAxiosError: () => H.isAxiosError },
  isAxiosError: () => H.isAxiosError,
}));

process.env.FLIGHTAWARE_API_KEY = "test-key";

const { getFlightOccurrences, isFlightLookupError, toAeroBound, AEROAPI_MAX_FORWARD_MS } =
  await import("./flightService.js");

const NOW = new Date("2026-08-05T12:00:00.123Z"); // deliberately has ms
const TWO_DAYS_MS = 2 * 86400_000;

function okRow(dateYMD: string) {
  return {
    ident: "IGO5001",
    flight_number: "5001",
    status: "Scheduled",
    scheduled_out: `${dateYMD}T04:30:00Z`,
    scheduled_in: `${dateYMD}T06:45:00Z`,
    origin: { code_iata: "BLR", name: "Kempegowda Intl", city: "Bengaluru", timezone: "Asia/Kolkata" },
    destination: { code_iata: "BOM", name: "Chhatrapati Shivaji", city: "Mumbai", timezone: "Asia/Kolkata" },
  };
}

/** The params object the service actually put on the wire. */
function sentParams() {
  expect(H.get).toHaveBeenCalled();
  return H.get.mock.calls[0][1].params as { start: string; end: string; max_pages: number };
}

beforeEach(() => {
  H.get.mockReset();
  H.isAxiosError = true;
  H.get.mockResolvedValue({ data: { flights: [okRow("2026-08-05")] } });
});

describe("AeroAPI bound formatting", () => {
  it("sends no fractional seconds on either bound, even when now carries ms", async () => {
    await getFlightOccurrences("6E5001", { now: NOW });
    const p = sentParams();
    expect(p.start).not.toMatch(/\.\d+Z$/);
    expect(p.end).not.toMatch(/\.\d+Z$/);
    // and is still a well-formed instant
    expect(Number.isNaN(Date.parse(p.start))).toBe(false);
    expect(Number.isNaN(Date.parse(p.end))).toBe(false);
  });

  it("toAeroBound strips fractional seconds and leaves an already-clean bound alone", () => {
    expect(toAeroBound("2026-08-05T12:00:00.123Z")).toBe("2026-08-05T12:00:00Z");
    expect(toAeroBound("2026-08-05T12:00:00Z")).toBe("2026-08-05T12:00:00Z");
  });
});

describe("AeroAPI forward-window cap", () => {
  it("never sends an end bound more than 2 days ahead — undated ask", async () => {
    await getFlightOccurrences("6E5001", { now: NOW });
    const p = sentParams();
    expect(Date.parse(p.end)).toBeLessThanOrEqual(NOW.getTime() + TWO_DAYS_MS);
  });

  it("never sends an end bound more than 2 days ahead — dated ask for a future date", async () => {
    // date+2d would land ~4 days out and 400 before the fix
    await getFlightOccurrences("6E5001", { now: NOW, date: "2026-08-07" });
    const p = sentParams();
    expect(Date.parse(p.end)).toBeLessThanOrEqual(NOW.getTime() + TWO_DAYS_MS);
  });

  it("leaves a past-dated window untouched — the clamp is one-sided", async () => {
    await getFlightOccurrences("6E5001", { now: NOW, date: "2026-08-01" });
    const p = sentParams();
    expect(Date.parse(p.end)).toBeLessThan(NOW.getTime());
  });

  it("the clamp constant stays inside AeroAPI's documented 2-day limit", () => {
    expect(AEROAPI_MAX_FORWARD_MS).toBeLessThan(TWO_DAYS_MS);
  });

  it("a date past the horizon returns an honest not-found without calling AeroAPI", async () => {
    const r = await getFlightOccurrences("6E5001", { now: NOW, date: "2026-09-20" });
    expect(H.get).not.toHaveBeenCalled();
    expect(isFlightLookupError(r)).toBe(true);
    expect((r as any).message).toMatch(/aren't published that far ahead/i);
  });
});

describe("400 handling", () => {
  it("surfaces AeroAPI's own detail instead of reporting a false outage", async () => {
    H.get.mockRejectedValue({
      response: { status: 400, data: { detail: "Invalid end bound: time is too far in the future (limit: 2 days)" } },
      message: "Request failed with status code 400",
    });
    await expect(getFlightOccurrences("6E5001", { now: NOW })).rejects.toThrow(
      /AeroAPI rejected the request \(400\).*too far in the future/,
    );
  });

  it("still names the fault when AeroAPI returns a 400 with no detail field", async () => {
    H.get.mockRejectedValue({ response: { status: 400, data: {} }, message: "Request failed with status code 400" });
    await expect(getFlightOccurrences("6E5001", { now: NOW })).rejects.toThrow(/400/);
  });

  it("a 404 is still a clean not-found, not a throw", async () => {
    H.get.mockRejectedValue({ response: { status: 404, data: {} }, message: "Request failed with status code 404" });
    const r = await getFlightOccurrences("6E5001", { now: NOW });
    expect(isFlightLookupError(r)).toBe(true);
  });
});
