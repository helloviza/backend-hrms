// Route-level coverage for POST/GET /api/visa/requests and GET
// /api/visa/travellers. mongodb-memory-server (the real-mongod pattern
// used by utils/plutoConversation.realmongo.integration.test.ts) can't
// start in this environment — confirmed by that pre-existing test failing
// identically, not something this change caused. Instead: VisaRule,
// TravellerProfile, VisaRequest and VisaApplication are backed by a small
// generic in-memory collection (equality + $in matching, the only filter
// shapes this router issues) rather than per-call canned responses, so
// relational/tenancy behaviour (traveller-count mismatches, cross-workspace
// leakage, N travellers -> N applications) is actually exercised, not just
// asserted against a hand-picked fixture. recomputeRequestStatus is a
// spy — its own rollup logic has dedicated coverage in
// models/VisaRequest.test.ts; here we only confirm the route calls it
// (and never assigns VisaRequest.status directly).
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { rules, travellers, requests, applications, recomputeRequestStatusMock, resetStores } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      const val = rec[key];
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

  return {
    rules,
    travellers,
    requests,
    applications,
    recomputeRequestStatusMock: vi.fn().mockResolvedValue("draft"),
    resetStores() {
      rules.clear();
      travellers.clear();
      requests.clear();
      applications.clear();
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

let refSeq = 0;

vi.mock("../models/VisaRule.js", () => ({
  default: { findById: (id: any) => chainable(() => rules.get(id)) },
  VISA_PURPOSES: ["TOURIST", "BUSINESS", "TOURIST_OR_BUSINESS", "TRANSIT"],
  VISA_SERVICE_TIERS: ["STANDARD", "EXPRESS", "SUPERFAST", "PRIORITY", "SUPER_PRIORITY"],
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
    findOne: (filter: any) => chainable(() => requests.query(filter)[0] ?? null),
    find: (filter: any) => chainable(() => requests.query(filter)),
    findByIdAndUpdate: async (id: any, update: any) => requests.update(id, update?.$set || {}),
  },
  recomputeRequestStatus: (...args: any[]) => recomputeRequestStatusMock(...args),
}));

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    insertMany: async (docs: any[]) => docs.map((d) => applications.insert(d)),
    find: (filter: any) => chainable(() => applications.query(filter)),
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
function travellerDoc(workspaceId: mongoose.Types.ObjectId, overrides: Record<string, any> = {}) {
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

beforeEach(() => {
  resetStores();
  recomputeRequestStatusMock.mockClear();
  refSeq = 0;
});

describe("POST /requests", () => {
  it("rejects the whole request when one traveller belongs to another workspace — nothing is created", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A);
    const t2 = travellerDoc(WORKSPACE_B); // wrong workspace

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t1._id), String(t2._id)] });

    expect(res.status).toBe(400);
    expect(requests.store.size).toBe(0);
    expect(applications.store.size).toBe(0);
  });

  it("404s when ruleId points at a DRAFT rule", async () => {
    const rule = ruleDoc({ status: "DRAFT" });
    const t1 = travellerDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t1._id)] });

    expect(res.status).toBe(404);
    expect(requests.store.size).toBe(0);
  });

  it("404s when ruleId doesn't exist at all", async () => {
    const t1 = travellerDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(new mongoose.Types.ObjectId()), travellerProfileIds: [String(t1._id)] });

    expect(res.status).toBe(404);
  });

  it("400s on a malformed traveller id rather than a 500", async () => {
    const rule = ruleDoc();
    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: ["not-an-object-id"] });
    expect(res.status).toBe(400);
  });

  it("ruleSnapshot is a copy — mutating the source rule afterwards does not change the snapshot", async () => {
    const rule = ruleDoc({ destinationName: "Germany", embassyFeeInr: 5000 });
    const t1 = travellerDoc(WORKSPACE_A);

    const createRes = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t1._id)] });
    expect(createRes.status).toBe(201);
    const appId = createRes.body.applications[0]._id;

    // Mutate the SAME source object the route read from, including the
    // nested array — proves the snapshot doesn't hold a shared reference.
    rule.destinationName = "Germany (renamed)";
    rule.embassyFeeInr = 99999;
    rule.documentRequirements.push({ docCode: "DOC-99", requirement: "REQUIRED" });

    const stored = applications.get(appId);
    expect(stored.ruleSnapshot.destinationName).toBe("Germany");
    expect(stored.indicativeCostSnapshot.embassyFeeInr).toBe(5000);
    expect(stored.ruleSnapshot.documentRequirements).toHaveLength(1);
  });

  it("generates the reference number once, on the request, HV-prefixed", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t1._id)] });

    expect(res.status).toBe(201);
    const yy = String(new Date().getFullYear()).slice(2);
    expect(res.body.request.referenceNumber).toMatch(new RegExp(`^HV${yy}-\\d{6}$`));
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
    expect(res.body.applications.every((a: any) => String(a.requestId) === String(requestId))).toBe(true);
    expect(applications.query({ requestId })).toHaveLength(3);
    expect(requests.store.size).toBe(1);
    expect(requests.get(requestId).applicationIds).toHaveLength(3);
  });

  it("creates with a flag when a traveller's nationality doesn't normalise, instead of failing", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A, { nationality: "Atlantis" });

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t1._id)] });

    expect(res.status).toBe(201);
    expect(res.body.applications[0].nationality).toBeNull();
    expect(res.body.applications[0].nationalityUnresolved).toBe(true);
  });

  it("resolves a recognisable nationality normally, unflagged", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A, { nationality: "Indian" });

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t1._id)] });

    expect(res.status).toBe(201);
    expect(res.body.applications[0].nationality).toBe("IN");
    expect(res.body.applications[0].nationalityUnresolved).toBe(false);
  });

  it("never assigns VisaRequest.status directly — relies on the schema default, then calls recomputeRequestStatus", async () => {
    const rule = ruleDoc();
    const t1 = travellerDoc(WORKSPACE_A);

    const res = await request(makeApp(WORKSPACE_A))
      .post("/requests")
      .send({ ruleId: String(rule._id), travellerProfileIds: [String(t1._id)] });

    expect(res.status).toBe(201);
    expect(recomputeRequestStatusMock).toHaveBeenCalledTimes(1);
    expect(String(recomputeRequestStatusMock.mock.calls[0][0])).toBe(String(res.body.request._id));
  });
});

