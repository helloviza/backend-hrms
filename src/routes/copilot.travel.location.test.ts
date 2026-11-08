// Pluto location fix — route-level (docs/audits/pluto-office-location-2026-11-09.md).
//
// Mounts the REAL router so every matcher (office phrase, near-me, flight
// detector + terminators, relative dates, pending answers, hotel lane,
// post-AI guard) runs for real. Only the edges are mocked: the profile/geo
// lookups (resolveOfficeCity / suggestCurrentCity), the DB-backed hotel
// destination resolver, TBO search, the LLM, and memory. No Mongo, MaxMind,
// TBO or LLM is ever reached.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
});

const H = vi.hoisted(() => ({
  searchFlightsMock: vi.fn(),
  officeMock: vi.fn(),
  hereMock: vi.fn(),
  resolveHotelDestinationMock: vi.fn(),
  searchHotelsForChatMock: vi.fn(),
  invokePlutoMock: vi.fn(),
}));

vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: H.searchFlightsMock }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({
  getRouteIntelProvider: () => ({ getRouteInsights: vi.fn().mockResolvedValue({ sufficient: false, observationCount: 0, dataWindowDays: 90 }) }),
}));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));
vi.mock("../services/flightService.js", () => ({ getDelightfulFlightStatus: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/sbtMargin.js", () => ({ flightRouteMargins: vi.fn().mockResolvedValue(null) }));
vi.mock("../utils/plutoInvoke.js", () => ({ invokePluto: H.invokePlutoMock }));
vi.mock("../utils/plutoStateResolver.js", () => ({ resolvePlutoState: () => "DISCOVERY" }));
vi.mock("../utils/plutoDecisionLocker.js", () => ({ lockDecisions: (_r: any, locked: any) => locked }));
vi.mock("../utils/plutoMemory.js", () => ({
  getConversationContext: async () => null,
  saveConversationContext: async () => {},
  claimHandoffDelivery: async () => false,
  releaseHandoffDelivery: async () => {},
}));
vi.mock("../utils/plutoUserLocation.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, resolveOfficeCity: H.officeMock, suggestCurrentCity: H.hereMock };
});
vi.mock("../utils/plutoHotelDestination.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, resolveHotelDestination: H.resolveHotelDestinationMock };
});
vi.mock("../utils/plutoHotelSearch.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, searchHotelsForChat: H.searchHotelsForChatMock };
});

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";
import { OFFICE_ASK_TEXT, OFFICE_ASK_CHIP, OTHER_CITY_CHIP } from "../utils/plutoUserLocation.js";

const WS = "656565656565656565656565";
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { _id: "64b000000000000000000001", email: "t@plumtrips.com", nationality: "IN" };
  req.workspaceObjectId = WS;
  req.workspaceId = WS;
  next();
});
app.use("/", router);

const chat = (prompt: string, context: any = {}) =>
  request(app).post("/").send({ prompt, context }).then((r) => r.body);

const oneFlight = {
  Response: {
    TraceId: "T",
    ResponseStatus: 1,
    Results: [[{
      ResultIndex: "OB1", IsLCC: true, IsRefundable: true,
      Fare: { PublishedFare: 5000, OfferedFare: 4800, Currency: "INR" },
      Segments: [[{
        CabinClass: 2, Duration: 130, Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "2582" },
        Origin: { DepTime: "2026-11-16T07:20:00", Airport: { AirportCode: "BLR", CityName: "Bengaluru" } },
        Destination: { ArrTime: "2026-11-16T09:30:00", Airport: { AirportCode: "BOM", CityName: "Mumbai" } },
      }]],
    }]],
  },
};

