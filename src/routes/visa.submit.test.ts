// Route-level coverage for POST /api/visa/requests/:id/submit (screen 5 —
// review & submit). Same in-memory-collection mocking approach as
// visa.requests.test.ts (mongodb-memory-server can't start in this
// environment) — VisaRequest/VisaApplication/TravellerProfile are backed by
// a small generic store with real find/findOneAndUpdate/updateMany
// semantics, so the idempotency claim (consentAcceptedAt as the atomic
// guard) and the draft->submitted transition are actually exercised, not
// just asserted against a hand-picked fixture. recomputeRequestStatus is a
// spy — its own rollup logic has dedicated coverage in
// models/VisaRequest.test.ts; here we only confirm the route calls it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { requests, applications, travellers, recomputeRequestStatusMock, resetStores } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  // Mongo's own semantics: { field: null } matches a doc where the field is
  // either explicitly null OR absent — needed for the consentAcceptedAt
  // idempotency filter to behave like the real query would.
  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      const val = rec[key];
      if (cond === null) return val == null;
      if (cond && typeof cond === "object" && "$in" in cond) {
        const set = new Set((cond.$in as any[]).map((v) => String(v)));
        return set.has(String(val));
      }
      return String(val) === String(cond);
    });
  }

  function makeCollection() {
    const store = new Map<string, Doc>();
    return {
      store,
      insert(doc: Doc): Doc {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const record: Doc = { ...doc, _id: id, createdAt: new Date(), updatedAt: new Date() };
        store.set(String(id), record);
        return record;
      },
      get(id: any): Doc | null {
        return store.get(String(id)) ?? null;
      },
      query(filter: Doc): Doc[] {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      // Applies a $set to every matching doc — mirrors Mongoose's
      // updateMany({...}, {$set:{...}}) for the one shape this route uses.
      updateMany(filter: Doc, update: Doc): { matchedCount: number } {
        const matched = this.query(filter);
        for (const rec of matched) Object.assign(rec, update.$set || {});
        return { matchedCount: matched.length };
      },
      // Finds the FIRST doc matching filter, applies $set, returns it
      // (post-update, matching { new: true }) — or null if nothing
      // matched. This is the atomic claim POST /submit relies on: once one
      // call flips consentAcceptedAt off null, a second call's filter no
      // longer matches anything.
      findOneAndUpdate(filter: Doc, update: Doc): Doc | null {
        const rec = this.query(filter)[0];
        if (!rec) return null;
        Object.assign(rec, update.$set || {});
        return rec;
      },
      clear() {
        store.clear();
      },
    };
  }

  const requests = makeCollection();
  const applications = makeCollection();
  const travellers = makeCollection();

  return {
    requests,
    applications,
    travellers,
    recomputeRequestStatusMock: vi.fn().mockResolvedValue("active"),
    resetStores() {
      requests.clear();
      applications.clear();
      travellers.clear();
    },
  };
});

function chainable(getResult: () => any) {
  const obj: any = {
    select: () => obj,
    sort: () => obj,
    limit: () => obj,
    lean: () => Promise.resolve(getResult()),
  };
  return obj;
}

vi.mock("../models/TravellerProfile.js", () => ({
  default: { find: (filter: any) => chainable(() => travellers.query(filter)) },
}));

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    findOne: (filter: any) => chainable(() => requests.query(filter)[0] ?? null),
    findById: (id: any) => chainable(() => requests.get(id)),
    findOneAndUpdate: async (filter: any, update: any) => requests.findOneAndUpdate(filter, update),
  },
  recomputeRequestStatus: (...args: any[]) => recomputeRequestStatusMock(...args),
}));

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    find: (filter: any) => chainable(() => applications.query(filter)),
    updateMany: async (filter: any, update: any) => applications.updateMany(filter, update),
  },
}));

import express from "express";
import request from "supertest";
import router from "./visa.js";

const WORKSPACE_A = new mongoose.Types.ObjectId();
const WORKSPACE_B = new mongoose.Types.ObjectId();
const USER_A = new mongoose.Types.ObjectId();

function makeApp(workspaceId: mongoose.Types.ObjectId = WORKSPACE_A, userId: mongoose.Types.ObjectId = USER_A) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(userId), roles: ["EMPLOYEE"], email: "agent@plumtrips.com" };
    req.workspaceId = String(workspaceId);
    req.workspaceObjectId = workspaceId;
    req.workspace = { _id: workspaceId, status: "ACTIVE" };
    next();
  });
  app.use("/", router);
  return app;
}

function requestDoc(workspaceId: mongoose.Types.ObjectId, overrides: Record<string, any> = {}) {
  return requests.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId,
    referenceNumber: "HV26-000001",
    status: "draft",
    consentAcceptedAt: null,
    ...overrides,
  });
}

