// apps/backend/src/routes/gstRegistrations.ts
//
// Business Profiles → "GST registrations" table. Plumtrips staff only (D2), the
// same gate as PATCH /api/customers/:id. Every WRITE also needs the
// gstRegistrations grant (services/gstRegistrationAccess.ts). Every write goes
// through services/gstRegistrations.ts. Mounted at /api/customers.
//
//   GET    /gst-registrations/check?gstin=&customerId=   live check for the add row
//   GET    /:id/gst-registrations
//   POST   /:id/gst-registrations                        { gstin, legalName?, label?, address?, billingEmail?, defaultSellerGstin?, makeDefault? }
//   PATCH  /:id/gst-registrations/:regId                 { legalName?, tradeName?, label?, address?, billingEmail?, defaultSellerGstin?, isSez? }
//   POST   /:id/gst-registrations/:regId/default
//   POST   /:id/gst-registrations/:regId/deactivate
//   POST   /:id/gst-registrations/:regId/reactivate
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePlatformAdmin } from "../middleware/requirePlatformAdmin.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireRoles } from "../middleware/roles.js";
import { validateObjectId } from "../middleware/validateObjectId.js";
import Customer from "../models/Customer.js";
import { canManageGstRegistrations, requireGstRegistrationsAccess } from "../services/gstRegistrationAccess.js";
import {
  addRegistration,
  checkGstin,
  deactivateRegistration,
  listRegistrations,
  reactivateRegistration,
  sendGstRegistrationError,
  setDefaultRegistration,
  updateRegistration,
  type Actor,
} from "../services/gstRegistrations.js";

const router = Router();

const staffOnly = [requireAuth, requireWorkspace, requireRoles("ADMIN", "SUPERADMIN", "HR") as any, requirePlatformAdmin as any];

function actorOf(req: any, source: string): Actor {
  return { actorId: String(req.user?._id || req.user?.id || req.user?.sub || ""), source };
}

function handle(fn: (req: any) => Promise<unknown>) {
  return async (req: any, res: any, next: any) => {
    try {
      res.json({ ok: true, ...((await fn(req)) as object) });
    } catch (err) {
      if (!sendGstRegistrationError(res, err)) next(err);
    }
  };
}

router.get(
  "/gst-registrations/check",
  ...staffOnly,
  handle(async (req) => {
    const customerId = String(req.query.customerId || "");
    const customer: any = customerId
      ? await Customer.findById(customerId).select("panNumber gstRegistrations").lean()
      : { panNumber: "", gstRegistrations: [] };
    return { check: await checkGstin(customer || { gstRegistrations: [] }, req.query.gstin) };
  }),
);

// canManage tells the table whether to offer Add / Deactivate / Make default /
// Bill From edits; the server enforces the same rule on every write below.
router.get(
  "/:id/gst-registrations",
  validateObjectId("id"),
  ...staffOnly,
  handle(async (req) => ({ ...(await listRegistrations(req.params.id)), canManage: await canManageGstRegistrations(req) })),
);

router.post(
  "/:id/gst-registrations",
  validateObjectId("id"),
  ...staffOnly,
  requireGstRegistrationsAccess as any,
  handle(async (req) => ({ registration: await addRegistration(req.params.id, req.body || {}, actorOf(req, "businessProfiles:add")) })),
);

router.patch(
  "/:id/gst-registrations/:regId",
  validateObjectId("id"),
  validateObjectId("regId"),
  ...staffOnly,
  requireGstRegistrationsAccess as any,
  handle(async (req) => ({
    registration: await updateRegistration(req.params.id, req.params.regId, req.body || {}, actorOf(req, "businessProfiles:update")),
  })),
);

router.post(
  "/:id/gst-registrations/:regId/default",
  validateObjectId("id"),
  validateObjectId("regId"),
  ...staffOnly,
  requireGstRegistrationsAccess as any,
  handle(async (req) => ({
    registration: await setDefaultRegistration(req.params.id, req.params.regId, actorOf(req, "businessProfiles:setDefault")),
  })),
);

router.post(
  "/:id/gst-registrations/:regId/deactivate",
  validateObjectId("id"),
  validateObjectId("regId"),
  ...staffOnly,
  requireGstRegistrationsAccess as any,
  handle(async (req) => ({
    registration: await deactivateRegistration(req.params.id, req.params.regId, actorOf(req, "businessProfiles:deactivate")),
  })),
);

router.post(
  "/:id/gst-registrations/:regId/reactivate",
  validateObjectId("id"),
  validateObjectId("regId"),
  ...staffOnly,
  requireGstRegistrationsAccess as any,
  handle(async (req) => ({
    registration: await reactivateRegistration(req.params.id, req.params.regId, actorOf(req, "businessProfiles:reactivate")),
  })),
);

export default router;
