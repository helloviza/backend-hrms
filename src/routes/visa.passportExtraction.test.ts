// Route-level coverage for Phase 4b: the fire-and-forget extraction trigger
// on POST .../documents (gated strictly to the passport docCode) and the
// user-confirmed write-back route, PATCH /documents/:documentId/extracted-
// fields. services/visaPassportExtraction.js is mocked here — this file
// tests ROUTE behaviour (gating, confirmation, ownership, field mapping),
// not the extraction pipeline itself (see services/visaPassportExtraction.
// test.ts for that, and utils/mrz.test.ts for the parser). Same in-memory
// collection approach as routes/visa.documents.test.ts; mongodb-memory-
// server can't start in this sandbox (confirmed pre-existing, unrelated).
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

function matches(rec: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const val = rec[key];
    if (cond === null) return val === null || val === undefined;
    return String(val) === String(cond);
  });
}

const { applications, documents, travellerProfiles, runVisaPassportExtractionMock, uploadBufferToS3Mock, visaLoggerInfoMock, visaLoggerErrorMock } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  // A findOne() result that works BOTH as `await X.findOne(f)` (resolves to
  // the live record, with .save() intact — needed by the PATCH route,
  // which never calls .lean()) AND as `await X.findOne(f).select(...).sort
  // (...).lean()` (resolves to a plain-object copy — needed by the other
  // routes in this file, which always do call .lean()).
  function queryResult(rec: Doc | null) {
    const promise: any = Promise.resolve(rec);
    const leanCopy = rec ? { ...rec } : null;
    promise.select = () => promise;
    promise.sort = () => promise;
    promise.lean = () => Promise.resolve(leanCopy);
    return promise;
  }

  function makeCollection() {
    const store = new Map<string, Doc>();
    return {
      store,
      insert(doc: Doc): Doc {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const record: Doc = { ...doc, _id: id };
        store.set(String(id), record);
        return record;
      },
      query(filter: Doc): Doc[] {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      findOne(filter: Doc) {
        return queryResult(this.query(filter)[0] ?? null);
      },
      clear() {
        store.clear();
      },
    };
  }

  const applications = makeCollection();
  const documents = makeCollection();
  const travellerProfiles = makeCollection();

  return {
    applications,
    documents,
    travellerProfiles,
    runVisaPassportExtractionMock: vi.fn().mockResolvedValue(undefined),
    uploadBufferToS3Mock: vi.fn().mockResolvedValue({ bucket: "test-bucket", key: "visa-applications/fake/key.jpg", url: "https://example.com/fake" }),
    visaLoggerInfoMock: vi.fn(),
    visaLoggerErrorMock: vi.fn(),
  };
});

vi.mock("../models/VisaRule.js", () => ({
  default: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }), findById: () => ({ lean: () => Promise.resolve(null) }), findOne: () => ({ lean: () => Promise.resolve(null) }) },
  VISA_PURPOSES: ["TOURIST", "BUSINESS", "TOURIST_OR_BUSINESS", "TRANSIT"],
  VISA_SERVICE_TIERS: ["STANDARD", "EXPRESS", "SUPERFAST", "PRIORITY", "SUPER_PRIORITY"],
}));

vi.mock("../models/VisaDestinationContent.js", () => ({
  default: { findOne: () => ({ lean: () => Promise.resolve(null) }) },
}));

vi.mock("../models/VisaRequest.js", () => ({
  default: { findOne: () => ({ lean: () => Promise.resolve(null) }), findById: () => ({ lean: () => Promise.resolve(null) }), create: async (input: any) => input },
  recomputeRequestStatus: vi.fn().mockResolvedValue("draft"),
}));

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    findOne: (filter: any) => applications.findOne(filter),
    find: (filter: any) => ({ lean: () => Promise.resolve(applications.query(filter)) }),
  },
  isTravellerErased: (application: any) => !!application?.travellerErasedAt,
  VISA_APPLICATION_ERASED_MESSAGE:
    "This traveller's data has been erased under a data-erasure request — this application can no longer be progressed.",
}));

