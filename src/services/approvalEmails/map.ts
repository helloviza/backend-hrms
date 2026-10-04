// apps/backend/src/services/approvalEmails/map.ts
//
// THE EMAIL MAP for the approval flows (Flow 2: request → approval → proposal
// → approval → booking; Flow 3: request → approval → booking). Every email
// those flows send is one row here, and services/approvalEmails/dispatch.ts
// routes from these rows, so this file is the whole routing in one place.
// docs/approval-emails.md is generated from it
// (src/scripts/gen-approval-emails-doc.ts; a test fails if the doc is stale).
//
// Rules applied to EVERY event by the dispatcher:
//   - A deactivated person (User.status INACTIVE, or a customer membership
//     that is no longer active) is never emailed or copied.
//   - One person gets at most one copy of an event (To wins over CC).
//   - Customer-facing emails: Reply-To is the ops desk (DESK_EMAIL), staff
//     show as "Plumtrips Travel Desk", people are named (never ids) and the
//     content is price-free.
//   - Every email with a decision link says when the link expires
//     (APPROVAL_LINK_EXPIRY_HOURS, 72h). Links are single-use and the
//     recipient is re-checked when they click.
//   - Every send goes through the outbox (services/emailOutbox.ts): retried,
//     and a permanent failure is listed for staff and alerted to the desk.
//
// Roles:
//   requester      who raised the request (ApprovalRequest.frontlinerEmail)
//   approver       the request's assigned approver (managerEmail)
//   leaders        the workspace's active Workspace Leaders
//   deciders       who may decide now: approver (while still an approver)
//                  + active Workspace Leaders, never the requester — except a
//                  Workspace Leader requester who is the only possible
//                  proposal decider (approvalDecisions.ts)
//   asker          whoever asked the open clarification question
//   agent          the Travel Desk agent the case is assigned to
//   proposalStaff  the staff who drafted / submitted the proposal
//   desk           the ops desk mailbox, DESK_EMAIL (ops@plumtrips.com)

export type EmailRole =
  | "requester"
  | "approver"
  | "leaders"
  | "deciders"
  | "asker"
  | "agent"
  | "proposalStaff"
  | "desk";

export type LinkType = "decision-request" | "decision-proposal" | "login" | "staff-login" | "none";

export type FlowName = "Flow 2" | "Flow 3";

export type EmailEventSpec = {
  /** Short human name. */
  label: string;
  flows: FlowName[];
  /** What sends it. null = no such action exists today (documented, never sent). */
  trigger: string | null;
  to: EmailRole[];
  cc: EmailRole[];
  /** Removed from the recipients (e.g. leaders who already got the approver copy). */
  exclude: EmailRole[];
  /** The person who just acted is dropped (no FYI about your own decision). */
  excludeActor: boolean;
  replyTo: "desk" | "none";
  audience: "customer" | "staff";
  /** One email per To recipient — needed when each carries their own decision link. */
  perRecipient: boolean;
  /** Which decision the "deciders" role means for this event. */
  decidersOf?: "request" | "proposal";
  link: LinkType;
  /** Template function in templates.ts. */
  template: string;
  subject: string;
  notes?: string;
};

const BOTH: FlowName[] = ["Flow 2", "Flow 3"];
const F2: FlowName[] = ["Flow 2"];

