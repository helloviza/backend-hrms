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

// ── PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE — Slice 3b ──────────────────────────
//
// The User._id that owns holiday leads captured from a CTWA referral
// (services/plumconnect/holidayLead.ts). Unset or malformed → the adapter
// falls back to the same "first ADMIN/SUPERADMIN" rule the website-capture
// route uses (routes/leads.ts:260-264). Read live, like the flag above.

export const PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE_ENV = "PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE";

/** The configured assignee id as a 24-hex string, or null when unset/invalid. */
export function holidayLeadAssigneeId(): string | null {
  const raw = String(process.env[PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE_ENV] || "").trim();
  return /^[0-9a-fA-F]{24}$/.test(raw) ? raw : null;
}
