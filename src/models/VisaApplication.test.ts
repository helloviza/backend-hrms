// Unit coverage for VisaApplication.ts's paired action_required helpers —
// same approach as models/VisaRequest.test.ts's recomputeRequestStatus
// coverage: VisaApplication is the REAL model object with its own static
// methods spied (findById/findByIdAndUpdate), no DB connection needed. A
// tiny mutable `store` object stands in for the one document under test,
// so the sequential read-then-write these functions actually do (read the
// current status, decide, write) is genuinely exercised rather than
// asserted against a hand-picked fixture.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

vi.mock("../utils/logger.js", () => ({
  default: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import VisaApplication, { setActionRequired, clearActionRequired, isTravellerErased } from "./VisaApplication.js";

function chainWithLean(value: any) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

describe("setActionRequired / clearActionRequired", () => {
  const appId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  let store: Record<string, any> | null;
  let findByIdSpy: any;
  let findByIdAndUpdateSpy: any;

  beforeEach(() => {
    store = { status: "cost_confirmed" };
    findByIdSpy = vi.spyOn(VisaApplication, "findById").mockImplementation(() => chainWithLean(store ? { ...store } : null) as any);
    findByIdAndUpdateSpy = vi.spyOn(VisaApplication, "findByIdAndUpdate").mockImplementation(((_id: any, update: any) => {
      if (!store) return Promise.resolve(null);
      Object.assign(store, update.$set);
      return Promise.resolve({ ...store });
    }) as any);
  });

  describe("setActionRequired", () => {
    it("rejects an empty/whitespace-only reason, without reading or writing anything", async () => {
      await expect(setActionRequired(appId, "   ", userId)).rejects.toThrow(/non-empty reason/);
      expect(findByIdSpy).not.toHaveBeenCalled();
      expect(findByIdAndUpdateSpy).not.toHaveBeenCalled();
    });

    it("returns null when the application doesn't exist, and writes nothing", async () => {
      store = null;
      const result = await setActionRequired(appId, "reason", userId);
      expect(result).toBeNull();
      expect(findByIdAndUpdateSpy).not.toHaveBeenCalled();
    });

    it("captures the current status into statusBeforeActionRequired", async () => {
      store!.status = "cost_confirmed";
      await setActionRequired(appId, "Bank statement needs a bank stamp", userId);
      expect(store!.status).toBe("action_required");
      expect(store!.statusBeforeActionRequired).toBe("cost_confirmed");
      expect(store!.actionRequiredReason).toBe("Bank statement needs a bank stamp");
      expect(store!.actionRequiredSetAt).toBeInstanceOf(Date);
      expect(String(store!.actionRequiredSetByUserId)).toBe(String(userId));
    });

    // The case that would corrupt the capture: re-affirming action_required
    // with a fresh reason while ALREADY action_required must never overwrite
    // statusBeforeActionRequired with the literal string "action_required".
    it("setting twice without clearing does not overwrite the captured status with 'action_required' itself", async () => {
      store!.status = "cost_confirmed";
      await setActionRequired(appId, "first reason", userId);
      expect(store!.statusBeforeActionRequired).toBe("cost_confirmed");

      await setActionRequired(appId, "second reason", userId);
      expect(store!.status).toBe("action_required");
      expect(store!.statusBeforeActionRequired).toBe("cost_confirmed");
      expect(store!.actionRequiredReason).toBe("second reason");
    });

    // Phase 9f — a fresh ask starts unanswered, even if a PRIOR episode on
    // this same application was responded to (a stale stamp would
    // misrepresent this new ask as already answered).
    it("nulls customerRespondedAt — a fresh ask starts unanswered, even if a prior episode had a stamp", async () => {
      store!.status = "cost_confirmed";
      store!.customerRespondedAt = new Date("2026-01-01T00:00:00Z"); // left over from a prior, already-cleared episode

      await setActionRequired(appId, "reason", userId);

      expect(store!.customerRespondedAt).toBeNull();
    });
  });

  describe("clearActionRequired", () => {
    it("set from cost_confirmed, then cleared, returns to cost_confirmed", async () => {
      store!.status = "cost_confirmed";
      await setActionRequired(appId, "reason", userId);
      expect(store!.status).toBe("action_required");

      await clearActionRequired(appId);
      expect(store!.status).toBe("cost_confirmed");
    });

    it("set from docs_under_review, then cleared, returns to docs_under_review (not a later stage)", async () => {
      store!.status = "docs_under_review";
      await setActionRequired(appId, "reason", userId);
      await clearActionRequired(appId);
      expect(store!.status).toBe("docs_under_review");
    });

    it("clears all four fields together", async () => {
      store!.status = "cost_confirmed";
      await setActionRequired(appId, "reason", userId);
      await clearActionRequired(appId);

      expect(store!.actionRequiredReason).toBeNull();
      expect(store!.actionRequiredSetAt).toBeNull();
      expect(store!.actionRequiredSetByUserId).toBeNull();
      expect(store!.statusBeforeActionRequired).toBeNull();
    });

    it("falls back to 'submitted' when statusBeforeActionRequired is absent — never a later stage", async () => {
      store!.status = "action_required";
      store!.statusBeforeActionRequired = null; // e.g. a record flagged before this field existed
      await clearActionRequired(appId);
      expect(store!.status).toBe("submitted");
      // Still clears the other three even on the fallback path.
      expect(store!.actionRequiredReason).toBeNull();
      expect(store!.statusBeforeActionRequired).toBeNull();
    });

    it("returns null when the application doesn't exist, and writes nothing", async () => {
      store = null;
      const result = await clearActionRequired(appId);
      expect(result).toBeNull();
      expect(findByIdAndUpdateSpy).not.toHaveBeenCalled();
    });

    // Phase 9f — customerRespondedAt is evidence of what happened in the
    // episode that just ended; clearActionRequired (manual or the Phase 9f
    // auto-clear, which reuses this same helper) must leave it exactly as
    // it was. Only the NEXT setActionRequired call resets it.
    it("does not touch customerRespondedAt — that's setActionRequired's job, not this one's", async () => {
      store!.status = "cost_confirmed";
      await setActionRequired(appId, "reason", userId);
      store!.customerRespondedAt = new Date("2026-02-01T00:00:00Z");

      await clearActionRequired(appId);

      expect(store!.customerRespondedAt).toEqual(new Date("2026-02-01T00:00:00Z"));
    });
  });
});

describe("isTravellerErased", () => {
  it("is false for an application whose traveller was never erased", () => {
    expect(isTravellerErased({ travellerErasedAt: null })).toBe(false);
    expect(isTravellerErased({})).toBe(false);
  });

  it("is true once travellerErasedAt is set", () => {
    expect(isTravellerErased({ travellerErasedAt: new Date() })).toBe(true);
  });

  it("is false for a null/undefined application — never throws on a not-found lookup", () => {
    expect(isTravellerErased(null)).toBe(false);
    expect(isTravellerErased(undefined)).toBe(false);
  });
});
