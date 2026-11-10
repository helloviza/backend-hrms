// Destination switch parsing (design §2.2 rules 5 / 5u, §3.5b; fixtures D, D-N).
import { describe, it, expect } from "vitest";
import {
  detectSwitchIntent,
  extractPlacePhrases,
  resolvePlaceSync,
  parseUndoAnswer,
  parseSameDatesAnswer,
  saysSameDates,
  tripActionOf,
} from "./plutoDestinationSwitch.js";

const firstCity = (prompt: string, locked = "Dubai") => {
  const sw = detectSwitchIntent(prompt, locked);
  if (!sw) return null;
  for (const p of sw.phrases) {
    const hit = resolvePlaceSync(p);
    if (hit && hit.city.toLowerCase() !== locked.toLowerCase()) return { ...hit, cue: sw.cue, action: sw.action };
  }
  return null;
};

describe("detectSwitchIntent", () => {
  it("E2 (cue): 'actually let's do singapore instead, same dates' → Singapore", () => {
    expect(firstCity("actually let's do singapore instead, same dates")).toMatchObject({ city: "Singapore", cue: true, action: null });
  });
  it("D1 (no cue): 'Executive stay in London Soho' → London, sub-area Soho, a hotel action", () => {
    expect(firstCity("Executive stay in London Soho")).toMatchObject({ city: "London", rest: "Soho", cue: false, action: "hotel" });
  });
  it("D4: 'flights to London instead' → London, a flight action", () => {
    expect(firstCity("flights to London instead")).toMatchObject({ city: "London", action: "flight" });
  });
  it("filler and tags around it are fine", () => {
    expect(firstCity("[QC] ok, Executive stay in London Soho please 🙂")).toMatchObject({ city: "London", rest: "Soho" });
  });
  it("D-N1: 'Dubai for 3 nights and then London for 2' is a second leg, never a switch", () => {
    expect(detectSwitchIntent("Dubai for 3 nights and then London for 2", "Dubai")).toBeNull();
  });
  it("D-N2: 'flights to London via Dubai' is a transit, never a switch", () => {
    expect(detectSwitchIntent("flights to London via Dubai", "Dubai")).toBeNull();
  });
  it("D-N3: 'is London Soho nice in November?' has no trip action and no cue", () => {
    expect(detectSwitchIntent("is London Soho nice in November?", "Dubai")).toBeNull();
  });
  it("nothing locked → never a switch (an ordinary first request)", () => {
    expect(detectSwitchIntent("hotels in London", null)).toBeNull();
  });
  it("a landmark is not a destination: 'hotels near Burj Khalifa', 'stay close to Soho'", () => {
    expect(extractPlacePhrases("hotels near Burj Khalifa")).toEqual([]);
    expect(extractPlacePhrases("stay close to Soho")).toEqual([]);
  });
  it("the origin after 'from' is not a candidate", () => {
    expect(extractPlacePhrases("flights from Bengaluru to London")).toEqual(["London"]);
  });
  it("same-city questions name only the trip's city", () => {
    expect(firstCity("best taxi app in Dubai?")).toBeNull();
    expect(firstCity("hotels in Dubai Marina")).toBeNull();
  });
  it("'change to 21 Nov' is a date, not a place", () => {
    expect(firstCity("change to 21 Nov")).toBeNull();
  });
  it("a 3-letter word is never an airport by accident ('for now' ≠ NOW)", () => {
    expect(resolvePlaceSync("now")).toBeNull();
    expect(resolvePlaceSync("Goa")).toMatchObject({ city: "Goa" });
  });
});

describe("tripActionOf / saysSameDates", () => {
  it("reads the action, flights before hotels", () => {
    expect(tripActionOf("flights and a hotel in London")).toBe("flight");
    expect(tripActionOf("Executive stay in London")).toBe("hotel");
    expect(tripActionOf("plan a trip to London")).toBe("trip");
    expect(tripActionOf("is London nice")).toBeNull();
  });
  it("'same dates' / 'same time'", () => {
    expect(saysSameDates("singapore instead, same dates")).toBe(true);
    expect(saysSameDates("singapore instead")).toBe(false);
  });
});

describe("parseUndoAnswer (rule 5u)", () => {
  it("the chip and its plain forms", () => {
    for (const p of ["Keep Dubai instead", "keep dubai", "go back to Dubai", "stick with Dubai please", "undo", "switch back"]) {
      expect(parseUndoAnswer(p, "Dubai")).toBe(true);
    }
  });
  it("another city or another sentence is not an undo", () => {
    expect(parseUndoAnswer("Keep London instead", "Dubai")).toBe(false);
    expect(parseUndoAnswer("keep the hotel", "Dubai")).toBe(false);
    expect(parseUndoAnswer("hotels in Dubai", "Dubai")).toBe(false);
  });
});

describe("parseSameDatesAnswer", () => {
  it("the chips and short answers", () => {
    expect(parseSameDatesAnswer("Same dates (16–19 Nov)")).toBe("same");
    expect(parseSameDatesAnswer("same dates")).toBe("same");
    expect(parseSameDatesAnswer("yes")).toBe("same");
    expect(parseSameDatesAnswer("Different dates")).toBe("different");
    expect(parseSameDatesAnswer("no")).toBe("different");
    expect(parseSameDatesAnswer("16 to 19 nov")).toBeNull();
  });
});
