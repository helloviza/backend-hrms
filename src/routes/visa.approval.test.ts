// Route-level coverage for the CUSTOMER-SIDE VISA APPROVAL GATE (2026-08-10):
// the flag branch in POST /requests/:id/submit, the three decision routes
// (approve / decline / request-clarification), the approvals queue and its
// badge count.
//
// Same in-memory-collection mocking approach as visa.submit.test.ts — the
// stores implement real find/updateMany/findOneAndUpdate/findByIdAndUpdate
// semantics, so the state machine is actually exercised rather than asserted
// against a hand-picked fixture.
//
// resolveL1Approver is NOT mocked. It is the whole point of this change that
// visa reuses the expenses resolver untouched, so these tests drive the real
// one through a faked User collection — which means the manager-then-admin
// fallback and the self-exclusion are genuinely under test here, not stubbed
// past.
//
// The GATE-OFF path (flag absent -> straight to ops, unchanged behaviour) is
// covered here AND, more strictly, by visa.submit.test.ts, whose every
// assertion predates this feature and still passes untouched.
//
// Ops-side gate enforcement (a pending_approval case never appearing on any
// Plumtrips surface) lives with the ops harnesses: admin.visa.test.ts,
// admin.visa.dashboard.test.ts and admin.visa.reports.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const {
  requests,
  applications,
  users,
  workspaceConfig,
  recomputeRequestStatusMock,
  logVisaActivityMock,
  sendVisaSubmittedEmailMock,
  resetStores,
} = vi.hoisted(() => {
  type Doc = Record<string, any>;

  function matchValue(val: any, cond: any): boolean {
    if (cond && typeof cond === "object" && !(cond instanceof Date) && cond.constructor?.name !== "ObjectId") {
      if ("$exists" in cond) return cond.$exists ? val != null : val == null;
      if ("$ne" in cond) return String(val) !== String(cond.$ne);
      if ("$in" in cond) {
        // resolveL1Approver's admin pre-filter passes REGEXES here
        // (roles: { $in: [/ADMIN/i, /LEADER/i, ...] }). Honouring them
        // faithfully would duplicate the route's own logic in the fake, so
        // instead any regex $in matches — exactly mirroring the real code's
        // stated contract that the coarse regex is only a scan-narrowing
        // pre-filter and isAdmin() is the authority.
        const conds = cond.$in as any[];
        if (conds.some((c) => c instanceof RegExp)) return true;
        return conds.map(String).includes(String(val));
      }
      if ("$nin" in cond) return !(cond.$nin as any[]).map(String).includes(String(val));
    }
    if (cond === null) return val === null || val === undefined;
    return String(val) === String(cond);
  }

  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      if (key === "consents.0" && cond && typeof cond === "object" && "$exists" in cond) {
        const hasFirst = Array.isArray(rec.consents) && rec.consents.length > 0;
        return cond.$exists ? hasFirst : !hasFirst;
      }
      if (key === "$or") return (cond as any[]).some((sub) => matches(rec, sub));
      if (key === "$and") return (cond as any[]).every((sub) => matches(rec, sub));
      return matchValue(rec[key], cond);
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
      query(filter: Doc = {}): Doc[] {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      updateMany(filter: Doc, update: Doc): { matchedCount: number } {
        const matched = this.query(filter);
        for (const rec of matched) Object.assign(rec, update.$set || {});
        return { matchedCount: matched.length };
      },
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
      findByIdAndUpdate(id: any, update: Doc): Doc | null {
        const rec = this.get(id);
        if (!rec) return null;
        if (update.$set) Object.assign(rec, update.$set);
        return rec;
      },
      clear() {
        store.clear();
      },
    };
  }

  const requests = makeCollection();
  const applications = makeCollection();
  const users = makeCollection();
  // Mutable per-test stand-in for CustomerWorkspace.config.
  const workspaceConfig: { value: any } = { value: null };

  return {
    requests,
    applications,
    users,
    workspaceConfig,
    recomputeRequestStatusMock: vi.fn().mockResolvedValue("draft"),
    logVisaActivityMock: vi.fn().mockResolvedValue(undefined),
    sendVisaSubmittedEmailMock: vi.fn().mockResolvedValue(undefined),
    resetStores() {
      requests.clear();
      applications.clear();
      users.clear();
      workspaceConfig.value = null;
    },
  };
});

