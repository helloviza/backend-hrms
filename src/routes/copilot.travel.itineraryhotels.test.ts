// Regression coverage for the "itinerary lane fabricates hotels" bug: "3-day
// business trip to Tokyo" used to render an AI-invented hotels[] block even
// though Tokyo resolves in the live TBO catalog. copilot.travel.ts's new
// "Itinerary hotel section" block (right after fullReply is built) is meant
// to replace/suppress that fabricated list. Same integration-test shape as
// copilot.travel.handoff.test.ts (mount the real router, mock invokePluto +
// the state/lock/intent layer for determinism) plus two more mocks specific
// to this lane: resolveHotelDestination and searchHotelsForChat, so this
// test never touches Mongo/TBO and asserts purely on how copilot.travel.ts
// USES their results.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
});

const H = vi.hoisted(() => ({
  invokePlutoMock: vi.fn(),
  resolveStateMock: vi.fn(),
  lockDecisionsMock: vi.fn(),
  classifyIntentMock: vi.fn(),
  resolveHotelDestinationMock: vi.fn(),
  searchHotelsForChatMock: vi.fn(),
  policyRulesMock: vi.fn(),
}));

vi.mock("../utils/plutoInvoke.js", () => ({ invokePluto: H.invokePlutoMock }));
vi.mock("../utils/plutoStateResolver.js", () => ({ resolvePlutoState: H.resolveStateMock }));
vi.mock("../utils/plutoDecisionLocker.js", () => ({ lockDecisions: H.lockDecisionsMock }));
vi.mock("../utils/plutoIntentClassifier.js", () => ({ classifyPlutoIntent: H.classifyIntentMock }));
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: H.policyRulesMock }));

// resolveHotelDestination is the ONE function from this module copilot.
// travel.ts's new block calls; the rest (isHotelRequest, extractStarFilter,
// nightsBetween, etc.) run for real via importOriginal — only the DB-backed
// resolution itself is stubbed.
vi.mock("../utils/plutoHotelDestination.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, resolveHotelDestination: H.resolveHotelDestinationMock };
});
vi.mock("../utils/plutoHotelSearch.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, searchHotelsForChat: H.searchHotelsForChatMock };
});

vi.mock("../utils/plutoMemory.js", () => ({
  getConversationContext: async () => null,
  saveConversationContext: async () => {},
  claimHandoffDelivery: async () => false,
  releaseHandoffDelivery: async () => {},
}));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const WS = "656565656565656565656565";
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { _id: "u1", email: "u@x.com", name: "U", nationality: "IN" };
  req.workspaceObjectId = WS;
  req.workspaceId = WS;
  next();
});
app.use("/", router);

// The exact fabrication the bug report describes — invented named hotels
// with invented prices, no HotelCode, nothing bookable.
const FABRICATED_HOTELS = [
  { name: "The Peninsula Tokyo", area: "Marunouchi", approxPrice: "₹45,000/night", whyGood: "Iconic luxury" },
  { name: "Park Hyatt Tokyo", area: "Shinjuku", approxPrice: "₹52,000/night", whyGood: "Lost in Translation views" },
  { name: "Mandarin Oriental Tokyo", area: "Nihonbashi", approxPrice: "₹58,000/night", whyGood: "Michelin dining" },
];

function itineraryAiReply(overrides: Record<string, any> = {}) {
  return {
    title: "3-Day Tokyo Business Trip",
    context: "Here's a draft plan for your Tokyo trip.",
    tripType: "business",
    itinerary: [
      { day: 1, heading: "Arrival & Orientation", details: ["Land, check in", "Evening in Shinjuku"] },
      { day: 2, heading: "Business Day", details: ["Meetings", "Client dinner"] },
      { day: 3, heading: "Departure", details: ["Final meetings", "Fly out"] },
    ],
    hotels: FABRICATED_HOTELS,
    nextSteps: ["Confirm your travel dates"],
    ...overrides,
  };
}

