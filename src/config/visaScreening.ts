// apps/backend/src/config/visaScreening.ts
//
// Screening authority — the capability, the enforcement switch, and the
// authority matrix it enforces. Step 1 of
// infra/audit/visa-screening-authority-model-2026-08-12.md.
//
// ── WHY THIS IS OFF BY DEFAULT ─────────────────────────────────────────
// The audit found that switching screening enforcement on today would
// refuse 100% of document review, invisibly:
//   • no level template grants visaScreening (deliberately — who gets it is
//     still an open product decision), so nobody holds the capability;
//   • 0 applications have an assigned screening officer, so no per-case
//     check could pass either;
//   • the only active reviewer is an L8 SuperAdmin, who bypasses permission
//     checks BEFORE any gate is consulted — so the breakage would not show
//     up until the first non-SuperAdmin tried to work a case.
// So the mechanism ships wired but dormant. Turning it on is a separate,
// deliberate act, taken after the capability has actually been granted.
//
// ── WHY A FLAG, NOT LOG-ONLY ──────────────────────────────────────────
// A log-only mode would tell us who WOULD be refused, which sounds useful
// until you notice it cannot tell us anything we do not already know: the
// answer today is "everyone", because nothing is granted and nothing is
// assigned. It would produce a stream of warnings that are all expected,
// which is the fastest way to teach people to ignore a log. The switch gives
// the one thing that actually matters — a single reversible setting whose
// every state is well-defined, each covered by its own tests.
//
// ── WHY AN ENV FLAG, NOT A PER-WORKSPACE CONFIG ───────────────────────
// visaApprovalRequired (models/CustomerWorkspace.ts) is per-workspace
// because it describes the CUSTOMER's own internal policy — each company
// decides whether its own staff need an approver. Screening authority is
// the opposite: it describes how OUR ops team is allowed to work, and the
// same screening officer handles cases across every workspace. Enforcing it
// for client A but not client B would be incoherent. So it is one
// deployment-wide switch, and it takes the opt-in SHAPE of
// visaApprovalRequired (default off, nothing happens until someone turns it
// on) without borrowing its per-tenant storage.

// ── WHY A TIER, NOT TWO BOOLEANS ──────────────────────────────────────
// Step 1 shipped ONE flag that gated the capability check and the per-case
// assignment check together. That made the audit's staged rollout
// unreachable: you could not enforce "must be a screener" without also
// enforcing "must be THIS case's screener", which is a much larger
// operational change needing its own rulings (auto-claim, lead override).
//
// The fix is ONE ordered value, not two booleans. Two booleans admit the
// combination {assignment: true, capability: false} — "must be the assigned
// screener, but need not be a screener at all" — which is not a policy
// anyone would choose and which the code would then have to defend against
// at every read. A single tier makes that state unrepresentable rather than
// merely discouraged.
//
// The tiers are cumulative, each a strict superset of the one before:
//
//   off         nothing is checked. Today's behaviour, byte for byte.
//   capability  you must hold visaScreening. Per-case assignment is NOT
//               consulted — a screener may work any case they can already
//               reach. This is the audit's Step 2.
//   assignment  you must hold visaScreening AND be this case's assigned
//               screening officer. This is the audit's Step 3, and it is
//               what step 1 wired behind its single flag.

export const VISA_SCREENING_TIERS = ["off", "capability", "assignment"] as const;
export type VisaScreeningTier = (typeof VISA_SCREENING_TIERS)[number];

/** Bad values already warned about, so a misconfiguration logs once, not per request. */
const warnedTierValues = new Set<string>();

