// Route-level coverage for Phase 4a: POST/GET .../documents, GET
// /documents/:id/url, DELETE /documents/:id, GET .../travel-bookings.
// Same approach as visa.requests.test.ts — mongodb-memory-server can't
// start in this sandbox (confirmed pre-existing, unrelated), so
// VisaApplication/VisaDocument/TravellerProfile/VisaRequest/TravelBooking
// are backed by small in-memory collections (equality + $in matching)
// rather than canned per-call responses, so tenancy/versioning/date-range
// behaviour is actually exercised. uploadBufferToS3/presignGetObject/
// logger are mocked — no real AWS calls, and the presign audit log is
// directly assertable.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const {
  applications,
  documents,
  travellerProfiles,
  visaRequests,
  travelBookings,
  uploadBufferToS3Mock,
  presignGetObjectMock,
  visaLoggerInfoMock,
  resetStores,
} = vi.hoisted(() => {
  type Doc = Record<string, any>;

  function toTime(v: any): number {
    return v instanceof Date ? v.getTime() : v;
  }

  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      if (key === "$or") {
        return (cond as Doc[]).some((sub) => matches(rec, sub));
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
    uploadBufferToS3Mock: vi.fn().mockResolvedValue({ bucket: "test-bucket", key: "visa-applications/fake/key.pdf", url: "https://example.com/fake" }),
    presignGetObjectMock: vi.fn().mockResolvedValue("https://example.com/presigned-url"),
    visaLoggerInfoMock: vi.fn(),
    resetStores() {
      applications.clear();
      documents.clear();
      travellerProfiles.clear();
      visaRequests.clear();
      travelBookings.clear();
    },
  };
});

// Unlike visa.requests.test.ts's chainable() (no route there depends on
// real sort order), GET .../documents relies on {docCode:1, version:-1}
// actually sorting before it takes "first row per docCode" as the latest
// version — so .sort() here is real, not a no-op passthrough.
function chainable(getResult: () => any) {
  let sortSpec: Record<string, number> | null = null;
  const obj: any = {
    select: () => obj,
    sort: (spec: any) => {
      sortSpec = spec;
      return obj;
    },
    limit: () => obj,
    lean: () => {
      let result = getResult();
      if (Array.isArray(result) && sortSpec) {
        const spec = sortSpec;
        result = [...result].sort((a: any, b: any) => {
          for (const [key, dir] of Object.entries(spec)) {
            const av = a[key];
            const bv = b[key];
            if (av < bv) return -1 * (dir as number);
            if (av > bv) return 1 * (dir as number);
          }
          return 0;
        });
      }
      return Promise.resolve(result);
    },
  };
  return obj;
}

// For findOne(...).sort(...) call sites (the "next version" lookup in POST
// .../documents) — sorts the FULL candidate set, then returns the first,
// so it stays correct even once a docCode has more than one prior version
// (not exercised by the current tests, which only ever have 0-or-1, but
// wrong-by-luck is still wrong).
function chainableFindOne(getResults: () => any[]) {
  let sortSpec: Record<string, number> | null = null;
  const obj: any = {
    select: () => obj,
    sort: (spec: any) => {
      sortSpec = spec;
      return obj;
    },
    lean: () => {
      let results = getResults();
      if (sortSpec) {
        const spec = sortSpec;
        results = [...results].sort((a: any, b: any) => {
          for (const [key, dir] of Object.entries(spec)) {
            const av = a[key];
            const bv = b[key];
            if (av < bv) return -1 * (dir as number);
            if (av > bv) return 1 * (dir as number);
          }
          return 0;
        });
      }
      return Promise.resolve(results[0] ?? null);
    },
  };
  return obj;
}

vi.mock("../models/VisaRule.js", () => ({
  default: { find: () => chainable(() => []), findById: () => chainable(() => null), findOne: () => chainable(() => null) },
  VISA_PURPOSES: ["TOURIST", "BUSINESS", "TOURIST_OR_BUSINESS", "TRANSIT"],
  VISA_SERVICE_TIERS: ["STANDARD", "EXPRESS", "SUPERFAST", "PRIORITY", "SUPER_PRIORITY"],
}));

