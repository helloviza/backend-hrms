// Shared client-detail helpers for invoice generation.
//
// Extracted verbatim from routes/invoices.ts so both the HTTP routes
// (gst-preview, enrichClientDetails) and the invoice-generation service can
// reuse them without a route↔service import cycle. Pure functions — no model
// or request access. Behavior is identical to the previous inline definitions.

/** Resolve a customer's GST state + country with the same fallback chain the
 *  invoice routes have always used. */
export function resolveCustomerState(cust: any): { state: string; country: string } {
  const state =
    cust?.gstRegisteredState ||
    cust?.address?.state ||
    cust?.shippingAddress?.state ||
    "";
  const country =
    cust?.address?.country ||
    cust?.shippingAddress?.country ||
    "India";
  return { state, country };
}

/** Join structured address parts into a single comma-separated billing string. */
export function buildAddressStr(o: {
  addressLine1?: string; addressLine2?: string;
  city?: string; state?: string; country?: string; pincode?: string;
}): string {
  return [o.addressLine1, o.addressLine2, o.city, o.state, o.country, o.pincode]
    .filter(Boolean).join(", ");
}
