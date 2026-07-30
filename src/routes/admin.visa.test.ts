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
} = vi.hoisted(() => {
  function matchValue(val: any, cond: any): boolean {
    if (cond && typeof cond === "object" && !(cond instanceof Date) && cond.constructor?.name !== "ObjectId") {
      if ("$ne" in cond) return String(val) !== String(cond.$ne);
      if ("$in" in cond) return (cond.$in as any[]).map(String).includes(String(val));
    }
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
      updateOne: async (filter: any, update: any) => {
        const rec = _applications.query(filter)[0];
        if (rec) Object.assign(rec, update.$set || {});
        return { acknowledged: true, matchedCount: rec ? 1 : 0 };
      },
    },
    setActionRequired: async (id: any, reason: string, userId: any) => {
      setActionRequiredMock(id, reason, userId);
      const rec = _applications.get(id);
      if (!rec) return null;
      if (!reason?.trim()) throw new Error("setActionRequired requires a non-empty reason");
      Object.assign(rec, {
        status: "action_required",
        actionRequiredReason: reason.trim(),
        actionRequiredSetAt: new Date(),
        actionRequiredSetByUserId: userId,
      });
      return { ...rec };
    },
    clearActionRequired: async (id: any) => {
      clearActionRequiredMock(id);
      const rec = _applications.get(id);
      if (!rec) return null;
      Object.assign(rec, {
        actionRequiredReason: null,
        actionRequiredSetAt: null,
        actionRequiredSetByUserId: null,
      });
      return { ...rec };
    },
  };
});

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => _requests.query(filter)),
    findById: (id: any) => chainableOne(() => _requests.get(id)),
  },
  recomputeRequestStatus: (...args: any[]) => recomputeRequestStatusMock(...args),
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
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

let permissionRecord: any = null;
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: {
    findOne: (_filter: any) => ({ lean: () => Promise.resolve(permissionRecord) }),
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
  recomputeRequestStatusMock.mockClear();
  setActionRequiredMock.mockClear();
  clearActionRequiredMock.mockClear();
  createVisaDocumentUploadMock.mockReset();
  presignGetObjectMock.mockClear();
  presignGetObjectMock.mockResolvedValue("https://example.com/presigned-url");
  syncVisaApplicationBillingMock.mockClear();
  syncVisaApplicationBillingMock.mockResolvedValue({ action: "created", manualBookingId: "stub-booking-id" });
  seq = 0;
  setAccess("FULL");
});

describe("permission gate", () => {
  const ROUTES: Array<{ method: "get" | "patch"; path: () => string; body?: any }> = [
    { method: "get", path: () => "/queue" },
    { method: "get", path: () => `/applications/${new mongoose.Types.ObjectId()}` },
    { method: "get", path: () => `/documents/${new mongoose.Types.ObjectId()}/url` },
    { method: "patch", path: () => `/applications/${new mongoose.Types.ObjectId()}/status`, body: { status: "docs_under_review" } },
    { method: "patch", path: () => `/documents/${new mongoose.Types.ObjectId()}/review`, body: { reviewStatus: "VERIFIED" } },
    { method: "patch", path: () => `/applications/${new mongoose.Types.ObjectId()}/costs`, body: {} },
    { method: "patch", path: () => `/applications/${new mongoose.Types.ObjectId()}/outcome`, body: {} },
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
});
