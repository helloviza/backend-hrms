// apps/backend/src/services/arrivalEscalation.ts
//
// Phase 4 (Arrive) Step 4 — HELP escalation. Raises a CONCIERGE_ARRIVAL
// SBTRequest for the assigned booker and emails them (ARRIVAL HELP + 15-min
// SLA). Idempotent: one OPEN escalation per session. FAIL TO A HUMAN — if the
// request can't be created, the traveler still receives the booker's contact
// details (never silence).

import SBTRequest from "../models/SBTRequest.js";
import { sendMail } from "../utils/mailer.js";
import { evaluateSla } from "../utils/plutoSlaEvaluator.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { arriveMetric } from "../utils/plutoMetricsBuilder.js";

/** Human-readable booker contact for the fail-to-a-human fallback. */
function bookerContactLine(session: any): string {
  const who = session?.bookerName || "your booker";
  const parts: string[] = [];
  if (session?.bookerEmail) parts.push(session.bookerEmail);
  if (session?.bookerPhone) parts.push(session.bookerPhone);
  if (parts.length) {
    return `I couldn't auto-alert your booker, but here are ${who}'s details: ${parts.join(", ")}. Please reach out directly.`;
  }
  return `I couldn't reach your booker automatically. Please try again shortly or contact your travel desk.`;
}

/**
 * Escalate a traveler HELP request to their booker. Returns the traveler-facing
 * reply text. Never throws.
 */
export async function escalateToBooker(session: any): Promise<string> {
  const workspaceId = String(session?.workspaceId || "");
  const city = session?.destinationCity || "their destination";
  const bookerName = session?.bookerName || "your booker";

  try {
    // Idempotency: one open CONCIERGE_ARRIVAL escalation per session.
    const existing = await SBTRequest.findOne({
      source: "CONCIERGE_ARRIVAL",
      status: "PENDING",
      conversationId: String(session._id),
    })
      .select("_id")
      .lean();
    if (existing) {
      return `Your booker ${bookerName} has already been alerted — they're on it and will call you shortly.`;
    }

    // No assigned booker → can't create an assigned request; fail to a human.
    if (!session?.bookerUserId) {
      void emitMetric(arriveMetric("pluto.arrive.escalation_failed", { workspaceId, reason: "no_booker" }, "error"));
      return bookerContactLine(session);
    }

    const sla = evaluateSla("business");
    await SBTRequest.create({
      workspaceId: session.workspaceId,
      requesterId: session.travelerUserId || session.bookerUserId,
      assignedBookerId: session.bookerUserId,
      type: "flight",
      searchParams: {},
      selectedOption: {},
      status: "PENDING",
      source: "CONCIERGE_ARRIVAL",
      conversationId: String(session._id),
      contactDetails: { phone: session.phone },
      tripBundle: {
        conversationSummary: `Traveler requested help on arrival in ${city}`,
        lockedDecisions: {
          arrivalSessionId: String(session._id),
          destinationIata: session.destinationIata,
          destinationCity: session.destinationCity,
          phone: session.phone,
          slaPriority: sla.priority,
          slaTarget: sla.targetSLA,
        },
      },
    });

    // Booker email — best-effort; a failed send must NOT undo the created alert.
    if (session.bookerEmail) {
      try {
        await sendMail({
          to: session.bookerEmail,
          subject: `ARRIVAL HELP — traveler in ${city} needs you (SLA ${sla.targetSLA})`,
          kind: "REQUESTS",
          html: `<p>A traveler who just landed in <b>${city}</b> requested help via WhatsApp.</p>
                 <p>Contact number: <b>${session.phone}</b></p>
                 <p>Please call them within <b>${sla.targetSLA}</b> (priority ${sla.priority}).</p>`,
        });
      } catch {
        // Alert row already exists; email failure alone is not an escalation failure.
      }
    }

    void emitMetric(arriveMetric("pluto.arrive.escalated", { workspaceId }));
    return `Your booker ${bookerName} has been alerted and will call you within ${sla.targetSLA}.`;
  } catch (e: any) {
    void emitMetric(arriveMetric("pluto.arrive.escalation_failed", { workspaceId, reason: e?.message }, "error"));
    return bookerContactLine(session);
  }
}