const BLR = { cityName: "Bengaluru", countryCode: "IN", cityCode: "111124" };
const officeAt = (city: typeof BLR) => ({ status: "RESOLVED", city, raw: city.cityName, source: "jobLocation" });
const OFFICE_NONE = { status: "ASK", raw: "Head Office", reason: "not_a_city" };

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  Object.values(H).forEach((m) => m.mockReset());
  H.searchFlightsMock.mockResolvedValue(oneFlight);
  H.hereMock.mockResolvedValue(null);
  H.officeMock.mockResolvedValue({ status: "ASK", raw: null, reason: "empty" });
  H.resolveHotelDestinationMock.mockResolvedValue({ status: "NO_CITY" });
  H.invokePlutoMock.mockResolvedValue({ title: "Sure", context: "Tell me more.", nextSteps: [] });
  // Monday 9 Nov 2026, noon IST — only Date is faked, timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T06:30:00Z"));
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  warnSpy.mockRestore();
});

/* ─────────────────────────── FLIGHTS ─────────────────────────── */

describe("#4 — 'next week' is a date, not part of the city", () => {
  it("'Find flights from Delhi to Mumbai next week' → DEL→BOM on Mon 16 Nov, and the rule is said back", async () => {
    const body = await chat("Find flights from Delhi to Mumbai next week");
    expect(H.searchFlightsMock).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "DEL", destination: "BOM", departDate: "2026-11-16" }),
    );
    expect(body.reply.context).toContain(`I read "next week" as the Monday of next week — Monday 16 Nov 2026 (IST)`);
    expect(body.reply.context).not.toMatch(/couldn't match/);
  });

  it("'flights to Mumbai tomorrow from Pune' → PNQ→BOM on 10 Nov", async () => {
    await chat("flights to Mumbai tomorrow from Pune");
    expect(H.searchFlightsMock).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "PNQ", destination: "BOM", departDate: "2026-11-10" }),
    );
  });

  it("an explicit date still wins and no relative note is added", async () => {
    const body = await chat("find flights from Delhi to Mumbai on 20 Nov 2026");
    expect(H.searchFlightsMock).toHaveBeenCalledWith(expect.objectContaining({ departDate: "2026-11-20" }));
    expect(body.reply.context).not.toMatch(/I read "/);
  });
});

describe("#2a — no origin: current location is a SUGGESTION, never a silent fill", () => {
  it("IP resolves → asks with a one-tap chip; does NOT search and does NOT lock an origin", async () => {
    H.hereMock.mockResolvedValue(BLR);
    const body = await chat("Find flights to Mumbai next week");
    expect(H.searchFlightsMock).not.toHaveBeenCalled();
    expect(body.reply.title).toBe("Where are you flying from?");
    expect(body.reply.context).toBe(
      `I can search flights to Mumbai on 16 Nov 2026. I read "next week" as the Monday of next week — Monday 16 Nov 2026 (IST) — tell me if you meant another day. Where are you flying from?`,
    );
    expect(body.reply.nextSteps).toEqual(["Flying from Bengaluru? (based on your current location)", OTHER_CITY_CHIP]);
    expect(body.context.locked?.origin).toBeUndefined();
    expect(body.context.pending).toMatchObject({ kind: "flight", need: "origin" });
  });

  it("tapping the chip sends the city as the user's answer → BLR→BOM on 16 Nov", async () => {
    H.hereMock.mockResolvedValue(BLR);
    const ask = await chat("Find flights to Mumbai next week");
    const body = await chat(ask.reply.nextSteps[0], ask.context);
    expect(H.searchFlightsMock).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "BLR", destination: "BOM", departDate: "2026-11-16" }),
    );
    expect(body.context.locked.origin).toMatchObject({ city: "Bengaluru", source: "user" });
    expect(body.context.pending).toBeUndefined(); // one-turn only
  });

  it("'Other city — which one?' prefilled + 'Pune' → PNQ→BOM", async () => {
    H.hereMock.mockResolvedValue(BLR);
    const ask = await chat("Find flights to Mumbai next week");
    await chat(`${OTHER_CITY_CHIP} Pune`, ask.context);
    expect(H.searchFlightsMock).toHaveBeenCalledWith(expect.objectContaining({ origin: "PNQ", destination: "BOM" }));
  });

  it("IP unavailable → today's question, no location chip; a typed 'Pune' still answers it", async () => {
    const ask = await chat("Find flights to Mumbai next week");
    expect(ask.reply.title).toBe("Which airport should I search?");
    expect(ask.reply.context).toMatch(/^I need both a departure and destination city to search flights\./);
    expect(ask.reply.nextSteps.join(" ")).not.toMatch(/current location/);
    await chat("Pune", ask.context);
    expect(H.searchFlightsMock).toHaveBeenCalledWith(expect.objectContaining({ origin: "PNQ", destination: "BOM" }));
  });

  it("an IP city equal to the destination is not offered", async () => {
    H.hereMock.mockResolvedValue({ cityName: "Mumbai", countryCode: "IN", cityCode: "144306" });
    const body = await chat("Find flights to Mumbai next week");
    expect(body.reply.nextSteps.join(" ")).not.toMatch(/current location/);
  });

  it("a stale pending marker never hijacks a NEW request", async () => {
    const ask = await chat("Find flights to Mumbai next week");
    await chat("find flights from Delhi to Goa on 20 Nov 2026", ask.context);
    expect(H.searchFlightsMock).toHaveBeenCalledWith(expect.objectContaining({ origin: "DEL", destination: "GOI" }));
  });
});

