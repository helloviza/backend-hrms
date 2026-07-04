import { describe, it, expect } from "vitest";
import { detectMaterialChange, normalizeWatchState } from "./tripWatchDiff.js";

const S = (over: Partial<ReturnType<typeof normalizeWatchState>> = {}) => ({
  status: "Scheduled", depScheduled: "2026-08-12T10:00:00Z", depActual: null, depGate: null, depTerminal: null,
  ...over,
});

describe("detectMaterialChange", () => {
  it("no change → changed:false", () => {
    expect(detectMaterialChange(S(), S()).changed).toBe(false);
  });

  it("cancellation fires once on transition into cancelled", () => {
    const r = detectMaterialChange(S({ status: "Scheduled" }), S({ status: "Cancelled" }));
    expect(r).toMatchObject({ changed: true, kind: "CANCELLED" });
    // Already cancelled → no re-alert.
    expect(detectMaterialChange(S({ status: "Cancelled" }), S({ status: "Cancelled" })).changed).toBe(false);
  });

  it("delay >= 30 min fires when newly crossing the threshold", () => {
    const prev = S({ depActual: "2026-08-12T10:10:00Z" }); // 10 min delay
    const curr = S({ depActual: "2026-08-12T10:45:00Z" }); // 45 min delay
    const r = detectMaterialChange(prev, curr);
    expect(r).toMatchObject({ changed: true, kind: "DELAY" });
    expect(r.detail).toContain("45");
  });

  it("delay under threshold does not fire", () => {
    const curr = S({ depActual: "2026-08-12T10:20:00Z" }); // 20 min
    expect(detectMaterialChange(S(), curr).changed).toBe(false);
  });

  it("does not re-alert a delay already above threshold", () => {
    const prev = S({ depActual: "2026-08-12T10:40:00Z" }); // 40
    const curr = S({ depActual: "2026-08-12T10:50:00Z" }); // 50 (still delayed, no new crossing)
    expect(detectMaterialChange(prev, curr).changed).toBe(false);
  });

  it("gate + terminal change fire only with a prior value", () => {
    expect(detectMaterialChange(S({ depGate: "A1" }), S({ depGate: "B7" }))).toMatchObject({ changed: true, kind: "GATE_CHANGE" });
    expect(detectMaterialChange(S({ depTerminal: "1" }), S({ depTerminal: "2" }))).toMatchObject({ changed: true, kind: "TERMINAL_CHANGE" });
    // No prior gate → no alert.
    expect(detectMaterialChange(S({ depGate: null }), S({ depGate: "B7" })).changed).toBe(false);
  });

  it("normalizeWatchState maps FlightAware shape", () => {
    const s = normalizeWatchState({ flight_status: "Delayed", departure: { scheduled: "x", actual: "y", gate: "G", terminal: "T" } });
    expect(s).toEqual({ status: "Delayed", depScheduled: "x", depActual: "y", depGate: "G", depTerminal: "T" });
  });
});