const LIVE_TOKYO_HOTELS = [
  { HotelCode: "148251-1", HotelName: "Real Live Hotel Tokyo", price: 21000 },
];

async function turn(context: any, prompt = "3-day business trip to Tokyo") {
  const res = await request(app).post("/").send({ prompt, context });
  return res.body;
}

beforeEach(() => {
  Object.values(H).forEach((m: any) => m.mockReset());
  H.resolveStateMock.mockReturnValue("PLANNING");
  H.lockDecisionsMock.mockImplementation((_reply: any, locked: any) => locked);
  H.classifyIntentMock.mockReturnValue("GENERAL");
  H.policyRulesMock.mockResolvedValue(null);
});

describe("itinerary hotel section — live lane supersedes fabrication", () => {
  it("city resolves live but NO dates locked → fabricated hotels suppressed, dates asked for, live search never called", async () => {
    H.invokePlutoMock.mockResolvedValue(itineraryAiReply());
    H.resolveHotelDestinationMock.mockResolvedValue({
      status: "RESOLVED", cityName: "Tokyo", countryCode: "JP", cityCode: "148251",
    });

    const context = { locked: { destination: { name: "Tokyo", source: "user" }, duration: { days: 3, source: "user" } } };
    const body = await turn(context);

    expect(body.ok).toBe(true);
    expect(body.reply.itinerary).toHaveLength(3); // schedule untouched
    expect(body.reply.hotels).toBeUndefined(); // fabricated list gone
    expect(body.reply.hotelSearch).toBeUndefined(); // no dates → no live search attempted
    expect(H.searchHotelsForChatMock).not.toHaveBeenCalled();
    // Structured signal for the frontend's inline "01 · Stays" dates-ask —
    // NOT duplicated into the generic nextSteps question row.
    expect(body.reply.hotelsAwaitingDates).toEqual({ city: "Tokyo" });
    expect(body.reply.nextSteps).not.toContain("What are your check-in and check-out dates for Tokyo?");
  });

  it("city resolves live AND dates are locked → live search runs, hotelSearch replaces the fabricated list", async () => {
    H.invokePlutoMock.mockResolvedValue(itineraryAiReply());
    H.resolveHotelDestinationMock.mockResolvedValue({
      status: "RESOLVED", cityName: "Tokyo", countryCode: "JP", cityCode: "148251",
    });
    H.searchHotelsForChatMock.mockResolvedValue({ ok: true, cityName: "Tokyo", hotels: LIVE_TOKYO_HOTELS, searchId: "srch1" });

    const context = {
      locked: {
        destination: { name: "Tokyo", source: "user" },
        duration: { days: 3, source: "user" },
        dates: { start: "2026-09-25", end: "2026-09-28", source: "user" },
      },
    };
    const body = await turn(context);

    expect(body.ok).toBe(true);
    expect(body.reply.hotels).toBeUndefined();
    expect(body.reply.hotelSearch).toBeDefined();
    expect(body.reply.hotelSearch.hotels).toEqual(LIVE_TOKYO_HOTELS);
    expect(body.reply.hotelSearch.city).toBe("Tokyo");
    expect(body.reply.hotelSearch.checkIn).toBe("2026-09-25");
    expect(body.reply.hotelSearch.checkOut).toBe("2026-09-28");
    expect(body.reply.hotelSearch.source).toBe("tbo");

    // The exact same live call the standalone hotel lane makes — same city
    // code, same dates, same occupancy default.
    expect(H.searchHotelsForChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cityName: "Tokyo",
        cityCode: "148251",
        countryCode: "JP",
        checkIn: "2026-09-25",
        checkOut: "2026-09-28",
        adults: 2,
        rooms: 1,
      }),
    );

    // The itinerary skeleton itself is completely unaffected.
    expect(body.reply.itinerary).toHaveLength(3);
    expect(body.reply.itinerary[0].heading).toBe("Arrival & Orientation");
    expect(body.reply.hotelsAwaitingDates).toBeUndefined();
  });

  it("live search runs but finds nothing → honest gap, not fabrication", async () => {
    H.invokePlutoMock.mockResolvedValue(itineraryAiReply());
    H.resolveHotelDestinationMock.mockResolvedValue({
      status: "RESOLVED", cityName: "Tokyo", countryCode: "JP", cityCode: "148251",
    });
    H.searchHotelsForChatMock.mockResolvedValue({ ok: false, reason: "NO_AVAILABILITY" });

    const context = {
      locked: {
        destination: { name: "Tokyo", source: "user" },
        dates: { start: "2026-09-25", end: "2026-09-28", source: "user" },
      },
    };
    const body = await turn(context);

    expect(body.reply.hotels).toBeUndefined();
    expect(body.reply.hotelSearch).toBeUndefined();
    expect(body.reply.hotelsAwaitingDates).toBeUndefined();
  });

  it("city matches SEVERAL real cities (AMBIGUOUS) → asks which, still no fabrication", async () => {
    H.invokePlutoMock.mockResolvedValue(itineraryAiReply({ title: "Trip to Springfield" }));
    H.resolveHotelDestinationMock.mockResolvedValue({
      status: "AMBIGUOUS",
      query: "Springfield",
      candidates: [
        { cityName: "Springfield", countryCode: "US", cityCode: "500001", region: "Illinois" },
        { cityName: "Springfield", countryCode: "US", cityCode: "500002", region: "Missouri" },
      ],
    });

    const context = { locked: { destination: { name: "Springfield", source: "user" } } };
    const body = await turn(context);

    // The fabricated list goes, exactly as it does for every other outcome.
    expect(body.reply.hotels).toBeUndefined();
    expect(body.reply.hotelSearch).toBeUndefined();
    // Never price a guess: the search must not run against either candidate.
    expect(H.searchHotelsForChatMock).not.toHaveBeenCalled();
    // Structured signal → the frontend renders one pickable chip per candidate.
    expect(body.reply.hotelsAwaitingCity).toEqual({
      query: "Springfield",
      candidates: [
        { cityName: "Springfield", countryCode: "US", cityCode: "500001", region: "Illinois" },
        { cityName: "Springfield", countryCode: "US", cityCode: "500002", region: "Missouri" },
      ],
    });
    expect(body.reply.hotelsAwaitingDates).toBeUndefined();
  });

  it("city does not resolve live (UNSUPPORTED) → no fabrication either", async () => {
    H.invokePlutoMock.mockResolvedValue(itineraryAiReply({ title: "Trip to Nowhereville" }));
    H.resolveHotelDestinationMock.mockResolvedValue({ status: "UNSUPPORTED", cityName: "Nowhereville" });

    const context = { locked: { destination: { name: "Nowhereville", source: "user" } } };
    const body = await turn(context);

    expect(body.reply.hotels).toBeUndefined();
    expect(body.reply.hotelSearch).toBeUndefined();
    expect(body.reply.hotelsAwaitingDates).toBeUndefined();
    expect(body.reply.hotelsAwaitingCity).toBeUndefined();
    expect(H.searchHotelsForChatMock).not.toHaveBeenCalled();
  });

  it("a non-itinerary reply with no hotels[] at all is completely unaffected (block never runs)", async () => {
    H.invokePlutoMock.mockResolvedValue({
      title: "Flight status", context: "Your flight is on time.", tripType: "business", nextSteps: [],
    });
    const body = await turn({ locked: {} }, "is my flight on time");

    expect(body.reply.hotels).toBeUndefined();
    expect(body.reply.hotelSearch).toBeUndefined();
    expect(H.resolveHotelDestinationMock).not.toHaveBeenCalled();
    expect(H.searchHotelsForChatMock).not.toHaveBeenCalled();
  });
});