vi.mock("../models/VisaDocument.js", () => ({
  default: {
    findOne: (filter: any) => documents.findOne(filter),
    find: (filter: any) => ({ sort: () => ({ lean: () => Promise.resolve(documents.query(filter)) }) }),
    create: async (input: any) => documents.insert({ extractedFields: [], reviewStatus: "PENDING", deletedAt: null, save: vi.fn().mockResolvedValue(undefined), ...input }),
  },
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    findOne: (filter: any) => travellerProfiles.findOne(filter),
    find: (filter: any) => ({ select: () => ({ sort: () => ({ lean: () => Promise.resolve(travellerProfiles.query(filter)) }) }) }),
  },
}));

vi.mock("../models/TravelBooking.js", () => ({
  default: { find: () => ({ select: () => ({ sort: () => ({ lean: () => Promise.resolve([]) }) }) }) },
}));

vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: (...args: any[]) => uploadBufferToS3Mock(...args),
}));

vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: vi.fn().mockResolvedValue("https://example.com/presigned-url"),
}));

vi.mock("../utils/logger.js", () => ({
  default: { child: () => ({ info: (...args: any[]) => visaLoggerInfoMock(...args), error: (...args: any[]) => visaLoggerErrorMock(...args) }) },
}));

vi.mock("../services/visaPassportExtraction.js", () => ({
  runVisaPassportExtraction: (...args: any[]) => runVisaPassportExtractionMock(...args),
  PASSPORT_DOC_CODE: "DOC-01",
}));

// Upload and the extracted-fields confirmation both log a VisaActivityLog
// row — mocked to a no-op so tests never touch the real (unconnected, in
// this test environment) VisaActivityLog collection.
vi.mock("../models/VisaActivityLog.js", () => ({
  logVisaActivity: vi.fn().mockResolvedValue(undefined),
  VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES: new Set(),
  default: { find: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }), countDocuments: async () => 0 },
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

function applicationDoc(workspaceId: mongoose.Types.ObjectId, overrides: Record<string, any> = {}) {
  return applications.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId,
    requestId: new mongoose.Types.ObjectId(),
    travellerProfileId: new mongoose.Types.ObjectId(),
    status: "draft",
    ...overrides,
  });
}

