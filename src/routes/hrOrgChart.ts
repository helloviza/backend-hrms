// apps/backend/src/routes/hrOrgChart.ts
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import EmployeeModel from "../models/Employee.js";

const router = express.Router();

// Helper: check if user has HR/Admin/SuperAdmin privileges
function hasOrgManageRights(user: any): boolean {
  if (!user) return false;

  const collected: string[] = [];

  if (Array.isArray(user.roles)) collected.push(...user.roles);

  const singleCandidates = [
    user.role,
    user.roleType,
    user.roleName,
    user.userRole,
    user.profile?.role,
    user.hrmsAccessRole,
  ];

  for (const r of singleCandidates) {
    if (r) collected.push(r);
  }

  if (!collected.length) collected.push("EMPLOYEE");

  return collected.some((r: string) => {
    const v = String(r).toUpperCase().trim().replace(/[\s_-]+/g, "");
    return v === "HR" || v === "ADMIN" || v === "SUPERADMIN";
  });
}

/**
 * GET /api/hr/org-chart
 * Returns a flat list of employees; frontend builds the tree.
 */
router.get(
  "/org-chart",
  requireAuth as any,
  async (req: any, res: any, next: any) => {
    try {
      const employees = await EmployeeModel.find(
        {
          // treat isActive=false as hidden if field exists
          $or: [{ isActive: { $ne: false } }, { isActive: { $exists: false } }],
        },
        {
          // projection: keep the payload lean but useful
          name: 1,
          fullName: 1,
          firstName: 1,
          lastName: 1,
          title: 1,
          jobTitle: 1,
          designation: 1,
          department: 1,
          dept: 1,
          function: 1,
          managerId: 1,
          reportsToId: 1,
          reportingManagerId: 1,
          manager: 1,
          avatarUrl: 1,
          avatar: 1,
          photoUrl: 1,
          profileImage: 1,
          officialEmail: 1,
          companyEmail: 1,
          userId: 1,
        },
      )
        .lean()
        .exec();

      res.json({ items: employees || [] });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/hr/org-chart/map
 * Body: { employeeId, managerId | null }
 * Only HR/Admin/SuperAdmin can update reporting lines.
 */
router.post(
  "/org-chart/map",
  requireAuth as any,
  async (req: any, res: any, next: any) => {
    try {
      const { employeeId, managerId } = req.body || {};

      if (!employeeId) {
        return res.status(400).json({ error: "employeeId is required" });
      }

      if (!hasOrgManageRights(req.user)) {
        return res.status(403).json({
          error: "You do not have permission to update org mappings",
        });
      }

      const emp = await EmployeeModel.findById(employeeId);
      if (!emp) {
        return res.status(404).json({ error: "Employee not found" });
      }

      let finalManagerId: any = null;

      if (managerId) {
        // Validate manager exists
        const mgr = await EmployeeModel.findById(managerId);
        if (!mgr) {
          return res.status(400).json({ error: "Manager not found" });
        }
        finalManagerId = mgr._id;
      }

      // Try to use whichever field already exists on this document.
      const candidateFields = [
        "managerId",
        "reportsToId",
        "reportingManagerId",
        "manager",
      ];

      let targetField = candidateFields.find(
        (f) => (emp as any)[f] !== undefined,
      );

      if (!targetField) {
        // fall back to managerId if nothing exists – schema may still accept it
        targetField = "managerId";
      }

      // If the existing field is an ObjectId, cast accordingly
      const currentValue = (emp as any)[targetField];
      if (
        currentValue instanceof mongoose.Types.ObjectId ||
        (Array.isArray(currentValue) &&
          currentValue[0] instanceof mongoose.Types.ObjectId)
      ) {
        (emp as any)[targetField] = finalManagerId
          ? new mongoose.Types.ObjectId(finalManagerId)
          : null;
      } else {
        (emp as any)[targetField] = finalManagerId || null;
      }

      await emp.save();

      res.json({
        ok: true,
        employeeId: emp._id,
        managerId: finalManagerId,
        field: targetField,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
