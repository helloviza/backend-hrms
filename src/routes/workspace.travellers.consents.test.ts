// Coverage for the DPDP Privacy Control (Tab 6) and the gated Tax
// Identification block — slice 4, 2026-08-11.
//
// AGAINST A REAL DATABASE (mongodb-memory-server), for the same reason
// slice 3's wallet test is: the ledger is a three-collection join
// (TravellerProfile -> VisaApplication -> VisaRequest) over PERSISTED
// sub-documents, and consents[] is a sub-document array — precisely the
// shape a literal fixture gets wrong (an array path Mongoose defaults to
// [] reads differently from a hand-written object, which is the whole
// literal-vs-document gap).
//
// The harness is ISOLATED: a private mongod on a throwaway data directory,
// torn down here. Nothing in this file can reach a configured MONGO_URI and
// nothing writes a consent record into any real database.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import travellerRouter from "./workspace.travellers.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerMember from "../models/CustomerMember.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";
import User from "../models/User.js";
import { resolveConsentLedger } from "../services/travellerConsent.service.js";
import {
  VISA_PLATFORM_CAPABILITIES,
  isIdentityNumberCaptureEnabled,
  isIdentityVerificationAvailable,
  IDENTITY_CAPTURE_DISABLED_MESSAGE,
} from "../config/platformCapabilities.js";
import { CURRENT_VISA_CONSENT_VERSION, VISA_CONSENT_CLAUSE_IDS } from "../config/visaConsent.js";

let mongod: MongoMemoryServer;

const WORKSPACE_A = new mongoose.Types.ObjectId();
const WORKSPACE_B = new mongoose.Types.ObjectId();
const CUSTOMER_A = "customer-a";
const LEADER_USER_ID = new mongoose.Types.ObjectId();
const SUBJECT_USER_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

function makeApp(workspaceId: mongoose.Types.ObjectId, customerId: string, email = "leader@acme.test") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(LEADER_USER_ID), email, roles: ["CUSTOMER"] };
    req.workspaceObjectId = workspaceId;
    req.workspace = { _id: workspaceId, customerId };
    next();
  });
  app.use(travellerRouter);
  return app;
}

async function seedTraveller(
  workspaceId: mongoose.Types.ObjectId,
  travelerId: string,
  claimedBy?: mongoose.Types.ObjectId,
) {
  return TravellerProfile.create({
    workspaceId,
    travelerId,
    firstName: "Asha",
    lastName: "Rao",
    source: "MANUAL",
    createdBy: LEADER_USER_ID,
    ...(claimedBy ? { claimedBy } : {}),
  });
}

/**
 * A submitted request carrying the three real clause rows, plus an
 * application tying it to the traveller. Mirrors exactly what
 * routes/visa.ts's POST /requests/:id/submit writes.
 */
async function seedSubmittedRequest(opts: {
  workspaceId: mongoose.Types.ObjectId;
  travellerProfileId: any;
  referenceNumber: string;
  acceptedByUserId: mongoose.Types.ObjectId;
  version?: string;
  clauseIds?: readonly string[];
  destinationIso2?: string;
  extraApplicants?: number;
}) {
  const req: any = await VisaRequest.create({
    workspaceId: opts.workspaceId,
    raisedByUserId: opts.acceptedByUserId,
    customerId: CUSTOMER_A,
    destinationIso2: opts.destinationIso2 ?? "DE",
    purpose: "TOURIST",
    referenceNumber: opts.referenceNumber,
    submittedAt: new Date("2026-07-01T10:00:00Z"),
    consents: (opts.clauseIds ?? VISA_CONSENT_CLAUSE_IDS).map((clauseId) => ({
      clauseId,
      version: opts.version ?? CURRENT_VISA_CONSENT_VERSION,
      acceptedAt: new Date("2026-07-01T10:00:00Z"),
      acceptedByUserId: opts.acceptedByUserId,
    })),
  });

  const application: any = await VisaApplication.create({
    workspaceId: opts.workspaceId,
    requestId: req._id,
    travellerProfileId: opts.travellerProfileId,
    customerId: CUSTOMER_A,
    ruleSnapshot: {
      ruleId: new mongoose.Types.ObjectId(),
      capturedAt: new Date(),
      destinationName: "Germany",
      isSchengen: true,
      productClass: "VISA",
      visaCategory: "STICKER",
      purpose: "TOURIST",
      entryType: "SINGLE",
      serviceTier: "STANDARD",
    },
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 1000 },
  });

  const applicationIds = [application._id];
  // Extra applicants make the request cover more than this traveller — the
  // case where the consent is plainly not this person's individual act.
  for (let i = 0; i < (opts.extraApplicants ?? 0); i++) {
    applicationIds.push(new mongoose.Types.ObjectId());
  }
  await VisaRequest.updateOne({ _id: req._id }, { $set: { applicationIds } });

  return { request: req, application };
}

