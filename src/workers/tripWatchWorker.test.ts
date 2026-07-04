import { describe, it, expect, vi } from "vitest";
import { runWatchCycle, type WatchCycleDeps } from "./tripWatchWorker.js";

// A claim source that hands out each watch exactly once (mimics the atomic
// findOneAndUpdate claim: a claimed watch is never returned again this cycle).
function claimSource(watches: any[]) {
  const q = [...watches];
  return () => Promise.resolve(q.shift() ?? null);
}

function baseDeps(over: Partial<WatchCycleDeps> = {}): WatchCycleDeps {
  return {
    cap: 50,
    metric: vi.fn(),
    claimNext: () => Promise.resolve(null),
    checkStatus: vi.fn().mockResolvedValue({ flight_status: "Scheduled", departure: { scheduled: "2026-08-12T10:00:00Z" } }),
    persistCheck: vi.fn().mockResolvedValue(undefined),
    createAndNotifyAlert: vi.fn().mockResolvedValue(undefined),
    isBookingCancelled: vi.fn().mockResolvedValue(false),
    cancelWatch: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const watch = (over: any = {}) => ({ _id: "w1", workspaceId: "ws1", flightNo: "6E-204", lastKnownState: null, ...over });

describe("runWatchCycle", () => {
  it("claim atomicity: two cycles sharing one claim source never double-process", async () => {
    const shared = claimSource([watch({ _id: "a" })]); // exactly ONE watch available
    const d1 = baseDeps({ claimNext: shared });
    const d2 = baseDeps({ claimNext: shared });

    const [r1, r2] = await Promise.all([runWatchCycle(d1), runWatchCycle(d2)]);
    // Exactly one cycle checked the single watch; the other got nothing.
    expect(r1.checked + r2.checked).toBe(1);
  });

  it("respects the per-cycle cap", async () => {
    const many = claimSource(Array.from({ length: 10 }, (_, i) => watch({ _id: `w${i}` })));
    const checkStatus = vi.fn().mockResolvedValue({ flight_status: "Scheduled", departure: { scheduled: "2026-08-12T10:00:00Z" } });
    const r = await runWatchCycle(baseDeps({ claimNext: many, cap: 3, checkStatus }));
    expect(r.checked).toBe(3);
    expect(checkStatus).toHaveBeenCalledTimes(3); // 1 FlightAware call per watch, capped
  });

  it("a material change creates an alert", async () => {
    const createAndNotifyAlert = vi.fn().mockResolvedValue(undefined);
    const checkStatus = vi.fn().mockResolvedValue({ flight_status: "Cancelled", departure: {} });
    const r = await runWatchCycle(baseDeps({
      claimNext: claimSource([watch()]), checkStatus, createAndNotifyAlert,
    }));
    expect(r.alerted).toBe(1);
    expect(createAndNotifyAlert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "CANCELLED" }));
  });

  it("cancelled booking → cancels watch, no FlightAware call", async () => {
    const checkStatus = vi.fn();
    const cancelWatch = vi.fn().mockResolvedValue(undefined);
    await runWatchCycle(baseDeps({
      claimNext: claimSource([watch()]),
      isBookingCancelled: vi.fn().mockResolvedValue(true),
      checkStatus, cancelWatch,
    }));
    expect(cancelWatch).toHaveBeenCalledTimes(1);
    expect(checkStatus).not.toHaveBeenCalled();
  });

  it("one failing watch does NOT kill the loop", async () => {
    let call = 0;
    const checkStatus = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("flightaware timeout");
      return { flight_status: "Scheduled", departure: { scheduled: "2026-08-12T10:00:00Z" } };
    });
    const r = await runWatchCycle(baseDeps({
      claimNext: claimSource([watch({ _id: "a" }), watch({ _id: "b" })]), checkStatus,
    }));
    expect(r.failed).toBe(1);
    expect(r.checked).toBe(1); // second watch still processed
  });
});
