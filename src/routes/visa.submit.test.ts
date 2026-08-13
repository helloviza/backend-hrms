// Route-level coverage for POST /api/visa/requests/:id/submit (screen 5 —
// review & submit). Same in-memory-collection mocking approach as
// visa.requests.test.ts — VisaRequest/VisaApplication/TravellerProfile are
// backed by a small generic store with real find/findOneAndUpdate/updateMany
// semantics, so the idempotency claim (consents being empty as the atomic
// guard) and the draft->submitted transition are actually exercised, not
// just asserted against a hand-picked fixture. recomputeRequestStatus is a
// spy — its own rollup logic has dedicated coverage in
// models/VisaRequest.test.ts; here we only confirm the route calls it.
//
// NOTE: that store is a convention, not a constraint — mongodb-memory-server
// does start here (see utils/visaPredicatePersistence.test.ts), so real
// persistence is available if this test ever needs schema defaults or
// casting to be real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { requests, applications, travellers, recomputeRequestStatusMock, resetStores } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  // Mongo's own semantics: { field: null } matches a doc where the field is
  // either explicitly null OR absent. "consents.0": { $exists: false } is
  // this route's OWN idempotency filter — matches whenever consents is
  // empty or absent, same as the real query would (Mongo has no concept of
  // index [0] existing on an empty/missing array).
  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      if (key === "consents.0" && cond && typeof cond === "object" && "$exists" in cond) {
        const hasFirst = Array.isArray(rec.consents) && rec.consents.length > 0;
        return cond.$exists ? hasFirst : !hasFirst;
      }
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
      // Finds the FIRST doc matching filter, applies $set and/or
      // $push/$each, returns it (post-update, matching { new: true }) — or
      // null if nothing matched. This is the atomic claim POST /submit
      // relies on: once one call pushes into consents, a second call's
      // "consents.0" filter no longer matches anything.
      findOneAndUpdate(filter: Doc, update: Doc): Doc | null {
        const rec = this.query(filter)[0];
        if (!rec) return null;
        if (update.$set) Object.assign(rec, update.$set);
        if (update.$push) {
          for (const [key, val] of Object.entries(update.$push as Doc)) {
            const toPush = val && typeof val === "object" && "$each" in val ? val.$each : [val];
            rec[key] = [...(rec[key] || []), ...toPush];
          }
        }
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
  isTravellerErased: (application: any) => !!application?.travellerErasedAt,
  VISA_APPLICATION_ERASED_MESSAGE:
    "This traveller's data has been erased under a data-erasure request — this application can no longer be progressed.",
}));

// This route logs SUBMITTED (one row per newly-submitted application) via
// logVisaActivity — mocked to a no-op so tests never touch the real
// (unconnected, in this test environment) VisaActivityLog collection.
vi.mock("../models/VisaActivityLog.js", () => ({
  logVisaActivity: vi.fn().mockResolvedValue(undefined),
  VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES: new Set(),
  default: { find: () => chainable(() => []), countDocuments: async () => 0 },
}));

// The approval gate (2026-08-10) reads config.visaApprovalRequired off the
// workspace before deciding where a submit goes. Mocked to return NOTHING —
// no workspace document at all — because that is the harshest version of
// "flag off": isVisaApprovalRequired must default to false when the config,
// or the whole workspace, is unreadable. Every assertion in this file
// therefore describes the GATE-OFF path, which is the regression line: with
// the flag off, submit behaves exactly as it did before the gate existed.
// The gate-ON path has its own file (visa.approval.test.ts).
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: { findById: () => chainable(() => null) },
}));

import express from "express";
import request from "supertest";
import router from "./visa.js";
import { VISA_CONSENT_CLAUSE_IDS, CURRENT_VISA_CONSENT_VERSION } from "../config/visaConsent.js";

const WORKSPACE_A = new mongoose.Types.ObjectId();
const WORKSPACE_B = new mongoose.Types.ObjectId();
const USER_A = new mongoose.Types.ObjectId();

