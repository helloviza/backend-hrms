// Route-level coverage for Phase 9f — routes/admin.visa.dashboard.ts (the
// ops dashboard). Same in-memory-collection approach as the rest of the
// visa test suite (mongodb-memory-server can't start in this environment),
// with a small purpose-built $match/$group aggregation emulator — just
// enough to run the exact pipelines this route issues, not a general Mongo
// emulator.
//
// requirePermission itself is NOT mocked — this file's own coverage
// includes proving READ is sufficient (task brief).
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { _applications, _requests, _activity, _bookings, _workspaces, _travellers, _users, matches, runAggregate } =
  vi.hoisted(() => {
    function getPath(rec: any, path: string): any {
      return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), rec);
    }

    function matchValue(val: any, cond: any): boolean {
      if (cond === null) return val === null || val === undefined;
      if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
        if ("$in" in cond) return (cond.$in as any[]).map(String).includes(String(val));
        if ("$nin" in cond) return !(cond.$nin as any[]).map(String).includes(String(val));
        if ("$ne" in cond) return String(val) !== String((cond as any).$ne);
        if ("$gte" in cond || "$lte" in cond) {
          if (val == null) return false;
          const t = new Date(val).getTime();
          if ("$gte" in cond && !(t >= new Date((cond as any).$gte).getTime())) return false;
          if ("$lte" in cond && !(t <= new Date((cond as any).$lte).getTime())) return false;
          return true;
        }
      }
      return String(val) === String(cond);
    }

    function matches(rec: Record<string, any>, filter: Record<string, any>): boolean {
      return Object.entries(filter || {}).every(([key, cond]) => matchValue(getPath(rec, key), cond));
    }

    function resolveGroupExpr(rec: any, expr: any): any {
      if (typeof expr === "string") return expr.startsWith("$") ? getPath(rec, expr.slice(1)) : expr;
      if (expr && typeof expr === "object" && "$cond" in expr) {
        const [cond, thenV, elseV] = expr.$cond;
        return evalCond(rec, cond) ? thenV : elseV;
      }
      return expr;
    }

    function evalCond(rec: any, cond: any): boolean {
      if (cond && cond.$ne) {
        const [a, b] = cond.$ne;
        const av = typeof a === "string" && a.startsWith("$") ? getPath(rec, a.slice(1)) : a;
        return (av ?? null) !== (b ?? null);
      }
      return false;
    }

    // Supports exactly [{$match}, {$group}] pipelines with a string or
    // object `_id`, and `{$sum: 1}` / `{$sum: "$path"}` accumulators —
    // everything admin.visa.dashboard.ts's own pipelines use, nothing more.
    function runAggregate(records: any[], pipeline: any[]): any[] {
      let rows = [...records];
      for (const stage of pipeline) {
        if (stage.$match) {
          rows = rows.filter((r) => matches(r, stage.$match));
        } else if (stage.$group) {
          const idSpec = stage.$group._id;
          const groups = new Map<string, { _id: any; rows: any[] }>();
          for (const r of rows) {
            let idValue: any;
            if (typeof idSpec === "string") {
              idValue = resolveGroupExpr(r, idSpec);
            } else {
              idValue = {};
              for (const [k, expr] of Object.entries(idSpec)) idValue[k] = resolveGroupExpr(r, expr);
            }
            const idKey = JSON.stringify(idValue);
            if (!groups.has(idKey)) groups.set(idKey, { _id: idValue, rows: [] });
            groups.get(idKey)!.rows.push(r);
          }
          const out: any[] = [];
          for (const g of groups.values()) {
            const result: any = { _id: g._id };
            for (const [field, accExpr] of Object.entries(stage.$group) as [string, any][]) {
              if (field === "_id") continue;
              if (accExpr?.$sum === 1) result[field] = g.rows.length;
              else if (typeof accExpr?.$sum === "string") {
                const path = accExpr.$sum.slice(1);
                result[field] = g.rows.reduce((s, r) => s + (Number(getPath(r, path)) || 0), 0);
              }
            }
            out.push(result);
          }
          rows = out;
        }
      }
      return rows;
    }

    function makeCollection() {
      const store = new Map<string, Record<string, any>>();
      return {
        store,
        insert(doc: Record<string, any>) {
          const id = doc._id ?? new mongoose.Types.ObjectId();
          const rec = { ...doc, _id: id };
          store.set(String(id), rec);
          return rec;
        },
        query(filter: Record<string, any> = {}) {
          return Array.from(store.values()).filter((rec) => matches(rec, filter));
        },
        clear() {
          store.clear();
        },
      };
    }

    return {
      _applications: makeCollection(),
      _requests: makeCollection(),
      _activity: makeCollection(),
      _bookings: makeCollection(),
      _workspaces: makeCollection(),
      _travellers: makeCollection(),
      _users: makeCollection(),
      matches,
      runAggregate,
    };
  });