beforeEach(async () => {
  await Promise.all([
    TravellerProfile.deleteMany({}),
    VisaRequest.deleteMany({}),
    VisaApplication.deleteMany({}),
    CustomerMember.deleteMany({}),
    User.deleteMany({}),
  ]);
  await CustomerMember.create({
    customerId: CUSTOMER_A, email: "leader@acme.test", role: "WORKSPACE_LEADER", isActive: true,
  });
  await User.create([
    {
      _id: LEADER_USER_ID, workspaceId: WORKSPACE_A, name: "Sara Leader",
      email: "leader@acme.test", passwordHash: "x", roles: ["CUSTOMER"],
    },
    {
      _id: SUBJECT_USER_ID, workspaceId: WORKSPACE_A, name: "Asha Rao",
      email: "asha@acme.test", passwordHash: "x", roles: ["CUSTOMER"],
    },
  ]);
});

/* ── The ledger renders REAL, REQUEST-SCOPED rows ────────────────────── */

describe("consent ledger — real rows, scoped to their request", () => {
  it("renders each consent under the request it was given for", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-001");
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A,
      travellerProfileId: t._id,
      referenceNumber: "HV26-000123",
      acceptedByUserId: LEADER_USER_ID,
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    const group = res.body.requests[0];
    // THE SCOPE. Every row travels attached to a named request — this is
    // what stops a per-request consent reading as a standing one.
    expect(group.referenceNumber).toBe("HV26-000123");
    expect(group.destinationIso2).toBe("DE");
    expect(group.consents).toHaveLength(3);
    expect(res.body.recordCount).toBe(3);

    const clauseIds = group.consents.map((c: any) => c.clauseId).sort();
    expect(clauseIds).toEqual([...VISA_CONSENT_CLAUSE_IDS].sort());
  });

  it("carries the real clause, version and timestamp on every row", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-002");
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A,
      travellerProfileId: t._id,
      referenceNumber: "HV26-000124",
      acceptedByUserId: LEADER_USER_ID,
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);
    const row = res.body.requests[0].consents.find((c: any) => c.clauseId === "DATA_PROCESSING");

    expect(row.version).toBe(CURRENT_VISA_CONSENT_VERSION);
    expect(new Date(row.acceptedAt).toISOString()).toBe("2026-07-01T10:00:00.000Z");
    // Current version => we still hold the wording, so it is shown verbatim.
    expect(row.isCurrentVersion).toBe(true);
    expect(row.clauseText).toContain("Digital Personal Data Protection Act");
  });

  it("NEVER exposes a profile-level consent claim", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-003");
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A,
      travellerProfileId: t._id,
      referenceNumber: "HV26-000125",
      acceptedByUserId: LEADER_USER_ID,
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);

    // THE CENTRAL RULE (§7.5). Three real consent rows exist, and the
    // payload still offers NO aggregate a surface could render as "this
    // traveller has consented". Asserted over key names so a future field
    // called hasConsented/consentValid/dpdpCompliant fails here before it
    // can reach a screen.
    const keysOf = (v: any): string[] =>
      v && typeof v === "object"
        ? Object.keys(v).concat(Object.values(v).flatMap(keysOf))
        : [];
    const keys = keysOf(res.body).map((k) => k.toLowerCase());
    for (const forbidden of [
      "hasconsented", "consentheld", "consentvalid", "consented",
      "dpdpcompliant", "compliant", "iscompliant", "consentstatus", "verified",
    ]) {
      expect(keys).not.toContain(forbidden);
    }

    // The one profile-level statement that IS present says the opposite of
    // a claim: nothing covers the profile.
    expect(res.body.profileConsent.captured).toBe(false);
    expect(res.body.profileConsent.message).toMatch(/isn't built yet/i);

    // And every consent row is reachable ONLY through a request group —
    // there is no flat top-level consents array to render unscoped.
    expect(res.body.consents).toBeUndefined();
    for (const group of res.body.requests) {
      expect(group.requestId).toBeTruthy();
      expect(group.consents.length).toBeGreaterThan(0);
    }
  });

  it("names WHO accepted, and does not attribute a colleague's click to the traveller", async () => {
    // The common case: a workspace leader submits one request covering
    // several colleagues. The consent is real, but it is not this
    // traveller's own act, and the ledger must not caption it as one.
    const t = await seedTraveller(WORKSPACE_A, "ACME-004", SUBJECT_USER_ID);
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A,
      travellerProfileId: t._id,
      referenceNumber: "HV26-000126",
      acceptedByUserId: LEADER_USER_ID, // NOT the subject
      extraApplicants: 2,
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);
    const group = res.body.requests[0];

    expect(group.applicantCount).toBe(3);
    for (const row of group.consents) {
      expect(row.acceptedBySubject).toBe(false);
      expect(row.acceptedByName).toBe("Sara Leader");
    }
  });

  it("marks a row accepted by the traveller themselves", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-005", SUBJECT_USER_ID);
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A,
      travellerProfileId: t._id,
      referenceNumber: "HV26-000127",
      acceptedByUserId: SUBJECT_USER_ID,
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);
    for (const row of res.body.requests[0].consents) {
      expect(row.acceptedBySubject).toBe(true);
      expect(row.acceptedByName).toBe("Asha Rao");
    }
  });

  it("does NOT show today's wording against an older notice version", async () => {
    // A v1 row genuinely exists in production (the consent-array migration
    // back-filled REPRESENTATION @ v1). config/visaConsent.ts only holds v2
    // text, so showing it here would assert they accepted wording that did
    // not exist when they clicked.
    const t = await seedTraveller(WORKSPACE_A, "ACME-006");
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A,
      travellerProfileId: t._id,
      referenceNumber: "HV26-000128",
      acceptedByUserId: LEADER_USER_ID,
      version: "v1",
      clauseIds: ["REPRESENTATION"],
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);
    const row = res.body.requests[0].consents[0];

    expect(row.version).toBe("v1");
    expect(row.isCurrentVersion).toBe(false);
    // Null, not the v2 text — and the clause is still NAMED, because which
    // clause was accepted is a fact the record does store.
    expect(row.clauseText).toBeNull();
    expect(row.clauseName).toBe("Authorisation to represent");
  });

  it("groups rows per request when a traveller has several", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-007");
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A, travellerProfileId: t._id,
      referenceNumber: "HV26-000129", acceptedByUserId: LEADER_USER_ID,
    });
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A, travellerProfileId: t._id,
      referenceNumber: "HV26-000130", acceptedByUserId: LEADER_USER_ID,
      destinationIso2: "FR",
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);
    expect(res.body.requests).toHaveLength(2);
    expect(res.body.recordCount).toBe(6);
    // Each group keeps its own reference — never merged into one list.
    const refs = res.body.requests.map((r: any) => r.referenceNumber).sort();
    expect(refs).toEqual(["HV26-000129", "HV26-000130"]);
  });
});

