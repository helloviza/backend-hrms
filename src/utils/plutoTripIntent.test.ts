import { describe, it, expect } from "vitest";
import { isMultiCityIntent, resolveRoundTripIntent } from "./plutoTripIntent.js";

describe("isMultiCityIntent", () => {
  it("detects the explicit 'multi-city' phrase", () => {
    expect(isMultiCityIntent("plan a multi-city trip")).toBe(true);
    expect(isMultiCityIntent("multi city flights please")).toBe(true);
  });

  it("detects 2+ 'to <City>' hops", () => {
    expect(isMultiCityIntent("flights from Delhi to Mumbai to Goa")).toBe(true);
  });

  it("single 'to <City>' hop is NOT multi-city", () => {
    expect(isMultiCityIntent("flights from Delhi to Mumbai on 5 May")).toBe(false);
  });

  it("filler like 'to be confirmed' does not trigger", () => {
    expect(isMultiCityIntent("flights to Mumbai, dates to be confirmed")).toBe(false);
  });
});

describe("resolveRoundTripIntent", () => {
  it("keyword 'round trip' with no date → wantsRoundTrip, no returnDate", () => {
    const r = resolveRoundTripIntent("round trip from Delhi to Mumbai");
    expect(r.wantsRoundTrip).toBe(true);
    expect(r.returnDateRaw).toBeNull();
  });

  it("keyword 'returning' + a second date → wantsRoundTrip + that return date", () => {
    const r = resolveRoundTripIntent("Delhi to Mumbai on 10 May returning 20 May");
    expect(r.wantsRoundTrip).toBe(true);
    expect(r.returnDateRaw).toBe("20 May");
  });

  it("two dates with no keyword still resolves a return date", () => {
    const r = resolveRoundTripIntent("flights Delhi to Mumbai 10 May 20 May");
    expect(r.wantsRoundTrip).toBe(true);
    expect(r.returnDateRaw).toBe("20 May");
  });

  it("single date, no keyword → one-way (not round trip)", () => {
    const r = resolveRoundTripIntent("flights Delhi to Mumbai on 10 May");
    expect(r.wantsRoundTrip).toBe(false);
    expect(r.returnDateRaw).toBeNull();
  });

  it("falls back to a locked context return date", () => {
    const r = resolveRoundTripIntent("flights Delhi to Mumbai", "2026-05-20");
    expect(r.wantsRoundTrip).toBe(true);
    expect(r.returnDateRaw).toBe("2026-05-20");
  });

  it("the exact observed turn-2 phrasing → round trip + the second date", () => {
    const r = resolveRoundTripIntent(
      "so i am flying from Delhi on 20th September 2026 and returning back by 24th September. Can you suggest few good business hotel and cheapest flight for me.",
      null,
      "2026-09-20",
    );
    expect(r.wantsRoundTrip).toBe(true);
    expect(r.returnDateRaw).toBe("24th September");
  });

  it("bare-day return ('back on the 24th') inherits month+year from the outbound date", () => {
    const r = resolveRoundTripIntent("Delhi to Tokyo on 20th September, back on the 24th", null, "2026-09-20");
    expect(r.wantsRoundTrip).toBe(true);
    expect(r.returnDateRaw).toBe("2026-09-24");
  });

  it("'coming back' with a bare day is still a round trip", () => {
    const r = resolveRoundTripIntent("fly out 20th September, coming back on the 25th", null, "2026-09-20");
    expect(r.wantsRoundTrip).toBe(true);
    expect(r.returnDateRaw).toBe("2026-09-25");
  });

  it("return date given in an earlier turn, then 'find flights' → uses the locked return date", () => {
    const r = resolveRoundTripIntent("find flights", "2026-09-24", "2026-09-20");
    expect(r.wantsRoundTrip).toBe(true);
    expect(r.returnDateRaw).toBe("2026-09-24");
  });

  it("explicit one-way with a single date stays one-way", () => {
    const r = resolveRoundTripIntent("one way from Delhi to Tokyo on 20th September", null, "2026-09-20");
    expect(r.wantsRoundTrip).toBe(false);
    expect(r.returnDateRaw).toBeNull();
  });
});