const ALL_CLAUSE_IDS = [...VISA_CONSENT_CLAUSE_IDS];

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
    consents: [],
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
  it("400s with no acceptedClauseIds at all, and touches nothing — application stays draft", async () => {
    const req = requestDoc(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, req._id);

    const res = await request(makeApp(WORKSPACE_A)).post(`/requests/${req._id}/submit`).send({});

    expect(res.status).toBe(400);
    expect(res.body.missingClauseIds.sort()).toEqual([...ALL_CLAUSE_IDS].sort());
    expect(requests.get(req._id).consents).toEqual([]);
    expect(applications.get(app._id).status).toBe("draft");
    expect(recomputeRequestStatusMock).not.toHaveBeenCalled();
  });

  it.each(ALL_CLAUSE_IDS)("400s when only %s is missing, naming exactly that clause", async (missingId) => {
    const req = requestDoc(WORKSPACE_A);
    const partial = ALL_CLAUSE_IDS.filter((id) => id !== missingId);

    const res = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${req._id}/submit`)
      .send({ acceptedClauseIds: partial });

    expect(res.status).toBe(400);
    expect(res.body.missingClauseIds).toEqual([missingId]);
    expect(res.body.error).toContain(missingId);
    expect(requests.get(req._id).consents).toEqual([]);
  });

  it("ignores an unrecognised clause id in the body rather than accepting it as one of the three", async () => {
    const req = requestDoc(WORKSPACE_A);
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${req._id}/submit`)
      .send({ acceptedClauseIds: ["REPRESENTATION", "DATA_PROCESSING", "SOMETHING_MADE_UP"] });

    expect(res.status).toBe(400);
    expect(res.body.missingClauseIds).toEqual(["TERMS"]);
  });

  it("404s for a request belonging to another workspace — never a 409, never leaks existence", async () => {
    const req = requestDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_B))
      .post(`/requests/${req._id}/submit`)
      .send({ acceptedClauseIds: ALL_CLAUSE_IDS });

    expect(res.status).toBe(404);
    expect(requests.get(req._id).consents).toEqual([]);
  });

  it("404s on a well-formed but nonexistent id, not a 500", async () => {
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${new mongoose.Types.ObjectId()}/submit`)
      .send({ acceptedClauseIds: ALL_CLAUSE_IDS });
    expect(res.status).toBe(404);
  });

  it("transitions every draft application to submitted, sets submittedAt, records all three consent entries, calls recomputeRequestStatus (never sets request status directly)", async () => {
    const req = requestDoc(WORKSPACE_A);
    const a1 = applicationDoc(WORKSPACE_A, req._id);
    const a2 = applicationDoc(WORKSPACE_A, req._id);

    const res = await request(makeApp(WORKSPACE_A, USER_A))
      .post(`/requests/${req._id}/submit`)
      .send({ acceptedClauseIds: ALL_CLAUSE_IDS });

    expect(res.status).toBe(200);
    expect(applications.get(a1._id).status).toBe("submitted");
    expect(applications.get(a2._id).status).toBe("submitted");
    expect(applications.get(a1._id).submittedAt).toBeInstanceOf(Date);
    expect(applications.get(a2._id).submittedAt).toBeInstanceOf(Date);

    const stored = requests.get(req._id);
    expect(stored.consents).toHaveLength(3);
    expect(stored.consents.map((c: any) => c.clauseId).sort()).toEqual([...ALL_CLAUSE_IDS].sort());
    for (const c of stored.consents) {
      expect(c.version).toBe(CURRENT_VISA_CONSENT_VERSION);
      expect(c.acceptedAt).toBeInstanceOf(Date);
      expect(String(c.acceptedByUserId)).toBe(String(USER_A));
    }
    // All three share the exact same acceptedAt — one atomic push, not
    // three separate writes at slightly different instants.
    const [first, ...rest] = stored.consents;
    for (const c of rest) expect(c.acceptedAt).toEqual(first.acceptedAt);

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
      .send({ acceptedClauseIds: ALL_CLAUSE_IDS });

    expect(res.status).toBe(200);
    expect(applications.get(app._id).status).toBe("submitted");
  });

  it("idempotent double-submit: second call 409s, application is not moved or dated twice, consents not duplicated, recomputeRequestStatus called only once", async () => {
    const req = requestDoc(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, req._id);

    const first = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${req._id}/submit`)
      .send({ acceptedClauseIds: ALL_CLAUSE_IDS });
    expect(first.status).toBe(200);

    const submittedAtAfterFirst = applications.get(app._id).submittedAt;
    const consentsAfterFirst = requests.get(req._id).consents;

    const second = await request(makeApp(WORKSPACE_A))
      .post(`/requests/${req._id}/submit`)
      .send({ acceptedClauseIds: ALL_CLAUSE_IDS });

    expect(second.status).toBe(409);
    expect(applications.get(app._id).submittedAt).toEqual(submittedAtAfterFirst);
    expect(requests.get(req._id).consents).toEqual(consentsAfterFirst);
    expect(requests.get(req._id).consents).toHaveLength(3); // never duplicated to 6
    expect(recomputeRequestStatusMock).toHaveBeenCalledTimes(1);
  });
});
