// Route-level coverage for Phase 4c: PATCH /applications/:applicationId/
// linked-bookings, and the satisfiedByBooking checklist hydration it feeds
// (routes/visa.ts's hydrateDocumentRequirements via GET /requests/:id).
// Same in-memory collection approach as visa.documents.test.ts/
// visa.passportExtraction.test.ts. VisaApplication.findOne
// here uses the dual-mode "live doc with .save(), or .lean() copy" result
// from visa.passportExtraction.test.ts, since the PATCH route (like PATCH
// /documents/:id/extracted-fields) fetches a live document and saves it —
// every other collection only ever needs the .lean() path.
//
// NOTE: that approach is a convention, not a constraint — mongodb-memory-
// server does start here (see utils/visaPredicatePersistence.test.ts), so
// real persistence is available if this test ever needs schema defaults or
// casting to be real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

function toTime(v: any): number {
  return v instanceof Date ? v.getTime() : v;
}

function matches(rec: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") {
      return (cond as Record<string, any>[]).some((sub) => matches(rec, sub));
    }
    const val = rec[key];
    if (cond && typeof cond === "object" && cond !== null) {
      if ("$in" in cond) {
        const set = new Set((cond.$in as any[]).map((v) => String(v)));
        return set.has(String(val));
      }
      if ("$regex" in cond) {
        return (cond.$regex as RegExp).test(String(val ?? ""));
      }
      if ("$gte" in cond || "$lte" in cond) {
        if (val == null) return false;
        if ("$gte" in cond && !(toTime(val) >= toTime(cond.$gte))) return false;
        if ("$lte" in cond && !(toTime(val) <= toTime(cond.$lte))) return false;
        return true;
      }
    }
    return String(val) === String(cond);
  });
}

const {
  applications,
  documents,
  travellerProfiles,
  visaRequests,
  travelBookings,
  resetStores,
} = vi.hoisted(() => {
  type Doc = Record<string, any>;

  // Read-only chain — every non-VisaApplication collection only needs
  // .select()/.sort()/.lean() (never .save()).
  function chainable(getResult: () => any) {
    const obj: any = {
      select: () => obj,
      sort: () => obj,
      limit: () => obj,
      lean: () => Promise.resolve(getResult()),
    };
    return obj;
  }

  // Live-or-lean — works BOTH as `await X.findOne(f)` (resolves to the
  // live record, with .save() intact — needed by the linked-bookings
  // PATCH route, which never calls .lean()) AND as
  // `await X.findOne(f).select(...).lean()` (a plain-object copy).
  function liveOrLean(rec: Doc | null) {
    const promise: any = Promise.resolve(rec);
    const leanCopy = rec ? { ...rec } : null;
    promise.select = () => promise;
    promise.sort = () => promise;
    promise.lean = () => Promise.resolve(leanCopy);
    return promise;
  }

  function makeCollection(opts: { live?: boolean } = {}) {
    const store = new Map<string, Doc>();
    return {
      store,
      insert(doc: Doc): Doc {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const record: Doc = { ...doc, _id: id };
        if (opts.live) {
          record.save = vi.fn().mockResolvedValue(undefined);
        }
        store.set(String(id), record);
        return record;
      },
      query(filter: Doc): Doc[] {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      findOne(filter: Doc) {
        const rec = this.query(filter)[0] ?? null;
        return opts.live ? liveOrLean(rec) : chainable(() => (rec ? { ...rec } : null));
      },
      find(filter: Doc) {
        return chainable(() => this.query(filter).map((r) => ({ ...r })));
      },
      clear() {
        store.clear();
      },
    };
  }

  const applications = makeCollection({ live: true });
  const documents = makeCollection();
  const travellerProfiles = makeCollection();
  const visaRequests = makeCollection();
  const travelBookings = makeCollection();

  return {
    applications,
    documents,
    travellerProfiles,
    visaRequests,
    travelBookings,
    resetStores() {
      applications.clear();
      documents.clear();
      travellerProfiles.clear();
      visaRequests.clear();
      travelBookings.clear();
    },
  };
});

vi.mock("../models/VisaRule.js", () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }), findById: () => ({ lean: () => Promise.resolve(null) }), findOne: () => ({ lean: () => Promise.resolve(null) }) },
  VISA_PURPOSES: ["TOURIST", "BUSINESS", "TOURIST_OR_BUSINESS", "TRANSIT"],
  VISA_SERVICE_TIERS: ["STANDARD", "EXPRESS", "SUPERFAST", "PRIORITY", "SUPER_PRIORITY"],
}));

vi.mock("../models/VisaDestinationContent.js", () => ({
  default: { findOne: () => ({ lean: () => Promise.resolve(null) }) },
}));

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    findOne: (filter: any) => visaRequests.findOne(filter),
    findById: (id: any) => chainableForId(visaRequests, id),
    create: async (input: any) => visaRequests.insert(input),
  },
  recomputeRequestStatus: vi.fn().mockResolvedValue("draft"),
}));

