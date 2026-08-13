// Screening authority — step 1 (2026-08-12).
//
// The mechanism ships WIRED BUT DORMANT, so the two states are two real code
// paths and both need real coverage:
//
//   flag OFF (the default) — today's behaviour, byte for byte. This is the
//     critical half. The audit found nobody holds visaScreening and no case
//     has an assigned screener, so if the dormant gate leaked even slightly
//     it would refuse 100% of document review — and we would not notice,
//     because the only active reviewer is an L8 SuperAdmin who bypasses
//     permission checks before any gate is consulted.
//
//   flag ON — the future behaviour, proven now so switching it on later is a
//     decision rather than an experiment.
//
// Real database: the per-role assignment validation reads UserPermission
// grants and the gate reads assignedScreeningOfficerId off a persisted
// application, so the interesting failures are all "what does the query
// actually match" — exactly what an in-memory fake cannot answer.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../services/visaBillingSync.js", () => ({
  syncVisaApplicationBilling: vi.fn().mockResolvedValue({ action: "noop" }),
  createVisaWorkStartBooking: vi.fn().mockResolvedValue({ action: "noop" }),
}));

// requirePermission and the screening check both read UserPermission for
// REAL — this file's whole point is that those grants decide things — so the
// model is NOT mocked. Only the CALLER's own visaApplication gate is stubbed,
// so each test controls who is acting without seeding a permission row for
// the actor on every case.
let callerAccess: string | null = "WRITE";
vi.mock("../middleware/requirePermission.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    requirePermission: (_module: string, _min: string) => (req: any, res: any, next: any) => {
      if (!callerAccess || callerAccess === "NONE") {
        return res.status(403).json({ error: "Access not granted" });
      }
      next();
    },
  };
});

import router from "./admin.visa.js";
import VisaApplication from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaDocument from "../models/VisaDocument.js";
import TravellerProfile from "../models/TravellerProfile.js";
import User from "../models/User.js";
import { UserPermission } from "../models/UserPermission.js";
import VisaActivityLog from "../models/VisaActivityLog.js";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let actor: { _id: mongoose.Types.ObjectId; roles: string[] };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(actor._id), roles: actor.roles, email: "ops@plumtrips.com" };
    next();
  });
  app.use("/", router);
  return app;
}

async function makeUser(opts: { roles?: string[]; visaApplication?: string; visaScreening?: string } = {}) {
  const u = await User.create({
    name: "Ops User",
    email: `ops-${new mongoose.Types.ObjectId()}@plumtrips.com`,
    passwordHash: "x",
    workspaceId: new mongoose.Types.ObjectId(),
    roles: opts.roles ?? ["ADMIN"],
  });
  if (opts.visaApplication || opts.visaScreening) {
    await UserPermission.create({
      userId: String(u._id),
      email: u.email,
      workspaceId: "ws",
      universe: "STAFF",
      source: "manual",
      status: "active",
      grantedBy: new mongoose.Types.ObjectId(),
      level: { code: "L6", name: "Admin", designation: "Admin" },
      modules: {
        visaApplication: { access: opts.visaApplication ?? "NONE", scope: "ALL" },
        visaScreening: { access: opts.visaScreening ?? "NONE", scope: "ALL" },
      },
    } as any);
  }
  return u;
}

async function seedCase(opts: { assignedScreeningOfficerId?: mongoose.Types.ObjectId | null; status?: string } = {}) {
  const workspaceId = new mongoose.Types.ObjectId();
  const traveller = await TravellerProfile.create({
    workspaceId,
    travelerId: `T-${new mongoose.Types.ObjectId()}`,
    firstName: "A",
    lastName: "B",
    createdBy: new mongoose.Types.ObjectId(),
    source: "MANUAL",
  });
  const req = await VisaRequest.create({
    workspaceId,
    raisedByUserId: new mongoose.Types.ObjectId(),
    destinationIso2: "FR",
    purpose: "BUSINESS",
    applicationIds: [],
  });
  const application = await VisaApplication.create({
    workspaceId,
    requestId: req._id,
    travellerProfileId: traveller._id,
    ruleSnapshot: {
      ruleId: new mongoose.Types.ObjectId(),
      capturedAt: new Date(),
      destinationName: "France",
      isSchengen: true,
      productClass: "VISA",
      visaCategory: "STICKER",
      purpose: "BUSINESS",
      entryType: "SINGLE",
      serviceTier: "STANDARD",
      appointmentRequired: false,
      biometricsRequired: false,
      documentRequirements: [],
    },
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 1000 },
    status: opts.status ?? "docs_under_review",
    assignedScreeningOfficerId: opts.assignedScreeningOfficerId ?? null,
  });
  const document = await VisaDocument.create({
    workspaceId,
    applicationId: application._id,
    docCode: "DOC-02",
    originalFilename: "photo.jpg",
    s3Key: "k",
    mimeType: "image/jpeg",
    sizeBytes: 10,
    uploadedByUserId: new mongoose.Types.ObjectId(),
    deletedAt: null,
  } as any);
  return { application, document };
}

