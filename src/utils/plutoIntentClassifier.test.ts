import { describe, it, expect } from "vitest";
import { classifyPlutoIntent } from "./plutoIntentClassifier.js";

describe("classifyPlutoIntent — PLANNING word-boundary (2026-08 audit)", () => {
  it("a place name containing \"plan\" as a substring is NOT planning intent", () => {
    // The original bug: text.includes("plan") fired on "Plano".
    expect(classifyPlutoIntent("Hotels in Plano, Texas")).toBe("DISCOVERY");
  });

  it("mentioning a plane/airplane is NOT planning intent", () => {
    expect(classifyPlutoIntent("What time does the plane leave?")).toBe("DISCOVERY");
    expect(classifyPlutoIntent("Book my airplane tickets")).toBe("DISCOVERY");
  });

  it("mentioning a planet is NOT planning intent", () => {
    expect(classifyPlutoIntent("Is Mars the closest planet?")).toBe("DISCOVERY");
  });

  it("the rewritten canned-fallback suggestions classify as DISCOVERY", () => {
    // Replaces the old "Plan a trip inspired by this video" / "Create an
    // itinerary", both of which forced PLANNING on a conversation with
    // nothing locked yet.
    expect(classifyPlutoIntent("Suggest a trip inspired by this video")).toBe("DISCOVERY");
    expect(classifyPlutoIntent("Recommend a trip for me")).toBe("DISCOVERY");
  });

  it("the attraction-card message classifies as DISCOVERY", () => {
    expect(
      classifyPlutoIntent("Tell me about Lalbagh Botanical Garden in Bengaluru — and would you recommend building a trip around it?"),
    ).toBe("DISCOVERY");
  });

  it("a genuine planning request still classifies as PLANNING", () => {
    expect(classifyPlutoIntent("Can you plan my Tokyo trip?")).toBe("PLANNING");
    expect(classifyPlutoIntent("Help me plan a 5-day itinerary")).toBe("PLANNING");
  });

  it("plan/plans/planning/planned all still match as whole words", () => {
    expect(classifyPlutoIntent("I want to plan something")).toBe("PLANNING");
    expect(classifyPlutoIntent("What are our plans for Dubai?")).toBe("PLANNING");
    expect(classifyPlutoIntent("Still planning the honeymoon")).toBe("PLANNING");
    expect(classifyPlutoIntent("Already planned the flights")).toBe("PLANNING");
  });

  it("itinerary still matches (word-bounded, no known real-world collision)", () => {
    expect(classifyPlutoIntent("Send me the itinerary")).toBe("PLANNING");
  });

  it("REFINEMENT and PIVOT are untouched by the word-boundary fix", () => {
    expect(classifyPlutoIntent("Add another hotel night")).toBe("REFINEMENT");
    expect(classifyPlutoIntent("Actually, let's go to Dubai instead")).toBe("PIVOT");
  });
});
