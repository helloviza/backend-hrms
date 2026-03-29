// apps/backend/src/routes/password.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { scopedFindById } from "../middleware/scopedFindById.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isHrmsAdmin(currentUser: any): boolean {
  if (!currentUser) return false;
  const roles: string[] = [];

  if (Array.isArray(currentUser.roles)) roles.push(...currentUser.roles);
  if (currentUser.role) roles.push(currentUser.role);
  if (currentUser.hrmsAccessLevel) roles.push(currentUser.hrmsAccessLevel);
  if (currentUser.hrmsAccessRole) roles.push(currentUser.hrmsAccessRole);

  const upper = roles.map((r) => String(r).toUpperCase());
  return (
    upper.includes("ADMIN") ||
    upper.includes("SUPER_ADMIN") ||
    upper.includes("SUPERADMIN") ||
    upper.includes("HR_ADMIN")
  );
}

function validatePassword(pw: string): string | null {
  if (!pw || typeof pw !== "string") return "Password is required";
  if (pw.length < 8) return "Password must be at least 8 characters long";
  // You can add more rules (numbers/special chars) later if you want.
  return null;
}

/* -------------------------------------------------------------------------- */
/* POST /api/password/change  (self-service)                                  */
/* -------------------------------------------------------------------------- */

router.post("/change", requireAuth, async (req: any, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: "Current password and new password are required" });
    }

    const pwError = validatePassword(newPassword);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorised" });
    }

    const user = await User.findOne({ _id: userId, workspaceId: req.workspaceId }).exec();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const ok = await bcrypt.compare(currentPassword, (user as any).passwordHash);
    if (!ok) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    (user as any).passwordHash = hash;
    await user.save();

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/password/admin-set  (HR/Admin can reset any user)                */
/* -------------------------------------------------------------------------- */

router.post("/admin-set", requireAuth, async (req: any, res, next) => {
  try {
    if (!isHrmsAdmin(req.user)) {
      return res
        .status(403)
        .json({ error: "Only HR/Admin can set passwords for other users" });
    }

    const { userId, newPassword } = req.body as {
      userId?: string;
      newPassword?: string;
    };

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const pwError = validatePassword(newPassword || "");
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    const user = await User.findOne({ _id: userId, workspaceId: req.workspaceId }).exec();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const hash = await bcrypt.hash(String(newPassword), 10);
    (user as any).passwordHash = hash;
    await user.save();

    return res.json({ ok: true, userId });
  } catch (err) {
    next(err);
  }
});

export default router;
