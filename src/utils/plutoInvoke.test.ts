// Step 3 — substance enforce-retry in the OpenAI invoke loop.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

import { invokePluto } from "./plutoInvoke.js";

const aiJson = (obj: unknown) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

const THIN = { handoff: false, title: "3-Day Business Trip to Tokyo", context: "Tokyo, Japan" };
const RICH = {
  handoff: false,
  context: "Tokyo is an excellent base for a focused three-day business trip. Here is a draft skeleton to refine together. We can tune the pace once dates are set.",
  itinerary: [
    { day: 1, heading: "Arrival & settle in", details: ["Check in near Marunouchi"] },
    { day: 2, heading: "Core meetings", details: ["Full working day"] },
    { day: 3, heading: "Wrap-up & departure", details: ["Morning buffer, then airport"] },
  ],
  nextSteps: ["What are your travel dates?", "Which city are you flying from?"],
};

beforeEach(() => { createMock.mockReset(); });

describe("invokePluto — substance enforce-retry", () => {
  it("requireSubstance + thin → ONE corrective retry with the substance instruction, returns the rich reply", async () => {
    createMock.mockResolvedValueOnce(aiJson(THIN)).mockResolvedValueOnce(aiJson(RICH));
    const reply = await invokePluto("plan Tokyo", { requireSubstance: true });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(reply.itinerary).toHaveLength(3);
    // The 2nd attempt carries the substance corrective (not the schema one).
    const secondMsgs = createMock.mock.calls[1][0].messages.map((m: any) => m.content).join("\n");
    expect(secondMsgs).toMatch(/too thin/i);
    expect(secondMsgs).toMatch(/itinerary/i);
  });

  it("requireSubstance + already-rich → no retry", async () => {
    createMock.mockResolvedValueOnce(aiJson(RICH));
    const reply = await invokePluto("plan Tokyo", { requireSubstance: true });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reply.itinerary).toHaveLength(3);
  });

  it("requireSubstance + thin twice → ACCEPTED (no throw) + onThinAccepted fired", async () => {
    createMock.mockResolvedValueOnce(aiJson(THIN)).mockResolvedValueOnce(aiJson(THIN));
    const onThinAccepted = vi.fn();
    const reply = await invokePluto("plan Tokyo", { requireSubstance: true, onThinAccepted });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(onThinAccepted).toHaveBeenCalledTimes(1);
    expect(reply.context).toBe("Tokyo, Japan"); // accepted the thin reply, not an error
  });

  it("requireSubstance=false (default) + thin → NO substance retry, returns as-is", async () => {
    createMock.mockResolvedValueOnce(aiJson(THIN));
    const reply = await invokePluto("plan Tokyo");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reply.context).toBe("Tokyo, Japan");
  });

  it("schema-invalid still retries with the schema instruction (existing behaviour preserved)", async () => {
    createMock.mockResolvedValueOnce(aiJson({})).mockResolvedValueOnce(aiJson(RICH));
    const reply = await invokePluto("plan Tokyo");
    expect(createMock).toHaveBeenCalledTimes(2);
    const secondMsgs = createMock.mock.calls[1][0].messages.map((m: any) => m.content).join("\n");
    expect(secondMsgs).toMatch(/failed validation/i);
    expect(reply.itinerary).toHaveLength(3);
  });
});

const REASK = {
  handoff: false,
  context: "I need to know your travel destination first.",
  nextSteps: ["Where would you like to go?", "What are your travel dates?"],
};
const HOTELS_OK = {
  handoff: false,
  context: "Here are strong Pattaya options within your budget for your Oct 20–22 stay. Each is walkable to the beach. We can refine once you pick a vibe.",
  hotels: [{ name: "Beachfront Suites", area: "Beach Road", approxPrice: "$450", whyGood: "Central, sea view" }],
};
const LOCKED = { destination: "Pattaya", dates: "2026-10-20 to 2026-10-22" };

describe("invokePluto — reasked-locked enforce-retry (v2)", () => {
  it("lockedFacts + a reply re-asking destination → ONE retry naming the facts, returns the fixed reply", async () => {
    createMock.mockResolvedValueOnce(aiJson(REASK)).mockResolvedValueOnce(aiJson(HOTELS_OK));
    const reply = await invokePluto("show me few hotel beyond USD 500", { lockedFacts: LOCKED });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(reply.hotels).toHaveLength(1);
    const secondMsgs = createMock.mock.calls[1][0].messages.map((m: any) => m.content).join("\n");
    expect(secondMsgs).toMatch(/ALREADY KNOWN/i);
    expect(secondMsgs).toMatch(/Pattaya/);
  });

  it("lockedFacts + a reply that does NOT re-ask → no retry", async () => {
    createMock.mockResolvedValueOnce(aiJson(HOTELS_OK));
    const reply = await invokePluto("hotels beyond USD 500", { lockedFacts: LOCKED });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reply.hotels).toHaveLength(1);
  });

  it("lockedFacts + re-asks twice → ACCEPTED (no throw) + onReaskedLockedAccepted fired", async () => {
    createMock.mockResolvedValueOnce(aiJson(REASK)).mockResolvedValueOnce(aiJson(REASK));
    const onReaskedLockedAccepted = vi.fn();
    const reply = await invokePluto("hotels", { lockedFacts: LOCKED, onReaskedLockedAccepted });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(onReaskedLockedAccepted).toHaveBeenCalledTimes(1);
    expect(reply.context).toMatch(/need to know/i); // accepted, not an error
  });

  it("no lockedFacts → a re-ask reply is NOT corrected (gather phase unchanged)", async () => {
    createMock.mockResolvedValueOnce(aiJson(REASK));
    const reply = await invokePluto("plan a trip");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reply.context).toMatch(/need to know/i);
  });
});