function chainable(getResult: () => any) {
  const obj: any = { select: () => obj, sort: () => obj, limit: () => obj, lean: () => Promise.resolve(getResult()) };
  return obj;
}

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    find: (filter: any) => chainable(() => _applications.query(filter)),
    countDocuments: async (filter: any) => _applications.query(filter).length,
    aggregate: async (pipeline: any[]) => runAggregate(Array.from(_applications.store.values()), pipeline),
  },
}));

vi.mock("../models/VisaRequest.js", () => ({
  default: { find: (filter: any) => chainable(() => _requests.query(filter)) },
}));

vi.mock("../models/VisaActivityLog.js", () => ({
  default: {
    countDocuments: async (filter: any) => _activity.query(filter).length,
    aggregate: async (pipeline: any[]) => runAggregate(Array.from(_activity.store.values()), pipeline),
  },
}));

vi.mock("../models/ManualBooking.js", () => ({
  default: {
    aggregate: async (pipeline: any[]) => runAggregate(Array.from(_bookings.store.values()), pipeline),
  },
}));

vi.mock("../models/CustomerWorkspace.js", () => ({
  default: { find: (filter: any) => chainable(() => _workspaces.query(filter)) },
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: { find: (filter: any) => chainable(() => _travellers.query(filter)) },
}));

vi.mock("../models/User.js", () => ({
  default: { find: (filter: any) => chainable(() => _users.query(filter)) },
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

let permissionAccess: "NONE" | "READ" | "WRITE" | "FULL" | null = "READ";
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: {
    findOne: () => ({
      lean: () =>
        Promise.resolve(
          permissionAccess == null ? null : { modules: { visaApplication: { access: permissionAccess } }, level: { code: "L4" } },
        ),
    }),
  },
  hasAccess: (actual: string, required: string) => {
    const order = ["NONE", "READ", "WRITE", "FULL"];
    return order.indexOf(actual) >= order.indexOf(required);
  },
}));

import express from "express";
import request from "supertest";
import router from "./admin.visa.dashboard.js";

const WORKSPACE_A = new mongoose.Types.ObjectId();
const WORKSPACE_B = new mongoose.Types.ObjectId();
const CONCIERGE_X = new mongoose.Types.ObjectId();
const OFFICER_Y = new mongoose.Types.ObjectId();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(new mongoose.Types.ObjectId()), roles: ["OPS"] };
    next();
  });
  app.use("/", router);
  return app;
}

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 86400000);
}

function applicationFixture(overrides: Record<string, any> = {}) {
  const requestId = overrides.requestId ?? _requests.insert({ referenceNumber: "HV26-0001" })._id;
  return _applications.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE_A,
    requestId,
    travellerProfileId: new mongoose.Types.ObjectId(),
    status: "submitted",
    outcome: null,
    customerRespondedAt: null,
    assignedConciergeUserId: null,
    assignedScreeningOfficerId: null,
    ruleSnapshot: { destinationName: "Nowhere" },
    ...overrides,
  });
}

beforeEach(() => {
  _applications.clear();
  _requests.clear();
  _activity.clear();
  _bookings.clear();
  _workspaces.clear();
  _travellers.clear();
  _users.clear();
  permissionAccess = "READ";
});

