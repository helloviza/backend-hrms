// Route-level coverage for routes/admin.visa.ts — the concierge console
// API. Same in-memory-collection mocking approach as
// visa.submit.test.ts/visa.requests.test.ts (mongodb-memory-server can't
// start in this environment): every model this router touches is backed by
// a small generic store with real find/findById/findOneAndUpdate semantics,
// so the state machine, the paired action_required fields, and the cost
// variance gate are actually exercised, not just asserted against a
// hand-picked fixture.
//
// requirePermission itself is NOT mocked — these tests exist specifically
// to prove the READ/WRITE/FULL gate is real, so the actual middleware runs
// against a controllable fake UserPermission record per test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

// Everything a vi.mock factory below needs to close over MUST be built
// inside vi.hoisted — vi.mock calls (and, transitively, the imports at the
// bottom of this file that trigger them) are hoisted above ordinary
// top-level `const`s, so a plain `const _applications = makeCollection()`
// written after these vi.mock calls would still be undefined/TDZ by the
// time a factory runs. Same structure as visa.submit.test.ts's own
// makeCollection/matches setup, just with five collections instead of two.
const {
  _applications,
  _users,
  _requests,
  _travellers,
  _workspaces,
  _documents,
  chainableArray,
  chainableOne,
  findByIdApplication,
  recomputeRequestStatusMock,
  setActionRequiredMock,
  clearActionRequiredMock,
  createVisaDocumentUploadMock,
  presignGetObjectMock,
  syncVisaApplicationBillingMock,
  createVisaWorkStartBookingMock,
} = vi.hoisted(() => {
  function matchValue(val: any, cond: any): boolean {
    if (cond && typeof cond === "object" && !(cond instanceof Date) && cond.constructor?.name !== "ObjectId") {
      if ("$ne" in cond) return String(val) !== String(cond.$ne);
      if ("$in" in cond) return (cond.$in as any[]).map(String).includes(String(val));
    }
    // Real Mongo semantics: querying a field against literal null matches
    // BOTH an explicit null and a missing/undefined field — not just a
    // literal stored null. Needed for the assignment "unassigned" queue
    // filter, which queries assignedConciergeUserId/assignedScreeningOfficerId
    // against null and must also match applications that never had the
    // field set at all.
    if (cond === null) return val === null || val === undefined;
    return String(val) === String(cond);
  }

  function matches(rec: Record<string, any>, filter: Record<string, any>): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      if (key === "$and") return (cond as any[]).every((sub) => matches(rec, sub));
      return matchValue(rec[key], cond);
    });
  }

  function makeCollection() {
    const store = new Map<string, Record<string, any>>();
    return {
      store,
      insert(doc: Record<string, any>): Record<string, any> {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const rec = { ...doc, _id: id };
        store.set(String(id), rec);
        return rec;
      },
      get(id: any) {
        return store.get(String(id)) ?? null;
      },
      query(filter: Record<string, any> = {}) {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      clear() {
        store.clear();
      },
    };
  }

  // select/sort/limit are no-ops on these fakes (fixtures only ever carry
  // the fields a test needs) — only .lean() actually resolves.
  function chainableArray(getResult: () => any[]) {
    const obj: any = {
      select: () => obj,
      sort: () => obj,
      limit: () => obj,
      lean: () => Promise.resolve(getResult()),
    };
    return obj;
  }

  function chainableOne(getResult: () => any) {
    const obj: any = {
      select: () => obj,
      lean: () => Promise.resolve(getResult()),
    };
    return obj;
  }

  const _applications = makeCollection();
  const _users = makeCollection();

  // Wraps an application record with .save()/.toObject() — used only for
  // VisaApplication.findById, the one model this router mutates in place.
  function wrapApplicationDoc(rec: Record<string, any> | null) {
    if (!rec) return null;
    const doc: any = { ...rec };
    Object.defineProperty(doc, "save", {
      enumerable: false,
      value: async () => {
        Object.assign(rec, doc);
        return doc;
      },
    });
    Object.defineProperty(doc, "toObject", {
      enumerable: false,
      value: () => {
        const { save: _s, toObject: _t, ...plain } = doc;
        return { ...plain };
      },
    });
    return doc;
  }

  function findByIdApplication(id: any) {
    const rec = _applications.get(id);
    const p: any = Promise.resolve(wrapApplicationDoc(rec));
    p.lean = () => Promise.resolve(rec ? { ...rec } : null);
    return p;
  }

  return {
    _applications,
    _users,
    _requests: makeCollection(),
    _travellers: makeCollection(),
    _workspaces: makeCollection(),
    _documents: makeCollection(),
    chainableArray,
    chainableOne,
    findByIdApplication,
    recomputeRequestStatusMock: vi.fn().mockResolvedValue("active"),
    setActionRequiredMock: vi.fn(),
    clearActionRequiredMock: vi.fn(),
    createVisaDocumentUploadMock: vi.fn(),
    presignGetObjectMock: vi.fn().mockResolvedValue("https://example.com/presigned-url"),
    // Phase 8 — this file tests the outcome route's own state-machine/upload
    // behavior, not the billing sync (that's services/visaBillingSync.test.ts's
    // job). Stubbed to a resolved no-op so the route's real
    // syncVisaApplicationBilling call never reaches the real, unmocked
    // ManualBooking/VisaRequest/TravellerProfile/CustomerWorkspace models.
    syncVisaApplicationBillingMock: vi.fn().mockResolvedValue({ action: "created", manualBookingId: "stub-booking-id" }),
    // Phase 9e — same reasoning: this file tests the status-transition
    // route's own state machine, not work-start billing (that's services/
    // visaBillingSync.test.ts's job again).
    createVisaWorkStartBookingMock: vi.fn().mockResolvedValue({ action: "created", manualBookingId: "stub-work-start-booking-id" }),
  };
});

