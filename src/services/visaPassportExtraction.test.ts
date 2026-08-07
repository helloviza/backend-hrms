// Coverage for the Phase 4b orchestration service: Stage 1 (Gemini, mocked
// here) -> Stage 2 (the REAL utils/mrz.ts parser, not mocked — this is what
// proves the two stages wire together correctly) -> persisted onto the
// VisaDocument. No network: extractPassportGemini and s3Upload are mocked,
// and VisaDocument is backed by a tiny in-memory store, same convention as
// routes/visa.documents.test.ts. NOTE: that store is a convention, not a
// constraint — mongodb-memory-server does start here (see
// utils/visaPredicatePersistence.test.ts), so real persistence is available
// if this test ever needs schema defaults or casting to be real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import { ApiError } from "@google/genai";

// Same ICAO 9303 worked example used in utils/mrz.test.ts.
const VALID_LINE1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
const VALID_LINE2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";
// Only the composite check digit (pos43) is corrupted — every field check
// still passes.
const COMPOSITE_CORRUPTED_LINE2 = VALID_LINE2.slice(0, 43) + "9";

const {
  docsStore,
  applicationsStore,
  travellersStore,
  findByIdMock,
  findByIdAndUpdateMock,
  extractMock,
  getObjectBufferMock,
  loggerErrorMock,
  loggerWarnMock,
  loggerInfoMock,
  resetAll,
} = vi.hoisted(() => {
  const docsStore = new Map<string, any>();
  const applicationsStore = new Map<string, any>();
  const travellersStore = new Map<string, any>();
  return {
    docsStore,
    applicationsStore,
    travellersStore,
    findByIdMock: vi.fn((id: any) => Promise.resolve(docsStore.get(String(id)) ?? null)),
    findByIdAndUpdateMock: vi.fn((id: any, update: any) => {
      const rec = docsStore.get(String(id));
      if (!rec) return Promise.resolve(null);
      Object.assign(rec, update?.$set || {});
      return Promise.resolve(rec);
    }),
    extractMock: vi.fn(),
    getObjectBufferMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    resetAll() {
      docsStore.clear();
      applicationsStore.clear();
      travellersStore.clear();
    },
  };
});

vi.mock("../models/VisaDocument.js", () => ({
  default: {
    findById: (id: any) => findByIdMock(id),
    findByIdAndUpdate: (id: any, update: any) => findByIdAndUpdateMock(id, update),
  },
}));

// Identity cross-check lookups (VisaApplication -> TravellerProfile) — a
// thin chainable matching the .select(...).lean() shape the service calls.
// Most existing tests in this file never seed either store, so these
// resolve to null/undefined and the identity cross-check's own `if
// (application)`/`if (traveller)` guards make it a no-op — proving those
// tests are unaffected by this addition, not just assuming it.
function chainableLean(getResult: () => any) {
  const obj: any = { select: () => obj, lean: () => Promise.resolve(getResult()) };
  return obj;
}

vi.mock("../models/VisaApplication.js", () => ({
  default: {
    findById: (id: any) => chainableLean(() => applicationsStore.get(String(id)) ?? null),
  },
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    findOne: (filter: any) => chainableLean(() => travellersStore.get(String(filter._id)) ?? null),
  },
}));

vi.mock("./extractPassportGemini.js", () => ({
  extractPassportMrzViaGemini: (...args: any[]) => extractMock(...args),
}));

vi.mock("../utils/s3Upload.js", () => ({
  getObjectBuffer: (...args: any[]) => getObjectBufferMock(...args),
}));

// STARTED/COMPLETED/FAILED are all logged via logVisaActivity — mocked to a
// no-op so tests never touch the real (unconnected, in this test
// environment) VisaActivityLog collection. Without this, tests happen to
// pass anyway (most fixtures leave application.requestId unset, so the real
// model's own schema validation rejects the row locally, before any network
// call) — mocked explicitly so that stays true by design, not by accident.
vi.mock("../models/VisaActivityLog.js", () => ({
  logVisaActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/logger.js", () => ({
  default: {
    child: () => ({
      info: (...args: any[]) => loggerInfoMock(...args),
      warn: (...args: any[]) => loggerWarnMock(...args),
      error: (...args: any[]) => loggerErrorMock(...args),
    }),
  },
}));