describe("GET /dashboard — queueHealth", () => {
  it("counts by status, splitting action_required into waiting vs responded", async () => {
    applicationFixture({ status: "submitted" });
    applicationFixture({ status: "action_required", customerRespondedAt: null });
    applicationFixture({ status: "action_required", customerRespondedAt: new Date() });
    applicationFixture({ status: "action_required", customerRespondedAt: new Date() });
    applicationFixture({ status: "closed" });

    const res = await request(makeApp()).get("/dashboard");
    expect(res.status).toBe(200);

    const rows = res.body.queueHealth.rows;
    const byKey = Object.fromEntries(rows.map((r: any) => [r.key, r]));

    expect(byKey.submitted.count).toBe(1);
    expect(byKey.action_required_waiting.count).toBe(1);
    expect(byKey.action_required_responded.count).toBe(2);
    expect(byKey.closed.count).toBe(1);
    expect(byKey.draft.count).toBe(0);

    // Every row carries its own drilldown filter.
    expect(byKey.action_required_waiting.filter).toEqual({ actionRequired: "true", customerResponded: "false" });
    expect(byKey.action_required_responded.filter).toEqual({ actionRequired: "true", customerResponded: "true" });
    expect(byKey.submitted.filter).toEqual({ status: "submitted" });
  });

  it("is workspace-agnostic — sums across every workspace, never scoped to one", async () => {
    applicationFixture({ workspaceId: WORKSPACE_A, status: "submitted" });
    applicationFixture({ workspaceId: WORKSPACE_B, status: "submitted" });

    const res = await request(makeApp()).get("/dashboard");
    const byKey = Object.fromEntries(res.body.queueHealth.rows.map((r: any) => [r.key, r]));
    expect(byKey.submitted.count).toBe(2);
  });
});

