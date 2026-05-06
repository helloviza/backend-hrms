// apps/backend/src/routes/saas.signup.ts
// SaaS HRMS self-service signup — separate from Travel workspace signup (auth.signup.ts / signup.ts)
import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";

import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { UserPermission } from "../models/UserPermission.js";
import { sendMail } from "../utils/mailer.js";
import { buildEmailShell, escapeHtml } from "./approvals.email.js";
import { generateSlug, ensureUniqueSlug } from "../services/tenantProvisioning.js";
import { env } from "../config/env.js";
import TenantSetupProgress from "../models/TenantSetupProgress.js";

const r = Router();

const SaasSignupSchema = z.object({
  companyName: z.string().min(2, "Company name is required"),
  adminEmail: z.string().email("Valid email is required"),
  adminName: z.string().min(1, "Admin name is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  industry: z.string().optional(),
  employeeCount: z.string().optional(),
});

/* ───────────────────────────────────────────────
 * POST /api/saas/signup
 * ─────────────────────────────────────────────── */
r.post("/signup", async (req, res) => {
  try {
    const parse = SaasSignupSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Validation failed", details: parse.error.flatten() });
    }

    const { companyName, adminEmail, adminName, password, industry, employeeCount } = parse.data;
    const normalizedEmail = adminEmail.toLowerCase().trim();

    // 1. Check email uniqueness across all workspaces
    const exists = await User.exists({ email: normalizedEmail });
    if (exists) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    // 2. Generate slug and customerId (slug + 6-char hex, same pattern as auth.signup.ts)
    const baseSlug = generateSlug(companyName.trim());
    const slug = await ensureUniqueSlug(baseSlug, CustomerWorkspace);
    const customerId = `${slug}-${crypto.randomBytes(3).toString("hex")}`;

    // 3. Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // 4. Default features for trial
    const features = CustomerWorkspace.getDefaultFeaturesForPlan("trial");

    // 5. Create workspace — tenantType: "SAAS_HRMS" is the key differentiator from Travel workspaces
    const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const workspace = await CustomerWorkspace.create({
      customerId,
      slug,
      companyName: companyName.trim(),
      industry: industry || undefined,
      employeeCount: employeeCount || undefined,
      tenantType: "SAAS_HRMS",
      plan: "trial",
      trialEndsAt,
      status: "ACTIVE",
      source: "SELF_SERVICE",
      onboardingStep: "registered",
      accessMode: "INVITE_ONLY",
      "config.features": features,
    });

    // 6. Create admin user
    const user = await User.create({
      workspaceId: workspace._id,
      email: normalizedEmail,
      name: adminName.trim(),
      passwordHash,
      roles: ["TENANT_ADMIN", "WORKSPACE_LEADER"],
      hrmsAccessRole: "L0",
      hrmsAccessLevel: "L0",
      accountType: "STAFF",
      status: "ACTIVE",
    });

    // 7. Create UserPermission with full module access
    const fullAccess = { access: "FULL", scope: "ALL" } as const;
    const allModules = [
      "dashboard", "employees", "leaves", "attendance",
      "payroll", "onboarding", "vendors", "customers",
      "reports", "analytics", "settings", "permissions",
      "profile", "myBookings", "myInvoices", "sbt",
      "billing", "access",
    ];
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

    // 8. Set adminUserId and save
    workspace.adminUserId = user._id as any;
    await workspace.save();

    // 9. Initialize TenantSetupProgress for this new SaaS HRMS tenant
    await TenantSetupProgress.create({
      workspaceId: workspace._id,
      tenantType: "SAAS_HRMS",
      currentStage: "WELCOME",
      lastActivityAt: new Date(),
    });

    // 10. Welcome email (non-blocking)
    const loginUrl = String(env.FRONTEND_ORIGIN || "https://plumbox.plumtrips.com");
    const emailContent = `
      <p>Hi ${escapeHtml(adminName.trim())},</p>
      <p>Your <strong>Plumtrips HRMS</strong> workspace for <strong>${escapeHtml(companyName.trim())}</strong> is ready.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;margin:16px 0;">
        <tr><td style="padding:8px 0;border-bottom:1px solid #f0f4f8;">
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
      title: "Welcome to Plumtrips HRMS",
      badgeText: "ACTIVE",
      badgeColor: "#10b981",
    });
    sendMail({
      kind: "ONBOARDING",
      to: normalizedEmail,
      subject: "Welcome to Plumtrips HRMS — Your workspace is ready",
      html,
    }).catch(() => {});

    // 11. Return response
    return res.status(201).json({
      success: true,
      workspaceId: workspace._id.toString(),
      userId: user._id.toString(),
      redirect: "/login",
    });
  } catch (err: any) {
    console.error("[saas.signup] POST /signup error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default r;