vi.mock("../models/VisaDestinationContent.js", () => ({
  default: { findOne: () => chainable(() => null) },
}));

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    findOne: (filter: any) => chainable(() => applications.query(filter)[0] ?? null),
    find: (filter: any) => chainable(() => applications.query(filter)),
    insertMany: async (docs: any[]) => docs.map((d) => applications.insert(d)),
  },
}));

vi.mock("../models/VisaRequest.js", () => ({
  default: {
    findOne: (filter: any) => chainable(() => visaRequests.query(filter)[0] ?? null),
    findById: (id: any) => chainable(() => visaRequests.get(id)),
    create: async (input: any) => visaRequests.insert(input),
  },
  recomputeRequestStatus: vi.fn().mockResolvedValue("draft"),
}));

vi.mock("../models/VisaDocument.js", () => ({
  default: {
    find: (filter: any) => chainable(() => documents.query(filter)),
    findOne: (filter: any) => chainableFindOne(() => documents.query(filter)),
    create: async (input: any) => documents.insert(input),
    findOneAndUpdate: async (filter: any, update: any) => {
      const match = documents.query(filter)[0];
      if (!match) return null;
      return documents.update(match._id, update?.$set || {});
    },
  },
  VISA_DOCUMENT_EXTRACTION_STATUSES: ["PENDING", "PROCESSING", "EXTRACTED", "FAILED"],
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    findOne: (filter: any) => chainable(() => travellerProfiles.query(filter)[0] ?? null),
    find: (filter: any) => chainable(() => travellerProfiles.query(filter)),
  },
}));

vi.mock("../models/TravelBooking.js", () => ({
  default: {
    find: (filter: any) => chainable(() => travelBookings.query(filter)),
  },
}));

vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: (...args: any[]) => uploadBufferToS3Mock(...args),
}));

vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: (...args: any[]) => presignGetObjectMock(...args),
}));

vi.mock("../utils/logger.js", () => ({
  default: { child: () => ({ info: (...args: any[]) => visaLoggerInfoMock(...args), error: vi.fn() }) },
}));

// Phase 4b's fire-and-forget extraction trigger — this file only exercises
// the upload route's own behaviour (versioning, tenancy, extractionStatus
// starting PENDING), not extraction itself, so the trigger is stubbed out.
// See routes/visa.passportExtraction.test.ts for trigger-gating coverage
// and services/visaPassportExtraction.test.ts for the extraction pipeline.
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

beforeEach(() => {
  resetStores();
  uploadBufferToS3Mock.mockClear();
  presignGetObjectMock.mockClear();
  visaLoggerInfoMock.mockClear();
  uploadBufferToS3Mock.mockResolvedValue({
    bucket: "test-bucket",
    key: "visa-applications/fake/key.pdf",
    url: "https://example.com/fake",
  });
  presignGetObjectMock.mockResolvedValue("https://example.com/presigned-url");
});

