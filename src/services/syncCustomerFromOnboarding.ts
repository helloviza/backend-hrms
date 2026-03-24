// apps/backend/src/services/syncCustomerFromOnboarding.ts
import Customer from "../models/Customer.js";

export async function syncCustomerFromOnboarding(invite: any) {
  if (!invite || String(invite.type).toLowerCase() !== "business") return;

  const p = invite.formPayload || {};

  // Avoid duplicate customers for same onboarding
  const exists = await Customer.findOne({ onboardingId: invite._id }).lean();
  if (exists) return;

  await Customer.create({
    // ---------- Identity ----------
    name: p.legalName || invite.name || invite.inviteeName || "Business",
    email: p.officialEmail || invite.email,
    phone: p.contacts?.primaryPhone || "",
    type: "CUSTOMER",
    status: "ACTIVE",
    segment: p.industry || "CUSTOMER",

    // ---------- Business master ----------
    companyName: p.legalName || "",
    officialEmail: p.officialEmail || "",
    industry: p.industry || "",
    gstin: p.gstNumber || "",
    pan: p.panNumber || "",

    registeredAddress: p.registeredAddress || "",
    operationalAddress: p.operationalAddress || "",

    // ---------- Primary contact ----------
    contactName: p.signatory?.name || "",
    contactEmail:
      p.keyContacts?.[0]?.email || p.officialEmail || invite.email,
    contactMobile:
      p.keyContacts?.[0]?.mobile || p.contacts?.primaryPhone || "",

    // ---------- Finance ----------
    creditLimit: p.creditLimit || "",
    paymentTerms: p.paymentTerms || "",

    // ---------- Linking ----------
    onboardingId: invite._id,
  });
}