vi.mock("../models/VisaApplication.js", async () => {
  const actual: any = await vi.importActual("../models/VisaApplication.js");
  return {
    VISA_APPLICATION_STATUSES: actual.VISA_APPLICATION_STATUSES,
    VISA_APPLICATION_OUTCOMES: actual.VISA_APPLICATION_OUTCOMES,
    default: {
      find: (filter: any) => chainableArray(() => _applications.query(filter)),
      findById: (id: any) => findByIdApplication(id),
      findOneAndUpdate: async (filter: any, update: any) => {
        const rec = _applications.query(filter)[0];
        if (!rec) return null;
        Object.assign(rec, update.$set || {});
        return { ...rec };
      },
      findByIdAndUpdate: (id: any, update: any) =>
        chainableOne(() => {
          const rec = _applications.get(id);
          if (!rec) return null;
          if (update.$set) Object.assign(rec, update.$set);
          if (update.$unset) for (const key of Object.keys(update.$unset)) delete rec[key];
          return { ...rec };
        }),
      updateOne: async (filter: any, update: any) => {
        const rec = _applications.query(filter)[0];
        if (rec) Object.assign(rec, update.$set || {});
        return { acknowledged: true, matchedCount: rec ? 1 : 0 };
      },
      updateMany: async (filter: any, update: any) => {
        const recs = _applications.query(filter);
        for (const rec of recs) {
          if (update.$set) Object.assign(rec, update.$set);
          if (update.$unset) for (const key of Object.keys(update.$unset)) delete rec[key];
        }
        return { acknowledged: true, matchedCount: recs.length, modifiedCount: recs.length };
      },
    },
    // Mirrors the real models/VisaApplication.ts behavior (unit-tested
    // directly in models/VisaApplication.test.ts) closely enough for this
    // file's route-level tests to exercise the full round trip: capture on
    // set (never re-capturing "action_required" itself over an existing
    // capture), restore + null all four fields on clear.
    setActionRequired: async (id: any, reason: string, userId: any) => {
      setActionRequiredMock(id, reason, userId);
      const rec = _applications.get(id);
      if (!rec) return null;
      if (!reason?.trim()) throw new Error("setActionRequired requires a non-empty reason");
      const statusBeforeActionRequired =
        rec.status === "action_required" ? (rec.statusBeforeActionRequired ?? null) : rec.status;
      Object.assign(rec, {
        status: "action_required",
        actionRequiredReason: reason.trim(),
        actionRequiredSetAt: new Date(),
        actionRequiredSetByUserId: userId,
        statusBeforeActionRequired,
      });
      return { ...rec };
    },
    clearActionRequired: async (id: any) => {
      clearActionRequiredMock(id);
      const rec = _applications.get(id);
      if (!rec) return null;
      const restoredStatus = rec.statusBeforeActionRequired || "submitted";
      Object.assign(rec, {
        status: restoredStatus,
        actionRequiredReason: null,
        actionRequiredSetAt: null,
        actionRequiredSetByUserId: null,
        statusBeforeActionRequired: null,
      });
      return { ...rec };
    },
  };
});

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => _requests.query(filter)),
    findById: (id: any) => chainableOne(() => _requests.get(id)),
    findByIdAndUpdate: async (id: any, update: any) => {
      const rec = _requests.get(id);
      if (!rec) return null;
      Object.assign(rec, update.$set || {});
      return { ...rec };
    },
  },
  recomputeRequestStatus: (...args: any[]) => recomputeRequestStatusMock(...args),
}));

vi.mock("../models/User.js", () => ({
  default: {
    findOne: (filter: any) => chainableOne(() => _users.query(filter)[0] ?? null),
    findById: (id: any) => chainableOne(() => _users.get(id)),
    find: (filter: any) => chainableArray(() => _users.query(filter)),
  },
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => _travellers.query(filter)),
    findById: (id: any) => chainableOne(() => _travellers.get(id)),
  },
}));

vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => _workspaces.query(filter)),
    findById: (id: any) => chainableOne(() => _workspaces.get(id)),
  },
}));

vi.mock("../models/VisaDocument.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => _documents.query(filter)),
    findOne: (filter: any) => chainableOne(() => _documents.query(filter)[0] ?? null),
    findOneAndUpdate: async (filter: any, update: any) => {
      const rec = _documents.query(filter)[0];
      if (!rec) return null;
      if (update.$set) Object.assign(rec, update.$set);
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete rec[key];
      return { ...rec };
    },
  },
}));

// Every mutating route in this file now logs a VisaActivityLog row —
// mocked to a no-op create plus an empty paginated read, so tests never
// touch the real (unconnected, in this test environment) collection. This
// file's own coverage is the state machine/permission gate, not the
// activity trail — see routes/visa.activity.test.ts for that.
vi.mock("../models/VisaActivityLog.js", () => ({
  logVisaActivity: vi.fn().mockResolvedValue(undefined),
  default: {
    find: () => ({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }),
    }),
    countDocuments: async () => 0,
  },
}));

// Same fake as visa.documents.test.ts's own presignGetObject mock — no real
// AWS SDK call, just proof this route calls it with the right key/filename.
vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: (...args: any[]) => presignGetObjectMock(...args),
}));

// The multer/S3 mechanics are routes/visa.ts's own well-tested surface
// (visa.documents.test.ts) — this file only needs to prove admin.visa.ts
// calls that shared path with the right arguments, not re-verify multer or
// S3 itself.
vi.mock("./visa.js", () => ({
  visaDocumentUploadMw: (_req: any, _res: any, next: any) => next(),
  createVisaDocumentUpload: (...args: any[]) => createVisaDocumentUploadMock(...args),
}));

vi.mock("../services/visaBillingSync.js", () => ({
  syncVisaApplicationBilling: (...args: any[]) => syncVisaApplicationBillingMock(...args),
  createVisaWorkStartBooking: (...args: any[]) => createVisaWorkStartBookingMock(...args),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

// permissionRecord: the CALLING user's own permission — what requirePermission
// itself checks (via setAccess(), keyed implicitly to USER_ID/makeApp()).
// _userPermissions: a small fake collection of OTHER users' grants — what
// admin.visa.ts's own assignment-validation code and GET /assignable-users
// look up for a TARGET user (grantVisaPermission()). Two different concerns
// sharing one mocked model, distinguished below by whether filter.userId is
// the caller's own id.
let permissionRecord: any = null;
const _userPermissions: any[] = [];

function permPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function matchesPermFilter(rec: any, filter: any): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const val = permPath(rec, key);
    if (cond && typeof cond === "object" && cond !== null) {
      if ("$in" in cond) return (cond.$in as any[]).map(String).includes(String(val));
      if ("$ne" in cond) return String(val) !== String(cond.$ne);
    }
    return String(val) === String(cond);
  });
}
function grantVisaPermission(userId: any, access: "READ" | "WRITE" | "FULL", opts: { level?: string; status?: string } = {}) {
  _userPermissions.push({
    userId: String(userId),
    modules: { visaApplication: { access, scope: "ALL" } },
    level: { code: opts.level ?? "L4" },
    status: opts.status ?? "active",
  });
}

vi.mock("../models/UserPermission.js", () => ({
  UserPermission: {
    findOne: (filter: any) =>
      chainableOne(() => {
        const uid = String(filter?.userId ?? "");
        if (uid === String(USER_ID)) return permissionRecord;
        return _userPermissions.find((r) => matchesPermFilter(r, filter)) ?? null;
      }),
    find: (filter: any) => chainableArray(() => _userPermissions.filter((r) => matchesPermFilter(r, filter))),
  },
  hasAccess: (actual: string, required: string) => {
    const order = ["NONE", "READ", "WRITE", "FULL"];
    return order.indexOf(actual) >= order.indexOf(required);
  },
}));

import express from "express";
import request from "supertest";
import router from "./admin.visa.js";

const WORKSPACE_A = new mongoose.Types.ObjectId();
const WORKSPACE_B = new mongoose.Types.ObjectId();
const USER_ID = new mongoose.Types.ObjectId();

