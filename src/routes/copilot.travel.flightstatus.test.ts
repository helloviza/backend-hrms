import { describe, it, expect } from "vitest";
import {
  isFlightStatusQuery,
  extractFlightDesignator,
  extractStatusDate,
} from "../utils/flightDesignator.js";
import { parseDateToISO } from "../utils/plutoDate.js";

// The route-search detector, copied verbatim from copilot.travel.ts so this test
// fails loudly if the two ever drift apart.
const isFlightRouteSearch = (p: string) =>
  Boolean(
    /(find|search|show|get|look up|check).{0,30}flight/i.test(p) ||
      /flights?\s+(from|between|on|available|for)/i.test(p) ||
      /flight\s+(option|price|fare|deal|available)/i.test(p) ||
      /available.*flight/i.test(p) ||
      /fly(ing)?\s+from\s+.{2,30}\s+to\s+/i.test(p),
  );

const looksLikeRouteSearch = (p: string) => /\bfrom\b[\s\S]{1,40}\bto\b/i.test(p);

/** Which branch of runConciergeTurn a prompt lands in. */
function route(p: string): "status" | "search" | "ai" {
  if (isFlightStatusQuery(p) && !looksLikeRouteSearch(p)) return "status";
  if (isFlightRouteSearch(p)) return "search";
  return "ai";
}

describe("branch routing — the two phrasings that used to fail differently", () => {
  it("(a) 'tell me the flight status of AI-4305 788' → status branch (was: AI path)", () => {
    const p = "tell me the flight status of AI-4305 788";
    expect(route(p)).toBe("status");
    expect(extractFlightDesignator(p)).toBe("AI4305");
    // "788" must not be mistaken for the flight number or a date.
    expect(extractStatusDate(p)).toBeNull();
  });

  it("(b) 'Check flight 6E-2582' → status branch (was: 'Which airport should I search?')", () => {
    const p = "Check flight 6E-2582";
    // It still matches the route-search detector...
    expect(isFlightRouteSearch(p)).toBe(true);
    // ...but the status branch runs first and wins.
    expect(route(p)).toBe("status");
    expect(extractFlightDesignator(p)).toBe("6E2582");
  });

  it("(c) 'status of AI-4305 on 5 Aug' → status branch, dated", () => {
    const p = "status of AI-4305 on 5 Aug";
    expect(route(p)).toBe("status");
    const token = extractStatusDate(p);
    expect(token).toBe("5 Aug");
    expect(parseDateToISO(token as string)).toMatch(/^\d{4}-08-05$/);
  });

  it("(d) a route search phrased with a designator still SEARCHES — the from/to tie-break", () => {
    // SINGULAR "flight" is a status-intent word, so this one genuinely reaches
    // the tie-break: designator present, intent present — and from…to wins.
    const singular = "find flight from DEL to BOM like AI 2024";
    expect(isFlightStatusQuery(singular)).toBe(true);
    expect(looksLikeRouteSearch(singular)).toBe(true);
    expect(route(singular)).toBe("search");
  });

  it("(d2) the PLURAL form never even looks like a status query", () => {
    // \bflight\b does not match "flights", so the intent test fails first and
    // the tie-break is never consulted. Documented so a future widening of
    // FLIGHT_STATUS_INTENT to /flights?/ has to confront this case knowingly.
    const plural = "find flights from DEL to BOM like AI 2024";
    expect(isFlightStatusQuery(plural)).toBe(false);
    expect(route(plural)).toBe("search");
  });

  it("ordinary planning prompts reach neither flight branch", () => {
    for (const p of [
      "Plan a business trip to Dubai, 20 Sep, flying from Bangalore",
      "3-day business trip to Tokyo",
      "trip in 2026",
    ]) {
      expect(route(p)).not.toBe("status");
    }
  });

  it("a route search with a year no longer looks like a status query at all", () => {
    const p = "flights from Bangalore to Dubai on 20 Sep 2026";
    expect(isFlightStatusQuery(p)).toBe(false);
    expect(route(p)).toBe("search");
  });
});

describe("extractStatusDate", () => {
  it("does not read a date out of the flight number itself", () => {
    // I5-754: a naive d/m pattern reads "5-75" here.
    expect(extractStatusDate("status of I5-754")).toBeNull();
    expect(extractStatusDate("is 6E-2582 delayed")).toBeNull();
    expect(extractStatusDate("UK 995 status")).toBeNull();
  });

  it("finds real date tokens", () => {
    expect(extractStatusDate("AI-4305 status on 5 Aug")).toBe("5 Aug");
    expect(extractStatusDate("AI-4305 on 12 December 2026")).toBe("12 December 2026");
    expect(extractStatusDate("AI-4305 status 25/12")).toBe("25/12");
  });
});