describe("#1 — office as a flight endpoint (profile, disclosed)", () => {
  it("office on file → used as origin and DISCLOSED; locked with source 'profile'; IP never consulted", async () => {
    H.officeMock.mockResolvedValue(officeAt({ cityName: "Pune", countryCode: "IN", cityCode: "131766" }));
    const body = await chat("flights from my office to Mumbai on 20 Nov 2026");
    expect(H.searchFlightsMock).toHaveBeenCalledWith(expect.objectContaining({ origin: "PNQ", destination: "BOM" }));
    expect(body.reply.context).toMatch(/^Your profile lists your office as Pune, so I've used Pune as your departure city\. /);
    expect(body.context.locked.origin).toMatchObject({ city: "Pune", source: "profile" });
    expect(H.hereMock).not.toHaveBeenCalled();
  });

  it("no office city on file → the specific question; never a guess, never the IP city", async () => {
    H.officeMock.mockResolvedValue(OFFICE_NONE);
    H.hereMock.mockResolvedValue(BLR);
    const body = await chat("flights from my office to Mumbai on 20 Nov 2026");
    expect(H.searchFlightsMock).not.toHaveBeenCalled();
    expect(body.reply.context).toBe(OFFICE_ASK_TEXT);
    expect(body.reply.nextSteps).toEqual([OFFICE_ASK_CHIP]);
    expect(JSON.stringify(body.reply)).not.toMatch(/Bengaluru|current location/);
    expect(H.hereMock).not.toHaveBeenCalled();
  });

  it("answering the office question → search from that city", async () => {
    H.officeMock.mockResolvedValue(OFFICE_NONE);
    const ask = await chat("flights from my office to Mumbai on 20 Nov 2026");
    await chat(`${OFFICE_ASK_CHIP} Hyderabad`, ask.context);
    expect(H.searchFlightsMock).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "HYD", destination: "BOM", departDate: "2026-11-20" }),
    );
  });
});

/* ─────────────────────────── HOTELS ─────────────────────────── */

