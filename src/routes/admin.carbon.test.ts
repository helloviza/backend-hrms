// Tenancy coverage for the Carbon Ledger aggregations.
//
// Aggregation is where F-01 (docs/audits/vouchers-extract-render-audit.md §7)
// is most dangerous. A `find` with an over-wide filter returns rows a caller
// might notice; a `$group` with an over-wide $match returns a single
// plausible-looking NUMBER with another tenant's emissions folded in, and
// nothing about that number looks wrong.
//
// So these tests assert on THE PIPELINE HANDED TO MONGO — specifically the
// $match stage — not on the totals that come back. A totals-only test passes
// identically whether the SuperAdmin's cross-tenant read was a deliberate `{}`
// or an accidental `{ workspaceId: undefined }` that Mongoose silently
// stripped, which is exactly how this class of bug survives review.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const WS_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const WS_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

/** Every aggregate pipeline handed to CarbonRecord, in order. */
const pipelines: any[][] = [];
const distinctScopes: any[] = [];
/** What the mocked aggregate returns; per-test overridable. */
let aggResult: any[] = [];

vi.mock("../models/CarbonRecord.js", () => ({
  default: {
    aggregate: (p: any[]) => {
      pipelines.push(p);
      return Promise.resolve(aggResult);
    },
    distinct: (_f: string, scope: any) => {
      distinctScopes.push(scope);
      return Promise.resolve([]);
    },
  },
}));

const docCountFilters: any[] = [];
vi.mock("../models/ExtractedDocument.js", () => ({
  default: {
    countDocuments: (f: any) => {
      docCountFilters.push(f);
      return Promise.resolve(7);
    },
  },
}));

vi.mock("../models/Customer.js", () => ({
  default: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

import express from "express";
import request from "supertest";
import router, { carbonScope, buildCarbonMatch } from "./admin.carbon.js";
import { CARBON_CALCULATION_VERSION } from "../services/carbonEngine.service.js";

function appAs(user: any, workspaceObjectId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspaceObjectId = workspaceObjectId;
    next();
  });
  app.use("/api/admin/carbon", router);
  return app;
}

const SUPERADMIN = { _id: "super000000000000000001", roles: ["SUPERADMIN"] };
const TENANT_ADMIN = { _id: "tenant00000000000000001", roles: ["ADMIN"] };
const EMPLOYEE = { _id: "emp00000000000000000001", roles: ["EMPLOYEE"] };

/** The $match of the first pipeline issued during a request. */
const firstMatch = () => pipelines[0].find((s) => s.$match).$match;

beforeEach(() => {
  pipelines.length = 0;
  distinctScopes.length = 0;
  docCountFilters.length = 0;
  aggResult = [];
});

describe("carbon aggregation — access", () => {
  it("a real SuperAdmin's $match has NO workspaceId key at all", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/carbon/overview");
    expect(res.status).toBe(200);

    const m = firstMatch();
    // The whole of F-01: absent BY DECISION, never present-but-undefined.
    expect(Object.prototype.hasOwnProperty.call(m, "workspaceId")).toBe(false);
    expect(m.workspaceId).toBeUndefined();
  });

  it("a tenant admin's $match contains ONLY their own workspace", async () => {
    const res = await request(appAs(TENANT_ADMIN, WS_A)).get("/api/admin/carbon/overview");
    expect(res.status).toBe(200);

    const m = firstMatch();
    expect(Object.prototype.hasOwnProperty.call(m, "workspaceId")).toBe(true);
    expect(String(m.workspaceId)).toBe(WS_A);
    expect(String(m.workspaceId)).not.toBe(WS_B);
  });

  it("a non-admin is refused outright, and nothing is aggregated", async () => {
    const res = await request(appAs(EMPLOYEE, WS_A)).get("/api/admin/carbon/overview");
    expect(res.status).toBe(403);
    expect(pipelines).toHaveLength(0);
  });

  it("every endpoint carries the same scope — none is left unscoped", async () => {
    for (const path of ["overview", "trend", "by-airline", "by-haul-band", "top-routes", "data-quality"]) {
      pipelines.length = 0;
      const res = await request(appAs(TENANT_ADMIN, WS_A)).get(`/api/admin/carbon/${path}`);
      expect(res.status, path).toBe(200);
      // Every pipeline this endpoint issued must be pinned to WS_A.
      for (const p of pipelines) {
        const m = p.find((s: any) => s.$match).$match;
        expect(String(m.workspaceId), `${path} $match`).toBe(WS_A);
      }
    }
  });

  it("the document-grain query in data-quality is scoped too", async () => {
    await request(appAs(TENANT_ADMIN, WS_A)).get("/api/admin/carbon/data-quality");
    expect(docCountFilters).toHaveLength(1);
    expect(String(docCountFilters[0].workspaceId)).toBe(WS_A);
  });

  it("the SuperAdmin document-grain query has no workspace key either", async () => {
    await request(appAs(SUPERADMIN)).get("/api/admin/carbon/data-quality");
    expect(Object.prototype.hasOwnProperty.call(docCountFilters[0], "workspaceId")).toBe(false);
  });

  it("the workspace-options list is scoped by the same branch", async () => {
    await request(appAs(TENANT_ADMIN, WS_A)).get("/api/admin/carbon/workspaces");
    expect(String(distinctScopes[0].workspaceId)).toBe(WS_A);

    distinctScopes.length = 0;
    await request(appAs(SUPERADMIN)).get("/api/admin/carbon/workspaces");
    expect(Object.prototype.hasOwnProperty.call(distinctScopes[0], "workspaceId")).toBe(false);
  });
});