function chainable(getResult: () => any) {
  const obj: any = {
    select: () => obj,
    sort: () => obj,
    limit: () => obj,
    distinct: () => Promise.resolve(getResult()),
    lean: () => Promise.resolve(getResult()),
  };
  return obj;
}

vi.mock("../models/TravellerProfile.js", () => ({
  default: { find: () => chainable(() => []) },
}));

vi.mock("../models/VisaRequest.js", async () => {
  const actual: any = await vi.importActual("../models/VisaRequest.js");
  return {
    VISA_APPROVAL_STATUSES: actual.VISA_APPROVAL_STATUSES,
    default: {
      find: (filter: any) => chainable(() => requests.query(filter)),
      findOne: (filter: any) => chainable(() => requests.query(filter)[0] ?? null),
      findById: (id: any) => chainable(() => requests.get(id)),
      countDocuments: async (filter: any) => requests.query(filter).length,
      exists: async (filter: any) => requests.query(filter).length > 0,
      findOneAndUpdate: async (filter: any, update: any) => requests.findOneAndUpdate(filter, update),
      findByIdAndUpdate: async (id: any, update: any) => requests.findByIdAndUpdate(id, update),
    },
    recomputeRequestStatus: (...args: any[]) => recomputeRequestStatusMock(...args),
  };
});

vi.mock("../models/VisaApplication.js", async () => {
  const actual: any = await vi.importActual("../models/VisaApplication.js");
  return {
    VISA_APPLICATION_STATUSES: actual.VISA_APPLICATION_STATUSES,
    VISA_OPS_HIDDEN_STATUSES: actual.VISA_OPS_HIDDEN_STATUSES,
    default: {
      find: (filter: any) => chainable(() => applications.query(filter)),
      updateMany: async (filter: any, update: any) => applications.updateMany(filter, update),
    },
    isTravellerErased: (application: any) => !!application?.travellerErasedAt,
    VISA_APPLICATION_ERASED_MESSAGE:
      "This traveller's data has been erased under a data-erasure request — this application can no longer be progressed.",
  };
});

// Shared by routes/visa.ts AND (transitively) by reports.service.ts's
// resolveL1Approver, which is exactly the point — the real resolver runs
// against this fake collection.
vi.mock("../models/User.js", () => ({
  default: {
    find: (filter: any) => chainable(() => users.query(filter)),
    findOne: (filter: any) => chainable(() => users.query(filter)[0] ?? null),
    findById: (id: any) => chainable(() => users.get(id)),
  },
}));

vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    findById: () => chainable(() => (workspaceConfig.value ? { config: workspaceConfig.value } : null)),
  },
}));

vi.mock("../models/VisaActivityLog.js", () => ({
  logVisaActivity: (...args: any[]) => logVisaActivityMock(...args),
  VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES: new Set(),
  default: { find: () => chainable(() => []), countDocuments: async () => 0 },
}));

vi.mock("../utils/visaEmails.js", () => ({
  sendVisaSubmittedEmail: (...args: any[]) => sendVisaSubmittedEmailMock(...args),
}));

import express from "express";
import request from "supertest";
import router from "./visa.js";
import { VISA_CONSENT_CLAUSE_IDS } from "../config/visaConsent.js";
import { VISA_OPS_HIDDEN_STATUSES } from "../models/VisaApplication.js";

const WORKSPACE = new mongoose.Types.ObjectId();
const ALL_CLAUSE_IDS = [...VISA_CONSENT_CLAUSE_IDS];

/** Mounts the router acting as `actor`. */
function makeApp(actor: { _id: any; roles?: string[]; email?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(actor._id), roles: actor.roles ?? ["EMPLOYEE"], email: actor.email };
    req.workspaceId = String(WORKSPACE);
    req.workspaceObjectId = WORKSPACE;
    req.workspace = { _id: WORKSPACE, status: "ACTIVE" };
    next();
  });
  app.use("/", router);
  return app;
}

