// apps/backend/src/routes/password.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";

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

// No dedicated audit model/collection exists in this codebase — the generic
// audit(tag) middleware (middleware/audit.ts) is a no-op stub that logs
// nothing anywhere it's used (separate finding, not fixed here). The one
// REAL, working persistence pattern already in production is a raw insert
// into the "workspaceauditlogs" collection (see routes/leaves.ts and
// workers/leaveAccrual.worker.ts). Reused here rather than inventing a new
// mechanism or silently leaving this unlogged.
async function writePasswordResetAudit(entry: {
  actorId: string;
  actorEmail?: string;
  targetUserId: string;
  targetEmail?: string;
  workspaceId: string;
  crossTenant: boolean;
}) {
  try {
    const auditLogCollection = mongoose.connection.collection("workspaceauditlogs");
    await auditLogCollection.insertOne({
      workspaceId: entry.workspaceId,
      event: "ADMIN_PASSWORD_RESET",
      runAt: new Date(),
      triggeredBy: entry.actorEmail || entry.actorId,
      status: "SUCCESS",
      details: {
        actorId: entry.actorId,
        actorEmail: entry.actorEmail || null,
        targetUserId: entry.targetUserId,
        targetEmail: entry.targetEmail || null,
        crossTenant: entry.crossTenant,
      },
    });
  } catch (err) {
    // Audit failure must never block or silently mask the reset from the
    // caller's perspective, but it must be loud in the server logs.
    console.error("[password] failed to write admin-reset audit record", err);
  }
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

    const userId = req.user?._id || req.user?.id || req.user?.sub;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorised" });
    }

    // Self password change — find by userId only (no workspace check needed)
    const user = await User.findById(userId).exec();
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
/* POST /api/password/admin-set  (HR/Admin can reset a user in their own      */
/* workspace; SUPERADMIN may act cross-tenant ONLY via explicit              */
/* targetWorkspaceId — never an inherited side effect of requireWorkspace's  */
/* generic SUPERADMIN body/query/header bypass, which this route does not    */
/* trust for that reason).                                                    */
/* -------------------------------------------------------------------------- */

router.post("/admin-set", requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    if (!isHrmsAdmin(req.user)) {
      return res
        .status(403)
        .json({ error: "Only HR/Admin can set passwords for other users" });
    }

    const { userId, email, newPassword, targetWorkspaceId } = req.body as {
      userId?: string;
      email?: string;
      newPassword?: string;
      targetWorkspaceId?: string;
    };

    if (!userId && !email) {
      return res.status(400).json({ error: "userId or email is required" });
    }

    const pwError = validatePassword(newPassword || "");
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    const actorIsSuperAdmin = isSuperAdmin(req);
    let effectiveWorkspaceId: mongoose.Types.ObjectId;
    let crossTenant = false;

    if (actorIsSuperAdmin) {
      // Explicit only. Do NOT fall back to req.workspaceObjectId here — for
      // a SUPERADMIN caller that value can already be a side effect of
      // requireWorkspace's own body/query/x-workspace-id bypass, which is
      // exactly the ambient/inherited path this endpoint must not trust.
      if (!targetWorkspaceId) {
        return res.status(400).json({
          error: "SUPERADMIN must supply targetWorkspaceId explicitly to reset a password.",
        });
      }
      const targetWs = await CustomerWorkspace.findOne({
        _id: targetWorkspaceId,
        status: "ACTIVE",
      })
        .select("_id")
        .lean();
      if (!targetWs) {
        return res.status(404).json({ error: "targetWorkspaceId is not a valid, active workspace" });
      }
      effectiveWorkspaceId = targetWs._id as mongoose.Types.ObjectId;
      crossTenant = true; // every SUPERADMIN explicit-target reset is treated and logged as cross-tenant
    } else {
      // HR/Admin/HR_ADMIN: strictly the caller's own workspace, resolved
      // server-side by requireWorkspace from their token. targetWorkspaceId
      // in the body is ignored outright — no exceptions.
      effectiveWorkspaceId = req.workspaceObjectId;
    }

    const identifierFilter = userId
      ? { _id: userId }
      : {
          $or: [
            { email: String(email).toLowerCase() },
            { officialEmail: String(email).toLowerCase() },
            { personalEmail: String(email).toLowerCase() },
          ],
        };

    const user = await User.findOne({
      ...identifierFilter,
      workspaceId: effectiveWorkspaceId,
    }).exec();
    if (!user) {
      return res.status(404).json({ error: "User not found in the target workspace" });
    }

    const hash = await bcrypt.hash(String(newPassword), 10);
    (user as any).passwordHash = hash;
    await user.save();

    await writePasswordResetAudit({
      actorId: String(req.user?._id || req.user?.id || req.user?.sub || ""),
      actorEmail: req.user?.email,
      targetUserId: String(user._id),
      targetEmail: (user as any).email,
      workspaceId: String(effectiveWorkspaceId),
      crossTenant,
    });

    // Never echo the new password back.
    return res.json({ ok: true, userId: String(user._id) });
  } catch (err) {
    next(err);
  }
});

export default router;
