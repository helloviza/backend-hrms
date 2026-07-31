// Route-level coverage for Phase 9f: an application left in action_required
// after the customer has actually uploaded reads as "blocked" on the queue
// when it isn't — this file covers the auto-response-tracking/auto-clear
// side effect on POST /applications/:applicationId/documents (routes/
// visa.ts's recordCustomerResponseDuringActionRequired). Same in-memory-
// collection approach as visa.documents.test.ts (mongodb-memory-server
// can't start in this environment), with VisaApplication's mock extended to
// cover findById/findByIdAndUpdate/clearActionRequired, which that sibling
// file's own mock doesn't need.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { applications, documents, travellerProfiles, visaRequests, travelBookings, logVisaActivityMock, resetStores } =
  vi.hoisted(() => {
    type Doc = Record<string, any>;

    function matches(rec: Doc, filter: Doc): boolean {
      return Object.entries(filter).every(([key, cond]) => {
        if (key === "$or") return (cond as Doc[]).some((sub) => matches(rec, sub));
        const val = rec[key];
        if (cond === null) return val === null || val === undefined;
        if (cond && typeof cond === "object") {
          if ("$in" in cond) return (cond.$in as any[]).map(String).includes(String(val));
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

    const applications = makeCollection();

    return {
      applications,
      documents: makeCollection(),
      travellerProfiles: makeCollection(),
      visaRequests: makeCollection(),
      travelBookings: makeCollection(),
      logVisaActivityMock: vi.fn().mockResolvedValue(undefined),
      resetStores() {
        applications.clear();
      },
    };
  });

function chainable(getResult: () => any) {
  const obj: any = { select: () => obj, sort: () => obj, limit: () => obj, lean: () => Promise.resolve(getResult()) };
  return obj;
}

vi.mock("../models/VisaRule.js", () => ({
  default: { find: () => chainable(() => []), findById: () => chainable(() => null), findOne: () => chainable(() => null) },
  VISA_PURPOSES: ["TOURIST", "BUSINESS", "TOURIST_OR_BUSINESS", "TRANSIT"],
  VISA_SERVICE_TIERS: ["STANDARD", "EXPRESS", "SUPERFAST", "PRIORITY", "SUPER_PRIORITY"],
}));

vi.mock("../models/VisaDestinationContent.js", () => ({ default: { findOne: () => chainable(() => null) } }));

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    findOne: (filter: any) => chainable(() => applications.query(filter)[0] ?? null),
    find: (filter: any) => chainable(() => applications.query(filter)),
    findById: (id: any) => chainable(() => applications.get(id)),
    findByIdAndUpdate: async (id: any, update: any) => applications.update(id, update?.$set || {}),
  },
  isTravellerErased: (application: any) => !!application?.travellerErasedAt,
  VISA_APPLICATION_ERASED_MESSAGE:
    "This traveller's data has been erased under a data-erasure request — this application can no longer be progressed.",
  // Faithful-enough replica of the real clearActionRequired (models/
  // VisaApplication.ts) for this route's purposes: restores status from
  // statusBeforeActionRequired, nulls the action_required quartet.
  // customerRespondedAt is deliberately NOT touched here — same as the
  // real implementation.
  clearActionRequired: async (id: any) => {
    const rec = applications.get(id);
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
}));

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    findOne: (filter: any) => chainable(() => visaRequests.query(filter)[0] ?? null),
    findById: (id: any) => chainable(() => visaRequests.get(id)),
  },
  recomputeRequestStatus: vi.fn().mockResolvedValue("active"),
}));

vi.mock("../models/VisaDocument.js", () => ({
  default: {
    find: (filter: any) => chainable(() => documents.query(filter)),
    findOne: (filter: any) => chainable(() => documents.query(filter).sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null),
    create: async (input: any) => documents.insert(input),
  },
  VISA_DOCUMENT_EXTRACTION_STATUSES: ["PENDING", "PROCESSING", "EXTRACTED", "FAILED"],
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: { findOne: (filter: any) => chainable(() => travellerProfiles.query(filter)[0] ?? null) },
}));