function setAccess(access: "NONE" | "READ" | "WRITE" | "FULL" | null) {
  permissionRecord =
    access == null ? null : { modules: { visaApplication: { access, scope: "ALL" } }, level: { code: "L5" } };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(USER_ID), roles: ["OPS"], email: "concierge@plumtrips.com" };
    // Lets one test simulate an attached file without real multer/multipart
    // plumbing — visaDocumentUploadMw itself is mocked to a no-op above.
    if (req.headers["x-test-attach-file"]) {
      req.file = { buffer: Buffer.from("fake-scan"), mimetype: "application/pdf", originalname: "visa.pdf", size: 9 };
    }
    next();
  });
  app.use("/", router);
  return app;
}

let seq = 0;
function applicationDoc(workspaceId: mongoose.Types.ObjectId, overrides: Record<string, any> = {}) {
  seq += 1;
  const requestId = overrides.requestId ?? _requests.insert({ workspaceId, referenceNumber: `HV26-00000${seq}` })._id;
  return _applications.insert({
    workspaceId,
    requestId,
    travellerProfileId: new mongoose.Types.ObjectId(),
    status: "submitted",
    outcome: undefined,
    nationality: "IN",
    nationalityUnresolved: false,
    ruleSnapshot: { destinationName: "France", purpose: "TOURIST", serviceTier: "STANDARD", documentRequirements: [] },
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 5000 },
    actionRequiredReason: null,
    actionRequiredSetAt: null,
    actionRequiredSetByUserId: null,
    linkedBookings: [],
    ...overrides,
  });
}

beforeEach(() => {
  _applications.clear();
  _requests.clear();
  _travellers.clear();
  _workspaces.clear();
  _documents.clear();
  _users.clear();
  _userPermissions.length = 0;
  recomputeRequestStatusMock.mockClear();
  setActionRequiredMock.mockClear();
  clearActionRequiredMock.mockClear();
  createVisaDocumentUploadMock.mockReset();
  presignGetObjectMock.mockClear();
  presignGetObjectMock.mockResolvedValue("https://example.com/presigned-url");
  syncVisaApplicationBillingMock.mockClear();
  syncVisaApplicationBillingMock.mockResolvedValue({ action: "created", manualBookingId: "stub-booking-id" });
  createVisaWorkStartBookingMock.mockClear();
  createVisaWorkStartBookingMock.mockResolvedValue({ action: "created", manualBookingId: "stub-work-start-booking-id" });
  seq = 0;
  setAccess("FULL");
});

describe("permission gate", () => {
  const ROUTES: Array<{ method: "get" | "patch" | "post"; path: () => string; body?: any }> = [
    { method: "get", path: () => "/queue" },
    { method: "get", path: () => `/applications/${new mongoose.Types.ObjectId()}` },
    { method: "get", path: () => `/documents/${new mongoose.Types.ObjectId()}/url` },
    { method: "patch", path: () => `/applications/${new mongoose.Types.ObjectId()}/status`, body: { status: "docs_under_review" } },
    { method: "patch", path: () => `/documents/${new mongoose.Types.ObjectId()}/review`, body: { reviewStatus: "VERIFIED" } },
    { method: "patch", path: () => `/applications/${new mongoose.Types.ObjectId()}/costs`, body: {} },
    { method: "patch", path: () => `/applications/${new mongoose.Types.ObjectId()}/outcome`, body: {} },
    { method: "patch", path: () => `/applications/${new mongoose.Types.ObjectId()}/assignment`, body: {} },
    { method: "post", path: () => "/applications/bulk-assign", body: {} },
    { method: "get", path: () => "/assignable-users" },
  ];

  it("403s on every route when the caller has no visaApplication permission record at all", async () => {
    setAccess(null);
    const app = makeApp();
    for (const r of ROUTES) {
      const res = await request(app)[r.method](r.path()).send(r.body || {});
      expect(res.status).toBe(403);
    }
  });

  it("403s on every route when the caller's access is explicitly NONE", async () => {
    setAccess("NONE");
    const app = makeApp();
    for (const r of ROUTES) {
      const res = await request(app)[r.method](r.path()).send(r.body || {});
      expect(res.status).toBe(403);
    }
  });

  it("READ can view the queue and detail but cannot write", async () => {
    setAccess("READ");
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A);

    expect((await request(app).get("/queue")).status).toBe(200);
    expect((await request(app).get(`/applications/${a._id}`)).status).toBe(200);

    expect((await request(app).patch(`/applications/${a._id}/status`).send({ status: "docs_under_review" })).status).toBe(403);
    expect((await request(app).patch(`/applications/${a._id}/costs`).send({})).status).toBe(403);
    expect((await request(app).patch(`/applications/${a._id}/outcome`).send({})).status).toBe(403);
    expect((await request(app).patch(`/applications/${a._id}/assignment`).send({ assignedConciergeUserId: null })).status).toBe(403);
    expect((await request(app).post("/applications/bulk-assign").send({ applicationIds: [String(a._id)] })).status).toBe(403);
  });

  it("WRITE can work applications (status/action_required) but cannot set costs or outcome", async () => {
    setAccess("WRITE");
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "submitted" });

    const statusRes = await request(app).patch(`/applications/${a._id}/status`).send({ status: "docs_under_review" });
    expect(statusRes.status).toBe(200);

    expect((await request(app).patch(`/applications/${a._id}/costs`).send({ actualEmbassyFeeInr: 100, actualVfsFeeInr: 100, actualPlumtripsServiceFeeInr: 100 })).status).toBe(403);
    expect((await request(app).patch(`/applications/${a._id}/outcome`).send({ outcome: "WITHDRAWN" })).status).toBe(403);
  });

  it("FULL can set costs and record an outcome", async () => {
    setAccess("FULL");
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "lodged" });

    const costsRes = await request(app)
      .patch(`/applications/${a._id}/costs`)
      .send({ actualEmbassyFeeInr: 2000, actualVfsFeeInr: 2000, actualPlumtripsServiceFeeInr: 500 }); // total 4500, variance 500 — under both thresholds
    expect(costsRes.status).toBe(200);

    const outcomeRes = await request(app).patch(`/applications/${a._id}/outcome`).send({ outcome: "WITHDRAWN" });
    expect(outcomeRes.status).toBe(200);
  });
});

describe("GET /applications/:id — detail", () => {
  it("assignedConcierge/assignedScreeningOfficer are null when the application has neither assigned", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A);

    const res = await request(app).get(`/applications/${a._id}`);
    expect(res.status).toBe(200);
    expect(res.body.assignedConcierge).toBeNull();
    expect(res.body.assignedScreeningOfficer).toBeNull();
  });

  it("resolves both assignees' names/emails from the application's own assignment fields", async () => {
    const app = makeApp();
    const concierge = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });
    const officer = _users.insert({ name: "Ravi Kumar", email: "ravi@plumtrips.com" });
    const a = applicationDoc(WORKSPACE_A, {
      assignedConciergeUserId: concierge._id,
      assignedScreeningOfficerId: officer._id,
    });

    const res = await request(app).get(`/applications/${a._id}`);
    expect(res.status).toBe(200);
    expect(res.body.assignedConcierge).toEqual({ id: String(concierge._id), name: "Asha Rao", email: "asha@plumtrips.com" });
    expect(res.body.assignedScreeningOfficer).toEqual({ id: String(officer._id), name: "Ravi Kumar", email: "ravi@plumtrips.com" });
  });
});

