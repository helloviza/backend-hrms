// Conversation-id hygiene (P0 sidebar churn).
//   1. GUARD: every branch's returned context carries a non-empty id — so no
//      future branch can regress into an id-less context the sidebar can't dedup.
//   2. REGRESSION: a 3-turn conversation across different branches (gather →
//      flight → hotel) keeps ONE stable id, ONE PlutoConversation doc, and ONE
//      ChatSession key (data.context.id) end-to-end.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });
const { searchFlightsMock } = vi.hoisted(() => ({ searchFlightsMock: vi.fn() }));
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: searchFlightsMock }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({ getRouteIntelProvider: () => ({ getRouteInsights: vi.fn().mockResolvedValue({ sufficient: false, observationCount: 0, dataWindowDays: 90 }) }) }));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));
vi.mock("../services/flightService.js", () => ({ getDelightfulFlightStatus: vi.fn().mockResolvedValue(null) }));

// Durable memory simulated in-process (like production Mongo), so we can count
// how many PlutoConversation docs a conversation fragments into.
const store = new Map<string, any>();
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

const flights = { Response: { TraceId: "T", ResponseStatus: 1, Results: [[{ ResultIndex: "OB1", IsLCC: true, Fare: { PublishedFare: 5000, OfferedFare: 4800, Currency: "INR" }, Segments: [[{ CabinClass: 2, Duration: 130, Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "2582" }, Origin: { DepTime: "2026-09-20T07:20:00", Airport: { AirportCode: "DEL", CityName: "Delhi" } }, Destination: { ArrTime: "2026-09-20T13:30:00", Airport: { AirportCode: "NRT", CityName: "Tokyo" } } }]] }]] } };
const post = (b: any) => request(app).post("/").send(b).then(r => r.body);

beforeEach(() => {
  store.clear();
  searchFlightsMock.mockReset().mockResolvedValue(flights);
  getCtxMock.mockReset().mockImplementation(async ({ conversationId }: any) => store.get(conversationId) ?? null);
  saveCtxMock.mockReset().mockImplementation(async ({ conversationId, context }: any) => { store.set(conversationId, context); });
  invokeMock.mockReset().mockResolvedValue({ handoff: false, title: "Tokyo", context: "A strong three-day base for business. Here is a draft to refine. We can tune the pace.", itinerary: [{ day: 1, heading: "Arrival", details: ["settle in"] }], nextSteps: ["What are your travel dates?"] });
});

describe("id hygiene — GUARD: every branch returns a non-empty context.id", () => {
  it.each([
    ["off-domain redirect",        "what is my salary this month"],
    ["multi-city downgrade",       "find flights from Delhi to Mumbai to Goa on 20 May 2026"],
    ["flight-search results",      "find flights from Delhi to Mumbai on 20 May 2026"],
    ["unresolved-airport clarify", "find flights from Zzxqqwt to Mumbai on 20 May 2026"],
    ["ask-return-date",            "round trip flights from Delhi to Mumbai on 20 May 2026"],
    ["AI gather path",             "3-day trip to Tokyo"],
  ])("%s → context.id is a non-empty string", async (_label, prompt) => {
    const body = await post({ prompt, context: {} });
    expect(typeof body.context?.id).toBe("string");
    expect(body.context.id.length).toBeGreaterThan(0);
  });
});

describe("id hygiene — REGRESSION: 3 turns → one id, one doc, one ChatSession key", () => {
  it("gather → flight-search → hotel-trigger keeps a single stable identity", async () => {
    const t1 = await post({ prompt: "3-day business trip to Tokyo", context: {} });
    const t2 = await post({ prompt: "find flights from Delhi to Tokyo on 20 September 2026 returning 24 September", context: t1.context, conversationId: t1.context.id });
    const t3 = await post({ prompt: "Show me business hotels in Tokyo", context: t2.context, conversationId: t2.context.id });

    const ids = [t1, t2, t3].map((t) => t.context.id);
    // One stable id across all three branches (this is also the ChatSession key).
    expect(new Set(ids).size).toBe(1);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);

    // One PlutoConversation doc — server memory never fragments.
    const savedIds = saveCtxMock.mock.calls.map((c: any) => c[0].conversationId);
    expect(new Set(savedIds).size).toBe(1);
    expect(savedIds[0]).toBe(ids[0]);
    expect(store.size).toBe(1);
  });
});
