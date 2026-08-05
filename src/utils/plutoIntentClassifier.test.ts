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

  it("REFINEMENT and PIVOT still fire on their real keywords", () => {
    expect(classifyPlutoIntent("Add another hotel night")).toBe("REFINEMENT");
    expect(classifyPlutoIntent("Actually, let's go to Dubai instead")).toBe("PIVOT");
  });
});

describe("classifyPlutoIntent — REFINEMENT/PIVOT word-boundary (2026-08 audit, pass 2)", () => {
  it("\"address\" is not REFINEMENT — the urgent collision (constant in travel copy)", () => {
    expect(classifyPlutoIntent("what's the address of the hotel")).toBe("DISCOVERY");
  });

  it("\"additional\" is not REFINEMENT", () => {
    expect(classifyPlutoIntent("any additional fees")).toBe("DISCOVERY");
  });

  it("bare \"add\" still classifies as REFINEMENT", () => {
    expect(classifyPlutoIntent("add a day in Rome")).toBe("REFINEMENT");
  });

  it("add/adds/adding/added all still match as whole words", () => {
    expect(classifyPlutoIntent("adds a stop in Kyoto")).toBe("REFINEMENT");
    expect(classifyPlutoIntent("adding a connecting flight")).toBe("REFINEMENT");
    expect(classifyPlutoIntent("added a hotel night")).toBe("REFINEMENT");
  });

  it("\"exchange to\" does not PIVOT — the \"change to\" collision", () => {
    expect(classifyPlutoIntent("exchange to USD")).toBe("DISCOVERY");
  });

  it("bare \"change to\" still classifies as PIVOT", () => {
    expect(classifyPlutoIntent("change to a window seat instead")).toBe("PIVOT");
  });

  it("\"unforgettable\" does not PIVOT — the \"forget\" collision", () => {
    expect(classifyPlutoIntent("an unforgettable trip")).toBe("DISCOVERY");
  });

  it("bare \"forget\"/\"forgetting\" still classify as PIVOT", () => {
    expect(classifyPlutoIntent("forget the beach, let's do mountains")).toBe("PIVOT");
    expect(classifyPlutoIntent("forgetting the passport would be bad")).toBe("PIVOT");
  });

  it("update/updates/updated/updating all still match as whole words", () => {
    expect(classifyPlutoIntent("update my dates")).toBe("REFINEMENT");
    expect(classifyPlutoIntent("updated the flight")).toBe("REFINEMENT");
  });

  it("instead/actually/nevermind still match as whole words", () => {
    expect(classifyPlutoIntent("nevermind, keep the old plan")).toBe("PIVOT");
  });
});
