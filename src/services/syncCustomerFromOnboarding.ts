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
    phone: p.contacts?.primaryPhone || p.phone || "",
    type: "CUSTOMER",
    status: "ACTIVE",
    segment: p.industry || "CUSTOMER",

    // ---------- Business master ----------
    legalName: p.legalName || p.companyName || "",
    gstNumber: p.gstNumber || p.gstin || "",
    panNumber: p.panNumber || "",
    industry: p.industry || "",

    registeredAddress: p.registeredAddress || "",
    operationalAddress: p.operationalAddress || "",

    contacts: {
      primaryPhone: p.contacts?.primaryPhone || p.phone || "",
      officialEmail: p.officialEmail || invite.email || "",
    },

    keyContacts: Array.isArray(p.keyContacts) ? p.keyContacts : [],

    // ---------- Finance ----------
    creditLimit: p.creditLimit || "",
    paymentTerms: p.paymentTerms || "",

    // ---------- Linking ----------
    onboardingId: invite._id,
  });
}
