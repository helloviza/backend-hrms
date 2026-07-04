// Phase 5 Step 3 — itinerary → /raise-request handoff (full-context submit).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
});

const H = vi.hoisted(() => ({
  reqCreate: vi.fn(),
  reqFindOne: vi.fn(),
  itinFindOne: vi.fn(),
  wsFindById: vi.fn(),
  userFindOne: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock("../models/SBTRequest.js", () => ({ default: { create: H.reqCreate, findOne: H.reqFindOne } }));
vi.mock("../models/Itinerary.js", () => ({ default: { findOne: H.itinFindOne } }));
vi.mock("../models/CustomerWorkspace.js", () => ({ default: { findById: H.wsFindById } }));
vi.mock("../models/User.js", () => ({ default: { findOne: H.userFindOne } }));
vi.mock("../utils/mailer.js", () => ({ sendMail: H.sendMail }));
vi.mock("../middleware/requireWorkspace.js", () => ({ requireWorkspace: (_req: any, _res: any, next: any) => next() }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { _id: "u1", email: "u@x.com", name: "U", customerId: "ws1" };
  req.workspaceObjectId = "ws1";
  next();
});
app.use("/", router);

const chain = (val: any) => ({ lean: () => Promise.resolve(val), select: () => ({ lean: () => Promise.resolve(val) }) });

const items = [
  { kind: "FLIGHT_OUTBOUND", payload: { airline: { name: "IndiGo" }, flightNo: "6E-2582", origin: { code: "DEL" }, destination: { code: "BOM" }, departure: { date: "2026-05-20" }, cabin: "Economy", fare: { offered: 4800 } }, policy: { status: "IN_POLICY", reasons: [] }, priceINR: 4800 },
  { kind: "HOTEL", payload: { HotelName: "The Taj", Address: "Colaba, Mumbai" }, policy: { status: "NEEDS_APPROVAL", reasons: ["star_above_cap"] }, priceINR: 9000 },
];

function itineraryDoc(over: any = {}) {
  return { _id: "itn1", items, policySummary: "NEEDS_APPROVAL", totalPriceINR: 13800, status: "DRAFT", destinationCity: "Mumbai", title: "DEL→BOM", save: vi.fn().mockResolvedValue(undefined), ...over };
}

beforeEach(() => {
  Object.values(H).forEach((m: any) => m.mockReset());
  H.sendMail.mockResolvedValue(undefined);
  H.wsFindById.mockReturnValue(chain({ _id: "ws1", defaultApproverEmails: ["booker@x.com"] }));
  H.userFindOne
    .mockReturnValueOnce(chain({ _id: "bk1", email: "booker@x.com" })) // approver
    .mockReturnValueOnce(chain({ email: "booker@x.com" })); // booker email
  H.reqCreate.mockResolvedValue({ _id: "req1" });
});

describe("/raise-request itinerary submit", () => {
  it("submits the full itinerary → SBTRequest with items, itinerary SUBMITTED + linked", async () => {
    const doc = itineraryDoc();
    H.itinFindOne.mockResolvedValue(doc);
    H.reqFindOne.mockResolvedValue(null); // no existing PENDING → create

    const res = await request(app).post("/raise-request").send({ itineraryId: "itn1", conversationId: "c1" });

    expect(res.status).toBe(201);
    const created = H.reqCreate.mock.calls[0][0];
    expect(created.type).toBe("flight");
    expect(created.tripBundle).toMatchObject({ itineraryId: "itn1", policySummary: "NEEDS_APPROVAL", totalPriceINR: 13800 });
    expect(created.tripBundle.items.length).toBe(2);
    // itinerary linked + SUBMITTED
    expect(doc.status).toBe("SUBMITTED");
    expect(doc.sbtRequestId).toBe("req1");
    expect(doc.save).toHaveBeenCalled();
  });

  it("booker email carries the full trip block (flight + hotel + total)", async () => {
    H.itinFindOne.mockResolvedValue(itineraryDoc());
    H.reqFindOne.mockResolvedValue(null);
    await request(app).post("/raise-request").send({ itineraryId: "itn1" });
    const html = String(H.sendMail.mock.calls[0][0].html);
    expect(html).toContain("Trip summary");
    expect(html).toContain("6E-2582");
    expect(html).toContain("The Taj");
    expect(html).toContain("13,800"); // total, en-IN
  });

  it("resubmit → updates the existing PENDING request, no duplicate created", async () => {
    const doc = itineraryDoc();
    H.itinFindOne.mockResolvedValue(doc);
    const existing = { _id: "req0", save: vi.fn().mockResolvedValue(undefined) };
    H.reqFindOne.mockResolvedValue(existing); // an open PENDING request already links this itinerary

    const res = await request(app).post("/raise-request").send({ itineraryId: "itn1" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.requestId).toBe("req0");
    expect(H.reqCreate).not.toHaveBeenCalled(); // no duplicate
    expect(existing.save).toHaveBeenCalled();
    expect(doc.status).toBe("SUBMITTED");
  });

  it("unknown itineraryId → 404", async () => {
    H.itinFindOne.mockResolvedValue(null);
    const res = await request(app).post("/raise-request").send({ itineraryId: "nope" });
    expect(res.status).toBe(404);
    expect(H.reqCreate).not.toHaveBeenCalled();
  });
});
