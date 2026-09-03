// Route-level coverage for Phase 9c — the concierge console's activity
// trail. Unlike admin.visa.test.ts (which mocks VisaActivityLog away
// entirely — its own coverage is the state machine/permission gate, not
// this), VisaActivityLog here is the REAL model with `.create`/`.find`/
// `.countDocuments` spied onto a small in-memory array (same "spy on the
// real static method" pattern as models/VisaActivityLog.test.ts and
// models/VisaRequest.test.ts) — this file proves rows are actually written,
// paginated back out, and survive a downstream failure, not just that a
// mock was called.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const {
  _applications,
  _requests,
  _users,
  _documents,
  chainableArray,
  chainableOne,
  findByIdApplication,
  recomputeRequestStatusMock,
} = vi.hoisted(() => {
  function matchValue(val: any, cond: any): boolean {
    if (cond === null) return val === null || val === undefined;
    if (cond && typeof cond === "object" && "$in" in cond) {
      return (cond.$in as any[]).map(String).includes(String(val));
    }
    return String(val) === String(cond);
  }
  function matches(rec: Record<string, any>, filter: Record<string, any>): boolean {
    return Object.entries(filter).every(([key, cond]) => matchValue(rec[key], cond));
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

  function chainableArray(getResult: () => any[]) {
    const obj: any = { select: () => obj, sort: () => obj, limit: () => obj, lean: () => Promise.resolve(getResult()) };
    return obj;
  }
  function chainableOne(getResult: () => any) {
    const obj: any = { select: () => obj, lean: () => Promise.resolve(getResult()) };
    return obj;
  }

  const _applications = makeCollection();

  function wrapApplicationDoc(rec: Record<string, any> | null) {
    if (!rec) return null;
    const doc: any = { ...rec };
    Object.defineProperty(doc, "save", { enumerable: false, value: async () => { Object.assign(rec, doc); return doc; } });
    Object.defineProperty(doc, "toObject", { enumerable: false, value: () => { const { save: _s, toObject: _t, ...plain } = doc; return { ...plain }; } });
    return doc;
  }
  function findByIdApplication(id: any) {
    const rec = _applications.get(id);
    const p: any = Promise.resolve(wrapApplicationDoc(rec));
    p.select = () => p;
    p.lean = () => Promise.resolve(rec ? { ...rec } : null);
    return p;
  }

  return {
    _applications,
    _requests: makeCollection(),
    _users: makeCollection(),
    _documents: makeCollection(),
    chainableArray,
    chainableOne,
    findByIdApplication,
    recomputeRequestStatusMock: vi.fn().mockResolvedValue("active"),
  };
});

vi.mock("../models/VisaApplication.js", async () => {
  const actual: any = await vi.importActual("../models/VisaApplication.js");
  return {
    VISA_APPLICATION_STATUSES: actual.VISA_APPLICATION_STATUSES,
    VISA_APPLICATION_OUTCOMES: actual.VISA_APPLICATION_OUTCOMES,
    isTravellerErased: actual.isTravellerErased,
    VISA_APPLICATION_ERASED_MESSAGE: actual.VISA_APPLICATION_ERASED_MESSAGE,
    default: {
      findById: (id: any) => findByIdApplication(id),
      findOneAndUpdate: async (filter: any, update: any) => {
        const rec = _applications.query(filter)[0];
        if (!rec) return null;
        Object.assign(rec, update.$set || {});
        return { ...rec };
      },
    },
    setActionRequired: async (id: any, reason: string, userId: any) => {
      const rec = _applications.get(id);
      if (!rec) return null;
      if (!reason?.trim()) throw new Error("setActionRequired requires a non-empty reason");
      const statusBeforeActionRequired = rec.status === "action_required" ? (rec.statusBeforeActionRequired ?? null) : rec.status;
      Object.assign(rec, { status: "action_required", actionRequiredReason: reason.trim(), actionRequiredSetAt: new Date(), actionRequiredSetByUserId: userId, statusBeforeActionRequired });
      return { ...rec };
    },
    clearActionRequired: async (id: any) => {
      const rec = _applications.get(id);
      if (!rec) return null;
      const restoredStatus = rec.statusBeforeActionRequired || "submitted";
      Object.assign(rec, { status: restoredStatus, actionRequiredReason: null, actionRequiredSetAt: null, actionRequiredSetByUserId: null, statusBeforeActionRequired: null });
      return { ...rec };
    },
  };
});

vi.mock("../models/VisaRequest.js", () => ({
  default: { findById: (id: any) => chainableOne(() => _requests.get(id)) },
  recomputeRequestStatus: (...args: any[]) => recomputeRequestStatusMock(...args),
}));

vi.mock("../models/User.js", () => ({
  default: {
    findById: (id: any) => chainableOne(() => _users.get(id)),
    find: (filter: any) => chainableArray(() => _users.query(filter)),
  },
}));

vi.mock("../models/TravellerProfile.js", () => ({ default: { find: () => chainableArray(() => []), findById: () => chainableOne(() => null) } }));
vi.mock("../models/CustomerWorkspace.js", () => ({ default: { find: () => chainableArray(() => []), findById: () => chainableOne(() => null) } }));

vi.mock("../models/VisaDocument.js", () => ({
  default: {
    findOne: (filter: any) => ({ lean: () => Promise.resolve(_documents.query(filter)[0] ?? null) }),
    findOneAndUpdate: async (filter: any, update: any) => {
      const rec = _documents.query(filter)[0];
      if (!rec) return null;
      if (update.$set) Object.assign(rec, update.$set);
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete rec[key];
      return { ...rec };
    },
  },
}));

vi.mock("./visa.js", () => ({
  visaDocumentUploadMw: (_req: any, _res: any, next: any) => next(),
  createVisaDocumentUpload: vi.fn(),
}));

vi.mock("../services/visaBillingSync.js", () => ({ syncVisaApplicationBilling: vi.fn() }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

// Permission gate always passes FULL here — this file's own coverage is
// the activity trail, not the READ/WRITE/FULL gate (admin.visa.test.ts's
// job).
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: { findOne: () => chainableOne(() => ({ modules: { visaApplication: { access: "FULL" } }, status: "active" })) },
  hasAccess: () => true,
}));

