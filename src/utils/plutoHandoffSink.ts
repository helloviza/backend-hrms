// apps/backend/src/utils/plutoHandoffSink.ts
//
// REAL delivery for an AI-driven handoff: creates a durable SBTRequest
// (source "CONCIERGE_AI") carrying the handoff payload in the tripBundle
// subdocument, and emails the assigned booker. Failures are returned (never
// thrown) so the caller can emit a metric and surface the failure to the user.

import type { PlutoHandoffPayload } from "../types/plutoHandoff.js";
import SBTRequest from "../models/SBTRequest.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import { sendMail } from "./mailer.js";
import { renderTripSummaryHtml } from "../services/conciergeHandoff.js";

export interface HandoffDeliveryContext {
  workspaceObjectId: any;
  requesterId: any;
  requesterEmail?: string;
  requesterName?: string;
  conversationId?: string;
}

export interface HandoffDeliveryResult {
  delivered: boolean;
  requestId?: string;
  error?: string;
}

export async function sendHandoffPayload(
  payload: PlutoHandoffPayload,
  ctx: HandoffDeliveryContext,
): Promise<HandoffDeliveryResult> {
  try {
    if (!ctx?.workspaceObjectId) return { delivered: false, error: "no_workspace" };

    const workspace = (await CustomerWorkspace.findById(ctx.workspaceObjectId).lean()) as any;
    if (!workspace) return { delivered: false, error: "no_workspace" };

    // Resolve booker: workspace defaultApproverEmails → User, else workspace leader.
    let assignedBookerId: any = null;
    const approverEmails: string[] = workspace.defaultApproverEmails || [];
    if (approverEmails.length > 0) {
      const approver = (await User.findOne({
        email: { $in: approverEmails.map((e: string) => e.toLowerCase()) },
      })
        .select("_id email")
        .lean()) as any;
      if (approver) assignedBookerId = approver._id;
    }
    if (!assignedBookerId) {
      const leader = (await User.findOne({
        customerId: workspace._id,
        roles: { $in: ["WORKSPACE_LEADER"] },
        _id: { $ne: ctx.requesterId },
      })
        .select("_id email")
        .lean()) as any;
      if (leader) assignedBookerId = leader._id;
    }
    if (!assignedBookerId) return { delivered: false, error: "no_booker" };

    const tripBundle = {
      policyStatus: payload.lockedDecisions?.policyStatus || null,
      conversationSummary: payload.summary,
      lockedDecisions: payload.lockedDecisions || null,
    };

    const request = (await SBTRequest.create({
      workspaceId: ctx.workspaceObjectId,
      customerId: workspace._id,
      requesterId: ctx.requesterId,
      assignedBookerId,
      type: "flight",
      source: "CONCIERGE_AI",
      conversationId: ctx.conversationId || null,
      // searchParams / selectedOption are required by the schema; the AI handoff
      // carries no specific selected flight, so these are minimal + synthetic.
      searchParams: { source: "CONCIERGE_AI" },
      selectedOption: { handoff: true, priority: payload.priority },
      status: "PENDING",
      tripBundle,
      contactDetails: { email: ctx.requesterEmail },
    })) as any;

    // Email the booker (best-effort; a mail failure does not undo the request).
    const booker = (await User.findOne({
      _id: assignedBookerId,
      workspaceId: ctx.workspaceObjectId,
    })
      .select("email")
      .lean()) as any;

    if (booker?.email) {
      const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
      await sendMail({
        to: booker.email,
        subject: `[${payload.priority}] Concierge AI handoff — ${payload.destination || "trip"} (SLA ${payload.targetSLA})`,
        kind: "REQUESTS",
        html: `
          <h3>AI Concierge Handoff</h3>
          <p><strong>From:</strong> ${ctx.requesterName || ctx.requesterEmail || "a traveller"}</p>
          <p><strong>Priority:</strong> ${payload.priority} · Target SLA ${payload.targetSLA} (${payload.slaReason})</p>
          ${renderTripSummaryHtml(tripBundle)}
          <p><a href="${frontendUrl}/sbt/inbox">View in Booking Inbox</a></p>
        `,
      }).catch((e: any) => console.warn("[PLUTO HANDOFF] email failed:", e?.message));
    }

    return { delivered: true, requestId: String(request._id) };
  } catch (err: any) {
    console.error("[PLUTO HANDOFF] delivery failed", { message: err?.message });
    return { delivered: false, error: err?.message || "delivery_failed" };
  }
}
