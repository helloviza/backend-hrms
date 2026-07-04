// Integration test for /raise-request: the optional tripBundle is persisted on
// the SBTRequest and the booker email gains a trip-summary section, while
// existing single-flight calls (no tripBundle) work unchanged.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
});

const { createMock, findByIdMock, findOneMock, sendMailMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  findByIdMock: vi.fn(),
  findOneMock: vi.fn(),
  sendMailMock: vi.fn(),
}));

vi.mock("../models/SBTRequest.js", () => ({ default: { create: createMock } }));
vi.mock("../models/CustomerWorkspace.js", () => ({ default: { findById: findByIdMock } }));
vi.mock("../models/User.js", () => ({ default: { findOne: findOneMock } }));
vi.mock("../utils/mailer.js", () => ({ sendMail: sendMailMock }));
// requireWorkspace on the route would hit Mongo — bypass it; our stub sets ids.
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

const flightData = {
  ResultIndex: "OB1", TraceId: "T1",
  airline: { name: "IndiGo" }, flightNo: "6E-2582",
  origin: { code: "DEL" }, destination: { code: "BOM" },
  departure: { date: "2026-05-20" }, cabin: "Economy",
  fare: { offered: 4800 },
};

beforeEach(() => {
  createMock.mockReset();
  findByIdMock.mockReset();
  findOneMock.mockReset();
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue(undefined);
  findByIdMock.mockReturnValue(chain({ _id: "ws1", defaultApproverEmails: ["booker@x.com"] }));
  findOneMock
    .mockReturnValueOnce(chain({ _id: "bk1", email: "booker@x.com" })) // approver
    .mockReturnValueOnce(chain({ email: "booker@x.com" })); // booker email
  createMock.mockResolvedValue({ _id: "req1" });
});

describe("/raise-request tripBundle", () => {
  it("persists tripBundle and adds a trip-summary email section", async () => {
    const tripBundle = {
      outboundFlight: flightData,
      inboundFlight: { flightNo: "AI-660", origin: { code: "BOM" }, destination: { code: "DEL" }, fare: { offered: 5200 } },
      policyStatus: "NEEDS_APPROVAL",
      conversationSummary: "Business trip, 3 nights",
    };
    const res = await request(app).post("/raise-request").send({ flightData, tripBundle, conversationId: "c1" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "CONCIERGE",
        conversationId: "c1",
        tripBundle: expect.objectContaining({ policyStatus: "NEEDS_APPROVAL" }),
      }),
    );
    // searchParams shape is untouched (still carries source CONCIERGE).
    expect(createMock.mock.calls[0][0].searchParams).toMatchObject({ source: "CONCIERGE", origin: "DEL" });
    expect(String(sendMailMock.mock.calls[0][0].html)).toContain("Trip summary");
    expect(String(sendMailMock.mock.calls[0][0].html)).toContain("AI-660");
  });

  it("backward compat: no tripBundle → still 201, no trip-summary in email", async () => {
    const res = await request(app).post("/raise-request").send({ flightData });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].tripBundle).toBeUndefined();
    expect(String(sendMailMock.mock.calls[0][0].html)).not.toContain("Trip summary");
  });
});
