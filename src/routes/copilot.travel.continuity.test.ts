// REGRESSION — conversation continuity through the pre-AI gather gate.
//
// The two-turn "state reset" bug: turn 1 (a details-gathering planning message)
// used to return an ID-LESS context, so turn 2 was never recognised as a
// follow-up and the whole conversation reset to "Ready when you are". The fix
// establishes + returns a stable conversation id from the gather gate.
//
// This drives the REAL runConciergeTurn exactly as the frontend does: turn 2
// sends back turn 1's returned context. AI/TBO/memory are mocked at the edges
// so the assertions target the gate/routing logic, not the AI itself.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });
const { searchFlightsMock } = vi.hoisted(() => ({ searchFlightsMock: vi.fn() }));
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: searchFlightsMock }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({ getRouteIntelProvider: () => ({ getRouteInsights: vi.fn() }) }));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));

// Memory mocked so the follow-up turn can traverse the AI/memory path without a
// real DB. getConversationContext is the SEAM we assert on: it sits right after
// the pre-AI gate block, so it is only reached when a turn is treated as a
// follow-up. A reset would return at the gate and never call it.
const { getCtxMock, saveCtxMock } = vi.hoisted(() => ({ getCtxMock: vi.fn(), saveCtxMock: vi.fn() }));
vi.mock("../utils/plutoMemory.js", () => ({
  getConversationContext: getCtxMock,
  saveConversationContext: saveCtxMock,
  claimHandoffDelivery: vi.fn().mockResolvedValue(false),
  releaseHandoffDelivery: vi.fn().mockResolvedValue(undefined),
}));

// AI mocked to a valid reply so the follow-up turn completes instead of throwing.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../utils/plutoInvoke.js", () => ({ invokePluto: invokeMock }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.user = { _id: "u1", email: "t@plumtrips.com" }; req.workspaceObjectId = "656565656565656565656565"; req.workspaceId = "656565656565656565656565"; next(); });
app.use("/", router);

beforeEach(() => {
  invokeMock.mockReset();
  searchFlightsMock.mockReset();
  getCtxMock.mockReset();
  saveCtxMock.mockReset().mockResolvedValue(undefined);
  // Follow-up read returns the client-supplied context (round-tripped id).
  getCtxMock.mockResolvedValue(null);
  invokeMock.mockResolvedValue({ title: "Your Tokyo itinerary", context: "Draft plan.", nextSteps: [] });
});

describe("concierge continuity — gather gate establishes a durable conversation id", () => {
  it("turn 1 (fresh planning) reaches the AI and returns a stable context.id", async () => {
    // Frontend sends only { prompt, context } on a brand-new conversation.
    const t1 = (await request(app).post("/").send({ prompt: "3-day business trip to Tokyo" })).body;

    // The old hardcoded gather gate is gone — the AI now owns the gather phase,
    // so a brand-new on-domain planning message flows to invokePluto instead of
    // a canned "…a couple more details" reply.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(t1.reply.title).not.toBe("Let's plan your trip to Tokyo");
    expect(t1.reply.title).not.toBe("Ready when you are");

    // The conversation now HAS an identity. (Previously undefined — the root of
    // the reset.) This is the core regression assertion.
    expect(typeof t1.context.id).toBe("string");
    expect(t1.context.id.length).toBeGreaterThan(0);
  });

  it("turn 2 carrying turn 1's context is treated as a follow-up, not reset", async () => {
    const t1 = (await request(app).post("/").send({ prompt: "3-day business trip to Tokyo" })).body;
    const convoId = t1.context.id as string;

    // Frontend round-trips turn 1's context (id included) into turn 2.
    await request(app).post("/").send({
      prompt: "I am flying from Delhi on 16th Aug and Returning back on 20th Aug.",
      context: t1.context,
      conversationId: convoId,
    });

    // getConversationContext is reached ONLY after the pre-AI gate block, i.e.
    // only when the turn is recognised as a follow-up. A reset would have
    // returned "Ready when you are" at the gate and never called it.
    expect(getCtxMock).toHaveBeenCalled();
    expect(getCtxMock.mock.calls[0][0]).toMatchObject({ conversationId: convoId });
  });

  it("an existing id supplied via context is reused, not regenerated", async () => {
    // A resumed conversation (id already present) must keep the same id — the
    // gate's new-uuid fallback only fires when none exists.
    const supplied = "resumed-conversation-id-1234";
    await request(app).post("/").send({
      prompt: "Continue planning my trip.",
      context: { id: supplied, summary: "" },
    });

    expect(getCtxMock).toHaveBeenCalled();
    expect(getCtxMock.mock.calls[0][0]).toMatchObject({ conversationId: supplied });
  });
});
