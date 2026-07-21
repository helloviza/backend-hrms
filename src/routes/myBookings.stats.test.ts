// Route-level coverage for GET /api/my-bookings/stats — the uncapped
// aggregate that replaces bookingKpis (bookings.length off a 200-row-capped
// fetch) on the customer Overview. Proves:
//   1. the pipeline's $project stage never allowlists a cost/margin/PII
//      field, even as a literal key anywhere in the pipeline sent to Mongo;
//   2. OWN-scope (non-leader) callers get an email-in-passengers $expr gate,
//      ORG-scope callers (leader/approver/staff-admin) don't;
//   3. the response is shaped correctly from a facet result — flightCount/
//      hotelCount pulled from the breakdown, travellerCount from the
//      distinct-passenger facet, compare omitted when not requested.
//
// requireAuth / requireWorkspace are NOT part of this router (mounted by
// server.ts) — the test injects req.user / req.workspace directly, same
// approach as myBookings.manual.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const aggregateMock = vi.fn();
vi.mock("../models/ManualBooking.js", () => ({
  default: { aggregate: (...args: any[]) => aggregateMock(...args) },
}));

vi.mock("../models/TravelBooking.js", () => ({
  default: { find: () => ({ populate: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }) }) }) }) },
}));

import express from "express";
import request from "supertest";
import router from "./myBookings.js";

const COMPANY_A_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const LEADER_EMAIL = "leader@company-a.com";
const REQUESTER_EMAIL = "traveller@company-a.com";

function makeApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspace = { customerId: COMPANY_A_ID };
    next();
  });
  app.use("/", router);
  return app;
}

// Flat sibling branches (primaryTotals/primaryByService/primaryTravellers,
// and compareTotals/compareByService/compareTravellers) — NOT a
// primary:[{totals,byService,travellers}] nested shape. Mongo rejects a
// $facet nested inside another $facet stage, so the route builds these as
// sibling keys at the SAME $facet level and reassembles them afterwards
// (see periodTotalsBranch's doc comment in myBookings.ts).
function canned(overrides: any = {}) {
  return {
    primaryTotals: [{ totalTrips: 200, totalSpend: 5_000_000 }],
    primaryByService: [
      { _id: "FLIGHT", count: 148, spend: 4_000_000 },
      { _id: "HOTEL", count: 42, spend: 900_000 },
      { _id: "VISA", count: 4, spend: 20_000 },
      { _id: "OTHER", count: 6, spend: 80_000 },
    ],
    primaryTravellers: [{ n: 153 }],
    ...overrides,
  };
}

const FORBIDDEN_KEYS = [
  "actualPrice",
  "supplierCost",
  "markupAmount",
  "profitMargin",
  "basePrice",
  "diff",
  "notes",
  "supplierName",
  "supplierPNR",
  "panNo",
  "passportNo",
  "metadata",
];

beforeEach(() => {
  aggregateMock.mockReset();
});

describe("GET /my-bookings/stats — cost/PII safety of the pipeline itself", () => {
  it("never contains a forbidden field key anywhere in the pipeline sent to Mongo", async () => {
    aggregateMock.mockResolvedValue([canned()]);
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    await request(app).get("/stats?from=2026-01-01&to=2026-07-20");

    expect(aggregateMock).toHaveBeenCalledTimes(1);
    const pipeline = aggregateMock.mock.calls[0][0];
    const serialized = JSON.stringify(pipeline);
    for (const key of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(key);
    }
  });

  it("the $project stage allowlists exactly the six customer-safe fields", async () => {
    aggregateMock.mockResolvedValue([canned()]);
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    await request(app).get("/stats?from=2026-01-01&to=2026-07-20");

    const pipeline = aggregateMock.mock.calls[0][0];
    const projectStage = pipeline.find((s: any) => s.$project);
    expect(Object.keys(projectStage.$project).sort()).toEqual(
      ["bookingDate", "passengers.email", "passengers.name", "pricing.grandTotal", "pricing.quotedPrice", "pricing.totalWithGST", "type"].sort(),
    );
  });
});