/* ── Honest empties ──────────────────────────────────────────────────── */

describe("consent ledger — empty states", () => {
  it("returns no rows for a traveller with no requests", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-010");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);

    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
    expect(res.body.recordCount).toBe(0);
    // Not a pre-filled ledger, and not a claim either way.
    expect(res.body.profileConsent.captured).toBe(false);
  });

  it("drops a request that has no consent rows rather than rendering it empty", async () => {
    // A draft that was never submitted has no consent to report. An empty
    // group under a reference number would read as "consent missing" when
    // the truth is "never asked for yet".
    const t = await seedTraveller(WORKSPACE_A, "ACME-011");
    const req: any = await VisaRequest.create({
      workspaceId: WORKSPACE_A,
      raisedByUserId: LEADER_USER_ID,
      customerId: CUSTOMER_A,
      destinationIso2: "DE",
      purpose: "TOURIST",
      referenceNumber: "HV26-000131",
      consents: [],
    });
    await VisaApplication.create({
      workspaceId: WORKSPACE_A,
      requestId: req._id,
      travellerProfileId: t._id,
      customerId: CUSTOMER_A,
      ruleSnapshot: {
        ruleId: new mongoose.Types.ObjectId(), capturedAt: new Date(),
        destinationName: "Germany", isSchengen: true, productClass: "VISA",
        visaCategory: "STICKER", purpose: "TOURIST", entryType: "SINGLE", serviceTier: "STANDARD",
      },
      indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 1000 },
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);
    expect(res.body.requests).toEqual([]);
    expect(res.body.recordCount).toBe(0);
  });
});