describe("PATCH /applications/:id/status — state machine", () => {
  beforeEach(() => setAccess("WRITE"));

  it("rejects an illegal skip-ahead transition (submitted -> lodged)", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "submitted" });
    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "lodged" });
    expect(res.status).toBe(400);
    expect(_applications.get(a._id).status).toBe("submitted");
    expect(recomputeRequestStatusMock).not.toHaveBeenCalled();
  });

  it("rejects draft -> anything (draft only ever moves via the customer submit route)", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "draft" });
    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "docs_under_review" });
    expect(res.status).toBe(400);
    expect(_applications.get(a._id).status).toBe("draft");
  });

  it("rejects lodged -> decision_received via this route (only PATCH /outcome may set it)", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "lodged" });
    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "decision_received" });
    expect(res.status).toBe(400);
  });

  it("allows a legal single-step transition and calls recomputeRequestStatus", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "docs_under_review" });
    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "cost_confirmed" });
    expect(res.status).toBe(200);
    expect(_applications.get(a._id).status).toBe("cost_confirmed");
    expect(recomputeRequestStatusMock).toHaveBeenCalledTimes(1);
    expect(String(recomputeRequestStatusMock.mock.calls[0][0])).toBe(String(a.requestId));
  });

  it("Phase 9e: triggers work-start billing on submitted -> docs_under_review, and surfaces it in the response", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "submitted" });
    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "docs_under_review" });

    expect(res.status).toBe(200);
    expect(createVisaWorkStartBookingMock).toHaveBeenCalledTimes(1);
    const [calledApplication, calledActorId] = createVisaWorkStartBookingMock.mock.calls[0];
    expect(String(calledApplication._id)).toBe(String(a._id));
    expect(String(calledActorId)).toBe(String(USER_ID));
    expect(res.body.billing).toEqual({ action: "created", manualBookingId: "stub-work-start-booking-id" });
  });

  it("Phase 9e: never triggers work-start billing on any OTHER transition", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "cost_confirmed" });
    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "lodged" });

    expect(res.status).toBe(200);
    expect(createVisaWorkStartBookingMock).not.toHaveBeenCalled();
    expect(res.body.billing).toBeUndefined();
  });

  it("Phase 9e: a work-start billing failure never fails the status transition itself", async () => {
    createVisaWorkStartBookingMock.mockRejectedValueOnce(new Error("mongo write failed"));
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "submitted" });
    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "docs_under_review" });

    expect(res.status).toBe(200);
    expect(_applications.get(a._id).status).toBe("docs_under_review");
    expect(res.body.billing).toEqual({ error: "mongo write failed" });
  });

  it("stamps lodgedAt on the cost_confirmed -> lodged transition, and never earlier", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "cost_confirmed" });
    expect(_applications.get(a._id).lodgedAt).toBeUndefined();

    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "lodged" });
    expect(res.status).toBe(200);
    expect(_applications.get(a._id).lodgedAt).toBeInstanceOf(Date);
    expect(res.body.application.lodgedAt).toBeTruthy();
  });

  it("does not re-stamp lodgedAt when action_required is cleared back to lodged", async () => {
    const app = makeApp();
    const originalLodgedAt = new Date("2026-08-01T00:00:00.000Z");
    const a = applicationDoc(WORKSPACE_A, {
      status: "action_required",
      lodgedAt: originalLodgedAt,
      actionRequiredReason: "Missing bank stamp",
      actionRequiredSetAt: new Date(),
      actionRequiredSetByUserId: USER_ID,
    });

    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "lodged" });
    expect(res.status).toBe(200);
    expect(_applications.get(a._id).lodgedAt).toEqual(originalLodgedAt);
  });

  it("rejects setting action_required with no reason, and touches nothing", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "submitted" });
    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "action_required" });
    expect(res.status).toBe(400);
    const stored = _applications.get(a._id);
    expect(stored.status).toBe("submitted");
    expect(stored.actionRequiredReason).toBeNull();
    expect(stored.actionRequiredSetAt).toBeNull();
    expect(stored.actionRequiredSetByUserId).toBeNull();
    expect(setActionRequiredMock).not.toHaveBeenCalled();
  });

  it("sets all three action_required fields together, then clears all three together", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "docs_under_review" });

    const setRes = await request(app)
      .patch(`/applications/${a._id}/status`)
      .send({ status: "action_required", reason: "Bank statement needs a bank stamp" });
    expect(setRes.status).toBe(200);

    let stored = _applications.get(a._id);
    expect(stored.status).toBe("action_required");
    expect(stored.actionRequiredReason).toBe("Bank statement needs a bank stamp");
    expect(stored.actionRequiredSetAt).toBeInstanceOf(Date);
    expect(String(stored.actionRequiredSetByUserId)).toBe(String(USER_ID));

    const clearRes = await request(app)
      .patch(`/applications/${a._id}/status`)
      .send({ status: "docs_under_review" });
    expect(clearRes.status).toBe(200);

    stored = _applications.get(a._id);
    expect(stored.status).toBe("docs_under_review");
    expect(stored.actionRequiredReason).toBeNull();
    expect(stored.actionRequiredSetAt).toBeNull();
    expect(stored.actionRequiredSetByUserId).toBeNull();
    expect(stored.statusBeforeActionRequired).toBeNull();
  });

  it("clearing restores the CAPTURED status, not whatever target the caller sends — set from cost_confirmed, clear to cost_confirmed even when a different target is requested", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "cost_confirmed" });

    await request(app)
      .patch(`/applications/${a._id}/status`)
      .send({ status: "action_required", reason: "Awaiting appointment" });
    expect(_applications.get(a._id).statusBeforeActionRequired).toBe("cost_confirmed");

    // Requests a DIFFERENT (but still legal) resumption target — the
    // captured status must win regardless, since target is no longer what
    // gets written (routes/admin.visa.ts's PATCH /applications/:id/status).
    const clearRes = await request(app)
      .patch(`/applications/${a._id}/status`)
      .send({ status: "submitted" });
    expect(clearRes.status).toBe(200);
    expect(_applications.get(a._id).status).toBe("cost_confirmed");
    expect(clearRes.body.application.status).toBe("cost_confirmed");
  });

  it("rejects clearing action_required into a non-resumption target", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, {
      status: "action_required",
      actionRequiredReason: "Awaiting appointment",
      actionRequiredSetAt: new Date(),
      actionRequiredSetByUserId: USER_ID,
    });
    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "closed" });
    expect(res.status).toBe(400);
    expect(_applications.get(a._id).status).toBe("action_required");
  });
});

