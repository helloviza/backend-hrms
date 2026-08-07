// Route-level coverage for POST/GET /api/visa/requests and GET
// /api/visa/travellers. VisaRule, TravellerProfile, VisaRequest and
// VisaApplication are backed by a small generic in-memory collection
// (equality + $in matching, the only filter shapes this router issues)
// rather than per-call canned responses, so relational/tenancy behaviour
// (traveller-count mismatches, cross-workspace leakage, N travellers ->
// N applications) is actually exercised, not just asserted against a
// hand-picked fixture. recomputeRequestStatus is a spy — its own rollup
// logic has dedicated coverage in models/VisaRequest.test.ts; here we only
// confirm the route calls it (and never assigns VisaRequest.status
// directly).
//
// NOTE: that collection is a convention, not a constraint — mongodb-memory-
// server does start here (see utils/visaPredicatePersistence.test.ts and
// utils/plutoConversation.realmongo.integration.test.ts), so real
// persistence is available if this test ever needs schema defaults or
// casting to be real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const {
  rules,
  travellers,
  requests,
  applications,
  users,
  members,
  recomputeRequestStatusMock,
  visaLoggerWarnMock,
  resetStores,
} = vi.hoisted(() => {
  type Doc = Record<string, any>;

  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      // $or — needed by GET /requests's 2026-08-01 scoping filter (own
      // requests OR own-as-traveller requests; team-user lookup via
      // customerId OR businessId).
      if (key === "$or") {
        return (cond as Doc[]).some((sub) => matches(rec, sub));
      }
      const val = rec[key];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        if ("$in" in cond) {
          const set = new Set((cond.$in as any[]).map((v) => String(v)));
          return set.has(String(val));
        }
        // $nin/$ne/$lte/$gte — needed by POST /requests's 2026-08-02
        // duplicate-application check (status exclusion lists, travel-
        // window overlap via a date range on either side).
        if ("$nin" in cond) {
          const set = new Set((cond.$nin as any[]).map((v) => String(v)));
          return !set.has(String(val));
        }
        if ("$ne" in cond) {
          return String(val) !== String(cond.$ne);
        }
        if ("$lte" in cond || "$gte" in cond) {
          const valTime = val ? new Date(val).getTime() : NaN;
          if (Number.isNaN(valTime)) return false;
          if ("$lte" in cond && !(valTime <= new Date(cond.$lte).getTime()))
            return false;
          if ("$gte" in cond && !(valTime >= new Date(cond.$gte).getTime()))
            return false;
          return true;
        }
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
        const record: Doc = {
          ...doc,
          _id: id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.set(String(id), record);
        return record;
      },
      get(id: any): Doc | null {
        return store.get(String(id)) ?? null;
      },
      update(id: any, patch: Doc): Doc | null {
        const rec = store.get(String(id));
        if (!rec) return null;
        Object.assign(rec, patch);
        return rec;
      },
      query(filter: Doc): Doc[] {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      clear() {
        store.clear();
      },
    };
  }

  const rules = makeCollection();
  const travellers = makeCollection();
  const requests = makeCollection();
  const applications = makeCollection();
  const users = makeCollection();
  const members = makeCollection();

  return {
    rules,
    travellers,
    requests,
    applications,
    users,
    members,
    recomputeRequestStatusMock: vi.fn().mockResolvedValue("draft"),
    visaLoggerWarnMock: vi.fn(),
    resetStores() {
      rules.clear();
      travellers.clear();
      requests.clear();
      applications.clear();
      users.clear();
      members.clear();
    },
  };
});

function chainable(getResult: () => any) {
  const obj: any = {
    select: () => obj,
    sort: () => obj,
    limit: () => obj,
    lean: () => Promise.resolve(getResult()),
    // .distinct(field) — resolveVisaRequestsFilter (routes/visa.ts) chains
    // this straight off .find(filter), mirroring real Mongoose's Query#distinct.
    distinct: (field: string) => {
      const docs = getResult();
      const seen = new Set<string>();
      const out: any[] = [];
      for (const d of Array.isArray(docs) ? docs : []) {
        const v = d?.[field];
        if (v == null) continue;
        const k = String(v);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(v);
        }
      }
      return Promise.resolve(out);
    },
  };
  return obj;
}

let refSeq = 0;

vi.mock("../models/VisaRule.js", () => ({
  default: { findById: (id: any) => chainable(() => rules.get(id)) },
  VISA_PURPOSES: ["TOURIST", "BUSINESS", "TOURIST_OR_BUSINESS", "TRANSIT"],
  VISA_SERVICE_TIERS: [
    "STANDARD",
    "EXPRESS",
    "SUPERFAST",
    "PRIORITY",
    "SUPER_PRIORITY",
  ],
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: { find: (filter: any) => chainable(() => travellers.query(filter)) },
}));

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    create: async (input: any) => {
      refSeq += 1;
      const yy = String(new Date().getFullYear()).slice(2);
      return requests.insert({
        ...input,
        status: "draft", // schema default — NOT set by the route
        referenceNumber: `HV${yy}-${String(refSeq).padStart(6, "0")}`,
      });
    },
    findById: (id: any) => chainable(() => requests.get(id)),
    findOne: (filter: any) =>
      chainable(() => requests.query(filter)[0] ?? null),
    find: (filter: any) => chainable(() => requests.query(filter)),
    // resolveVisaRequestsFilter's own legacy-fallback check (routes/visa.ts).
    exists: async (filter: any) =>
      requests.query(filter).length > 0
        ? { _id: requests.query(filter)[0]._id }
        : null,
    findByIdAndUpdate: async (id: any, update: any) =>
      requests.update(id, update?.$set || {}),
  },
  recomputeRequestStatus: (...args: any[]) =>
    recomputeRequestStatusMock(...args),
}));

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    insertMany: async (docs: any[]) => docs.map((d) => applications.insert(d)),
    find: (filter: any) => chainable(() => applications.query(filter)),
  },
  isTravellerErased: (application: any) => !!application?.travellerErasedAt,
  VISA_APPLICATION_ERASED_MESSAGE:
    "This traveller's data has been erased under a data-erasure request — this application can no longer be progressed.",
}));

vi.mock("../models/User.js", () => ({
  default: {
    findById: (id: any) => chainable(() => users.get(id)),
    find: (filter: any) => chainable(() => users.query(filter)),
  },
}));

vi.mock("../models/CustomerMember.js", () => ({
  default: {
    findOne: (filter: any) => chainable(() => members.query(filter)[0] ?? null),
  },
}));

// resolveVisaRequestsFilter (routes/visa.ts) logs via visaLogger.warn when a
// customer-side user has no CustomerMember record at all (task brief,
// 2026-08-01: "LOG when it fires with the user id") — spied here so that's
// actually asserted, not just trusted.
vi.mock("../utils/logger.js", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: visaLoggerWarnMock, error: vi.fn() }),
  },
}));

