// Unit coverage for VisaErasureLog.ts — the append-only record of every
// visa-module erasure run. Same "spy on the real Model's .create" approach
// as VisaActivityLog.test.ts — no DB connection needed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import VisaErasureLog, { recordVisaErasure } from "./VisaErasureLog.js";

describe("recordVisaErasure — the erasure log is never touched by the erasure it records", () => {
  const targetId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const actorUserId = new mongoose.Types.ObjectId();

  let createSpy: any;

  beforeEach(() => {
    createSpy = vi.spyOn(VisaErasureLog, "create").mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }] as any);
  });

  it("writes exactly one row, with every field passed through", async () => {
    await recordVisaErasure({
      scope: "VISA_REQUEST",
      targetId,
      workspaceId,
      actorUserId,
      actorEmail: "ops@plumtrips.com",
      reason: "Customer DPDP erasure request #4821",
      counts: { visaRequestsDeleted: 1, visaApplicationsDeleted: 2, visaDocumentsDeleted: 5 },
      s3KeysDeleted: ["visa-applications/ws/app1/passport.png"],
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [[rows]] = createSpy.mock.calls;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.scope).toBe("VISA_REQUEST");
    expect(row.targetId).toBe(targetId);
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.actorUserId).toBe(actorUserId);
    expect(row.actorEmail).toBe("ops@plumtrips.com");
    expect(row.reason).toBe("Customer DPDP erasure request #4821");
    expect(row.counts).toEqual({ visaRequestsDeleted: 1, visaApplicationsDeleted: 2, visaDocumentsDeleted: 5 });
    expect(row.s3KeysDeleted).toEqual(["visa-applications/ws/app1/passport.png"]);
    expect(row.cstepImpact).toBeNull();
    expect(row.performedAt).toBeInstanceOf(Date);
  });

  it("defaults cstepImpact to null when omitted (VISA_REQUEST scope never sets it)", async () => {
    await recordVisaErasure({
      scope: "VISA_REQUEST",
      targetId,
      workspaceId,
      actorUserId,
      actorEmail: "ops@plumtrips.com",
      reason: "test",
      counts: {},
      s3KeysDeleted: [],
    });
    const row = createSpy.mock.calls[0][0][0];
    expect(row.cstepImpact).toBeNull();
  });

  it("carries cstepImpact through for TRAVELLER_PROFILE scope", async () => {
    await recordVisaErasure({
      scope: "TRAVELLER_PROFILE",
      targetId,
      workspaceId,
      actorUserId,
      actorEmail: "ops@plumtrips.com",
      reason: "test",
      counts: {},
      s3KeysDeleted: [],
      cstepImpact: { travelRequestCount: 2, claimCount: 1, acknowledged: true },
    });
    const row = createSpy.mock.calls[0][0][0];
    expect(row.cstepImpact).toEqual({ travelRequestCount: 2, claimCount: 1, acknowledged: true });
  });

  it("is append-only: two erasure runs create two independent rows, never an update to the first", async () => {
    await recordVisaErasure({
      scope: "VISA_REQUEST", targetId, workspaceId, actorUserId,
      actorEmail: "ops@plumtrips.com", reason: "first", counts: {}, s3KeysDeleted: [],
    });
    await recordVisaErasure({
      scope: "TRAVELLER_PROFILE", targetId: new mongoose.Types.ObjectId(), workspaceId, actorUserId,
      actorEmail: "ops@plumtrips.com", reason: "second", counts: {}, s3KeysDeleted: [],
    });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls[0][0][0].reason).toBe("first");
    expect(createSpy.mock.calls[1][0][0].reason).toBe("second");
  });

  it("propagates a write failure instead of swallowing it — unlike logVisaActivity, a missing erasure record must be visible", async () => {
    createSpy.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      recordVisaErasure({
        scope: "VISA_REQUEST", targetId, workspaceId, actorUserId,
        actorEmail: "ops@plumtrips.com", reason: "test", counts: {}, s3KeysDeleted: [],
      }),
    ).rejects.toThrow("connection reset");
  });
});
