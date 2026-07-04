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
  // Phase 5 — full itinerary submit: the assembled items + worst-of rollup + total.
  itineraryId?: string;
  items?: Array<{ kind: string; payload: any; policy?: { status?: string } | null; priceINR?: number }>;
  policySummary?: string | null;
  totalPriceINR?: number;
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

// Phase 5 — render one assembled itinerary item (flight leg or hotel) with its
// price + policy flag.
function itineraryItemLine(it: any): string {
  if (!it) return "";
  const price = it.priceINR ? ` · ₹${Number(it.priceINR).toLocaleString("en-IN")}` : "";
  const pol = it?.policy?.status ? ` · <em>${it.policy.status}</em>` : "";
  if (it.kind === "HOTEL") {
    const h = it.payload || {};
    const name = h.HotelName || h.name || "—";
    const addr = h.Address ? ` · ${h.Address}` : "";
    return `<li><strong>Hotel:</strong> ${name}${addr}${price}${pol}</li>`;
  }
  const label = it.kind === "FLIGHT_INBOUND" ? "Return" : "Outbound";
  const f = it.payload || {};
  const route = `${f.origin?.code || f.origin || "?"} → ${f.destination?.code || f.destination || "?"}`;
  const airline = f.airline?.name || f.airline || "";
  const no = f.flightNo || "";
  return `<li><strong>${label}:</strong> ${airline} ${no} · ${route}${price}${pol}</li>`;
}

/**
 * renderTripSummaryHtml — compact HTML block summarising a trip bundle for the
 * booker email. Returns "" when no bundle is present (so the existing
 * single-flight email is unchanged for backward-compatible calls).
 */
export function renderTripSummaryHtml(tb?: TripBundle | null): string {
  if (!tb) return "";

  // Phase 5 — full itinerary submit: render the assembled items + total + rollup.
  if (Array.isArray(tb.items) && tb.items.length > 0) {
    const rows = tb.items.map(itineraryItemLine).filter(Boolean).join("");
    const total = tb.totalPriceINR
      ? `<p><strong>Total:</strong> ₹${Number(tb.totalPriceINR).toLocaleString("en-IN")}</p>`
      : "";
    const policy = tb.policySummary ? `<p><strong>Policy:</strong> ${tb.policySummary}</p>` : "";
    const summary = tb.conversationSummary
      ? `<p><strong>Summary:</strong> ${tb.conversationSummary}</p>`
      : "";
    return `<h4>Trip summary</h4>${rows ? `<ul>${rows}</ul>` : ""}${total}${policy}${summary}`;
  }

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