describe("POST /applications/:applicationId/documents", () => {
  it("404s for an application belonging to another workspace", async () => {
    const app = applicationDoc(WORKSPACE_B);
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/applications/${app._id}/documents`)
      .field("docCode", "DOC-01")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "passport.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(404);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
    expect(documents.store.size).toBe(0);
  });

  it("404s on a well-formed but nonexistent applicationId", async () => {
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/applications/${new mongoose.Types.ObjectId()}/documents`)
      .field("docCode", "DOC-01")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "passport.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(404);
  });

  it("400s on an unrecognised docCode", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/applications/${app._id}/documents`)
      .field("docCode", "DOC-999")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "x.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
  });

  it("rejects a disallowed mime type cleanly (400, not 500)", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/applications/${app._id}/documents`)
      .field("docCode", "DOC-01")
      .attach("file", Buffer.from("MZ\x90\x00fake-exe"), { filename: "malware.exe", contentType: "application/x-msdownload" });
    expect(res.status).toBe(400);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
    expect(documents.store.size).toBe(0);
  });

  it("rejects an oversized file cleanly (413, not 500)", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const big = Buffer.alloc(16 * 1024 * 1024, 1); // 16MB > 15MB cap
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/applications/${app._id}/documents`)
      .field("docCode", "DOC-01")
      .attach("file", big, { filename: "big.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(413);
    expect(documents.store.size).toBe(0);
  }, 20_000);

  it("uploads under visa-applications/<workspaceId>/<applicationId>/ and creates a PENDING-extraction document", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const res = await request(makeApp(WORKSPACE_A))
      .post(`/applications/${app._id}/documents`)
      .field("docCode", "DOC-01")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "passport.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.document.docCode).toBe("DOC-01");
    expect(res.body.document.version).toBe(1);
    expect(res.body.document.extractionStatus).toBe("PENDING");

    const [callArgs] = uploadBufferToS3Mock.mock.calls;
    expect(callArgs[0].keyPrefix).toBe(`visa-applications/${WORKSPACE_A}/${app._id}`);
  });

  it.each(["draft", "submitted", "action_required"])(
    "allows upload while status is %s",
    async (status) => {
      const app = applicationDoc(WORKSPACE_A, { status });
      const res = await request(makeApp(WORKSPACE_A))
        .post(`/applications/${app._id}/documents`)
        .field("docCode", "DOC-01")
        .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "passport.pdf", contentType: "application/pdf" });

      expect(res.status).toBe(201);
      expect(uploadBufferToS3Mock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["docs_under_review", "cost_confirmed", "lodged", "decision_received", "closed"])(
    "409s once status is %s — an agent is already working the file",
    async (status) => {
      const app = applicationDoc(WORKSPACE_A, { status });
      const res = await request(makeApp(WORKSPACE_A))
        .post(`/applications/${app._id}/documents`)
        .field("docCode", "DOC-01")
        .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "passport.pdf", contentType: "application/pdf" });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/concierge/i);
      expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
      expect(documents.store.size).toBe(0);
    },
  );

  it("re-uploading the same docCode versions rather than overwrites — both rows survive", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const upload = () =>
      request(makeApp(WORKSPACE_A))
        .post(`/applications/${app._id}/documents`)
        .field("docCode", "DOC-01")
        .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "passport.pdf", contentType: "application/pdf" });

    const first = await upload();
    const second = await upload();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.document.version).toBe(1);
    expect(second.body.document.version).toBe(2);
    expect(first.body.document.id).not.toBe(second.body.document.id);

    const rows = documents.query({ applicationId: app._id, docCode: "DOC-01" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.version).sort()).toEqual([1, 2]);
  });
});

describe("GET /applications/:applicationId/documents", () => {
  it("404s for an application belonging to another workspace", async () => {
    const app = applicationDoc(WORKSPACE_B);
    const res = await request(makeApp(WORKSPACE_A)).get(`/applications/${app._id}/documents`);
    expect(res.status).toBe(404);
  });

  it("returns only the latest version per docCode by default", async () => {
    const app = applicationDoc(WORKSPACE_A);
    documents.insert({ workspaceId: WORKSPACE_A, applicationId: app._id, docCode: "DOC-01", version: 1, originalFilename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedByUserId: USER_A, extractionStatus: "PENDING", deletedAt: null });
    documents.insert({ workspaceId: WORKSPACE_A, applicationId: app._id, docCode: "DOC-01", version: 2, originalFilename: "b.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedByUserId: USER_A, extractionStatus: "PENDING", deletedAt: null });
    documents.insert({ workspaceId: WORKSPACE_A, applicationId: app._id, docCode: "DOC-02", version: 1, originalFilename: "c.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedByUserId: USER_A, extractionStatus: "PENDING", deletedAt: null });

    const res = await request(makeApp(WORKSPACE_A)).get(`/applications/${app._id}/documents`);
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(2);
    const doc01 = res.body.documents.find((d: any) => d.docCode === "DOC-01");
    expect(doc01.version).toBe(2);
    expect(doc01.originalFilename).toBe("b.pdf");
  });

  it("?includeVersions=true returns every version", async () => {
    const app = applicationDoc(WORKSPACE_A);
    documents.insert({ workspaceId: WORKSPACE_A, applicationId: app._id, docCode: "DOC-01", version: 1, originalFilename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedByUserId: USER_A, extractionStatus: "PENDING", deletedAt: null });
    documents.insert({ workspaceId: WORKSPACE_A, applicationId: app._id, docCode: "DOC-01", version: 2, originalFilename: "b.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedByUserId: USER_A, extractionStatus: "PENDING", deletedAt: null });

    const res = await request(makeApp(WORKSPACE_A)).get(`/applications/${app._id}/documents?includeVersions=true`);
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(2);
  });

  it("never includes s3Key or a URL in the list response", async () => {
    const app = applicationDoc(WORKSPACE_A);
    documents.insert({ workspaceId: WORKSPACE_A, applicationId: app._id, docCode: "DOC-01", version: 1, s3Key: "visa-applications/secret/key.pdf", originalFilename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedByUserId: USER_A, extractionStatus: "PENDING", deletedAt: null });

    const res = await request(makeApp(WORKSPACE_A)).get(`/applications/${app._id}/documents`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("visa-applications/secret/key.pdf");
    expect(res.body.documents[0].s3Key).toBeUndefined();
    expect(res.body.documents[0].url).toBeUndefined();
  });
});

describe("GET /documents/:documentId/url", () => {
  it("validates workspace ownership BEFORE signing — never signs a cross-tenant document", async () => {
    const app = applicationDoc(WORKSPACE_B);
    const doc = documents.insert({
      workspaceId: WORKSPACE_B,
      applicationId: app._id,
      docCode: "DOC-01",
      version: 1,
      s3Key: "visa-applications/wsB/app/key.pdf",
      originalFilename: "passport.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      uploadedByUserId: USER_A,
      extractionStatus: "PENDING",
      deletedAt: null,
    });

    const res = await request(makeApp(WORKSPACE_A)).get(`/documents/${doc._id}/url`);
    expect(res.status).toBe(404);
    expect(presignGetObjectMock).not.toHaveBeenCalled();
  });

  it("signs and logs who requested it and when, for an owned document", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const doc = documents.insert({
      workspaceId: WORKSPACE_A,
      applicationId: app._id,
      docCode: "DOC-01",
      version: 1,
      s3Key: "visa-applications/wsA/app/key.pdf",
      originalFilename: "passport.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      uploadedByUserId: USER_A,
      extractionStatus: "PENDING",
      deletedAt: null,
    });

    const res = await request(makeApp(WORKSPACE_A, USER_A)).get(`/documents/${doc._id}/url`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://example.com/presigned-url");

    expect(presignGetObjectMock).toHaveBeenCalledTimes(1);
    expect(presignGetObjectMock.mock.calls[0][0].key).toBe("visa-applications/wsA/app/key.pdf");

    expect(visaLoggerInfoMock).toHaveBeenCalledTimes(1);
    const [, meta] = visaLoggerInfoMock.mock.calls[0];
    expect(meta.documentId).toBe(String(doc._id));
    expect(meta.requestedBy).toBe(String(USER_A));
    expect(typeof meta.requestedAt).toBe("string");
  });

  it("404s for a soft-deleted document — never signs a URL for one", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const doc = documents.insert({
      workspaceId: WORKSPACE_A,
      applicationId: app._id,
      docCode: "DOC-01",
      version: 1,
      s3Key: "k",
      originalFilename: "passport.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      uploadedByUserId: USER_A,
      extractionStatus: "PENDING",
      deletedAt: new Date(),
    });

    const res = await request(makeApp(WORKSPACE_A)).get(`/documents/${doc._id}/url`);
    expect(res.status).toBe(404);
    expect(presignGetObjectMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /documents/:documentId", () => {
  it("404s for a document belonging to another workspace", async () => {
    const app = applicationDoc(WORKSPACE_B);
    const doc = documents.insert({
      workspaceId: WORKSPACE_B,
      applicationId: app._id,
      docCode: "DOC-01",
      version: 1,
      s3Key: "k",
      originalFilename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      uploadedByUserId: USER_A,
      extractionStatus: "PENDING",
      deletedAt: null,
    });

    const res = await request(makeApp(WORKSPACE_A)).delete(`/documents/${doc._id}`);
    expect(res.status).toBe(404);
    expect(documents.get(doc._id).deletedAt).toBeNull();
  });

  it("soft-deletes — sets deletedAt/deletedBy, never touches S3", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const doc = documents.insert({
      workspaceId: WORKSPACE_A,
      applicationId: app._id,
      docCode: "DOC-01",
      version: 1,
      s3Key: "visa-applications/wsA/app/key.pdf",
      originalFilename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      uploadedByUserId: USER_A,
      extractionStatus: "PENDING",
      deletedAt: null,
    });

    const res = await request(makeApp(WORKSPACE_A, USER_A)).delete(`/documents/${doc._id}`);
    expect(res.status).toBe(200);

    const stored = documents.get(doc._id);
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect(String(stored.deletedBy)).toBe(String(USER_A));
    // The S3 object itself is never referenced by the delete route at all —
    // no delete/remove S3 call exists in this file's mocks for a reason:
    // there's nothing to call. Confirm the row (and its s3Key) is intact.
    expect(stored.s3Key).toBe("visa-applications/wsA/app/key.pdf");
  });

  it("a soft-deleted document is excluded from the default document list", async () => {
    const app = applicationDoc(WORKSPACE_A);
    const doc = documents.insert({
      workspaceId: WORKSPACE_A,
      applicationId: app._id,
      docCode: "DOC-01",
      version: 1,
      s3Key: "k",
      originalFilename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      uploadedByUserId: USER_A,
      extractionStatus: "PENDING",
      deletedAt: null,
    });

    await request(makeApp(WORKSPACE_A)).delete(`/documents/${doc._id}`);

    const res = await request(makeApp(WORKSPACE_A)).get(`/applications/${app._id}/documents`);
    expect(res.body.documents).toHaveLength(0);
  });
});

describe("GET /applications/:applicationId/travel-bookings", () => {
  it("404s for an application belonging to another workspace", async () => {
    const app = applicationDoc(WORKSPACE_B);
    const res = await request(makeApp(WORKSPACE_A)).get(`/applications/${app._id}/travel-bookings`);
    expect(res.status).toBe(404);
  });

  it("returns empty, not an error, when the traveller has no email on file", async () => {
    const travellerId = new mongoose.Types.ObjectId();
    travellerProfiles.insert({ _id: travellerId, workspaceId: WORKSPACE_A, email: null });
    const app = applicationDoc(WORKSPACE_A, { travellerProfileId: travellerId });

    const res = await request(makeApp(WORKSPACE_A)).get(`/applications/${app._id}/travel-bookings`);
    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([]);
  });

  it("returns empty, not an error, when nothing matches the traveller/date window", async () => {
    const travellerId = new mongoose.Types.ObjectId();
    travellerProfiles.insert({ _id: travellerId, workspaceId: WORKSPACE_A, email: "asha@example.com" });
    const requestId = new mongoose.Types.ObjectId();
    visaRequests.insert({ _id: requestId, workspaceId: WORKSPACE_A, travelDateFrom: new Date("2026-08-01"), travelDateTo: new Date("2026-08-10") });
    const app = applicationDoc(WORKSPACE_A, { travellerProfileId: travellerId, requestId });

    const res = await request(makeApp(WORKSPACE_A)).get(`/applications/${app._id}/travel-bookings`);
    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([]);
  });

  it("finds a flight/hotel booking matching traveller email and overlapping the request's date window", async () => {
    const travellerId = new mongoose.Types.ObjectId();
    travellerProfiles.insert({ _id: travellerId, workspaceId: WORKSPACE_A, email: "asha@example.com" });
    const requestId = new mongoose.Types.ObjectId();
    visaRequests.insert({ _id: requestId, workspaceId: WORKSPACE_A, travelDateFrom: new Date("2026-08-01"), travelDateTo: new Date("2026-08-10") });
    const app = applicationDoc(WORKSPACE_A, { travellerProfileId: travellerId, requestId });

    travelBookings.insert({
      workspaceId: WORKSPACE_A,
      isActive: true,
      service: "FLIGHT",
      travellerEmail: "Asha@Example.com", // case-insensitive match
      travelDate: new Date("2026-08-03"),
      travelDateEnd: new Date("2026-08-03"),
      destination: "DXB",
      origin: "BOM",
      status: "CONFIRMED",
      bookedAt: new Date("2026-07-01"),
    });
    // A non-matching service type — must be excluded.
    travelBookings.insert({
      workspaceId: WORKSPACE_A,
      isActive: true,
      service: "CAB",
      travellerEmail: "asha@example.com",
      travelDate: new Date("2026-08-03"),
      destination: "DXB",
      origin: "BOM",
      status: "CONFIRMED",
      bookedAt: new Date("2026-07-01"),
    });

    const res = await request(makeApp(WORKSPACE_A)).get(`/applications/${app._id}/travel-bookings`);
    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].service).toBe("FLIGHT");
    expect(res.body.bookings[0].destination).toBe("DXB");
  });
});