import express from "express";
import request from "supertest";
import router from "./admin.visa.js";
import VisaActivityLog, { logVisaActivity } from "../models/VisaActivityLog.js";

const WORKSPACE_A = new mongoose.Types.ObjectId();
const USER_ID = new mongoose.Types.ObjectId();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(USER_ID), roles: ["OPS"], email: "concierge@plumtrips.com" };
    next();
  });
  app.use("/", router);
  return app;
}

function applicationDoc(overrides: Record<string, any> = {}) {
  const requestId = overrides.requestId ?? _requests.insert({ workspaceId: WORKSPACE_A, referenceNumber: "HV26-000001" })._id;
  return _applications.insert({
    workspaceId: WORKSPACE_A,
    requestId,
    travellerProfileId: new mongoose.Types.ObjectId(),
    status: "submitted",
    actionRequiredReason: null,
    actionRequiredSetAt: null,
    actionRequiredSetByUserId: null,
    linkedBookings: [],
    ...overrides,
  });
}

// A real in-memory backing store for the REAL VisaActivityLog model —
// `.create` appends, `.find`/`.countDocuments` read back out. This is what
// makes the tests below prove real behaviour (pagination, append-only)
// rather than asserting a mock was called.
let _activityRows: any[] = [];

function activityChain(rows: any[]) {
  let sorted = rows;
  let skipN = 0;
  let limitN: number | undefined;
  const obj: any = {
    sort: (spec: Record<string, number>) => {
      const [field, dir] = Object.entries(spec)[0] || [];
      sorted = [...rows].sort((a, b) => ((new Date(a[field as string]).getTime() - new Date(b[field as string]).getTime()) * (dir as number)));
      return obj;
    },
    skip: (n: number) => { skipN = n; return obj; },
    limit: (n: number) => { limitN = n; return obj; },
    lean: () => Promise.resolve(sorted.slice(skipN, limitN != null ? skipN + limitN : undefined)),
  };
  return obj;
}

beforeEach(() => {
  _applications.clear();
  _requests.clear();
  _users.clear();
  _documents.clear();
  recomputeRequestStatusMock.mockClear();
  _activityRows = [];

  vi.spyOn(VisaActivityLog, "create").mockImplementation(async (docs: any) => {
    const arr = Array.isArray(docs) ? docs : [docs];
    const created = arr.map((d: any) => ({ _id: new mongoose.Types.ObjectId(), ...d }));
    _activityRows.push(...created);
    return created as any;
  });
  vi.spyOn(VisaActivityLog, "find").mockImplementation(
    ((filter: any) => activityChain(_activityRows.filter((r) => String(r.applicationId) === String(filter.applicationId)))) as any,
  );
  vi.spyOn(VisaActivityLog, "countDocuments").mockImplementation(
    (async (filter: any) => _activityRows.filter((r) => String(r.applicationId) === String(filter.applicationId)).length) as any,
  );
});