// POST /requests logs REQUEST_CREATED/APPLICATION_CREATED, and GET
// /requests/:id reads back a trimmed activity feed — both mocked to a
// no-op/empty-list so tests never touch the real (unconnected, in this
// test environment) VisaActivityLog collection.
vi.mock("../models/VisaActivityLog.js", () => ({
  logVisaActivity: vi.fn().mockResolvedValue(undefined),
  VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES: new Set(),
  default: { find: () => chainable(() => []), countDocuments: async () => 0 },
}));

import express from "express";
import request from "supertest";
import router from "./visa.js";

const WORKSPACE_A = new mongoose.Types.ObjectId();
const WORKSPACE_B = new mongoose.Types.ObjectId();
const USER_A = new mongoose.Types.ObjectId();

// makeApp's third param carries the scoping-relevant identity fields
// (2026-08-01) — roles/email/customerId/businessId — on top of the
// existing userId/workspaceId params, defaulting to the pre-existing
// staff-flavoured fixture so every test written before this pass keeps
// working unchanged.
function makeApp(
  workspaceId: mongoose.Types.ObjectId = WORKSPACE_A,
  userId: mongoose.Types.ObjectId = USER_A,
  userOverrides: Record<string, any> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      _id: String(userId),
      roles: ["EMPLOYEE"],
      email: "agent@plumtrips.com",
      ...userOverrides,
    };
    req.workspaceId = String(workspaceId);
    req.workspaceObjectId = workspaceId;
    req.workspace = { _id: workspaceId, status: "ACTIVE" };
    next();
  });
  app.use("/", router);
  return app;
}

function ruleDoc(overrides: Record<string, any> = {}) {
  return rules.insert({
    _id: new mongoose.Types.ObjectId(),
    nationality: "IN",
    destinationIso2: "DE",
    destinationName: "Germany",
    purpose: "TOURIST",
    entryType: "MULTIPLE",
    serviceTier: "STANDARD",
    status: "PUBLISHED",
    isSchengen: true,
    productClass: "VISA",
    visaCategory: "STICKER",
    validityDays: 90,
    maxStayDays: 30,
    isExtension: false,
    etaMinDays: 5,
    etaMaxDays: 10,
    etaBasis: "BUSINESS",
    appointmentRequired: true,
    biometricsRequired: true,
    documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
    embassyFeeInr: 5000,
    vfsFeeInr: 1500,
    plumtripsServiceFeeInr: 2000,
    ...overrides,
  });
}

let travellerSeq = 0;
function travellerDoc(
  workspaceId: mongoose.Types.ObjectId,
  overrides: Record<string, any> = {},
) {
  travellerSeq += 1;
  return travellers.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId,
    travelerId: `TRV-${travellerSeq}`,
    firstName: "Asha",
    lastName: "Rao",
    nationality: "IN",
    passportNo: "M1234567",
    passportExpiry: "2030-01-01",
    isActive: true,
    ...overrides,
  });
}

// 2026-08-01 scoping fixtures — a "customer" here is just a shared string
// id linking a set of Users + CustomerMember rows, same shape
// resolveVisaRequestsFilter (routes/visa.ts) reads: User.customerId/
// businessId and CustomerMember.customerId+email.
function customerUser(
  customerId: string,
  email: string,
  overrides: Record<string, any> = {},
) {
  return users.insert({
    _id: new mongoose.Types.ObjectId(),
    email,
    customerId,
    businessId: customerId,
    roles: ["CUSTOMER"],
    ...overrides,
  });
}

function memberDoc(
  customerId: string,
  email: string,
  role: "WORKSPACE_LEADER" | "APPROVER" | "REQUESTER",
) {
  return members.insert({
    _id: new mongoose.Types.ObjectId(),
    customerId,
    email,
    role,
    isActive: true,
  });
}

beforeEach(() => {
  resetStores();
  recomputeRequestStatusMock.mockClear();
  visaLoggerWarnMock.mockClear();
  refSeq = 0;
});