function userDoc(roles: string[], overrides: Record<string, any> = {}) {
  return users.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE,
    roles,
    firstName: "Test",
    lastName: roles[0] ?? "User",
    email: `${roles[0] ?? "user"}${users.store.size}@acme.test`.toLowerCase(),
    ...overrides,
  });
}

function requestDoc(raisedByUserId: any, overrides: Record<string, any> = {}) {
  return requests.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE,
    raisedByUserId,
    referenceNumber: "HV26-000042",
    destinationIso2: "AE",
    status: "draft",
    approvalStatus: null,
    approvalChain: [],
    currentLevel: 1,
    selfApproved: false,
    consents: [],
    ...overrides,
  });
}

function applicationDoc(requestId: any, overrides: Record<string, any> = {}) {
  return applications.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE,
    requestId,
    travellerProfileId: new mongoose.Types.ObjectId(),
    status: "draft",
    ruleSnapshot: { documentRequirements: [] },
    linkedBookings: [],
    ...overrides,
  });
}

/** Switch the workspace's approval gate on/off for this test. */
function setApprovalGate(on: boolean) {
  workspaceConfig.value = { visaApprovalRequired: on };
}

function submit(actorId: any, requestId: any) {
  return request(makeApp({ _id: actorId }))
    .post(`/requests/${requestId}/submit`)
    .send({ acceptedClauseIds: ALL_CLAUSE_IDS });
}

beforeEach(() => {
  resetStores();
  recomputeRequestStatusMock.mockClear();
  logVisaActivityMock.mockClear();
  sendVisaSubmittedEmailMock.mockClear();
});

