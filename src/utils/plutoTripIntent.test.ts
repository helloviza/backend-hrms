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
});