describe("POST /requests", () => {
  it("rejects the whole request when one traveller belongs to another workspace — nothing is created", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A);
    const t2 = travellerDoc(WORKSPACE_B); // wrong workspace

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id), String(t2._id)],
      });

    expect(res.status).toBe(400);
    expect(requests.store.size).toBe(0);
    expect(applications.store.size).toBe(0);
  });

  it("404s when ruleId points at a DRAFT rule", async () => {
    const rule = ruleDoc({ status: "DRAFT" });
    const t1 = travellerDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id)],
      });

    expect(res.status).toBe(404);
    expect(requests.store.size).toBe(0);
  });

  it("404s when ruleId doesn't exist at all", async () => {
    const t1 = travellerDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(new mongoose.Types.ObjectId()),
        travellerProfileIds: [String(t1._id)],
      });

    expect(res.status).toBe(404);
  });

  it("400s on a malformed traveller id rather than a 500", async () => {
    const rule = ruleDoc();
    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: ["not-an-object-id"],
      });
    expect(res.status).toBe(400);
  });

  it("ruleSnapshot is a copy — mutating the source rule afterwards does not change the snapshot", async () => {
    const rule = ruleDoc({ destinationName: "Germany", embassyFeeInr: 5000 });
    const t1 = travellerDoc(WORKSPACE_A);

    const createRes = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id)],
      });
    expect(createRes.status).toBe(201);
    const appId = createRes.body.applications[0]._id;

    // Mutate the SAME source object the route read from, including the
    // nested array — proves the snapshot doesn't hold a shared reference.
    rule.destinationName = "Germany (renamed)";
    rule.embassyFeeInr = 99999;
    rule.documentRequirements.push({
      docCode: "DOC-99",
      requirement: "REQUIRED",
    });

    const stored = applications.get(appId);
    expect(stored.ruleSnapshot.destinationName).toBe("Germany");
    expect(stored.indicativeCostSnapshot.embassyFeeInr).toBe(5000);
    expect(stored.ruleSnapshot.documentRequirements).toHaveLength(1);
  });

  // Phase 10b (task brief §3) — applicantProfile corporate defaults +
  // client-submitted answers.
  it("defaults employmentStatus=EMPLOYED and sponsorType=EMPLOYER for a workspace member (linkedMemberId set)", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A, { linkedMemberId: new mongoose.Types.ObjectId() });

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t1._id)] });

    expect(res.status).toBe(201);
    const stored = applications.get(res.body.applications[0]._id);
    expect(stored.applicantProfile).toMatchObject({ employmentStatus: "EMPLOYED", sponsorType: "EMPLOYER" });
  });

  it("does not default employmentStatus/sponsorType for a non-member traveller (e.g. a family member)", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A); // no linkedMemberId

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t1._id)] });

    expect(res.status).toBe(201);
    const stored = applications.get(res.body.applications[0]._id);
    expect(stored.applicantProfile.employmentStatus).toBeUndefined();
    expect(stored.applicantProfile.sponsorType).toBeUndefined();
  });

  it("derives isMinor from the traveller's dob", async () => {
    const rule = ruleDoc();
    const minor = travellerDoc(WORKSPACE_A, { dob: "2015-01-01" });

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(minor._id)] });

    expect(res.status).toBe(201);
    expect(applications.get(res.body.applications[0]._id).applicantProfile.isMinor).toBe(true);
  });

  it("merges a client-submitted applicantProfileAnswers entry on top of the corporate defaults", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A, { linkedMemberId: new mongoose.Types.ObjectId() });

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id)],
        applicantProfileAnswers: { [String(t1._id)]: { maritalStatus: "MARRIED", holdsUsVisa: true } },
      });

    expect(res.status).toBe(201);
    const stored = applications.get(res.body.applications[0]._id);
    expect(stored.applicantProfile).toMatchObject({
      employmentStatus: "EMPLOYED", // still defaulted
      sponsorType: "EMPLOYER",
      maritalStatus: "MARRIED", // from the answer
      holdsUsVisa: true,
    });
  });

  it("rejects an invalid enum value in applicantProfileAnswers — nothing is created", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id)],
        applicantProfileAnswers: { [String(t1._id)]: { maritalStatus: "NOT_A_REAL_STATUS" } },
      });

    expect(res.status).toBe(400);
    expect(applications.store.size).toBe(0);
  });

  it("generates the reference number once, on the request, HV-prefixed", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id)],
      });

    expect(res.status).toBe(201);
    const yy = String(new Date().getFullYear()).slice(2);
    expect(res.body.request.referenceNumber).toMatch(
      new RegExp(`^HV${yy}-\\d{6}$`),
    );
    expect(res.body.request.referenceNumber.startsWith("PT")).toBe(false);
    for (const app of res.body.applications) {
      expect(app.referenceNumber).toBeUndefined();
    }
  });

  it("three travellers produce three VisaApplications sharing one VisaRequest", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A, { firstName: "A" });
    const t2 = travellerDoc(WORKSPACE_A, { firstName: "B" });
    const t3 = travellerDoc(WORKSPACE_A, { firstName: "C" });

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id), String(t2._id), String(t3._id)],
      });

    expect(res.status).toBe(201);
    expect(res.body.applications).toHaveLength(3);
    const requestId = res.body.request._id;
    expect(
      res.body.applications.every(
        (a: any) => String(a.requestId) === String(requestId),
      ),
    ).toBe(true);
    expect(applications.query({ requestId })).toHaveLength(3);
    expect(requests.store.size).toBe(1);
    expect(requests.get(requestId).applicationIds).toHaveLength(3);
  });

  it("creates with a flag when a traveller's nationality doesn't normalise, instead of failing", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A, { nationality: "Atlantis" });

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id)],
      });

    expect(res.status).toBe(201);
    expect(res.body.applications[0].nationality).toBeNull();
    expect(res.body.applications[0].nationalityUnresolved).toBe(true);
  });

  it("resolves a recognisable nationality normally, unflagged", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A, { nationality: "Indian" });

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id)],
      });

    expect(res.status).toBe(201);
    expect(res.body.applications[0].nationality).toBe("IN");
    expect(res.body.applications[0].nationalityUnresolved).toBe(false);
  });

  it("never assigns VisaRequest.status directly — relies on the schema default, then calls recomputeRequestStatus", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t1._id)],
      });

    expect(res.status).toBe(201);
    expect(recomputeRequestStatusMock).toHaveBeenCalledTimes(1);
    expect(String(recomputeRequestStatusMock.mock.calls[0][0])).toBe(
      String(res.body.request._id),
    );
  });
});