describe("PATCH /documents/:id/review", () => {
  beforeEach(() => setAccess("WRITE"));

  it("rejects a rejection with no rejectionReason, and leaves the document untouched", async () => {
    const app = makeApp();
    const doc = _documents.insert({ applicationId: new mongoose.Types.ObjectId(), docCode: "DOC-03", reviewStatus: "PENDING", deletedAt: null });
    const res = await request(app).patch(`/documents/${doc._id}/review`).send({ reviewStatus: "REJECTED" });
    expect(res.status).toBe(400);
    const stored = _documents.get(doc._id);
    expect(stored.reviewStatus).toBe("PENDING");
    expect(stored.reviewedBy).toBeUndefined();
  });

  it("accepts a rejection with a reason, recording reviewedBy/reviewedAt/rejectionReason without deleting the document", async () => {
    const app = makeApp();
    const doc = _documents.insert({ applicationId: new mongoose.Types.ObjectId(), docCode: "DOC-03", reviewStatus: "PENDING", deletedAt: null });
    const res = await request(app)
      .patch(`/documents/${doc._id}/review`)
      .send({ reviewStatus: "REJECTED", rejectionReason: "Statement is only 3 months, needs 6" });
    expect(res.status).toBe(200);
    const stored = _documents.get(doc._id);
    expect(stored.reviewStatus).toBe("REJECTED");
    expect(stored.rejectionReason).toBe("Statement is only 3 months, needs 6");
    expect(String(stored.reviewedBy)).toBe(String(USER_ID));
    expect(stored.reviewedAt).toBeInstanceOf(Date);
    // Never deleted — the applicant still needs to see what was rejected.
    expect(_documents.get(doc._id)).not.toBeNull();
  });
});

describe("GET /documents/:id/url", () => {
  beforeEach(() => setAccess("READ"));

  it("signs a URL for an existing document, scoped by _id only (no workspace check)", async () => {
    const app = makeApp();
    const doc = _documents.insert({
      applicationId: new mongoose.Types.ObjectId(),
      docCode: "DOC-03",
      deletedAt: null,
      s3Key: "visa-applications/some-workspace/app/key.pdf",
      originalFilename: "bank-statement.pdf",
      mimeType: "application/pdf",
    });
    const res = await request(app).get(`/documents/${doc._id}/url`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://example.com/presigned-url");
    expect(presignGetObjectMock).toHaveBeenCalledTimes(1);
    expect(presignGetObjectMock.mock.calls[0][0]).toMatchObject({
      key: "visa-applications/some-workspace/app/key.pdf",
      filename: "bank-statement.pdf",
      view: true,
    });
  });

  it("404s for a soft-deleted document", async () => {
    const app = makeApp();
    const doc = _documents.insert({ applicationId: new mongoose.Types.ObjectId(), docCode: "DOC-03", deletedAt: new Date() });
    const res = await request(app).get(`/documents/${doc._id}/url`);
    expect(res.status).toBe(404);
    expect(presignGetObjectMock).not.toHaveBeenCalled();
  });

  it("404s for an unknown document id", async () => {
    const app = makeApp();
    const res = await request(app).get(`/documents/${new mongoose.Types.ObjectId()}/url`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /applications/:id/costs", () => {
  beforeEach(() => setAccess("FULL"));

  it("rejects a variance above the threshold with no reason, and never mutates indicativeCostSnapshot or actual* fields", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 5000 } });
    const res = await request(app)
      .patch(`/applications/${a._id}/costs`)
      .send({ actualEmbassyFeeInr: 6000, actualVfsFeeInr: 3000, actualPlumtripsServiceFeeInr: 1000 }); // total 10000, variance 5000
    expect(res.status).toBe(400);
    expect(res.body.variance.reasonRequired).toBe(true);
    const stored = _applications.get(a._id);
    expect(stored.indicativeCostSnapshot).toEqual({ displayMode: "ITEMISED", totalInr: 5000 });
    expect(stored.actualTotalInr).toBeUndefined();
  });

  it("accepts a variance above the threshold WITH a reason, records actual fees, and never mutates indicativeCostSnapshot", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 5000 } });
    const res = await request(app)
      .patch(`/applications/${a._id}/costs`)
      .send({
        actualEmbassyFeeInr: 6000,
        actualVfsFeeInr: 3000,
        actualPlumtripsServiceFeeInr: 1000,
        reason: "Embassy raised its fee this quarter",
      });
    expect(res.status).toBe(200);
    expect(res.body.variance.amountInr).toBe(5000);
    const stored = _applications.get(a._id);
    expect(stored.actualTotalInr).toBe(10000);
    expect(stored.actualEmbassyFeeInr).toBe(6000);
    // Never touched — it's what the customer saw.
    expect(stored.indicativeCostSnapshot).toEqual({ displayMode: "ITEMISED", totalInr: 5000 });
  });

  it("accepts a variance within the threshold with no reason at all", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 5000 } });
    const res = await request(app)
      .patch(`/applications/${a._id}/costs`)
      .send({ actualEmbassyFeeInr: 2000, actualVfsFeeInr: 2000, actualPlumtripsServiceFeeInr: 500 }); // total 4500, variance 500
    expect(res.status).toBe(200);
    expect(res.body.variance.reasonRequired).toBe(false);
  });

  it("hybrid gate — small-value application: variance caught by percentage but not by the flat floor", async () => {
    const app = makeApp();
    // indicative 354 (catalogue's cheapest corridor): 15% of it is ~53.1, far
    // below the ₹2,000 flat floor — a flat-only gate would let this ₹100
    // (28%) swing through unremarked.
    const a = applicationDoc(WORKSPACE_A, { indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 354 } });
    const res = await request(app)
      .patch(`/applications/${a._id}/costs`)
      .send({ actualEmbassyFeeInr: 200, actualVfsFeeInr: 200, actualPlumtripsServiceFeeInr: 54 }); // total 454, variance 100
    expect(res.status).toBe(400);
    expect(res.body.variance).toMatchObject({ amountInr: 100, floorBreached: false, percentBreached: true, reasonRequired: true });
    const stored = _applications.get(a._id);
    expect(stored.actualTotalInr).toBeUndefined();

    const withReason = await request(app)
      .patch(`/applications/${a._id}/costs`)
      .send({ actualEmbassyFeeInr: 200, actualVfsFeeInr: 200, actualPlumtripsServiceFeeInr: 54, reason: "VFS added a courier surcharge" });
    expect(withReason.status).toBe(200);
    expect(_applications.get(a._id).actualTotalInr).toBe(454);
  });

  it("hybrid gate — large-value application: variance caught by the flat floor but not by percentage", async () => {
    const app = makeApp();
    // indicative 26,689 (catalogue's dearest corridor): 15% of it is ~4,003 —
    // well above the ₹2,000 flat floor — a percentage-only gate would let
    // this ₹3,000 (11.2%) swing through unremarked.
    const a = applicationDoc(WORKSPACE_A, { indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 26689 } });
    const res = await request(app)
      .patch(`/applications/${a._id}/costs`)
      .send({ actualEmbassyFeeInr: 15000, actualVfsFeeInr: 10000, actualPlumtripsServiceFeeInr: 4689 }); // total 29689, variance 3000
    expect(res.status).toBe(400);
    expect(res.body.variance).toMatchObject({ amountInr: 3000, floorBreached: true, percentBreached: false, reasonRequired: true });
    const stored = _applications.get(a._id);
    expect(stored.actualTotalInr).toBeUndefined();

    const withReason = await request(app)
      .patch(`/applications/${a._id}/costs`)
      .send({ actualEmbassyFeeInr: 15000, actualVfsFeeInr: 10000, actualPlumtripsServiceFeeInr: 4689, reason: "Embassy fee hike this quarter" });
    expect(withReason.status).toBe(200);
    expect(_applications.get(a._id).actualTotalInr).toBe(29689);
  });
});

