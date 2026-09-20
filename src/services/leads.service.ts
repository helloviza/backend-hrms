// apps/backend/src/services/leads.service.ts
//
// Headless lead creation — the tail of POST /api/leads (routes/leads.ts),
// extracted so that the route and PlumConnect's lead adapter create leads
// through ONE function and both get the company anchor and the
// lead.created automation. PlumConnect Slice 3a;
// docs/plumconnect/lead-automation-invocation.md (decision (iii));
// docs/plumconnect/INTEGRATION_AUDIT.md §1c.
//
// What lives here is exactly what the route did after it had resolved its
// caller-specific inputs (permission, owner scope, owner label, creator id):
//   1. resolve-or-create the shared CRMCompany for a company-type lead
//   2. Lead.create({ ...body, assignedTo, assignedToName, companyId, createdBy })
//   3. the "note" activity, when the body carried notes
//   4. triggerTaskAutomation("lead.created", …) — started synchronously,
//      NOT awaited, never allowed to reject
//
// The input is deliberately PERMISSIVE: `body` is spread into Lead.create
// exactly as the route has always done. Tightening that to an allow-list is
// separate work, not this extraction.
//
// `automation` is a completion handle. The route ignores it (no new latency,
// no new failure mode — byte-for-byte what it did with `.catch(() => {})`);
// tests await it instead of sleeping for the Task row.

import mongoose from "mongoose";
import Lead, { type LeadDoc } from "../models/Lead.js";
import LeadActivity, { type ActivityType } from "../models/LeadActivity.js";
import type Task from "../models/Task.js";
import { resolveOrCreateCompany } from "../utils/crmCompany.js";
import { triggerTaskAutomation } from "./taskAutomation.js";
import { SYSTEM_WORKSPACE_ID } from "../config/defaultTaskAutomations.js";

type AnyObj = Record<string, any>;

export interface CreateLeadInput {
  /** The request body (or adapter-built equivalent). Spread into Lead.create verbatim. */
  body: AnyObj;
  /** Already resolved by the caller: the owner (scope-checked) and their label. */
  assignedTo: mongoose.Types.ObjectId | undefined;
  assignedToName: string;
  /** The creating user, when there is one (an adapter may pass a system user). */
  createdBy: mongoose.Types.ObjectId | undefined;
  /** Who to credit on the "note" activity when body.notes is set. */
  noteAuthorName: string;
}

export interface CreateLeadResult {
  lead: LeadDoc;
  /**
   * Settles when the lead.created automation has finished — the Task it
   * created, or null (no automation row, dedup, or a swallowed failure).
   * Never rejects. Callers may ignore it; tests await it.
   */
  automation: Promise<InstanceType<typeof Task> | null>;
}

export async function createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
  const { body, assignedTo, assignedToName, createdBy, noteAuthorName } = input;

  // Anchor on a shared company (resolve-or-create) for company-type leads with
  // a non-blank name. companyId is set server-side, never trusted from the body.
  const leadType = body.type === "individual" ? "individual" : "company";
  let companyId: mongoose.Types.ObjectId | null = null;
  if (leadType === "company" && body.companyName && String(body.companyName).trim()) {
    const co = await resolveOrCreateCompany(
      {
        name: body.companyName,
        industry: body.industry,
        companySize: body.companySize,
        location: body.location,
        website: body.website,
        gstin: body.gstin,
      },
      createdBy
    );
    companyId = co?._id ?? null;
  }

  const lead = await Lead.create({
    ...body,
    assignedTo,
    assignedToName,
    companyId,
    createdBy,
  });

  if (body.notes) {
    await LeadActivity.create({
      leadId: lead._id,
      type: "note" as ActivityType,
      note: String(body.notes),
      createdBy: lead.createdBy,
      createdByName: noteAuthorName,
    });
  }

  // Task automation hook — fire-and-forget, never breaks lead creation. The
  // promise is created HERE, synchronously, and handed back; the route's old
  // `.catch(() => {})` is the handle's own swallow.
  const automation = triggerTaskAutomation("lead.created", {
    workspaceId: SYSTEM_WORKSPACE_ID,
    entityType: "LEAD",
    entityId: lead._id as mongoose.Types.ObjectId,
    entityRef: lead.leadCode,
    ownerId: lead.assignedTo,
    variables: {
      leadName: lead.contactName || lead.companyName || "Lead",
      ownerName: lead.assignedToName || "",
    },
  }).catch(() => null);

  return { lead, automation };
}
