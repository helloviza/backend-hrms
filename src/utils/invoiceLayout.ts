// apps/backend/src/utils/invoiceLayout.ts
//
// Invoice LAYOUT = how the PDF presents an invoice. It never changes amounts.
//
//   SEPARATE       each booking itemised (COST + Transaction Fees rows)
//   COMBINED       one COST + Transaction Fees row per category
//   ALL_INCLUSIVE  one row per booking at its all-in price; tax shown only as
//                  one line of small print under the table. Registered and
//                  Unregistered (B2C) clients; not a client whose status is
//                  not set. A registered client's Bill To keeps its GSTIN and
//                  the small print states the taxable value and each tax.
//
// ALL_INCLUSIVE is presentation only: the invoice is generated with exactly
// the SEPARATE line items, so subtotal / GST / grand total, the CGST/SGST/IGST
// split, the stored lineItems (GST filing reads them) and numbering are
// identical to a SEPARATE invoice. The stored `invoiceLayout` is what makes a
// re-download render the same way it was generated.

import { invoiceTaxBreakdown } from "./invoiceRegister.js";

export const INVOICE_LAYOUTS = ["SEPARATE", "COMBINED", "ALL_INCLUSIVE"] as const;
export type InvoiceLayout = (typeof INVOICE_LAYOUTS)[number];

export function parseInvoiceLayout(v: unknown): InvoiceLayout | null {
  const s = String(v ?? "").trim().toUpperCase();
  return (INVOICE_LAYOUTS as readonly string[]).includes(s) ? (s as InvoiceLayout) : null;
}

export const ALL_INCLUSIVE_NOT_ALLOWED = "ALL_INCLUSIVE_NOT_ALLOWED";

/** null = allowed. A client whose GST status is REGISTERED or UNREGISTERED
 *  may get an all-inclusive invoice; one whose status is not set may not —
 *  the small print depends on which it is (allInclusiveTaxNote). A registered
 *  client still gets the taxable value and each tax stated, for input credit. */
export function allInclusiveRefusal(gstStatus: unknown): string | null {
  const s = String(gstStatus ?? "").toUpperCase();
  return s === "REGISTERED" || s === "UNREGISTERED"
    ? null
    : "The All-inclusive layout needs the client's GST status set to Registered or Unregistered (B2C). " +
      "Use Separate or Combined, or set the client's GST status in Business Profiles.";
}

/**
 * A client's "Default invoice layout" (Business Profiles) as a save would
 * leave it. `sent` = the body's value (undefined = not in this save; "" =
 * Separate). `gstStatus` = the status the client will have after the save,
 * `current` = the stored default.
 *   - an unknown value or All-inclusive for a non-B2C client is refused (400);
 *   - a save that moves a client off Unregistered drops a stored
 *     All-inclusive default back to Separate (Generate would refuse it);
 *   - otherwise `value` is what to write, or undefined to leave it alone.
 */
export function resolveDefaultInvoiceLayout(
  sent: unknown,
  gstStatus: unknown,
  current?: unknown,
): { value?: InvoiceLayout; refused?: { error: string; message: string } } {
  if (sent === undefined || sent === null) {
    return current === "ALL_INCLUSIVE" && allInclusiveRefusal(gstStatus)
      ? { value: "SEPARATE" }
      : {};
  }
  const value = sent === "" ? "SEPARATE" : parseInvoiceLayout(sent);
  if (!value) {
    return { refused: { error: "INVOICE_LAYOUT_INVALID", message: "Default invoice layout must be Separate, Combined or All-inclusive." } };
  }
  if (value === "ALL_INCLUSIVE") {
    const refusal = allInclusiveRefusal(gstStatus);
    if (refusal) return { refused: { error: ALL_INCLUSIVE_NOT_ALLOWED, message: refusal } };
  }
  return { value };
}

const SERVICE_NAMES: Record<string, string> = {
  FLIGHT: "Flight",
  DUMMY_FLIGHT: "Flight",
  FLIGHT_RESCHEDULE: "Flight rescheduling",
  HOTEL: "Hotel",
  DUMMY_HOTEL: "Hotel",
  TRAIN: "Train",
  VISA: "Visa",
  US_VISA_EARLY_APPOINTMENT_FEE: "US visa appointment",
  TRANSFER: "Transfer",
  CAB: "Cab",
  FOREX: "Forex",
  ESIM: "eSIM",
  HOLIDAYS: "Holiday",
  EVENTS: "Event",
  INSURANCE: "Insurance",
};

/** "Flight services", "Hotel services", … ("Travel services" otherwise). */
export function allInclusiveDescription(type: unknown): string {
  return `${SERVICE_NAMES[String(type ?? "").toUpperCase()] ?? "Travel"} services`;
}

