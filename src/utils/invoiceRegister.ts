// apps/backend/src/utils/invoiceRegister.ts
//
// GST columns for the invoice register export (GET /api/admin/invoices/export).
// Everything comes from STORED invoice fields — never from the PDF layout — so
// a SEPARATE, COMBINED or ALL_INCLUSIVE invoice of the same bookings gives the
// same figures; only the "Invoice Layout" column differs.
//
// Taxable value: each stored line carrying GST (lineItems[].igst > 0 — the
// line's total GST, whatever the split) contributes amount − GST, i.e. the fee
// ex-GST. Lines with no GST (the pass-through cost) are the Non-taxable /
// Pass-through amount. So Taxable + Pass-through = the stored subtotal and
// Taxable + Pass-through + total GST = the grand total.

const paise = (n: unknown) => Math.round((Number(n) || 0) * 100);
const rupees = (p: number) => p / 100;

export interface InvoiceTaxBreakdown {
  taxableValue: number;
  passThrough: number;
}

export function invoiceTaxBreakdown(inv: any): InvoiceTaxBreakdown {
  let taxable = 0;
  let pass = 0;
  for (const li of Array.isArray(inv?.lineItems) ? inv.lineItems : []) {
    const amount = paise(li?.amount);
    const gst = paise(li?.igst);
    if (gst > 0) taxable += amount - gst;
    else pass += amount;
  }
  return { taxableValue: rupees(taxable), passThrough: rupees(pass) };
}

export const LAYOUT_EXPORT_LABEL: Record<string, string> = {
  SEPARATE: "Separate",
  COMBINED: "Combined",
  ALL_INCLUSIVE: "All-inclusive",
};

/** Appended after the original register columns (those stay unchanged). */
export const REGISTER_GST_COLUMNS = [
  "Taxable Value",
  "Non-taxable / Pass-through Amount",
  "CGST",
  "SGST",
  "UTGST",
  "IGST",
  "Supply Type",
  "Place of Supply",
  "Client GSTIN (or Unregistered)",
  "Invoice Layout",
];

export function registerGstCells(inv: any): (string | number)[] {
  const { taxableValue, passThrough } = invoiceTaxBreakdown(inv);
  const gstin = String(inv?.clientDetails?.gstin ?? "").trim();
  return [
    taxableValue,
    passThrough,
    inv?.cgstAmount ?? 0,
    inv?.sgstAmount ?? 0,
    inv?.utgstAmount ?? 0,
    inv?.igstAmount ?? 0,
    inv?.supplyType ?? "",
    inv?.placeOfSupply ?? "",
    gstin || "Unregistered",
    // Unset on invoices from before the layout was stored, and on bulk/auto ones.
    LAYOUT_EXPORT_LABEL[inv?.invoiceLayout] ?? "Not recorded",
  ];
}