function chainableForId(collection: any, id: any) {
  return { lean: () => Promise.resolve(collection.store.get(String(id)) ?? null) };
}

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    findOne: (filter: any) => applications.findOne(filter),
    find: (filter: any) => applications.find(filter),
    insertMany: async (docs: any[]) => docs.map((d) => applications.insert(d)),
  },
  isTravellerErased: (application: any) => !!application?.travellerErasedAt,
  VISA_APPLICATION_ERASED_MESSAGE:
    "This traveller's data has been erased under a data-erasure request — this application can no longer be progressed.",
}));

vi.mock("../models/VisaDocument.js", () => ({
  default: {
    find: (filter: any) => documents.find(filter),
    findOne: (filter: any) => documents.findOne(filter),
    create: async (input: any) => documents.insert(input),
  },
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    findOne: (filter: any) => travellerProfiles.findOne(filter),
    find: (filter: any) => travellerProfiles.find(filter),
  },
}));

vi.mock("../models/TravelBooking.js", () => ({
  default: {
    find: (filter: any) => travelBookings.find(filter),
  },
}));

// GET /requests/:id now reads back a trimmed activity feed — mocked to an
// empty list so tests never touch the real (unconnected, in this test
// environment) VisaActivityLog collection.
vi.mock("../models/VisaActivityLog.js", () => ({
  logVisaActivity: vi.fn().mockResolvedValue(undefined),
  VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES: new Set(),
  default: { find: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }), countDocuments: async () => 0 },
}));

vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: vi.fn() }));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn() }));
vi.mock("../utils/logger.js", () => ({
  default: { child: () => ({ info: vi.fn(), error: vi.fn() }) },
}));
vi.mock("../services/visaPassportExtraction.js", () => ({
  runVisaPassportExtraction: vi.fn().mockResolvedValue(undefined),
  PASSPORT_DOC_CODE: "DOC-01",
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

const DOC_REQUIREMENTS = [
  { docCode: "DOC-08", requirement: "REQUIRED" }, // Flight Itinerary
  { docCode: "DOC-07", requirement: "REQUIRED" }, // Hotel Booking
  { docCode: "DOC-01", requirement: "REQUIRED" }, // Passport — unrelated control
];

function setupTravellerAndRequest(workspaceId: mongoose.Types.ObjectId, opts: { email?: string | null } = {}) {
  const travellerId = new mongoose.Types.ObjectId();
  travellerProfiles.insert({
    _id: travellerId,
    workspaceId,
    firstName: "Asha",
    lastName: "Rao",
    email: opts.email === undefined ? "asha@example.com" : opts.email,
  });
  const requestId = new mongoose.Types.ObjectId();
  visaRequests.insert({
    _id: requestId,
    workspaceId,
    travelDateFrom: new Date("2026-08-01"),
    travelDateTo: new Date("2026-08-10"),
    applicationIds: [],
  });
  return { travellerId, requestId };
}

function applicationDoc(workspaceId: mongoose.Types.ObjectId, overrides: Record<string, any> = {}) {
  return applications.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId,
    requestId: new mongoose.Types.ObjectId(),
    travellerProfileId: new mongoose.Types.ObjectId(),
    status: "draft",
    ruleSnapshot: { documentRequirements: DOC_REQUIREMENTS },
    indicativeCostSnapshot: { displayMode: "FIXED", totalInr: 1000 },
    linkedBookings: [],
    ...overrides,
  });
}

function flightBooking(workspaceId: mongoose.Types.ObjectId, overrides: Record<string, any> = {}) {
  return travelBookings.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId,
    isActive: true,
    service: "FLIGHT",
    travellerEmail: "asha@example.com",
    travelDate: new Date("2026-08-03"),
    travelDateEnd: new Date("2026-08-03"),
    destination: "DXB",
    origin: "BOM",
    status: "CONFIRMED",
    bookedAt: new Date("2026-07-01"),
    referenceModel: "SBTBooking",
    ...overrides,
  });
}

beforeEach(() => {
  resetStores();
});