export const APPROVAL_EMAIL_MAP = {
  /* ───────────── request phase (Flow 2 and Flow 3) ───────────── */
  request_submitted_approver: {
    label: "Approval needed (approver)",
    flows: BOTH,
    trigger: "Requester submits a request (not auto-approved)",
    to: ["approver"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: true, link: "decision-request",
    template: "approverRequestHtml",
    subject: "Approval Needed — {customer} ({code})",
  },
  request_submitted_leaders: {
    label: "Approval needed (Workspace Leaders)",
    flows: BOTH,
    trigger: "Requester submits a request (not auto-approved)",
    to: ["leaders"], cc: [], exclude: ["approver", "requester"], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: true, link: "decision-request",
    template: "approverRequestHtml",
    subject: "Approval Needed — {customer} ({code})",
    notes: "Leaders may decide too (\"either\" rule), so they get their own decision links. Not sent for an auto-approved request.",
  },
  request_submitted_confirmation: {
    label: "Request received (requester)",
    flows: BOTH,
    trigger: "Requester submits a request (not auto-approved)",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "submitConfirmationHtml",
    subject: "We've received your travel request — {code}",
  },
  request_auto_approved: {
    label: "Request auto-approved (requester)",
    flows: BOTH,
    trigger: "A Workspace Leader submits a request (no one above them to approve)",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "autoApprovedHtml",
    subject: "Request Approved — {code}",
  },
  request_resent: {
    label: "Approval needed (resent)",
    flows: BOTH,
    trigger: "Requester (or ops) presses Resend on a pending request",
    to: ["deciders"], cc: [], exclude: [], excludeActor: false, decidersOf: "request",
    replyTo: "desk", audience: "customer", perRecipient: true, link: "decision-request",
    template: "approverRequestHtml",
    subject: "Approval Needed — {customer} ({code})",
    notes: "Recomputed deciders, not the stored approver email: someone who lost the role is not re-sent.",
  },
  request_resubmitted: {
    label: "Approval needed (resubmitted)",
    flows: BOTH,
    trigger: "Requester resubmits a declined request",
    to: ["deciders"], cc: [], exclude: [], excludeActor: false, decidersOf: "request",
    replyTo: "desk", audience: "customer", perRecipient: true, link: "decision-request",
    template: "approverRequestHtml",
    subject: "Approval Needed (Resubmitted) — {customer} ({code})",
  },
  request_reminder: {
    label: "Reminder: approval pending",
    flows: BOTH,
    trigger: "Reminder job: request still awaiting a decision 24h, 48h, 72h after it reached the approver",
    to: ["deciders"], cc: [], exclude: [], excludeActor: false, decidersOf: "request",
    replyTo: "desk", audience: "customer", perRecipient: true, link: "decision-request",
    template: "approverRequestHtml",
    subject: "Reminder {n} of 3: Approval Needed — {customer} ({code})",
    notes: "At most 3. Stops as soon as the request is decided, revoked, cancelled or waiting on the requester's reply.",
  },
  request_approved: {
    label: "Request approved (requester)",
    flows: BOTH,
    trigger: "Approver or Workspace Leader approves (app or email link)",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "requestApprovedHtml",
    subject: "Request approved — {customer} ({code})",
  },
  request_approved_fyi: {
    label: "Request approved (other deciders)",
    flows: BOTH,
    trigger: "Approver or Workspace Leader approves",
    to: ["deciders"], cc: [], exclude: ["requester"], excludeActor: true, decidersOf: "request",
    replyTo: "desk", audience: "customer", perRecipient: false, link: "none",
    template: "decisionFyiHtml",
    subject: "Request approved — {code}",
    notes: "Tells the approver and Workspace Leaders the outcome; never the person who decided.",
  },
  request_declined: {
    label: "Request declined (requester)",
    flows: BOTH,
    trigger: "Approver or Workspace Leader declines",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "requestDeclinedHtml",
    subject: "Your Travel Request Has Been Declined — {code}",
  },
  request_declined_fyi: {
    label: "Request declined (other deciders)",
    flows: BOTH,
    trigger: "Approver or Workspace Leader declines",
    to: ["deciders"], cc: [], exclude: ["requester"], excludeActor: true, decidersOf: "request",
    replyTo: "desk", audience: "customer", perRecipient: false, link: "none",
    template: "decisionFyiHtml",
    subject: "Request declined — {code}",
  },
  clarification_asked: {
    label: "Question for the requester",
    flows: BOTH,
    trigger: "Approver or Workspace Leader asks a clarification question",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "clarificationAskedHtml",
    subject: "Your approver has a question — {code}",
  },
  clarification_answered: {
    label: "Requester replied",
    flows: BOTH,
    trigger: "Requester answers the question",
    to: ["asker"], cc: [], exclude: [], excludeActor: false, decidersOf: "request",
    replyTo: "desk", audience: "customer", perRecipient: true, link: "decision-request",
    template: "approverRequestHtml",
    subject: "Reply received — Approval Needed — {customer} ({code})",
    notes: "Goes back to whoever asked (a Workspace Leader or the approver); the assigned approver only if the asker can no longer decide.",
  },

  /* ───────────── ops queue ───────────── */
  ops_new_case: {
    label: "New case in the ops queue",
    flows: BOTH,
    trigger: "Request approved or auto-approved (enters the ops queue)",
    to: ["desk"], cc: [], exclude: [], excludeActor: false,
    replyTo: "none", audience: "staff", perRecipient: false, link: "staff-login",
    template: "deskNewCaseHtml",
    subject: "New case — {code} — {customer}",
    notes: "Says who it was auto-assigned to, if anyone.",
  },
  ops_no_agent: {
    label: "New case — no agent available",
    flows: BOTH,
    trigger: "Request enters the ops queue and auto-allocation finds no available agent",
    to: ["desk"], cc: [], exclude: [], excludeActor: false,
    replyTo: "none", audience: "staff", perRecipient: false, link: "staff-login",
    template: "deskNewCaseHtml",
    subject: "Unassigned — no agent available — {code} — {customer}",
    notes: "Sent instead of ops_new_case for that case.",
  },
  case_assigned: {
    label: "Case assigned to you",
    flows: BOTH,
    trigger: "Case assigned to a Travel Desk agent (by hand or auto-allocation)",
    to: ["agent"], cc: [], exclude: [], excludeActor: false,
    replyTo: "none", audience: "staff", perRecipient: false, link: "staff-login",
    template: "assigneeHtml",
    subject: "Assigned to you — {code} — {customer}",
  },

  /* ───────────── proposal phase (Flow 2) ───────────── */
  proposal_submitted: {
    label: "Proposal approval needed",
    flows: F2,
    trigger: "Ops submit a proposal",
    to: ["deciders"], cc: [], exclude: [], excludeActor: false, decidersOf: "proposal",
    replyTo: "desk", audience: "customer", perRecipient: true, link: "decision-proposal",
    template: "proposalApprovalHtml",
    subject: "Proposal Approval Needed — {code}",
    notes: "Option and line titles are price-stripped and HTML-escaped. No option PDFs (they carry prices).",
  },
  proposal_ready: {
    label: "Proposal ready (requester)",
    flows: F2,
    trigger: "Ops submit a proposal",
    to: ["requester"], cc: [], exclude: ["deciders"], excludeActor: false, decidersOf: "proposal",
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "proposalReadyHtml",
    subject: "Your travel proposal is ready — {code}",
    notes: "Not sent when the requester is a decider (a Workspace Leader who is the only decider gets the approval email instead).",
  },
  proposal_reminder: {
    label: "Reminder: proposal decision pending",
    flows: F2,
    trigger: "Reminder job: proposal still awaiting a decision 24h, 48h, 72h after it was submitted",
    to: ["deciders"], cc: [], exclude: [], excludeActor: false, decidersOf: "proposal",
    replyTo: "desk", audience: "customer", perRecipient: true, link: "decision-proposal",
    template: "proposalApprovalHtml",
    subject: "Reminder {n} of 3: Proposal Approval Needed — {code}",
    notes: "At most 3. Stops as soon as the proposal is decided or the request is cancelled or revoked.",
  },
  proposal_approved: {
    label: "Proposal approved (requester)",
    flows: F2,
    trigger: "Approver or Workspace Leader approves the proposal (or ops record it on the customer's behalf)",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "proposalApprovedHtml",
    subject: "Your Travel Proposal Has Been Approved — {code}",
  },
  proposal_declined: {
    label: "Proposal declined (requester)",
    flows: F2,
    trigger: "Approver or Workspace Leader declines the proposal (or ops record it)",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "proposalDeclinedHtml",
    subject: "Your Travel Proposal Has Been Declined — {code}",
  },
  proposal_changes_requested: {
    label: "Proposal changes requested (requester)",
    flows: F2,
    trigger: "Approver or Workspace Leader requests changes (or ops record it)",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "proposalChangesRequestedHtml",
    subject: "Changes requested on your travel proposal — {code}",
  },
  proposal_decision_fyi: {
    label: "Proposal decided (other deciders)",
    flows: F2,
    trigger: "Any proposal decision (approve, decline, request changes)",
    to: ["deciders"], cc: [], exclude: ["requester"], excludeActor: true, decidersOf: "proposal",
    replyTo: "desk", audience: "customer", perRecipient: false, link: "none",
    template: "decisionFyiHtml",
    subject: "Proposal {approved|declined|sent back for changes} — {code}",
    notes: "Recorded on the customer's behalf: the decider is shown as Plumtrips Travel Desk and nobody is the actor.",
  },
  ops_proposal_outcome: {
    label: "Proposal outcome (ops)",
    flows: F2,
    trigger: "Any proposal decision (approve, decline, request changes)",
    to: ["desk"], cc: ["agent", "proposalStaff"], exclude: [], excludeActor: true,
    replyTo: "none", audience: "staff", perRecipient: false, link: "staff-login",
    template: "deskProposalOutcomeHtml",
    subject: "Proposal {approved|declined|changes requested} — {code} — {customer}",
    notes: "CC: the assigned agent and the staff who drafted/submitted it (not the staff member who recorded the decision).",
  },

  /* ───────────── booking (Flow 2 and Flow 3) ───────────── */
  booking_started: {
    label: "Booking in progress",
    flows: BOTH,
    trigger: "Ops start booking (queue or proposal page)",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "progressHtml",
    subject: "Booking in progress — {code}",
  },
  booking_on_hold: {
    label: "Booking on hold",
    flows: BOTH,
    trigger: "Ops put the booking on hold",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "progressHtml",
    subject: "Your booking is on hold — {code}",
  },
  booking_cancelled: {
    label: "Request cancelled by ops",
    flows: BOTH,
    trigger: "Ops cancel the case (queue or proposal page) — refused if already cancelled or completed",
    to: ["requester"], cc: [], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "login",
    template: "progressHtml",
    subject: "Booking Update — Request Cancelled — {code}",
  },
  booking_done: {
    label: "Booking processed",
    flows: BOTH,
    trigger: "Ops mark the booking done (queue or proposal page)",
    to: ["requester"], cc: ["approver", "leaders"], exclude: [], excludeActor: false,
    replyTo: "desk", audience: "customer", perRecipient: false, link: "none",
    template: "bookingDoneHtml",
    subject: "Your Booking has been Processed — {customer} ({code})",
    notes: "Carries the booking documents. The request records \"notified\" only once the send succeeds.",
  },
  ops_customer_cancelled: {
    label: "Customer cancelled after approval",
    flows: BOTH,
    trigger: null,
    to: ["desk"], cc: [], exclude: [], excludeActor: false,
    replyTo: "none", audience: "staff", perRecipient: false, link: "staff-login",
    template: "deskNewCaseHtml",
    subject: "Customer cancelled — {code} — {customer}",
    notes: "NOT SENT: customers have no cancel action after approval today (revoke is pending-only). Agreed recipient kept here for when one exists.",
  },

  /* ───────────── delivery ───────────── */
  email_send_failed_alert: {
    label: "Email not delivered",
    flows: BOTH,
    trigger: "Any email above fails its last retry (outbox)",
    to: ["desk"], cc: [], exclude: [], excludeActor: false,
    replyTo: "none", audience: "staff", perRecipient: false, link: "staff-login",
    template: "sendFailureAlertHtml",
    subject: "Email not delivered — {code} — {original subject}",
    notes: "Sent once (never retried or re-alerted). The failure is also listed for staff on the ops queue.",
  },
} satisfies Record<string, EmailEventSpec>;

export type ApprovalEmailEvent = keyof typeof APPROVAL_EMAIL_MAP;

export const ROLE_LABEL: Record<EmailRole, string> = {
  requester: "Requester",
  approver: "Approver",
  leaders: "Workspace Leaders",
  deciders: "Deciders (approver + Workspace Leaders)",
  asker: "Who asked the question",
  agent: "Assigned Travel Desk agent",
  proposalStaff: "Proposal drafter / submitter (staff)",
  desk: "Ops desk (ops@plumtrips.com)",
};

/** The five people/mailboxes the per-role tables are written for. */
export const ROLE_VIEWS: Array<{ title: string; roles: EmailRole[] }> = [
  { title: "Requester", roles: ["requester"] },
  { title: "Approver", roles: ["approver", "deciders", "asker"] },
  { title: "Workspace Leader", roles: ["leaders", "deciders", "asker"] },
  { title: "Assigned ops agent", roles: ["agent", "proposalStaff"] },
  { title: "Ops desk (ops@plumtrips.com)", roles: ["desk"] },
];
