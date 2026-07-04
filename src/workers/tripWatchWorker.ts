// apps/backend/src/workers/tripWatchWorker.ts
//
// Disruption watcher. Mirrors videoProcessingWorker's atomic-claim pattern so
// it is safe under multiple App Runner instances: each watch is claimed via an
// atomic findOneAndUpdate, so two instances never check (and double-alert) the
// same watch. FlightAware economics: 1 status call per watch per cycle, skip if
// checked < 15 min ago, hard cap per cycle (env WATCH_MAX_CALLS_PER_CYCLE).

import crypto from "crypto";
import TripWatch from "../models/TripWatch.js";
import TripAlert from "../models/TripAlert.js";
import SBTBooking from "../models/SBTBooking.js";
import { getDelightfulFlightStatus } from "../services/flightService.js";
import {
  detectMaterialChange,
  normalizeWatchState,
  type MaterialChange,
  type WatchFlightState,
} from "../services/tripWatchDiff.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { watchMetric } from "../utils/plutoMetricsBuilder.js";

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_RECHECK_MS = 15 * 60 * 1000; // don't re-check a watch within 15 min
const CLAIM_STALE_MS = 10 * 60 * 1000; // a claim older than this is reclaimable
const WINDOW_BEFORE_MS = 6 * 60 * 60 * 1000; // now - 6h
const WINDOW_AFTER_MS = 48 * 60 * 60 * 1000; // now + 48h
const INSTANCE_ID = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

function maxCallsPerCycle(): number {
  const n = Number(process.env.WATCH_MAX_CALLS_PER_CYCLE);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

export interface WatchCycleDeps {
  cap: number;
  metric: (m: any) => void;
  /** Atomically claim the next due, unclaimed ACTIVE watch (or null). */
  claimNext: () => Promise<any | null>;
  checkStatus: (flightNo: string) => Promise<any>;
  /** Persist lastCheckedAt + lastKnownState and release the claim. */
  persistCheck: (watch: any, curr: WatchFlightState | null) => Promise<void>;
  createAndNotifyAlert: (watch: any, change: MaterialChange) => Promise<void>;
  isBookingCancelled: (watch: any) => Promise<boolean>;
  cancelWatch: (watch: any) => Promise<void>;
}

/**
 * Pure-ish cycle over injected deps (testable without Mongo/FlightAware).
 * One watch failing never kills the loop.
 */
export async function runWatchCycle(
  deps: WatchCycleDeps,
): Promise<{ checked: number; alerted: number; failed: number }> {
  let checked = 0;
  let alerted = 0;
  let failed = 0;

  for (let i = 0; i < deps.cap; i++) {
    const watch = await deps.claimNext();
    if (!watch) break;

    try {
      // If the linked booking was cancelled, cancel the watch — no FlightAware call.
      if (await deps.isBookingCancelled(watch)) {
        await deps.cancelWatch(watch);
        continue;
      }

      const info = await deps.checkStatus(watch.flightNo); // 1 call per watch per cycle
      deps.metric(watchMetric("pluto.watch.checked", { workspaceId: String(watch.workspaceId) }));
      checked++;

      if (info?.error) {
        await deps.persistCheck(watch, null); // not found — record check, no alert
        continue;
      }

      const curr = normalizeWatchState(info);
      const change = detectMaterialChange(watch.lastKnownState || null, curr);
      await deps.persistCheck(watch, curr);

      if (change.changed) {
        await deps.createAndNotifyAlert(watch, change);
        deps.metric(watchMetric("pluto.watch.alerted", { workspaceId: String(watch.workspaceId) }));
        alerted++;
      }
    } catch (e: any) {
      deps.metric(
        watchMetric("pluto.watch.check_failed", { workspaceId: String(watch?.workspaceId), reason: e?.message }, "error"),
      );
      failed++;
      // swallow — one bad watch must not stop the cycle
    }
  }

  return { checked, alerted, failed };
}

/* ── Real dependency wiring ─────────────────────────────────────────── */

function buildRealDeps(now: Date): WatchCycleDeps {
  const windowStart = new Date(now.getTime() - WINDOW_BEFORE_MS);
  const windowEnd = new Date(now.getTime() + WINDOW_AFTER_MS);
  const recheckBefore = new Date(now.getTime() - MIN_RECHECK_MS);
  const claimStaleBefore = new Date(now.getTime() - CLAIM_STALE_MS);

  return {
    cap: maxCallsPerCycle(),
    metric: (m) => { void emitMetric(m); },
    claimNext: () =>
      TripWatch.findOneAndUpdate(
        {
          status: "ACTIVE",
          departDate: { $gte: windowStart, $lte: windowEnd },
          $and: [
            { $or: [{ lastCheckedAt: { $lt: recheckBefore } }, { lastCheckedAt: null }] },
            { $or: [{ claimedAt: { $lt: claimStaleBefore } }, { claimedAt: null }] },
          ],
        },
        { $set: { claimedBy: INSTANCE_ID, claimedAt: now } },
        { new: true, sort: { lastCheckedAt: 1 } },
      ),
    checkStatus: (flightNo) => getDelightfulFlightStatus(flightNo),
    persistCheck: async (watch, curr) => {
      await TripWatch.updateOne(
        { _id: watch._id },
        {
          $set: {
            lastCheckedAt: now,
            ...(curr ? { lastKnownState: curr } : {}),
            claimedBy: null,
            claimedAt: null,
          },
        },
      );
    },
    createAndNotifyAlert: async (watch, change) => {
      await TripAlert.create({
        workspaceId: watch.workspaceId,
        tripWatchId: watch._id,
        kind: change.kind,
        detail: change.detail || "",
        deliveryStatus: "PENDING",
      });
      // Delivery is wired to tripNotifier in Step 4; alert stays PENDING until then.
    },
    isBookingCancelled: async (watch) => {
      if (!watch.bookingId) return false;
      const booking = (await SBTBooking.findById(watch.bookingId).select("status").lean()) as any;
      return booking?.status === "CANCELLED";
    },
    cancelWatch: async (watch) => {
      await TripWatch.updateOne(
        { _id: watch._id },
        { $set: { status: "CANCELLED", claimedBy: null, claimedAt: null } },
      );
    },
  };
}

let isRunning = false;

export function startTripWatchWorker(): void {
  if (isRunning) return;
  isRunning = true;
  console.log("🛫 Trip watch worker started");

  setInterval(async () => {
    const now = new Date();
    try {
      await runWatchCycle(buildRealDeps(now));
      // Terminal cleanup in the same cycle (Amendment I): COMPLETE watches whose
      // departure was > 24h ago.
      await TripWatch.updateMany(
        { status: "ACTIVE", departDate: { $lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
        { $set: { status: "COMPLETED", claimedBy: null, claimedAt: null } },
      );
    } catch (err) {
      console.error("❌ Trip watch worker error:", err);
    }
  }, POLL_INTERVAL_MS);
}
