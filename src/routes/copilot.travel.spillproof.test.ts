// STEP 4 — spillproof matrix. Varied openers must ALWAYS move forward: lock what
// the user stated, steer the AI to the highest-priority missing rung (never a
// low-value question while a higher one is missing), demand substance once a trip
// is plannable, and never dead-end. The AI is mocked with schema-realistic
// replies; assertions target the HANDLER's steer (missingFields ladder, state,
// requireSubstance) and decision accumulation — the deterministic parts.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: vi.fn() }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({ getRouteIntelProvider: () => ({ getRouteInsights: vi.fn() }) }));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));
vi.mock("../services/flightService.js", () => ({ getDelightfulFlightStatus: vi.fn().mockResolvedValue(null) }));
vi.mock("../utils/plutoMemory.js", () => ({
  getConversationContext: vi.fn().mockResolvedValue(null),
  saveConversationContext: vi.fn().mockResolvedValue(undefined),
  claimHandoffDelivery: vi.fn().mockResolvedValue(false),
  releaseHandoffDelivery: vi.fn().mockResolvedValue(undefined),
}));
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../utils/plutoInvoke.js", () => ({ invokePluto: invokeMock }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.user = { _id: "u1", email: "t@plumtrips.com" }; req.workspaceObjectId = "656565656565656565656565"; req.workspaceId = "656565656565656565656565"; next(); });
app.use("/", router);

const DRAFT = [
  { day: 1, heading: "Arrival & settle in (draft)", details: ["Check in, light evening"] },
  { day: 2, heading: "Core working day (draft)", details: ["Meetings"] },
  { day: 3, heading: "Wrap-up & departure (draft)", details: ["Buffer, airport"] },
];
const RICH_PLAN = { handoff: false, context: "A solid three-day base. Here is a draft to refine. We can tune once dates land.", itinerary: DRAFT, nextSteps: ["What are your travel dates?", "Which city are you flying from?"] };
const ASK_DEST = { handoff: false, context: "Happy to help you choose. December is great for several regions depending on your vibe. Tell me where and I'll build it.", nextSteps: ["Where would you like to go?"] };

const post = (body: any) => request(app).post("/").send(body).then(r => r.body);

beforeEach(() => { invokeMock.mockReset().mockResolvedValue(RICH_PLAN); });

describe("spillproof matrix — every opener moves forward", () => {
  it("'3-day business trip to Tokyo' → PLANNING, requireSubstance, ladder asks dates+origin (not hotels), draft flows through", async () => {
    const t = await post({ prompt: "3-day business trip to Tokyo", context: {} });
    expect(t.context.locked.destination.name).toBe("Tokyo");
    expect(t.context.locked.duration.days).toBe(3);
    expect(t.context.state).toBe("PLANNING");
    // Priority ladder: the two highest missing rungs, in order — never hotels/budget.
    expect(t.context.missingFields).toEqual(["dates", "origin"]);
    // Substance is required (trip is plannable) and the prompt says so.
    expect(invokeMock.mock.calls[0][1]?.requireSubstance).toBe(true);
    expect(invokeMock.mock.calls[0][0]).toMatch(/PLAN_READINESS/);
    // The draft skeleton survives to the client.
    expect(t.reply.itinerary).toHaveLength(3);
  });

  it("'travel somewhere in December' → destination is the top rung, no substance demand, no hotel questions", async () => {
    invokeMock.mockResolvedValue(ASK_DEST);
    const t = await post({ prompt: "I want to travel somewhere in December", context: {} });
    expect(t.context.locked.destination).toBeUndefined();
    expect(t.context.missingFields[0]).toBe("destination");
    expect(invokeMock.mock.calls[0][1]?.requireSubstance).toBe(false);
    expect(invokeMock.mock.calls[0][0]).not.toMatch(/PLAN_READINESS/);
    expect(t.reply.title).not.toBe("Ready when you are");
  });

  it("'Flying to Singapore from Delhi 12-15 Sep, hotel near Marina Bay' → everything locked in one turn, nothing redundant to ask", async () => {
    const t = await post({ prompt: "Flying to Singapore from Delhi 12-15 Sep, need a hotel near Marina Bay", context: {} });
    expect(t.context.locked.destination.name).toBe("Singapore");
    expect(t.context.locked.origin.city).toBe("Delhi");
    expect(t.context.locked.dates.start).toMatch(/\d{4}-09-12/);
    expect(t.context.locked.dates.end).toMatch(/\d{4}-09-15/);
    expect(t.context.locked.duration.days).toBe(4);
    expect(t.context.state).toBe("PLANNING");
    // Nothing redundant: destination/dates/origin are all locked → ladder empty.
    expect(t.context.missingFields).toBeUndefined();
    expect(invokeMock.mock.calls[0][1]?.requireSubstance).toBe(true);
  });

  it("'plan me something' → asks destination, still gives value, never a dead-end reset", async () => {
    invokeMock.mockResolvedValue(ASK_DEST);
    const t = await post({ prompt: "plan me something", context: {} });
    expect(t.context.missingFields[0]).toBe("destination");
    expect(invokeMock.mock.calls[0][1]?.requireSubstance).toBe(false);
    expect(t.reply.title).not.toBe("Ready when you are");
    expect(typeof t.reply.context).toBe("string");
    expect(t.reply.nextSteps.length).toBeGreaterThan(0);
  });

  it("turn-2 continuation → locked accumulates and the question ladder descends", async () => {
    const t1 = await post({ prompt: "3-day business trip to Tokyo", context: {} });
    expect(t1.context.missingFields).toEqual(["dates", "origin"]);

    const t2 = await post({ prompt: "from Mumbai, leaving 10-12 December", context: t1.context, conversationId: t1.context.id });
    // Tokyo + duration retained; Mumbai + dates added.
    expect(t2.context.locked.destination.name).toBe("Tokyo");
    expect(t2.context.locked.duration.days).toBe(3);
    expect(t2.context.locked.origin.city).toBe("Mumbai");
    expect(t2.context.locked.dates.start).toMatch(/\d{4}-12-10/);
    // Ladder descended from [dates, origin] to empty.
    expect(t2.context.missingFields).toBeUndefined();
  });
});