describe("scope layering — layer 2 holds independently of the route guard", () => {
  it("a non-SuperAdmin's scope is their own workspace, never {}", () => {
    expect(carbonScope({ user: TENANT_ADMIN, workspaceObjectId: WS_A })).toEqual({ workspaceId: WS_A });
  });

  it("a real SuperAdmin's scope is an explicit, empty object", () => {
    const s = carbonScope({ user: SUPERADMIN, workspaceObjectId: undefined });
    expect(s).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(s, "workspaceId")).toBe(false);
  });

  it("tenantScope THROWS for a tenant caller with no workspace, rather than widening", () => {
    expect(() => carbonScope({ user: TENANT_ADMIN, workspaceObjectId: undefined }))
      .toThrowError(/workspace context missing/i);
  });

  it("a caller-supplied workspaceId cannot widen a tenant caller's own scope", () => {
    const m = buildCarbonMatch({
      user: TENANT_ADMIN,
      workspaceObjectId: WS_A,
      query: { workspaceId: WS_B },
    });
    expect(String(m.workspaceId)).toBe(WS_A);
    expect(String(m.workspaceId)).not.toBe(WS_B);
  });

  it("a SuperAdmin CAN drill into one workspace", () => {
    const m = buildCarbonMatch({
      user: SUPERADMIN,
      workspaceObjectId: undefined,
      query: { workspaceId: WS_B },
    });
    expect(String(m.workspaceId)).toBe(WS_B);
  });

  it("every $match is pinned to one calculation version", () => {
    const m = buildCarbonMatch({ user: SUPERADMIN, workspaceObjectId: undefined, query: {} });
    expect(m.calculationVersion).toBe(CARBON_CALCULATION_VERSION);
  });

  it("a period filter applies to TRAVEL month, not calculatedAt", () => {
    const m = buildCarbonMatch({
      user: SUPERADMIN, workspaceObjectId: undefined,
      query: { from: "2026-07", to: "2026-09" },
    });
    expect(m.travelMonth).toEqual({ $gte: "2026-07", $lte: "2026-09" });
    expect(m.calculatedAt).toBeUndefined();
    expect(m.createdAt).toBeUndefined();
  });
});

