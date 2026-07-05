// REGRESSION — GET /conversation/:id rehydration route (v2, refresh/resume).
// Exercises the route contract: a workspace-scoped hit returns the context bag;
// a miss / wrong-workspace / TTL-expired / malformed id all return 404 (the FE
// treats 404 as "start a clean conversation"). The real tenant scoping lives in
// getConversationContext (mocked here to simulate it by (workspace, id) pair).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: vi.fn() }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({ getRouteIntelProvider: () => ({ getRouteInsights: vi.fn() }) }));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));
vi.mock("../utils/plutoInvoke.js", () => ({ invokePluto: vi.fn(), reaskRetryInstruction: () => "" }));

// requireWorkspace mocked to set workspaceObjectId from a header (no DB).
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (req: any, _res: any, next: any) => {
    req.user = { _id: "u1" };
    req.workspaceObjectId = req.headers["x-workspace-id"] || "WS1";
    next();
  },
}));

// getConversationContext mocked to simulate tenant scoping: the doc lives in WS1
// under id "known-convo" and stores locked Pattaya; every other (workspace,id)
// pair is a miss → null (exactly what wrong-workspace / TTL-expiry produce).
const { getCtxMock } = vi.hoisted(() => ({ getCtxMock: vi.fn() }));
vi.mock("../utils/plutoMemory.js", () => ({
  getConversationContext: getCtxMock,
  saveConversationContext: vi.fn(),
  claimHandoffDelivery: vi.fn().mockResolvedValue(false),
  releaseHandoffDelivery: vi.fn().mockResolvedValue(undefined),
  isValidConversationId: (id: unknown) => typeof id === "string" && id.length > 0,
}));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const SAVED = { id: "known-convo", locked: { destination: { name: "Pattaya", source: "user" } } };

const app = express();
app.use(express.json());
app.use("/", router);

beforeEach(() => {
  getCtxMock.mockReset();
  getCtxMock.mockImplementation(async ({ workspaceObjectId, conversationId }: any) =>
    workspaceObjectId === "WS1" && conversationId === "known-convo" ? SAVED : null,
  );
});

describe("GET /conversation/:id — rehydration", () => {
  it("roundtrip: a known id in its workspace returns the context bag incl. locked facts", async () => {
    const res = await request(app).get("/conversation/known-convo").set("x-workspace-id", "WS1");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.context.locked.destination.name).toBe("Pattaya");
  });

  it("wrong workspace → 404 (indistinguishable from a miss)", async () => {
    const res = await request(app).get("/conversation/known-convo").set("x-workspace-id", "WS2");
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it("TTL-miss / unknown id → 404 (client starts fresh)", async () => {
    const res = await request(app).get("/conversation/gone-convo").set("x-workspace-id", "WS1");
    expect(res.status).toBe(404);
  });
});
