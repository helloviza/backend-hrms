// apps/backend/src/services/gstRegistrationAccess.ts
//
// Who may change a client company's GST registrations (R2, decision 3b).
//
// Access Console key `gstRegistrations`, level only (no scope): any level
// above NONE grants it, and no level template carries it, so it is given per
// person and changing someone's level neither confers nor revokes it.
//
//   - Platform SuperAdmin always passes (isSuperAdmin: the same detector the
//     permission gate uses, which refuses demo impersonation).
//   - Only Plumtrips staff can hold it: a caller outside the HOUSE workspace
//     (a tenant admin included) never passes, even with the key stored on
//     their permission document.
//   - The grant must be active (holdsCapability reads status "active").
//
// Required for: add, edit (incl. per-registration Plumtrips Bill From),
// set default, deactivate, reactivate — and on the legacy paths a change to
// the GSTIN, GST state or GST status (services/gstRegistrations.ts
// applyLegacyGstFields). Reading registrations is unchanged.
import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { isHouseUser } from "../middleware/requirePlatformAdmin.js";
import { holdsCapability } from "./capabilityProbe.js";

export const GST_REGISTRATIONS_KEY = "gstRegistrations";

export async function canManageGstRegistrations(req: unknown): Promise<boolean> {
  if (isSuperAdmin(req as any)) return true;
  // The PERSON must be Plumtrips staff (their login's workspace is HOUSE), not
  // merely the request: staff edit a client's workspace on some paths.
  const user = (req as any)?.user;
  if (!user || user._demoImpersonation || !isHouseUser(user)) return false;
  return holdsCapability(req, GST_REGISTRATIONS_KEY, "READ");
}

export async function requireGstRegistrationsAccess(req: Request, res: Response, next: NextFunction) {
  try {
    if (await canManageGstRegistrations(req)) return next();
    return res.status(403).json({
      error: "Managing GST registrations needs the GST Registrations grant (Access Console).",
      code: "GST_REGISTRATIONS_ACCESS_REQUIRED",
      module: GST_REGISTRATIONS_KEY,
      required: "READ",
    });
  } catch (err) {
    return next(err);
  }
}