describe("PATCH /applications/:applicationId/linked-bookings", () => {
  it("404s for an application belonging to another workspace", async () => {
    const app = applicationDoc(WORKSPACE_B);
    const res = await request(makeApp(WORKSPACE_A))
      .patch(`/applications/${app._id}/linked-bookings`)
      .send({ bookings: [{ bookingId: String(new mongoose.Types.ObjectId()), service: "FLIGHT" }] });
    expect(res.status).toBe(404);
  });

  it("400s when bookings is missing or empty", async () => {
    const { travellerId, requestId } = setupTravellerAndRequest(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, { travellerProfileId: travellerId, requestId });

    const res1 = await request(makeApp(WORKSPACE_A)).patch(`/applications/${app._id}/linked-bookings`).send({});
    expect(res1.status).toBe(400);

    const res2 = await request(makeApp(WORKSPACE_A))
      .patch(`/applications/${app._id}/linked-bookings`)
      .send({ bookings: [] });
    expect(res2.status).toBe(400);
  });

  it("400s on a malformed bookingId or an unrecognised service", async () => {
    const { travellerId, requestId } = setupTravellerAndRequest(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, { travellerProfileId: travellerId, requestId });

    const badId = await request(makeApp(WORKSPACE_A))
      .patch(`/applications/${app._id}/linked-bookings`)
      .send({ bookings: [{ bookingId: "not-an-id", service: "FLIGHT" }] });
    expect(badId.status).toBe(400);

    const booking = flightBooking(WORKSPACE_A);
    const badService = await request(makeApp(WORKSPACE_A))
      .patch(`/applications/${app._id}/linked-bookings`)
      .send({ bookings: [{ bookingId: String(booking._id), service: "TRAIN" }] });
    expect(badService.status).toBe(400);
  });

  it("400s and never links a bookingId that doesn't belong to this applicant — never trusts the client", async () => {
    const { travellerId, requestId } = setupTravellerAndRequest(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, { travellerProfileId: travellerId, requestId });

    // Real booking, but for a different traveller's email entirely.
    const strangersBooking = flightBooking(WORKSPACE_A, { travellerEmail: "someone-else@example.com" });

    const res = await request(makeApp(WORKSPACE_A))
      .patch(`/applications/${app._id}/linked-bookings`)
      .send({ bookings: [{ bookingId: String(strangersBooking._id), service: "FLIGHT" }] });

    expect(res.status).toBe(400);
    const stored = applications.store.get(String(app._id));
    expect(stored.linkedBookings).toEqual([]);
  });

  it("400s when the supplied service doesn't match the booking's actual service", async () => {
    const { travellerId, requestId } = setupTravellerAndRequest(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, { travellerProfileId: travellerId, requestId });
    const booking = flightBooking(WORKSPACE_A); // service: FLIGHT

    const res = await request(makeApp(WORKSPACE_A))
      .patch(`/applications/${app._id}/linked-bookings`)
      .send({ bookings: [{ bookingId: String(booking._id), service: "HOTEL" }] });

    expect(res.status).toBe(400);
  });

  it("links a matching booking, is idempotent on re-link, and creates no VisaDocument", async () => {
    const { travellerId, requestId } = setupTravellerAndRequest(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, { travellerProfileId: travellerId, requestId });
    const booking = flightBooking(WORKSPACE_A);

    const res1 = await request(makeApp(WORKSPACE_A))
      .patch(`/applications/${app._id}/linked-bookings`)
      .send({ bookings: [{ bookingId: String(booking._id), service: "FLIGHT" }] });

    expect(res1.status).toBe(200);
    expect(res1.body.linkedBookings).toHaveLength(1);
    expect(res1.body.linkedBookings[0].service).toBe("FLIGHT");
    expect(String(res1.body.linkedBookings[0].bookingId)).toBe(String(booking._id));
    expect(documents.store.size).toBe(0);

    // Re-linking the same booking must not create a duplicate entry.
    const res2 = await request(makeApp(WORKSPACE_A))
      .patch(`/applications/${app._id}/linked-bookings`)
      .send({ bookings: [{ bookingId: String(booking._id), service: "FLIGHT" }] });

    expect(res2.status).toBe(200);
    expect(res2.body.linkedBookings).toHaveLength(1);
    expect(documents.store.size).toBe(0);
  });
});

describe("Linked bookings satisfy the checklist without an upload", () => {
  it("GET /requests/:id marks DOC-08 (Flight Itinerary) satisfiedByBooking after linking, leaves DOC-07/DOC-01 untouched, and never creates a VisaDocument", async () => {
    const { travellerId, requestId } = setupTravellerAndRequest(WORKSPACE_A);
    const app = applicationDoc(WORKSPACE_A, { travellerProfileId: travellerId, requestId });
    const booking = flightBooking(WORKSPACE_A);

    const linkRes = await request(makeApp(WORKSPACE_A))
      .patch(`/applications/${app._id}/linked-bookings`)
      .send({ bookings: [{ bookingId: String(booking._id), service: "FLIGHT" }] });
    expect(linkRes.status).toBe(200);

    const detailRes = await request(makeApp(WORKSPACE_A)).get(`/requests/${requestId}`);
    expect(detailRes.status).toBe(200);

    const hydratedApp = detailRes.body.applications.find((a: any) => a._id === String(app._id));
    expect(hydratedApp.linkedBookings).toHaveLength(1);

    const reqs = hydratedApp.ruleSnapshot.documentRequirements;
    const flightReq = reqs.find((r: any) => r.docCode === "DOC-08");
    const hotelReq = reqs.find((r: any) => r.docCode === "DOC-07");
    const passportReq = reqs.find((r: any) => r.docCode === "DOC-01");

    expect(flightReq.satisfiedByBooking).toBe(true);
    expect(hotelReq.satisfiedByBooking).toBe(false);
    expect(passportReq.satisfiedByBooking).toBe(false);

    // No file was ever uploaded — the requirement is satisfied purely by
    // the reference on VisaApplication.linkedBookings.
    expect(documents.store.size).toBe(0);
  });
});