describe("POST /requests — duplicate-application warning (2026-08-02)", () => {
  async function createFor(
    workspaceId: mongoose.Types.ObjectId,
    ruleOverrides: Record<string, any>,
    travellerId: mongoose.Types.ObjectId,
    dates: { travelDateFrom?: string; travelDateTo?: string } = {},
  ) {
    const rule = ruleDoc(ruleOverrides);
    const res = await request(makeApp(workspaceId))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(travellerId)],
        ...dates,
      });
    return { rule, body: res.body, res };
  }

  it("warns when an existing non-draft, non-terminal application overlaps in destination and dates — but still creates the new request", async () => {
    const t1 = travellerDoc(WORKSPACE_A, {
      firstName: "Asha",
      lastName: "Rao",
    });
    const first = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE", destinationName: "Germany" },
      t1._id,
      {
        travelDateFrom: "2026-09-20",
        travelDateTo: "2026-09-28",
      },
    );
    applications.update(first.body.applications[0]._id, {
      status: "submitted",
    });

    const second = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE", destinationName: "Germany" },
      t1._id,
      {
        travelDateFrom: "2026-09-22",
        travelDateTo: "2026-09-30",
      },
    );

    expect(second.res.status).toBe(201);
    expect(second.body.applications).toHaveLength(1); // never blocked
    expect(second.body.warnings).toEqual([
      {
        travellerProfileId: String(t1._id),
        travellerName: "Asha Rao",
        existingRequestId: first.body.request._id,
        existingReferenceNumber: first.body.request.referenceNumber,
        existingApplicationId: first.body.applications[0]._id,
        existingStatus: "submitted",
        destinationName: "Germany",
      },
    ]);
  });

  it("does not warn when the only existing application is a draft — an in-progress attempt is not a duplicate", async () => {
    const t1 = travellerDoc(WORKSPACE_A);
    await createFor(WORKSPACE_A, { destinationIso2: "DE" }, t1._id, {
      travelDateFrom: "2026-09-20",
      travelDateTo: "2026-09-28",
    }); // left as draft — never advanced

    const second = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {
        travelDateFrom: "2026-09-22",
        travelDateTo: "2026-09-25",
      },
    );

    expect(second.res.status).toBe(201);
    expect(second.body.warnings).toEqual([]);
  });

  it("does not warn for a different destination", async () => {
    const t1 = travellerDoc(WORKSPACE_A);
    const first = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {
        travelDateFrom: "2026-09-20",
        travelDateTo: "2026-09-28",
      },
    );
    applications.update(first.body.applications[0]._id, {
      status: "submitted",
    });

    const second = await createFor(
      WORKSPACE_A,
      { destinationIso2: "FR" },
      t1._id,
      {
        travelDateFrom: "2026-09-22",
        travelDateTo: "2026-09-25",
      },
    );

    expect(second.body.warnings).toEqual([]);
  });

  it("does not warn for non-overlapping travel dates", async () => {
    const t1 = travellerDoc(WORKSPACE_A);
    const first = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {
        travelDateFrom: "2026-09-20",
        travelDateTo: "2026-09-28",
      },
    );
    applications.update(first.body.applications[0]._id, {
      status: "submitted",
    });

    const second = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {
        travelDateFrom: "2026-11-01",
        travelDateTo: "2026-11-10",
      },
    );

    expect(second.body.warnings).toEqual([]);
  });

  it("does not warn once the existing application is decision_received or closed", async () => {
    const t1 = travellerDoc(WORKSPACE_A);
    const decisionReceived = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {
        travelDateFrom: "2026-09-20",
        travelDateTo: "2026-09-28",
      },
    );
    applications.update(decisionReceived.body.applications[0]._id, {
      status: "decision_received",
      outcome: "APPROVED",
    });

    const closed = await createFor(
      WORKSPACE_A,
      { destinationIso2: "AE" },
      t1._id,
      {
        travelDateFrom: "2026-09-20",
        travelDateTo: "2026-09-28",
      },
    );
    applications.update(closed.body.applications[0]._id, {
      status: "closed",
      outcome: "APPROVED",
    });

    const third = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {
        travelDateFrom: "2026-09-21",
        travelDateTo: "2026-09-27",
      },
    );
    expect(third.body.warnings).toEqual([]);

    const fourth = await createFor(
      WORKSPACE_A,
      { destinationIso2: "AE" },
      t1._id,
      {
        travelDateFrom: "2026-09-21",
        travelDateTo: "2026-09-27",
      },
    );
    expect(fourth.body.warnings).toEqual([]);
  });

  it("does not warn once the existing REQUEST is cancelled", async () => {
    const t1 = travellerDoc(WORKSPACE_A);
    const first = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {
        travelDateFrom: "2026-09-20",
        travelDateTo: "2026-09-28",
      },
    );
    applications.update(first.body.applications[0]._id, {
      status: "submitted",
    });
    requests.update(first.body.request._id, { status: "cancelled" });

    const second = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {
        travelDateFrom: "2026-09-21",
        travelDateTo: "2026-09-27",
      },
    );
    expect(second.body.warnings).toEqual([]);
  });

  it("skips the check entirely when the new request has no travel dates — request is still created", async () => {
    const t1 = travellerDoc(WORKSPACE_A);
    const first = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {
        travelDateFrom: "2026-09-20",
        travelDateTo: "2026-09-28",
      },
    );
    applications.update(first.body.applications[0]._id, {
      status: "submitted",
    });

    const second = await createFor(
      WORKSPACE_A,
      { destinationIso2: "DE" },
      t1._id,
      {},
    );
    expect(second.res.status).toBe(201);
    expect(second.body.warnings).toEqual([]);
  });

  it("only warns for the traveller who actually has an overlapping application, not every traveller on the new request", async () => {
    const t1 = travellerDoc(WORKSPACE_A, {
      firstName: "Has",
      lastName: "Existing",
    });
    const t2 = travellerDoc(WORKSPACE_A, {
      firstName: "No",
      lastName: "Existing",
    });
    const rule1 = ruleDoc({ destinationIso2: "DE" });
    const firstRes = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule1._id),
        travellerProfileIds: [String(t1._id)],
        travelDateFrom: "2026-09-20",
        travelDateTo: "2026-09-28",
      });
    applications.update(firstRes.body.applications[0]._id, {
      status: "submitted",
    });

    const rule2 = ruleDoc({ destinationIso2: "DE" });
    const secondRes = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({
        ruleId: String(rule2._id),
        travellerProfileIds: [String(t1._id), String(t2._id)],
        travelDateFrom: "2026-09-22",
        travelDateTo: "2026-09-25",
      });

    expect(secondRes.body.warnings).toHaveLength(1);
    expect(secondRes.body.warnings[0].travellerProfileId).toBe(String(t1._id));
  });
});

