// apps/backend/src/utils/invoiceHeaderDisplay.ts
// ── SHARED: everything below the 3-line header is byte-identical to
// apps/frontend/src/lib/invoiceHeaderDisplay.ts (invoiceHeaderDisplay.parity.test.ts).
//
// What an invoice's header shows in its BALANCE DUE and DUE DATE boxes, by
// status. Used by the staff invoice page (InvoicePreview), its side panel,
// the admin invoice list's Due date column, and the invoice PDF (staff,
// workspace-customer and consumer downloads) — one rule, so they can't drift.
//
// Display only: the stored amounts, status and the invoice TOTAL are never
// touched. The total still prints in full everywhere.
//
//   PAID       BALANCE DUE "Paid"       DUE DATE "NA"
//   CANCELLED  BALANCE DUE "Cancelled"  DUE DATE "NA"
//   anything else (DRAFT, SENT, PAYMENT_DECLARED)
//              BALANCE DUE = grandTotal  DUE DATE = the invoice's due date
//
// PAYMENT_DECLARED stays a balance: it is the customer's unconfirmed claim,
// not finance-confirmed receipt (see models/Invoice.ts). Invoices record no
// partial payments, and issued credit notes are not netted against the
// balance anywhere today, so the balance is the full grandTotal.

export interface InvoiceHeaderDisplay {
  /** Words shown in place of the balance-due amount, or null to show `balanceDueAmount`. */
  balanceDueText: string | null;
  balanceDueAmount: number;
  /** Words shown in place of the due date, or null to show the invoice's due date as before. */
  dueDateText: string | null;
}

export function invoiceHeaderDisplay(invoice: {
  status?: string | null;
  grandTotal?: number | null;
}): InvoiceHeaderDisplay {
  const balanceDueAmount = Number(invoice.grandTotal ?? 0) || 0;
  if (invoice.status === "PAID") {
    return { balanceDueText: "Paid", balanceDueAmount, dueDateText: "NA" };
  }
  if (invoice.status === "CANCELLED") {
    return { balanceDueText: "Cancelled", balanceDueAmount, dueDateText: "NA" };
  }
  return { balanceDueText: null, balanceDueAmount, dueDateText: null };
}
