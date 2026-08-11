// apps/backend/src/config/visaScreening.ts
//
// Screening authority — the capability, the enforcement switch, and the
// authority matrix it enforces. Step 1 of
// infra/audit/visa-screening-authority-model-2026-08-12.md.
//
// ── WHY THIS IS OFF BY DEFAULT ────────────────────────────────────────
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
// which is the fastest way to teach people to ignore a log. The flag gives
// the one thing that actually matters — a single reversible switch whose
// two states are both well-defined, each covered by its own tests.
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

/**
 * Whether screening authority is ENFORCED on the screening-act routes.
 *
 * Read live from process.env on every call rather than captured once at
 * module load. That is deliberate: it keeps the switch flippable without a
 * rebuild, and it lets each test pin the value it needs — the OFF path
 * (today's behaviour, which must not regress) and the ON path (the future
 * behaviour) are both real code paths that need real coverage, and a
 * boot-time capture would force one of them to be tested by mocking.
 */
export function isVisaScreeningEnforced(): boolean {
  return String(process.env.VISA_SCREENING_ENFORCED || "").trim().toLowerCase() === "true";
}

/**
 * THE AUTHORITY MATRIX — enforced only while isVisaScreeningEnforced() is
 * true. Recorded here in one place because the split is a product decision,
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
