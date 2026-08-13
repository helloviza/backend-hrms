// Unit coverage for scripts/lib/visaErasureCascade.ts — the shared cascade
// logic behind scripts/erase-visa-request.ts and
// scripts/erase-traveller-profile.ts. Every real Model's static methods are
// spied (same convention as VisaApplication.test.ts/VisaActivityLog.test.ts)
// — no DB connection needed, and this proves the cascade calls through to
// the real schema/model rather than a stand-in.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";

vi.mock("../../utils/s3Upload.js", () => ({
  deleteObject: vi.fn(),
}));

import VisaApplication from "../../models/VisaApplication.js";
import VisaDocument from "../../models/VisaDocument.js";
import ManualBooking from "../../models/ManualBooking.js";
import User from "../../models/User.js";
import CstepTravelRequest from "../../models/cstep/CstepTravelRequest.js";
import CstepClaim from "../../models/cstep/CstepClaim.js";
import { deleteObject } from "../../utils/s3Upload.js";
import {
  resolveSuperAdminActor,
  ActorNotSuperAdminError,
  findApplicationIdsForRequest,
  findApplicationIdsForTraveller,
  planDocuments,
  deleteDocumentsAndS3,
  planManualBookings,
  redactManualBookings,
  scrubApplicationsAfterTravellerErasure,
  planCstepImpact,
  assertCstepImpactAcknowledged,
  assertNoDanglingVisaDocuments,
} from "./visaErasureCascade.js";

function leanChain(value: any) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