/* ── Read-only ───────────────────────────────────────────────────────── */

describe("consent ledger is read-only", () => {
  it("reports canEdit false with a reason", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-020");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}/consents`);

    expect(res.body.capabilities.canEdit).toBe(false);
    expect(res.body.capabilities.canWithdraw).toBe(false);
    expect(res.body.capabilities.readOnlyReason).toMatch(/audit trail/i);
  });

  it("exposes NO write verb at all", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-021");
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A, travellerProfileId: t._id,
      referenceNumber: "HV26-000140", acceptedByUserId: LEADER_USER_ID,
    });
    const app = makeApp(WORKSPACE_A, CUSTOMER_A);

    // Editing a consent record would rewrite evidence of a legal act rather
    // than correct it. There is one verb, GET — asserted so a later change
    // cannot quietly add a "fix this row" affordance.
    expect((await request(app).post(`/${t._id}/consents`).send({})).status).toBe(404);
    expect((await request(app).put(`/${t._id}/consents`).send({})).status).toBe(404);
    expect((await request(app).patch(`/${t._id}/consents`).send({})).status).toBe(404);
    expect((await request(app).delete(`/${t._id}/consents`)).status).toBe(404);

    // And the rows are untouched.
    const stored: any = await VisaRequest.findOne({ referenceNumber: "HV26-000140" }).lean();
    expect(stored.consents).toHaveLength(3);
  });
});

/* ── Scoping and access ──────────────────────────────────────────────── */