export interface AllInclusiveRow {
  bookingRef: string;
  description: string;
  subDescription: string;
  amount: number;
}

function fmtDateDMY(d: unknown): string {
  if (!d) return "";
  const dt = new Date(d as any);
  if (isNaN(dt.getTime())) return "";
  return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
}

/**
 * One row per booking, from the invoice's STORED (Separate) line items, in
 * their order. Amount = Σ of the booking's line amounts (cost + fee + GST on
 * the fee), so Σ rows === Σ lineItems.amount — the invoice total.
 *
 * Details: the booking's own Separate sub-description (passengers, route,
 * flight no, travel date). Group-booking item rows carry "Qty × Rate" there
 * instead, so they fall back to passengers + travel date.
 */
export function buildAllInclusiveRows(lineItems: any[]): AllInclusiveRow[] {
  const rows: (AllInclusiveRow & { _details?: string; _fallback: string })[] = [];
  const byRef = new Map<string, (typeof rows)[number]>();
  (lineItems || []).forEach((li: any, i: number) => {
    const key = li?.bookingRef ? String(li.bookingRef) : `#${i}`;
    let row = byRef.get(key);
    if (!row) {
      const pax = (li?.passengerNames || []).filter(Boolean).join(", ");
      const date = fmtDateDMY(li?.travelDate);
      row = {
        bookingRef: li?.bookingRef ? String(li.bookingRef) : "",
        description: allInclusiveDescription(li?.type),
        subDescription: "",
        amount: 0,
        _fallback: [pax, date ? `Travel Date: ${date}` : ""].filter(Boolean).join(" || "),
      };
      byRef.set(key, row);
      rows.push(row);
    }
    row.amount += Number(li?.amount ?? 0);
    const sub = String(li?.subDescription ?? "");
    if (!row._details && sub && !/^Qty\s/.test(sub)) row._details = sub;
  });
  return rows.map(({ _details, _fallback, ...r }) => ({
    ...r,
    amount: parseFloat(r.amount.toFixed(2)),
    subDescription: _details || _fallback,
  }));
}

/** The tax actually charged, from the stored invoice totals (whole invoice).
 *  rate = the % printed beside each tax: the same fixed 18% (9% + 9% when
 *  split) the itemised layout prints in its column heads and totals. */
export function allInclusiveGstParts(invoice: any): { parts: { label: string; rate: number; amount: number }[]; total: number } {
  const total = Number(invoice?.totalGST ?? 0);
  const t = String(invoice?.supplyType ?? "");
  if (t === "CGST_SGST") {
    return { parts: [{ label: "CGST", rate: 9, amount: Number(invoice.cgstAmount ?? total / 2) }, { label: "SGST", rate: 9, amount: Number(invoice.sgstAmount ?? total / 2) }], total };
  }
  if (t === "CGST_UTGST") {
    return { parts: [{ label: "CGST", rate: 9, amount: Number(invoice.cgstAmount ?? total / 2) }, { label: "UTGST", rate: 9, amount: Number(invoice.utgstAmount ?? total / 2) }], total };
  }
  return { parts: [{ label: "IGST", rate: 18, amount: Number(invoice?.igstAmount ?? total) }], total };
}

/**
 * The small print under an all-inclusive table, from STORED invoice fields so
 * a re-download always reads as issued. Which wording = whether the stored
 * Bill To carries a client GSTIN:
 *   with a GSTIN (registered client):
 *     "Amount inclusive of all taxes and service charges. Taxable value ₹X + CGST @9% ₹a + SGST @9% ₹b"
 *     (or "+ IGST @18% ₹c"); X = the register export's Taxable Value (GST-bearing
 *     lines ex-GST = the fee, summed per invoice — invoiceTaxBreakdown).
 *   without (Unregistered / B2C):
 *     "Amount inclusive of all taxes and service charges. GST included: CGST @9% ₹152.54 + SGST @9% ₹152.54 = ₹305.08"
 *     (or "GST included: IGST @18% ₹c")
 */
export function allInclusiveTaxNote(invoice: any, fmt: (n: number) => string): string {
  const { parts, total } = allInclusiveGstParts(invoice);
  const tax = (p: { label: string; rate: number; amount: number }) => `${p.label} @${p.rate}% ${fmt(p.amount)}`;
  if (String(invoice?.clientDetails?.gstin ?? "").trim()) {
    const { taxableValue } = invoiceTaxBreakdown(invoice);
    return `Amount inclusive of all taxes and service charges. Taxable value ${fmt(taxableValue)} + ${parts.map(tax).join(" + ")}`;
  }
  const breakdown = parts.length > 1
    ? `${parts.map(tax).join(" + ")} = ${fmt(total)}`
    : tax(parts[0]);
  return `Amount inclusive of all taxes and service charges. GST included: ${breakdown}`;
}
