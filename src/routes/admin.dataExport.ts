// apps/backend/src/routes/admin.dataExport.ts
// DPDP Act 2023 — Data portability export endpoint

import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRoles } from "../middleware/roles.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import logger from "../utils/logger.js";

import Employee from "../models/Employee.js";
import User from "../models/User.js";
import Leave from "../models/Leave.js";
import LeaveRequest from "../models/LeaveRequest.js";
import LeaveBalance from "../models/LeaveBalance.js";
import Attendance from "../models/Attendance.js";
import Document from "../models/Document.js";

const router = express.Router();
const MAX_DOCS_PER_COLLECTION = 10_000;

const EXPORTABLE_COLLECTIONS: Record<string, any> = {
  employees: Employee,
  users: User,
  leaves: Leave,
  leaveRequests: LeaveRequest,
  leaveBalances: LeaveBalance,
  attendance: Attendance,
  documents: Document,
};

/**
 * POST /api/admin/workspace/export-data
 *
 * Exports all workspace-scoped data for DPDP Act 2023 compliance.
 * Requires SUPERADMIN or ADMIN role.
 */
router.post(
  "/workspace/export-data",
  requireAuth,
  requireWorkspace,
  requireRoles("SUPERADMIN", "ADMIN"),
  async (req: any, res, next) => {
    try {
      const { workspaceId } = req;
      const requestedCollections: string[] | undefined = req.body?.collections;

      const collectionsToExport = requestedCollections?.length
        ? requestedCollections.filter((c) => EXPORTABLE_COLLECTIONS[c])
        : Object.keys(EXPORTABLE_COLLECTIONS);

      const data: Record<string, any[]> = {};

      for (const name of collectionsToExport) {
        const model = EXPORTABLE_COLLECTIONS[name];
        if (!model) continue;

        data[name] = await model
          .find({ workspaceId })
          .select("-passwordHash -resetTokenHash -resetTokenExpiry")
          .limit(MAX_DOCS_PER_COLLECTION)
          .lean();
      }

      // Audit log
      logger.info("Data export executed", {
        exportedBy: req.user?.email || req.user?.sub,
        workspaceId,
        collections: collectionsToExport,
        exportedAt: new Date().toISOString(),
      });

      res.json({
        exportedAt: new Date().toISOString(),
        workspaceId,
        collections: collectionsToExport,
        data,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
