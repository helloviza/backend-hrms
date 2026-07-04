// REGRESSION — the screenshot "state reset" bug, end-to-end through the REAL
// runConciergeTurn, driven exactly as the frontend drives it (turn N+1 sends
// turn N's returned context + conversationId). The AI is mocked with realistic
// DISCOVERY replies so the assertions target routing / identity / decision
// locking, not the model. Converted from the diagnostic harness.
//
// Acceptance case:
//   Turn 1 "3-day business trip to Tokyo" → AI clarifying reply; context carries
//     a stable id; destination Tokyo + duration locked; doc persisted.
//   Turn 2 "flying from Delhi on 16th Aug … returning 20th Aug" → NO reset;
//     origin + dates locked ALONGSIDE Tokyo; the plan advances. Never
//     "Ready when you are".
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });
const { searchFlightsMock } = vi.hoisted(() => ({ searchFlightsMock: vi.fn() }));
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: searchFlightsMock }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({ getRouteIntelProvider: () => ({ getRouteInsights: vi.fn() }) }));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));
// No flight number in any prompt → never called, but stub to guarantee no network.
vi.mock("../services/flightService.js", () => ({ getDelightfulFlightStatus: vi.fn().mockResolvedValue(null) }));

// Memory: getConversationContext returns null (a miss, as when Mongo is not
// connected) so the handler falls back to the round-tripped client context —
// exactly the production fallback. saveConversationContext is the persistence
// seam we assert on.
const { getCtxMock, saveCtxMock } = vi.hoisted(() => ({ getCtxMock: vi.fn(), saveCtxMock: vi.fn() }));
vi.mock("../utils/plutoMemory.js", () => ({
  getConversationContext: getCtxMock,
  saveConversationContext: saveCtxMock,
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

const post = (body: any) => request(app).post("/").send(body).then(r => r.body);

beforeEach(() => {
  invokeMock.mockReset();
  searchFlightsMock.mockReset();
  getCtxMock.mockReset().mockResolvedValue(null);
  saveCtxMock.mockReset().mockResolvedValue(undefined);
  // Realistic DISCOVERY behaviour: clarifying questions until origin is known,
  // then the plan advances. The prompt carries LOCKED DECISIONS json, so we can
  // key off the origin city to verify prior decisions reached the model.
  invokeMock.mockImplementation(async (p: string) => {
    if (/Delhi/.test(p)) {
      return {
        title: "Your Tokyo trip is taking shape",
        context: "Delhi → Tokyo, 16–20 Aug. I can pull live fares whenever you're ready.",
        nextSteps: ["Search flights Delhi → Tokyo for 16 Aug", "Draft your 3-day Tokyo itinerary"],
        tripType: "business",
      };
    }
    return {
      title: "Let's shape your Tokyo trip",
      context: "Tokyo for 3 days on business — a strong start.",
      nextSteps: ["Where are you flying from?", "What are your exact travel dates?"],
      tripType: "business",
    };
  });
});

describe("concierge gather regression — no state reset across turns", () => {
  it("full acceptance flow: identity, no reset, accumulating locked decisions, persistence", async () => {
    /* ── Turn 1 — brand new conversation (frontend sends only prompt+context) ── */
    const t1 = await post({ prompt: "3-day business trip to Tokyo", context: {} });

    // The AI now owns the gather phase (no hardcoded gate reply).
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // Identity established from turn 1.
    expect(typeof t1.context.id).toBe("string");
    expect(t1.context.id.length).toBeGreaterThan(0);
    // Clarifying question is present AND rendered as a nextSteps entry.
    expect(t1.reply.nextSteps.some((s: string) => /flying from/i.test(s))).toBe(true);
    // User-stated facts locked on turn 1.
    expect(t1.context.locked.destination).toMatchObject({ name: "Tokyo", source: "user" });
    expect(t1.context.locked.duration).toMatchObject({ days: 3 });
    expect(t1.context.locked.tripType).toBe("business");
    // The turn-1 doc was persisted with those locked decisions.
    const save1 = saveCtxMock.mock.calls.at(-1)![0];
    expect(save1.conversationId).toBe(t1.context.id);
    expect(save1.context.locked.destination.name).toBe("Tokyo");
    // The AI saw the locked destination in its prompt.
    expect(invokeMock.mock.calls[0][0]).toMatch(/Tokyo/);

    /* ── Turn 2 — frontend round-trips turn 1's context + conversationId ── */
    const t2 = await post({
      prompt: "I am flying from Delhi on 16th Aug and Returning back on 20th Aug.",
      context: t1.context,
      conversationId: t1.context.id,
    });

    // NEVER a reset.
    expect(t2.reply.title).not.toBe("Ready when you are");
    expect(t2.reply.context).not.toMatch(/Ask me to plan a trip/i);
    // Recognised as a follow-up → memory read reached with the same id.
    expect(getCtxMock).toHaveBeenCalled();
    expect(getCtxMock.mock.calls.at(-1)![0]).toMatchObject({ conversationId: t1.context.id });
    // Same conversation id preserved.
    expect(t2.context.id).toBe(t1.context.id);
    // Locked decisions ACCUMULATE: Delhi + dates added, Tokyo NOT dropped.
    expect(t2.context.locked.destination.name).toBe("Tokyo");
    expect(t2.context.locked.origin).toMatchObject({ city: "Delhi", source: "user" });
    expect(t2.context.locked.dates.start).toMatch(/\d{4}-08-16/);
    expect(t2.context.locked.dates.end).toMatch(/\d{4}-08-20/);
    // The turn-2 prompt carried the accumulated decisions (Tokyo + Delhi) to the AI.
    const aiPrompt2 = invokeMock.mock.calls.at(-1)![0];
    expect(aiPrompt2).toMatch(/Tokyo/);
    expect(aiPrompt2).toMatch(/Delhi/);

    /* ── Turn 3 — a further follow-up must retain the whole brief ── */
    const t3 = await post({
      prompt: "What hotels do you recommend there?",
      context: t2.context,
      conversationId: t2.context.id,
    });
    expect(t3.reply.title).not.toBe("Ready when you are");
    expect(t3.context.locked.destination.name).toBe("Tokyo");
    expect(t3.context.locked.origin.city).toBe("Delhi");
    expect(t3.context.locked.dates.start).toMatch(/\d{4}-08-16/);
    expect(t3.context.locked.duration.days).toBe(3);
  });

  it("a video-locked destination is never overridden by a user-stated city", async () => {
    // Precedence regression: locked.destination from a video is FINAL — the
    // pre-AI user-fact extractor must not clobber it even if the user names a
    // different city in prose.
    const seeded = { id: "conv-video-lock-1", locked: { destination: { name: "Bali", source: "video" } } };
    const body = await post({ prompt: "Actually plan a trip to Paris", context: seeded, conversationId: seeded.id });
    expect(body.context.locked.destination).toMatchObject({ name: "Bali", source: "video" });
  });
});
