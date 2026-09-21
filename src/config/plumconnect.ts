// apps/backend/src/config/plumconnect.ts
//
// PLUMCONNECT_ENABLED — the ship-dark switch for PlumConnect (the single-WABA
// WhatsApp router: docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md).
//
// OFF (default, unset, anything but "true"): the WhatsApp webhook runs its
// existing type-first ladder byte-for-byte; the PlumConnect models exist but
// nothing writes them; no route, nav item or permission surface is reachable.
//
// ON ("true"): the context-first dispatcher takes the inbound path (Slice 2
// onward). Slice 0 ships this switch with NOTHING gated on it, so that later
// slices have one agreed flag to import rather than each inventing its own.
//
// Read live from process.env on every call — the same pattern as
// config/crmV2.ts — so a test can pin either state without re-importing and
// the switch can be flipped at runtime (APP_SECRETS) without a rebuild.

export const PLUMCONNECT_ENABLED_ENV = "PLUMCONNECT_ENABLED";

export function isPlumConnectEnabled(): boolean {
  return String(process.env[PLUMCONNECT_ENABLED_ENV] || "").trim().toLowerCase() === "true";
}

// (PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE — the Slice 3b static assignee — was
// retired by Track B: a captured lead is routed by the assignment matrix
// (services/plumconnect/assignment.ts) or held unassigned. The env var is
// no longer read anywhere.)

// ── PLUMCONNECT_ADS_READ_TOKEN — Slice 8 ────────────────────────────────────
//
// A Meta system-user token with `ads_read` on the ad account, used ONLY by
// workers/plumconnectEnrichmentWorker.ts to resolve an ad id upward to its
// ad set and campaign (names, statuses). NOT a dependency of anything else:
// unset → the worker discovers ad ids and leaves them pending, capture is
// untouched, nothing errors. Read live like the flag above; lives in
// APP_SECRETS in prod like every other credential. Never in code.

export const PLUMCONNECT_ADS_READ_TOKEN_ENV = "PLUMCONNECT_ADS_READ_TOKEN";

export function adsReadToken(): string | null {
  const raw = String(process.env[PLUMCONNECT_ADS_READ_TOKEN_ENV] || "").trim();
  return raw || null;
}

/** Enrichment runs only with the flag on AND a token present. */
export function isEnrichmentEnabled(): boolean {
  return isPlumConnectEnabled() && adsReadToken() !== null;
}
