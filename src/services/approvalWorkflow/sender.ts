// apps/backend/src/services/approvalWorkflow/sender.ts
//
// S6 — email level A (docs/audits/request-workflow-audit.md §12.4): a
// workspace's approval emails go out from OUR address with the client's name
// as the display name ("StatusNeo Travel via Plumtrips <approvals@…>") and
// the client's reply-to. Display names work on any SMTP, Google included; the
// address itself never changes (levels B/C — the client's own domain or
// mailbox — are later).
//
// Read at SEND time (services/emailOutbox.ts calls customerSenderFor on every
// try), so a retry uses the current setting. Applies only to customer-facing
// events of a request raised under an approval workflow, while the workspace's
// workflow is in force. Everything else keeps today's From / Reply-To.
//
// Per-event on/off: eventEnabled — a client may switch off FYI events only;
// an event that carries a decision link cannot be switched off (the config
// validation refuses it, and this check ignores it anyway).
import mongoose from "mongoose";
import ApprovalRequest from "../../models/ApprovalRequest.js";
import { activeWorkflowFor } from "./store.js";
import { mailFromAddress, type MailKind } from "../../utils/mailer.js";
import { APPROVAL_EMAIL_MAP } from "../approvalEmails/map.js";

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();

/** Events whose email carries a decision link: never switchable. */
export function isLockedEvent(event: string): boolean {
  const spec: AnyObj | undefined = (APPROVAL_EMAIL_MAP as AnyObj)[event];
  return !!spec && (spec.link === "decision-request" || spec.link === "decision-proposal");
}

export function isCustomerEvent(event: string): boolean {
  const spec: AnyObj | undefined = (APPROVAL_EMAIL_MAP as AnyObj)[event];
  return !!spec && spec.audience === "customer";
}

/** Is this event switched off by the workspace's workflow config? (FYI events only.) */
export function eventEnabled(cfg: AnyObj | null, event: string): boolean {
  if (!cfg || isLockedEvent(event)) return true;
  return cfg?.email?.events?.[event]?.enabled !== false;
}

/**
 * The From / Reply-To for one outbox row now, or null for today's. `row`
 * needs event, kind and requestId.
 */
export async function customerSenderFor(row: AnyObj): Promise<{ from: string; replyTo: string } | null> {
  if (!isCustomerEvent(str(row?.event))) return null;
  const rid = str(row?.requestId);
  if (!mongoose.Types.ObjectId.isValid(rid)) return null;
  const ar: any = await ApprovalRequest.findOne({ _id: rid }).select("workspaceId workflow.versionId").lean().exec();
  if (!ar?.workflow) return null;
  const cfg: any = await activeWorkflowFor(ar.workspaceId);
  const sender = cfg?.email?.sender;
  const name = str(sender?.displayName).replace(/["<>\r\n]/g, "");
  const replyTo = str(sender?.replyTo);
  if (!name && !replyTo) return null;
  const address = mailFromAddress((str(row?.kind) || "DEFAULT") as MailKind);
  return { from: name ? `"${name}" <${address}>` : "", replyTo };
}