describe("honest denominators", () => {
  it("coverage counts Insufficient rows in the denominator but not in the total", async () => {
    aggResult = [{
      records: 100, totalCo2eKg: 5000, totalDistanceKm: 40000,
      calculated: 90, high: 50, medium: 40, insufficient: 10, undatedRows: 3,
    }];
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/carbon/overview");

    expect(res.body.records).toBe(100);         // includes the 10 refused
    expect(res.body.calculated).toBe(90);
    expect(res.body.totalCo2eKg).toBe(5000);    // the 10 contribute nothing
    expect(res.body.coveragePct).toBe(90);
    expect(res.body.confidence.insufficient).toBe(10);
    expect(res.body.confidence.highPct).toBe(50);
    expect(res.body.undatedRows).toBe(3);
  });

  it("reports zeroes rather than throwing when a workspace has no records", async () => {
    aggResult = [];
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/carbon/overview");
    expect(res.status).toBe(200);
    expect(res.body.records).toBe(0);
    expect(res.body.totalCo2eKg).toBe(0);
    expect(res.body.coveragePct).toBe(0);
  });
});

describe("breakdowns must reconcile to their own total", () => {
  it("an airline with no name becomes Unattributed and is never dropped", async () => {
    aggResult = [
      { _id: "IndiGo", co2eKg: 600, records: 6, calculated: 6, distanceKm: 5000 },
      { _id: "__UNATTRIBUTED__", co2eKg: 400, records: 4, calculated: 4, distanceKm: 3000 },
    ];
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/carbon/by-airline");

    const names = res.body.airlines.map((a: any) => a.airline);
    expect(names).toContain("Unattributed");
    const un = res.body.airlines.find((a: any) => a.unattributed);
    expect(un.co2eKg).toBe(400);

    // Shares must sum to 100 — the point of not dropping the unmatched slice.
    const shareSum = res.body.airlines.reduce((s: number, a: any) => s + a.sharePct, 0);
    expect(shareSum).toBeCloseTo(100, 1);
    const co2Sum = res.body.airlines.reduce((s: number, a: any) => s + a.co2eKg, 0);
    expect(co2Sum).toBe(res.body.totalCo2eKg);
  });

  it("a null haul band is named 'Not determined', not hidden", async () => {
    aggResult = [
      { _id: "International, to/from non-UK", co2eKg: 900, records: 9, distanceKm: 8000 },
      { _id: "__UNRESOLVED__", co2eKg: 0, records: 3, distanceKm: 0 },
    ];
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/carbon/by-haul-band");
    const nd = res.body.bands.find((b: any) => !b.resolved);
    expect(nd.band).toBe("Not determined");
    expect(nd.records).toBe(3);
  });

  it("top-routes only ranks rows that were actually calculated", async () => {
    await request(appAs(SUPERADMIN)).get("/api/admin/carbon/top-routes");
    expect(firstMatch().status).toBe("calculated");
  });

  it("the trend excludes undated rows rather than bucketing them arbitrarily", async () => {
    await request(appAs(SUPERADMIN)).get("/api/admin/carbon/trend");
    expect(firstMatch().travelMonth).toMatchObject({ $ne: null });
  });
});

describe("data quality separates the two grains", () => {
  it("insufficient causes are per segment; mode-not-supported is per document", async () => {
    aggResult = [{ total: 21, blankEndpoints: 12 }];
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/carbon/data-quality");

    expect(res.body.insufficient.total).toBe(21);
    const blank = res.body.insufficient.causes.find((c: any) => c.cause === "blank_origin_destination");
    const unres = res.body.insufficient.causes.find((c: any) => c.cause === "unresolvable_code");
    expect(blank.records).toBe(12);
    expect(unres.records).toBe(9);
    expect(blank.records + unres.records).toBe(res.body.insufficient.total);

    // The document count is reported at its own grain and NOT summed into the above.
    expect(res.body.modeNotSupported.grain).toBe("documents");
    expect(res.body.modeNotSupported.documents).toBe(7);
  });

  it("counts only non-flight documents as mode-not-supported", async () => {
    await request(appAs(SUPERADMIN)).get("/api/admin/carbon/data-quality");
    expect(docCountFilters[0].docType).toEqual({ $ne: "flight" });
    expect(docCountFilters[0].status).toBe("extracted");
  });
});