const reviewBody = { reviewStatus: "VERIFIED" };

function clearTierEnv() {
  delete process.env.VISA_SCREENING_ENFORCEMENT;
  delete process.env.VISA_SCREENING_ENFORCED;
}

beforeEach(async () => {
  callerAccess = "WRITE";
  clearTierEnv();
  await Promise.all([
    VisaApplication.deleteMany({}),
    VisaRequest.deleteMany({}),
    VisaDocument.deleteMany({}),
    TravellerProfile.deleteMany({}),
    User.deleteMany({}),
    UserPermission.deleteMany({}),
    VisaActivityLog.deleteMany({}),
  ]);
  const u = await makeUser({ visaApplication: "WRITE" });
  actor = { _id: u._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
});

afterEach(() => {
  clearTierEnv();
});

/* ═══════════════════════════════════════════════════════════════════════
 * FLAG OFF — today's behaviour, unchanged. The critical half.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("flag OFF (default) — zero regression", () => {
  it("a reviewer with NO visaScreening grant and NO assignment can still review a document", async () => {
    const { document } = await seedCase({ assignedScreeningOfficerId: null });
    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(200);
    const fresh: any = await VisaDocument.findById(document._id).lean();
    expect(fresh.reviewStatus).toBe("VERIFIED");
  });

  it("...and can flag a discrepancy", async () => {
    const { application } = await seedCase({ assignedScreeningOfficerId: null });
    const res = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "photo is wrong" });
    expect(res.status).toBe(200);
    expect((await VisaApplication.findById(application._id).lean() as any).status).toBe("discrepancy_flagged");
  });

  it("...and can clear one", async () => {
    const { application } = await seedCase({ assignedScreeningOfficerId: null });
    await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "photo is wrong" });
    const res = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "docs_under_review" });
    expect(res.status).toBe(200);
    expect((await VisaApplication.findById(application._id).lean() as any).status).toBe("docs_under_review");
  });

  it("a case ASSIGNED TO SOMEONE ELSE is still reviewable — assignment carries no authority while dormant", async () => {
    const someoneElse = await makeUser({ visaScreening: "WRITE" });
    const { document } = await seedCase({ assignedScreeningOfficerId: someoneElse._id as mongoose.Types.ObjectId });
    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(200);
  });

  it("an explicitly false flag is off, and so is any non-'true' value", async () => {
    const { document } = await seedCase();
    process.env.VISA_SCREENING_ENFORCED = "false";
    expect((await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody)).status).toBe(200);
    process.env.VISA_SCREENING_ENFORCED = "1";
    expect((await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody)).status).toBe(200);
  });

  it("tier 'off' is explicitly off", async () => {
    const { document } = await seedCase({ assignedScreeningOfficerId: null });
    process.env.VISA_SCREENING_ENFORCEMENT = "off";
    expect((await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody)).status).toBe(200);
  });

  it("an UNRECOGNISED tier falls back to off rather than half-enforcing", async () => {
    // A typo must not become an outage — but it also must not silently look
    // like enforcement. Behaviour is off; the warning is the loud part.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { document } = await seedCase({ assignedScreeningOfficerId: null });
    process.env.VISA_SCREENING_ENFORCEMENT = "capabilty"; // deliberate typo
    expect((await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody)).status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * TIER "capability" — the point of the split.
 *
 * The capability is required; per-case assignment is NOT. This is what
 * makes the audit's Step 2 shippable without Step 3: it changes WHO may
 * screen (fixable with a grant) without changing HOW OPS WORKS (every case
 * needing an assignment before anyone can touch it).
 *
 * Every allow-case here runs as a NON-SuperAdmin on purpose. The L8
 * break-glass clears both halves of the gate at every tier, so an L8 test
 * would pass no matter how the tier behaved and would prove nothing.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("tier 'capability' — capability required, assignment NOT", () => {
  beforeEach(() => {
    process.env.VISA_SCREENING_ENFORCEMENT = "capability";
  });

  it("REFUSES a non-SuperAdmin with no visaScreening capability", async () => {
    const { document } = await seedCase({ assignedScreeningOfficerId: actor?._id });
    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("NOT_A_SCREENER");
    expect((await VisaDocument.findById(document._id).lean() as any).reviewStatus).not.toBe("VERIFIED");
  });

  it("ALLOWS a capability-holder on an UNASSIGNED case", async () => {
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { document } = await seedCase({ assignedScreeningOfficerId: null });

    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(200);
    expect((await VisaDocument.findById(document._id).lean() as any).reviewStatus).toBe("VERIFIED");
  });

  it("ALLOWS a capability-holder on a case assigned to a DIFFERENT screener", async () => {
    // The same setup returns 403 NOT_ASSIGNED at tier 'assignment' — this is
    // the single assertion that proves the two checks are now independent.
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    const other = await makeUser({ visaScreening: "WRITE" });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { document } = await seedCase({ assignedScreeningOfficerId: other._id as mongoose.Types.ObjectId });

    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(200);
  });

  it("never returns NOT_ASSIGNED at this tier — assignment is not consulted at all", async () => {
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    const other = await makeUser({ visaScreening: "WRITE" });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { application } = await seedCase({ assignedScreeningOfficerId: other._id as mongoose.Types.ObjectId });

    const res = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "photo" });
    expect(res.status).toBe(200);
    expect(res.body.reason).toBeUndefined();
  });

  it("gates clearing a discrepancy on the capability, not on assignment", async () => {
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { application } = await seedCase({ assignedScreeningOfficerId: null });
    await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "photo" });

    // A concierge with no screening capability still cannot resolve it.
    const concierge = await makeUser({ visaApplication: "WRITE" });
    actor = { _id: concierge._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const refused = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "docs_under_review" });
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe("NOT_A_SCREENER");

    // Any screener may, assigned or not.
    const otherScreener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    actor = { _id: otherScreener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const allowed = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "docs_under_review" });
    expect(allowed.status).toBe(200);
  });

  it("still does NOT gate the shared acts — action_required stays open to a concierge", async () => {
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { application } = await seedCase({ assignedScreeningOfficerId: null });
    await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "photo" });

    const concierge = await makeUser({ visaApplication: "WRITE" });
    actor = { _id: concierge._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const res = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "action_required", reason: "Please resend the photograph" });
    expect(res.status).toBe(200);
  });

  it("ALLOWS a SUPERADMIN who holds no grant — break-glass survives at this tier", async () => {
    const su = await makeUser({ roles: ["SUPERADMIN"] });
    actor = { _id: su._id as mongoose.Types.ObjectId, roles: ["SUPERADMIN"] };
    const { document } = await seedCase({ assignedScreeningOfficerId: null });
    expect((await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody)).status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * TIER "assignment" — the strictest tier, and step 1's wired behaviour.
 * Everything the single flag used to do lives here, unchanged.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("tier 'assignment' — capability AND assigned-on-this-case", () => {
  beforeEach(() => {
    process.env.VISA_SCREENING_ENFORCEMENT = "assignment";
  });

  it("REFUSES a reviewer with no visaScreening capability", async () => {
    const { document } = await seedCase({ assignedScreeningOfficerId: actor?._id });
    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("NOT_A_SCREENER");
    expect((await VisaDocument.findById(document._id).lean() as any).reviewStatus).not.toBe("VERIFIED");
  });

  // NOTE: "unassigned" used to be refused here. Ruling 1 (2026-08-12) made it
  // an auto-claim instead — see the dedicated describe below.

  it("REFUSES a screener when the case belongs to a DIFFERENT screener", async () => {
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    const other = await makeUser({ visaScreening: "WRITE" });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { document } = await seedCase({ assignedScreeningOfficerId: other._id as mongoose.Types.ObjectId });

    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("NOT_ASSIGNED");
  });

  it("ALLOWS the assigned screening officer", async () => {
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { document } = await seedCase({ assignedScreeningOfficerId: screener._id as mongoose.Types.ObjectId });

    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(200);
    expect((await VisaDocument.findById(document._id).lean() as any).reviewStatus).toBe("VERIFIED");
  });

  it("ALLOWS a SUPERADMIN — the break-glass account is not locked out by its own gate", async () => {
    const su = await makeUser({ roles: ["SUPERADMIN"] });
    actor = { _id: su._id as mongoose.Types.ObjectId, roles: ["SUPERADMIN"] };
    const { application, document } = await seedCase({ assignedScreeningOfficerId: null });

    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(200);

    // And break-glass does NOT auto-claim. An emergency action must not
    // quietly make the SuperAdmin the accountable officer on a case they
    // were only unblocking.
    const fresh: any = await VisaApplication.findById(application._id).lean();
    expect(fresh.assignedScreeningOfficerId).toBeNull();
  });

  it("gates flagging a discrepancy, and allows the assigned screener", async () => {
    const { application } = await seedCase({ assignedScreeningOfficerId: null });
    const refused = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "x" });
    expect(refused.status).toBe(403);
    expect((await VisaApplication.findById(application._id).lean() as any).status).toBe("docs_under_review");

    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    await VisaApplication.updateOne({ _id: application._id }, { $set: { assignedScreeningOfficerId: screener._id } });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };

    const allowed = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "x" });
    expect(allowed.status).toBe(200);
  });

  it("gates CLEARING a discrepancy — a concierge cannot declare someone else's finding resolved", async () => {
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    const { application } = await seedCase({ assignedScreeningOfficerId: screener._id as mongoose.Types.ObjectId });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "x" });

    // Concierge (visaApplication only) tries to resolve it.
    const concierge = await makeUser({ visaApplication: "WRITE" });
    actor = { _id: concierge._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const res = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "docs_under_review" });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("NOT_A_SCREENER");
    expect((await VisaApplication.findById(application._id).lean() as any).status).toBe("discrepancy_flagged");
  });

  it("does NOT gate escalating to action_required — publishing a customer ask stays shared", async () => {
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    const { application } = await seedCase({ assignedScreeningOfficerId: screener._id as mongoose.Types.ObjectId });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "photo" });

    // A concierge with NO screening capability escalates it to the customer.
    const concierge = await makeUser({ visaApplication: "WRITE" });
    actor = { _id: concierge._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const res = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "action_required", reason: "Please resend the photograph" });

    expect(res.status).toBe(200);
    expect((await VisaApplication.findById(application._id).lean() as any).status).toBe("action_required");
  });

  it("does NOT gate the forward chain — case progression is not a screening judgement", async () => {
    const { application } = await seedCase({ status: "submitted", assignedScreeningOfficerId: null });
    const res = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "docs_under_review" });
    expect(res.status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * RULING 1 — AUTO-CLAIM ON UNASSIGNED (tier "assignment" only).
 *
 * A screener acting on a case nobody owns takes it, rather than being
 * refused into a dead end that only a coordinator could open. Every test
 * here runs as a NON-SuperAdmin: the break-glass clears the assignment
 * check outright, so an L8 would never reach the claim and would prove
 * nothing about it.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("tier 'assignment' — auto-claim on an unassigned case", () => {
  beforeEach(() => {
    process.env.VISA_SCREENING_ENFORCEMENT = "assignment";
  });

  async function screenerActor() {
    const u = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    actor = { _id: u._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    return u;
  }

  it("ALLOWS the act, and makes the actor the assigned screening officer", async () => {
    const screener = await screenerActor();
    const { application, document } = await seedCase({ assignedScreeningOfficerId: null });

    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(200);
    expect((await VisaDocument.findById(document._id).lean() as any).reviewStatus).toBe("VERIFIED");

    const fresh: any = await VisaApplication.findById(application._id).lean();
    expect(String(fresh.assignedScreeningOfficerId)).toBe(String(screener._id));
  });

  it("LOGS the claim as its own event, naming who and how", async () => {
    const screener = await screenerActor();
    const { application, document } = await seedCase({ assignedScreeningOfficerId: null });
    await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);

    const rows: any[] = await VisaActivityLog.find({
      applicationId: application._id,
      eventType: "SCREENING_OFFICER_AUTO_CLAIMED",
    }).lean();

    expect(rows).toHaveLength(1);
    expect(String(rows[0].actorUserId)).toBe(String(screener._id));
    expect(rows[0].detail).toMatchObject({ act: "DOCUMENT_REVIEW", autoClaimed: true });
    expect(rows[0].at).toBeInstanceOf(Date);
    // Distinct from a coordinator assigning someone — that is the point of
    // giving it its own event type.
    expect(
      await VisaActivityLog.countDocuments({
        applicationId: application._id,
        eventType: "SCREENING_OFFICER_ASSIGNED",
      }),
    ).toBe(0);
  });

  it("auto-claims on flagging a discrepancy too, not just document review", async () => {
    const screener = await screenerActor();
    const { application } = await seedCase({ assignedScreeningOfficerId: null });

    const res = await request(makeApp())
      .patch(`/applications/${application._id}/status`)
      .send({ status: "discrepancy_flagged", reason: "photo is wrong" });
    expect(res.status).toBe(200);

    const fresh: any = await VisaApplication.findById(application._id).lean();
    expect(String(fresh.assignedScreeningOfficerId)).toBe(String(screener._id));
    const rows = await VisaActivityLog.find({ eventType: "SCREENING_OFFICER_AUTO_CLAIMED" }).lean();
    expect((rows[0] as any).detail.act).toBe("DISCREPANCY_SET");
  });

  it("claims ONCE — a second act by the same officer does not re-log", async () => {
    await screenerActor();
    const { application, document } = await seedCase({ assignedScreeningOfficerId: null });

    await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    await request(makeApp()).patch(`/documents/${document._id}/review`).send({ reviewStatus: "REJECTED", rejectionReason: "blurred" });

    expect(
      await VisaActivityLog.countDocuments({
        applicationId: application._id,
        eventType: "SCREENING_OFFICER_AUTO_CLAIMED",
      }),
    ).toBe(1);
  });

  it("does NOT satisfy the capability half — a non-screener cannot claim their way in", async () => {
    // The actor holds visaApplication WRITE but NOT visaScreening. Auto-claim
    // answers "is this case yours"; it must never answer "are you a screener".
    const { application, document } = await seedCase({ assignedScreeningOfficerId: null });

    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("NOT_A_SCREENER");

    const fresh: any = await VisaApplication.findById(application._id).lean();
    expect(fresh.assignedScreeningOfficerId).toBeNull();
    expect(await VisaActivityLog.countDocuments({ eventType: "SCREENING_OFFICER_AUTO_CLAIMED" })).toBe(0);
  });

  it("never claims a case that already belongs to someone else", async () => {
    const other = await makeUser({ visaScreening: "WRITE" });
    await screenerActor();
    const { application, document } = await seedCase({
      assignedScreeningOfficerId: other._id as mongoose.Types.ObjectId,
    });

    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("NOT_ASSIGNED");

    const fresh: any = await VisaApplication.findById(application._id).lean();
    expect(String(fresh.assignedScreeningOfficerId)).toBe(String(other._id));
  });

  it("only ONE of two racing screeners wins the case", async () => {
    // Two people working the same queue is the ordinary case, not an exotic
    // one — a read-then-write claim would let the second silently overwrite
    // the first and leave the trail naming the wrong officer.
    const a = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    const b = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    const { application, document } = await seedCase({ assignedScreeningOfficerId: null });

    actor = { _id: a._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const appA = makeApp();
    await request(appA).patch(`/documents/${document._id}/review`).send(reviewBody);

    actor = { _id: b._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const second = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);

    // B arrives after A owns it and is refused exactly as if it had been
    // assigned all along.
    expect(second.status).toBe(403);
    expect(second.body.reason).toBe("NOT_ASSIGNED");

    const fresh: any = await VisaApplication.findById(application._id).lean();
    expect(String(fresh.assignedScreeningOfficerId)).toBe(String(a._id));
    expect(await VisaActivityLog.countDocuments({ eventType: "SCREENING_OFFICER_AUTO_CLAIMED" })).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * AUTO-CLAIM IS TIER-SPECIFIC — it must not leak into the lower tiers.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("auto-claim does not apply below tier 'assignment'", () => {
  it("tier OFF leaves an unassigned case unassigned", async () => {
    const { application, document } = await seedCase({ assignedScreeningOfficerId: null });
    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);

    expect(res.status).toBe(200);
    expect((await VisaApplication.findById(application._id).lean() as any).assignedScreeningOfficerId).toBeNull();
    expect(await VisaActivityLog.countDocuments({ eventType: "SCREENING_OFFICER_AUTO_CLAIMED" })).toBe(0);
  });

  it("tier CAPABILITY leaves an unassigned case unassigned", async () => {
    process.env.VISA_SCREENING_ENFORCEMENT = "capability";
    const u = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    actor = { _id: u._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { application, document } = await seedCase({ assignedScreeningOfficerId: null });

    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(200);
    // Assignment is not consulted at this tier, so it must not be WRITTEN
    // either — the tier's promise is that ops keeps working unassigned.
    expect((await VisaApplication.findById(application._id).lean() as any).assignedScreeningOfficerId).toBeNull();
    expect(await VisaActivityLog.countDocuments({ eventType: "SCREENING_OFFICER_AUTO_CLAIMED" })).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * LEGACY BOOLEAN — an environment still carrying step 1's flag must keep
 * its exact former meaning, not quietly change behaviour on deploy.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("legacy VISA_SCREENING_ENFORCED", () => {
  // Probed with a case owned by ANOTHER screener, not an unassigned one.
  // Since Ruling 1 an unassigned case is auto-claimed at the assignment tier,
  // so it no longer separates the two tiers — "belongs to someone else" is
  // the difference that remains: refused at assignment, allowed at
  // capability.
  it("'true' still means the assignment tier — capability alone is not enough", async () => {
    const other = await makeUser({ visaScreening: "WRITE" });
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { document } = await seedCase({ assignedScreeningOfficerId: other._id as mongoose.Types.ObjectId });

    process.env.VISA_SCREENING_ENFORCED = "true";
    const res = await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("NOT_ASSIGNED");
  });

  it("is IGNORED once the tier is set explicitly — the new variable wins", async () => {
    const other = await makeUser({ visaScreening: "WRITE" });
    const screener = await makeUser({ visaApplication: "WRITE", visaScreening: "WRITE" });
    actor = { _id: screener._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const { document } = await seedCase({ assignedScreeningOfficerId: other._id as mongoose.Types.ObjectId });

    process.env.VISA_SCREENING_ENFORCED = "true";
    process.env.VISA_SCREENING_ENFORCEMENT = "capability";
    expect((await request(makeApp()).patch(`/documents/${document._id}/review`).send(reviewBody)).status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * ASSIGNABLE LISTS + per-role validation (NOT tier-gated)
 * ═══════════════════════════════════════════════════════════════════════ */

describe("GET /assignable-users — split by capability", () => {
  it("returns two lists, and screening is empty while nobody holds the capability", async () => {
    await makeUser({ visaApplication: "WRITE" });
    await makeUser({ visaApplication: "FULL" });

    const res = await request(makeApp()).get("/assignable-users");
    expect(res.status).toBe(200);
    expect(res.body.concierge.length).toBeGreaterThanOrEqual(2);
    // Honest, not broken: nobody has been made a screener yet.
    expect(res.body.screening).toEqual([]);
  });

  it("a visaScreening grant puts a user in the screening list only", async () => {
    const screenerOnly = await makeUser({ visaScreening: "WRITE" });
    const res = await request(makeApp()).get("/assignable-users");

    const screeningIds = res.body.screening.map((u: any) => u.id);
    const conciergeIds = res.body.concierge.map((u: any) => u.id);
    expect(screeningIds).toContain(String(screenerOnly._id));
    expect(conciergeIds).not.toContain(String(screenerOnly._id));
  });

  it("a SUPERADMIN appears in both pools", async () => {
    const su = await makeUser({ roles: ["SUPERADMIN"] });
    const res = await request(makeApp()).get("/assignable-users");
    expect(res.body.concierge.map((u: any) => u.id)).toContain(String(su._id));
    expect(res.body.screening.map((u: any) => u.id)).toContain(String(su._id));
  });

  it("keeps `users` populated with the concierge pool for the current console", async () => {
    await makeUser({ visaApplication: "WRITE" });
    const res = await request(makeApp()).get("/assignable-users");
    expect(res.body.users).toEqual(res.body.concierge);
  });
});

describe("assignment validates PER ROLE — the two slots stop being interchangeable", () => {
  it("REFUSES assigning a concierge-only user to the SCREENING slot", async () => {
    const conciergeOnly = await makeUser({ visaApplication: "WRITE" });
    const { application } = await seedCase();

    const res = await request(makeApp())
      .patch(`/applications/${application._id}/assignment`)
      .send({ assignedScreeningOfficerId: String(conciergeOnly._id) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/visaScreening/);
    expect((await VisaApplication.findById(application._id).lean() as any).assignedScreeningOfficerId).toBeNull();
  });

  it("REFUSES assigning a screening-only user to the CONCIERGE slot", async () => {
    const screenerOnly = await makeUser({ visaScreening: "WRITE" });
    const { application } = await seedCase();

    const res = await request(makeApp())
      .patch(`/applications/${application._id}/assignment`)
      .send({ assignedConciergeUserId: String(screenerOnly._id) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/visaApplication/);
  });

  it("ALLOWS each user into the slot their capability matches", async () => {
    const concierge = await makeUser({ visaApplication: "WRITE" });
    const screener = await makeUser({ visaScreening: "WRITE" });
    const { application } = await seedCase();

    const res = await request(makeApp())
      .patch(`/applications/${application._id}/assignment`)
      .send({
        assignedConciergeUserId: String(concierge._id),
        assignedScreeningOfficerId: String(screener._id),
      });

    expect(res.status).toBe(200);
    const fresh: any = await VisaApplication.findById(application._id).lean();
    expect(String(fresh.assignedConciergeUserId)).toBe(String(concierge._id));
    expect(String(fresh.assignedScreeningOfficerId)).toBe(String(screener._id));
  });

  it("a half-bad pair assigns NEITHER role", async () => {
    const concierge = await makeUser({ visaApplication: "WRITE" });
    const notAScreener = await makeUser({ visaApplication: "WRITE" });
    const { application } = await seedCase();

    const res = await request(makeApp())
      .patch(`/applications/${application._id}/assignment`)
      .send({
        assignedConciergeUserId: String(concierge._id),
        assignedScreeningOfficerId: String(notAScreener._id),
      });

    expect(res.status).toBe(400);
    const fresh: any = await VisaApplication.findById(application._id).lean();
    expect(fresh.assignedConciergeUserId).toBeNull();
    expect(fresh.assignedScreeningOfficerId).toBeNull();
  });

  it("clearing a role never needs a capability", async () => {
    const screener = await makeUser({ visaScreening: "WRITE" });
    const { application } = await seedCase({ assignedScreeningOfficerId: screener._id as mongoose.Types.ObjectId });

    const res = await request(makeApp())
      .patch(`/applications/${application._id}/assignment`)
      .send({ assignedScreeningOfficerId: null });

    expect(res.status).toBe(200);
    expect((await VisaApplication.findById(application._id).lean() as any).assignedScreeningOfficerId).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The capability key itself
 * ═══════════════════════════════════════════════════════════════════════ */

describe("visaScreening is a grantable capability, granted to nobody by default", () => {
  it("defaults to NONE on a permission record that never mentions it", async () => {
    const u = await User.create({ name: "X", email: `x-${new mongoose.Types.ObjectId()}@p.com`, passwordHash: "x", workspaceId: new mongoose.Types.ObjectId(), roles: ["ADMIN"] });
    await UserPermission.create({
      userId: String(u._id),
      email: u.email,
      workspaceId: "ws",
      universe: "STAFF",
      source: "manual",
      status: "active",
      grantedBy: new mongoose.Types.ObjectId(),
      level: { code: "L6", name: "Admin", designation: "Admin" },
      modules: { visaApplication: { access: "FULL", scope: "ALL" } },
    } as any);

    const perm: any = await UserPermission.findOne({ userId: String(u._id) }).lean();
    expect(perm.modules.visaScreening.access).toBe("NONE");
  });

  it("no level template grants it — the product decision is still open", async () => {
    const { LEVEL_TEMPLATES } = await import("../config/levelTemplates.js");
    for (const [code, template] of Object.entries(LEVEL_TEMPLATES as Record<string, any>)) {
      expect(
        template.visaScreening?.access,
        `level ${code} unexpectedly grants visaScreening`,
      ).toBe("NONE");
    }
  });
});
