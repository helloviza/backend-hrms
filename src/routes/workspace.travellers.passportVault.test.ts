// Route-level coverage for the Passport & MRZ Vault (Tab 2, 2026-08-11):
// resolvePassportVault's THREE-STATE source counting on GET /:id, and the
// field gating for the new self-editable passport keys on PUT /:id.
//
// The three states are the point of the whole panel, and they are counted
// HERE (not in the comparator, which is covered by
// utils/passportSourceCompare.test.ts) because only the route knows whether
// a second source exists:
//
//   0 sources — no typed passport, no extraction => the client renders
//               NOTHING. `comparison` is null and no percentage exists.
//   1 source  — typed passport only (or an extraction with nothing typed)
//               => the data renders, `comparison` STAYS NULL. A single
//               value compared to itself cannot disagree, so a "100% match"
//               here would be a tick that can never fail.
//   2 sources — the real comparison, with a real percentage.
//
// requireAuth/requireWorkspace are mocked as passthroughs and req.user /
// req.workspaceObjectId injected directly — same harness shape as
// workspace.travellers.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));

function chainable(value: any) {
  const obj: any = {
    select: () => obj,
    sort: () => obj,
    limit: () => obj,
    lean: () => Promise.resolve(value),
    exec: () => Promise.resolve(value),
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
  };
  return obj;
}

const tpFindOneMock = vi.fn();
vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    find: () => chainable([]),
    findOne: (...args: any[]) => chainable(tpFindOneMock(...args)),
    create: vi.fn(),
  },
  MEAL_PREFERENCE_CODES: ["VGML"],
  LOYALTY_PROGRAMME_TYPES: ["HOTEL", "CAR", "RAIL", "OTHER"],
  SEAT_PREFERENCES: ["WINDOW", "AISLE", "MIDDLE", "NO_PREFERENCE"],
  HOTEL_PREFERENCES: ["NON_SMOKING"],
  // Slice 2 vocabularies, mirrored from the model so the route's
  // allowlisting is exercised against the values production uses.
  PASSPORT_BOOKLET_SIZES: ["36", "60"],
  PASSPORT_ECR_STATUSES: ["ECR", "ECNR"],
  TRAVEL_BADGE_PROGRAMMES: [
    "GLOBAL_ENTRY", "APEC_ABTC", "TSA_PRECHECK", "NEXUS", "SENTRI", "OTHER",
  ],
}));

// The second source's two collections. VisaDocument is applicationId-keyed,
// so the lookup is traveller -> applications -> documents.
const visaAppFindMock = vi.fn();
vi.mock("../models/VisaApplication.js", () => ({
  default: { find: (...args: any[]) => chainable(visaAppFindMock(...args)) },
}));

const visaDocFindMock = vi.fn();
vi.mock("../models/VisaDocument.js", () => ({
  default: { find: (...args: any[]) => chainable(visaDocFindMock(...args)) },
}));

// requireActiveMember reads findOne(...).lean().exec(), so `lean()` must
// return a thenable that ALSO has .exec — same shape workspace.travellers
// .test.ts's `leanish` uses.
function leanish(value: any) {
  return {
    exec: () => Promise.resolve(value),
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
  };
}

const cmFindOneMock = vi.fn();
vi.mock("../models/CustomerMember.js", () => ({
  default: {
    findOne: (...args: any[]) => {
      const value = cmFindOneMock(...args);
      return {
        lean: () => leanish(value),
        select: () => ({ lean: () => leanish(value) }),
      };
    },
  },
}));

vi.mock("../models/CustomerWorkspace.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve({}) }) }) },
}));
vi.mock("../models/Customer.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve({ legalName: "Acme" }) }) }) },
}));
vi.mock("../models/Designation.js", () => ({
  default: { findOne: () => chainable(null), find: () => chainable([]), create: vi.fn(), updateOne: vi.fn() },
}));
vi.mock("../models/User.js", () => ({
  default: { findOne: () => chainable(null), findById: () => chainable(null), find: () => chainable([]) },
}));
vi.mock("../services/travellerAutoCapture.js", () => ({
  autoCaptureTravellersFromBooking: vi.fn(),
}));

import express from "express";
import request from "supertest";
import travellerRouter from "./workspace.travellers.js";

