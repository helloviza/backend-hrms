// apps/backend/src/services/closeReasons.ts
//
// Why ops closed a case without a booking (Mark Processed, PUT
// /approvals/admin/:id/close → meta.closedReason). Customer-safe labels: the
// requester's "cancelled" email and the partner / student tracker show them;
// the free-text note ops add never leaves staff views on the tracker.
export const CLOSE_REASONS: Record<string, string> = {
  CANCELLED_BY_CLIENT: "Cancelled by the client",
  NOT_AVAILABLE: "Not available",
  DUPLICATE: "Duplicate request",
  HANDLED_ELSEWHERE: "Handled outside Plumbox",
};