/**
 * The enforcement tier for the screening-act routes.
 *
 * Read live from process.env on every call rather than captured once at
 * module load. That is deliberate: it keeps the switch flippable without a
 * rebuild, and it lets each test pin the value it needs — every tier is a
 * real code path that needs real coverage, and a boot-time capture would
 * force most of them to be tested by mocking.
 *
 * UNRECOGNISED VALUES FALL BACK TO "off" AND WARN. Falling back to off keeps
 * a typo from being an outage, which matches the opt-in shape of the whole
 * mechanism — but silently reading `VISA_SCREENING_ENFORCEMENT=capabilty` as
 * "off" would leave someone believing they had enforcement they do not have,
 * so it is loud.
 *
 * LEGACY: `VISA_SCREENING_ENFORCED=true` (step 1's boolean) maps to
 * "assignment", which is exactly what it meant — capability AND assignment.
 * It is consulted only when the tier variable is unset, so an environment
 * carrying the old flag keeps its precise former meaning instead of silently
 * changing behaviour on deploy. New environments should set the tier.
 */
export function visaScreeningTier(): VisaScreeningTier {
  const raw = String(process.env.VISA_SCREENING_ENFORCEMENT || "").trim().toLowerCase();

  if (!raw) {
    const legacy = String(process.env.VISA_SCREENING_ENFORCED || "").trim().toLowerCase();
    return legacy === "true" ? "assignment" : "off";
  }

  if ((VISA_SCREENING_TIERS as readonly string[]).includes(raw)) {
    return raw as VisaScreeningTier;
  }

  if (!warnedTierValues.has(raw)) {
    warnedTierValues.add(raw);
    console.warn(
      `[visaScreening] VISA_SCREENING_ENFORCEMENT="${raw}" is not a known tier ` +
        `(${VISA_SCREENING_TIERS.join(" | ")}) — falling back to "off", so screening is NOT enforced.`,
    );
  }
  return "off";
}

/** True at any tier above off — i.e. the gate does something. */
export function isVisaScreeningEnforced(): boolean {
  return visaScreeningTier() !== "off";
}

/**
 * THE AUTHORITY MATRIX — enforced only while visaScreeningTier() is above
 * "off". Recorded here in one place because the split is a product decision,
 * not an implementation detail, and reading it out of three scattered route
 * guards is how it drifts.
 *
 *   CONCIERGE owns the relationship and the coordination.
 *   SCREENING owns the verdict on the applicant's evidence.
 *
 * ┌──────────────────────────────────────┬───────────┬───────────┐
 * │ Capability                           │ Concierge │ Screening │
 * ├──────────────────────────────────────┼───────────┼───────────┤
 * │ See the queue / case detail          │     ✓     │     ✓     │
 * │ Accept or reject a document          │     ✗     │     ✓     │  <- gated
 * │ Flag a discrepancy                   │     ✗     │     ✓     │  <- gated
 * │ Clear a discrepancy                  │     ✗     │     ✓     │  <- gated
 * │ Escalate discrepancy -> action_req.  │     ✓     │     ✓     │
 * │ Publish "action required" to customer│     ✓     │     ✓     │
 * │ Clear action_required                │     ✓     │     ✓     │
 * │ Advance the forward chain            │     ✓     │     ✓     │
 * │ Set service partner                  │     ✓     │     ✗     │
 * │ Assign / bulk-assign                 │     ✓     │     ✗     │
 * │ Record costs                         │     ✗     │     ✗     │  (FULL only)
 * │ Record outcome                       │     ✗     │     ✗     │  (FULL only)
 * └──────────────────────────────────────┴───────────┴───────────┘
 *
 * Two entries carry a decision worth restating:
 *
 *  • "Publish action required" is SHARED, not screening-only. A screener who
 *    has just rejected a photo should be able to ask for a replacement in
 *    the same breath; routing that through a concierge would add a handoff
 *    and latency for no control benefit.
 *
 *  • Recording an OUTCOME is not a screening act. It records what the
 *    mission decided, not what we judged — screening is our verdict on
 *    evidence BEFORE lodging. It stays behind FULL, unchanged.
 *
 * Only the three rows marked "gated" consult screening authority. Every
 * other row keeps exactly the gate it has today, in both flag states.
 */
export const VISA_SCREENING_ACTS = [
  "DOCUMENT_REVIEW",
  "DISCREPANCY_SET",
  "DISCREPANCY_CLEAR",
] as const;
export type VisaScreeningAct = (typeof VISA_SCREENING_ACTS)[number];