describe("#1 — 'hotels near my office'", () => {
  it("office on file, no dates → disclosed, destination locked with source 'profile', asks only for dates", async () => {
    H.officeMock.mockResolvedValue(officeAt(BLR));
    const body = await chat("Suggest hotels near my office");
    expect(body.reply.context).toBe(
      "Your profile lists your office as Bengaluru — I'll search hotels in Bengaluru (city-wide, not sorted by distance to your office). Which dates are you staying?",
    );
    expect(body.context.locked.destination).toEqual({ name: "Bengaluru", source: "profile" });
    expect(H.searchHotelsForChatMock).not.toHaveBeenCalled();
    expect(H.resolveHotelDestinationMock).not.toHaveBeenCalled();
    expect(H.hereMock).not.toHaveBeenCalled();
    expect(H.invokePlutoMock).not.toHaveBeenCalled();
  });

  it("office on file + dates → live search by the office city's code, disclosure BEFORE the results", async () => {
    H.officeMock.mockResolvedValue(officeAt(BLR));
    H.searchHotelsForChatMock.mockResolvedValue({
      ok: true, cityName: "Bengaluru", searchId: "S1",
      hotels: [{ HotelCode: "H1", HotelName: "Real Hotel", Rooms: [] }],
    });
    const body = await chat("hotels near my office 12 to 14 Dec 2026");
    expect(H.searchHotelsForChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ cityName: "Bengaluru", cityCode: "111124", countryCode: "IN", checkIn: "2026-12-12", checkOut: "2026-12-14" }),
    );
    expect(body.reply.context).toMatch(
      /^Your profile lists your office as Bengaluru — showing hotels in Bengaluru \(city-wide, not sorted by distance to your office\)\. Found 1 available property/,
    );
    expect(body.context.locked.destination).toEqual({ name: "Bengaluru", source: "profile" });
  });

  it.each([
    ["nothing on file", { status: "ASK", raw: null, reason: "empty" }],
    ["'Head Office'", OFFICE_NONE],
    ["'Remote'", { status: "ASK", raw: "Remote", reason: "not_a_city" }],
    ["ambiguous", { status: "ASK", raw: "Springfield", reason: "ambiguous" }],
  ])("%s → the specific office question, never UNSUPPORTED and never the IP city", async (_l, office) => {
    H.officeMock.mockResolvedValue(office);
    H.hereMock.mockResolvedValue(BLR);
    const body = await chat("Suggest hotels near my office");
    expect(body.reply.context).toBe(OFFICE_ASK_TEXT);
    expect(body.reply.nextSteps).toEqual([OFFICE_ASK_CHIP]);
    expect(body.reply.title).not.toMatch(/Hotels in my office/i);
    expect(H.hereMock).not.toHaveBeenCalled();
    expect(H.invokePlutoMock).not.toHaveBeenCalled();
    expect(body.context.pending).toMatchObject({ kind: "hotel" });
  });

  it("answering the office question ('… Pune') → that city through the normal ladder, then dates", async () => {
    H.officeMock.mockResolvedValue(OFFICE_NONE);
    H.resolveHotelDestinationMock.mockResolvedValue({ status: "RESOLVED", cityName: "Pune", countryCode: "IN", cityCode: "131766" });
    const ask = await chat("Suggest hotels near my office");
    const body = await chat(`${OFFICE_ASK_CHIP} Pune`, ask.context);
    expect(H.resolveHotelDestinationMock).toHaveBeenCalledWith("hotels in Pune", {});
    expect(body.reply.context).toBe("Hotels in Pune — which dates are you staying?");
    expect(body.context.locked.destination).toEqual({ name: "Pune", source: "user" });
  });

  it("a place named in the prompt wins over the profile ('near my office in Pune')", async () => {
    H.officeMock.mockResolvedValue(officeAt(BLR));
    await chat("hotels near my office in Pune");
    expect(H.officeMock).not.toHaveBeenCalled();
    expect(H.resolveHotelDestinationMock).toHaveBeenCalledWith("hotels near my office in Pune", {});
  });
});