describe("GET /my-bookings/stats — ORG vs OWN scope", () => {
  it("ORG-scope (WORKSPACE_LEADER) has no email $expr gate — sees the whole tenant", async () => {
    aggregateMock.mockResolvedValue([canned()]);
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    await request(app).get("/stats?from=2026-01-01&to=2026-07-20");

    const pipeline = aggregateMock.mock.calls[0][0];
    const matchStage = pipeline.find((s: any) => s.$match);
    expect(matchStage.$match.$expr).toBeUndefined();
  });

  it("OWN-scope (plain CUSTOMER) gets a case-insensitive email-in-passengers $expr", async () => {
    aggregateMock.mockResolvedValue([canned()]);
    const app = makeApp({ roles: ["CUSTOMER"], email: REQUESTER_EMAIL.toUpperCase() });
    await request(app).get("/stats?from=2026-01-01&to=2026-07-20");

    const pipeline = aggregateMock.mock.calls[0][0];
    const matchStage = pipeline.find((s: any) => s.$match);
    expect(matchStage.$match.$expr.$in[0]).toBe(REQUESTER_EMAIL.toLowerCase());
  });

  it("OWN-scope with no caller email short-circuits without querying Mongo", async () => {
    const app = makeApp({ roles: ["CUSTOMER"], email: "" });
    const res = await request(app).get("/stats?from=2026-01-01&to=2026-07-20");
    expect(res.status).toBe(200);
    expect(res.body.primary.totalTrips).toBe(0);
    expect(aggregateMock).not.toHaveBeenCalled();
  });
});

describe("GET /my-bookings/stats — pipeline shape (regression: Mongo rejects $facet nested in $facet)", () => {
  it("never nests a $facet stage inside another $facet stage's branches", async () => {
    aggregateMock.mockResolvedValue([canned()]);
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    await request(app).get("/stats?from=2026-01-01&to=2026-07-20&compareFrom=2025-01-01&compareTo=2025-07-20");

    const pipeline = aggregateMock.mock.calls[0][0];
    const facetStage = pipeline.find((s: any) => s.$facet);
    expect(facetStage).toBeDefined();
    for (const branch of Object.values(facetStage.$facet) as any[][]) {
      for (const stage of branch) {
        expect(stage.$facet).toBeUndefined();
      }
    }
  });
});

describe("GET /my-bookings/stats — response shaping", () => {
  it("uncapped totals pass through untouched — no 200-row ceiling in the response path", async () => {
    aggregateMock.mockResolvedValue([canned({ primaryTotals: [{ totalTrips: 252, totalSpend: 7_881_790 }], primaryByService: [], primaryTravellers: [{ n: 153 }] })]);
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/stats?from=2026-01-01&to=2026-07-20");

    expect(res.body.primary.totalTrips).toBe(252);
    expect(res.body.primary.totalSpend).toBe(7_881_790);
  });

  it("flightCount/hotelCount are pulled from the breakdown, and all 7 buckets are always present", async () => {
    aggregateMock.mockResolvedValue([canned()]);
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/stats?from=2026-01-01&to=2026-07-20");

    expect(res.body.primary.flightCount).toBe(148);
    expect(res.body.primary.hotelCount).toBe(42);
    expect(res.body.primary.breakdown.map((b: any) => b.service).sort()).toEqual(
      ["FLIGHT", "HOTEL", "VISA", "CAB", "FOREX", "MICE", "OTHER"].sort(),
    );
    // CAB/FOREX/MICE weren't in the canned byService — must default to 0, not be missing.
    expect(res.body.primary.breakdown.find((b: any) => b.service === "CAB")).toEqual({ service: "CAB", count: 0, spend: 0 });
  });

  it("travellerCount comes from the distinct-passenger facet, not totalTrips", async () => {
    aggregateMock.mockResolvedValue([canned()]);
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/stats?from=2026-01-01&to=2026-07-20");
    expect(res.body.primary.travellerCount).toBe(153);
  });

  it("compare is null when compareFrom/compareTo are absent, and no compare facet is requested", async () => {
    aggregateMock.mockResolvedValue([canned()]);
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/stats?from=2026-01-01&to=2026-07-20");

    expect(res.body.compare).toBeNull();
    const pipeline = aggregateMock.mock.calls[0][0];
    const facetStage = pipeline.find((s: any) => s.$facet && s.$facet.primaryTotals);
    expect(facetStage.$facet.compareTotals).toBeUndefined();
  });

  it("compare is populated when compareFrom/compareTo are present", async () => {
    aggregateMock.mockResolvedValue([
      canned({
        compareTotals: [{ totalTrips: 190, totalSpend: 4_500_000 }],
        compareByService: [],
        compareTravellers: [{ n: 140 }],
      }),
    ]);
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get(
      "/stats?from=2026-07-01&to=2026-07-20&compareFrom=2026-06-01&compareTo=2026-06-30",
    );

    expect(res.body.compare).not.toBeNull();
    expect(res.body.compare.totalTrips).toBe(190);
    const pipeline = aggregateMock.mock.calls[0][0];
    const facetStage = pipeline.find((s: any) => s.$facet && s.$facet.primaryTotals);
    expect(facetStage.$facet.compareTotals).toBeDefined();
  });
});
