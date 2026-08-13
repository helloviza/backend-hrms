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

import VisaApplication, {
  setActionRequired,
  clearActionRequired,
  setDiscrepancyFlagged,
  clearDiscrepancyFlagged,
  isTravellerErased,
} from "./VisaApplication.js";

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

/* ═══════════════════════════════════════════════════════════════════════
 * discrepancy_flagged (2026-08-12) — the INTERNAL-hold interrupt, and the
 * capture slot it shares with action_required.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("setDiscrepancyFlagged / clearDiscrepancyFlagged", () => {
  const appId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  let store: Record<string, any> | null;
  let findByIdAndUpdateSpy: any;

  beforeEach(() => {
    store = { status: "docs_under_review" };
    vi.spyOn(VisaApplication, "findById").mockImplementation(() => chainWithLean(store ? { ...store } : null) as any);
    findByIdAndUpdateSpy = vi.spyOn(VisaApplication, "findByIdAndUpdate").mockImplementation(((_id: any, update: any) => {
      if (!store) return Promise.resolve(null);
      Object.assign(store, update.$set);
      return Promise.resolve({ ...store });
    }) as any);
  });

  it("rejects an empty reason — an internal hold nobody can read is not a hold", async () => {
    await expect(setDiscrepancyFlagged(appId, "  ", userId)).rejects.toThrow(/non-empty reason/);
    expect(findByIdAndUpdateSpy).not.toHaveBeenCalled();
  });

  it("returns null for a missing application and writes nothing", async () => {
    store = null;
    expect(await setDiscrepancyFlagged(appId, "reason", userId)).toBeNull();
    expect(findByIdAndUpdateSpy).not.toHaveBeenCalled();
  });

  it("captures the displaced status and records the finding", async () => {
    await setDiscrepancyFlagged(appId, "Photo face height under spec", userId);
    expect(store!.status).toBe("discrepancy_flagged");
    expect(store!.statusBeforeActionRequired).toBe("docs_under_review");
    expect(store!.discrepancyReason).toBe("Photo face height under spec");
    expect(store!.discrepancySetAt).toBeInstanceOf(Date);
    expect(String(store!.discrepancySetByUserId)).toBe(String(userId));
  });

  it("re-flagging with a fresh finding never captures 'discrepancy_flagged' over the real status", async () => {
    await setDiscrepancyFlagged(appId, "first finding", userId);
    await setDiscrepancyFlagged(appId, "second finding", userId);
    expect(store!.statusBeforeActionRequired).toBe("docs_under_review");
    expect(store!.discrepancyReason).toBe("second finding");
  });

  it("clearing restores the captured status and nulls the whole trio", async () => {
    await setDiscrepancyFlagged(appId, "finding", userId);
    await clearDiscrepancyFlagged(appId);
    expect(store!.status).toBe("docs_under_review");
    expect(store!.discrepancyReason).toBeNull();
    expect(store!.discrepancySetAt).toBeNull();
    expect(store!.discrepancySetByUserId).toBeNull();
    expect(store!.statusBeforeActionRequired).toBeNull();
  });

  it("falls back to 'submitted' — never a later stage — when no capture survives", async () => {
    store = { status: "discrepancy_flagged" };
    await clearDiscrepancyFlagged(appId);
    expect(store!.status).toBe("submitted");
  });

  it("does NOT clear customerRespondedAt — flagging internally asks the customer nothing", async () => {
    const replied = new Date("2026-08-01T00:00:00.000Z");
    store = { status: "docs_under_review", customerRespondedAt: replied };
    await setDiscrepancyFlagged(appId, "finding", userId);
    // setActionRequired deliberately nulls this (a fresh ask starts
    // unanswered). An internal hold is not an ask, so a reply the customer
    // really did send must not be erased.
    expect(store!.customerRespondedAt).toBe(replied);
  });

  describe("the shared capture slot — the two interrupts hand over, they do not nest", () => {
    it("discrepancy -> action_required -> clear resumes the ORIGINAL stage, not discrepancy_flagged", async () => {
      store = { status: "docs_under_review" };
      await setDiscrepancyFlagged(appId, "we found something", userId);
      expect(store!.statusBeforeActionRequired).toBe("docs_under_review");

      // Escalate: we have now asked the customer.
      await setActionRequired(appId, "please resend the photo", userId);
      expect(store!.status).toBe("action_required");
      // The capture must NOT have become "discrepancy_flagged" — otherwise
      // clearing below would strand the case back on an internal hold that
      // was already resolved into a customer ask.
      expect(store!.statusBeforeActionRequired).toBe("docs_under_review");

      await clearActionRequired(appId);
      expect(store!.status).toBe("docs_under_review");
    });

    it("action_required -> discrepancy_flagged (customer answered, ops investigating) keeps the original capture", async () => {
      store = { status: "cost_confirmed" };
      await setActionRequired(appId, "need a bank stamp", userId);
      expect(store!.statusBeforeActionRequired).toBe("cost_confirmed");

      await setDiscrepancyFlagged(appId, "stamp is there but the balance is short", userId);
      expect(store!.status).toBe("discrepancy_flagged");
      expect(store!.statusBeforeActionRequired).toBe("cost_confirmed");

      await clearDiscrepancyFlagged(appId);
      expect(store!.status).toBe("cost_confirmed");
    });
  });
});
