// Phase 5 Step 1 — /itinerary endpoints: idempotent DRAFT + workspace-scoped read.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
});

// Import-enabling mocks (router pulls in these at module load; itinerary
// endpoints never call them).
vi.mock("../services/tbo.flight.service.js", () => ({ searchFlights: vi.fn() }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: vi.fn() }));
vi.mock("../services/policyService.js", () => ({ loadWorkspacePolicyRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/routeIntel.provider.js", () => ({ getRouteIntelProvider: () => ({ getRouteInsights: vi.fn() }) }));
vi.mock("../services/fareObservations.js", () => ({ recordFareObservations: () => {} }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: () => Promise.resolve(null) }));
vi.mock("../middleware/requireWorkspace.js", () => ({ requireWorkspace: (_req: any, _res: any, next: any) => next() }));

// In-memory Itinerary model.
const H = vi.hoisted(() => {
  const store: any[] = [];
  let seq = 0;
  const eq = (a: any, b: any) => String(a) === String(b);
  const model = {
    __store: store,
    async findOne(q: any) {
      return store.find((r) => Object.entries(q).every(([k, v]) => eq(r[k], v))) || null;
    },
    async create(data: any) {
      const doc: any = { _id: `itn${++seq}`, ...data, save: async function () { return this; } };
      store.push(doc);
      return doc;
    },
  };
  return { model };
});
vi.mock("../models/Itinerary.js", () => ({ default: H.model }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

let currentWs = "656565656565656565656565";
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { _id: "u1", email: "t@plumtrips.com", name: "T" };
  req.workspaceObjectId = currentWs;
  req.workspaceId = currentWs;
  next();
});
app.use("/", router);

const outbound = (price = 5000, status = "IN_POLICY") => ({ kind: "FLIGHT_OUTBOUND", payload: { flightNo: "AI-101" }, policy: { status, reasons: [] }, priceINR: price });
const hotel = (price = 9000, status = "NEEDS_APPROVAL") => ({ kind: "HOTEL", payload: { HotelName: "Taj" }, policy: { status, reasons: ["star_above_cap"] }, priceINR: price });

beforeEach(() => {
  H.model.__store.length = 0;
  currentWs = "656565656565656565656565";
});

describe("POST /itinerary", () => {
  it("creates a DRAFT and rolls up policy + total", async () => {
    const res = await request(app).post("/itinerary").send({ conversationId: "c1", title: "DEL→BOM", items: [outbound(), hotel()] });
    expect(res.status).toBe(200);
    expect(res.body.itinerary.status).toBe("DRAFT");
    expect(res.body.itinerary.items.map((i: any) => i.kind)).toEqual(["FLIGHT_OUTBOUND", "HOTEL"]);
    expect(res.body.itinerary.totalPriceINR).toBe(14000);
    expect(res.body.itinerary.policySummary).toBe("NEEDS_APPROVAL");
    expect(H.model.__store.length).toBe(1);
  });

  it("is idempotent per conversationId — second call UPDATES the same DRAFT", async () => {
    await request(app).post("/itinerary").send({ conversationId: "c1", items: [outbound()] });
    const res2 = await request(app).post("/itinerary").send({ conversationId: "c1", items: [hotel()] });
    expect(H.model.__store.length).toBe(1); // no duplicate
    expect(res2.body.itinerary.items.map((i: any) => i.kind)).toEqual(["FLIGHT_OUTBOUND", "HOTEL"]);
    expect(res2.body.itinerary.totalPriceINR).toBe(14000);
  });

  it("same-kind add replaces (one outbound)", async () => {
    await request(app).post("/itinerary").send({ conversationId: "c1", items: [outbound(5000, "IN_POLICY")] });
    const res2 = await request(app).post("/itinerary").send({ conversationId: "c1", items: [outbound(7000, "OUT_OF_POLICY")] });
    expect(res2.body.itinerary.items.length).toBe(1);
    expect(res2.body.itinerary.totalPriceINR).toBe(7000);
    expect(res2.body.itinerary.policySummary).toBe("OUT_OF_POLICY");
  });

  it("rejects an invalid item kind with 400", async () => {
    const res = await request(app).post("/itinerary").send({ conversationId: "c1", items: [{ kind: "TRAIN", payload: {}, priceINR: 1 }] });
    expect(res.status).toBe(400);
  });
});

describe("GET /itinerary/:id", () => {
  it("reads within the same workspace", async () => {
    const created = await request(app).post("/itinerary").send({ conversationId: "c1", items: [outbound()] });
    const id = created.body.itinerary._id;
    const res = await request(app).get(`/itinerary/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.itinerary._id).toBe(id);
  });

  it("a wrong-workspace read → 404 (no cross-tenant leak)", async () => {
    const created = await request(app).post("/itinerary").send({ conversationId: "c1", items: [outbound()] });
    const id = created.body.itinerary._id;
    currentWs = "757575757575757575757575"; // different tenant
    const res = await request(app).get(`/itinerary/${id}`);
    expect(res.status).toBe(404);
  });
});
