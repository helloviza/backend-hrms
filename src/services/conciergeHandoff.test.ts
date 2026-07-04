import { describe, it, expect } from "vitest";
import { renderTripSummaryHtml } from "./conciergeHandoff.js";

describe("renderTripSummaryHtml", () => {
  it("empty / no bundle → '' (single-flight email unchanged)", () => {
    expect(renderTripSummaryHtml(null)).toBe("");
    expect(renderTripSummaryHtml(undefined)).toBe("");
    expect(renderTripSummaryHtml({})).toBe("");
  });

  it("renders both legs, hotel, policy, and summary", () => {
    const html = renderTripSummaryHtml({
      outboundFlight: { airline: { name: "IndiGo" }, flightNo: "6E-2582", origin: { code: "DEL" }, destination: { code: "BOM" }, fare: { offered: 4800 } },
      inboundFlight: { airline: { name: "Air India" }, flightNo: "AI-660", origin: { code: "BOM" }, destination: { code: "DEL" }, fare: { offered: 5200 } },
      hotel: { name: "Taj Santacruz" },
      policyStatus: "NEEDS_APPROVAL",
      conversationSummary: "3 nights, business trip",
    });
    expect(html).toContain("Trip summary");
    expect(html).toContain("Outbound");
    expect(html).toContain("6E-2582");
    expect(html).toContain("DEL → BOM");
    expect(html).toContain("Return");
    expect(html).toContain("AI-660");
    expect(html).toContain("Taj Santacruz");
    expect(html).toContain("NEEDS_APPROVAL");
    expect(html).toContain("3 nights, business trip");
  });

  it("outbound-only bundle omits the return line", () => {
    const html = renderTripSummaryHtml({
      outboundFlight: { flightNo: "6E-1", origin: { code: "DEL" }, destination: { code: "GOI" } },
    });
    expect(html).toContain("Outbound");
    expect(html).not.toContain("Return");
  });
});