import { runVisaPassportExtraction, PASSPORT_DOC_CODE } from "./visaPassportExtraction.js";

function makeDoc(overrides: Record<string, any> = {}) {
  const doc = {
    _id: overrides._id ?? new mongoose.Types.ObjectId(),
    docCode: "DOC-01",
    s3Key: "visa-applications/ws/app/key.jpg",
    mimeType: "image/jpeg",
    extractionStatus: "PENDING",
    extractedFields: [] as Array<{ key: string; value: string }>,
    extractionConfidence: undefined as string | undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  docsStore.set(String(doc._id), doc);
  return doc;
}

function fieldMap(doc: any): Record<string, string> {
  return Object.fromEntries(doc.extractedFields.map((f: any) => [f.key, f.value]));
}

function makeApplication(overrides: Record<string, any> = {}) {
  const app = {
    _id: overrides._id ?? new mongoose.Types.ObjectId(),
    workspaceId: new mongoose.Types.ObjectId(),
    travellerProfileId: overrides.travellerProfileId ?? new mongoose.Types.ObjectId(),
    ...overrides,
  };
  applicationsStore.set(String(app._id), app);
  return app;
}

function makeTraveller(overrides: Record<string, any> = {}) {
  const traveller = {
    _id: overrides._id ?? new mongoose.Types.ObjectId(),
    firstName: "Anna",
    middleName: null,
    lastName: "Eriksson",
    dob: null,
    passportNo: null,
    ...overrides,
  };
  travellersStore.set(String(traveller._id), traveller);
  return traveller;
}

beforeEach(() => {
  resetAll();
  extractMock.mockReset();
  getObjectBufferMock.mockReset().mockResolvedValue(Buffer.from("fake-image-bytes"));
  loggerErrorMock.mockClear();
  loggerWarnMock.mockClear();
  loggerInfoMock.mockClear();
});

describe("runVisaPassportExtraction", () => {
  it("PASSPORT_DOC_CODE is DOC-01, matching config/visaDocumentCodes.ts", () => {
    expect(PASSPORT_DOC_CODE).toBe("DOC-01");
  });

  it("never calls Gemini for a non-passport docCode (defense in depth)", async () => {
    const doc = makeDoc({ docCode: "DOC-07" });
    await runVisaPassportExtraction(String(doc._id));

    expect(extractMock).not.toHaveBeenCalled();
    expect(getObjectBufferMock).not.toHaveBeenCalled();
    expect(doc.extractionStatus).toBe("PENDING"); // untouched
  });

  it("goes PENDING -> PROCESSING -> COMPLETED with high confidence when every check digit passes", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("COMPLETED");
    expect(doc.extractionConfidence).toBe("high");
    expect(doc.save).toHaveBeenCalledTimes(2); // once for PROCESSING, once for the final result

    const fields = fieldMap(doc);
    expect(fields.documentNumber).toBe("L898902C3");
    expect(fields.surname).toBe("ERIKSSON");
    expect(fields.givenNames).toBe("ANNA MARIA");
    expect(fields.issuingState).toBe("UTO");
    expect(fields.dateOfExpiry).toBe("120415");
    expect(fields.check_documentNumber).toBe("passed");
    expect(fields.check_composite).toBe("passed");
  });

  it("goes NEEDS_REVIEW with medium confidence when only the composite check digit fails", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: COMPOSITE_CORRUPTED_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("NEEDS_REVIEW");
    expect(doc.extractionConfidence).toBe("medium");

    const fields = fieldMap(doc);
    expect(fields.check_composite).toBe("failed");
    expect(fields.check_documentNumber).toBe("passed"); // review shows what's actually suspect, not everything
    expect(fields.check_dateOfBirth).toBe("passed");
    expect(fields.check_dateOfExpiry).toBe("passed");
  });

  it("FAILED, without throwing, when Gemini reports no MRZ found — the application stays usable", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({ found: false, line1: null, line2: null, model: "gemini-2.5-flash", rawText: "{}" });

    await expect(runVisaPassportExtraction(String(doc._id))).resolves.toBeUndefined();

    expect(doc.extractionStatus).toBe("FAILED");
    const fields = fieldMap(doc);
    expect(fields.error).toMatch(/no mrz/i);
    // Distinguishes "document/MRZ itself couldn't be read" from a service
    // error — ExtractionCard.tsx renders different copy per category.
    expect(fields.failureCategory).toBe("UNREADABLE_DOCUMENT");
    // Previously undiagnosable without a DB query — this path used to log
    // nothing at all (see file header's screen-4-review note).
    expect(loggerWarnMock).toHaveBeenCalled();
  });

  it("recovers a line 1 short by 2 (dropped trailing filler) WITHOUT retrying — mrz.ts's repair fixes it on the first attempt, check digits verified", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1.slice(0, -2), line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("COMPLETED");
    expect(extractMock).toHaveBeenCalledTimes(1); // no retry needed at all
    // Repair is diagnostics-only logging, never blocks/marks the document —
    // confirms the repair path was actually exercised, not a coincidental
    // pass.
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.stringMatching(/recovered via filler repair/i),
      expect.objectContaining({ repairedVia: "line1" }),
    );
  });

  it("recovers a line 2 too long by filler (the diagnosed real case: line 1 short, line 2 long, at once) WITHOUT retrying", async () => {
    const doc = makeDoc();
    const longLine2 = VALID_LINE2.slice(0, 41) + "<" + VALID_LINE2.slice(41); // 45 chars
    extractMock.mockResolvedValue({
      found: true, line1: VALID_LINE1.slice(0, -1), line2: longLine2, model: "gemini-2.5-flash", rawText: "{}",
    });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("COMPLETED");
    expect(extractMock).toHaveBeenCalledTimes(1);
    const fields = fieldMap(doc);
    expect(fields.documentNumber).toBe("L898902C3");
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.stringMatching(/recovered via filler repair/i),
      expect.objectContaining({ repairedVia: "both" }),
    );
  });

  it("retries ONCE with a PLAIN re-request (no repairHint) when the MRZ still fails to parse after repair, and recovers if the retry succeeds", async () => {
    const doc = makeDoc();
    extractMock
      .mockResolvedValueOnce({ found: true, line1: "TOO<SHORT", line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" })
      .mockResolvedValueOnce({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("COMPLETED");
    expect(extractMock).toHaveBeenCalledTimes(2); // original attempt + one retry
    // The retry hint measurably made filler errors WORSE on a retry of the
    // same image (see file header) — the retry call must carry NO
    // repairHint at all now, a plain re-request.
    const [, secondCallArgs] = extractMock.mock.calls;
    expect(secondCallArgs[0].repairHint).toBeUndefined();
  });

  it("logs a MASKED form of both lines on parse failure — structure only, no real passport data in the log", async () => {
    const doc = makeDoc();
    // "TOO<SHORT" is 9 characters, nowhere near 44 either way — guaranteed
    // to still fail after repair, so the failure-logging branch runs.
    extractMock.mockResolvedValue({ found: true, line1: "TOO<SHORT", line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringMatching(/MRZ parse failed, retrying once/i),
      expect.objectContaining({
        line1Masked: "XXX<XXXXX", // "TOO<SHORT" -> every alphanumeric X, the one "<" kept in place
        line2Masked: expect.stringMatching(/^[X<]+$/),
      }),
    );
    // The real passport number must never appear in any log call at all.
    for (const call of loggerWarnMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("L898902C3");
    }
  });

  it("FAILED with MALFORMED_MRZ (not UNREADABLE_DOCUMENT), without throwing, when the MRZ still fails to parse after the retry — an MRZ WAS found and read, just not cleanly", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({ found: true, line1: "TOO<SHORT", line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await expect(runVisaPassportExtraction(String(doc._id))).resolves.toBeUndefined();

    expect(doc.extractionStatus).toBe("FAILED");
    const fields = fieldMap(doc);
    expect(fields.failureCategory).toBe("MALFORMED_MRZ");
    expect(extractMock).toHaveBeenCalledTimes(2); // original attempt + one retry, never more
    expect(loggerWarnMock).toHaveBeenCalled();
  });

  it("FAILED, without throwing, when the Gemini call itself errors — a network/API failure never blocks the application", async () => {
    const doc = makeDoc();
    extractMock.mockRejectedValue(new Error("Gemini timed out"));

    await expect(runVisaPassportExtraction(String(doc._id))).resolves.toBeUndefined();

    expect(doc.extractionStatus).toBe("FAILED");
    const fields = fieldMap(doc);
    expect(fields.error).toBe("Gemini timed out");
    expect(fields.failureCategory).toBe("SERVICE_ERROR");
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  // Task brief: a Gemini 503 ("model is currently experiencing high
  // demand") that exhausts its transient-upstream retries (utils/
  // geminiRetry.ts, exercised for real in extractPassportGemini.test.ts —
  // extractPassportMrzViaGemini is mocked here, so this test only needs to
  // reproduce what THAT function throws once its own retries are spent)
  // must land as SERVICE_ERROR. The user must never be told to re-photograph
  // a good document, or be given "couldn't read it cleanly" copy, because
  // the upstream was momentarily busy — both of those imply a problem with
  // THEIR file, not ours.
  it("a 503 that exhausts retries lands as SERVICE_ERROR, never UNREADABLE_DOCUMENT or MALFORMED_MRZ", async () => {
    const doc = makeDoc();
    extractMock.mockRejectedValue(new ApiError({ message: "model is currently experiencing high demand", status: 503 }));

    await expect(runVisaPassportExtraction(String(doc._id))).resolves.toBeUndefined();

    expect(doc.extractionStatus).toBe("FAILED");
    const fields = fieldMap(doc);
    expect(fields.failureCategory).toBe("SERVICE_ERROR");
    expect(fields.failureCategory).not.toBe("UNREADABLE_DOCUMENT");
    expect(fields.failureCategory).not.toBe("MALFORMED_MRZ");
    expect(fields.error).toMatch(/high demand/i);
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("FAILED, without throwing, when S3 fetch of the image itself errors", async () => {
    const doc = makeDoc();
    getObjectBufferMock.mockRejectedValue(new Error("S3 object not found"));

    await expect(runVisaPassportExtraction(String(doc._id))).resolves.toBeUndefined();

    expect(doc.extractionStatus).toBe("FAILED");
    expect(extractMock).not.toHaveBeenCalled();
    const fields = fieldMap(doc);
    expect(fields.failureCategory).toBe("SERVICE_ERROR");
  });

  it("returns quietly when the document no longer exists", async () => {
    await expect(runVisaPassportExtraction(String(new mongoose.Types.ObjectId()))).resolves.toBeUndefined();
    expect(extractMock).not.toHaveBeenCalled();
  });
});

describe("runVisaPassportExtraction — VIZ (visual inspection zone)", () => {
  const AGREEING_VIZ = {
    surname: "ERIKSSON",
    givenNames: "ANNA MARIA",
    dateOfBirth: "1974-08-12",
    documentNumber: "L898902C3",
    dateOfExpiry: "2012-04-15",
    sex: "F",
    nationality: "UTOPIAN", // ICAO's fictional demonym — deliberately not ISO-resolvable
    dateOfIssue: "2002-04-15",
    placeOfBirth: "STOCKHOLM",
    placeOfIssue: "STOCKHOLM",
  };

  it("stores VIZ-only fields (dateOfIssue/placeOfBirth/placeOfIssue) under viz_ keys, unverified", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({
      found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}",
      vizFound: true, viz: AGREEING_VIZ,
    });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("COMPLETED"); // MRZ confidence untouched by VIZ
    const fields = fieldMap(doc);
    expect(fields.viz_dateOfIssue).toBe("2002-04-15");
    expect(fields.viz_placeOfBirth).toBe("STOCKHOLM");
    expect(fields.viz_placeOfIssue).toBe("STOCKHOLM");
  });

  it("MRZ wins on overlap — the stored canonical fields stay the MRZ value even when VIZ agrees (and would still win if it disagreed)", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({
      found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}",
      vizFound: true, viz: { ...AGREEING_VIZ, documentNumber: "DIFFERENT99" },
    });

    await runVisaPassportExtraction(String(doc._id));

    const fields = fieldMap(doc);
    // The canonical "documentNumber" key is untouched — still the MRZ value.
    expect(fields.documentNumber).toBe("L898902C3");
  });

  it("records a deliberate MRZ/VIZ mismatch, not silently dropped", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({
      found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}",
      vizFound: true, viz: { ...AGREEING_VIZ, documentNumber: "DIFFERENT99" },
    });

    await runVisaPassportExtraction(String(doc._id));

    const fields = fieldMap(doc);
    expect(fields.mismatch_documentNumber_mrz).toBe("L898902C3");
    expect(fields.mismatch_documentNumber_viz).toBe("DIFFERENT99");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringMatching(/cross-check mismatch/i),
      expect.objectContaining({ fields: ["documentNumber"] }),
    );
  });

  it("the MRZ path still works unchanged when the VIZ read fails entirely (vizFound: false)", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({
      found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}",
      vizFound: false, viz: null,
    });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("COMPLETED");
    expect(doc.extractionConfidence).toBe("high");
    const fields = fieldMap(doc);
    expect(fields.documentNumber).toBe("L898902C3");
    expect(fields.viz_dateOfIssue).toBeUndefined();
    expect(fields.viz_placeOfBirth).toBeUndefined();
    expect(Object.keys(fields).some((k) => k.startsWith("mismatch_"))).toBe(false);
  });

  it("also works unchanged when the extraction result carries no viz fields at all (older mocks/older Gemini responses)", async () => {
    const doc = makeDoc();
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("COMPLETED");
    const fields = fieldMap(doc);
    expect(fields.documentNumber).toBe("L898902C3");
  });

  it("a VIZ processing failure never fails the whole extraction — the MRZ result is kept as-is", async () => {
    const doc = makeDoc();
    // A Proxy that throws on any property access — simulates a genuinely
    // broken VIZ shape without needing to mock the cross-check module
    // itself; exercises the try/catch wrapped around all VIZ processing.
    const throwingViz = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    extractMock.mockResolvedValue({
      found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}",
      vizFound: true, viz: throwingViz as any,
    });

    await expect(runVisaPassportExtraction(String(doc._id))).resolves.toBeUndefined();

    expect(doc.extractionStatus).toBe("COMPLETED");
    expect(doc.extractionConfidence).toBe("high");
    const fields = fieldMap(doc);
    expect(fields.documentNumber).toBe("L898902C3");
  });
});

