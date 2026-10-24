// apps/backend/src/utils/ncLead.ts
//
// "Not Contactable" leads: a manual booking saved at one of these Status +
// Sub Status pairs records a lead nobody could reach — nothing is booked, so
// create and update ask only for the basics (type, client, booking date,
// travel date, status, sub status, a passenger name). Supplier, given by,
// hotel city / check-out and every other detail are optional; prices may be
// blank (stored as 0). The booking form applies the same rule (frontend
// pages/admin/ncLeadRule.ts; the parity test keeps the two lists equal).
//
// Every other Status / Sub Status keeps today's rules, and a booking moving
// OFF an NC sub status is checked against the full create rules — not Option B
// (routes/manualBookings.ts), since an NC lead was allowed to skip them.

export const NC_LEAD_SUB_STATUSES: Record<string, readonly string[]> = {
  PENDING: ["Lead Not Contactable", "NC Leads - Email Sent", "NC Leads - Multiple Follow-up Done"],
  CANCELLED: ["Lead Not Contactable"],
};

export function isNcLead(status: any, subStatus: any): boolean {
  const list = NC_LEAD_SUB_STATUSES[String(status || "").toUpperCase()];
  return !!list && list.includes(String(subStatus || ""));
}

/** The basics an NC lead still needs (status and sub status are what make it one). */
export function ncLeadRequiredErrors(b: any): string[] {
  const errors: string[] = [];
  if (!String(b?.type ?? "").trim()) errors.push("Booking Type is required");
  if (!String(b?.workspaceId?._id ?? b?.workspaceId ?? "").trim()) errors.push("Client is required");
  if (!b?.bookingDate) errors.push("Booking Date is required");
  if (!b?.travelDate) errors.push("Travel Date is required");
  const first = Array.isArray(b?.passengers) ? b.passengers[0] : null;
  if (!String(first?.name ?? "").trim()) errors.push("Passenger name is required");
  return errors;
}