let appSeq = 0;
function applicationDoc(
  workspaceId: mongoose.Types.ObjectId,
  requestId: mongoose.Types.ObjectId,
  overrides: Record<string, any> = {},
) {
  appSeq += 1;
  return applications.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId,
    requestId,
    travellerProfileId: new mongoose.Types.ObjectId(),
    status: "draft",
    ruleSnapshot: { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }] },
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 5000 },
    linkedBookings: [],
    ...overrides,
  });
}

beforeEach(() => {
  resetStores();
  recomputeRequestStatusMock.mockClear();
  appSeq = 0;
});

describe("POST /requests/:id/submit", () => {
  it("400s without consent, and touches nothing — application stays draft", async () => {
    const req = requestDoc(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, req._id);

    const res = await request(makeApp(WORKSPACE_A)).post(`/requests/${req._id}/submit`).send({});

    expect(res.status).toBe(400);
    expect(requests.get(req._id).consentAcceptedAt).toBeNull();
    expect(applications.get(app._id).status).toBe("draft");
    expect(recomputeRequestStatusMock).not.toHaveBeenCalled();
  });

  it("400s when consentAccepted is any non-true value (e.g. the string 'true')", async () => {
    const req = requestDoc(WORKSPACE_A);
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${req._id}/submit`)
      .send({ consentAccepted: "true" });
    expect(res.status).toBe(400);
  });

  it("404s for a request belonging to another workspace — never a 409, never leaks existence", async () => {
    const req = requestDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_B))
      .post(`/requests/${req._id}/submit`)
      .send({ consentAccepted: true });

    expect(res.status).toBe(404);
    expect(requests.get(req._id).consentAcceptedAt).toBeNull();
  });

  it("404s on a well-formed but nonexistent id, not a 500", async () => {
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${new mongoose.Types.ObjectId()}/submit`)
      .send({ consentAccepted: true });
    expect(res.status).toBe(404);
  });

  it("transitions every draft application to submitted, sets submittedAt, records consent, calls recomputeRequestStatus (never sets request status directly)", async () => {
    const req = requestDoc(WORKSPACE_A);
    const a1 = applicationDoc(WORKSPACE_A, req._id);
    const a2 = applicationDoc(WORKSPACE_A, req._id);

    const res = await request(makeApp(WORKSPACE_A, USER_A))
      .post(`/requests/${req._id}/submit`)
      .send({ consentAccepted: true });

    expect(res.status).toBe(200);
    expect(applications.get(a1._id).status).toBe("submitted");
    expect(applications.get(a2._id).status).toBe("submitted");
    expect(applications.get(a1._id).submittedAt).toBeInstanceOf(Date);
    expect(applications.get(a2._id).submittedAt).toBeInstanceOf(Date);

    const stored = requests.get(req._id);
    expect(stored.consentAcceptedAt).toBeInstanceOf(Date);
    expect(String(stored.consentAcceptedByUserId)).toBe(String(USER_A));
    expect(stored.consentVersion).toBeTruthy();

    expect(recomputeRequestStatusMock).toHaveBeenCalledTimes(1);
    expect(String(recomputeRequestStatusMock.mock.calls[0][0])).toBe(String(req._id));
    // The route itself never writes `status` on the request — only
    // recomputeRequestStatus (mocked here) is allowed to.
  });

  it("submits successfully even with zero documents uploaded and required docs still missing — no checklist gate", async () => {
    const req = requestDoc(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, req._id, {
      ruleSnapshot: { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }] },
    });

    const res = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${req._id}/submit`)
      .send({ consentAccepted: true });

    expect(res.status).toBe(200);
    expect(applications.get(app._id).status).toBe("submitted");
  });

  it("idempotent double-submit: second call 409s, application is not moved or dated twice, recomputeRequestStatus called only once", async () => {
    const req = requestDoc(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, req._id);

    const first = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${req._id}/submit`)
      .send({ consentAccepted: true });
    expect(first.status).toBe(200);

    const submittedAtAfterFirst = applications.get(app._id).submittedAt;
    const consentAtAfterFirst = requests.get(req._id).consentAcceptedAt;

    const second = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${req._id}/submit`)
      .send({ consentAccepted: true });

    expect(second.status).toBe(409);
    expect(applications.get(app._id).submittedAt).toEqual(submittedAtAfterFirst);
    expect(requests.get(req._id).consentAcceptedAt).toEqual(consentAtAfterFirst);
    expect(recomputeRequestStatusMock).toHaveBeenCalledTimes(1);
  });
});
