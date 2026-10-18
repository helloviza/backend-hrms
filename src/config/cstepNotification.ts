// apps/backend/src/config/cstepNotification.ts
//
// The one sender identity for CSTEP Travel & Claim Portal notification emails
// (services/cstepNotifications.ts). Its display name is also the organisation
// label the CSTEP email header and footer show (layout footer: "cstep").
//
// TODO(CSTEP sender): PLACEHOLDER — not a real mailbox. CSTEP have not yet
// confirmed how mail is sent as them (a cstep.in domain verified for our SMTP
// vs. their own Exchange mailbox). Until they do, mail sent with this From
// will not be authorised for any real domain. Replacing this one line is the
// whole switch-over; no SMTP credentials belong here.
export const CSTEP_NOTIFICATION_FROM = "CSTEP <todo-confirm-cstep-sender@example.invalid>";

/** The display-name part of CSTEP_NOTIFICATION_FROM ("CSTEP"). */
export function cstepOrgLabel(from: string = CSTEP_NOTIFICATION_FROM): string {
  const name = from.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
  return name || "CSTEP";
}