describe("GET /requests and GET /requests/:id — workspace scoping", () => {
  async function createOne(
    workspaceId: mongoose.Types.ObjectId,
    travellerOverrides: Record<string, any> = {},
  ) {
    const rule = ruleDoc();
    const t = travellerDoc(workspaceId, travellerOverrides);
    const res = await request(makeApp(workspaceId))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t._id)] });
    return res.body;
  }

  it("list is workspace-scoped and leaks nothing cross-tenant", async () => {
    await createOne(WORKSPACE_A);
    await createOne(WORKSPACE_B);

    const resA = await request(makeApp(WORKSPACE_A)).get("/requests");
    expect(resA.status).toBe(200);
    expect(resA.body.requests).toHaveLength(1);

    const resB = await request(makeApp(WORKSPACE_B)).get("/requests");
    expect(resB.status).toBe(200);
    expect(resB.body.requests).toHaveLength(1);
    expect(String(resB.body.requests[0]._id)).not.toBe(
      String(resA.body.requests[0]._id),
    );
  });

  it("list includes applications and their travellers", async () => {
    await createOne(WORKSPACE_A, { firstName: "Asha", lastName: "Rao" });

    const res = await request(makeApp(WORKSPACE_A)).get("/requests");
    expect(res.body.requests[0].applications).toHaveLength(1);
    expect(res.body.requests[0].applications[0].traveller.name).toBe(
      "Asha Rao",
    );
  });

  it("detail 404s for a request belonging to another workspace — never leaks it", async () => {
    const created = await createOne(WORKSPACE_A);
    const requestId = created.request._id;

    const crossTenant = await request(makeApp(WORKSPACE_B)).get(
      `/requests/${requestId}`,
    );
    expect(crossTenant.status).toBe(404);

    const own = await request(makeApp(WORKSPACE_A)).get(
      `/requests/${requestId}`,
    );
    expect(own.status).toBe(200);
    expect(own.body.applications).toHaveLength(1);
    expect(own.body.applications[0].traveller.passportNo).toBe("M1234567");
  });

  // Phase 10b — end-to-end: POST /requests captures documentGroups into the
  // snapshot (buildRuleSnapshot) and applies the corporate-defaulted
  // applicantProfile; GET /requests/:id then narrows the checklist via the
  // resolver (hydrateApplicationsWithTravellers) using that same profile.
  it("GET /requests/:id narrows a group-based rule's checklist to what applies to this (workspace-member) traveller", async () => {
    const rule = ruleDoc({
      documentGroups: [
        { key: "PASSPORT", label: "Passport", requirement: "REQUIRED", docTypeCodes: ["DOC-01"] },
        {
          key: "ITR",
          label: "Income Tax Return",
          requirement: "CONDITIONAL",
          appliesWhen: [{ field: "employmentStatus", in: ["SELF_EMPLOYED"] }],
          docTypeCodes: ["DOC-04"],
        },
      ],
    });
    const t = travellerDoc(WORKSPACE_A, { linkedMemberId: new mongoose.Types.ObjectId() }); // -> EMPLOYED default

    const created = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t._id)] });
    expect(created.status).toBe(201);

    const detail = await request(makeApp(WORKSPACE_A)).get(`/requests/${created.body.request._id}`);
    expect(detail.status).toBe(200);
    const groups = detail.body.applications[0].ruleSnapshot.documentGroups;
    expect(groups.map((g: any) => g.key)).toEqual(["PASSPORT"]); // ITR excluded — this traveller is EMPLOYED, not SELF_EMPLOYED
    expect(detail.body.applications[0].ruleSnapshot.documentRequirements.map((d: any) => d.docCode)).toEqual(["DOC-01"]);
  });

  it("detail 404s on a well-formed but nonexistent id, not a 500", async () => {
    const res = await request(makeApp(WORKSPACE_A)).get(
      `/requests/${new mongoose.Types.ObjectId()}`,
    );
    expect(res.status).toBe(404);
  });

  it("detail's lodgedAt/estimatedDecision/assignedConciergeName are null until lodged/assigned — never guessed", async () => {
    const created = await createOne(WORKSPACE_A);
    const requestId = created.request._id;

    const res = await request(makeApp(WORKSPACE_A)).get(
      `/requests/${requestId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.applications[0].lodgedAt).toBeNull();
    expect(res.body.applications[0].estimatedDecision).toBeNull();
    expect(res.body.applications[0].assignedConciergeName).toBeNull();
  });

  it("detail resolves lodgedAt into an estimatedDecision window (rule snapshot's eta*), and the assigned concierge's name", async () => {
    const created = await createOne(WORKSPACE_A);
    const requestId = created.request._id;
    const appId = created.applications[0]._id;

    // ruleDoc() (the rule this request was created from) carries
    // etaMinDays: 5, etaMaxDays: 10, etaBasis: "BUSINESS" — copied into
    // ruleSnapshot at creation time (buildRuleSnapshot, routes/visa.ts).
    const lodgedAt = new Date("2026-08-03T00:00:00.000Z"); // Monday
    const concierge = users.insert({
      name: "Asha Rao",
      email: "asha@plumtrips.com",
    });
    // Phase 9a — assignment lives on the APPLICATION itself, not the parent
    // request (models/VisaApplication.ts's assignedConciergeUserId).
    applications.update(appId, {
      status: "lodged",
      lodgedAt,
      assignedConciergeUserId: concierge._id,
    });

    const res = await request(makeApp(WORKSPACE_A)).get(
      `/requests/${requestId}`,
    );
    expect(res.status).toBe(200);
    const app = res.body.applications[0];
    expect(new Date(app.lodgedAt).toISOString()).toBe(lodgedAt.toISOString());
    expect(app.estimatedDecision).toEqual({
      minDate: new Date("2026-08-10T00:00:00.000Z").toISOString(),
      maxDate: new Date("2026-08-17T00:00:00.000Z").toISOString(),
    });
    expect(app.assignedConciergeName).toBe("Asha Rao");
  });

  it("GET /requests (list) does NOT compute the derived timeline fields — scoped to the detail route only", async () => {
    const created = await createOne(WORKSPACE_A);
    applications.update(created.applications[0]._id, {
      status: "lodged",
      lodgedAt: new Date(),
    });

    const res = await request(makeApp(WORKSPACE_A)).get("/requests");
    expect(res.status).toBe(200);
    // estimatedDecision/assignedConciergeName require extra derivation (an
    // ETA computation, a User lookup) — those stay gated behind
    // hydrateApplicationsWithTravellers' timelineOpts, which only GET
    // /requests/:id passes. lodgedAt itself is a plain stored field on the
    // application document, so it passes through either route's `...a`
    // spread same as any other raw field (submittedAt, status, ...) — never
    // deliberately gated, nothing to assert against here.
    expect(
      res.body.requests[0].applications[0].estimatedDecision,
    ).toBeUndefined();
    expect(
      res.body.requests[0].applications[0].assignedConciergeName,
    ).toBeUndefined();
  });
});

describe("GET /requests — customer-side scoping (2026-08-01)", () => {
  function asCustomer(
    customerId: string,
    email: string,
    role: "WORKSPACE_LEADER" | "REQUESTER" | "APPROVER",
  ) {
    return {
      email,
      customerId,
      businessId: customerId,
      roles: ["CUSTOMER", role],
    };
  }

  async function createRequestAs(
    workspaceId: mongoose.Types.ObjectId,
    userId: mongoose.Types.ObjectId,
    userFields: Record<string, any>,
    travellerOverrides: Record<string, any> = {},
  ) {
    const rule = ruleDoc();
    const t = travellerDoc(workspaceId, travellerOverrides);
    const res = await request(makeApp(workspaceId, userId, userFields))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t._id)] });
    return { body: res.body, traveller: t };
  }

  it("a WORKSPACE_LEADER sees their own customer's requests, and NOT another customer's sharing the same workspace", async () => {
    // Mirrors HOUSE exactly: two different customerIds, one shared
    // workspaceId — expressible today because resolveWorkspaceForUser
    // (middleware/requireWorkspace.ts) already resolves every one of a
    // shared workspace's many Customers' users onto the SAME
    // CustomerWorkspace, one request/session at a time; this test just
    // exercises two of them back to back rather than needing 62 real
    // Customer documents to prove the shape.
    const customerA = "cust-a";
    const customerB = "cust-b";
    const leaderA = customerUser(customerA, "leader-a@x.com", {
      roles: ["CUSTOMER", "WORKSPACE_LEADER"],
    });
    memberDoc(customerA, "leader-a@x.com", "WORKSPACE_LEADER");
    const requesterA = customerUser(customerA, "requester-a@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerA, "requester-a@x.com", "REQUESTER");
    const leaderB = customerUser(customerB, "leader-b@x.com", {
      roles: ["CUSTOMER", "WORKSPACE_LEADER"],
    });
    memberDoc(customerB, "leader-b@x.com", "WORKSPACE_LEADER");

    const reqA1 = await createRequestAs(
      WORKSPACE_A,
      leaderA._id,
      asCustomer(customerA, "leader-a@x.com", "WORKSPACE_LEADER"),
    );
    const reqA2 = await createRequestAs(
      WORKSPACE_A,
      requesterA._id,
      asCustomer(customerA, "requester-a@x.com", "REQUESTER"),
    );
    const reqB1 = await createRequestAs(
      WORKSPACE_A,
      leaderB._id,
      asCustomer(customerB, "leader-b@x.com", "WORKSPACE_LEADER"),
    );

    const res = await request(
      makeApp(
        WORKSPACE_A,
        leaderA._id,
        asCustomer(customerA, "leader-a@x.com", "WORKSPACE_LEADER"),
      ),
    ).get("/requests");

    expect(res.status).toBe(200);
    const ids = res.body.requests.map((r: any) => r._id).sort();
    expect(ids).toEqual(
      [reqA1.body.request._id, reqA2.body.request._id].sort(),
    );
    expect(ids).not.toContain(reqB1.body.request._id);
  });

  it("a REQUESTER sees requests they raised, plus requests where they're the claimed traveller — nothing else", async () => {
    const customerId = "cust-c";
    const req1 = customerUser(customerId, "req1@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "req1@x.com", "REQUESTER");
    const req2 = customerUser(customerId, "req2@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "req2@x.com", "REQUESTER");
    const fields1 = asCustomer(customerId, "req1@x.com", "REQUESTER");
    const fields2 = asCustomer(customerId, "req2@x.com", "REQUESTER");

    // A: raised by req1 themself.
    const reqA = await createRequestAs(WORKSPACE_A, req1._id, fields1);

    // B: raised by req2, but FOR a traveller profile req1 has claimed —
    // req1 must see this one even though they didn't raise it.
    const claimedTraveller = travellerDoc(WORKSPACE_A, { claimedBy: req1._id });
    const ruleB = ruleDoc();
    const resB = await request(makeApp(WORKSPACE_A, req2._id, fields2))
      .post("/requests")
      .send({
        ruleId: String(ruleB._id),
        travellerProfileIds: [String(claimedTraveller._id)],
      });

    // C: raised by req2, for an unrelated traveller — req1 must never see this.
    const reqC = await createRequestAs(WORKSPACE_A, req2._id, fields2);

    const res = await request(makeApp(WORKSPACE_A, req1._id, fields1)).get(
      "/requests",
    );
    const ids = res.body.requests.map((r: any) => r._id).sort();
    expect(ids).toEqual([reqA.body.request._id, resB.body.request._id].sort());
    expect(ids).not.toContain(reqC.body.request._id);
  });

  it("an unclaimed traveller (no claimedBy at all) gets no extra visibility from being the subject of a colleague's request", async () => {
    const customerId = "cust-d";
    const bystander = customerUser(customerId, "bystander@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "bystander@x.com", "REQUESTER");
    const raiser = customerUser(customerId, "raiser@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "raiser@x.com", "REQUESTER");

    // Traveller profile has no claimedBy — never inferred from email, per
    // TravellerProfile.ts's own rule, even if this traveller's email were
    // to coincidentally match the bystander (not set here either way).
    await createRequestAs(
      WORKSPACE_A,
      raiser._id,
      asCustomer(customerId, "raiser@x.com", "REQUESTER"),
    );

    const res = await request(
      makeApp(
        WORKSPACE_A,
        bystander._id,
        asCustomer(customerId, "bystander@x.com", "REQUESTER"),
      ),
    ).get("/requests");
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(0);
  });

  it("a customerId-bearing user with NO CustomerMember record defaults to REQUESTER-tier (own-scope only) and logs it", async () => {
    const customerId = "cust-e";
    // Deliberately NO memberDoc() call for this one — the real, observed
    // data gap (2026-08-01 audit: some customer-side Users have customerId
    // set with no CustomerMember row at all).
    const orphan = customerUser(customerId, "orphan@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    const leader = customerUser(customerId, "leader@x.com", {
      roles: ["CUSTOMER", "WORKSPACE_LEADER"],
    });
    memberDoc(customerId, "leader@x.com", "WORKSPACE_LEADER");

    // A colleague raises a request the orphan neither raised nor is the traveller on.
    await createRequestAs(
      WORKSPACE_A,
      leader._id,
      asCustomer(customerId, "leader@x.com", "WORKSPACE_LEADER"),
    );

    const res = await request(
      makeApp(
        WORKSPACE_A,
        orphan._id,
        asCustomer(customerId, "orphan@x.com", "REQUESTER"),
      ),
    ).get("/requests");
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(0);

    expect(visaLoggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("no CustomerMember record"),
      expect.objectContaining({ userId: String(orphan._id), customerId }),
    );
  });

  it("creation sets VisaRequest.customerId (and copies it onto every application) from the raiser's own customerId", async () => {
    const customerId = "cust-f";
    const leader = customerUser(customerId, "leader-f@x.com", {
      roles: ["CUSTOMER", "WORKSPACE_LEADER"],
    });

    const { body } = await createRequestAs(
      WORKSPACE_A,
      leader._id,
      asCustomer(customerId, "leader-f@x.com", "WORKSPACE_LEADER"),
    );

    expect(body.request.customerId).toBe(customerId);
    expect(body.applications).toHaveLength(1);
    expect(applications.get(body.applications[0]._id).customerId).toBe(
      customerId,
    );
  });

  it("a staff-raised request (raiser has no customerId/businessId) leaves customerId null — never guessed from workspaceId", async () => {
    const staffUser = {
      _id: new mongoose.Types.ObjectId(),
      email: "admin@plumtrips.com",
      roles: ["EMPLOYEE"],
    }; // no customerId/businessId

    const { body } = await createRequestAs(
      WORKSPACE_A,
      staffUser._id,
      staffUser,
    );

    expect(body.request.customerId).toBeNull();
    expect(applications.get(body.applications[0]._id).customerId).toBeNull();
  });

  it("org scope uses the stored field directly — survives the raiser's OWN customerId later changing, unlike the old customerId->users->raisedByUserId join", async () => {
    const customerId = "cust-g";
    const leader = customerUser(customerId, "leader-g@x.com", {
      roles: ["CUSTOMER", "WORKSPACE_LEADER"],
    });
    const raiser = customerUser(customerId, "raiser-g@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "leader-g@x.com", "WORKSPACE_LEADER");

    const created = await createRequestAs(
      WORKSPACE_A,
      raiser._id,
      asCustomer(customerId, "raiser-g@x.com", "REQUESTER"),
    );
    expect(created.body.request.customerId).toBe(customerId);

    // The raiser's account is later moved off this customer entirely — the
    // exact silent-breakage this field exists to stop (task brief: "a
    // request raised by someone whose customerId is later cleared falls
    // out of their own company's scope"). Re-deriving via the indirect
    // join would now fail; the stored field must not care.
    users.update(raiser._id, {
      customerId: "cust-somewhere-else",
      businessId: "cust-somewhere-else",
    });

    const res = await request(
      makeApp(
        WORKSPACE_A,
        leader._id,
        asCustomer(customerId, "leader-g@x.com", "WORKSPACE_LEADER"),
      ),
    ).get("/requests");
    expect(res.status).toBe(200);
    expect(res.body.requests.map((r: any) => r._id)).toEqual([
      created.body.request._id,
    ]);
  });

  it("falls back to the indirect join for a legacy null-customerId record, and logs that the fallback fired", async () => {
    const customerId = "cust-h";
    const leader = customerUser(customerId, "leader-h@x.com", {
      roles: ["CUSTOMER", "WORKSPACE_LEADER"],
    });
    const legacyRaiser = customerUser(customerId, "legacy-raiser-h@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "leader-h@x.com", "WORKSPACE_LEADER");

    // Inserted directly, bypassing POST /requests — simulates a row written
    // before this field existed: workspaceId set, customerId explicitly
    // null, raisedByUserId pointing at a real member of this customer.
    const legacyRequest = requests.insert({
      workspaceId: WORKSPACE_A,
      raisedByUserId: legacyRaiser._id,
      customerId: null,
      destinationIso2: "DE",
      purpose: "TOURIST",
      applicationIds: [],
    });

    const res = await request(
      makeApp(
        WORKSPACE_A,
        leader._id,
        asCustomer(customerId, "leader-h@x.com", "WORKSPACE_LEADER"),
      ),
    ).get("/requests");
    expect(res.status).toBe(200);
    expect(res.body.requests.map((r: any) => r._id)).toEqual([
      String(legacyRequest._id),
    ]);

    expect(visaLoggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "falling back to the indirect raisedByUserId join",
      ),
      expect.objectContaining({ workspaceId: String(WORKSPACE_A), customerId }),
    );
  });
});

describe("GET /summary — customer dashboard aggregate (2026-08-01)", () => {
  function asCustomer(
    customerId: string,
    email: string,
    role: "WORKSPACE_LEADER" | "REQUESTER" | "APPROVER",
  ) {
    return {
      email,
      customerId,
      businessId: customerId,
      roles: ["CUSTOMER", role],
    };
  }

  async function createRequestAs(
    workspaceId: mongoose.Types.ObjectId,
    userId: mongoose.Types.ObjectId,
    userFields: Record<string, any>,
    body: Record<string, any> = {},
    travellerOverrides: Record<string, any> = {},
  ) {
    const rule = ruleDoc();
    const t = travellerDoc(workspaceId, travellerOverrides);
    const res = await request(makeApp(workspaceId, userId, userFields))
      .post("/requests")
      .send({
        ruleId: String(rule._id),
        travellerProfileIds: [String(t._id)],
        ...body,
      });
    return { body: res.body, traveller: t };
  }

  function daysFromNow(n: number): string {
    return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
  }

  it("a WORKSPACE_LEADER and a REQUESTER in the same customer see different counts — org scope vs own scope", async () => {
    const customerId = "cust-sum";
    const leader = customerUser(customerId, "leader-sum@x.com", {
      roles: ["CUSTOMER", "WORKSPACE_LEADER"],
    });
    memberDoc(customerId, "leader-sum@x.com", "WORKSPACE_LEADER");
    const requester = customerUser(customerId, "req-sum@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "req-sum@x.com", "REQUESTER");

    await createRequestAs(
      WORKSPACE_A,
      leader._id,
      asCustomer(customerId, "leader-sum@x.com", "WORKSPACE_LEADER"),
    );
    await createRequestAs(
      WORKSPACE_A,
      requester._id,
      asCustomer(customerId, "req-sum@x.com", "REQUESTER"),
    );

    const leaderRes = await request(
      makeApp(
        WORKSPACE_A,
        leader._id,
        asCustomer(customerId, "leader-sum@x.com", "WORKSPACE_LEADER"),
      ),
    ).get("/summary");
    expect(leaderRes.status).toBe(200);
    expect(leaderRes.body.scope).toBe("ORG");
    expect(leaderRes.body.totalApplications).toBe(2);

    const requesterRes = await request(
      makeApp(
        WORKSPACE_A,
        requester._id,
        asCustomer(customerId, "req-sum@x.com", "REQUESTER"),
      ),
    ).get("/summary");
    expect(requesterRes.status).toBe(200);
    expect(requesterRes.body.scope).toBe("OWN");
    expect(requesterRes.body.totalApplications).toBe(1);
  });

  it("a user with no applications gets an all-empty summary (totalApplications: 0, every section empty)", async () => {
    const customerId = "cust-sum-empty";
    const requester = customerUser(customerId, "empty@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "empty@x.com", "REQUESTER");

    const res = await request(
      makeApp(
        WORKSPACE_A,
        requester._id,
        asCustomer(customerId, "empty@x.com", "REQUESTER"),
      ),
    ).get("/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      scope: "OWN",
      totalApplications: 0,
      stageCounts: [],
      needsAction: [],
      upcomingTravel: [],
      atRisk: [],
    });
  });

  it("needsAction surfaces action_required applications named by traveller, with the concierge's reason", async () => {
    const customerId = "cust-sum-needs";
    const requester = customerUser(customerId, "needs@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "needs@x.com", "REQUESTER");

    const created = await createRequestAs(
      WORKSPACE_A,
      requester._id,
      asCustomer(customerId, "needs@x.com", "REQUESTER"),
      {},
      { firstName: "Asha", lastName: "Rao" },
    );
    const appId = created.body.applications[0]._id;
    applications.update(appId, {
      status: "action_required",
      actionRequiredReason: "Upload a clearer passport scan",
    });

    const res = await request(
      makeApp(
        WORKSPACE_A,
        requester._id,
        asCustomer(customerId, "needs@x.com", "REQUESTER"),
      ),
    ).get("/summary");
    expect(res.status).toBe(200);
    expect(res.body.needsAction).toEqual([
      {
        requestId: String(created.body.request._id),
        applicationId: String(appId),
        travellerName: "Asha Rao",
        reason: "Upload a clearer passport scan",
        destinationName: "Germany",
      },
    ]);
    // action_required must never double-count into the in-progress stage breakdown.
    expect(res.body.stageCounts).toEqual([]);
  });

  it("stageCounts buckets non-draft, non-action_required applications by stage — excludes draft and action_required", async () => {
    const customerId = "cust-sum-stages";
    const leader = customerUser(customerId, "stages@x.com", {
      roles: ["CUSTOMER", "WORKSPACE_LEADER"],
    });
    memberDoc(customerId, "stages@x.com", "WORKSPACE_LEADER");
    const fields = asCustomer(customerId, "stages@x.com", "WORKSPACE_LEADER");

    const draft = await createRequestAs(WORKSPACE_A, leader._id, fields); // stays draft
    const submitted = await createRequestAs(WORKSPACE_A, leader._id, fields);
    applications.update(submitted.body.applications[0]._id, {
      status: "submitted",
    });
    const lodged = await createRequestAs(WORKSPACE_A, leader._id, fields);
    applications.update(lodged.body.applications[0]._id, { status: "lodged" });
    const lodged2 = await createRequestAs(WORKSPACE_A, leader._id, fields);
    applications.update(lodged2.body.applications[0]._id, { status: "lodged" });
    const actionReq = await createRequestAs(WORKSPACE_A, leader._id, fields);
    applications.update(actionReq.body.applications[0]._id, {
      status: "action_required",
      actionRequiredReason: "x",
    });
    void draft;

    const res = await request(makeApp(WORKSPACE_A, leader._id, fields)).get(
      "/summary",
    );
    expect(res.status).toBe(200);
    expect(res.body.stageCounts).toEqual([
      { status: "submitted", count: 1 },
      { status: "lodged", count: 2 },
    ]);
  });

  it("upcomingTravel includes applications with travel within 60 days, marks decided from outcome, and excludes travel further out", async () => {
    const customerId = "cust-sum-travel";
    const requester = customerUser(customerId, "travel@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "travel@x.com", "REQUESTER");
    const fields = asCustomer(customerId, "travel@x.com", "REQUESTER");

    const soonUndecided = await createRequestAs(
      WORKSPACE_A,
      requester._id,
      fields,
      { travelDateFrom: daysFromNow(10) },
      { firstName: "Undecided", lastName: "Traveller" },
    );
    applications.update(soonUndecided.body.applications[0]._id, {
      status: "lodged",
    });

    const soonDecided = await createRequestAs(
      WORKSPACE_A,
      requester._id,
      fields,
      { travelDateFrom: daysFromNow(5) },
      { firstName: "Decided", lastName: "Traveller" },
    );
    applications.update(soonDecided.body.applications[0]._id, {
      status: "closed",
      outcome: "APPROVED",
    });

    const farOut = await createRequestAs(WORKSPACE_A, requester._id, fields, {
      travelDateFrom: daysFromNow(90),
    });
    applications.update(farOut.body.applications[0]._id, {
      status: "submitted",
    });

    const stillDraft = await createRequestAs(
      WORKSPACE_A,
      requester._id,
      fields,
      { travelDateFrom: daysFromNow(3) },
    ); // left as draft

    const res = await request(makeApp(WORKSPACE_A, requester._id, fields)).get(
      "/summary",
    );
    expect(res.status).toBe(200);
    const ids = res.body.upcomingTravel.map((u: any) => u.requestId);
    expect(ids).toEqual([
      String(soonDecided.body.request._id),
      String(soonUndecided.body.request._id),
    ]);
    expect(ids).not.toContain(String(farOut.body.request._id));
    expect(ids).not.toContain(String(stillDraft.body.request._id));

    const decidedEntry = res.body.upcomingTravel.find(
      (u: any) => u.requestId === String(soonDecided.body.request._id),
    );
    expect(decidedEntry.decided).toBe(true);
    expect(decidedEntry.outcome).toBe("APPROVED");
    expect(decidedEntry.travellerName).toBe("Decided Traveller");

    const undecidedEntry = res.body.upcomingTravel.find(
      (u: any) => u.requestId === String(soonUndecided.body.request._id),
    );
    expect(undecidedEntry.decided).toBe(false);
    expect(undecidedEntry.outcome).toBeNull();
  });

  it("atRisk reuses assessProcessingRisk (short on time relative to the rule's etaMaxDays) and excludes decided/closed/draft cases", async () => {
    const customerId = "cust-sum-risk";
    const requester = customerUser(customerId, "risk@x.com", {
      roles: ["CUSTOMER", "REQUESTER"],
    });
    memberDoc(customerId, "risk@x.com", "REQUESTER");
    const fields = asCustomer(customerId, "risk@x.com", "REQUESTER");

    // ruleDoc() defaults: etaMaxDays 10, etaBasis BUSINESS — 2 days out is
    // nowhere near enough lead time, so this must come back at-risk.
    const atRiskCase = await createRequestAs(
      WORKSPACE_A,
      requester._id,
      fields,
      { travelDateFrom: daysFromNow(2) },
      { firstName: "AtRisk", lastName: "Traveller" },
    );
    applications.update(atRiskCase.body.applications[0]._id, {
      status: "submitted",
    });

    // Plenty of lead time — not at risk, must not appear.
    const safeCase = await createRequestAs(WORKSPACE_A, requester._id, fields, {
      travelDateFrom: daysFromNow(120),
    });
    applications.update(safeCase.body.applications[0]._id, {
      status: "submitted",
    });

    // Short on time, but already decided — nothing left to risk.
    const decidedCase = await createRequestAs(
      WORKSPACE_A,
      requester._id,
      fields,
      { travelDateFrom: daysFromNow(2) },
    );
    applications.update(decidedCase.body.applications[0]._id, {
      status: "closed",
      outcome: "REJECTED",
    });

    const res = await request(makeApp(WORKSPACE_A, requester._id, fields)).get(
      "/summary",
    );
    expect(res.status).toBe(200);
    const ids = res.body.atRisk.map((r: any) => r.requestId);
    expect(ids).toEqual([String(atRiskCase.body.request._id)]);
    expect(ids).not.toContain(String(safeCase.body.request._id));
    expect(ids).not.toContain(String(decidedCase.body.request._id));
    expect(res.body.atRisk[0].travellerName).toBe("AtRisk Traveller");
    expect(res.body.atRisk[0].marginDays).toBeLessThan(0);
  });
});

describe("GET /travellers — visa picker data", () => {
  it("returns masked passportNo (same tail-mask as workspace.travellers GET /), unmasked passportExpiry, workspace-scoped, with disambiguating fields", async () => {
    travellerDoc(WORKSPACE_A, {
      firstName: "Asha",
      passportNo: "M1234567",
      passportExpiry: "2030-05-01",
      dob: "1990-01-01",
    });
    travellerDoc(WORKSPACE_B, { firstName: "Other" });

    const res = await request(makeApp(WORKSPACE_A)).get("/travellers");
    expect(res.status).toBe(200);
    expect(res.body.travellers).toHaveLength(1);
    expect(res.body.travellers[0].passportMasked).toBe("****4567");
    expect(res.body.travellers[0].passportExpiry).toBe("2030-05-01");
    expect(res.body.travellers[0].dob).toBe("1990-01-01");
  });

  it("never includes the full passport number anywhere in the response", async () => {
    travellerDoc(WORKSPACE_A, { passportNo: "M1234567" });

    const res = await request(makeApp(WORKSPACE_A)).get("/travellers");
    expect(res.status).toBe(200);
    expect(res.body.travellers[0].passportNo).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("M1234567");
  });

  // Phase 10b (task brief §3) — screen 3 uses this to skip asking
  // employmentStatus/sponsorType for a traveller who'll get them
  // corporate-defaulted anyway (see POST /requests' buildApplicantProfileForTraveller).
  it("flags isWorkspaceMember true only for a traveller with a linkedMemberId, never the raw id itself", async () => {
    travellerDoc(WORKSPACE_A, { firstName: "Member", linkedMemberId: new mongoose.Types.ObjectId() });
    travellerDoc(WORKSPACE_A, { firstName: "NonMember" });

    const res = await request(makeApp(WORKSPACE_A)).get("/travellers");
    const member = res.body.travellers.find((t: any) => t.name.startsWith("Member"));
    const nonMember = res.body.travellers.find((t: any) => t.name.startsWith("NonMember"));
    expect(member.isWorkspaceMember).toBe(true);
    expect(nonMember.isWorkspaceMember).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("linkedMemberId");
  });
});