describe("GET /dashboard — atRisk", () => {
  it("flags an application whose remaining runway no longer fits etaMaxDays, and excludes a safe one", async () => {
    const soonRequest = _requests.insert({ referenceNumber: "HV26-SOON", travelDateFrom: daysFromNow(1) });
    const safeRequest = _requests.insert({ referenceNumber: "HV26-SAFE", travelDateFrom: daysFromNow(400) });

    const atRiskApp = applicationFixture({
      status: "lodged",
      requestId: soonRequest._id,
      ruleSnapshot: { destinationName: "Germany", etaMaxDays: 15, etaBasis: "CALENDAR" },
    });
    applicationFixture({
      status: "docs_under_review",
      requestId: safeRequest._id,
      ruleSnapshot: { destinationName: "UAE", etaMaxDays: 5, etaBasis: "CALENDAR" },
    });

    const res = await request(makeApp()).get("/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.atRisk.count).toBe(1);
    expect(res.body.atRisk.filter).toEqual({ atRisk: "true" });
    expect(res.body.atRisk.topApplications).toHaveLength(1);
    expect(res.body.atRisk.topApplications[0].id).toBe(String(atRiskApp._id));
    expect(res.body.atRisk.topApplications[0].referenceNumber).toBe("HV26-SOON");
  });

  it("respects etaBasis — the same travel date can be safe under CALENDAR but at risk under BUSINESS", async () => {
    // A 10-calendar-day window always contains at least one full weekend,
    // so business-day availability is always < 10 while calendar
    // availability is exactly 10 — deterministic regardless of what day of
    // the week the test happens to run on.
    const req10 = _requests.insert({ referenceNumber: "HV26-10D", travelDateFrom: daysFromNow(10) });
    const calendarApp = applicationFixture({
      status: "lodged",
      requestId: req10._id,
      ruleSnapshot: { destinationName: "X", etaMaxDays: 10, etaBasis: "CALENDAR" },
    });
    const businessApp = applicationFixture({
      status: "lodged",
      requestId: req10._id,
      ruleSnapshot: { destinationName: "X", etaMaxDays: 10, etaBasis: "BUSINESS" },
    });

    const res = await request(makeApp()).get("/dashboard");
    const ids = res.body.atRisk.topApplications.map((a: any) => a.id);
    expect(ids).not.toContain(String(calendarApp._id));
    expect(ids).toContain(String(businessApp._id));
  });

  it("excludes decided and closed applications from the at-risk pool entirely", async () => {
    const soonRequest = _requests.insert({ referenceNumber: "HV26-X", travelDateFrom: daysFromNow(1) });
    applicationFixture({
      status: "decision_received",
      outcome: "APPROVED",
      requestId: soonRequest._id,
      ruleSnapshot: { destinationName: "X", etaMaxDays: 15, etaBasis: "CALENDAR" },
    });
    applicationFixture({
      status: "closed",
      requestId: soonRequest._id,
      ruleSnapshot: { destinationName: "X", etaMaxDays: 15, etaBasis: "CALENDAR" },
    });
    applicationFixture({
      status: "draft",
      requestId: soonRequest._id,
      ruleSnapshot: { destinationName: "X", etaMaxDays: 15, etaBasis: "CALENDAR" },
    });

    const res = await request(makeApp()).get("/dashboard");
    expect(res.body.atRisk.count).toBe(0);
  });

  it("sorts worst (most overrun) first", async () => {
    const mild = _requests.insert({ referenceNumber: "HV26-MILD", travelDateFrom: daysFromNow(10) });
    const severe = _requests.insert({ referenceNumber: "HV26-SEVERE", travelDateFrom: daysFromNow(1) });
    const mildApp = applicationFixture({ status: "lodged", requestId: mild._id, ruleSnapshot: { etaMaxDays: 15, etaBasis: "CALENDAR" } });
    const severeApp = applicationFixture({ status: "lodged", requestId: severe._id, ruleSnapshot: { etaMaxDays: 15, etaBasis: "CALENDAR" } });

    const res = await request(makeApp()).get("/dashboard");
    const ids = res.body.atRisk.topApplications.map((a: any) => a.id);
    expect(ids[0]).toBe(String(severeApp._id));
    expect(ids[1]).toBe(String(mildApp._id));
  });
});

describe("GET /dashboard — workload", () => {
  it("counts open cases per concierge/officer and an unassigned-both count", async () => {
    applicationFixture({ status: "docs_under_review", assignedConciergeUserId: CONCIERGE_X, assignedScreeningOfficerId: OFFICER_Y });
    applicationFixture({ status: "submitted", assignedConciergeUserId: CONCIERGE_X, assignedScreeningOfficerId: null });
    applicationFixture({ status: "cost_confirmed", assignedConciergeUserId: null, assignedScreeningOfficerId: null });
    applicationFixture({ status: "decision_received", outcome: "APPROVED", assignedConciergeUserId: CONCIERGE_X }); // decided -> not "open", excluded

    _users.insert({ _id: CONCIERGE_X, name: "Asha Rao" });
    _users.insert({ _id: OFFICER_Y, name: "Ravi Kumar" });

    const res = await request(makeApp()).get("/dashboard");
    expect(res.status).toBe(200);

    const concierge = res.body.workload.concierges.find((c: any) => c.userId === String(CONCIERGE_X));
    expect(concierge.openCount).toBe(2); // the decided one is excluded
    expect(concierge.name).toBe("Asha Rao");
    expect(concierge.filter).toEqual({ assignedConciergeUserId: String(CONCIERGE_X) });

    const officer = res.body.workload.screeningOfficers.find((o: any) => o.userId === String(OFFICER_Y));
    expect(officer.openCount).toBe(1);

    expect(res.body.workload.unassigned.count).toBe(1);
    expect(res.body.workload.unassigned.filter).toEqual({ unassigned: "true" });
  });

  it("a case with only one role assigned is not counted in the unassigned-both bucket", async () => {
    applicationFixture({ status: "submitted", assignedConciergeUserId: CONCIERGE_X, assignedScreeningOfficerId: null });

    const res = await request(makeApp()).get("/dashboard");
    expect(res.body.workload.unassigned.count).toBe(0);
  });
});

describe("GET /dashboard — throughput and outcomes", () => {
  function activityFixture(overrides: Record<string, any> = {}) {
    return _activity.insert({
      _id: new mongoose.Types.ObjectId(),
      applicationId: new mongoose.Types.ObjectId(),
      requestId: new mongoose.Types.ObjectId(),
      workspaceId: WORKSPACE_A,
      eventType: "SUBMITTED",
      at: new Date(),
      detail: {},
      ...overrides,
    });
  }

  it("counts submitted/lodged/decided within the window, from the activity log", async () => {
    activityFixture({ eventType: "SUBMITTED", at: daysFromNow(-5) });
    activityFixture({ eventType: "SUBMITTED", at: daysFromNow(-5) });
    activityFixture({ eventType: "STATUS_CHANGED", detail: { from: "submitted", to: "docs_under_review" }, at: daysFromNow(-4) });
    activityFixture({ eventType: "STATUS_CHANGED", detail: { from: "cost_confirmed", to: "lodged" }, at: daysFromNow(-3) });
    activityFixture({ eventType: "OUTCOME_RECORDED", detail: { outcome: "APPROVED" }, at: daysFromNow(-2) });
    activityFixture({ eventType: "SUBMITTED", at: daysFromNow(-90) }); // outside the default 30-day window

    const res = await request(makeApp()).get("/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.throughput.submitted).toEqual({ count: 2, filter: { eventType: "SUBMITTED" } });
    expect(res.body.throughput.lodged).toEqual({ count: 1, filter: { eventType: "STATUS_CHANGED", statusTo: "lodged" } });
    expect(res.body.throughput.decided).toEqual({ count: 1, filter: { eventType: "OUTCOME_RECORDED" } });
  });

  it("splits outcomes approved/rejected/withdrawn within the window", async () => {
    activityFixture({ eventType: "OUTCOME_RECORDED", detail: { outcome: "APPROVED" }, at: daysFromNow(-1) });
    activityFixture({ eventType: "OUTCOME_RECORDED", detail: { outcome: "APPROVED" }, at: daysFromNow(-1) });
    activityFixture({ eventType: "OUTCOME_RECORDED", detail: { outcome: "REJECTED" }, at: daysFromNow(-1) });
    activityFixture({ eventType: "OUTCOME_RECORDED", detail: { outcome: "WITHDRAWN" }, at: daysFromNow(-90) }); // outside window

    const res = await request(makeApp()).get("/dashboard");
    expect(res.body.outcomes.approved).toEqual({ count: 2, filter: { eventType: "OUTCOME_RECORDED", outcome: "APPROVED" } });
    expect(res.body.outcomes.rejected).toEqual({ count: 1, filter: { eventType: "OUTCOME_RECORDED", outcome: "REJECTED" } });
    expect(res.body.outcomes.withdrawn).toEqual({ count: 0, filter: { eventType: "OUTCOME_RECORDED", outcome: "WITHDRAWN" } });
  });

  it("respects an explicit ?dateFrom/?dateTo window", async () => {
    activityFixture({ eventType: "SUBMITTED", at: new Date("2026-01-15") });
    activityFixture({ eventType: "SUBMITTED", at: new Date("2026-03-01") }); // outside the explicit window below

    const res = await request(makeApp()).get("/dashboard").query({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(res.body.throughput.submitted.count).toBe(1);
    expect(res.body.window.from).toBe(new Date("2026-01-01").toISOString());
  });
});

describe("GET /dashboard — value", () => {
  it("keeps WIP and CONFIRMED totals separate, never merged", async () => {
    _bookings.insert({ type: "VISA", status: "WIP", pricing: { grandTotal: 5000 } });
    _bookings.insert({ type: "VISA", status: "WIP", pricing: { grandTotal: 3000 } });
    _bookings.insert({ type: "VISA", status: "CONFIRMED", pricing: { grandTotal: 7500 } });
    _bookings.insert({ type: "VISA", status: "INVOICED", pricing: { grandTotal: 99999 } }); // excluded
    _bookings.insert({ type: "FLIGHT", status: "WIP", pricing: { grandTotal: 12345 } }); // excluded — not a visa booking

    const res = await request(makeApp()).get("/dashboard");
    expect(res.body.value.wipTotalInr).toBe(8000);
    expect(res.body.value.confirmedTotalInr).toBe(7500);
    expect(res.body.value.wipFilter).toEqual({ mb_type: "VISA", mb_status: "WIP" });
    expect(res.body.value.confirmedFilter).toEqual({ mb_type: "VISA", mb_status: "CONFIRMED" });
  });
});

describe("GET /dashboard — permission gate", () => {
  it("READ is sufficient", async () => {
    permissionAccess = "READ";
    const res = await request(makeApp()).get("/dashboard");
    expect(res.status).toBe(200);
  });

  it("WRITE/FULL also work — READ is the floor, not a ceiling", async () => {
    for (const access of ["WRITE", "FULL"] as const) {
      permissionAccess = access;
      const res = await request(makeApp()).get("/dashboard");
      expect(res.status).toBe(200);
    }
  });

  it("403s with no permission record or NONE access", async () => {
    for (const access of [null, "NONE"] as const) {
      permissionAccess = access;
      const res = await request(makeApp()).get("/dashboard");
      expect(res.status).toBe(403);
    }
  });
});