vi.mock("../models/TravelBooking.js", () => ({
  default: { find: (filter: any) => chainable(() => travelBookings.query(filter)) },
}));

vi.mock("../models/VisaActivityLog.js", () => ({
  logVisaActivity: (...args: any[]) => logVisaActivityMock(...args),
  VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES: new Set(),
  default: { find: () => chainable(() => []), countDocuments: async () => 0 },
}));

vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn().mockResolvedValue({ bucket: "test-bucket", key: "visa-applications/fake/key.pdf", url: "https://example.com/fake" }),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn().mockResolvedValue("https://example.com/presigned-url") }));
vi.mock("../utils/logger.js", () => ({ default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock("../services/visaPassportExtraction.js", () => ({
  runVisaPassportExtraction: vi.fn().mockResolvedValue(undefined),
  PASSPORT_DOC_CODE: "DOC-01",
}));

import express from "express";
import request from "supertest";
import router from "./visa.js";

const WORKSPACE_A = new mongoose.Types.ObjectId();
const USER_A = new mongoose.Types.ObjectId();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(USER_A), roles: ["EMPLOYEE"] };
    req.workspaceObjectId = WORKSPACE_A;
    req.workspaceId = String(WORKSPACE_A);
    req.workspace = { _id: WORKSPACE_A, status: "ACTIVE" };
    next();
  });
  app.use("/", router);
  return app;
}

// Two REQUIRED documents (DOC-02 Photograph, DOC-03 Bank Statement) so a
// single upload can be exercised as either "complete" (only one required)
// or "partial" (one of two still missing) depending on the fixture.
function applicationFixture(overrides: Record<string, any> = {}) {
  return applications.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE_A,
    requestId: new mongoose.Types.ObjectId(),
    travellerProfileId: new mongoose.Types.ObjectId(),
    status: "action_required",
    statusBeforeActionRequired: "docs_under_review",
    actionRequiredReason: "Missing bank statement",
    customerRespondedAt: null,
    linkedBookings: [],
    ruleSnapshot: {
      documentRequirements: [{ docCode: "DOC-03", requirement: "REQUIRED" }],
    },
    ...overrides,
  });
}

function uploadRequest(app: any, applicationId: any, docCode: string) {
  return request(app)
    .post(`/applications/${applicationId}/documents`)
    .field("docCode", docCode)
    .attach("file", Buffer.from("fake-bytes"), "statement.pdf");
}

beforeEach(() => {
  resetStores();
  documents.clear();
  travellerProfiles.clear();
  visaRequests.clear();
  travelBookings.clear();
  logVisaActivityMock.mockClear();
});

