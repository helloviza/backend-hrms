import { emailLayout } from "./onboardingBase.js";

export function onboardingVendorEmail(params: {
  name?: string;
  link: string;
  expiresAt: Date;
}) {
  return {
    subject: "Invitation to Partner with Plumtrips",
    html: emailLayout({
      title: "Welcome, Partner",
      subtitle:
        "You’ve been invited to onboard as a Plumtrips vendor partnership program— a curated ecosystem built on trust, transparency, and long-term collaboration. Complete your profile to begin working with our teams.",
      ctaText: "Start Vendor Onboarding",
      ctaLink: params.link,
      expiresAt: params.expiresAt,

      // ✅ PERSONALIZATION (same as Business)
      name: params.name,
    }),
  };
}
