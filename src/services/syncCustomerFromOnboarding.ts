// apps/backend/src/services/syncCustomerFromOnboarding.ts
import Customer from "../models/Customer.js";
import { gstStatusFromForm } from "../utils/customerGst.js";
import { ensureRegistrationFromOnboarding } from "./gstRegistrations.js";

// Only a SUBMITTED form describes a company. An invite that was merely sent,
// opened or expired has no form data, so a stub made from it is junk keyed on
// the contact's email — which is exactly what later collided with the real
// customer on promote (ABC Cleantech, 2026-09-29).
const SUBMITTED_STATUSES = ["submitted", "verified", "approved"];

export async function syncCustomerFromOnboarding(invite: any) {
  if (!invite || String(invite.type).toLowerCase() !== "business") return;
  if (!SUBMITTED_STATUSES.includes(String(invite.status || "").toLowerCase())) return;

  const p = invite.formPayload || {};

  // Avoid duplicate customers for same onboarding. At APPROVAL the stub made
  // at submit already exists: that is when its form GSTIN becomes the default
  // GST registration (R2) — validated, and skipped (logged, never failing the
  // approval) when invalid; promote then refuses it until it is fixed.
  const exists: any = await Customer.findOne({ onboardingId: invite._id }).select("_id").lean();
  if (exists) {
    await registerAtApproval(invite, exists._id, p);
    return;
  }

  let stub: any;
  try {
    stub = await createStub(invite, p);
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
  // Approved with no stub from submit (e.g. a form submitted before stubs
  // existed): the stub is made now, and its GSTIN is registered exactly as it
  // would have been on an existing stub.
  await registerAtApproval(invite, stub._id, p);
}

/** At APPROVAL the form GSTIN becomes the default GST registration (R2):
 *  validated, and skipped (logged, never failing the approval) when invalid. */
async function registerAtApproval(invite: any, customerId: unknown, p: any) {
  if (String(invite.status || "").toLowerCase() !== "approved") return;
  try {
    await ensureRegistrationFromOnboarding(customerId, p, { source: "onboarding:approved" }, { strict: false });
  } catch (err: any) {
    console.warn("[syncCustomerFromOnboarding] GST registration not created at approval", {
      onboardingId: String(invite._id),
      code: err?.code,
      message: err?.message,
    });
  }
}

async function createStub(invite: any, p: any) {
  return Customer.create({
    // ---------- Identity ----------
    name: p.legalName || invite.name || invite.inviteeName || "Business",
    email: p.officialEmail || invite.email,
    phone: p.contacts?.primaryPhone || p.phone || "",
    type: "CUSTOMER",
    status: "ACTIVE",
    segment: p.industry || "CUSTOMER",

    // ---------- Business master ----------
    legalName: p.legalName || p.companyName || "",
    // No GSTIN on the stub: a submitted form is the client's own, unvalidated
    // input. It becomes a GST registration at approval / promote (R2).
    gstStatus: gstStatusFromForm(p),
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