describe("PATCH /applications/:id/outcome", () => {
  beforeEach(() => setAccess("FULL"));

  it("rejects APPROVED/REJECTED unless the application is lodged", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "cost_confirmed" });
    const res = await request(app).patch(`/applications/${a._id}/outcome`).send({ outcome: "APPROVED", visaNumber: "V1", visaIssuedAt: "2026-01-01", visaExpiresAt: "2027-01-01" });
    expect(res.status).toBe(400);
    expect(_applications.get(a._id).status).toBe("cost_confirmed");
  });

  it("allows WITHDRAWN from any pre-decision status", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "action_required" });
    const res = await request(app).patch(`/applications/${a._id}/outcome`).send({ outcome: "WITHDRAWN" });
    expect(res.status).toBe(200);
    expect(_applications.get(a._id).status).toBe("decision_received");
    expect(_applications.get(a._id).outcome).toBe("WITHDRAWN");
  });

  it("requires visaNumber/visaIssuedAt/visaExpiresAt for APPROVED", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "lodged" });
    const res = await request(app).patch(`/applications/${a._id}/outcome`).send({ outcome: "APPROVED" });
    expect(res.status).toBe(400);
  });

  it("records an APPROVED outcome and attaches a scanned visa via the shared upload path", async () => {
    createVisaDocumentUploadMock.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      docCode: "DOC-10",
      version: 1,
      originalFilename: "visa.pdf",
      mimeType: "application/pdf",
      sizeBytes: 9,
      extractionStatus: "PENDING",
      extractedFields: [],
      reviewStatus: "PENDING",
    });
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A, { status: "lodged" });

    const res = await request(app)
      .patch(`/applications/${a._id}/outcome`)
      .set("x-test-attach-file", "1")
      .send({ outcome: "APPROVED", visaNumber: "V123", visaIssuedAt: "2026-01-01", visaExpiresAt: "2027-01-01" });

    expect(res.status).toBe(200);
    expect(_applications.get(a._id).status).toBe("decision_received");
    expect(_applications.get(a._id).visaNumber).toBe("V123");
    expect(createVisaDocumentUploadMock).toHaveBeenCalledTimes(1);
    expect(createVisaDocumentUploadMock.mock.calls[0][0]).toMatchObject({ docCode: "DOC-10" });
    expect(res.body.document).toBeTruthy();
  });
});

describe("GET /queue — cross-workspace", () => {
  beforeEach(() => setAccess("READ"));

  it("returns applications from more than one workspace in a single response", async () => {
    const app = makeApp();
    applicationDoc(WORKSPACE_A, { status: "submitted" });
    applicationDoc(WORKSPACE_B, { status: "docs_under_review" });

    const res = await request(app).get("/queue");
    expect(res.status).toBe(200);
    const workspaceIds = new Set(res.body.applications.map((row: any) => row.workspace.id));
    expect(workspaceIds.has(String(WORKSPACE_A))).toBe(true);
    expect(workspaceIds.has(String(WORKSPACE_B))).toBe(true);
  });

  it("surfaces action_required above everything else regardless of travel date", async () => {
    const app = makeApp();
    const soon = new Date(Date.now() + 1000 * 60 * 60 * 24);
    const far = new Date(Date.now() + 1000 * 60 * 60 * 24 * 300);
    applicationDoc(WORKSPACE_A, { status: "submitted", requestId: _requests.insert({ workspaceId: WORKSPACE_A, travelDateFrom: soon })._id });
    const urgent = applicationDoc(WORKSPACE_B, {
      status: "action_required",
      requestId: _requests.insert({ workspaceId: WORKSPACE_B, travelDateFrom: far })._id,
    });

    const res = await request(app).get("/queue");
    expect(res.status).toBe(200);
    expect(res.body.applications[0].id).toBe(String(urgent._id));
  });

  it("excludes draft applications by default", async () => {
    const app = makeApp();
    applicationDoc(WORKSPACE_A, { status: "draft" });
    const res = await request(app).get("/queue");
    expect(res.body.applications).toHaveLength(0);
  });

  describe("Phase 9f — customer-responded visibility", () => {
    it("returns customerRespondedAt on each row", async () => {
      const app = makeApp();
      const respondedAt = new Date("2026-08-15T10:00:00Z");
      const a = applicationDoc(WORKSPACE_A, { status: "action_required", customerRespondedAt: respondedAt });
      const res = await request(app).get("/queue");
      const row = res.body.applications.find((r: any) => r.id === String(a._id));
      expect(new Date(row.customerRespondedAt).toISOString()).toBe(respondedAt.toISOString());
    });

    it("sorts a responded-but-still-action_required row above an untouched action_required row", async () => {
      const app = makeApp();
      const untouched = applicationDoc(WORKSPACE_A, { status: "action_required", customerRespondedAt: null });
      const responded = applicationDoc(WORKSPACE_B, {
        status: "action_required",
        customerRespondedAt: new Date(),
      });

      const res = await request(app).get("/queue");
      const ids = res.body.applications.map((r: any) => r.id);
      expect(ids.indexOf(String(responded._id))).toBeLessThan(ids.indexOf(String(untouched._id)));
    });

    it("a responded action_required row still sorts above a non-action_required row", async () => {
      const app = makeApp();
      applicationDoc(WORKSPACE_A, { status: "docs_under_review" });
      const responded = applicationDoc(WORKSPACE_B, { status: "action_required", customerRespondedAt: new Date() });

      const res = await request(app).get("/queue");
      expect(res.body.applications[0].id).toBe(String(responded._id));
    });

    it("?customerResponded=true narrows to only responded rows", async () => {
      const app = makeApp();
      applicationDoc(WORKSPACE_A, { status: "action_required", customerRespondedAt: null });
      const responded = applicationDoc(WORKSPACE_B, { status: "action_required", customerRespondedAt: new Date() });

      const res = await request(app).get("/queue").query({ customerResponded: "true" });
      expect(res.body.applications).toHaveLength(1);
      expect(res.body.applications[0].id).toBe(String(responded._id));
    });

    it("?customerResponded=false narrows to only un-responded rows", async () => {
      const app = makeApp();
      const untouched = applicationDoc(WORKSPACE_A, { status: "action_required", customerRespondedAt: null });
      applicationDoc(WORKSPACE_B, { status: "action_required", customerRespondedAt: new Date() });

      const res = await request(app).get("/queue").query({ customerResponded: "false" });
      expect(res.body.applications).toHaveLength(1);
      expect(res.body.applications[0].id).toBe(String(untouched._id));
    });

    it("?customerResponded=true composes with an explicit status filter rather than clobbering it", async () => {
      const app = makeApp();
      const respondedLodged = applicationDoc(WORKSPACE_A, { status: "lodged", customerRespondedAt: new Date() });
      applicationDoc(WORKSPACE_B, { status: "action_required", customerRespondedAt: new Date() });

      const res = await request(app).get("/queue").query({ status: "lodged", customerResponded: "true" });
      expect(res.body.applications).toHaveLength(1);
      expect(res.body.applications[0].id).toBe(String(respondedLodged._id));
    });
  });
});