// VALID_LINE1/VALID_LINE2 (see top of file) encode surname ERIKSSON, given
// names ANNA MARIA, documentNumber L898902C3, dateOfBirth 1974-08-12 — every
// test below seeds a TravellerProfile against that same identity and varies
// exactly one field to isolate what does/doesn't flag.
describe("runVisaPassportExtraction — identity cross-check (utils/passportCrossCheck.ts)", () => {
  function seedApplicationAndTraveller(travellerOverrides: Record<string, any> = {}) {
    const traveller = makeTraveller(travellerOverrides);
    const application = makeApplication({ travellerProfileId: traveller._id });
    return { application, traveller };
  }

  it("does not flag anything, and stores no identity_mismatch_* keys, when the profile matches the passport", async () => {
    const { application } = seedApplicationAndTraveller({ firstName: "Anna", middleName: "Maria", lastName: "Eriksson" });
    const doc = makeDoc({ applicationId: application._id });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("COMPLETED");
    expect(Object.keys(fieldMap(doc)).some((k) => k.startsWith("identity_mismatch_"))).toBe(false);
  });

  it("flags a clear surname mismatch — a completely different family name is the strongest 'wrong person' signal", async () => {
    const { application } = seedApplicationAndTraveller({ firstName: "Anna", middleName: "Maria", lastName: "Sharma" });
    const doc = makeDoc({ applicationId: application._id });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    // Never blocks — extraction still succeeds normally.
    expect(doc.extractionStatus).toBe("COMPLETED");
    const fields = fieldMap(doc);
    expect(fields.identity_mismatch_surname_passport).toBe("ERIKSSON");
    expect(fields.identity_mismatch_surname_profile).toBe("Sharma"); // stored exactly as on the profile, not case-forced
    expect(fields.identity_mismatch_surname_severity).toBe("MISMATCH");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringMatching(/identity cross-check mismatch/i),
      expect.objectContaining({ fields: expect.arrayContaining(["surname:MISMATCH"]) }),
    );
  });

  it("does NOT flag initials on file against the passport's full given names", async () => {
    const { application } = seedApplicationAndTraveller({ firstName: "A", middleName: "M", lastName: "Eriksson" });
    const doc = makeDoc({ applicationId: application._id });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(fieldMap(doc).identity_mismatch_givenNames_passport).toBeUndefined();
  });

  it("does NOT flag a middle name present on the passport but absent from the profile on file", async () => {
    // Profile has only "Anna" (no middleName); passport's MRZ givenNames is
    // "ANNA MARIA" — the extra "MARIA" token is simply not present on
    // either side to contradict, so this must not read as a mismatch.
    const { application } = seedApplicationAndTraveller({ firstName: "Anna", middleName: null, lastName: "Eriksson" });
    const doc = makeDoc({ applicationId: application._id });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(fieldMap(doc).identity_mismatch_givenNames_passport).toBeUndefined();
  });

  it("does NOT flag reordered given-name tokens (profile 'Maria Anna' vs passport 'ANNA MARIA')", async () => {
    const { application } = seedApplicationAndTraveller({ firstName: "Maria", middleName: "Anna", lastName: "Eriksson" });
    const doc = makeDoc({ applicationId: application._id });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(fieldMap(doc).identity_mismatch_givenNames_passport).toBeUndefined();
  });

  it("flags a date-of-birth mismatch when the profile already has one on file", async () => {
    const { application } = seedApplicationAndTraveller({
      firstName: "Anna", middleName: "Maria", lastName: "Eriksson", dob: "1974-08-11",
    });
    const doc = makeDoc({ applicationId: application._id });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(doc.extractionStatus).toBe("COMPLETED");
    const fields = fieldMap(doc);
    expect(fields.identity_mismatch_dateOfBirth_passport).toBe("1974-08-12");
    expect(fields.identity_mismatch_dateOfBirth_profile).toBe("1974-08-11");
    expect(fields.identity_mismatch_dateOfBirth_severity).toBe("MISMATCH");
  });

  it("does not compare dateOfBirth at all when the profile has none on file yet", async () => {
    const { application } = seedApplicationAndTraveller({
      firstName: "Anna", middleName: "Maria", lastName: "Eriksson", dob: null,
    });
    const doc = makeDoc({ applicationId: application._id });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(fieldMap(doc).identity_mismatch_dateOfBirth_passport).toBeUndefined();
  });

  it("a passport number differing from the one on file reads as DIFFERS_FROM_FILE, never MISMATCH — renewal is the ordinary explanation", async () => {
    const { application } = seedApplicationAndTraveller({
      firstName: "Anna", middleName: "Maria", lastName: "Eriksson", passportNo: "Z9999999",
    });
    const doc = makeDoc({ applicationId: application._id });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    // Never treated as a failure/error — extraction succeeds normally.
    expect(doc.extractionStatus).toBe("COMPLETED");
    const fields = fieldMap(doc);
    expect(fields.identity_mismatch_documentNumber_passport).toBe("L898902C3");
    expect(fields.identity_mismatch_documentNumber_profile).toBe("Z9999999");
    expect(fields.identity_mismatch_documentNumber_severity).toBe("DIFFERS_FROM_FILE");
  });

  it("does not compare documentNumber at all when the profile has none on file yet (first-ever upload)", async () => {
    const { application } = seedApplicationAndTraveller({
      firstName: "Anna", middleName: "Maria", lastName: "Eriksson", passportNo: null,
    });
    const doc = makeDoc({ applicationId: application._id });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await runVisaPassportExtraction(String(doc._id));

    expect(fieldMap(doc).identity_mismatch_documentNumber_passport).toBeUndefined();
  });

  it("a lookup failure (no matching application) never fails the whole extraction — the MRZ result is kept as-is", async () => {
    // No makeApplication/makeTraveller seeded at all — doc.applicationId
    // resolves to nothing in the mocked store.
    const doc = makeDoc({ applicationId: new mongoose.Types.ObjectId() });
    extractMock.mockResolvedValue({ found: true, line1: VALID_LINE1, line2: VALID_LINE2, model: "gemini-2.5-flash", rawText: "{}" });

    await expect(runVisaPassportExtraction(String(doc._id))).resolves.toBeUndefined();

    expect(doc.extractionStatus).toBe("COMPLETED");
    expect(Object.keys(fieldMap(doc)).some((k) => k.startsWith("identity_mismatch_"))).toBe(false);
  });
});