describe("PATCH /applications/:id/status — action_required writes an activity row", () => {
  it("logs ACTION_REQUIRED_SET with the reason (not PII — the concierge's own message)", async () => {
    const app = makeApp();
    const a = applicationDoc({ status: "submitted" });

    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "action_required", reason: "Bank statement needs a bank stamp" });
    expect(res.status).toBe(200);

    expect(_activityRows).toHaveLength(1);
    expect(_activityRows[0].eventType).toBe("ACTION_REQUIRED_SET");
    expect(_activityRows[0].detail.reason).toBe("Bank statement needs a bank stamp");
    expect(String(_activityRows[0].applicationId)).toBe(String(a._id));
    expect(_activityRows[0].actorType).toBe("STAFF");
  });

  it("a logging failure never fails the underlying status change", async () => {
    vi.spyOn(VisaActivityLog, "create").mockRejectedValueOnce(new Error("mongo write failed"));
    const app = makeApp();
    const a = applicationDoc({ status: "submitted" });

    const res = await request(app).patch(`/applications/${a._id}/status`).send({ status: "action_required", reason: "Missing photo" });

    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe("action_required");
  });

  it("two sequential transitions on the same application write two separate rows — the first is never mutated", async () => {
    const app = makeApp();
    const a = applicationDoc({ status: "submitted" });

    await request(app).patch(`/applications/${a._id}/status`).send({ status: "docs_under_review" });
    await request(app).patch(`/applications/${a._id}/status`).send({ status: "action_required", reason: "Passport photo blurry" });

    expect(_activityRows).toHaveLength(2);
    expect(_activityRows[0].eventType).toBe("STATUS_CHANGED");
    expect(_activityRows[0].detail).toEqual({ from: "submitted", to: "docs_under_review" });
    expect(_activityRows[1].eventType).toBe("ACTION_REQUIRED_SET");
    // The first row's own detail is untouched by the second write.
    expect(_activityRows[0].detail).toEqual({ from: "submitted", to: "docs_under_review" });
  });
});

describe("PATCH /documents/:id/review — no PII in the rejection detail", () => {
  it("DOCUMENT_REJECTED carries only the reason text, never document contents/field values", async () => {
    const app = makeApp();
    const a = applicationDoc();
    const doc = _documents.insert({ applicationId: a._id, workspaceId: WORKSPACE_A, docCode: "DOC-01", deletedAt: null, reviewStatus: "PENDING" });

    const res = await request(app).patch(`/documents/${doc._id}/review`).send({ reviewStatus: "REJECTED", rejectionReason: "Photo page is blurry" });
    expect(res.status).toBe(200);

    /* TWO rows now, and the second one is the fix.
     *
     * Rejecting a document used to write only the document, leaving the
     * case in docs_under_review with a refused file inside it — the
     * customer's own surface renders `action_required`, so nothing told
     * them to act. The reject handler now derives that status through the
     * same setActionRequired helper the manual route uses, and logs the
     * same ACTION_REQUIRED_SET event, so an automatic flag is
     * indistinguishable downstream from a hand-set one. */
    expect(_activityRows).toHaveLength(2);
    expect(_activityRows[0].eventType).toBe("DOCUMENT_REJECTED");
    expect(_activityRows[0].detail).toEqual({ documentId: String(doc._id), docCode: "DOC-01", reason: "Photo page is blurry" });
    // No passport/extracted-field keys anywhere in the payload.
    expect(Object.keys(_activityRows[0].detail)).toEqual(["documentId", "docCode", "reason"]);

    expect(_activityRows[1].eventType).toBe("ACTION_REQUIRED_SET");
    // Same discipline on the derived row: the concierge's own sentence and
    // the interrupted status, and nothing extracted from the document.
    expect(_activityRows[1].detail).toEqual({
      reason: "Photo page is blurry",
      // The fixture's application is `submitted` — the status the case is
      // interrupted FROM, captured so it can be resumed when the customer
      // replaces the document.
      interruptedStatus: "submitted",
      documentId: String(doc._id),
    });
    expect(res.body.actionRequired).toBe(true);
  });
});

describe("GET /applications/:id/activity — paginated read", () => {
  it("404s for an application that doesn't exist", async () => {
    const app = makeApp();
    const res = await request(app).get(`/applications/${new mongoose.Types.ObjectId()}/activity`);
    expect(res.status).toBe(404);
  });

  it("returns rows newest-first, paginated, with actor names resolved", async () => {
    const app = makeApp();
    const a: any = applicationDoc({ status: "submitted" });
    const officer: any = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });

    await logVisaActivity({ applicationId: a._id, requestId: a.requestId, workspaceId: WORKSPACE_A, eventType: "STATUS_CHANGED", actorUserId: officer._id, actorType: "STAFF", detail: { from: "submitted", to: "docs_under_review" } });
    await logVisaActivity({ applicationId: a._id, requestId: a.requestId, workspaceId: WORKSPACE_A, eventType: "ACTION_REQUIRED_SET", actorUserId: officer._id, actorType: "STAFF", detail: { reason: "Missing bank stamp" } });
    // Two real-time `new Date()` calls can land in the same millisecond —
    // pin them a beat apart so the newest-first assertion below is
    // deterministic rather than racing the system clock's resolution.
    _activityRows[0].at = new Date("2026-01-01T00:00:00.000Z");
    _activityRows[1].at = new Date("2026-01-01T00:00:00.500Z");

    const res = await request(app).get(`/applications/${a._id}/activity`).query({ page: 1, limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(res.body.activity).toHaveLength(1);
    // Newest first — ACTION_REQUIRED_SET was logged second.
    expect(res.body.activity[0].eventType).toBe("ACTION_REQUIRED_SET");
    expect(res.body.activity[0].actor).toEqual({ id: String(officer._id), name: "Asha Rao" });
  });
});
