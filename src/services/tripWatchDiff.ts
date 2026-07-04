// apps/backend/src/services/tripWatchDiff.ts
//
// PURE flight-status diffing for the trip watcher. Normalises a FlightAware
// EnhancedFlightInfo into a compact snapshot and detects MATERIAL changes vs the
// last known snapshot (cancellation, delay >= 30 min, gate/terminal change).

export interface WatchFlightState {
  status: string;
  depScheduled?: string | null;
  depActual?: string | null;
  depGate?: string | null;
  depTerminal?: string | null;
  // Arrival-side landing signal (Phase 4). There is NO arrival.actual in the
  // FlightAware shape, so "landed" is inferred from flight_status / progress.
  progressPercent?: number | null;
}

export type MaterialChangeKind = "CANCELLED" | "DELAY" | "GATE_CHANGE" | "TERMINAL_CHANGE";

export interface MaterialChange {
  changed: boolean;
  kind?: MaterialChangeKind;
  detail?: string;
}

export const DELAY_THRESHOLD_MIN = 30;

/** Normalise a getDelightfulFlightStatus result into a WatchFlightState. */
export function normalizeWatchState(info: any): WatchFlightState {
  return {
    status: info?.flight_status || "Unknown",
    depScheduled: info?.departure?.scheduled ?? null,
    depActual: info?.departure?.actual ?? null,
    depGate: info?.departure?.gate ?? null,
    depTerminal: info?.departure?.terminal ?? null,
    progressPercent: info?.progress_percent ?? null,
  };
}

/**
 * isLanded — PURE arrival detection (Phase 4). A watch has arrived when the
 * normalized flight_status is "Landed" (normalizeStatus maps any "land*" here)
 * OR progress is 100%. Idempotency across cycles is enforced by the unique
 * ArrivalSession-per-watch index, NOT by diffing — so this stays a simple test.
 */
export function isLanded(state: WatchFlightState | null | undefined): boolean {
  if (!state) return false;
  if (state.status === "Landed") return true;
  return state.progressPercent === 100;
}

function minutesBetween(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (isNaN(ta) || isNaN(tb)) return null;
  return Math.round((tb - ta) / 60000);
}

/**
 * detectMaterialChange — returns the FIRST material change vs the previous
 * snapshot. Delay and cancellation only fire on a NEW transition (so we don't
 * re-alert every cycle). prev=null means "first observation" (no delay/gate
 * baseline yet → only a fresh cancellation alerts).
 */
export function detectMaterialChange(
  prev: WatchFlightState | null,
  curr: WatchFlightState,
): MaterialChange {
  // Cancellation — only on transition into a cancelled state.
  const currCancelled = /cancel/i.test(curr.status);
  const prevCancelled = prev ? /cancel/i.test(prev.status) : false;
  if (currCancelled && !prevCancelled) {
    return { changed: true, kind: "CANCELLED", detail: "Flight cancelled" };
  }

  // Departure delay >= threshold, newly crossing it.
  const currDelay = minutesBetween(curr.depScheduled, curr.depActual);
  const prevDelay = prev ? minutesBetween(prev.depScheduled, prev.depActual) : null;
  if (
    currDelay != null &&
    currDelay >= DELAY_THRESHOLD_MIN &&
    (prevDelay == null || prevDelay < DELAY_THRESHOLD_MIN)
  ) {
    return { changed: true, kind: "DELAY", detail: `Departure delayed ${currDelay} min` };
  }

  // Gate change (only when we had a prior gate to compare).
  if (prev && prev.depGate && curr.depGate && curr.depGate !== prev.depGate) {
    return { changed: true, kind: "GATE_CHANGE", detail: `Gate changed to ${curr.depGate}` };
  }

  // Terminal change.
  if (prev && prev.depTerminal && curr.depTerminal && curr.depTerminal !== prev.depTerminal) {
    return { changed: true, kind: "TERMINAL_CHANGE", detail: `Terminal changed to ${curr.depTerminal}` };
  }

  return { changed: false };
}
