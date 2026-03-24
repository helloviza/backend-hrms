// apps/backend/src/emails/onboardingBusiness.ts
import { emailLayout } from "./onboardingBase.js";

export function onboardingBusinessEmail(params: {
  name?: string;
  link: string;
  expiresAt: Date;
}) {
  return {
    subject: "Your Plumtrips Business Workspace Awaits",
    html: emailLayout({
      title: "Your Business Workspace Awaits",
      subtitle:
        "You’ve been invited to activate your Plumtrips workspace — a calm, intelligent control layer designed to bring clarity, governance, and confidence to how your teams operate.",
      ctaText: "Complete Business Setup",
      ctaLink: params.link,
      expiresAt: params.expiresAt,

      // ✅ THIS LINE WAS MISSING
      name: params.name,
    }),
  };
}
