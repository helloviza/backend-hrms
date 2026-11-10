// Post-AI guardrails (design §4.1, §4.3).
import { describe, it, expect } from "vitest";
import {
  claimsResultsWithoutCards,
  stripClaimSentences,
  staleDestinationIn,
  replaceStaleDestination,
} from "./plutoReplyGuards.js";

describe("claims without cards (C2-guard)", () => {
  it("'These hotel options…' with no cards is a claim", () => {
    expect(claimsResultsWithoutCards({ context: "These hotel options balance comfort and price. Goa is lovely in December." })).toBe(true);
    expect(claimsResultsWithoutCards({ context: "Here are three great stays near Calangute." })).toBe(true);
  });
  it("with cards it is fine; advice is fine", () => {
    expect(claimsResultsWithoutCards({ context: "These hotel options are live.", hotelSearch: { hotels: [{}] } })).toBe(false);
    expect(claimsResultsWithoutCards({ context: "North Goa suits nightlife; South Goa is quieter." })).toBe(false);
  });
  it("strips only the claiming sentence", () => {
    expect(stripClaimSentences("These hotel options balance comfort and price. Goa is lovely in December.")).toBe("Goa is lovely in December.");
  });
});

describe("stale destination (E3-guard)", () => {
  it("a reply about Dubai after the switch to Singapore is stale", () => {
    expect(staleDestinationIn({ title: "Must-See Places in Dubai" }, ["Dubai"], "Singapore")).toBe("Dubai");
  });
  it("naming both, or only the current city, is fine", () => {
    expect(staleDestinationIn({ title: "Singapore, not Dubai" }, ["Dubai"], "Singapore")).toBeNull();
    expect(staleDestinationIn({ title: "Must-See Places in Singapore" }, ["Dubai"], "Singapore")).toBeNull();
  });
  it("rebuilds the title and drops the stale sentences", () => {
    const r: any = { title: "Must-See Places in Dubai", context: "Visit the Burj Khalifa in Dubai. Gardens by the Bay in Singapore is a must." };
    replaceStaleDestination(r, "Dubai", "Singapore");
    expect(r.title).toBe("Must-See Places in Singapore");
    expect(r.context).toBe("Gardens by the Bay in Singapore is a must.");
  });
});
