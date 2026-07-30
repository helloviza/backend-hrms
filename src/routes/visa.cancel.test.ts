// Route-level coverage for POST /api/visa/requests/:id/cancel (the "Abandon"
// action on screen 7 — track). Same in-memory-collection mocking approach as
// visa.submit.test.ts (mongodb-memory-server can't start in this
// environment) — VisaRequest is backed by a small generic store with real
// find/findOneAndUpdate semantics, so the draft-only guard and the atomic
// idempotency claim are actually exercised, not just asserted against a
// hand-picked fixture. recomputeRequestStatus is a spy — its own rollup
// logic has dedicated coverage in models/VisaRequest.test.ts; here we only
// confirm the route calls it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { requests, recomputeRequestStatusMock, resetStores } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  // Mongo's own semantics: { field: null } matches a doc where the field is
  // either explicitly null OR absent — needed for the cancelledAt
  // idempotency filter to behave like the real query would.
  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      const val = rec[key];
      if (cond === null) return val == null;
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
      // Finds the FIRST doc matching filter, applies $set, returns it
      // (post-update, matching { new: true }) — or null if nothing
      // matched. This is the atomic claim POST /cancel relies on: once one
      // call flips cancelledAt off null (or status off "draft"), a second
      // call's filter no longer matches anything.
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

  return {
    requests,
    recomputeRequestStatusMock: vi.fn().mockResolvedValue("cancelled"),
    resetStores() {
      requests.clear();
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
  default: { find: () => chainable(() => []) },
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
    find: () => chainable(() => []),
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
    cancelledAt: null,
    consentAcceptedAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  resetStores();
  recomputeRequestStatusMock.mockClear();
});

describe("POST /requests/:id/cancel", () => {
  it("404s for a request belonging to another workspace — never a 409, never leaks existence", async () => {
    const req = requestDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_B)).post(`/requests/${req._id}/cancel`);

    expect(res.status).toBe(404);
    expect(requests.get(req._id).cancelledAt).toBeNull();
  });

  it("404s on a well-formed but nonexistent id, not a 500", async () => {
    const res = await request(makeApp(WORKSPACE_A)).post(`/requests/${new mongoose.Types.ObjectId()}/cancel`);
    expect(res.status).toBe(404);
  });

  it("cancels a draft request: sets cancelledAt/cancelledByUserId and calls recomputeRequestStatus", async () => {
    const req = requestDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A, USER_A)).post(`/requests/${req._id}/cancel`);

    expect(res.status).toBe(200);
    const stored = requests.get(req._id);
    expect(stored.cancelledAt).toBeInstanceOf(Date);
    expect(String(stored.cancelledByUserId)).toBe(String(USER_A));
    expect(recomputeRequestStatusMock).toHaveBeenCalledTimes(1);
    expect(String(recomputeRequestStatusMock.mock.calls[0][0])).toBe(String(req._id));
  });

  it("rejects cancelling a SUBMITTED request (status no longer draft) with a 409, and touches nothing", async () => {
    const req = requestDoc(WORKSPACE_A, { status: "active", consentAcceptedAt: new Date() });

    const res = await request(makeApp(WORKSPACE_A)).post(`/requests/${req._id}/cancel`);

    expect(res.status).toBe(409);
    expect(requests.get(req._id).cancelledAt).toBeNull();
    expect(recomputeRequestStatusMock).not.toHaveBeenCalled();
  });

  it("rejects cancelling a COMPLETED request the same way", async () => {
    const req = requestDoc(WORKSPACE_A, { status: "completed", consentAcceptedAt: new Date() });

    const res = await request(makeApp(WORKSPACE_A)).post(`/requests/${req._id}/cancel`);

    expect(res.status).toBe(409);
    expect(recomputeRequestStatusMock).not.toHaveBeenCalled();
  });

  it("idempotent double-cancel: second call 409s, cancelledAt is not overwritten, recomputeRequestStatus called only once", async () => {
    const req = requestDoc(WORKSPACE_A);

    const first = await request(makeApp(WORKSPACE_A)).post(`/requests/${req._id}/cancel`);
    expect(first.status).toBe(200);
    const cancelledAtAfterFirst = requests.get(req._id).cancelledAt;

    const second = await request(makeApp(WORKSPACE_A)).post(`/requests/${req._id}/cancel`);

    expect(second.status).toBe(409);
    expect(requests.get(req._id).cancelledAt).toEqual(cancelledAtAfterFirst);
    expect(recomputeRequestStatusMock).toHaveBeenCalledTimes(1);
  });
});
