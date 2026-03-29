import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import Department from "../models/Department.js";
import Designation from "../models/Designation.js";
import User from "../models/User.js";

const router = Router();

/* ── Helpers ─────────────────────────────────────────────────────── */

function isHrAdmin(user: any): boolean {
  if (!user) return false;
  const roles: string[] = [
    ...(Array.isArray(user.roles) ? user.roles : []),
    ...(user.role ? [user.role] : []),
    ...(user.hrmsAccessRole ? [user.hrmsAccessRole] : []),
  ].map((r) => String(r || "").toUpperCase());
  return (
    roles.includes("ADMIN") ||
    roles.includes("SUPERADMIN") ||
    roles.includes("HR") ||
    roles.includes("HR_ADMIN") ||
    roles.includes("MANAGER")
  );
}

function isWriteRole(user: any): boolean {
  if (!user) return false;
  const roles: string[] = [
    ...(Array.isArray(user.roles) ? user.roles : []),
    ...(user.role ? [user.role] : []),
    ...(user.hrmsAccessRole ? [user.hrmsAccessRole] : []),
  ].map((r) => String(r || "").toUpperCase());
  return (
    roles.includes("ADMIN") ||
    roles.includes("SUPERADMIN") ||
    roles.includes("HR") ||
    roles.includes("HR_ADMIN")
  );
}

/* ══════════════════════════════════════════════════════════════════
   DEPARTMENTS
   ══════════════════════════════════════════════════════════════════ */