describe("GET /requests and GET /requests/:id — workspace scoping", () => {
  async function createOne(workspaceId: mongoose.Types.ObjectId, travellerOverrides: Record<string, any> = {}) {
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
    expect(String(resB.body.requests[0]._id)).not.toBe(String(resA.body.requests[0]._id));
  });

  it("list includes applications and their travellers", async () => {
    await createOne(WORKSPACE_A, { firstName: "Asha", lastName: "Rao" });

    const res = await request(makeApp(WORKSPACE_A)).get("/requests");
    expect(res.body.requests[0].applications).toHaveLength(1);
    expect(res.body.requests[0].applications[0].traveller.name).toBe("Asha Rao");
  });

  it("detail 404s for a request belonging to another workspace — never leaks it", async () => {
    const created = await createOne(WORKSPACE_A);
    const requestId = created.request._id;

    const crossTenant = await request(makeApp(WORKSPACE_B)).get(`/requests/${requestId}`);
    expect(crossTenant.status).toBe(404);

    const own = await request(makeApp(WORKSPACE_A)).get(`/requests/${requestId}`);
    expect(own.status).toBe(200);
    expect(own.body.applications).toHaveLength(1);
    expect(own.body.applications[0].traveller.passportNo).toBe("M1234567");
  });

  it("detail 404s on a well-formed but nonexistent id, not a 500", async () => {
    const res = await request(makeApp(WORKSPACE_A)).get(`/requests/${new mongoose.Types.ObjectId()}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /travellers — visa picker data", () => {
  it("returns masked passportNo (same tail-mask as workspace.travellers GET /), unmasked passportExpiry, workspace-scoped, with disambiguating fields", async () => {
    travellerDoc(WORKSPACE_A, { firstName: "Asha", passportNo: "M1234567", passportExpiry: "2030-05-01", dob: "1990-01-01" });
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
});
