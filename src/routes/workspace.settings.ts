import { Router, type Request, type Response, type NextFunction } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace, isCustomerUser } from "../middleware/requireWorkspace.js";
import { requireRoles } from "../middleware/roles.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";

const r = Router();

r.use(requireAuth, requireWorkspace);

// Plumtrips internal HOUSE workspace _id — mirrors the per-file literal
// convention used in requireHouse.ts / requireFeature.ts / requireWorkspace.ts
// (no shared exported constant). NEVER write to it.
const PLUMTRIPS_HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

/* ─── PUT /payroll-enable — Enable/disable payroll feature flag ─── */
r.put(
  "/payroll-enable",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const { enabled } = req.body;

      if (!workspaceId) {
        return res.status(400).json({
          success: false,
          error:
            "No workspace context. SUPERADMIN: pass workspaceId in body, query, or x-workspace-id header.",
        });
      }

      const update: Record<string, any> = {
        "config.features.payrollEnabled": !!enabled,
      };

      // Upgrade plan if on trial or starter
      if (enabled) {
        const ws = await CustomerWorkspace.findById(workspaceId).select("plan").lean();
        const plan = (ws as any)?.plan;
        if (plan === "trial" || plan === "starter") {
          update.plan = "growth";
        }
      }

      await CustomerWorkspace.findByIdAndUpdate(workspaceId, { $set: update });

      return res.json({ success: true, payrollEnabled: !!enabled });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /payroll — Update payroll config ─── */
r.put(
  "/payroll",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const body = req.body;

      const update: Record<string, any> = {};

      if (typeof body.pfApplicable === "boolean") update["payrollConfig.pfApplicable"] = body.pfApplicable;
      if (body.pfBasis && ["CAPPED", "ACTUAL"].includes(body.pfBasis)) update["payrollConfig.pfBasis"] = body.pfBasis;
      if (typeof body.pfCap === "number" && body.pfCap > 0) update["payrollConfig.pfCap"] = body.pfCap;
      if (typeof body.esiApplicable === "boolean") update["payrollConfig.esiApplicable"] = body.esiApplicable;
      if (typeof body.esiGrossLimit === "number" && body.esiGrossLimit > 0) update["payrollConfig.esiGrossLimit"] = body.esiGrossLimit;
      if (typeof body.ptApplicable === "boolean") update["payrollConfig.ptApplicable"] = body.ptApplicable;
      if (typeof body.ptState === "string") update["payrollConfig.ptState"] = body.ptState;
      if (typeof body.payrollCycleDate === "number" && body.payrollCycleDate >= 1 && body.payrollCycleDate <= 28) {
        update["payrollConfig.payrollCycleDate"] = body.payrollCycleDate;
      }
      if (body.taxRegimeDefault && ["OLD", "NEW"].includes(body.taxRegimeDefault)) {
        update["payrollConfig.taxRegimeDefault"] = body.taxRegimeDefault;
      }
      if (typeof body.lopDeductionEnabled === "boolean") update["payrollConfig.lopDeductionEnabled"] = body.lopDeductionEnabled;
      if (typeof body.payslipFooterNote === "string") update["payrollConfig.payslipFooterNote"] = body.payslipFooterNote;

      const ws = await CustomerWorkspace.findByIdAndUpdate(
        workspaceId,
        { $set: update },
        { new: true }
      ).select("payrollConfig").lean();

      return res.json({ success: true, payrollConfig: (ws as any)?.payrollConfig });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /attendance — Update attendance config ─── */
r.put(
  "/attendance",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const body = req.body;

      const update: Record<string, any> = {};

      if (Array.isArray(body.workingDays)) update["attendanceConfig.workingDays"] = body.workingDays;

      // Validate HH:MM format
      const hhmmRe = /^\d{2}:\d{2}$/;
      if (typeof body.shiftStart === "string" && hhmmRe.test(body.shiftStart)) {
        update["attendanceConfig.shiftStart"] = body.shiftStart;
      }
      if (typeof body.shiftEnd === "string" && hhmmRe.test(body.shiftEnd)) {
        update["attendanceConfig.shiftEnd"] = body.shiftEnd;
      }
      if (typeof body.graceMinutes === "number" && body.graceMinutes >= 0 && body.graceMinutes <= 60) {
        update["attendanceConfig.graceMinutes"] = body.graceMinutes;
      }
      if (typeof body.halfDayHours === "number" && body.halfDayHours >= 2 && body.halfDayHours <= 6) {
        update["attendanceConfig.halfDayHours"] = body.halfDayHours;
      }
      if (typeof body.minHoursForPresent === "number" && body.minHoursForPresent >= 0) {
        update["attendanceConfig.minHoursForPresent"] = body.minHoursForPresent;
      }

      const ws = await CustomerWorkspace.findByIdAndUpdate(
        workspaceId,
        { $set: update },
        { new: true }
      ).select("attendanceConfig").lean();

      return res.json({ success: true, attendanceConfig: (ws as any)?.attendanceConfig });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /official-booking — Toggle SBT Official Booking ─── */
r.put(
  "/official-booking",
  requireRoles("WORKSPACE_ADMIN", "ADMIN", "WORKSPACE_LEADER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const { enabled, monthlyLimit } = req.body;

      if (!workspaceId) {
        return res.status(400).json({
          success: false,
          error: "No workspace context.",
        });
      }

      const update: Record<string, any> = {};
      if (typeof enabled === "boolean") update["sbtOfficialBooking.enabled"] = enabled;
      if (typeof monthlyLimit === "number" && monthlyLimit >= 0) update["sbtOfficialBooking.monthlyLimit"] = monthlyLimit;

      const ws = await CustomerWorkspace.findByIdAndUpdate(
        workspaceId,
        { $set: update },
        { new: true, runValidators: false },
      ).select("sbtOfficialBooking").lean();

      return res.json({ success: true, sbtOfficialBooking: (ws as any)?.sbtOfficialBooking });
    } catch (err) {
      return next(err);
    }
  },
);

/* ─── PATCH /pan — Update workspace Company PAN and GST number ─── */
r.patch(
  "/pan",
  requireRoles("WORKSPACE_ADMIN", "ADMIN", "WORKSPACE_LEADER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      if (!workspaceId) {
        return res.status(400).json({ success: false, error: "No workspace context." });
      }

      const update: Record<string, any> = {};
      if (typeof req.body.pan === "string") {
        update.pan = req.body.pan.trim().toUpperCase();
      }
      if (typeof req.body.gstNumber === "string") {
        update.gstNumber = req.body.gstNumber.trim().toUpperCase();
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ success: false, error: "No valid fields to update." });
      }

      const ws = await CustomerWorkspace.findByIdAndUpdate(
        workspaceId,
        { $set: update },
        { new: true },
      )
        .select("pan gstNumber")
        .lean();

      return res.json({ success: true, pan: (ws as any)?.pan || "", gstNumber: (ws as any)?.gstNumber || "" });
    } catch (err) {
      return next(err);
    }
  },
);

