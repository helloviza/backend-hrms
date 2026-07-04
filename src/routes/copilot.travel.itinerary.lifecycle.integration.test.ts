// Phase 5 smoke — itinerary lifecycle end-to-end through the real concierge
// router: assemble DRAFT (worst-of rollup + total) → idempotent update → submit
// (full items in tripBundle + booker email) → resubmit guard → BOOKED
// propagation → cross-workspace 404. Persistence is a faithful in-memory store.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });

// ── in-memory fakes shared by the router + the propagation helper ──
const H = vi.hoisted(() => {
  const getPath = (o: any, p: string) => p.split(".").reduce((x: any, k) => (x == null ? undefined : x[k]), o);
  const matches = (doc: any, q: any) => Object.entries(q).every(([k, v]) => String(getPath(doc, k)) === String(v));
  function fakeModel() {
    const store: any[] = [];
    let seq = 0;
    return {
      __store: store,
      async findOne(q: any) { return store.find((r) => matches(r, q)) || null; },
      async create(data: any) { const doc: any = { _id: `id${++seq}`, ...data, save: async function () { return this; } }; store.push(doc); return doc; },
      async updateOne(q: any, update: any) { const d = store.find((r) => matches(r, q)); if (d && update.$set) Object.assign(d, update.$set); return { modifiedCount: d ? 1 : 0 }; },
    };
  }
  return { Itinerary: fakeModel(), SBTRequest: fakeModel(), sendMail: vi.fn(), wsFindById: vi.fn(), userFindOne: vi.fn() };
});

vi.mock("../models/Itinerary.js", () => ({ default: H.Itinerary }));
vi.mock("../models/SBTRequest.js", () => ({ default: H.SBTRequest }));
vi.mock("../models/CustomerWorkspace.js", () => ({ default: { findById: H.wsFindById } }));
vi.mock("../models/User.js", () => ({ default: { findOne: H.userFindOne } }));
vi.mock("../utils/mailer.js", () => ({ sendMail: H.sendMail }));
vi.mock("../middleware/requireWorkspace.js", () => ({ requireWorkspace: (_req: any, _res: any, next: any) => next() }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";
import { propagateItineraryBooked } from "../services/itineraryStatus.js";

const WS = "656565656565656565656565";
let currentWs = WS;
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.user = { _id: "u1", email: "u@x.com", name: "U", customerId: "ws1" }; req.workspaceObjectId = currentWs; req.workspaceId = currentWs; next(); });
app.use("/", router);

const chain = (v: any) => ({ lean: () => Promise.resolve(v), select: () => ({ lean: () => Promise.resolve(v) }) });

const outbound = (over: any = {}) => ({ kind: "FLIGHT_OUTBOUND", payload: { airline: { name: "IndiGo" }, flightNo: "6E-2582", origin: { code: "DEL" }, destination: { code: "BOM" }, departure: { date: "2026-05-20" }, cabin: "Economy", fare: { offered: 4800 } }, policy: { status: "OUT_OF_POLICY", reasons: ["price_above_cap"] }, priceINR: 4800, ...over });
const inbound = { kind: "FLIGHT_INBOUND", payload: { airline: { name: "Air India" }, flightNo: "AI-660", origin: { code: "BOM" }, destination: { code: "DEL" }, fare: { offered: 5000 } }, policy: { status: "IN_POLICY", reasons: [] }, priceINR: 5000 };
const hotel = (name: string, price: number, status = "NEEDS_APPROVAL") => ({ kind: "HOTEL", payload: { HotelName: name, Address: "Colaba, Mumbai" }, policy: { status, reasons: status === "IN_POLICY" ? [] : ["star_above_cap"] }, priceINR: price });

beforeEach(() => {
  H.Itinerary.__store.length = 0;
  H.SBTRequest.__store.length = 0;
  H.sendMail.mockReset(); H.sendMail.mockResolvedValue(undefined);
  H.wsFindById.mockReset(); H.wsFindById.mockReturnValue(chain({ _id: "ws1", defaultApproverEmails: ["booker@x.com"] }));
  H.userFindOne.mockReset(); H.userFindOne.mockReturnValue(chain({ _id: "bk1", email: "booker@x.com", name: "Booker" }));
  currentWs = WS;
});