function travellerDoc(workspaceId: mongoose.Types.ObjectId, overrides: Record<string, any> = {}) {
  return travellerProfiles.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId,
    firstName: "Anna",
    lastName: "Eriksson",
    passportNo: null,
    passportExpiry: null,
    passportIssueCountry: null,
    passportIssueDate: null,
    nationality: null,
    dob: null,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

function documentDoc(workspaceId: mongoose.Types.ObjectId, applicationId: any, overrides: Record<string, any> = {}) {
  return documents.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId,
    applicationId,
    docCode: "DOC-01",
    version: 1,
    s3Key: "visa-applications/wsA/app/key.jpg",
    originalFilename: "passport.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 10,
    uploadedByUserId: USER_A,
    extractionStatus: "COMPLETED",
    extractedFields: [
      { key: "documentNumber", value: "L898902C3" },
      { key: "check_composite", value: "passed" },
    ],
    extractionConfidence: "high",
    reviewStatus: "PENDING",
    deletedAt: null,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

beforeEach(() => {
  applications.clear();
  documents.clear();
  travellerProfiles.clear();
  runVisaPassportExtractionMock.mockClear();
  uploadBufferToS3Mock.mockClear();
  visaLoggerInfoMock.mockClear();
  visaLoggerErrorMock.mockClear();
  uploadBufferToS3Mock.mockResolvedValue({ bucket: "test-bucket", key: "visa-applications/fake/key.jpg", url: "https://example.com/fake" });
});

describe("POST /applications/:applicationId/documents — extraction trigger gating", () => {
  it("fires extraction for the passport docCode (DOC-01)", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/applications/${app._id}/documents`)
      .field("docCode", "DOC-01")
      .attach("file", Buffer.from("fake-jpeg"), { filename: "passport.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(201);
    expect(runVisaPassportExtractionMock).toHaveBeenCalledTimes(1);
    expect(runVisaPassportExtractionMock).toHaveBeenCalledWith(res.body.document.id);
  });

  it("never fires extraction for a non-passport docCode", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/applications/${app._id}/documents`)
      .field("docCode", "DOC-07")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "hotel.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(runVisaPassportExtractionMock).not.toHaveBeenCalled();
  });

  it("the upload response never waits on extraction (still resolves even if the trigger rejects)", async () => {
    runVisaPassportExtractionMock.mockRejectedValueOnce(new Error("boom"));
    const app = applicationDoc(WORKSPACE_A);
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/applications/${app._id}/documents`)
      .field("docCode", "DOC-01")
      .attach("file", Buffer.from("fake-jpeg"), { filename: "passport.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(201);
  });
});

describe("PATCH /documents/:documentId/extracted-fields", () => {
  it("404s on a malformed documentId", async () => {
    const res = await request(makeApp(WORKSPACE_A))
      .patch(`/documents/not-an-id/extracted-fields`)
      .send({ confirmed: true, fields: {} });
    expect(res.status).toBe(404);
  });

  it("404s for a document belonging to another workspace — never writes to the traveller", async () => {
    const app = applicationDoc(WORKSPACE_B);
    const traveller = travellerDoc(WORKSPACE_B, { _id: app.travellerProfileId });
    const doc = documentDoc(WORKSPACE_B, app._id);

    const res = await request(makeApp(WORKSPACE_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({ confirmed: true, fields: { documentNumber: "L898902C3" } });

    expect(res.status).toBe(404);
    expect(traveller.save).not.toHaveBeenCalled();
  });

  it("400s when confirmed is not exactly true — write-back never fires without explicit confirmation", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const traveller = travellerDoc(WORKSPACE_A, { _id: app.travellerProfileId });
    const doc = documentDoc(WORKSPACE_A, app._id);

    const resMissing = await request(makeApp(WORKSPACE_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({ fields: { documentNumber: "L898902C3" } });
    expect(resMissing.status).toBe(400);

    const resFalse = await request(makeApp(WORKSPACE_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({ confirmed: false, fields: { documentNumber: "L898902C3" } });
    expect(resFalse.status).toBe(400);

    const resTruthy = await request(makeApp(WORKSPACE_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({ confirmed: "true", fields: { documentNumber: "L898902C3" } }); // string, not boolean true
    expect(resTruthy.status).toBe(400);

    expect(traveller.save).not.toHaveBeenCalled();
    expect(doc.reviewStatus).toBe("PENDING");
  });

  it("400s for a non-passport document — only passport fields are ever written back", async () => {
    const app = applicationDoc(WORKSPACE_A);
    travellerDoc(WORKSPACE_A, { _id: app.travellerProfileId });
    const doc = documentDoc(WORKSPACE_A, app._id, { docCode: "DOC-07" });

    const res = await request(makeApp(WORKSPACE_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({ confirmed: true, fields: { documentNumber: "L898902C3" } });

    expect(res.status).toBe(400);
  });

  it("400s when a field fails MRZ conversion, and writes nothing", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const traveller = travellerDoc(WORKSPACE_A, { _id: app.travellerProfileId });
    const doc = documentDoc(WORKSPACE_A, app._id);

    const res = await request(makeApp(WORKSPACE_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({ confirmed: true, fields: { dateOfExpiry: "not-a-date" } });

    expect(res.status).toBe(400);
    expect(traveller.save).not.toHaveBeenCalled();
  });

  it("400s when no recognised passport fields are provided", async () => {
    const app = applicationDoc(WORKSPACE_A);
    travellerDoc(WORKSPACE_A, { _id: app.travellerProfileId });
    const doc = documentDoc(WORKSPACE_A, app._id);

    const res = await request(makeApp(WORKSPACE_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({ confirmed: true, fields: { someUnknownKey: "x" } });

    expect(res.status).toBe(400);
  });

  it("re-verifies application ownership at this hop — a document whose application belongs to another workspace 404s", async () => {
    const appOtherWs = applicationDoc(WORKSPACE_B);
    // Document itself claims WORKSPACE_A (simulating a stale/inconsistent
    // record) but its applicationId points at a WORKSPACE_B application —
    // the PATCH route must re-check the application's workspace, not trust
    // the document's own workspaceId field alone.
    const doc = documentDoc(WORKSPACE_A, appOtherWs._id);

    const res = await request(makeApp(WORKSPACE_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({ confirmed: true, fields: { documentNumber: "L898902C3" } });

    expect(res.status).toBe(404);
  });

  it("writes confirmed fields through to TravellerProfile: normalises ISO3->ISO2 and resolves MRZ dates", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const traveller = travellerDoc(WORKSPACE_A, { _id: app.travellerProfileId });
    const doc = documentDoc(WORKSPACE_A, app._id);

    const res = await request(makeApp(WORKSPACE_A, USER_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({
        confirmed: true,
        fields: {
          documentNumber: "L898902C3",
          dateOfExpiry: "300101", // MRZ YYMMDD, expiry always resolves to the current century
          dateOfBirth: "850315", // unambiguously past — no century-boundary ambiguity
          issuingState: "IND", // ISO3, must normalise to ISO2
          nationality: "IND",
          passportIssueDate: "2020-05-01", // not on the MRZ at all — accepted as already YYYY-MM-DD
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.traveller.passportNo).toBe("L898902C3");
    expect(res.body.traveller.passportExpiry).toBe("2030-01-01");
    expect(res.body.traveller.dob).toBe("1985-03-15");
    expect(res.body.traveller.passportIssueCountry).toBe("IN");
    expect(res.body.traveller.nationality).toBe("IN");
    expect(res.body.traveller.passportIssueDate).toBe("2020-05-01");

    expect(traveller.save).toHaveBeenCalledTimes(1);
    expect(traveller.passportNo).toBe("L898902C3");
    expect(traveller.passportExpiry).toBe("2030-01-01");
    expect(traveller.passportIssueCountry).toBe("IN");

    expect(doc.reviewStatus).toBe("VERIFIED");
    expect(String(doc.reviewedBy)).toBe(String(USER_A));
    const docNumberField = doc.extractedFields.find((f: any) => f.key === "documentNumber");
    expect(docNumberField.value).toBe("L898902C3");
    // check_* entries survive the merge untouched.
    expect(doc.extractedFields.find((f: any) => f.key === "check_composite").value).toBe("passed");

    expect(visaLoggerInfoMock).toHaveBeenCalledTimes(1);
    const [, meta] = visaLoggerInfoMock.mock.calls[0];
    expect(meta.documentId).toBe(String(doc._id));
    expect(meta.travellerProfileId).toBe(String(traveller._id));
    expect(meta.confirmedBy).toBe(String(USER_A));
    expect(Array.isArray(meta.changed)).toBe(true);
  });

  // Task brief: identity mismatches (utils/passportCrossCheck.ts's
  // crossCheckPassportIdentity, stored by services/visaPassportExtraction.ts
  // under identity_mismatch_* keys) must NEVER block confirmation — they're
  // informational, surfaced to the user, never a gate this route enforces.
  // Nothing in the PATCH handler reads an identity_mismatch_* key at all;
  // this proves that by construction, not just by absence of a check.
  it("confirms successfully even when identity_mismatch_* fields are present on the document, and leaves them untouched", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const traveller = travellerDoc(WORKSPACE_A, { _id: app.travellerProfileId, lastName: "Sharma" });
    const doc = documentDoc(WORKSPACE_A, app._id, {
      extractedFields: [
        { key: "documentNumber", value: "L898902C3" },
        { key: "check_composite", value: "passed" },
        { key: "identity_mismatch_surname_passport", value: "ERIKSSON" },
        { key: "identity_mismatch_surname_profile", value: "SHARMA" },
        { key: "identity_mismatch_surname_severity", value: "MISMATCH" },
      ],
    });

    const res = await request(makeApp(WORKSPACE_A, USER_A))
      .patch(`/documents/${doc._id}/extracted-fields`)
      .send({ confirmed: true, fields: { documentNumber: "L898902C3" } });

    expect(res.status).toBe(200);
    expect(traveller.save).toHaveBeenCalledTimes(1);
    expect(doc.reviewStatus).toBe("VERIFIED");
    // The identity mismatch markers are neither cleared nor required —
    // they simply survive the merge like any other untouched key
    // (mergeConfirmedFields, routes/visa.ts).
    expect(doc.extractedFields.find((f: any) => f.key === "identity_mismatch_surname_severity")?.value).toBe(
      "MISMATCH",
    );
  });
});