describe("resolveSuperAdminActor", () => {
  const email = "ops@plumtrips.com";

  it("resolves a real SUPERADMIN user", async () => {
    vi.spyOn(User, "findOne").mockImplementation(
      () => leanChain({ _id: new mongoose.Types.ObjectId(), email, roles: ["SUPERADMIN"] }) as any,
    );
    const actor = await resolveSuperAdminActor(email);
    expect(actor.email).toBe(email);
  });

  it("rejects when no user exists with that email", async () => {
    vi.spyOn(User, "findOne").mockImplementation(() => leanChain(null) as any);
    await expect(resolveSuperAdminActor("nobody@plumtrips.com")).rejects.toThrow(ActorNotSuperAdminError);
  });

  it("rejects a real user who is not SUPERADMIN", async () => {
    vi.spyOn(User, "findOne").mockImplementation(
      () => leanChain({ _id: new mongoose.Types.ObjectId(), email, roles: ["ADMIN"] }) as any,
    );
    await expect(resolveSuperAdminActor(email)).rejects.toThrow(/not SUPERADMIN/);
  });

  it("rejects an empty actor email without querying", async () => {
    const spy = vi.spyOn(User, "findOne");
    await expect(resolveSuperAdminActor("")).rejects.toThrow(ActorNotSuperAdminError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("findApplicationIdsForRequest / findApplicationIdsForTraveller", () => {
  it("returns application ids scoped by requestId", async () => {
    const ids = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    const findSpy = vi.spyOn(VisaApplication, "find").mockImplementation(
      () => leanChain(ids.map((_id) => ({ _id }))) as any,
    );
    const requestId = new mongoose.Types.ObjectId();
    const result = await findApplicationIdsForRequest(requestId);
    expect(result).toEqual(ids.map(String));
    expect(findSpy).toHaveBeenCalledWith({ requestId });
  });

  it("returns application ids scoped by travellerProfileId", async () => {
    const ids = [new mongoose.Types.ObjectId()];
    const findSpy = vi.spyOn(VisaApplication, "find").mockImplementation(
      () => leanChain(ids.map((_id) => ({ _id }))) as any,
    );
    const travellerId = new mongoose.Types.ObjectId();
    const result = await findApplicationIdsForTraveller(travellerId);
    expect(result).toEqual(ids.map(String));
    expect(findSpy).toHaveBeenCalledWith({ travellerProfileId: travellerId });
  });
});

describe("planDocuments / deleteDocumentsAndS3 — cascade leaves nothing orphaned", () => {
  const appIds = ["app1", "app2"];
  const docs = [
    { _id: new mongoose.Types.ObjectId(), s3Key: "visa-applications/ws/app1/passport.png" },
    { _id: new mongoose.Types.ObjectId(), s3Key: "visa-applications/ws/app2/bank-statement.pdf" },
  ];

  beforeEach(() => {
    vi.mocked(deleteObject).mockReset().mockResolvedValue(undefined);
  });

  it("planDocuments never deletes anything — pure read", async () => {
    const findSpy = vi.spyOn(VisaDocument, "find").mockImplementation(() => leanChain(docs) as any);
    const deleteSpy = vi.spyOn(VisaDocument, "deleteMany");
    const plan = await planDocuments(appIds);
    expect(plan.documentIds).toEqual(docs.map((d) => String(d._id)));
    expect(plan.s3Keys).toEqual(docs.map((d) => d.s3Key));
    expect(findSpy).toHaveBeenCalledWith({ applicationId: { $in: appIds } });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("deletes every S3 object BEFORE deleting the VisaDocument rows", async () => {
    vi.spyOn(VisaDocument, "find").mockImplementation(() => leanChain(docs) as any);
    const deleteManySpy = vi.spyOn(VisaDocument, "deleteMany").mockResolvedValue({ deletedCount: 2 } as any);

    const callOrder: string[] = [];
    vi.mocked(deleteObject).mockImplementation(async () => {
      callOrder.push("s3");
    });
    deleteManySpy.mockImplementation((async () => {
      callOrder.push("mongo");
      return { deletedCount: 2 };
    }) as any);

    const result = await deleteDocumentsAndS3(appIds);

    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledWith(docs[0].s3Key);
    expect(deleteObject).toHaveBeenCalledWith(docs[1].s3Key);
    expect(deleteManySpy).toHaveBeenCalledWith({ _id: { $in: docs.map((d) => String(d._id)) } });
    expect(result.documentsDeleted).toBe(2);
    expect(result.s3KeysDeleted).toEqual(docs.map((d) => d.s3Key));
    expect(callOrder).toEqual(["s3", "s3", "mongo"]);
  });

  it("aborts BEFORE touching Mongo if any S3 delete fails — never leaves a row gone with its image still in S3, nor the reverse", async () => {
    vi.spyOn(VisaDocument, "find").mockImplementation(() => leanChain(docs) as any);
    const deleteManySpy = vi.spyOn(VisaDocument, "deleteMany").mockResolvedValue({ deletedCount: 2 } as any);
    vi.mocked(deleteObject)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("access denied"));

    await expect(deleteDocumentsAndS3(appIds)).rejects.toThrow(/S3 object\(s\) failed to delete/);
    expect(deleteManySpy).not.toHaveBeenCalled();
  });

  it("no-ops cleanly when there are no applications/documents", async () => {
    const findSpy = vi.spyOn(VisaDocument, "find");
    const result = await deleteDocumentsAndS3([]);
    expect(result).toEqual({ documentsDeleted: 0, s3KeysDeleted: [] });
    expect(findSpy).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });
});

describe("planManualBookings / redactManualBookings", () => {
  function fakeBooking(overrides: Record<string, any> = {}) {
    const passengers = [
      { toObject: () => ({ name: "Ananya Sharma", email: "a@x.com", phone: "999", passportNo: "TESTPP001", panNo: "PAN123", type: "ADULT" }) },
    ];
    return {
      _id: new mongoose.Types.ObjectId(),
      bookingRef: "MB-2607-0001",
      passengers,
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("planManualBookings is read-only and reports the passenger name for the plan output", async () => {
    const booking = fakeBooking();
    const findSpy = vi.spyOn(ManualBooking, "find").mockImplementation(
      () => leanChain([{ _id: booking._id, bookingRef: booking.bookingRef, passengers: [{ name: "Ananya Sharma" }] }]) as any,
    );
    const plan = await planManualBookings(["app1"]);
    expect(plan).toEqual([{ manualBookingId: String(booking._id), bookingRef: "MB-2607-0001", passengerName: "Ananya Sharma" }]);
    expect(findSpy).toHaveBeenCalledWith({ "metadata.visaApplicationId": { $in: ["app1"] } });
  });

  it("strips passportNo/email/phone but keeps name, panNo, and type", async () => {
    const booking: any = fakeBooking();
    vi.spyOn(ManualBooking, "find").mockReturnValue({
      select: () => Promise.resolve([booking]),
    } as any);

    const redactedCount = await redactManualBookings(["app1"]);

    expect(redactedCount).toBe(1);
    expect(booking.save).toHaveBeenCalledTimes(1);
    expect(booking.passengers[0]).toMatchObject({ name: "Ananya Sharma", panNo: "PAN123", type: "ADULT" });
    expect(booking.passengers[0].passportNo).toBeUndefined();
    expect(booking.passengers[0].email).toBeUndefined();
    expect(booking.passengers[0].phone).toBeUndefined();
    expect(booking.piiRedactedAt).toBeInstanceOf(Date);
  });

  it("only queries bookings not already redacted — idempotent re-runs", async () => {
    const findSpy = vi.spyOn(ManualBooking, "find").mockReturnValue({
      select: () => Promise.resolve([]),
    } as any);
    await redactManualBookings(["app1"]);
    expect(findSpy).toHaveBeenCalledWith({
      "metadata.visaApplicationId": { $in: ["app1"] },
      piiRedactedAt: { $exists: false },
    });
  });

  it("no-ops cleanly with no application ids", async () => {
    const findSpy = vi.spyOn(ManualBooking, "find");
    expect(await redactManualBookings([])).toBe(0);
    expect(findSpy).not.toHaveBeenCalled();
  });
});

describe("scrubApplicationsAfterTravellerErasure", () => {
  it("nulls travellerProfileId + action_required fields, stamps travellerErasedAt, on the given applications only", async () => {
    const updateManySpy = vi.spyOn(VisaApplication, "updateMany").mockResolvedValue({ modifiedCount: 2 } as any);
    const appIds = ["app1", "app2"];

    const count = await scrubApplicationsAfterTravellerErasure(appIds);

    expect(updateManySpy).toHaveBeenCalledWith(
      { _id: { $in: appIds } },
      {
        $set: {
          travellerProfileId: null,
          travellerErasedAt: expect.any(Date),
          actionRequiredReason: null,
          actionRequiredSetAt: null,
          actionRequiredSetByUserId: null,
        },
      },
    );
    expect(count).toBe(2);
  });

  it("deliberately leaves status/statusBeforeActionRequired out of the $set", async () => {
    const updateManySpy = vi.spyOn(VisaApplication, "updateMany").mockResolvedValue({ modifiedCount: 1 } as any);
    await scrubApplicationsAfterTravellerErasure(["app1"]);
    const [, update] = updateManySpy.mock.calls[0];
    expect((update as any).$set).not.toHaveProperty("status");
    expect((update as any).$set).not.toHaveProperty("statusBeforeActionRequired");
  });

  it("no-ops cleanly with no application ids", async () => {
    const updateManySpy = vi.spyOn(VisaApplication, "updateMany");
    expect(await scrubApplicationsAfterTravellerErasure([])).toBe(0);
    expect(updateManySpy).not.toHaveBeenCalled();
  });
});

describe("planCstepImpact / assertCstepImpactAcknowledged — the CSTEP flag is required when history exists", () => {
  it("reports zero impact and never requires acknowledgement", async () => {
    const travellerCountSpy = vi.spyOn(CstepTravelRequest, "countDocuments").mockResolvedValue(0 as any);
    const claimCountSpy = vi.spyOn(CstepClaim, "countDocuments").mockResolvedValue(0 as any);
    const travellerId = new mongoose.Types.ObjectId();
    const impact = await planCstepImpact(travellerId);
    expect(impact).toEqual({ travelRequestCount: 0, claimCount: 0 });
    expect(() => assertCstepImpactAcknowledged(impact, false)).not.toThrow();
    // Regression guard for the exact spelling-hazard bug this file's header
    // warns about: CSTEP's field is travelerProfileId (one L) — assert the
    // query was actually keyed on the traveller id passed in, not on some
    // other-named variable a shorthand property silently picked up instead.
    expect(travellerCountSpy).toHaveBeenCalledWith({ travelerProfileId: travellerId });
    expect(claimCountSpy).toHaveBeenCalledWith({ travelerProfileId: travellerId });
  });

  it("throws when there IS history and it was not acknowledged", () => {
    expect(() => assertCstepImpactAcknowledged({ travelRequestCount: 2, claimCount: 1 }, false)).toThrow(
      /--acknowledge-cstep-impact/,
    );
  });

  it("proceeds when there is history AND it was acknowledged", () => {
    expect(() => assertCstepImpactAcknowledged({ travelRequestCount: 2, claimCount: 1 }, true)).not.toThrow();
  });
});

describe("assertNoDanglingVisaDocuments", () => {
  let exitSpy: any;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("passes silently when every VisaDocument.applicationId resolves to a real VisaApplication", async () => {
    const appId = new mongoose.Types.ObjectId();
    vi.spyOn(VisaDocument, "distinct").mockResolvedValue([appId] as any);
    vi.spyOn(VisaApplication, "distinct").mockResolvedValue([appId] as any);

    await expect(assertNoDanglingVisaDocuments()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits non-zero when a VisaDocument references an applicationId that no longer exists — the exact invariant that caught the real orphans", async () => {
    const danglingId = new mongoose.Types.ObjectId();
    vi.spyOn(VisaDocument, "distinct").mockResolvedValue([danglingId] as any);
    vi.spyOn(VisaApplication, "distinct").mockResolvedValue([] as any);

    await expect(assertNoDanglingVisaDocuments()).rejects.toThrow("process.exit(1)");
  });
});