describe("customer upload during action_required — Phase 9f", () => {
  it("stamps customerRespondedAt on upload", async () => {
    const app = applicationFixture(); // single REQUIRED doc: DOC-03
    const res = await uploadRequest(makeApp(), app._id, "DOC-03");

    expect(res.status).toBe(201);
    expect(applications.get(app._id).customerRespondedAt).toBeInstanceOf(Date);
  });

  it("complete response auto-clears to statusBeforeActionRequired", async () => {
    const app = applicationFixture(); // single REQUIRED doc: DOC-03
    const res = await uploadRequest(makeApp(), app._id, "DOC-03");

    expect(res.status).toBe(201);
    const stored = applications.get(app._id);
    expect(stored.status).toBe("docs_under_review");
    expect(stored.actionRequiredReason).toBeNull();
    expect(stored.statusBeforeActionRequired).toBeNull();
    expect(stored.customerRespondedAt).toBeInstanceOf(Date); // survives the clear
  });

  it("partial response stays in action_required with the stamp set", async () => {
    // TWO required docs — uploading only one leaves DOC-04 outstanding.
    const app = applicationFixture({
      ruleSnapshot: {
        documentRequirements: [
          { docCode: "DOC-03", requirement: "REQUIRED" },
          { docCode: "DOC-04", requirement: "REQUIRED" },
        ],
      },
    });

    const res = await uploadRequest(makeApp(), app._id, "DOC-03");

    expect(res.status).toBe(201);
    const stored = applications.get(app._id);
    expect(stored.status).toBe("action_required"); // NOT cleared — DOC-04 still missing
    expect(stored.customerRespondedAt).toBeInstanceOf(Date); // but the response IS recorded
  });

  it("auto-clear logs CUSTOMER_RESPONDED as CUSTOMER and ACTION_REQUIRED_AUTO_CLEARED as SYSTEM", async () => {
    const app = applicationFixture(); // single REQUIRED doc — completes on this upload
    const res = await uploadRequest(makeApp(), app._id, "DOC-03");
    expect(res.status).toBe(201);

    const eventTypes = logVisaActivityMock.mock.calls.map((c: any[]) => c[0].eventType);
    expect(eventTypes).toContain("CUSTOMER_RESPONDED");
    expect(eventTypes).toContain("ACTION_REQUIRED_AUTO_CLEARED");

    const respondedCall = logVisaActivityMock.mock.calls.find((c: any[]) => c[0].eventType === "CUSTOMER_RESPONDED")![0];
    expect(respondedCall.actorType).toBe("CUSTOMER");
    expect(String(respondedCall.actorUserId)).toBe(String(USER_A));

    const autoClearCall = logVisaActivityMock.mock.calls.find((c: any[]) => c[0].eventType === "ACTION_REQUIRED_AUTO_CLEARED")![0];
    expect(autoClearCall.actorType).toBe("SYSTEM");
    expect(autoClearCall.actorUserId).toBeNull(); // the system inferred it, not the customer
  });

  it("a partial response never logs ACTION_REQUIRED_AUTO_CLEARED", async () => {
    const app = applicationFixture({
      ruleSnapshot: {
        documentRequirements: [
          { docCode: "DOC-03", requirement: "REQUIRED" },
          { docCode: "DOC-04", requirement: "REQUIRED" },
        ],
      },
    });
    const res = await uploadRequest(makeApp(), app._id, "DOC-03");
    expect(res.status).toBe(201);

    const eventTypes = logVisaActivityMock.mock.calls.map((c: any[]) => c[0].eventType);
    expect(eventTypes).toContain("CUSTOMER_RESPONDED");
    expect(eventTypes).not.toContain("ACTION_REQUIRED_AUTO_CLEARED");
  });

  it("uploads outside action_required don't stamp anything", async () => {
    const app = applicationFixture({ status: "submitted", statusBeforeActionRequired: null });
    const res = await uploadRequest(makeApp(), app._id, "DOC-03");

    expect(res.status).toBe(201);
    expect(applications.get(app._id).customerRespondedAt).toBeNull();
    const eventTypes = logVisaActivityMock.mock.calls.map((c: any[]) => c[0].eventType);
    expect(eventTypes).not.toContain("CUSTOMER_RESPONDED");
    expect(eventTypes).not.toContain("ACTION_REQUIRED_AUTO_CLEARED");
  });

  it("a linked booking counts as satisfying a REQUIRED doc, same as an upload", async () => {
    const app = applicationFixture({
      ruleSnapshot: {
        documentRequirements: [
          { docCode: "DOC-03", requirement: "REQUIRED" },
          { docCode: "DOC-07", requirement: "REQUIRED" }, // Hotel Booking — satisfiable via a linked booking
        ],
      },
      linkedBookings: [{ bookingId: new mongoose.Types.ObjectId(), service: "HOTEL", linkedAt: new Date(), linkedByUserId: USER_A }],
    });

    const res = await uploadRequest(makeApp(), app._id, "DOC-03");
    expect(res.status).toBe(201);
    // DOC-03 uploaded, DOC-07 satisfied by the linked booking -> nothing outstanding -> auto-clears.
    expect(applications.get(app._id).status).toBe("docs_under_review");
  });
});