/* ─── GET / — Get workspace configs ─── */
r.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const user = (req as any).user;

      const ws = workspaceId
        ? await CustomerWorkspace.findById(workspaceId)
            .select("payrollConfig attendanceConfig pan gstNumber companyName address customerId")
            .lean()
        : null;

      // Guard: a customer session must never resolve to the Plumtrips HOUSE
      // workspace — that would put Plumtrips' own PAN/GST/contact details on
      // a customer's GST invoice, invisibly to them (same class of bug as the
      // /auth/me HOUSE leak requireWorkspace.ts guards against). Blank the
      // company-info fields rather than error: this endpoint also serves
      // payrollConfig/attendanceConfig, which should still resolve normally.
      const isHouseForCustomer =
        isCustomerUser(user) && String(workspaceId || "") === PLUMTRIPS_HOUSE_WORKSPACE_ID;

      let companyEmail = "";
      let companyPhone = "";
      if (ws && !isHouseForCustomer && (ws as any).customerId) {
        const cust = await Customer.findOne({ _id: (ws as any).customerId })
          .select("email phone billingPhone")
          .lean();
        // billingPhone is the dedicated accounts/billing contact number
        // (populated from onboarding + Zoho "Billing Phone" import); phone
        // is the general primary contact. No equivalent billingEmail field
        // exists on Customer today, so email falls back to the general one.
        companyEmail = (cust as any)?.email || "";
        companyPhone = (cust as any)?.billingPhone || (cust as any)?.phone || "";
      }

      return res.json({
        payrollConfig: (ws as any)?.payrollConfig || {},
        attendanceConfig: (ws as any)?.attendanceConfig || {},
        pan: isHouseForCustomer ? "" : (ws as any)?.pan || "",
        gstNumber: isHouseForCustomer ? "" : (ws as any)?.gstNumber || "",
        companyName: isHouseForCustomer ? "" : (ws as any)?.companyName || "",
        address: isHouseForCustomer ? null : (ws as any)?.address || null,
        companyEmail,
        companyPhone,
      });
    } catch (err) {
      return next(err);
    }
  }
);

export default r;
