import { emailLayout } from "./onboardingBase.js";

export function onboardingEmployeeEmail(params: {
  name?: string;
  link: string;
  expiresAt: Date;
}) {
  return {
    subject: "Welcome to Plumtrips — Complete Your Onboarding",
    html: emailLayout({
      title: "Welcome to Plumtrips",
      subtitle:
        "You’ve been invited to join Plumtrips Human Resource Management System — a calm, intelligent workspace designed to support your journey. Complete your onboarding to access attendance, approvals, documents, and your AI-powered HR assistant.",
      ctaText: "Begin My Onboarding",
      ctaLink: params.link,
      expiresAt: params.expiresAt,

      // ✅ PERSONALIZATION (same as Business)
      name: params.name,
    }),
  };
}