describe("#2b — 'hotels near me': current location as a suggestion only", () => {
  it("IP resolves → 'You seem to be around …' with a one-tap chip; no search", async () => {
    H.hereMock.mockResolvedValue(BLR);
    const body = await chat("any hotels near me tonight?");
    expect(body.reply.context).toBe("You seem to be around Bengaluru right now (based on your current location). Search there?");
    expect(body.reply.nextSteps).toEqual(["Search hotels in Bengaluru (my current location)", OTHER_CITY_CHIP]);
    expect(H.searchHotelsForChatMock).not.toHaveBeenCalled();
    expect(body.context.locked?.destination).toBeUndefined();
    expect(H.officeMock).not.toHaveBeenCalled();
  });

  it("tapping the chip is an ordinary 'hotels in Bengaluru' turn", async () => {
    H.hereMock.mockResolvedValue(BLR);
    const ask = await chat("hotels nearby");
    await chat(ask.reply.nextSteps[0], ask.context);
    expect(H.resolveHotelDestinationMock).toHaveBeenCalledWith("Search hotels in Bengaluru (my current location)", {});
  });

  it("IP unavailable → today's behaviour (normal resolution, model asks)", async () => {
    const body = await chat("hotels near me");
    expect(H.resolveHotelDestinationMock).toHaveBeenCalledWith("hotels near me", {});
    expect(JSON.stringify(body.reply)).not.toMatch(/current location/);
  });
});

describe("#5 — NO_CITY: model-invented hotels are stripped and logged", () => {
  it("model emits hotels[] on a turn with no city → reply.hotels removed + warn", async () => {
    H.invokePlutoMock.mockResolvedValue({
      title: "Hotels",
      context: "Which city is your office in?",
      hotels: [{ name: "Invented Grand", approxPrice: "₹9,000/night" }],
      nextSteps: [],
    });
    const body = await chat("Suggest a good hotel for my team");
    expect(H.invokePlutoMock).toHaveBeenCalled();
    expect(body.reply.hotels).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "[Pluto] stripped model-generated hotels on a NO_CITY turn",
      expect.objectContaining({ count: 1 }),
    );
  });
});

/* ─────────────────────── #6 — MY SPACE CHIPS ─────────────────────── */

const CHIPS = ["Hotels near my office", "Flights to Mumbai next week", "Recommend places to visit in Goa"];

describe("#6 — My Space chips work end to end through the real matchers", () => {
  // The chip list is read from the shipped component, so this test fails the
  // moment the frontend list and these expectations drift apart. Skipped in
  // the backend-only GitHub mirror, where the frontend is not present.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const box = path.resolve(here, "../../../frontend/src/components/myspace/MsPlutoBox.tsx");
  it.skipIf(!fs.existsSync(box))("MsPlutoBox ships exactly these chips", () => {
    const src = fs.readFileSync(box, "utf8");
    const block = src.match(/const SUGGESTIONS = \[([\s\S]*?)\];/)?.[1] ?? "";
    expect([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(CHIPS);
  });

  it(`"${CHIPS[0]}" — office on file → disclosed office search`, async () => {
    H.officeMock.mockResolvedValue(officeAt(BLR));
    const body = await chat(CHIPS[0]);
    expect(body.reply.context).toMatch(/^Your profile lists your office as Bengaluru/);
  });

  it(`"${CHIPS[0]}" — no office on file → the specific office question`, async () => {
    const body = await chat(CHIPS[0]);
    expect(body.reply.context).toBe(OFFICE_ASK_TEXT);
  });

  it(`"${CHIPS[1]}" — reaches the flight branch, Mumbai + next Monday, location chip offered`, async () => {
    H.hereMock.mockResolvedValue(BLR);
    const body = await chat(CHIPS[1]);
    expect(body.reply.context).toContain("flights to Mumbai on 16 Nov 2026");
    expect(body.reply.nextSteps[0]).toBe("Flying from Bengaluru? (based on your current location)");
    const done = await chat(body.reply.nextSteps[0], body.context);
    expect(H.searchFlightsMock).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "BLR", destination: "BOM", departDate: "2026-11-16" }),
    );
    expect(done.reply.title).toMatch(/Bengaluru → Mumbai/);
  });

  it(`"${CHIPS[2]}" — goes to the model with the text intact; no location lookups`, async () => {
    await chat(CHIPS[2]);
    expect(H.invokePlutoMock).toHaveBeenCalledWith(expect.stringContaining(CHIPS[2]), expect.anything());
    expect(H.officeMock).not.toHaveBeenCalled();
    expect(H.hereMock).not.toHaveBeenCalled();
    expect(H.searchFlightsMock).not.toHaveBeenCalled();
  });
});