describe("PATCH /applications/:id/assignment", () => {
  beforeEach(() => setAccess("WRITE"));

  it("404s on a well-formed but nonexistent application id", async () => {
    const app = makeApp();
    const res = await request(app)
      .patch(`/applications/${new mongoose.Types.ObjectId()}/assignment`)
      .send({ assignedConciergeUserId: null });
    expect(res.status).toBe(404);
  });

  it("400s when neither role key is present in the body", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A);
    const res = await request(app).patch(`/applications/${a._id}/assignment`).send({});
    expect(res.status).toBe(400);
  });

  it("assigns both roles in one call, stamping assignedAt/assignedByUserId for each independently", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A);
    const concierge = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });
    const officer = _users.insert({ name: "Ravi Kumar", email: "ravi@plumtrips.com" });
    grantVisaPermission(concierge._id, "WRITE");
    grantVisaPermission(officer._id, "FULL");

    const res = await request(app).patch(`/applications/${a._id}/assignment`).send({
      assignedConciergeUserId: String(concierge._id),
      assignedScreeningOfficerId: String(officer._id),
    });

    expect(res.status).toBe(200);
    expect(res.body.application.assignedConciergeUserId).toBe(String(concierge._id));
    expect(res.body.application.assignedScreeningOfficerId).toBe(String(officer._id));

    const stored = _applications.get(a._id);
    expect(String(stored.assignedConciergeUserId)).toBe(String(concierge._id));
    expect(stored.assignedConciergeAssignedAt).toBeInstanceOf(Date);
    expect(String(stored.assignedConciergeAssignedByUserId)).toBe(String(USER_ID));
    expect(String(stored.assignedScreeningOfficerId)).toBe(String(officer._id));
    expect(stored.assignedScreeningOfficerAssignedAt).toBeInstanceOf(Date);
  });

  it("rejects assigning a user who does not hold visaApplication WRITE — nothing is applied", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A);
    const noAccess = _users.insert({ name: "Priya", email: "priya@plumtrips.com" });
    grantVisaPermission(noAccess._id, "READ"); // READ is not enough to be assigned a case

    const res = await request(app)
      .patch(`/applications/${a._id}/assignment`)
      .send({ assignedConciergeUserId: String(noAccess._id) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not have visaApplication write access/i);
    expect(_applications.get(a._id).assignedConciergeUserId).toBeUndefined();
  });

  it("rejects assigning a user with no visaApplication grant at all", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A);
    const stranger = _users.insert({ name: "Nobody", email: "nobody@plumtrips.com" });

    const res = await request(app)
      .patch(`/applications/${a._id}/assignment`)
      .send({ assignedScreeningOfficerId: String(stranger._id) });

    expect(res.status).toBe(400);
    expect(_applications.get(a._id).assignedScreeningOfficerId).toBeUndefined();
  });

  it("allows assigning a SUPERADMIN even with no explicit UserPermission grant — they bypass the gate by role", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A);
    const admin = _users.insert({ name: "Sam Boss", email: "sam@plumtrips.com", roles: ["SUPERADMIN"] });

    const res = await request(app)
      .patch(`/applications/${a._id}/assignment`)
      .send({ assignedConciergeUserId: String(admin._id) });

    expect(res.status).toBe(200);
    expect(String(_applications.get(a._id).assignedConciergeUserId)).toBe(String(admin._id));
  });

  it("404s when the assignee id doesn't resolve to any user", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A);
    const res = await request(app)
      .patch(`/applications/${a._id}/assignment`)
      .send({ assignedConciergeUserId: String(new mongoose.Types.ObjectId()) });
    expect(res.status).toBe(404);
  });

  it("400s on a malformed assignee id", async () => {
    const app = makeApp();
    const a = applicationDoc(WORKSPACE_A);
    const res = await request(app).patch(`/applications/${a._id}/assignment`).send({ assignedConciergeUserId: "not-an-id" });
    expect(res.status).toBe(400);
  });

  it("clearing one role leaves the other intact", async () => {
    const app = makeApp();
    const concierge = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });
    const officer = _users.insert({ name: "Ravi Kumar", email: "ravi@plumtrips.com" });
    grantVisaPermission(concierge._id, "WRITE");
    grantVisaPermission(officer._id, "WRITE");
    const a = applicationDoc(WORKSPACE_A, {
      assignedConciergeUserId: concierge._id,
      assignedConciergeAssignedAt: new Date("2026-01-01"),
      assignedConciergeAssignedByUserId: USER_ID,
      assignedScreeningOfficerId: officer._id,
      assignedScreeningOfficerAssignedAt: new Date("2026-01-01"),
      assignedScreeningOfficerAssignedByUserId: USER_ID,
    });

    const res = await request(app)
      .patch(`/applications/${a._id}/assignment`)
      .send({ assignedConciergeUserId: null });

    expect(res.status).toBe(200);
    const stored = _applications.get(a._id);
    expect(stored.assignedConciergeUserId).toBeNull();
    expect(stored.assignedConciergeAssignedAt).toBeNull();
    expect(stored.assignedConciergeAssignedByUserId).toBeNull();
    // Untouched — the screening officer role was never in this request's body.
    expect(String(stored.assignedScreeningOfficerId)).toBe(String(officer._id));
    expect(stored.assignedScreeningOfficerAssignedAt).toEqual(new Date("2026-01-01"));
  });
});