describe("itinerary lifecycle (real router)", () => {
  it("assemble → idempotent update → submit → resubmit guard → BOOKED", async () => {
    // (a) assemble: outbound(OUT) + inbound(IN) + hotel(NEEDS) → worst-of OUT_OF_POLICY
    const c1 = await request(app).post("/itinerary").send({ conversationId: "conv1", title: "DEL↔BOM", items: [outbound(), inbound, hotel("The Taj", 4000)] });
    expect(c1.status).toBe(200);
    const itnId = c1.body.itinerary._id;
    expect(c1.body.itinerary.policySummary).toBe("OUT_OF_POLICY");
    expect(c1.body.itinerary.totalPriceINR).toBe(13800);
    expect(c1.body.itinerary.items.map((i: any) => i.kind)).toEqual(["FLIGHT_OUTBOUND", "FLIGHT_INBOUND", "HOTEL"]);

    // (a) idempotent update: same conversationId, replaced hotel → SAME id, not a 2nd doc
    const c2 = await request(app).post("/itinerary").send({ conversationId: "conv1", items: [hotel("Novotel", 3000, "IN_POLICY")] });
    expect(c2.body.itinerary._id).toBe(itnId);
    expect(H.Itinerary.__store.length).toBe(1);
    expect(c2.body.itinerary.totalPriceINR).toBe(12800); // 4800 + 5000 + 3000
    expect(c2.body.itinerary.items.find((i: any) => i.kind === "HOTEL").payload.HotelName).toBe("Novotel");

    // (b) submit → SBTRequest PENDING with full items + itineraryId; booker email
    const s1 = await request(app).post("/raise-request").send({ itineraryId: itnId, conversationId: "conv1" });
    expect(s1.status).toBe(201);
    expect(H.SBTRequest.__store.length).toBe(1);
    const req1 = H.SBTRequest.__store[0];
    expect(req1.status).toBe("PENDING");
    expect(req1.tripBundle.itineraryId).toBe(itnId);
    expect(req1.tripBundle.items.length).toBe(3);
    const html = String(H.sendMail.mock.calls[0][0].html);
    expect(html).toContain("6E-2582"); // outbound
    expect(html).toContain("AI-660");  // inbound
    expect(html).toContain("Novotel"); // hotel
    expect(html).toContain("12,800");  // total
    expect(html).toContain("OUT_OF_POLICY"); // policy rollup
    // itinerary linked + SUBMITTED
    expect(H.Itinerary.__store[0].status).toBe("SUBMITTED");
    expect(String(H.Itinerary.__store[0].sbtRequestId)).toBe(String(req1._id));

    // (b) resubmit the same DRAFT → SAME request updated, NO duplicate
    const s2 = await request(app).post("/raise-request").send({ itineraryId: itnId });
    expect(s2.status).toBe(200);
    expect(s2.body.updated).toBe(true);
    expect(s2.body.requestId).toBe(String(req1._id));
    expect(H.SBTRequest.__store.length).toBe(1); // still one

    // (b, documented exception) prior request no longer PENDING → NEW request
    req1.status = "BOOKED";
    const s3 = await request(app).post("/raise-request").send({ itineraryId: itnId });
    expect(s3.status).toBe(201);
    expect(H.SBTRequest.__store.length).toBe(2); // a fresh request

    // (c) BOOKED transition → itinerary BOOKED (the exact hook sbt.requests calls)
    await propagateItineraryBooked({ workspaceId: WS, tripBundle: { itineraryId: itnId } });
    expect(H.Itinerary.__store[0].status).toBe("BOOKED");
  });

  it("(d) GET /itinerary/:id from a different workspace → 404", async () => {
    const created = await request(app).post("/itinerary").send({ conversationId: "conv1", items: [outbound()] });
    const id = created.body.itinerary._id;
    // same workspace reads fine
    expect((await request(app).get(`/itinerary/${id}`)).status).toBe(200);
    // different tenant → 404
    currentWs = "757575757575757575757575";
    expect((await request(app).get(`/itinerary/${id}`)).status).toBe(404);
  });
});