const WORKSPACE_ID = "workspace0000000000000001";
const TRAVELLER_ID = "traveller000000000000001";

/** A profile with a complete, MRZ-composable passport block. */
const FULL_PASSPORT = {
  _id: TRAVELLER_ID,
  travelerId: "ACME-001",
  firstName: "Anna",
  middleName: "Maria",
  lastName: "Eriksson",
  gender: "Female",
  dob: "1974-08-12",
  nationality: "IN",
  passportNo: "L898902C3",
  passportExpiry: "2012-04-15",
  passportIssueCountry: "IN",
  createdBy: "leader-user",
};

/** The MRZ as visaPassportExtraction.ts actually stores it. */
const EXTRACTED_FIELDS = [
  { key: "documentType", value: "P" },
  { key: "issuingState", value: "IND" },
  { key: "surname", value: "ERIKSSON" },
  { key: "givenNames", value: "ANNA MARIA" },
  { key: "documentNumber", value: "L898902C3" },
  { key: "nationality", value: "IND" },
  { key: "dateOfBirth", value: "740812" },
  { key: "sex", value: "F" },
  { key: "dateOfExpiry", value: "120415" },
  { key: "check_composite", value: "passed" },
];

function makeApp(user: any = { _id: "leader-user", id: "leader-user", email: "leader@acme.com" }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspace = { customerId: "customer0000000000000001" };
    req.workspaceObjectId = WORKSPACE_ID;
    next();
  });
  app.use("/", travellerRouter);
  return app;
}

/** Puts a usable extraction behind the traveller's visa applications. */
function withExtraction(overrides: Record<string, any> = {}) {
  visaAppFindMock.mockReturnValue([{ _id: "application0000000000001" }]);
  visaDocFindMock.mockReturnValue([
    {
      _id: "document00000000000001",
      applicationId: "application0000000000001",
      extractedFields: EXTRACTED_FIELDS,
      extractionStatus: "COMPLETED",
      extractionConfidence: "high",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      ...overrides,
    },
  ]);
}

