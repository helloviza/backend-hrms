// apps/backend/src/utils/demoContext.ts
//
// Demo Platform — request-scoped demo flag + fail-CLOSED TBO egress guard.
//
// Goal: when a request is authenticated as an impersonated demo user
// (req.user.isDemoUser === true), NO outbound TBO call may fire — not search,
// fare-quote, fare-rule, SSR, calendar, booking-detail reads, agency-balance,
// static-data reads, nor any booking write.
//
// The booking WRITE routes already short-circuit upstream via
// `maybeRouteToDemoSimulator` (see utils/demoSimulator.ts). This module is the
// additional last line of defence *at the egress layer*, beneath those guards,
// covering the READ surface that has no per-route simulator.
//
// Mechanism: the auth middleware wraps `next()` in
// `runWithDemoContext(store, () => next())`, so the demo flag (plus userId /
// sessionId for log attribution) rides an AsyncLocalStorage through every
// awaited continuation of the request — including the service-layer fetch()
// calls many frames down. Each TBO egress point calls `assertNotDemoTBO(op)`
// immediately before its fetch.
//
//   • Non-demo request  → store carries isDemoUser:false → assert is a no-op →
//                          the real path is byte-identical to before.
//   • Demo request      → assert warn-logs + throws → the TBO call never fires.
//   • Background job /   → no store at all → getStore() is undefined → treated
//     startup preload      as non-demo → unaffected (these MUST hit TBO).

import { AsyncLocalStorage } from "node:async_hooks";
import { sbtLogger } from "./logger.js";

export interface DemoStore {
  isDemoUser: boolean;
  /** Acting user id (impersonated user for demo sessions) — log attribution only. */
  userId?: string;
  /** Demo impersonation session id (DemoSession._id) — log attribution only. */
  sessionId?: string;
}

const demoContext = new AsyncLocalStorage<DemoStore>();

/**
 * Run `fn` — and every async continuation it spawns — with the request's demo
 * context attached. The auth middleware calls this around `next()`.
 */
export function runWithDemoContext<T>(store: DemoStore, fn: () => T): T {
  return demoContext.run({ ...store, isDemoUser: store.isDemoUser === true }, fn);
}

/** True only inside a request that authenticated as a demo/impersonation user. */
export function isDemoRequest(): boolean {
  return demoContext.getStore()?.isDemoUser === true;
}

/** Stable error code surfaced when a demo request is blocked at a TBO egress. */
export const DEMO_EGRESS_BLOCKED_CODE = "DEMO_EGRESS_BLOCKED";

/**
 * Thrown when a demo request reaches a TBO egress point that has no simulator.
 * The message names NO vendor — it is safe to surface to the client.
 *
 * `status = 501 Not Implemented` is honored by the global errorHandler (reads
 * `err.status`) and by route catch blocks via `tboBlockStatus(err)`.
 */
export class DemoEgressBlockedError extends Error {
  readonly code = DEMO_EGRESS_BLOCKED_CODE;
  readonly status = 501;
  readonly op: string;
  constructor(op: string) {
    super("This isn't available in demo mode.");
    this.name = "DemoEgressBlockedError";
    this.op = op;
  }
}

/**
 * Fail-closed gate. Call immediately before any outbound TBO request.
 * No-op for real traffic; for demo requests it warn-logs (op + userId +
 * sessionId for production visibility) and throws so the call never fires.
 */
export function assertNotDemoTBO(op: string): void {
  const store = demoContext.getStore();
  if (store?.isDemoUser === true) {
    sbtLogger.warn("[DEMO] blocked TBO egress (fail-closed)", {
      op,
      userId: store.userId,
      sessionId: store.sessionId,
    });
    throw new DemoEgressBlockedError(op);
  }
}

/**
 * Map a caught error to its HTTP status for route catch blocks. Returns 501
 * for a fail-closed demo block, otherwise 500 — byte-identical to the previous
 * hardcoded `res.status(500)` for every non-demo error. Accepts `unknown` so it
 * works directly inside `catch (err: unknown)`.
 */
export function tboBlockStatus(err: unknown): number {
  return (err as any)?.code === DEMO_EGRESS_BLOCKED_CODE ? 501 : 500;
}
