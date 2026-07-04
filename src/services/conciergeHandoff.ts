// apps/backend/src/services/conciergeHandoff.ts
//
// Shared, pure rendering for the concierge trip-summary email section. Used by
// both /raise-request (single-flight + optional bundle) and the AI handoff sink.

export interface TripBundle {
  outboundFlight?: any;
  inboundFlight?: any;
  hotel?: any;
  policyStatus?: string | null;
  conversationSummary?: string | null;
  lockedDecisions?: any;
}

function legLine(label: string, f: any): string {
  if (!f) return "";
  const route = `${f.origin?.code || f.origin || "?"} → ${f.destination?.code || f.destination || "?"}`;
  const airline = f.airline?.name || f.airline || "";
  const no = f.flightNo || "";
  const fare = f.fare?.offered ?? f.fare?.published;
  return `<li><strong>${label}:</strong> ${airline} ${no} · ${route}${
    fare ? ` · ₹${Number(fare).toLocaleString("en-IN")}` : ""
  }</li>`;
}

/**
 * renderTripSummaryHtml — compact HTML block summarising a trip bundle for the
 * booker email. Returns "" when no bundle is present (so the existing
 * single-flight email is unchanged for backward-compatible calls).
 */
export function renderTripSummaryHtml(tb?: TripBundle | null): string {
  if (!tb) return "";
  const hasAny =
    tb.outboundFlight || tb.inboundFlight || tb.hotel || tb.policyStatus || tb.conversationSummary;
  if (!hasAny) return "";

  const items: string[] = [];
  items.push(legLine("Outbound", tb.outboundFlight));
  if (tb.inboundFlight) items.push(legLine("Return", tb.inboundFlight));
  if (tb.hotel) {
    items.push(`<li><strong>Hotel:</strong> ${tb.hotel.name || tb.hotel.HotelName || "—"}</li>`);
  }
  if (tb.policyStatus) {
    items.push(`<li><strong>Policy:</strong> ${tb.policyStatus}</li>`);
  }

  const list = items.filter(Boolean).join("");
  const summary = tb.conversationSummary
    ? `<p><strong>Summary:</strong> ${tb.conversationSummary}</p>`
    : "";
  return `<h4>Trip summary</h4>${list ? `<ul>${list}</ul>` : ""}${summary}`;
}
