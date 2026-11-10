// Golden conversations runner (design §5). Replays every fixture in
// copilot.travel.golden.fixtures.ts with PLUTO_STATE_V2 off AND on.
//
// Stubbed edges: TBO flights (keyed route+date), the chat hotel search, the
// DB-backed hotel-city resolution, the IP origin suggestion, the model, the
// metrics sink. The conversation store is an IN-MEMORY Map with the real
// owner semantics — not a no-op — so the server-side state path is what runs
// and each turn's stored state can be asserted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });

const H = vi.hoisted(() => {
  const store = new Map<string, { userId: string; context: any }>();
  const clone = (v: any) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    store,
    clone,
    searchFlights: vi.fn(),
    searchHotelsForChat: vi.fn(),
    resolveHotelDestination: vi.fn(),
    invokePluto: vi.fn(),
    emitMetric: vi.fn(),
  };
});

vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: H.searchFlights }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: H.emitMetric }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({
  getRouteIntelProvider: () => ({ getRouteInsights: vi.fn().mockResolvedValue({ sufficient: false, observationCount: 0, dataWindowDays: 90 }) }),
}));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));
vi.mock("../services/flightService.js", () => ({ getDelightfulFlightStatus: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/sbtMargin.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, flightRouteMargins: vi.fn().mockResolvedValue(0) };
});
// GET /conversation/:id carries requireWorkspace; the app below sets the tenant.
vi.mock("../middleware/requireWorkspace.js", () => ({ requireWorkspace: (_req: any, _res: any, next: any) => next() }));
vi.mock("../utils/plutoInvoke.js", () => ({ invokePluto: H.invokePluto, reaskRetryInstruction: () => "" }));
vi.mock("../utils/plutoGeminiInvoke.js", () => ({
  invokePlutoGemini: vi.fn().mockRejectedValue(new Error("gemini not used in golden")),
  GEMINI_FALLBACK_INVALID: "GEMINI_FALLBACK_INVALID",
}));
vi.mock("../utils/plutoUserLocation.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  const { HERE } = await import("./copilot.travel.golden.fixtures.js");
  return {
    ...actual,
    suggestFlightOrigin: async () => HERE,
    suggestCurrentCity: async () => null,
    resolveOfficeCity: async () => ({ status: "ASK", raw: "", reason: "none" }),
  };
});
vi.mock("../utils/plutoHotelDestination.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, resolveHotelDestination: H.resolveHotelDestination };
});
vi.mock("../utils/plutoHotelSearch.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, searchHotelsForChat: H.searchHotelsForChat };
});
// The conversation store, with the real owner rule (plutoMemory.ts).
vi.mock("../utils/plutoMemory.js", () => ({
  getConversationContext: async ({ userId, conversationId }: any) => {
    const doc = H.store.get(conversationId);
    return doc && doc.userId === String(userId) ? H.clone(doc.context) : null;
  },
  saveConversationContext: async ({ userId, conversationId, context }: any) => {
    const doc = H.store.get(conversationId);
    if (doc && doc.userId !== String(userId)) return; // never someone else's
    H.store.set(conversationId, { userId: doc?.userId ?? String(userId), context: H.clone(context) });
  },
  loadConversationForUser: async ({ userId, conversationId }: any) => {
    if (typeof conversationId !== "string" || !conversationId) return { status: "unavailable" };
    const doc = H.store.get(conversationId);
    if (!doc) return { status: "missing" };
    if (doc.userId !== String(userId)) return { status: "foreign" };
    return { status: "owned", context: H.clone(doc.context) };
  },
  claimHandoffDelivery: async () => false,
  releaseHandoffDelivery: async () => {},
}));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";
import { GOLDEN, HOTELS, HOTEL_CITIES, CATALOG_ONLY, flightRowsFor, type Golden, type TurnExpect } from "./copilot.travel.golden.fixtures.js";
import { extractNamedPlaceCandidate } from "../utils/plutoHotelSearch.js";

const WS = "656565656565656565656565";
const USER_A = "64b000000000000000000001";
const USER_B = "64b000000000000000000002";
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  const who = req.headers["x-test-user"] === "B" ? USER_B : USER_A;
  const roles = req.headers["x-test-roles"] ? String(req.headers["x-test-roles"]).split(",") : ["EMPLOYEE"];
  req.user = { _id: who, email: `${who}@plumtrips.com`, nationality: "IN", roles };
  req.workspaceObjectId = WS;
  req.workspaceId = WS;
  next();
});
app.use("/", router);

