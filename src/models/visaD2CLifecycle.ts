// apps/backend/src/models/visaD2CLifecycle.ts
//
// THE D2C TRACKING VOCABULARY — Status, Stage, Payment status.
//
// One definition, several consumers (VisaApplication now; the Master Sheet
// and the ops tab next), for the same reason models/visaCaseSource.ts
// gives: an enum that has to agree across collections will stop agreeing
// the moment it is written down twice.
//
// ══════════════════════════════════════════════════════════════════════
// THESE ARE NOT A SECOND COPY OF VisaApplication.status.
// ══════════════════════════════════════════════════════════════════════
// `status` is the OPS PIPELINE state — draft / submitted /
// docs_under_review / lodged / closed. It is what a concierge works, what
// the queue bands and sorts on, and it is shared with B2B.
//
// The three below are the CONSUMER-FUNNEL view of the same case: what a
// commercial reader wants on one sheet ("how many are in progress, how
// many dropped at payment"). They are deliberately coarser than `status`
// and they are D2C-only — null on every B2B row.
//
// Keeping them separate is what stops each from corrupting the other. If
// "Payment Failed" were a VisaApplication.status, every ops surface's
// status enum, transition table and band logic would have to learn about
// payments; if the funnel read `status` directly, a concierge moving a case
// to docs_under_review would silently rewrite a commercial funnel report.
//
// ── WHY THE TICKET IS CREATED AT status "submitted" ──────────────────
// Discovered in Stage 2 and it is load-bearing: `draft` is excluded from
// the ops queue by VISA_OPS_HIDDEN_STATUSES *and* has no ops-side
// transitions at all (PATCH /status answers `allowed: []`). A D2C ticket
// created at "draft" would therefore exist, be invisible to the queue, and
// be unworkable by anyone — the customer's own submit route is the only
// thing that can move a draft, and D2C has no such route.
//
// So "In-Progress / Doc Submitted" maps onto status "submitted", which is
// the first genuinely workable state.

/**
 * ── VISA_FEES_PAID (Milestone 2, Stage 2) ────────────────────────────
 * APPENDED, never inserted mid-list. The three original values keep their
 * exact positions, so nothing that happens to read this array by index —
 * a filter chip order, a report's column order — reorders under it.
 *
 * It is a STATUS and not a stage because the stage slot is already spoken
 * for: a captured payment sets stage PAYMENT_DONE ("how far through the
 * funnel"), and the status answers the different question the Master
 * Sheet's Status column asks ("what commercial state is this case in").
 * A paid case is still in progress operationally — nobody has a visa yet —
 * but "In-Progress" on a sheet that a commercial reader scans for money
 * collected is the wrong answer, and COMPLETED would be a lie.
 *
 * NOT a terminal value: the case still moves to COMPLETED (or DROPPED) on
 * its ops outcome. This says only that the fee is in.
 */
export const D2C_TRACKING_STATUSES = [
  "IN_PROGRESS",
  "COMPLETED",
  "DROPPED",
  "VISA_FEES_PAID",
] as const;
export type D2CTrackingStatus = (typeof D2C_TRACKING_STATUSES)[number];

/**
 * Where the consumer has actually got to.
 *
 * DOC_SUBMISSION_IN_PROGRESS is reachable only on a Master Sheet row (a
 * person who started and has not submitted). An APPLICATION never carries
 * it — the application row does not exist until submit — which is exactly
 * the Scenario-1 distinction the Master Sheet exists to make visible.
 *
 * PAYMENT_DONE and PAYMENT_FAILED became writable in Milestone 2 Stage 2 —
 * routes/razorpay.webhook.ts sets them from a verified payment.captured /
 * payment.failed, on the application AND (mirrored) on the lead row.
 *
 * TODO(milestone-3): PAYMENT_DROPPED is still written by nothing, and
 * deliberately so — "dropped" is the ABSENCE of an event. Razorpay never
 * sends a webhook for a person who opened the checkout and closed the tab,
 * so no webhook branch can ever set it. It needs a timeout sweep over
 * applications left at PENDING past a cutoff, which is Milestone 3's job.
 */
export const D2C_STAGES = [
  "DOC_SUBMISSION_IN_PROGRESS",
  "DOC_SUBMITTED",
  "PAYMENT_FAILED",
  "PAYMENT_DROPPED",
  "PAYMENT_DONE",
] as const;
export type D2CStage = (typeof D2C_STAGES)[number];

/**
 * PENDING is the only value Milestone 1 can produce, and it is the honest
 * one: the case is real, the money is not collected, and nothing pretends
 * otherwise.
 *
 * FAILED / PAID became writable from the payment webhook in Milestone 2
 * Stage 2. Note there is deliberately no "NOT_APPLICABLE" — every D2C case
 * owes money; a corridor we cannot quote does not reach this flow.
 *
 * PAID is the IDEMPOTENCY KEY of the whole payment path: the webhook's
 * first act on a captured payment is to check whether this is already PAID
 * and do nothing if so. Anything that sets it outside that handler would
 * silently disarm a replayed webhook's only in-process guard.
 */
export const D2C_PAYMENT_STATUSES = ["PENDING", "FAILED", "PAID"] as const;
export type D2CPaymentStatus = (typeof D2C_PAYMENT_STATUSES)[number];

/* ── Display copy ────────────────────────────────────────────────────
 * The ops console renders these; the STORED value stays the enum. Same
 * split the source tab labels use ("B2B" stored, "Plumbox" shown) — a
 * display rename must never reach the database.
 * ──────────────────────────────────────────────────────────────────── */

export const D2C_TRACKING_STATUS_LABELS: Record<D2CTrackingStatus, string> = {
  IN_PROGRESS: "In-Progress",
  COMPLETED: "Completed",
  DROPPED: "Dropped",
  VISA_FEES_PAID: "Visa Fees Paid",
};

export const D2C_STAGE_LABELS: Record<D2CStage, string> = {
  DOC_SUBMISSION_IN_PROGRESS: "Doc Submission in Progress",
  DOC_SUBMITTED: "Doc Submitted",
  PAYMENT_FAILED: "Payment Failed",
  PAYMENT_DROPPED: "Payment Dropped",
  PAYMENT_DONE: "Payment Done",
};

export const D2C_PAYMENT_STATUS_LABELS: Record<D2CPaymentStatus, string> = {
  PENDING: "Payment Pending",
  FAILED: "Payment Failed",
  PAID: "Paid",
};

/**
 * The lifecycle a freshly-submitted D2C ticket starts in.
 *
 * Exported as one object rather than three constants so a create path
 * cannot set two of the three and leave the case in a state no reader
 * expects — the whole triple moves together or not at all.
 */
export const D2C_INITIAL_LIFECYCLE = {
  d2cStatus: "IN_PROGRESS" as D2CTrackingStatus,
  d2cStage: "DOC_SUBMITTED" as D2CStage,
  d2cPaymentStatus: "PENDING" as D2CPaymentStatus,
};