/* ═══════════════════════════════════════════════════════════════════════
 * BRANCH 1 — gate OFF. The regression line.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("submit with the approval gate OFF", () => {
  it("goes straight to submitted and writes NO approval fields — unchanged behaviour", async () => {
    setApprovalGate(false);
    const employee = userDoc(["EMPLOYEE"]);
    userDoc(["ADMIN"]); // an approver exists, and must still not be used
    const req = requestDoc(employee._id);
    const app = applicationDoc(req._id);

    const res = await submit(employee._id, req._id);

    expect(res.status).toBe(200);
    expect(applications.get(app._id).status).toBe("submitted");
    expect(applications.get(app._id).submittedAt).toBeInstanceOf(Date);

    const stored = requests.get(req._id);
    expect(stored.approvalStatus).toBeNull();
    expect(stored.approverId).toBeUndefined();
    expect(stored.approvalChain).toEqual([]);
    expect(stored.selfApproved).toBe(false);
    expect(sendVisaSubmittedEmailMock).not.toHaveBeenCalled();
    expect(recomputeRequestStatusMock).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable workspace config as OFF, never as ON", async () => {
    workspaceConfig.value = null; // no workspace document at all
    const employee = userDoc(["EMPLOYEE"]);
    userDoc(["ADMIN"]);
    const req = requestDoc(employee._id);
    const app = applicationDoc(req._id);

    const res = await submit(employee._id, req._id);

    expect(res.status).toBe(200);
    expect(applications.get(app._id).status).toBe("submitted");
    expect(requests.get(req._id).approvalStatus).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * BRANCH 2 — gate ON. Held before ops.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("submit with the approval gate ON", () => {
  it("holds the request at pending_approval, routes it to the workspace admin, and never reaches ops", async () => {
    setApprovalGate(true);
    const employee = userDoc(["EMPLOYEE"]);
    const admin = userDoc(["ADMIN"]);
    const req = requestDoc(employee._id);
    const a1 = applicationDoc(req._id);
    const a2 = applicationDoc(req._id);

    const res = await submit(employee._id, req._id);
    expect(res.status).toBe(200);

    // The applications are held in the gate — NOT submitted.
    expect(applications.get(a1._id).status).toBe("pending_approval");
    expect(applications.get(a2._id).status).toBe("pending_approval");
    expect(applications.get(a1._id).submittedAt).toBeUndefined();

    // ...and pending_approval is precisely what every ops read excludes.
    expect(VISA_OPS_HIDDEN_STATUSES).toContain("pending_approval");

    const stored = requests.get(req._id);
    expect(stored.approvalStatus).toBe("pending_approval");
    expect(String(stored.approverId)).toBe(String(admin._id));
    expect(stored.currentLevel).toBe(1);
    expect(stored.submittedAt).toBeInstanceOf(Date);
    expect(stored.selfApproved).toBe(false);
    // v1 chain: exactly one level, pending, pointed at the resolved approver.
    expect(stored.approvalChain).toHaveLength(1);
    expect(stored.approvalChain[0].level).toBe(1);
    expect(stored.approvalChain[0].status).toBe("pending");
    expect(String(stored.approvalChain[0].approverId)).toBe(String(admin._id));

    // Consent still recorded — the gate sits AFTER consent, not instead of it.
    expect(stored.consents).toHaveLength(3);

    expect(logVisaActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "APPROVAL_REQUESTED" }),
    );
    expect(sendVisaSubmittedEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: admin.email, selfRouted: false }),
    );
  });

  it("prefers the requestor's own manager over any workspace admin (the expenses resolver, reused)", async () => {
    setApprovalGate(true);
    const manager = userDoc(["EMPLOYEE"]);
    const employee = userDoc(["EMPLOYEE"], { managerId: manager._id });
    userDoc(["ADMIN"]);
    const req = requestDoc(employee._id);
    applicationDoc(req._id);

    await submit(employee._id, req._id);

    expect(String(requests.get(req._id).approverId)).toBe(String(manager._id));
  });

  it("still holds the request when the approver email can't be sent — the badge is the fallback notice", async () => {
    setApprovalGate(true);
    sendVisaSubmittedEmailMock.mockRejectedValueOnce(new Error("SMTP down"));
    const employee = userDoc(["EMPLOYEE"]);
    userDoc(["ADMIN"]);
    const req = requestDoc(employee._id);
    const app = applicationDoc(req._id);

    const res = await submit(employee._id, req._id);

    expect(res.status).toBe(200);
    expect(requests.get(req._id).approvalStatus).toBe("pending_approval");
    expect(applications.get(app._id).status).toBe("pending_approval");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * DECISION 1 — solo admin self-routes rather than being refused.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("solo-admin workspace (DECISION 1)", () => {
  it("self-routes instead of refusing the submit, and marks it permanently", async () => {
    setApprovalGate(true);
    const owner = userDoc(["ADMIN"]); // the ONLY user in the workspace
    const req = requestDoc(owner._id);
    const app = applicationDoc(req._id);

    const res = await submit(owner._id, req._id);

    // Never refused — an expense claim in this situation would 409.
    expect(res.status).toBe(200);
    const stored = requests.get(req._id);
    expect(stored.approvalStatus).toBe("pending_approval");
    expect(String(stored.approverId)).toBe(String(owner._id));
    expect(stored.selfApproved).toBe(true);
    expect(applications.get(app._id).status).toBe("pending_approval");

    expect(logVisaActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "APPROVAL_REQUESTED",
        detail: expect.objectContaining({ selfRouted: true }),
      }),
    );
  });

  it("is NOT auto-approved — the owner still has to press approve", async () => {
    setApprovalGate(true);
    const owner = userDoc(["ADMIN"]);
    const req = requestDoc(owner._id);
    const app = applicationDoc(req._id);
    await submit(owner._id, req._id);

    // Still pending, still invisible to ops, until an explicit decision.
    expect(requests.get(req._id).approvalStatus).toBe("pending_approval");
    expect(applications.get(app._id).status).toBe("pending_approval");

    const res = await request(makeApp({ _id: owner._id, roles: ["ADMIN"] }))
      .post(`/requests/${req._id}/approve`)
      .send({});

    expect(res.status).toBe(200);
    expect(requests.get(req._id).approvalStatus).toBe("approved");
    expect(requests.get(req._id).selfApproved).toBe(true);
    expect(applications.get(app._id).status).toBe("submitted");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * APPROVE — the moment ops sees the case.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("POST /requests/:id/approve", () => {
  async function pendingSetup() {
    setApprovalGate(true);
    const employee = userDoc(["EMPLOYEE"]);
    const admin = userDoc(["ADMIN"]);
    const req = requestDoc(employee._id);
    const app = applicationDoc(req._id);
    await submit(employee._id, req._id);
    recomputeRequestStatusMock.mockClear();
    return { employee, admin, req, app };
  }

  it("releases the applications to ops — status submitted, submittedAt stamped, SUBMITTED logged", async () => {
    const { admin, req, app } = await pendingSetup();

    const res = await request(makeApp({ _id: admin._id, roles: ["ADMIN"] }))
      .post(`/requests/${req._id}/approve`)
      .send({ decisionNote: "Approved for the Dubai trip" });

    expect(res.status).toBe(200);

    const stored = requests.get(req._id);
    expect(stored.approvalStatus).toBe("approved");
    expect(stored.approvedAt).toBeInstanceOf(Date);
    expect(String(stored.approverId)).toBe(String(admin._id));
    expect(stored.approvalChain[0].status).toBe("approved");
    expect(stored.approvalChain[0].decidedAt).toBeInstanceOf(Date);
    expect(stored.approvalChain[0].note).toBe("Approved for the Dubai trip");
    expect(stored.selfApproved).toBe(false);

    // THE moment ops sees it.
    expect(applications.get(app._id).status).toBe("submitted");
    expect(applications.get(app._id).submittedAt).toBeInstanceOf(Date);

    expect(logVisaActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "SUBMITTED" }),
    );
    expect(logVisaActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "APPROVED" }),
    );
    // The derived status is recomputed after the release, never assigned.
    expect(recomputeRequestStatusMock).toHaveBeenCalled();
  });

  it("409s when the request is not awaiting approval (already approved — no double release)", async () => {
    const { admin, req } = await pendingSetup();
    const app = makeApp({ _id: admin._id, roles: ["ADMIN"] });

    await request(app).post(`/requests/${req._id}/approve`).send({});
    const second = await request(app).post(`/requests/${req._id}/approve`).send({});

    expect(second.status).toBe(409);
  });

  it("404s across workspaces rather than leaking that the request exists", async () => {
    const { admin, req } = await pendingSetup();
    const otherWorkspaceApp = express();
    otherWorkspaceApp.use(express.json());
    otherWorkspaceApp.use((r: any, _res, next) => {
      r.user = { _id: String(admin._id), roles: ["ADMIN"] };
      r.workspaceObjectId = new mongoose.Types.ObjectId();
      next();
    });
    otherWorkspaceApp.use("/", router);

    const res = await request(otherWorkspaceApp).post(`/requests/${req._id}/approve`).send({});
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * SEGREGATION OF DUTIES.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("who may decide", () => {
  it("a NON-admin may never approve their own request, even when routed to them", async () => {
    setApprovalGate(true);
    // Sole user, no admin anywhere -> self-routes to a plain EMPLOYEE.
    const employee = userDoc(["EMPLOYEE"]);
    const req = requestDoc(employee._id);
    applicationDoc(req._id);
    await submit(employee._id, req._id);

    expect(String(requests.get(req._id).approverId)).toBe(String(employee._id));

    const res = await request(makeApp({ _id: employee._id, roles: ["EMPLOYEE"] }))
      .post(`/requests/${req._id}/approve`)
      .send({});

    expect(res.status).toBe(403);
    expect(requests.get(req._id).approvalStatus).toBe("pending_approval");
  });

  it("an unrelated non-admin colleague may not decide someone else's request", async () => {
    setApprovalGate(true);
    const employee = userDoc(["EMPLOYEE"]);
    userDoc(["ADMIN"]);
    const bystander = userDoc(["EMPLOYEE"]);
    const req = requestDoc(employee._id);
    applicationDoc(req._id);
    await submit(employee._id, req._id);

    const res = await request(makeApp({ _id: bystander._id, roles: ["EMPLOYEE"] }))
      .post(`/requests/${req._id}/approve`)
      .send({});

    expect(res.status).toBe(403);
  });

  it("a WORKSPACE_LEADER is a workspace admin and may decide a colleague's request", async () => {
    setApprovalGate(true);
    const employee = userDoc(["EMPLOYEE"]);
    const leader = userDoc(["WORKSPACE_LEADER"]);
    const req = requestDoc(employee._id);
    applicationDoc(req._id);
    await submit(employee._id, req._id);

    const res = await request(makeApp({ _id: leader._id, roles: ["WORKSPACE_LEADER"] }))
      .post(`/requests/${req._id}/approve`)
      .send({});

    expect(res.status).toBe(200);
    expect(requests.get(req._id).approvalStatus).toBe("approved");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * DECLINE — terminal.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("POST /requests/:id/decline", () => {
  async function pendingSetup() {
    setApprovalGate(true);
    const employee = userDoc(["EMPLOYEE"]);
    const admin = userDoc(["ADMIN"]);
    const req = requestDoc(employee._id);
    const app = applicationDoc(req._id);
    await submit(employee._id, req._id);
    return { employee, admin, req, app };
  }

  it("requires a reason", async () => {
    const { admin, req } = await pendingSetup();
    const res = await request(makeApp({ _id: admin._id, roles: ["ADMIN"] }))
      .post(`/requests/${req._id}/decline`)
      .send({ decisionNote: "   " });

    expect(res.status).toBe(400);
    expect(requests.get(req._id).approvalStatus).toBe("pending_approval");
  });

  it("declines terminally: applications leave the gate, ops never sees them, and resubmit is refused", async () => {
    const { employee, admin, req, app } = await pendingSetup();

    const res = await request(makeApp({ _id: admin._id, roles: ["ADMIN"] }))
      .post(`/requests/${req._id}/decline`)
      .send({ decisionNote: "Trip cancelled by the client" });

    expect(res.status).toBe(200);
    const stored = requests.get(req._id);
    expect(stored.approvalStatus).toBe("declined");
    expect(stored.decisionNote).toBe("Trip cancelled by the client");
    expect(stored.approvalChain[0].status).toBe("declined");

    // Back out of the gate — and never into the ops pipeline.
    expect(applications.get(app._id).status).toBe("draft");
    expect(applications.get(app._id).submittedAt).toBeUndefined();

    expect(logVisaActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "DECLINED" }),
    );

    // TERMINAL: the requestor cannot push it back through.
    const resubmit = await submit(employee._id, req._id);
    expect(resubmit.status).toBe(409);
    expect(resubmit.body.error).toContain("declined");
    expect(applications.get(app._id).status).toBe("draft");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * CLARIFICATION — back to the requestor, then a FRESH chain.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("POST /requests/:id/request-clarification", () => {
  it("requires a note", async () => {
    setApprovalGate(true);
    const employee = userDoc(["EMPLOYEE"]);
    const admin = userDoc(["ADMIN"]);
    const req = requestDoc(employee._id);
    applicationDoc(req._id);
    await submit(employee._id, req._id);

    const res = await request(makeApp({ _id: admin._id, roles: ["ADMIN"] }))
      .post(`/requests/${req._id}/request-clarification`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns the request to the requestor EDITABLE, and the resubmit rebuilds the chain fresh", async () => {
    setApprovalGate(true);
    const employee = userDoc(["EMPLOYEE"]);
    const firstAdmin = userDoc(["ADMIN"]);
    const req = requestDoc(employee._id);
    const app = applicationDoc(req._id);
    await submit(employee._id, req._id);
    expect(String(requests.get(req._id).approverId)).toBe(String(firstAdmin._id));

    const res = await request(makeApp({ _id: firstAdmin._id, roles: ["ADMIN"] }))
      .post(`/requests/${req._id}/request-clarification`)
      .send({ decisionNote: "Which cost centre is this against?" });

    expect(res.status).toBe(200);
    const bounced = requests.get(req._id);
    expect(bounced.approvalStatus).toBe("clarification_required");
    expect(bounced.decisionNote).toBe("Which cost centre is this against?");
    expect(bounced.approvalChain[0].status).toBe("clarification_required");
    expect(applications.get(app._id).status).toBe("draft");
    // EDITABLE: consents cleared, which is what reopens the submit route's
    // atomic claim.
    expect(bounced.consents).toEqual([]);
    expect(logVisaActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "CLARIFICATION_REQUESTED" }),
    );

    // The first admin leaves; a different admin is now the only one.
    users.store.delete(String(firstAdmin._id));
    const secondAdmin = userDoc(["ADMIN"]);

    const resubmit = await submit(employee._id, req._id);
    expect(resubmit.status).toBe(200);

    const rebuilt = requests.get(req._id);
    expect(rebuilt.approvalStatus).toBe("pending_approval");
    // FRESH chain — routed to the current admin, not the stale snapshot.
    expect(String(rebuilt.approverId)).toBe(String(secondAdmin._id));
    expect(rebuilt.approvalChain).toHaveLength(1);
    expect(rebuilt.approvalChain[0].status).toBe("pending");
    expect(rebuilt.consents).toHaveLength(3);
    expect(applications.get(app._id).status).toBe("pending_approval");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE QUEUE + BADGE.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("approvals queue and pending-count", () => {
  async function twoPending() {
    setApprovalGate(true);
    const admin = userDoc(["ADMIN"]);
    const alice = userDoc(["EMPLOYEE"]);
    const bob = userDoc(["EMPLOYEE"]);
    const rA = requestDoc(alice._id);
    applicationDoc(rA._id);
    await submit(alice._id, rA._id);
    const rB = requestDoc(bob._id, { referenceNumber: "HV26-000043" });
    applicationDoc(rB._id);
    await submit(bob._id, rB._id);
    return { admin, alice, bob, rA, rB };
  }

  it("shows an admin every pending request in the workspace", async () => {
    const { admin } = await twoPending();

    const res = await request(makeApp({ _id: admin._id, roles: ["ADMIN"] })).get(
      "/requests?queue=approvals",
    );

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(2);
    expect(
      res.body.requests.every((r: any) => r.approvalStatus === "pending_approval"),
    ).toBe(true);
  });

  it("shows a non-admin ONLY the requests routed to them", async () => {
    setApprovalGate(true);
    const manager = userDoc(["EMPLOYEE"]);
    const reportee = userDoc(["EMPLOYEE"], { managerId: manager._id });
    userDoc(["ADMIN"]);
    const mine = requestDoc(reportee._id);
    applicationDoc(mine._id);
    await submit(reportee._id, mine._id);

    // Someone else's request, routed to the admin, not to this manager.
    const other = userDoc(["EMPLOYEE"]);
    const theirs = requestDoc(other._id, { referenceNumber: "HV26-000044" });
    applicationDoc(theirs._id);
    await submit(other._id, theirs._id);

    const res = await request(makeApp({ _id: manager._id, roles: ["EMPLOYEE"] })).get(
      "/requests?queue=approvals",
    );

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(String(res.body.requests[0]._id)).toBe(String(mine._id));
  });

  it("counts the same set for the sidebar badge, and drops to zero once decided", async () => {
    const { admin, rA, rB } = await twoPending();
    const app = makeApp({ _id: admin._id, roles: ["ADMIN"] });

    const before = await request(app).get("/requests/pending-count");
    expect(before.status).toBe(200);
    expect(before.body.approvals).toBe(2);

    await request(app).post(`/requests/${rA._id}/approve`).send({});
    await request(app).post(`/requests/${rB._id}/decline`).send({ decisionNote: "No" });

    const after = await request(app).get("/requests/pending-count");
    expect(after.body.approvals).toBe(0);
  });

  it("does not let /requests/:id capture 'pending-count'", async () => {
    setApprovalGate(true);
    const admin = userDoc(["ADMIN"]);
    const res = await request(makeApp({ _id: admin._id, roles: ["ADMIN"] })).get(
      "/requests/pending-count",
    );
    // A route-order slip would 404 here (no request with that id).
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("approvals");
  });
});
