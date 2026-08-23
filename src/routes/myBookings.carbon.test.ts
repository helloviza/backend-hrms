// Route-level coverage for GET /api/my-bookings/carbon — the customer-facing
// flight-emissions read behind the Flight Emissions card on the Client Portal
// Overview. Proves the two properties the card's correctness rests on:
//
//   1. SCOPE. The $match pins to req.workspace.customerId — the CUSTOMER id
//      space CarbonRecord.workspaceId actually lives in — and NOT to
//      req.workspaceObjectId (a CustomerWorkspace._id, which would match
//      nothing and return a plausible-looking zero). A workspaceId supplied
//      by the caller is not read at all, so it can neither widen nor narrow.
//   2. ORG GATE. A non-org caller (plain traveller/requester) gets
//      { available: false } and NO pipeline is issued — same shape as
//      admin.carbon.test.ts's "a non-admin is refused outright, and nothing
//      is aggregated".
//
// requireAuth / requireWorkspace are NOT part of this router (mounted by
// server.ts) — the test injects req.user / req.workspace directly, same
// approach as myBookings.stats.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const aggregateMock = vi.fn();
const countMock = vi.fn();

vi.mock("../models/CarbonRecord.js", () => ({
  default: { aggregate: (...args: any[]) => aggregateMock(...args) },
}));

vi.mock("../models/ExtractedDocument.js", () => ({
  default: { countDocuments: (...args: any[]) => countMock(...args) },
}));

vi.mock("../models/ManualBooking.js", () => ({
  default: { aggregate: vi.fn().mockResolvedValue([{}]) },
}));

vi.mock("../models/TravelBooking.js", () => ({
  default: { find: () => ({ populate: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }) }) }) }) },
}));

import express from "express";
import request from "supertest";
import router from "./myBookings.js";
import { CARBON_CALCULATION_VERSION } from "../services/carbonEngine.service.js";

// The Customer id — what CarbonRecord.workspaceId holds.
const COMPANY_A_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
// The CustomerWorkspace id for the same tenant — a DIFFERENT collection's id,
// and the value the admin router would have scoped on. It must never appear
// in a pipeline issued by this route.
const COMPANY_A_WORKSPACE_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
// Somebody else's workspace, passed as a query param to prove it is ignored.
const COMPANY_B_ID = "cccccccccccccccccccccccc";

const LEADER = { roles: ["WORKSPACE_LEADER"], email: "leader@company-a.com" };
const REQUESTER = { roles: ["REQUESTER"], email: "traveller@company-a.com" };

function makeApp(user: any, workspace: any = { customerId: COMPANY_A_ID }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspace = workspace;
    // Deliberately set, and deliberately never used by this route.
    req.workspaceObjectId = COMPANY_A_WORKSPACE_ID;
    next();
  });
  app.use("/", router);
  return app;
}

function cannedAgg(overrides: any = {}) {
  return [
    {
      records: 3,
      totalCo2eKg: 1543.218,
      priced: 3,
      high: 0,
      medium: 3,
      insufficient: 0,
      undatedSegments: 0,
      documents: 2,
      ...overrides,
    },
  ];
}

const firstMatch = () => aggregateMock.mock.calls[0][0].find((s: any) => s.$match).$match;

beforeEach(() => {
  aggregateMock.mockReset();
  countMock.mockReset();
  countMock.mockResolvedValue(0);
});

describe("GET /my-bookings/carbon — scope", () => {
  it("matches on the CUSTOMER id from req.workspace.customerId", async () => {
    aggregateMock.mockResolvedValue(cannedAgg());
    await request(makeApp(LEADER)).get("/carbon");

    expect(aggregateMock).toHaveBeenCalledTimes(1);
    const m = firstMatch();
    expect(String(m.workspaceId)).toBe(COMPANY_A_ID);
    expect(m.calculationVersion).toBe(CARBON_CALCULATION_VERSION);
  });

  it("never scopes on req.workspaceObjectId — the CustomerWorkspace id space", async () => {
    aggregateMock.mockResolvedValue(cannedAgg());
    await request(makeApp(LEADER)).get("/carbon");

    // The whole point of not reusing buildCarbonMatch: this id would match
    // nothing in CarbonRecord and return a zero that looks like a real total.
    const serialized = JSON.stringify(aggregateMock.mock.calls[0][0]);
    expect(serialized).not.toContain(COMPANY_A_WORKSPACE_ID);
  });

  it("ignores a caller-supplied workspaceId entirely", async () => {
    aggregateMock.mockResolvedValue(cannedAgg());
    await request(makeApp(LEADER)).get(`/carbon?workspaceId=${COMPANY_B_ID}`);

    expect(String(firstMatch().workspaceId)).toBe(COMPANY_A_ID);
    expect(JSON.stringify(aggregateMock.mock.calls[0][0])).not.toContain(COMPANY_B_ID);
  });

  it("takes no period — the $match carries no date bound at all", async () => {
    aggregateMock.mockResolvedValue(cannedAgg());
    await request(makeApp(LEADER)).get("/carbon?from=2026-01&to=2026-06");

    const m = firstMatch();
    expect(m.travelMonth).toBeUndefined();
    expect(Object.keys(m).sort()).toEqual(["calculationVersion", "workspaceId"]);
  });

  it("scopes the document-grain count to the same customer id", async () => {
    aggregateMock.mockResolvedValue(cannedAgg());
    await request(makeApp(LEADER)).get("/carbon");

    expect(countMock).toHaveBeenCalledTimes(1);
    expect(String(countMock.mock.calls[0][0].workspaceId)).toBe(COMPANY_A_ID);
  });
});

describe("GET /my-bookings/carbon — org gate", () => {
  it("a non-org caller gets available:false, and nothing is aggregated", async () => {
    const res = await request(makeApp(REQUESTER)).get("/carbon");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(aggregateMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("an org caller is served", async () => {
    aggregateMock.mockResolvedValue(cannedAgg());
    const res = await request(makeApp(LEADER)).get("/carbon");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it("no workspace context yields the empty payload, not a wide query", async () => {
    const res = await request(makeApp(LEADER, { customerId: null })).get("/carbon");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.records).toBe(0);
    expect(aggregateMock).not.toHaveBeenCalled();
  });
});

describe("GET /my-bookings/carbon — response shape", () => {
  it("returns counts and the rounded total", async () => {
    aggregateMock.mockResolvedValue(cannedAgg());
    countMock.mockResolvedValue(7);
    const res = await request(makeApp(LEADER)).get("/carbon");

    expect(res.body.totalCo2eKg).toBe(1543.22);
    expect(res.body.records).toBe(3);
    expect(res.body.priced).toBe(3);
    expect(res.body.documents).toBe(2);
    expect(res.body.confidence).toEqual({ high: 0, medium: 3, insufficient: 0 });
    expect(res.body.excluded).toEqual({ undatedSegments: 0, modeNotSupportedDocuments: 7 });
  });

  it("returns NO coveragePct — the card words the counts, it is not handed a percentage", async () => {
    aggregateMock.mockResolvedValue(cannedAgg());
    const res = await request(makeApp(LEADER)).get("/carbon");

    expect(res.body.coveragePct).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("overage");
  });

  it("an empty result set is the zero payload, not a 500", async () => {
    aggregateMock.mockResolvedValue([]);
    const res = await request(makeApp(LEADER)).get("/carbon");

    expect(res.status).toBe(200);
    expect(res.body.records).toBe(0);
    expect(res.body.totalCo2eKg).toBe(0);
  });
});
