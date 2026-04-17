// apps/backend/src/routes/signup.ts
// Public self-service signup endpoints — NO requireAuth
import { Router } from "express";
import bcrypt from "bcryptjs";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import { UserPermission } from "../models/UserPermission.js";
import WorkspaceInvite from "../models/WorkspaceInvite.js";
import { sendMail } from "../utils/mailer.js";
import { buildEmailShell, escapeHtml } from "./approvals.email.js";
import {
  generateSlug,
  ensureUniqueSlug,
  provisionNewTenant,
} from "../services/tenantProvisioning.js";
import { env } from "../config/env.js";
import { sbtLogger } from "../utils/logger.js";

const router = Router();

/* ── POST /api/signup/check-email ────────────────────────────────── */
router.post("/check-email", async (req, res) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email required" });
    }
    const exists = await User.exists({ email: email.toLowerCase().trim() });
    return res.json({ available: !exists });
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

/* ── POST /api/signup ────────────────────────────────────────────── */
router.post("/", async (req, res) => {
  try {
    const {
      companyName,
      adminName,
      email,
      password,
      phone,
      industry,
      employeeCount,
      plan,
      gst,
    } = req.body as {
      companyName?: string;
      adminName?: string;
      email?: string;
      password?: string;
      phone?: string;
      industry?: string;
      employeeCount?: string;
      plan?: string;
      gst?: string;
    };

    console.log('[SIGNUP] Received:', { companyName, email, plan, employeeCount, industry });

    // Validation
    if (!companyName || String(companyName).trim().length < 2) {
      return res.status(400).json({ error: "Company name must be at least 2 characters" });
    }
    if (!adminName || !String(adminName).trim()) {
      return res.status(400).json({ error: "Admin name is required" });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ error: "Valid email is required" });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // Check email uniqueness
    const exists = await User.exists({ email: normalizedEmail });
    if (exists) {
      return res.status(409).json({ error: "Email already registered" });
    }

    // Map plan — "pro" displayed on frontend is stored as "growth" in schema
    const PLAN_MAP: Record<string, string> = {
      trial: "trial",
      starter: "starter",
      pro: "growth",
      growth: "growth",
      enterprise: "enterprise",
    };
    const resolvedPlan = PLAN_MAP[String(plan || "trial")] ?? "trial";

    // Generate slug
    const baseSlug = generateSlug(String(companyName).trim());
    const slug = await ensureUniqueSlug(baseSlug, CustomerWorkspace);

    // Generate customerId
    const customerId = `${slug}-${Math.random().toString(36).slice(2, 8)}`;

    const defaultFeatures = CustomerWorkspace.getDefaultFeaturesForPlan(resolvedPlan);

    // Trial ends 30 days from now
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30);

    const workspace = await CustomerWorkspace.create({
      customerId,
      companyName: String(companyName).trim(),
      phone: String(phone).trim(),
      industry: industry || undefined,
      employeeCount: employeeCount || undefined,
      gstNumber: gst,
      plan: resolvedPlan,
      status: "ACTIVE",
      source: "SELF_SERVICE",
      slug,
      trialEndsAt,
      "config.features": defaultFeatures,
    });

    const passwordHash = await bcrypt.hash(String(password), 12);

    const user = await User.create({
      workspaceId: workspace._id,
      email: normalizedEmail,
      name: String(adminName).trim(),
      passwordHash,
      roles: ["TENANT_ADMIN", "WORKSPACE_LEADER"],
      hrmsAccessRole: "L0",
      hrmsAccessLevel: "L0",
      accountType: "STAFF",
      status: "ACTIVE",
    });

    workspace.adminUserId = user._id as any;
    await workspace.save();

    const allModules = [
      "dashboard", "employees", "leaves", "attendance",
      "payroll", "onboarding", "vendors", "customers",
      "reports", "analytics", "settings", "permissions",
      "profile", "myBookings", "myInvoices", "sbt",
      "billing", "access",
    ];

    const fullAccess = { access: "FULL", scope: "ALL" } as const;
    const tenantAdminModules = {
      myProfile: fullAccess, attendance: fullAccess, leaves: fullAccess,
      leaveApprovals: fullAccess, holidays: fullAccess, holidayManagement: fullAccess,
      orgChart: fullAccess, policies: fullAccess, teamProfiles: fullAccess,
      teamPresence: fullAccess, teamCalendar: fullAccess, hrWorkspace: fullAccess,
      onboarding: fullAccess, people: fullAccess, masterData: fullAccess,
      payroll: fullAccess, payrollAdmin: fullAccess,
      adminQueue: fullAccess, manualBookings: fullAccess, invoices: fullAccess,
      reports: fullAccess, companySettings: fullAccess, adminVouchers: fullAccess,
      voucherExtract: fullAccess,
      analytics: fullAccess, workspaceSettings: fullAccess, accessConsole: fullAccess,
      sbt: fullAccess, sbtSearch: fullAccess, sbtBookings: fullAccess,
      sbtRequest: fullAccess, approvals: fullAccess, travelSpend: fullAccess,
      vendorProfile: fullAccess,
    };

    await UserPermission.create({
      userId: user._id.toString(),
      email: normalizedEmail,
      workspaceId: workspace._id.toString(),
      universe: "STAFF",
      level: { code: "L0", name: "Workspace Admin" },
      tier: 3,
      roleType: "SUPERADMIN",
      grantedModules: allModules,
      modules: tenantAdminModules,
      grantedBy: user._id.toString(),
      source: "system",
      status: "active",
    });

    // Fire-and-forget provisioning
    provisionNewTenant(
      workspace._id.toString(),
      workspace.customerId,
      slug,
    ).catch((err) => sbtLogger.error("[TENANT PROVISION ERROR]", { err }));

    // Welcome email (non-blocking)
    const loginUrl = String(env.FRONTEND_ORIGIN || "https://plumbox.plumtrips.com");
    const planLabel = resolvedPlan.charAt(0).toUpperCase() + resolvedPlan.slice(1);
    const emailContent = `
      <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;">
        <tr><td style="padding:8px 0;border-bottom:1px solid #f0f4f8;">
          <span style="color:#64748b;font-size:13px;">Company</span><br/>
          <span style="font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(String(companyName).trim())}</span>
        </td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #f0f4f8;">
          <span style="color:#64748b;font-size:13px;">Plan</span><br/>
          <span style="font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(planLabel)}</span>
        </td></tr>
        <tr><td style="padding:8px 0;">
          <span style="color:#64748b;font-size:13px;">Login URL</span><br/>
          <span style="font-size:14px;color:#4f46e5;">${escapeHtml(loginUrl)}</span>
        </td></tr>
      </table>
      <div style="margin-top:24px;text-align:center;">
        <a href="${loginUrl}"
           style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;
                  padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;">
          Go to Dashboard
        </a>
      </div>
    `;

    const html = buildEmailShell(emailContent, {
      title: "Your workspace is ready",
      badgeText: "ACTIVE",
      badgeColor: "#10b981",
    });

    sendMail({
      kind: "ONBOARDING",
      to: normalizedEmail,
      subject: "Welcome to Plumbox — Your workspace is ready",
      html,
    }).catch(() => {/* non-fatal */});

    return res.status(201).json({
      ok: true,
      message: "Workspace created",
      email: normalizedEmail,
      companyName: String(companyName).trim(),
      slug,
    });
  } catch (err: any) {
    console.error('[SIGNUP ERROR]', {
      message: err?.message,
      name: err?.name,
      errors: err?.errors,
      stack: err?.stack?.split('\n').slice(0, 5),
    });
    return res.status(500).json({ error: "Signup failed", detail: err?.message });
  }
});

/* ── POST /api/signup/invite/accept ──────────────────────────────── */
router.post("/invite/accept", async (req, res) => {
  try {
    const { token, password } = req.body as { token?: string; password?: string };
    if (!token || !password) {
      return res.status(400).json({ error: "token and password are required" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const invite = await WorkspaceInvite.findOne({ token: String(token) });
    if (!invite) {
      return res.status(400).json({ error: "Invalid or expired invite link" });
    }
    if (invite.status !== "pending") {
      return res.status(400).json({ error: "This invite has already been used or revoked" });
    }
    if (invite.expiresAt < new Date()) {
      invite.status = "expired";
      await invite.save();
      return res.status(400).json({ error: "This invite link has expired" });
    }

    const user = await User.findOne({ email: invite.email });
    if (!user) {
      return res.status(400).json({ error: "No account found for this invite" });
    }

    user.passwordHash = await bcrypt.hash(String(password), 12);
    (user as any).status = "ACTIVE";
    await user.save();

    invite.status = "accepted";
    invite.acceptedAt = new Date();
    await invite.save();

    return res.json({ ok: true, email: invite.email });
  } catch (err: any) {
    sbtLogger.error("[INVITE ACCEPT] Error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

export default router;
