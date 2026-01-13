// apps/backend/src/emails/index.ts

import { sendMail } from "../utils/mailer.js";

import { onboardingEmployeeEmail } from "./onboardingEmployee.js";
import { onboardingVendorEmail } from "./onboardingVendor.js";
import { onboardingBusinessEmail } from "./onboardingBusiness.js";

/* -------------------------------------------------------
 * Individual exports (useful for preview/testing)
 * ----------------------------------------------------- */
export {
  onboardingEmployeeEmail,
  onboardingVendorEmail,
  onboardingBusinessEmail,
};

/* -------------------------------------------------------
 * Single entry point for onboarding emails
 * ----------------------------------------------------- */
export async function sendOnboardingEmail(params: {
  type: "employee" | "vendor" | "business";
  email: string;

  // both supported — inviteeName takes priority
  name?: string;
  inviteeName?: string;

  link: string;
  expiresAt: Date;
}) {
  // 🔐 SINGLE SOURCE OF TRUTH FOR PERSONALIZATION
  const resolvedName =
    (typeof params.inviteeName === "string" &&
      params.inviteeName.trim()) ||
    (typeof params.name === "string" && params.name.trim()) ||
    undefined;

  let emailPayload: { subject: string; html: string };

  switch (params.type) {
    case "employee":
      emailPayload = onboardingEmployeeEmail({
        name: resolvedName,
        link: params.link,
        expiresAt: params.expiresAt,
      });
      break;

    case "vendor":
      emailPayload = onboardingVendorEmail({
        name: resolvedName,
        link: params.link,
        expiresAt: params.expiresAt,
      });
      break;

    case "business":
    default:
      emailPayload = onboardingBusinessEmail({
        name: resolvedName,
        link: params.link,
        expiresAt: params.expiresAt,
      });
      break;
  }

  return sendMail({
  to: params.email,
  subject: emailPayload.subject,
  html: emailPayload.html,

  from:
    process.env.MAIL_FROM_ONBOARDING ||
    "PlumTrips Onboarding <onboarding@plumtrips.com>",

  kind: "ONBOARDING", // ✅ IMPORTANT
});

}