describe("consent ledger scoping", () => {
  it("never returns another workspace's consent rows", async () => {
    const tA = await seedTraveller(WORKSPACE_A, "ACME-030");
    const tB = await seedTraveller(WORKSPACE_B, "BETA-030");
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A, travellerProfileId: tA._id,
      referenceNumber: "HV26-A", acceptedByUserId: LEADER_USER_ID,
    });
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_B, travellerProfileId: tB._id,
      referenceNumber: "HV26-B", acceptedByUserId: LEADER_USER_ID,
    });

    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${tA._id}/consents`);
    expect(res.body.requests.map((r: any) => r.referenceNumber)).toEqual(["HV26-A"]);
  });

  it("refuses a REQUESTER who is neither the subject nor the creator", async () => {
    await CustomerMember.deleteMany({});
    await CustomerMember.create({
      customerId: CUSTOMER_A, email: "employee@acme.test", role: "REQUESTER", isActive: true,
    });
    const t = await TravellerProfile.create({
      workspaceId: WORKSPACE_A, travelerId: "ACME-031", firstName: "Someone", lastName: "Else",
      source: "MANUAL", createdBy: new mongoose.Types.ObjectId(),
    });

    // A record of what a named person legally agreed to is squarely the
    // class of dossier a colleague has no business browsing.
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A, "employee@acme.test"))
      .get(`/${t._id}/consents`);
    expect(res.status).toBe(403);
  });
});

/* ── The service, directly ───────────────────────────────────────────── */

describe("resolveConsentLedger", () => {
  it("returns an empty ledger, never a fabricated row, with no applications", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-040");
    const ledger = await resolveConsentLedger(t._id, WORKSPACE_A, {
      subjectUserId: null,
      profileConsentMessage: "not built",
    });
    expect(ledger.requests).toEqual([]);
    expect(ledger.recordCount).toBe(0);
    expect(ledger.profileConsent).toEqual({ captured: false, message: "not built" });
  });

  it("treats an unresolvable accepting user as unknown, not as the traveller", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-041", SUBJECT_USER_ID);
    const ghost = new mongoose.Types.ObjectId(); // no User row
    await seedSubmittedRequest({
      workspaceId: WORKSPACE_A, travellerProfileId: t._id,
      referenceNumber: "HV26-000150", acceptedByUserId: ghost,
    });

    const ledger = await resolveConsentLedger(t._id, WORKSPACE_A, {
      subjectUserId: String(SUBJECT_USER_ID),
      profileConsentMessage: "not built",
    });
    const row = ledger.requests[0].consents[0];
    expect(row.acceptedByName).toBeNull();
    // The safe direction to be wrong in: unknown, never silently the subject.
    expect(row.acceptedBySubject).toBe(false);
  });
});

/* ── TAX IDENTIFICATION — the gated block ────────────────────────────── */

describe("tax identification — PAN / Aadhaar stay gated", () => {
  it("refuses to store a PAN or Aadhaar number, for every role", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-050");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A))
      .put(`/${t._id}`)
      .send({ panNumber: "ABCDE1234F", aadhaarNumber: "123412341234" });

    // 422, not 403: this is build state, not a permission — the same
    // refusal a SUPERADMIN gets.
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(IDENTITY_CAPTURE_DISABLED_MESSAGE);

    const stored: any = await TravellerProfile.findById(t._id).lean();
    expect(stored.pan?.number).toBeUndefined();
    expect(stored.aadhaar?.number).toBeUndefined();
  });

  it("reports the gated state, with no value and no verification claim", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-051");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}`);

    expect(res.body.identityCapture.enabled).toBe(false);
    expect(res.body.identityCapture.message).toBe(IDENTITY_CAPTURE_DISABLED_MESSAGE);
    // Nothing is stored, so there is nothing to take the last four of.
    expect(res.body.traveller.pan?.number).toBeUndefined();
    expect(res.body.traveller.aadhaar?.number).toBeUndefined();
  });

  it("keeps VERIFICATION a separate gate that the encryption flag cannot light", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-052");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}`);

    expect(res.body.identityCapture.verificationAvailable).toBe(false);

    // THE §7.1 RULE, asserted as a property of the code rather than of
    // today's config: flipping the encryption flag on must earn the CAPTURE
    // and nothing else. If someone ever implements the badge off
    // isIdentityNumberCaptureEnabled(), this fails.
    const original = (VISA_PLATFORM_CAPABILITIES as any).mrzEncryptionAtRest;
    try {
      (VISA_PLATFORM_CAPABILITIES as any).mrzEncryptionAtRest = true;
      expect(isIdentityNumberCaptureEnabled()).toBe(true);
      // Still false. Verification needs a real UIDAI integration, which
      // does not exist anywhere in this codebase.
      expect(isIdentityVerificationAvailable()).toBe(false);
    } finally {
      (VISA_PLATFORM_CAPABILITIES as any).mrzEncryptionAtRest = original;
    }
  });

  it("never sends a verified/UIDAI badge field on the traveller payload", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-053");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A)).get(`/${t._id}`);

    const serialised = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ["uidai", "aadhaarverified", "panverified", "identityverified"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("lets tax residency be set — it is not a regulated ID and is not gated", async () => {
    const t = await seedTraveller(WORKSPACE_A, "ACME-054");
    const res = await request(makeApp(WORKSPACE_A, CUSTOMER_A))
      .put(`/${t._id}`)
      .send({ taxResidency: "IN" });

    expect(res.status).toBe(200);
    const stored: any = await TravellerProfile.findById(t._id).lean();
    expect(stored.taxResidency).toBe("IN");
  });
});
