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
  isLanded,
  type MaterialChange,
  type WatchFlightState,
} from "../services/tripWatchDiff.js";
import { openArrivalSession } from "../services/arrivalSession.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { watchMetric } from "../utils/plutoMetricsBuilder.js";
import { deliverTripAlert, MAX_ATTEMPTS } from "../services/tripNotifier.js";
import { getDestinationWeather } from "../services/weatherService.js";

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
  /** On LANDED for a WHATSAPP watch: open the arrival concierge session (Phase 4). */
  handleArrival: (watch: any, info: any) => Promise<void>;
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

      // Phase 4 (Arrive): open the WhatsApp concierge session once landed. The
      // unique ArrivalSession-per-watch index makes this idempotent across the
      // repeated cycles a landed flight produces.
      if (watch.notifyChannel === "WHATSAPP" && isLanded(curr)) {
        await deps.handleArrival(watch, info);
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
      const alert = (await TripAlert.create({
        workspaceId: watch.workspaceId,
        tripWatchId: watch._id,
        kind: change.kind,
        detail: change.detail || "",
        deliveryStatus: "PENDING",
      })) as any;
      const outcome = await deliverTripAlert(alert, watch);
      await TripAlert.updateOne(
        { _id: alert._id },
        {
          $set: {
            deliveryStatus: outcome.deliveryStatus,
            channelUsed: outcome.channelUsed,
            attempts: outcome.attempts,
            deliveredAt: outcome.delivered ? new Date() : null,
          },
        },
      );
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
    handleArrival: (watch, info) => openArrivalSession(watch, info, now),
  };
}

// Retry PENDING alerts once next cycle; deliverTripAlert marks FAILED at
// MAX_ATTEMPTS so we never infinite-retry.
async function retryPendingAlerts(): Promise<void> {
  const pending = (await TripAlert.find({
    deliveryStatus: "PENDING",
    attempts: { $lt: MAX_ATTEMPTS },
  })
    .limit(100)
    .lean()) as any[];

  for (const alert of pending) {
    try {
      const watch = (await TripWatch.findById(alert.tripWatchId).lean()) as any;
      if (!watch) continue;
      const outcome = await deliverTripAlert(alert, watch);
      await TripAlert.updateOne(
        { _id: alert._id },
        {
          $set: {
            deliveryStatus: outcome.deliveryStatus,
            channelUsed: outcome.channelUsed,
            attempts: outcome.attempts,
            deliveredAt: outcome.delivered ? new Date() : null,
          },
        },
      );
    } catch (e: any) {
      console.error("[tripWatchWorker] retry failed", { alertId: String(alert?._id), message: e?.message });
    }
  }
}

// Severe-weather pass: for ACTIVE watches within 24h of departure, raise a
// one-off WEATHER alert (deduped per watch) through the same notifier path.
async function checkWeatherForDueWatches(now: Date): Promise<void> {
  const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const due = (await TripWatch.find({ status: "ACTIVE", departDate: { $gte: now, $lte: soon } })
    .limit(100)
    .lean()) as any[];

  for (const watch of due) {
    try {
      const dateISO = new Date(watch.departDate).toISOString().slice(0, 10);
      const w = await getDestinationWeather(watch.destination, dateISO);
      if (!w || !w.severe) continue;
      const existing = await TripAlert.findOne({ tripWatchId: watch._id, kind: "WEATHER" }).lean();
      if (existing) continue; // one weather alert per watch
      const alert = (await TripAlert.create({
        workspaceId: watch.workspaceId,
        tripWatchId: watch._id,
        kind: "WEATHER",
        detail: `Severe weather (${w.summary}) expected in ${w.city}`,
        deliveryStatus: "PENDING",
      })) as any;
      const outcome = await deliverTripAlert(alert, watch);
      await TripAlert.updateOne(
        { _id: alert._id },
        {
          $set: {
            deliveryStatus: outcome.deliveryStatus,
            channelUsed: outcome.channelUsed,
            attempts: outcome.attempts,
            deliveredAt: outcome.delivered ? new Date() : null,
          },
        },
      );
    } catch (e: any) {
      console.error("[tripWatchWorker] weather pass failed", { watchId: String(watch?._id), message: e?.message });
    }
  }
}

/** One full worker cycle against the REAL deps (models + FlightAware). Exported
 *  so integration tests can drive it end-to-end with the edges mocked. */
export async function runRealCycle(now: Date = new Date()): Promise<void> {
  await runWatchCycle(buildRealDeps(now));
  await checkWeatherForDueWatches(now);
  await retryPendingAlerts();
  // Terminal cleanup in the same cycle (Amendment I): COMPLETE watches whose
  // departure was > 24h ago.
  await TripWatch.updateMany(
    { status: "ACTIVE", departDate: { $lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    { $set: { status: "COMPLETED", claimedBy: null, claimedAt: null } },
  );
}

let isRunning = false;

export function startTripWatchWorker(): void {
  if (isRunning) return;
  isRunning = true;
  console.log("🛫 Trip watch worker started");

  setInterval(async () => {
    try {
      await runRealCycle(new Date());
    } catch (err) {
      console.error("❌ Trip watch worker error:", err);
    }
  }, POLL_INTERVAL_MS);
}
