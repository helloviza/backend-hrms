import { describe, it, expect } from "vitest";
import { isReaskedLockedReply } from "./plutoValidator.js";

const LOCKED = { destination: "Pattaya", dates: "2026-10-20 to 2026-10-22" };

describe("isReaskedLockedReply", () => {
  it("detects the observed 'I need to know your travel destination first'", () => {
    const reply = {
      handoff: false,
      context: "I need to know your travel destination first.",
      nextSteps: ["Where would you like to go?", "What are your travel dates?"],
    };
    expect(isReaskedLockedReply(reply, LOCKED)).toBe(true);
  });

  it("detects a re-ask that lives only in nextSteps", () => {
    const reply = { handoff: false, context: "Sure!", nextSteps: ["Which city are you flying from?"] };
    expect(isReaskedLockedReply(reply, { origin: "Delhi" })).toBe(true);
  });

  it("a reply that USES the locked facts is not flagged", () => {
    const reply = {
      handoff: false,
      context: "Here are hotels in Pattaya for your Oct 20–22 stay within budget.",
      hotels: [{ name: "H", area: "Beach", approxPrice: "$450", whyGood: "central" }],
    };
    expect(isReaskedLockedReply(reply, LOCKED)).toBe(false);
  });

  it("only guards facts that are actually locked (dates not locked → dates re-ask is allowed)", () => {
    const reply = { handoff: false, context: "Great.", nextSteps: ["What are your travel dates?"] };
    expect(isReaskedLockedReply(reply, { destination: "Pattaya" })).toBe(false);
  });

  it("null locked / empty reply → false", () => {
    expect(isReaskedLockedReply({ handoff: false, context: "hi" }, null)).toBe(false);
    expect(isReaskedLockedReply({ handoff: false }, LOCKED)).toBe(false);
  });
});
