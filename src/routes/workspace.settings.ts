import { Router, type Request, type Response, type NextFunction } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireRoles } from "../middleware/roles.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const r = Router();

r.use(requireAuth, requireWorkspace);

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

/* ─── GET / — Get workspace configs ─── */
r.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const ws = await CustomerWorkspace.findById(workspaceId)
        .select("payrollConfig attendanceConfig")
        .lean();

      return res.json({
        payrollConfig: (ws as any)?.payrollConfig || {},
        attendanceConfig: (ws as any)?.attendanceConfig || {},
      });
    } catch (err) {
      return next(err);
    }
  }
);

export default r;