describe("POST /applications/bulk-assign", () => {
  beforeEach(() => setAccess("WRITE"));

  it("400s on an empty applicationIds array", async () => {
    const app = makeApp();
    const res = await request(app).post("/applications/bulk-assign").send({ applicationIds: [] });
    expect(res.status).toBe(400);
  });

  it("assigns the same concierge to every application in the batch in one call", async () => {
    const app = makeApp();
    const concierge = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });
    grantVisaPermission(concierge._id, "WRITE");
    const a1 = applicationDoc(WORKSPACE_A);
    const a2 = applicationDoc(WORKSPACE_A);
    const a3 = applicationDoc(WORKSPACE_A);

    const res = await request(app).post("/applications/bulk-assign").send({
      applicationIds: [String(a1._id), String(a2._id), String(a3._id)],
      assignedConciergeUserId: String(concierge._id),
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(3);
    for (const a of [a1, a2, a3]) {
      expect(String(_applications.get(a._id).assignedConciergeUserId)).toBe(String(concierge._id));
    }
  });

  it("is atomic — one nonexistent applicationId means NONE of the batch is touched", async () => {
    const app = makeApp();
    const concierge = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });
    grantVisaPermission(concierge._id, "WRITE");
    const a1 = applicationDoc(WORKSPACE_A);
    const a2 = applicationDoc(WORKSPACE_A);
    const missingId = new mongoose.Types.ObjectId();

    const res = await request(app).post("/applications/bulk-assign").send({
      applicationIds: [String(a1._id), String(a2._id), String(missingId)],
      assignedConciergeUserId: String(concierge._id),
    });

    expect(res.status).toBe(404);
    expect(_applications.get(a1._id).assignedConciergeUserId).toBeUndefined();
    expect(_applications.get(a2._id).assignedConciergeUserId).toBeUndefined();
  });

  it("is atomic — an assignee without permission means NONE of the batch is touched", async () => {
    const app = makeApp();
    const noAccess = _users.insert({ name: "Priya", email: "priya@plumtrips.com" });
    const a1 = applicationDoc(WORKSPACE_A);
    const a2 = applicationDoc(WORKSPACE_A);

    const res = await request(app).post("/applications/bulk-assign").send({
      applicationIds: [String(a1._id), String(a2._id)],
      assignedScreeningOfficerId: String(noAccess._id),
    });

    expect(res.status).toBe(400);
    expect(_applications.get(a1._id).assignedScreeningOfficerId).toBeUndefined();
    expect(_applications.get(a2._id).assignedScreeningOfficerId).toBeUndefined();
  });

  it("clearing a role in bulk leaves the other role intact on every application", async () => {
    const app = makeApp();
    const concierge = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });
    const officer = _users.insert({ name: "Ravi Kumar", email: "ravi@plumtrips.com" });
    const a1 = applicationDoc(WORKSPACE_A, { assignedConciergeUserId: concierge._id, assignedScreeningOfficerId: officer._id });
    const a2 = applicationDoc(WORKSPACE_A, { assignedConciergeUserId: concierge._id, assignedScreeningOfficerId: officer._id });

    const res = await request(app).post("/applications/bulk-assign").send({
      applicationIds: [String(a1._id), String(a2._id)],
      assignedConciergeUserId: null,
    });

    expect(res.status).toBe(200);
    for (const a of [a1, a2]) {
      const stored = _applications.get(a._id);
      expect(stored.assignedConciergeUserId).toBeNull();
      expect(String(stored.assignedScreeningOfficerId)).toBe(String(officer._id));
    }
  });
});

describe("GET /queue — assignment filters", () => {
  beforeEach(() => setAccess("READ"));

  it("?assignedConciergeUserId returns only applications assigned to that concierge", async () => {
    const app = makeApp();
    const concierge = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });
    const other = _users.insert({ name: "Someone Else", email: "else@plumtrips.com" });
    const mine = applicationDoc(WORKSPACE_A, { assignedConciergeUserId: concierge._id });
    applicationDoc(WORKSPACE_A, { assignedConciergeUserId: other._id });
    applicationDoc(WORKSPACE_A);

    const res = await request(app).get(`/queue?assignedConciergeUserId=${concierge._id}`);
    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(1);
    expect(res.body.applications[0].id).toBe(String(mine._id));
    expect(res.body.applications[0].assignedConcierge).toEqual({ id: String(concierge._id), name: "Asha Rao" });
  });

  it("?assignedScreeningOfficerId returns only applications assigned to that officer", async () => {
    const app = makeApp();
    const officer = _users.insert({ name: "Ravi Kumar", email: "ravi@plumtrips.com" });
    const mine = applicationDoc(WORKSPACE_A, { assignedScreeningOfficerId: officer._id });
    applicationDoc(WORKSPACE_A);

    const res = await request(app).get(`/queue?assignedScreeningOfficerId=${officer._id}`);
    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(1);
    expect(res.body.applications[0].id).toBe(String(mine._id));
    expect(res.body.applications[0].assignedScreeningOfficer).toEqual({ id: String(officer._id), name: "Ravi Kumar" });
  });

  it("?unassigned=true returns only applications with neither role set", async () => {
    const app = makeApp();
    const concierge = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });
    const unassigned = applicationDoc(WORKSPACE_A);
    applicationDoc(WORKSPACE_A, { assignedConciergeUserId: concierge._id });

    const res = await request(app).get("/queue?unassigned=true");
    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(1);
    expect(res.body.applications[0].id).toBe(String(unassigned._id));
  });
});

describe("GET /assignable-users", () => {
  beforeEach(() => setAccess("READ"));

  it("returns users with a WRITE or FULL visaApplication grant, with their access level", async () => {
    const app = makeApp();
    const writer = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });
    const lead = _users.insert({ name: "Ravi Kumar", email: "ravi@plumtrips.com" });
    const readOnly = _users.insert({ name: "Priya", email: "priya@plumtrips.com" });
    grantVisaPermission(writer._id, "WRITE", { level: "L3" });
    grantVisaPermission(lead._id, "FULL", { level: "L5" });
    grantVisaPermission(readOnly._id, "READ", { level: "L1" });

    const res = await request(app).get("/assignable-users");
    expect(res.status).toBe(200);
    const ids = res.body.users.map((u: any) => u.id);
    expect(ids).toContain(String(writer._id));
    expect(ids).toContain(String(lead._id));
    expect(ids).not.toContain(String(readOnly._id));

    const writerRow = res.body.users.find((u: any) => u.id === String(writer._id));
    expect(writerRow.access).toBe("WRITE");
    expect(writerRow.level).toBe("L3");
  });

  it("includes SUPERADMINs even without an explicit grant", async () => {
    const app = makeApp();
    const admin = _users.insert({ name: "Sam Boss", email: "sam@plumtrips.com", roles: ["SUPERADMIN"] });

    const res = await request(app).get("/assignable-users");
    expect(res.status).toBe(200);
    const row = res.body.users.find((u: any) => u.id === String(admin._id));
    expect(row).toBeTruthy();
    expect(row.access).toBe("FULL");
  });

  it("excludes a suspended/revoked grant", async () => {
    const app = makeApp();
    const suspended = _users.insert({ name: "Suspended Sam", email: "suspended@plumtrips.com" });
    grantVisaPermission(suspended._id, "WRITE", { status: "suspended" });

    const res = await request(app).get("/assignable-users");
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: any) => u.id)).not.toContain(String(suspended._id));
  });
});
