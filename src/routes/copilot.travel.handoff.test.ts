// End-to-end integration test for the AI-driven handoff (closes Phase 2 report
// flag #3). Mounts the real concierge router; mocks invokePluto + the
// state/lock/intent layer so a chat turn deterministically reaches
// isHandoffReady=true; mocks the models + mailer so the REAL handoff sink runs.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
});

const H = vi.hoisted(() => ({
  invokePlutoMock: vi.fn(),
  resolveStateMock: vi.fn(),
  lockDecisionsMock: vi.fn(),
  classifyIntentMock: vi.fn(),
  sbtCreateMock: vi.fn(),
  wsFindByIdMock: vi.fn(),
  userFindOneMock: vi.fn(),
  metricCreateMock: vi.fn(),
  sendMailMock: vi.fn(),
}));

// AI + state/lock/intent → deterministic so the turn reaches EXECUTION + locked.
vi.mock("../utils/plutoInvoke.js", () => ({ invokePluto: H.invokePlutoMock }));
vi.mock("../utils/plutoStateResolver.js", () => ({ resolvePlutoState: H.resolveStateMock }));
vi.mock("../utils/plutoDecisionLocker.js", () => ({ lockDecisions: H.lockDecisionsMock }));
vi.mock("../utils/plutoIntentClassifier.js", () => ({ classifyPlutoIntent: H.classifyIntentMock }));
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: vi.fn() }));
// Isolate the idempotency guard to the CLIENT-supplied context (round-tripped),
// simulating a per-instance Map miss (restart / other App Runner instance) so
// the context flag is the sole state carrier. Not modifying plutoMemory source —
// this is a test double.
vi.mock("../utils/plutoMemory.js", () => ({
  getConversationContext: async () => null,
  saveConversationContext: async () => {},
}));

// Models + mailer → the real sink + real persistent metrics sink run against these.
vi.mock("../models/SBTRequest.js", () => ({ default: { create: H.sbtCreateMock } }));
vi.mock("../models/CustomerWorkspace.js", () => ({ default: { findById: H.wsFindByIdMock } }));
vi.mock("../models/User.js", () => ({ default: { findOne: H.userFindOneMock } }));
vi.mock("../models/PlutoMetricEvent.js", () => ({ default: { create: H.metricCreateMock } }));
vi.mock("../utils/mailer.js", () => ({ sendMail: H.sendMailMock }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const WS = "656565656565656565656565"; // valid ObjectId string (persist requires it)
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { _id: "u1", email: "u@x.com", name: "U" };
  req.workspaceObjectId = WS;
  req.workspaceId = WS;
  next();
});
app.use("/", router);

const chain = (val: any) => ({ lean: () => Promise.resolve(val), select: () => ({ lean: () => Promise.resolve(val) }) });

// A handoff-ready conversation context (state + locked pre-seeded).
const readyContext = () => ({
  id: "conv-handoff-1",
  state: "EXECUTION",
  locked: {
    tripType: "business",
    destination: "Goa",
    dates: { start: "2026-05-20", end: "2026-05-27" },
    policyStatus: "IN_POLICY",
  },
});

async function turn(context: any) {
  const res = await request(app)
    .post("/")
    .send({ prompt: "Please proceed and book this trip.", context });
  return res.body;
}

beforeEach(() => {
  Object.values(H).forEach((m: any) => m.mockReset());
  // AI returns a valid reply; handler overwrites reply.handoff via isHandoffReady.
  H.invokePlutoMock.mockResolvedValue({
    handoff: false,
    context: "You're all set — ready to book your Goa business trip.",
    nextSteps: ["Confirm and book"],
  });
  H.resolveStateMock.mockReturnValue("EXECUTION"); // keep EXECUTION
  H.lockDecisionsMock.mockImplementation((_reply: any, locked: any) => locked); // preserve seeded locked
  H.classifyIntentMock.mockReturnValue("GENERAL");

  // Booker resolution + creates.
  H.wsFindByIdMock.mockReturnValue(chain({ _id: WS, defaultApproverEmails: ["booker@x.com"] }));
  H.userFindOneMock
    .mockReturnValueOnce(chain({ _id: "bk1", email: "booker@x.com" })) // approver
    .mockReturnValueOnce(chain({ email: "booker@x.com" })); // booker email lookup
  H.sbtCreateMock.mockResolvedValue({ _id: "aireq1" });
  H.metricCreateMock.mockResolvedValue({ _id: "m1" });
  H.sendMailMock.mockResolvedValue(undefined);
});

describe("AI handoff end-to-end", () => {
  it("a) creates exactly ONE SBTRequest — CONCIERGE_AI / PENDING / tripBundle + P0 SLA", async () => {
    const body = await turn(readyContext());
    expect(body.ok).toBe(true);

    expect(H.sbtCreateMock).toHaveBeenCalledTimes(1);
    const doc = H.sbtCreateMock.mock.calls[0][0];
    expect(doc.source).toBe("CONCIERGE_AI");
    expect(doc.status).toBe("PENDING");
    expect(doc.tripBundle.conversationSummary).toMatch(/ready to book your Goa/i);
    expect(doc.tripBundle.policyStatus).toBe("IN_POLICY");
    expect(doc.tripBundle.lockedDecisions.tripType).toBe("business");
    // SLA from the (real) evaluator for a business trip → P0 in the email subject.
    expect(String(H.sendMailMock.mock.calls[0][0].subject)).toContain("P0");
  });

  it("b) booker email carries the trip-summary section + 15-minute SLA", async () => {
    await turn(readyContext());
    const mail = H.sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe("booker@x.com");
    expect(String(mail.subject)).toContain("15 minutes");
    expect(String(mail.html)).toContain("Trip summary");
    expect(String(mail.html)).toContain("AI Concierge Handoff");
  });

  it("c) pluto.handoff.delivered is persisted as a PlutoMetricEvent row", async () => {
    await turn(readyContext());
    const delivered = H.metricCreateMock.mock.calls
      .map((c) => c[0])
      .find((d) => d.type === "pluto.handoff.delivered");
    expect(delivered).toBeDefined();
    expect(String(delivered.workspaceId)).toBe(WS);
  });

  it("d) second turn on the same conversation (context keeps handoffDelivered) → NO second SBTRequest", async () => {
    const body1 = await turn(readyContext());
    expect(H.sbtCreateMock).toHaveBeenCalledTimes(1);
    expect(body1.context.handoffDelivered).toBe(true);

    // Re-arm booker lookups for a hypothetical second delivery.
    H.userFindOneMock
      .mockReturnValueOnce(chain({ _id: "bk1", email: "booker@x.com" }))
      .mockReturnValueOnce(chain({ email: "booker@x.com" }));

    await turn(body1.context); // client returns context carrying handoffDelivered
    expect(H.sbtCreateMock).toHaveBeenCalledTimes(1); // still ONE
  });

  it("e) client DROPS handoffDelivered from context → duplicate is created (known gap)", async () => {
    const body1 = await turn(readyContext());
    expect(H.sbtCreateMock).toHaveBeenCalledTimes(1);

    const tampered = { ...body1.context };
    delete tampered.handoffDelivered;

    H.userFindOneMock
      .mockReturnValueOnce(chain({ _id: "bk1", email: "booker@x.com" }))
      .mockReturnValueOnce(chain({ email: "booker@x.com" }));

    await turn(tampered);
    // Context-flag dedup is client-trusted, so a dropped flag yields a duplicate.
    // Server-side dedup moves to the Mongo conversation store post-migration.
    expect(H.sbtCreateMock).toHaveBeenCalledTimes(2);
  });
});