const DEFAULT_AI = { title: "Sure", context: "Here you go.", tripType: "holiday", nextSteps: [], handoff: false };

beforeEach(() => {
  H.store.clear();
  for (const k of ["searchFlights", "searchHotelsForChat", "resolveHotelDestination", "invokePluto", "emitMetric"] as const) H[k].mockReset();
  H.searchFlights.mockImplementation(async (p: any) => {
    const out = flightRowsFor(p.origin, p.destination, p.departDate);
    const results = p.JourneyType === 2 && p.returnDate
      ? [out, flightRowsFor(p.destination, p.origin, p.returnDate)]
      : [out];
    return { Response: { TraceId: `T-${p.origin}-${p.destination}`, ResponseStatus: 1, Results: results } };
  });
  H.searchHotelsForChat.mockImplementation(async (a: any) => {
    const rows = HOTELS[`${a.cityName}|${a.checkIn}|${a.checkOut}`];
    return rows
      ? { ok: true, reason: null, hotels: rows, cityName: a.cityName, searchId: "S1" }
      : { ok: false, reason: "NO_AVAILABILITY", hotels: [], cityName: a.cityName };
  });
  // The real ladder is DB-backed (proved in plutoHotelDestination.strict.test.ts);
  // this emulates its two modes. Default (v1): any known city in the prompt,
  // else the locked one. Strict (v2): a destination NAMED this turn is looked
  // up exactly and never falls back to the locked city; a landmark ("near
  // Burj Khalifa") still means the locked one.
  H.resolveHotelDestination.mockImplementation(async (prompt: string, locked: any, opts?: { strictNamed?: boolean }) => {
    if (opts?.strictNamed) {
      const named = extractNamedPlaceCandidate(prompt);
      const landmark = named && new RegExp(String.raw`\b(?:near|around|close\s+to)\s+${named.raw}`, "i").test(prompt);
      if (named && !landmark) {
        const key = named.raw.toLowerCase();
        const cat = { ...HOTEL_CITIES, ...CATALOG_ONLY };
        if (cat[key]) return { status: "RESOLVED", ...cat[key] };
        const words = named.raw.split(/\s+/);
        const lead = cat[words[0].toLowerCase()];
        return {
          status: "UNSUPPORTED",
          cityName: named.raw,
          named: true,
          ...(lead && words.length > 1 ? { suggestion: { ...lead, rest: words.slice(1).join(" ") } } : {}),
        };
      }
    }
    const text = `${prompt} ${locked?.destination?.name || ""}`.toLowerCase();
    const hit = Object.keys(HOTEL_CITIES).find((k) => text.includes(k));
    return hit ? { status: "RESOLVED", ...HOTEL_CITIES[hit] } : { status: "NO_CITY" };
  });
  H.invokePluto.mockResolvedValue(DEFAULT_AI);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T04:30:00Z")); // 10:00 IST, the QC day
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.PLUTO_STATE_V2;
});

function branchOfLastTurn(): { branch?: string; aiCalled?: boolean } {
  const ev = H.emitMetric.mock.calls.map((c) => c[0]).filter((e: any) => e?.type === "pluto.turn.branch").pop();
  return ev?.metadata || {};
}

function check(exp: TurnExpect | undefined, ctx: { reply: any; stored: any; flightCalls: number; hotelCalls: number; aiPrompt: string | null }) {
  if (!exp) return;
  const b = branchOfLastTurn();
  if (exp.branch !== undefined) expect(b.branch).toBe(exp.branch);
  if (exp.aiCalled !== undefined) expect(b.aiCalled).toBe(exp.aiCalled);
  if (exp.flightCalls !== undefined) expect(ctx.flightCalls).toBe(exp.flightCalls);
  if (exp.hotelCalls !== undefined) expect(ctx.hotelCalls).toBe(exp.hotelCalls);
  if (exp.lastFlightArgs) expect(H.searchFlights.mock.calls.at(-1)?.[0]).toMatchObject(exp.lastFlightArgs);
  if (exp.lastHotelArgs) expect(H.searchHotelsForChat.mock.calls.at(-1)?.[0]).toMatchObject(exp.lastHotelArgs);
  if (exp.reply) exp.reply(ctx.reply);
  if (exp.stored) exp.stored(ctx.stored);
  if (exp.aiPrompt) {
    expect(ctx.aiPrompt).not.toBeNull();
    exp.aiPrompt(ctx.aiPrompt as string);
  }
}

