// utils/invoiceLifecycle.ts
//
// THE invoice status state machine. Every route that writes Invoice.status
// calls assertInvoiceTransition() before it writes — there is no other list
// of legal moves anywhere. (D2C invoicing, services/d2cInvoicing.ts, is the
// one deliberate exception: it creates its invoice already paid inside the
// Razorpay webhook and is out of this machine's scope.)
//
// The only allowed moves, and the single route each one belongs to:
//
//   DRAFT                        → SENT              PUT /:id/status, POST /bulk-mark-sent
//   SENT                         → PAYMENT_DECLARED  customer portal PUT /:id/declare-payment
//   SENT | PAYMENT_DECLARED      → PAID              PUT /:id/status, POST /bulk-mark-paid
//   PAID | PAYMENT_DECLARED      → SENT              POST /:id/revert-to-sent   (reason required)
//   SENT                         → DRAFT             POST /:id/revert-to-draft  (reason required)
//   DRAFT | SENT | PAYMENT_DECLARED → CANCELLED      POST /:id/cancel           (reason required)
//
// Anything else — PAID→CANCELLED, anything out of CANCELLED, DRAFT→PAID, a
// backward move through the forward-mark routes — is refused with a 400 whose
// message names the route that does own the move (or says there is none).
// See docs/audits/loyalty-points-audit.md §2/§5 for why: before this, staff
// could take a PAID invoice to CANCELLED with no credit note and no reason.

export const INVOICE_STATUSES = ["DRAFT", "SENT", "PAYMENT_DECLARED", "PAID", "CANCELLED"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export type InvoiceTransitionRoute =
  | "status"
  | "bulk-mark-sent"
  | "bulk-mark-paid"
  | "declare-payment"
  | "revert-to-sent"
  | "revert-to-draft"
  | "cancel";

const ROUTE_LABEL: Record<InvoiceTransitionRoute, string> = {
  status: "PUT /api/admin/invoices/:id/status",
  "bulk-mark-sent": "POST /api/admin/invoices/bulk-mark-sent",
  "bulk-mark-paid": "POST /api/admin/invoices/bulk-mark-paid",
  "declare-payment": "the customer portal's PUT /api/invoices/workspace/:id/declare-payment",
  "revert-to-sent": "POST /api/admin/invoices/:id/revert-to-sent",
  "revert-to-draft": "POST /api/admin/invoices/:id/revert-to-draft",
  cancel: "POST /api/admin/invoices/:id/cancel",
};

interface TransitionRule {
  from: readonly InvoiceStatus[];
  to: InvoiceStatus;
  routes: readonly InvoiceTransitionRoute[];
  reasonRequired: boolean;
}

const RULES: readonly TransitionRule[] = [
  { from: ["DRAFT"], to: "SENT", routes: ["status", "bulk-mark-sent"], reasonRequired: false },
  { from: ["SENT"], to: "PAYMENT_DECLARED", routes: ["declare-payment"], reasonRequired: false },
  { from: ["SENT", "PAYMENT_DECLARED"], to: "PAID", routes: ["status", "bulk-mark-paid"], reasonRequired: false },
  { from: ["PAID", "PAYMENT_DECLARED"], to: "SENT", routes: ["revert-to-sent"], reasonRequired: true },
  { from: ["SENT"], to: "DRAFT", routes: ["revert-to-draft"], reasonRequired: true },
  { from: ["DRAFT", "SENT", "PAYMENT_DECLARED"], to: "CANCELLED", routes: ["cancel"], reasonRequired: true },
];

export class InvoiceTransitionError extends Error {
  readonly httpStatus = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvoiceTransitionError";
  }
}

export function isInvoiceStatus(s: unknown): s is InvoiceStatus {
  return typeof s === "string" && (INVOICE_STATUSES as readonly string[]).includes(s);
}

function findRule(from: InvoiceStatus, to: InvoiceStatus): TransitionRule | undefined {
  return RULES.find((r) => r.to === to && r.from.includes(from));
}

/** The statuses `from` may legally move to, by any route. */
export function allowedInvoiceTransitions(from: InvoiceStatus): InvoiceStatus[] {
  return RULES.filter((r) => r.from.includes(from)).map((r) => r.to);
}

/**
 * Throws InvoiceTransitionError (httpStatus 400) unless `from → to` is a legal
 * move. With `via`, the move must also belong to that route; when the move
 * needs a reason, `reason` must be non-blank. Without `via` only legality is
 * checked.
 */
export function assertInvoiceTransition(
  from: string,
  to: string,
  opts: { via?: InvoiceTransitionRoute; reason?: string | null } = {},
): void {
  if (!isInvoiceStatus(to)) {
    throw new InvoiceTransitionError(`Unknown invoice status "${to}".`);
  }
  if (!isInvoiceStatus(from)) {
    throw new InvoiceTransitionError(`Invoice has an unknown status "${from}"; it cannot be moved.`);
  }
  if (from === to) {
    throw new InvoiceTransitionError(`Invoice is already ${to}.`);
  }

  const rule = findRule(from, to);
  if (!rule) {
    if (from === "CANCELLED") {
      throw new InvoiceTransitionError("A cancelled invoice is final; its status cannot change.");
    }
    if (from === "PAID" && to === "CANCELLED") {
      throw new InvoiceTransitionError(
        "A paid invoice cannot be cancelled. Raise a credit note instead, or revert it to SENT first (reason required).",
      );
    }
    if (from === "DRAFT" && to === "PAID") {
      throw new InvoiceTransitionError("Cannot mark a DRAFT invoice as PAID. Mark it as SENT first.");
    }
    const allowed = allowedInvoiceTransitions(from);
    throw new InvoiceTransitionError(
      `${from} → ${to} is not an allowed invoice transition.` +
        (allowed.length ? ` From ${from} the invoice can only move to ${allowed.join(", ")}.` : ""),
    );
  }

  if (opts.via && !rule.routes.includes(opts.via)) {
    throw new InvoiceTransitionError(
      `${from} → ${to} is not done here. Use ${ROUTE_LABEL[rule.routes[0]]}` +
        (rule.reasonRequired ? " (a reason is required)." : "."),
    );
  }

  if (opts.via && rule.reasonRequired && !String(opts.reason ?? "").trim()) {
    throw new InvoiceTransitionError(`A reason is required to move an invoice from ${from} to ${to}.`);
  }
}
