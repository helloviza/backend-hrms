// apps/backend/src/services/approvalEmails/links.ts
//
// Every URL the approval emails carry, and the request code they show — one
// place, so a wrong path (the old "/approvals/requests/mine") can't creep back.
import { signApprovalLink, APPROVAL_LINK_EXPIRY_HOURS, type ApprovalLinkKind } from "../../utils/approvalLinkToken.js";
import { frontendBaseUrl } from "../../routes/approvals.security.js";

type AnyObj = Record<string, any>;

/** Confirm-page URL for one recipient, or "" when links are not configured. */
export function decisionLinkUrl(
  kind: ApprovalLinkKind,
  id: string,
  recipient: string,
  _ws?: AnyObj | null,
  intent?: string,
): string {
  const token = signApprovalLink({ kind, id, email: recipient }, APPROVAL_LINK_EXPIRY_HOURS);
  if (!token) return "";
  return `${frontendBaseUrl()}/approval/email?token=${encodeURIComponent(token)}${
    intent ? `&intent=${encodeURIComponent(intent)}` : ""
  }`;
}

/** "These links expire in 72 hours (by Tue, 6 Oct, 10:15 pm IST)." */
export function linkExpiryText(now = new Date()): string {
  const until = new Date(now.getTime() + APPROVAL_LINK_EXPIRY_HOURS * 3600_000);
  const when = until.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `These links expire in ${APPROVAL_LINK_EXPIRY_HOURS} hours (by ${when} IST) and each works once. After that, open Plumbox to decide.`;
}

/** The requester's own requests (FE route customer/approvals/mine). */
export const myRequestsUrl = () => `${frontendBaseUrl()}/customer/approvals/mine`;
/** The approver / Workspace Leader inbox. */
export const deciderInboxUrl = () => `${frontendBaseUrl()}/customer/approvals/inbox`;
/** Proposals awaiting the approver / Workspace Leader. */
export const deciderProposalsUrl = () => `${frontendBaseUrl()}/customer/approvals/proposals`;
/** Raise a new request. */
export const newRequestUrl = () => `${frontendBaseUrl()}/customer/approvals/new`;
/** Read-only, price-free proposal view for the requester. */
export const proposalViewUrl = (proposalId: any) =>
  `${frontendBaseUrl()}/customer/approvals/proposal/${encodeURIComponent(String(proposalId || ""))}`;
/** The case in the ops queue (opens with the Admin Queue grant). */
export const staffCaseUrl = (requestId: any) =>
  `${frontendBaseUrl()}/admin/approvals?request=${encodeURIComponent(String(requestId || ""))}`;

/** What people call a request: the ticket id, else REQ-<last 6 of the id> (as the app shows it). */
export function caseCode(ar: AnyObj | null | undefined): string {
  return String(ar?.ticketId || "").trim() || `REQ-${String(ar?._id || "").slice(-6).toUpperCase()}`;
}