/** GET /departments — list active departments with headcount */
router.get(
  "/departments",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      if (!isHrAdmin((req as any).user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const wsId = req.workspaceObjectId;
      const showAll = req.query.all === "true";
      const filter: any = { workspaceId: wsId };
      if (!showAll) filter.isActive = true;

      const departments = await Department.find(filter).sort({ name: 1 }).lean();

      // Compute headcount per department from User collection
      const headcounts = await User.aggregate([
        { $match: { workspaceId: wsId, status: { $ne: "INACTIVE" } } },
        { $group: { _id: "$department", count: { $sum: 1 } } },
      ]);
      const hcMap = new Map(headcounts.map((h: any) => [h._id, h.count]));

      const result = departments.map((d: any) => ({
        ...d,
        headcount: hcMap.get(d.name) || 0,
      }));

      res.json(result);
    } catch (err) {
      console.error("[masterData.departments] GET /departments error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** POST /departments — create department */
router.post(
  "/departments",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      if (!isWriteRole((req as any).user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { name, code, description, managerId, parentDepartmentId } = req.body as any;
      if (!name || !String(name).trim()) {
        res.status(400).json({ error: "Department name is required" });
        return;
      }

      const user = (req as any).user;
      const dept = await Department.create({
        workspaceId: req.workspaceObjectId,
        name: String(name).trim(),
        code: code ? String(code).trim() : undefined,
        description: description ? String(description).trim() : undefined,
        managerId: managerId || undefined,
        parentDepartmentId: parentDepartmentId || undefined,
        createdBy: user._id ?? user.id ?? user.sub,
      });

      res.status(201).json(dept);
    } catch (err: any) {
      if (err?.code === 11000) {
        res.status(409).json({ error: "A department with this name already exists" });
        return;
      }
      console.error("[masterData.departments] POST /departments error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** PUT /departments/:id — update department */
router.put(
  "/departments/:id",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      if (!isWriteRole((req as any).user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { id } = req.params;
      const { name, code, description, managerId, parentDepartmentId, isActive } = req.body as any;

      const dept = await Department.findOne({ _id: id, workspaceId: req.workspaceObjectId });
      if (!dept) {
        res.status(404).json({ error: "Department not found" });
        return;
      }

      if (name !== undefined) dept.name = String(name).trim();
      if (code !== undefined) dept.code = String(code).trim();
      if (description !== undefined) dept.description = String(description).trim();
      if (managerId !== undefined) dept.managerId = managerId || undefined;
      if (parentDepartmentId !== undefined) dept.parentDepartmentId = parentDepartmentId || undefined;
      if (isActive !== undefined) dept.isActive = Boolean(isActive);

      await dept.save();
      res.json(dept);
    } catch (err: any) {
      if (err?.code === 11000) {
        res.status(409).json({ error: "A department with this name already exists" });
        return;
      }
      console.error("[masterData.departments] PUT /departments/:id error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** DELETE /departments/:id — soft delete (set isActive: false) */
router.delete(
  "/departments/:id",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      if (!isWriteRole((req as any).user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { id } = req.params;
      const dept = await Department.findOne({ _id: id, workspaceId: req.workspaceObjectId });
      if (!dept) {
        res.status(404).json({ error: "Department not found" });
        return;
      }

      // Check if any active users have this department
      const usersCount = await User.countDocuments({
        workspaceId: req.workspaceObjectId,
        department: dept.name,
        status: { $ne: "INACTIVE" },
      });

      if (usersCount > 0) {
        res.status(400).json({
          error: `Cannot deactivate: ${usersCount} active employee(s) belong to this department`,
          activeCount: usersCount,
        });
        return;
      }

      dept.isActive = false;
      await dept.save();
      res.json({ success: true });
    } catch (err) {
      console.error("[masterData.departments] DELETE /departments/:id error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ══════════════════════════════════════════════════════════════════
   DESIGNATIONS
   ══════════════════════════════════════════════════════════════════ */

/** GET /designations — list active designations */
router.get(
  "/designations",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      if (!isHrAdmin((req as any).user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const wsId = req.workspaceObjectId;
      const showAll = req.query.all === "true";
      const filter: any = { workspaceId: wsId };
      if (!showAll) filter.isActive = true;
      if (req.query.department) filter.department = String(req.query.department);

      const designations = await Designation.find(filter).sort({ level: 1, name: 1 }).lean();
      res.json(designations);
    } catch (err) {
      console.error("[masterData.departments] GET /designations error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** POST /designations — create designation */
router.post(
  "/designations",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      if (!isWriteRole((req as any).user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { name, department, level } = req.body as any;
      if (!name || !String(name).trim()) {
        res.status(400).json({ error: "Designation name is required" });
        return;
      }

      const user = (req as any).user;
      const desig = await Designation.create({
        workspaceId: req.workspaceObjectId,
        name: String(name).trim(),
        department: department ? String(department).trim() : undefined,
        level: level != null ? Number(level) : undefined,
        createdBy: user._id ?? user.id ?? user.sub,
      });

      res.status(201).json(desig);
    } catch (err: any) {
      if (err?.code === 11000) {
        res.status(409).json({ error: "A designation with this name already exists" });
        return;
      }
      console.error("[masterData.departments] POST /designations error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** PUT /designations/:id — update designation */
router.put(
  "/designations/:id",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      if (!isWriteRole((req as any).user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { id } = req.params;
      const { name, department, level, isActive } = req.body as any;

      const desig = await Designation.findOne({ _id: id, workspaceId: req.workspaceObjectId });
      if (!desig) {
        res.status(404).json({ error: "Designation not found" });
        return;
      }

      if (name !== undefined) desig.name = String(name).trim();
      if (department !== undefined) desig.department = String(department).trim();
      if (level !== undefined) desig.level = Number(level);
      if (isActive !== undefined) desig.isActive = Boolean(isActive);

      await desig.save();
      res.json(desig);
    } catch (err: any) {
      if (err?.code === 11000) {
        res.status(409).json({ error: "A designation with this name already exists" });
        return;
      }
      console.error("[masterData.departments] PUT /designations/:id error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** DELETE /designations/:id — soft delete */
router.delete(
  "/designations/:id",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      if (!isWriteRole((req as any).user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { id } = req.params;
      const desig = await Designation.findOne({ _id: id, workspaceId: req.workspaceObjectId });
      if (!desig) {
        res.status(404).json({ error: "Designation not found" });
        return;
      }

      desig.isActive = false;
      await desig.save();
      res.json({ success: true });
    } catch (err) {
      console.error("[masterData.departments] DELETE /designations/:id error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ══════════════════════════════════════════════════════════════════
   COMBINED — GET /all
   ══════════════════════════════════════════════════════════════════ */

/** GET /all — returns both departments and designations for form dropdowns */
router.get(
  "/all",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const wsId = req.workspaceObjectId;
      const [departments, designations] = await Promise.all([
        Department.find({ workspaceId: wsId, isActive: true }).sort({ name: 1 }).lean(),
        Designation.find({ workspaceId: wsId, isActive: true }).sort({ level: 1, name: 1 }).lean(),
      ]);
      res.json({ departments, designations });
    } catch (err) {
      console.error("[masterData.departments] GET /all error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
