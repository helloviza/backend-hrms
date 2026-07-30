// Unit coverage for VisaActivityLog.ts — the append-only activity trail
// (Phase 9c). VisaActivityLog itself is the REAL Model object with
// `.create` spied (same pattern as VisaRequest.test.ts's own
// recomputeRequestStatus coverage) — no DB connection needed to spy on a
// static method, and this proves logVisaActivity really calls through to
// the real schema/model rather than a stand-in.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import VisaActivityLog, {
  logVisaActivity,
  VISA_ACTIVITY_EVENT_TYPES,
  VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES,
  VISA_ACTIVITY_ACTOR_TYPES,
} from "./VisaActivityLog.js";

vi.mock("../utils/logger.js", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

describe("VISA_ACTIVITY_EVENT_TYPES / customer-visible slice", () => {
  it("every customer-visible event type is a real event type", () => {
    for (const t of VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES) {
      expect(VISA_ACTIVITY_EVENT_TYPES).toContain(t);
    }
  });

  it("excludes every assignment, cost, billing, and extraction event — internal concierge-console detail only", () => {
    const internalOnly = [
      "CONCIERGE_ASSIGNED", "CONCIERGE_CHANGED", "CONCIERGE_CLEARED",
      "SCREENING_OFFICER_ASSIGNED", "SCREENING_OFFICER_CHANGED", "SCREENING_OFFICER_CLEARED",
      "COSTS_RECORDED",
      "MANUAL_BOOKING_CREATED", "MANUAL_BOOKING_UPDATED",
      "EXTRACTION_STARTED", "EXTRACTION_COMPLETED", "EXTRACTION_FAILED", "FIELDS_CONFIRMED",
    ] as const;
    for (const t of internalOnly) {
      expect(VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES.has(t)).toBe(false);
    }
  });

  it("includes every lifecycle and document event", () => {
    const customerFacing = [
      "REQUEST_CREATED", "APPLICATION_CREATED", "SUBMITTED", "STATUS_CHANGED",
      "ACTION_REQUIRED_SET", "ACTION_REQUIRED_CLEARED", "OUTCOME_RECORDED", "REQUEST_CANCELLED",
      "DOCUMENT_UPLOADED", "DOCUMENT_REPLACED", "DOCUMENT_DELETED", "DOCUMENT_ACCEPTED", "DOCUMENT_REJECTED",
    ] as const;
    for (const t of customerFacing) {
      expect(VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES.has(t)).toBe(true);
    }
  });

  it("actor types are exactly STAFF/CUSTOMER/SYSTEM", () => {
    expect([...VISA_ACTIVITY_ACTOR_TYPES].sort()).toEqual(["CUSTOMER", "STAFF", "SYSTEM"]);
  });
});

describe("logVisaActivity", () => {
  const applicationId = new mongoose.Types.ObjectId();
  const requestId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const actorUserId = new mongoose.Types.ObjectId();

  let createSpy: any;

  beforeEach(() => {
    createSpy = vi.spyOn(VisaActivityLog, "create").mockResolvedValue([{}] as any);
  });

  it("writes exactly one row per call, with the fields passed through", async () => {
    await logVisaActivity({
      applicationId,
      requestId,
      workspaceId,
      eventType: "STATUS_CHANGED",
      actorUserId,
      actorType: "STAFF",
      detail: { from: "submitted", to: "docs_under_review" },
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [[rows]] = createSpy.mock.calls;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.applicationId).toBe(applicationId);
    expect(row.requestId).toBe(requestId);
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.eventType).toBe("STATUS_CHANGED");
    expect(row.actorUserId).toBe(actorUserId);
    expect(row.actorType).toBe("STAFF");
    expect(row.detail).toEqual({ from: "submitted", to: "docs_under_review" });
    expect(row.at).toBeInstanceOf(Date);
  });

  it("defaults applicationId/actorUserId to null and detail to {} when omitted — request-level events (REQUEST_CREATED/CANCELLED) have no single application", async () => {
    await logVisaActivity({
      requestId,
      workspaceId,
      eventType: "REQUEST_CANCELLED",
      actorType: "CUSTOMER",
    });

    const [[rows]] = createSpy.mock.calls;
    const row = rows[0];
    expect(row.applicationId).toBeNull();
    expect(row.actorUserId).toBeNull();
    expect(row.detail).toEqual({});
  });

  it("SYSTEM events (extraction, billing sync) carry no actorUserId", async () => {
    await logVisaActivity({
      applicationId,
      requestId,
      workspaceId,
      eventType: "EXTRACTION_STARTED",
      actorUserId: null,
      actorType: "SYSTEM",
    });

    const [[rows]] = createSpy.mock.calls;
    expect(rows[0].actorUserId).toBeNull();
    expect(rows[0].actorType).toBe("SYSTEM");
  });

  it("never throws when the underlying write fails — the operation it describes must survive", async () => {
    createSpy.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      logVisaActivity({
        applicationId,
        requestId,
        workspaceId,
        eventType: "DOCUMENT_UPLOADED",
        actorUserId,
        actorType: "CUSTOMER",
      }),
    ).resolves.toBeUndefined();
  });

  it("is append-only: two events on the same application create two separate rows, never an update to the first", async () => {
    await logVisaActivity({
      applicationId, requestId, workspaceId,
      eventType: "STATUS_CHANGED", actorUserId, actorType: "STAFF",
      detail: { from: "submitted", to: "docs_under_review" },
    });
    await logVisaActivity({
      applicationId, requestId, workspaceId,
      eventType: "STATUS_CHANGED", actorUserId, actorType: "STAFF",
      detail: { from: "docs_under_review", to: "cost_confirmed" },
    });

    expect(createSpy).toHaveBeenCalledTimes(2);
    // Two independent inserts, not one row mutated twice — the second call's
    // payload still shows the second transition, proving nothing overwrote
    // or merged with the first instead of adding to it.
    const firstRow = createSpy.mock.calls[0][0][0];
    const secondRow = createSpy.mock.calls[1][0][0];
    expect(firstRow.detail).toEqual({ from: "submitted", to: "docs_under_review" });
    expect(secondRow.detail).toEqual({ from: "docs_under_review", to: "cost_confirmed" });
  });
});
