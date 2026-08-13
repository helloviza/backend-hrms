// Route-level coverage for routes/admin.visa.roster.ts — specifically THE
// APPROVAL GATE (2026-08-10).
//
// The roster is the one ops surface that reads applications with no status
// filter of its own: GET /workspaces/:workspaceId/roster shapes EVERY
// application of every request in a workspace onto a per-traveller view, by
// name. So a case held at the customer's own approval gate would be listed
// there against a named traveller unless it is excluded explicitly — which
// is what this file exists to prove.
//
// Same in-memory-collection mocking approach as the other admin.visa.*
// tests. The permission middleware is stubbed to a pass-through here: this
// file is about the STATUS gate, and the READ-grant gate already has
// dedicated coverage in admin.visa.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { _workspaces, _requests, _applications, _travellers, _departments, resetStores } = vi.hoisted(
  () => {
    type Doc = Record<string, any>;

    function matchValue(val: any, cond: any): boolean {
      if (
        cond &&
        typeof cond === "object" &&
        !(cond instanceof Date) &&
        cond.constructor?.name !== "ObjectId"
      ) {
        if ("$ne" in cond) return String(val) !== String(cond.$ne);
        if ("$in" in cond) return (cond.$in as any[]).map(String).includes(String(val));
        if ("$nin" in cond) return !(cond.$nin as any[]).map(String).includes(String(val));
      }
      if (cond === null) return val === null || val === undefined;
      return String(val) === String(cond);
    }

    function matches(rec: Doc, filter: Doc): boolean {
      return Object.entries(filter).every(([key, cond]) => matchValue(rec[key], cond));
    }

    function makeCollection() {
      const store = new Map<string, Doc>();
      return {
        store,
        insert(doc: Doc): Doc {
          const id = doc._id ?? new mongoose.Types.ObjectId();
          const rec = { ...doc, _id: id };
          store.set(String(id), rec);
          return rec;
        },
        query(filter: Doc = {}): Doc[] {
          return Array.from(store.values()).filter((rec) => matches(rec, filter));
        },
        clear() {
          store.clear();
        },
      };
    }

    const _workspaces = makeCollection();
    const _requests = makeCollection();
    const _applications = makeCollection();
    const _travellers = makeCollection();
    const _departments = makeCollection();

    return {
      _workspaces,
      _requests,
      _applications,
      _travellers,
      _departments,
      resetStores() {
        _workspaces.clear();
        _requests.clear();
        _applications.clear();
        _travellers.clear();
        _departments.clear();
      },
    };
  },
);

function chainable(getResult: () => any) {
  const obj: any = {
    select: () => obj,
    sort: () => obj,
    limit: () => obj,
    lean: () => Promise.resolve(getResult()),
  };
  return obj;
}

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    find: (filter: any) => chainable(() => _workspaces.query(filter)),
    findById: (id: any) => chainable(() => _workspaces.query({ _id: id })[0] ?? null),
  },
}));

vi.mock("../models/VisaRequest.js", () => ({
  default: { find: (filter: any) => chainable(() => _requests.query(filter)) },
}));

vi.mock("../models/VisaApplication.js", () => ({
  default: { find: (filter: any) => chainable(() => _applications.query(filter)) },
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    find: (filter: any) => chainable(() => _travellers.query(filter)),
    // GET /workspaces groups travellers per workspace. Supports exactly the
    // one [{$match},{$group}] shape that route uses, nothing more.
    aggregate: async (pipeline: any[]) => {
      const match = pipeline.find((s) => s.$match)?.$match ?? {};
      const rows = _travellers.query({ isActive: match.isActive });
      const byWs = new Map<string, { _id: any; n: number; expiries: any[] }>();
      for (const r of rows) {
        const key = String(r.workspaceId);
        const entry = byWs.get(key) ?? { _id: r.workspaceId, n: 0, expiries: [] };
        entry.n += 1;
        entry.expiries.push(r.passportExpiry ?? null);
        byWs.set(key, entry);
      }
      return Array.from(byWs.values());
    },
  },
}));

vi.mock("../models/Department.js", () => ({
  default: { find: (filter: any) => chainable(() => _departments.query(filter)) },
}));

import express from "express";
import request from "supertest";
import router from "./admin.visa.roster.js";

const WORKSPACE = new mongoose.Types.ObjectId();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(new mongoose.Types.ObjectId()), roles: ["SUPERADMIN"] };
    next();
  });
  app.use("/", router);
  return app;
}

beforeEach(() => {
  resetStores();
  _workspaces.insert({
    _id: WORKSPACE,
    companyName: "Acme Travel",
    customerId: "CUST-1",
    status: "ACTIVE",
    tenantType: "CUSTOMER",
  });
});

function seedFiling(status: string, referenceNumber: string) {
  const traveller = _travellers.insert({
    workspaceId: WORKSPACE,
    isActive: true,
    firstName: "Anna",
    lastName: "Eriksson",
  });
  const req = _requests.insert({
    workspaceId: WORKSPACE,
    referenceNumber,
    status: "draft",
    destinationIso2: "AE",
    purpose: "TOURIST",
  });
  const application = _applications.insert({
    workspaceId: WORKSPACE,
    requestId: req._id,
    travellerProfileId: traveller._id,
    status,
    ruleSnapshot: { destinationName: "UAE" },
  });
  return { traveller, req, application };
}

describe("GET /workspaces/:workspaceId/roster — the approval gate", () => {
  it("GATE: omits a pending_approval application from the roster entirely", async () => {
    const { application } = seedFiling("pending_approval", "HV26-HELD");

    const res = await request(makeApp()).get(`/workspaces/${WORKSPACE}/roster`);

    expect(res.status).toBe(200);
    const allApplications = res.body.requests.flatMap((r: any) => r.applications);
    expect(allApplications).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(String(application._id));
  });

  it("still lists submitted and draft applications — only the held status is withheld", async () => {
    const { application: submitted } = seedFiling("submitted", "HV26-LIVE");
    const { application: draft } = seedFiling("draft", "HV26-DRAFT");
    seedFiling("pending_approval", "HV26-HELD");

    const res = await request(makeApp()).get(`/workspaces/${WORKSPACE}/roster`);

    expect(res.status).toBe(200);
    const ids = res.body.requests.flatMap((r: any) => r.applications.map((a: any) => a._id));
    expect(ids).toContain(String(submitted._id));
    expect(ids).toContain(String(draft._id));
    expect(ids).toHaveLength(2);
  });
});

describe("GET /workspaces — the overview in-flight count", () => {
  it("GATE: a pending_approval filing is not in flight (IN_FLIGHT_STATUSES is an allow-list)", async () => {
    seedFiling("pending_approval", "HV26-HELD");

    const res = await request(makeApp()).get("/workspaces");

    expect(res.status).toBe(200);
    const row = res.body.workspaces.find((w: any) => w.workspaceId === String(WORKSPACE));
    expect(row.inFlightCount).toBe(0);
  });

  it("counts a genuinely in-flight filing", async () => {
    seedFiling("submitted", "HV26-LIVE");

    const res = await request(makeApp()).get("/workspaces");

    const row = res.body.workspaces.find((w: any) => w.workspaceId === String(WORKSPACE));
    expect(row.inFlightCount).toBe(1);
  });
});