beforeEach(() => {
  tpFindOneMock.mockReset().mockReturnValue(FULL_PASSPORT);
  // Default: no visa applications at all, so no second source.
  visaAppFindMock.mockReset().mockReturnValue([]);
  visaDocFindMock.mockReset().mockReturnValue([]);
  cmFindOneMock.mockReset().mockReturnValue({ _id: "member1", role: "WORKSPACE_LEADER", isActive: true });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE THREE STATES
 * ═══════════════════════════════════════════════════════════════════════ */

describe("GET /:id passportVault — source counting", () => {
  it("0 SOURCES: no typed passport and no extraction => no comparison, no percentage", async () => {
    tpFindOneMock.mockReturnValue({
      _id: TRAVELLER_ID, firstName: "Anna", lastName: "Eriksson", createdBy: "leader-user",
    });

    const res = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    expect(res.status).toBe(200);

    const { mismatch } = res.body.passportVault;
    expect(mismatch.sourceCount).toBe(0);
    expect(mismatch.hasTypedPassport).toBe(false);
    expect(mismatch.hasExtraction).toBe(false);
    // The client renders NOTHING at 0 — there must be no comparison object
    // for it to be tempted into drawing.
    expect(mismatch.comparison).toBeNull();
    expect(mismatch.reason).toBeTruthy();
  });

  it("1 SOURCE: a typed passport with no scan makes NO match claim", async () => {
    const res = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    expect(res.status).toBe(200);

    const { mismatch } = res.body.passportVault;
    expect(mismatch.sourceCount).toBe(1);
    expect(mismatch.hasTypedPassport).toBe(true);
    expect(mismatch.hasExtraction).toBe(false);
    // THE RULE. One source compared to itself is not a check, so there is
    // no comparison and therefore no percentage anywhere in the payload.
    expect(mismatch.comparison).toBeNull();
    expect(JSON.stringify(res.body.passportVault)).not.toContain("matchPercent");
    expect(mismatch.reason).toContain("No passport scan on file");
  });

  it("1 SOURCE the other way round: an extraction with nothing typed also makes no claim", async () => {
    tpFindOneMock.mockReturnValue({
      _id: TRAVELLER_ID, firstName: "Anna", lastName: "Eriksson", createdBy: "leader-user",
    });
    withExtraction();

    const { body } = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    expect(body.passportVault.mismatch.sourceCount).toBe(1);
    expect(body.passportVault.mismatch.hasExtraction).toBe(true);
    expect(body.passportVault.mismatch.hasTypedPassport).toBe(false);
    expect(body.passportVault.mismatch.comparison).toBeNull();
  });

  it("2 SOURCES: the real comparison, with a real percentage", async () => {
    withExtraction();

    const { body } = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    const { mismatch } = body.passportVault;

    expect(mismatch.sourceCount).toBe(2);
    expect(mismatch.hasTypedPassport).toBe(true);
    expect(mismatch.hasExtraction).toBe(true);
    expect(mismatch.reason).toBeNull();

    expect(mismatch.comparison).not.toBeNull();
    expect(mismatch.comparison.matchPercent).toBe(100);
    expect(mismatch.comparison.comparedCount).toBe(8);
    expect(mismatch.comparison.mismatchedCount).toBe(0);
    expect(mismatch.extractionStatus).toBe("COMPLETED");
    expect(mismatch.extractionConfidence).toBe("high");
    expect(mismatch.extractedAt).toBeTruthy();
  });

  it("2 SOURCES with a genuine discrepancy: the mismatch is reported per field", async () => {
    withExtraction({
      extractedFields: EXTRACTED_FIELDS.map((f) =>
        f.key === "surname" ? { key: "surname", value: "SHARMA" } : f,
      ),
    });

    const { body } = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    const { comparison } = body.passportVault.mismatch;

    expect(comparison.mismatchedCount).toBe(1);
    expect(comparison.matchPercent).toBe(88);
    const surname = comparison.rows.find((r: any) => r.field === "surname");
    expect(surname.status).toBe("MISMATCH");
    expect(surname.profileValue).toBe("Eriksson");
    expect(surname.extractedValue).toBe("SHARMA");
  });

  it("a FAILED extraction is not a second source", async () => {
    // markFailed writes into the same extractedFields array. Counting it
    // would render a comparison panel of entirely "not comparable" rows,
    // which reads as "we checked and found nothing wrong".
    withExtraction({
      extractionStatus: "COMPLETED",
      extractedFields: [
        { key: "failureCategory", value: "NO_MRZ_FOUND" },
        { key: "error", value: "No MRZ detected." },
      ],
    });

    const { body } = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    expect(body.passportVault.mismatch.sourceCount).toBe(1);
    expect(body.passportVault.mismatch.hasExtraction).toBe(false);
    expect(body.passportVault.mismatch.comparison).toBeNull();
  });

  it("only queries documents whose extraction actually produced MRZ fields", async () => {
    withExtraction();
    await request(makeApp()).get(`/${TRAVELLER_ID}`);

    const filter = visaDocFindMock.mock.calls[0][0];
    expect(filter.extractionStatus).toEqual({ $in: ["COMPLETED", "NEEDS_REVIEW"] });
    expect(filter.deletedAt).toBeNull();
    // Tenant-bound in the query itself, never trusted from the traveller row.
    expect(filter.workspaceId).toBe(WORKSPACE_ID);
  });

  it("scopes the application lookup to this traveller AND this workspace", async () => {
    await request(makeApp()).get(`/${TRAVELLER_ID}`);
    expect(visaAppFindMock).toHaveBeenCalledWith(
      expect.objectContaining({ travellerProfileId: TRAVELLER_ID, workspaceId: WORKSPACE_ID }),
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE COMPOSED MRZ — a rendering, never a verification
 * ═══════════════════════════════════════════════════════════════════════ */

describe("GET /:id passportVault — the composed MRZ", () => {
  it("composes both TD3 lines from the stored passport fields", async () => {
    const { body } = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    const { mrz } = body.passportVault;

    expect(mrz.available).toBe(true);
    expect(mrz.line1).toBe("P<INDERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<");
    expect(mrz.line1).toHaveLength(44);
    expect(mrz.line2).toHaveLength(44);
    expect(mrz.sex).toBe("F");
    expect(mrz.issuingState).toBe("IND");
  });

  it("NEVER ships a check-digit verification result over the composed MRZ", async () => {
    // The single most important assertion in this file. We computed those
    // check digits from our own fields, so "verifying" them passes by
    // construction — a green tick that cannot fail, over data that could be
    // entirely mistyped. The payload must give the client nothing to render
    // as one. See utils/mrzCompose.ts's header and design doc §7.2(b).
    const { body } = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    const serialised = JSON.stringify(body.passportVault.mrz);

    for (const forbidden of ["verified", "checksPassed", "checks", "checkDigit", "valid", "confidence"]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // What it says instead: a plain statement of where the lines came from.
    expect(body.passportVault.mrz.basis).toBe(
      "Generated from the passport details on this profile.",
    );
  });

  it("renders NO MRZ, and names the gap, when a country cannot be mapped to an ICAO code", async () => {
    tpFindOneMock.mockReturnValue({ ...FULL_PASSPORT, passportIssueCountry: "Narnia" });

    const { body } = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    expect(body.passportVault.mrz.available).toBe(false);
    expect(body.passportVault.mrz.line1).toBeUndefined();
    const gap = body.passportVault.mrz.gaps.find((g: any) => g.field === "passportIssueCountry");
    expect(gap.reason).toContain("Narnia");
  });

  it("renders NO MRZ when the passport block is empty, listing what is needed", async () => {
    tpFindOneMock.mockReturnValue({
      _id: TRAVELLER_ID, firstName: "Anna", lastName: "Eriksson", createdBy: "leader-user",
    });

    const { body } = await request(makeApp()).get(`/${TRAVELLER_ID}`);
    expect(body.passportVault.mrz.available).toBe(false);
    expect(body.passportVault.mrz.gaps.map((g: any) => g.field)).toEqual(
      expect.arrayContaining(["passportNo", "dob", "passportExpiry", "nationality", "passportIssueCountry"]),
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * FIELD GATING — the new passport keys are SELF-editable
 * ═══════════════════════════════════════════════════════════════════════ */

describe("PUT /:id — Tab 2 field gating", () => {
  /**
   * PUT loads a real Mongoose DOCUMENT (not .lean()), so the mock has to
   * behave like one: assignable properties plus a .save().
   */
  function travellerDoc(overrides: Record<string, any> = {}): Record<string, any> {
    return { ...FULL_PASSPORT, travelBadges: [], save: vi.fn().mockResolvedValue(undefined), ...overrides };
  }

  it("a REQUESTER editing their OWN record may set the new passport fields", async () => {
    // These are facts printed on the holder's own document — the holder is
    // the only person looking at it.
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc = travellerDoc({ createdBy: "self-user" });
    tpFindOneMock.mockReturnValue(doc);

    const res = await request(makeApp({ _id: "self-user", id: "self-user", email: "anna@acme.com" }))
      .put(`/${TRAVELLER_ID}`)
      .send({
        passportPlaceOfIssue: "Bengaluru",
        passportBookletSize: "60",
        passportEcrStatus: "ECNR",
        passportBlankPagesRemaining: "12",
      });

    expect(res.status).toBe(200);
    expect(doc.passportPlaceOfIssue).toBe("Bengaluru");
    expect(doc.passportBookletSize).toBe("60");
    expect(doc.passportEcrStatus).toBe("ECNR");
    expect(doc.passportBlankPagesRemaining).toBe(12);
    expect(doc.save).toHaveBeenCalled();
  });

  it("…but still cannot set an ADMIN-only field, and is told which one", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindOneMock.mockReturnValue(travellerDoc({ createdBy: "self-user" }));

    const res = await request(makeApp({ _id: "self-user", id: "self-user", email: "anna@acme.com" }))
      .put(`/${TRAVELLER_ID}`)
      .send({ passportPlaceOfIssue: "Bengaluru", workLocation: "HQ" });

    expect(res.status).toBe(403);
    expect(res.body.fields).toEqual(["workLocation"]);
  });

  it("stamps the blank-pages declaration date when the count CHANGES", async () => {
    // The figure decays — nothing observes a stamp — so it is only
    // meaningful alongside the date it was declared.
    const doc = travellerDoc({ passportBlankPagesRemaining: 4 });
    tpFindOneMock.mockReturnValue(doc);

    await request(makeApp()).put(`/${TRAVELLER_ID}`).send({ passportBlankPagesRemaining: "10" });

    expect(doc.passportBlankPagesRemaining).toBe(10);
    expect(doc.passportBlankPagesDeclaredAt).toBeInstanceOf(Date);
  });

  it("does NOT re-stamp when the count is resent unchanged", async () => {
    // The form sends every field on every save, so re-stamping here would
    // silently refresh a two-year-old figure to today on an unrelated edit —
    // erasing exactly the staleness the stamp exists to expose.
    const declaredAt = new Date("2024-01-01T00:00:00Z");
    const doc = travellerDoc({ passportBlankPagesRemaining: 4, passportBlankPagesDeclaredAt: declaredAt });
    tpFindOneMock.mockReturnValue(doc);

    await request(makeApp()).put(`/${TRAVELLER_ID}`).send({ passportBlankPagesRemaining: "4" });

    expect(doc.passportBlankPagesDeclaredAt).toBe(declaredAt);
  });

  it("clears the stamp along with the value", async () => {
    const doc = travellerDoc({
      passportBlankPagesRemaining: 4,
      passportBlankPagesDeclaredAt: new Date("2024-01-01T00:00:00Z"),
    });
    tpFindOneMock.mockReturnValue(doc);

    await request(makeApp()).put(`/${TRAVELLER_ID}`).send({ passportBlankPagesRemaining: "" });

    expect(doc.passportBlankPagesRemaining).toBeUndefined();
    expect(doc.passportBlankPagesDeclaredAt).toBeUndefined();
  });

  it("keeps a declared 0 rather than treating it as 'not stated'", async () => {
    // "This booklet is full" and "we don't know" are very different things
    // to someone about to travel.
    const doc = travellerDoc();
    tpFindOneMock.mockReturnValue(doc);

    await request(makeApp()).put(`/${TRAVELLER_ID}`).send({ passportBlankPagesRemaining: "0" });

    expect(doc.passportBlankPagesRemaining).toBe(0);
    expect(doc.passportBlankPagesDeclaredAt).toBeInstanceOf(Date);
  });

  it("drops an out-of-vocabulary enum value instead of rejecting the whole save", async () => {
    const doc = travellerDoc({ passportBookletSize: "36" });
    tpFindOneMock.mockReturnValue(doc);

    const res = await request(makeApp())
      .put(`/${TRAVELLER_ID}`)
      .send({ passportBookletSize: "48", passportEcrStatus: "MAYBE", passportPlaceOfIssue: "Pune" });

    expect(res.status).toBe(200);
    expect(doc.passportBookletSize).toBeUndefined();
    expect(doc.passportEcrStatus).toBeUndefined();
    expect(doc.passportPlaceOfIssue).toBe("Pune");
  });

  it("stores travel badges as typed, and drops rows identifying no membership", async () => {
    const doc = travellerDoc();
    tpFindOneMock.mockReturnValue(doc);

    await request(makeApp())
      .put(`/${TRAVELLER_ID}`)
      .send({
        travelBadges: [
          { programme: "GLOBAL_ENTRY", number: "99887766", expiry: "2029-06-30" },
          { programme: "APEC_ABTC", number: "", programmeName: "" },
          { programme: "NOT_A_PROGRAMME", number: "12345" },
        ],
      });

    expect(doc.travelBadges).toEqual([
      { programme: "GLOBAL_ENTRY", programmeName: "", number: "99887766", expiry: "2029-06-30" },
      { programme: undefined, programmeName: "", number: "12345", expiry: "" },
    ]);
  });

  it("never derives a validity status from a badge expiry", async () => {
    // No CBP/ABTC/TSA integration exists, so the expiry is echoed as the
    // date the traveller entered and nothing more. A stored "Active"/
    // "Valid" would be a claim about a membership nobody has checked.
    const doc = travellerDoc();
    tpFindOneMock.mockReturnValue(doc);

    await request(makeApp())
      .put(`/${TRAVELLER_ID}`)
      .send({ travelBadges: [{ programme: "GLOBAL_ENTRY", number: "1", expiry: "2020-01-01" }] });

    const stored = JSON.stringify(doc.travelBadges).toLowerCase();
    for (const forbidden of ["active", "valid", "verified", "status", "expired"]) {
      expect(stored).not.toContain(forbidden);
    }
  });
});