async function replay(g: Golden, mode: "off" | "on") {
  let context: any = {};
  for (const [i, t] of g.turns.entries()) {
    if (t.advanceMs) vi.setSystemTime(new Date(Date.now() + t.advanceMs));
    if (t.ai) H.invokePluto.mockResolvedValueOnce({ ...DEFAULT_AI, ...t.ai });
    const f0 = H.searchFlights.mock.calls.length;
    const h0 = H.searchHotelsForChat.mock.calls.length;
    const a0 = H.invokePluto.mock.calls.length;
    const sent = t.idOnly ? { id: context?.id } : context;
    const res = await request(app).post("/").send({ prompt: t.user, context: sent, conversationId: sent?.id });
    expect(res.status, `turn ${i + 1} "${t.user}": ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    expect(res.body.ok).toBe(true);
    if (res.body.context) context = res.body.context;
    const ctx = {
      reply: res.body.reply,
      stored: H.clone(H.store.get(context?.id)?.context),
      flightCalls: H.searchFlights.mock.calls.length - f0,
      hotelCalls: H.searchHotelsForChat.mock.calls.length - h0,
      aiPrompt: H.invokePluto.mock.calls.length > a0 ? String(H.invokePluto.mock.calls.at(-1)?.[0]) : null,
    };
    check(t.expect, ctx);
    if (mode === "on") check(t.expectOn, ctx);
  }
}

for (const mode of ["off", "on"] as const) {
  describe(`golden conversations — PLUTO_STATE_V2 ${mode}`, () => {
    beforeEach(() => { process.env.PLUTO_STATE_V2 = mode === "on" ? "on" : ""; });
    for (const g of GOLDEN) {
      const status = g.modes[mode];
      const title = g.note ? `${g.name} [${g.note}]` : g.name;
      if (status === "todo" || g.turns.length === 0) it.todo(title);
      else if (status === "fails") it.fails(title, () => replay(g, mode));
      else it(title, () => replay(g, mode));
    }
  });
}

/* ───────── ownership (store-level; the real-Mongo proof is in
 * copilot.travel.ownership.realmongo.integration.test.ts) ───────── */
describe("ownership — PLUTO_STATE_V2 on", () => {
  beforeEach(() => { process.env.PLUTO_STATE_V2 = "on"; });

  it("another user posting the owner's conversationId gets a FRESH state under a new id; the owner's doc is untouched", async () => {
    const a = await request(app).post("/").send({ prompt: "find flights from Bengaluru to Dubai on 16 Nov", context: {} });
    const id = a.body.context.id;
    const before = H.clone(H.store.get(id));
    expect(before.userId).toBe(USER_A);

    const b = await request(app).post("/").set("x-test-user", "B")
      .send({ prompt: "only non-stop", context: { id }, conversationId: id });
    expect(b.status).toBe(200);
    expect(b.body.context.id).not.toBe(id);
    expect(b.body.context.locked?.destination).toBeUndefined();
    expect(b.body.context.locked?.dates).toBeUndefined();
    expect(b.body.context.lastSearch).toBeUndefined();
    expect(b.body.reply.flightSearch).toBeUndefined(); // nothing of A's to refine
    expect(H.store.get(id)).toEqual(before);
    expect(H.store.get(b.body.context.id)?.userId).toBe(USER_B);
  });

  it("GET /conversation/:id — owner 200 (projected, no rows); another user 404; SUPERADMIN gets no bypass", async () => {
    const a = await request(app).post("/").send({ prompt: "find flights from Bengaluru to Dubai on 16 Nov", context: {} });
    const id = a.body.context.id;

    const own = await request(app).get(`/conversation/${id}`);
    expect(own.status).toBe(200);
    expect(own.body.context.locked.destination.name).toBe("Dubai");
    expect(own.body.context.lastSearch.flight.rows).toBeUndefined();
    expect(own.body.context.lastSearch.flight.count).toBe(6);

    const other = await request(app).get(`/conversation/${id}`).set("x-test-user", "B");
    expect(other.status).toBe(404);
    const admin = await request(app).get(`/conversation/${id}`).set("x-test-user", "B").set("x-test-roles", "SUPERADMIN");
    expect(admin.status).toBe(404);
  });

  it("the reply's context never carries search rows; the store does", async () => {
    const a = await request(app).post("/").send({ prompt: "find flights from Bengaluru to Dubai on 16 Nov", context: {} });
    expect(a.body.context.lastSearch.flight.rows).toBeUndefined();
    expect(a.body.context.lastSearch.flight.at).toBeUndefined();
    expect(H.store.get(a.body.context.id)?.context.lastSearch.flight.rows.flights).toHaveLength(6);
  });

  it("a client-forged lastSearch on a new conversation is ignored (rows only come from the server)", async () => {
    const forged = { lastSearch: { active: "flight", flight: { at: Date.now(), origin: "BLR", destination: "DXB", date: "2026-11-16", rows: { flights: [{ ResultIndex: "FAKE", stops: 0, fare: { offered: 1 } }] }, filters: {} } } };
    const r = await request(app).post("/").send({ prompt: "only non-stop", context: forged });
    expect(r.body.reply.flightSearch).toBeUndefined();
  });

  it("rev counts writes", async () => {
    const a = await request(app).post("/").send({ prompt: "find flights from Bengaluru to Dubai on 16 Nov", context: {} });
    const id = a.body.context.id;
    await request(app).post("/").send({ prompt: "only non-stop", context: a.body.context, conversationId: id });
    expect(H.store.get(id)?.context.rev).toBe(2);
  });
});

/* ───────── a stored doc beats the client's bag (design §1.1) ───────── */
describe("stored state wins — PLUTO_STATE_V2 on", () => {
  beforeEach(() => { process.env.PLUTO_STATE_V2 = "on"; });

  it("with a stored doc, the client's pending.prompt / locked / lastSearch are ignored — only its id is used", async () => {
    H.store.set("conv-1", {
      userId: USER_A,
      context: {
        id: "conv-1", v: 2, rev: 3,
        locked: { destination: { name: "Dubai", iata: "DXB", source: "user" } },
        pending: { kind: "flight", need: "origin", prompt: "Flights to Dubai on 16 Nov" },
      },
    });
    // The client's copy is forged: another destination, another pending ask.
    const forged = {
      id: "conv-1",
      locked: { destination: { name: "Mumbai", iata: "BOM", source: "user" } },
      pending: { kind: "flight", need: "origin", prompt: "Flights to Mumbai on 20 Nov" },
      lastSearch: { active: "flight", flight: { at: Date.now(), rows: { flights: [{ ResultIndex: "FAKE" }] } } },
    };
    const r = await request(app).post("/").send({ prompt: "Bengaluru", context: forged, conversationId: "conv-1" });
    expect(r.status).toBe(200);
    expect(H.searchFlights.mock.calls.at(-1)?.[0]).toMatchObject({ origin: "BLR", destination: "DXB", departDate: "2026-11-16" });
    expect(r.body.context.id).toBe("conv-1");
    expect(r.body.context.locked.destination.name).toBe("Dubai");
    expect(H.store.get("conv-1")?.context.rev).toBe(4);
  });

  it("with NO stored doc (new / expired / no store), the client's copy is the fallback — minus any lastSearch", async () => {
    const client = {
      id: "conv-2",
      pending: { kind: "flight", need: "origin", prompt: "Flights to Mumbai on 20 Nov" },
      lastSearch: { active: "flight", flight: { at: Date.now(), rows: { flights: [{ ResultIndex: "FAKE" }] } } },
    };
    const r = await request(app).post("/").send({ prompt: "Bengaluru", context: client, conversationId: "conv-2" });
    expect(H.searchFlights.mock.calls.at(-1)?.[0]).toMatchObject({ origin: "BLR", destination: "BOM", departDate: "2026-11-20" });
    expect(JSON.stringify(H.store.get("conv-2")?.context.lastSearch.flight.rows)).not.toMatch(/FAKE/);
    expect(r.body.context.id).toBe("conv-2");
  });
});
