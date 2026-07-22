// apps/backend/src/routes/publicSupportContact.ts
//
// Minimal, unauthenticated endpoint for surfaces that need a support email —
// customer/vendor pages, pre-auth flows (verify-email, signup-success), etc.
// via useSupportEmail() on the frontend. Deliberately returns only
// supportEmail (nothing else CompanySettings holds — GST, bank details,
// invoice numbering — is admin-only and stays behind /api/admin/company-settings).
import express from "express";
import { getCompanySettings } from "../models/CompanySettings.js";

const router = express.Router();

router.get("/support-contact", async (_req, res) => {
  try {
    const settings = await getCompanySettings();
    res.json({ ok: true, supportEmail: settings.supportEmail || "hello@plumtrips.com" });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: "Failed to load support contact" });
  }
});

export default router;
