// apps/backend/src/services/syncCustomerFromOnboarding.ts
import Customer from "../models/Customer.js";

// Only a SUBMITTED form describes a company. An invite that was merely sent,
// opened or expired has no form data, so a stub made from it is junk keyed on
// the contact's email — which is exactly what later collided with the real
// customer on promote (ABC Cleantech, 2026-09-29).
const SUBMITTED_STATUSES = ["submitted", "verified", "approved"];

export async function syncCustomerFromOnboarding(invite: any) {
  if (!invite || String(invite.type).toLowerCase() !== "business") return;
  if (!SUBMITTED_STATUSES.includes(String(invite.status || "").toLowerCase())) return;

  const p = invite.formPayload || {};

  // Avoid duplicate customers for same onboarding
  const exists = await Customer.findOne({ onboardingId: invite._id }).lean();
  if (exists) return;

  try {
    await createStub(invite, p);
  } catch (err: any) {
    // A company that already exists as a customer (same legal name) must not
    // fail the submit — the promote step reports that clash to the admin with
    // the existing record, which is where it can actually be resolved.
    if (err?.code === 11000) {
      console.warn("[syncCustomerFromOnboarding] stub skipped, duplicate key", {
        onboardingId: String(invite._id),
        keyPattern: err.keyPattern,
      });
      return;
    }
    throw err;
  }
}

async function createStub(invite: any, p: any) {
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
