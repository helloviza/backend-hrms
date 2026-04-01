import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import WorkspaceInvite from "../models/WorkspaceInvite.js";
import { sendWorkspaceCredentials } from "../services/email.service.js";
import logger from "../utils/logger.js";
import requireAuth from "../middleware/auth.js";
import { env } from "../config/env.js";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// SUPERADMIN role check at router level
router.use((req: any, res, next) => {
  const roles = req.user?.roles || [];
  if (!roles.includes("SUPERADMIN")) return res.status(403).json({ error: "SUPERADMIN access required" });
  next();
});

/* ── Helpers ─────────────────────────────────────────────────────── */

function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generateTempPassword(length = 12): string {
  return crypto.randomBytes(Math.ceil(length * 0.75)).toString("base64").slice(0, length);
}

/* ── GET /workspaces ─────────────────────────────────────────────── */

router.get("/workspaces", async (req: any, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, parseInt(req.query.limit as string) || 20);
    const { search, plan, status } = req.query as Record<string, string>;

    const filter: Record<string, any> = {};
    if (search) filter.companyName = { $regex: search, $options: "i" };
    if (plan) filter.plan = plan;
    if (status) filter.status = status;

    const [workspaces, total] = await Promise.all([
      CustomerWorkspace.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CustomerWorkspace.countDocuments(filter),
    ]);

    const wsIds = workspaces.map((ws: any) => ws._id);

    // Batch: user counts per workspace
    const userCounts = await User.aggregate([
      { $match: { workspaceId: { $in: wsIds } } },
      { $group: { _id: "$workspaceId", count: { $sum: 1 } } },
    ]);
    const userCountMap = new Map(userCounts.map((u: any) => [String(u._id), u.count as number]));

    // Batch: admin user per workspace
    const adminUsers = await User.find({
      workspaceId: { $in: wsIds },
      $or: [
        { roles: { $in: ["WORKSPACE_ADMIN", "ADMIN", "SUPERADMIN"] } },
      ],
    })
      .select("workspaceId name firstName lastName email")
      .sort({ createdAt: 1 })
      .lean();

    const adminByWs = new Map<string, any>();
    for (const u of adminUsers) {
      const key = String((u as any).workspaceId);
      if (!adminByWs.has(key)) adminByWs.set(key, u);
    }

    const workspacesWithCounts = workspaces.map((ws: any) => {
      const admin = adminByWs.get(String(ws._id));
      const adminName = admin
        ? (admin.firstName && admin.lastName ? `${admin.firstName} ${admin.lastName}` : admin.name || admin.email)
        : "—";
      return {
        ...ws,
        companyName: ws.companyName
          || ws.name
          || (ws.allowedDomains?.length ? ws.allowedDomains[0].split(".")[0] : null)
          || (ws.allowedEmails?.length ? ws.allowedEmails[0].split("@")[1]?.split(".")[0] : null)
          || `Workspace ${ws.createdAt ? new Date(ws.createdAt).toLocaleDateString("en-IN", { month: "short", year: "numeric" }) : ""}`.trim(),
        adminName,
        adminEmail: admin?.email || "—",
        features: ws.config?.features || {},
        userCount: userCountMap.get(String(ws._id)) || 0,
      };
    });

    res.json({ workspaces: workspacesWithCounts, total, page, limit });
  } catch (err: any) {
    logger.error("GET /workspaces failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /workspaces ────────────────────────────────────────────── */

router.post("/workspaces", async (req: any, res) => {
  try {
    const { companyName, industry, employeeCount, adminEmail, adminName, plan, features, notes } =
      req.body as {
        companyName: string;
        industry?: string;
        employeeCount?: string;
        adminEmail: string;
        adminName: string;
        plan: "trial" | "starter" | "growth" | "enterprise";
        features?: Record<string, boolean>;
        notes?: string;
      };

    if (!companyName || !adminEmail || !adminName || !plan) {
      return res.status(400).json({ error: "companyName, adminEmail, adminName and plan are required" });
    }

    // Build customerId: slug + 6 random hex chars
    const customerId = `${slugify(companyName)}-${crypto.randomBytes(3).toString("hex")}`;

    // Resolve features for the plan, then apply any overrides
    const defaultFeatures = CustomerWorkspace.getDefaultFeaturesForPlan(plan);
    const mergedFeatures = { ...defaultFeatures, ...(features || {}) };

    const workspace = await CustomerWorkspace.create({
      customerId,
      companyName,
      industry,
      employeeCount,
      plan,
      notes,
      status: "ACTIVE",
      "config.features": mergedFeatures,
    });

    // Generate temp password and hash it
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await User.create({
      workspaceId: workspace._id,
      customerId,
      email: adminEmail,
      name: adminName,
      passwordHash,
      roles: ["WORKSPACE_ADMIN"],
      tempPassword: true,
    });

    // Send credentials email (best-effort)
    try {
      await sendWorkspaceCredentials(adminEmail, {
        companyName,
        loginUrl: `${env.FRONTEND_ORIGIN}/login`,
        tempPassword,
      });
    } catch (emailErr: any) {
      logger.warn("Failed to send workspace credentials email");
    }

    const userObj = user.toObject() as Record<string, any>;
    delete userObj.passwordHash;

    res.status(201).json({ workspace, user: userObj });
  } catch (err: any) {
    logger.error("POST /workspaces failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /workspaces/:workspaceId ────────────────────────────────── */

router.get("/workspaces/:workspaceId", async (req, res) => {
  try {
    const workspace = await CustomerWorkspace.findById(req.params.workspaceId).lean();
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const [userCount, inviteCount] = await Promise.all([
      User.countDocuments({ workspaceId: workspace._id }),
      WorkspaceInvite.countDocuments({ workspaceId: workspace._id }),
    ]);

    const admin = await User.findOne({
      workspaceId: workspace._id,
      $or: [{ roles: { $in: ["WORKSPACE_ADMIN", "ADMIN", "SUPERADMIN"] } }],
    })
      .select("name firstName lastName email")
      .sort({ createdAt: 1 })
      .lean();

    const adminName = admin
      ? ((admin as any).firstName && (admin as any).lastName
          ? `${(admin as any).firstName} ${(admin as any).lastName}`
          : (admin as any).name || (admin as any).email)
      : "—";

    const wsFlat = {
      ...(workspace as any),
      companyName: (workspace as any).companyName
        || (workspace as any).name
        || ((workspace as any).allowedDomains?.length ? (workspace as any).allowedDomains[0].split(".")[0] : null)
        || ((workspace as any).allowedEmails?.length ? (workspace as any).allowedEmails[0].split("@")[1]?.split(".")[0] : null)
        || `Workspace ${(workspace as any).createdAt ? new Date((workspace as any).createdAt).toLocaleDateString("en-IN", { month: "short", year: "numeric" }) : ""}`.trim(),
      adminName,
      adminEmail: (admin as any)?.email || "—",
      features: (workspace as any).config?.features || {},
    };
    res.json({ workspace: wsFlat, userCount, inviteCount });
  } catch (err: any) {
    logger.error("GET /workspaces/:workspaceId failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── PUT /workspaces/:workspaceId ────────────────────────────────── */

router.put("/workspaces/:workspaceId", async (req, res) => {
  try {
    const ALLOWED_FIELDS = [
      "status", "name", "config", "travelMode",
      "allowedDomains", "plan", "notes",
    ];
    const safeUpdate: Record<string, any> = {};
    for (const key of ALLOWED_FIELDS) {
      if (req.body[key] !== undefined) {
        safeUpdate[key] = req.body[key];
      }
    }

    const workspace = await CustomerWorkspace.findByIdAndUpdate(
      req.params.workspaceId,
      { $set: safeUpdate },
      { new: true, runValidators: true },
    );
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    res.json({ workspace });
  } catch (err: any) {
    logger.error("PUT /workspaces/:workspaceId failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── PUT /workspaces/:workspaceId/features ───────────────────────── */

router.put("/workspaces/:workspaceId/features", async (req: any, res) => {
  try {
    const { feature, enabled } = req.body as { feature: string; enabled: boolean };
    if (!feature || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "feature (string) and enabled (boolean) are required" });
    }

    const $set: Record<string, any> = { [`config.features.${feature}`]: enabled };

    // Keep travelFlow in sync when toggling approval/SBT features
    if (feature === "approvalFlowEnabled" && enabled) {
      $set["config.features.sbtEnabled"] = false;
      $set["config.travelFlow"] = "APPROVAL_FLOW";
    } else if (feature === "approvalDirectEnabled" && enabled) {
      $set["config.features.approvalFlowEnabled"] = true;
      $set["config.features.sbtEnabled"] = false;
      $set["config.travelFlow"] = "APPROVAL_DIRECT";
    } else if (feature === "sbtEnabled" && enabled) {
      $set["config.features.approvalFlowEnabled"] = false;
      $set["config.features.approvalDirectEnabled"] = false;
      $set["config.travelFlow"] = "SBT";
    }

    const workspace = await CustomerWorkspace.findByIdAndUpdate(
      req.params.workspaceId,
      { $set },
      { new: true },
    );
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    logger.info("SUPERADMIN toggled workspace feature", {
      workspaceId: req.params.workspaceId,
      customerId: workspace.customerId,
      feature,
      enabled,
      changedBy: (req as any).user?._id,
    });

    res.json({
      success: true,
      workspace: {
        _id: workspace._id,
        config: { features: workspace.config.features },
      },
    });
  } catch (err: any) {
    logger.error("PUT /workspaces/:workspaceId/features failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── PUT /workspaces/:workspaceId/official-booking ─────────────── */

router.put("/workspaces/:workspaceId/official-booking", async (req: any, res) => {
  try {
    const { enabled, monthlyLimit } = req.body as { enabled?: boolean; monthlyLimit?: number };

    const update: Record<string, any> = {};
    if (typeof enabled === "boolean") update["sbtOfficialBooking.enabled"] = enabled;
    if (typeof monthlyLimit === "number" && monthlyLimit >= 0) update["sbtOfficialBooking.monthlyLimit"] = monthlyLimit;

    const workspace = await CustomerWorkspace.findByIdAndUpdate(
      req.params.workspaceId,
      { $set: update },
      { new: true, runValidators: false },
    ).select("sbtOfficialBooking").lean();

    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    logger.info("SUPERADMIN updated official booking config", {
      workspaceId: req.params.workspaceId,
      enabled,
      monthlyLimit,
      changedBy: req.user?._id,
    });

    res.json({ success: true, sbtOfficialBooking: (workspace as any).sbtOfficialBooking });
  } catch (err: any) {
    logger.error("PUT /workspaces/:workspaceId/official-booking failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /workspaces/:workspaceId/reset-spend ───────────────────── */

router.post("/workspaces/:workspaceId/reset-spend", async (req: any, res) => {
  try {
    const monthKey = new Date().toISOString().slice(0, 7);
    const workspace = await CustomerWorkspace.findOneAndUpdate(
      { _id: req.params.workspaceId },
      { $set: {
        'sbtOfficialBooking.currentMonthSpend': 0,
        'sbtOfficialBooking.lastResetMonth': monthKey,
      }},
      { new: true, runValidators: false },
    );
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    logger.info("SUPERADMIN reset monthly spend", {
      workspaceId: req.params.workspaceId,
      resetBy: req.user?._id,
    });

    res.json({ success: true, message: "Monthly spend reset to 0" });
  } catch (err: any) {
    logger.error("POST /workspaces/:workspaceId/reset-spend failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /workspaces/:workspaceId/impersonate ───────────────────── */

router.post("/workspaces/:workspaceId/impersonate", async (req: any, res) => {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: "reason is required" });
    }

    const workspace = await CustomerWorkspace.findById(req.params.workspaceId).lean();
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const token = jwt.sign(
      {
        sub: "superadmin-impersonation",
        customerId: workspace.customerId,
        roles: ["SUPERADMIN"],
        _impersonating: true,
      },
      env.JWT_SECRET,
      { expiresIn: "1h" },
    );

    logger.info("SUPERADMIN impersonated workspace", {
      impersonatedBy: (req as any).user?._id,
      workspaceId: workspace._id,
      customerId: workspace.customerId,
      companyName: workspace.companyName,
      reason,
    });

    res.json({ token });
  } catch (err: any) {
    logger.error("POST /workspaces/:workspaceId/impersonate failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /workspaces/:workspaceId ─────────────────────────────── */

router.delete("/workspaces/:workspaceId", async (req, res) => {
  try {
    const workspace = await CustomerWorkspace.findByIdAndUpdate(
      req.params.workspaceId,
      { $set: { status: "DELETED" } },
      { new: true },
    );
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    res.json({ success: true, workspaceId: workspace._id, status: workspace.status });
  } catch (err: any) {
    logger.error("DELETE /workspaces/:workspaceId failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /stats ──────────────────────────────────────────────────── */

router.get("/stats", async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [
      totalWorkspaces,
      activeWorkspaces,
      trialWorkspaces,
      totalUsers,
      createdThisMonth,
      trialsExpiringSoon,
      topWorkspaces,
      planBreakdown,
    ] = await Promise.all([
        // Total non-deleted workspaces
        CustomerWorkspace.countDocuments({ status: { $ne: "DELETED" } }),

        // Active workspaces (by status, not plan)
        CustomerWorkspace.countDocuments({ status: "ACTIVE" }),

        // Trial workspaces: status ACTIVE + plan is trial or missing
        CustomerWorkspace.countDocuments({
          status: "ACTIVE",
          $or: [{ plan: "trial" }, { plan: { $exists: false } }, { plan: null }],
        }),

        // Total users across all workspaces
        User.countDocuments({ workspaceId: { $exists: true, $ne: null } }),

        // Workspaces created this month
        CustomerWorkspace.countDocuments({ createdAt: { $gte: startOfMonth } }),

        // Trials expiring in next 7 days
        CustomerWorkspace.countDocuments({
          status: "ACTIVE",
          plan: "trial",
          trialEndsAt: { $gte: now, $lte: in7Days },
        }),

        // Top 5 workspaces by user count
        User.aggregate([
          { $match: { workspaceId: { $exists: true } } },
          { $group: { _id: "$workspaceId", userCount: { $sum: 1 } } },
          { $sort: { userCount: -1 } },
          { $limit: 5 },
          {
            $lookup: {
              from: "customerworkspaces",
              localField: "_id",
              foreignField: "_id",
              as: "workspace",
            },
          },
          { $unwind: { path: "$workspace", preserveNullAndEmptyArrays: false } },
          {
            $project: {
              _id: "$workspace._id",
              customerId: "$workspace.customerId",
              companyName: "$workspace.companyName",
              plan: "$workspace.plan",
              userCount: 1,
            },
          },
        ]),

        // Plan breakdown (for reference)
        CustomerWorkspace.aggregate([
          { $match: { status: { $ne: "DELETED" } } },
          { $group: { _id: "$plan", count: { $sum: 1 } } },
        ]),
      ]);

    res.json({
      totalWorkspaces,
      activeWorkspaces,
      trialWorkspaces,
      totalUsers,
      createdThisMonth,
      trialsExpiringSoon,
      topWorkspaces,
      planBreakdown,
    });
  } catch (err: any) {
    logger.error("GET /stats failed");
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /users ──────────────────────────────────────────────────── */

router.get("/users", async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = (req.query.search as string) || "";
    const workspaceId = (req.query.workspace as string) || "";

    const filter: any = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }
    if (workspaceId) {
      filter.workspaceId = new mongoose.Types.ObjectId(workspaceId);
    }

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select(
        "name email roles sbtRole workspaceId status lastLoginAt createdAt isActive officialEmail sbtEnabled activatedByAdmin",
      )
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Enrich with workspace name
    const wsIds = [
      ...new Set(
        users
          .map((u: any) => u.workspaceId?.toString())
          .filter(Boolean),
      ),
    ];
    const workspaces = await CustomerWorkspace.find({ _id: { $in: wsIds } })
      .select("companyName")
      .lean();
    const wsMap: Record<string, string> = Object.fromEntries(
      workspaces.map((w: any) => [w._id.toString(), w.companyName || "Unknown"]),
    );

    return res.json({
      users: users.map((u: any) => ({
        ...u,
        workspaceName: wsMap[u.workspaceId?.toString() || ""] || "No workspace",
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    logger.error("GET /users failed");
    res.status(500).json({ error: err.message });
  }
});

export default router;
