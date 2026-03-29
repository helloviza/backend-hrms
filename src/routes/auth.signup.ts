// apps/backend/src/routes/auth.signup.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";

import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import WorkspaceInvite from "../models/WorkspaceInvite.js";
import { requireAuth } from "../middleware/auth.js";
import { sendWelcomeEmail, sendEmailVerification } from "../services/email.service.js";

const r = Router();

/* ───────────────────────────────────────────────
 * Constants
 * ─────────────────────────────────────────────── */
const ACCESS_EXPIRES_IN = "30m";
const REFRESH_EXPIRES_IN = "7d";

/* ───────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────── */
function safeEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function normalizeRoles(roles: string[] = []): string[] {
  return roles
    .map((r) => String(r).trim().toUpperCase())
    .filter(Boolean)
    .map((r) => (r === "SUPER_ADMIN" ? "SUPERADMIN" : r));
}

function slugify(str: string): string {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function signAccessToken(params: {
  userId: string;
  email: string;
  roles: string[];
  customerId?: string | null;
  businessId?: string | null;
}): string {
  const payload: any = {
    sub: String(params.userId),
    roles: normalizeRoles(params.roles || []),
    email: normalizeEmail(params.email || ""),
  };
  if (params.customerId) payload.customerId = String(params.customerId);
  if (params.businessId) payload.businessId = String(params.businessId);
  return jwt.sign(payload, safeEnv("JWT_SECRET"), { expiresIn: ACCESS_EXPIRES_IN });
}

function signRefresh(user: any): string {
  return jwt.sign({ sub: String(user._id) }, safeEnv("JWT_REFRESH_SECRET"), {
    expiresIn: REFRESH_EXPIRES_IN,
  });
}

function frontendOrigin(): string {
  return String(process.env.FRONTEND_ORIGIN || "http://localhost:5173").replace(/\/$/, "");
}

/* ───────────────────────────────────────────────
 * Validation schemas
 * ─────────────────────────────────────────────── */
const SignupSchema = z.object({
  companyName: z.string().min(2, "Company name is required"),
  industry: z.string().optional(),
  employeeCount: z.string().optional(),
  adminName: z.string().min(1, "Admin name is required"),
  email: z.string().email("Valid email is required"),
  phone: z.string().optional(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const AcceptInviteSchema = z.object({
  token: z.string().min(1, "Invite token is required"),
  name: z.string().min(1, "Name is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().optional(),
});

/* ───────────────────────────────────────────────
 * POST /signup
 * ─────────────────────────────────────────────── */
r.post("/signup", async (req, res) => {
  try {
    const parse = SignupSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Validation failed", details: parse.error.flatten() });
    }

    const { companyName, industry, employeeCount, adminName, email, phone, password } = parse.data;
    const normalizedEmail = normalizeEmail(email);

    // 1. Check email uniqueness
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    // 2. Generate customerId: slugify(companyName) + '-' + 6 random hex chars
    const customerId =
      slugify(companyName) + "-" + crypto.randomBytes(3).toString("hex");

    // 3. Resolve default features for trial plan
    const features = CustomerWorkspace.getDefaultFeaturesForPlan("trial");

    // 4. Create CustomerWorkspace
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const workspace = await CustomerWorkspace.create({
      customerId,
      companyName,
      industry: industry || undefined,
      employeeCount: employeeCount || undefined,
      status: "ACTIVE",
      plan: "trial",
      trialEndsAt,
      onboardingStep: "registered",
      accessMode: "INVITE_ONLY",
      config: {
        features,
      },
    });

    // 5. Create admin User
    const passwordHash = bcrypt.hashSync(password, 10);
    const user = await User.create({
      workspaceId: workspace._id,
      roles: ["WORKSPACE_ADMIN"],
      name: adminName,
      email: normalizedEmail,
      phone: phone || undefined,
      passwordHash,
      status: "ACTIVE",
    });

    // 6. Generate email verification token (24h expiry)
    const emailVerificationToken = crypto.randomBytes(32).toString("hex");
    const emailVerificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    workspace.emailVerificationToken = emailVerificationToken;
    workspace.emailVerificationExpiry = emailVerificationExpiry;
    await workspace.save();

    // 7. Send welcome email (non-blocking — errors are swallowed inside sendWelcomeEmail)
    const verifyUrl = `${frontendOrigin()}/verify-email?token=${emailVerificationToken}`;
    sendWelcomeEmail(normalizedEmail, {
      adminName,
      companyName,
      verifyUrl,
    }).catch(() => {
      // already swallowed by email.service safeSend, but belt-and-suspenders
    });

    // 8. Sign JWT access + refresh tokens
    const token = signAccessToken({
      userId: String(user._id),
      email: normalizedEmail,
      roles: ["WORKSPACE_ADMIN"],
      customerId: workspace.customerId,
      businessId: workspace.customerId,
    });
    const refreshToken = signRefresh(user);

    // 9. Return response
    return res.status(201).json({
      success: true,
      token,
      refreshToken,
      workspace: {
        id: String(workspace._id),
        customerId: workspace.customerId,
        companyName: workspace.companyName,
        plan: workspace.plan,
        onboardingStep: workspace.onboardingStep,
      },
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: "WORKSPACE_ADMIN",
      },
    });
  } catch (err: any) {
    console.error("[auth.signup] POST /signup error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ───────────────────────────────────────────────
 * GET /verify-email?token=XXX
 * ─────────────────────────────────────────────── */
r.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Missing verification token." });
    }

    const workspace = await CustomerWorkspace.findOne({
      emailVerificationToken: token,
      emailVerificationExpiry: { $gt: new Date() },
    });

    if (!workspace) {
      return res
        .status(400)
        .json({ error: "Verification token is invalid or has expired." });
    }

    workspace.isEmailVerified = true;
    workspace.emailVerificationToken = undefined;
    workspace.emailVerificationExpiry = undefined;
    await workspace.save();

    return res.json({ success: true, message: "Email verified successfully." });
  } catch (err: any) {
    console.error("[auth.signup] GET /verify-email error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ───────────────────────────────────────────────
 * POST /resend-verification  (authenticated)
 * ─────────────────────────────────────────────── */
r.post("/resend-verification", requireAuth, async (req: any, res) => {
  try {
    const userId = req.user?.sub || req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const workspace = await CustomerWorkspace.findById(user.workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found." });
    }

    if (workspace.isEmailVerified) {
      return res.status(400).json({ error: "Email is already verified." });
    }

    // Regenerate token + expiry
    const emailVerificationToken = crypto.randomBytes(32).toString("hex");
    const emailVerificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    workspace.emailVerificationToken = emailVerificationToken;
    workspace.emailVerificationExpiry = emailVerificationExpiry;
    await workspace.save();

    const verifyUrl = `${frontendOrigin()}/verify-email?token=${emailVerificationToken}`;
    sendEmailVerification(user.email, {
      name: user.name || user.email,
      verifyUrl,
    }).catch(() => {});

    return res.json({ success: true, message: "Verification email resent." });
  } catch (err: any) {
    console.error("[auth.signup] POST /resend-verification error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ───────────────────────────────────────────────
 * GET /invite-preview?token=XXX  (public)
 * ─────────────────────────────────────────────── */
r.get("/invite-preview", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Missing invite token." });
    }

    const invite = await WorkspaceInvite.findOne({
      token,
      status: "pending",
      expiresAt: { $gt: new Date() },
    });

    if (!invite) {
      return res.status(404).json({ error: "Invite not found, already used, or expired." });
    }

    const workspace = await CustomerWorkspace.findById(invite.workspaceId).select(
      "companyName status",
    );
    if (!workspace || workspace.status !== "ACTIVE") {
      return res.status(404).json({ error: "Workspace not found or inactive." });
    }

    const inviter = await User.findById(invite.invitedBy).select("name email");
    const inviterName = inviter?.name || inviter?.email || "Someone";

    return res.json({
      companyName: workspace.companyName,
      inviterName,
      role: invite.role,
      expiresAt: invite.expiresAt,
    });
  } catch (err: any) {
    console.error("[auth.signup] GET /invite-preview error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ───────────────────────────────────────────────
 * POST /accept-invite  (public)
 * ─────────────────────────────────────────────── */
r.post("/accept-invite", async (req, res) => {
  try {
    const parse = AcceptInviteSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Validation failed", details: parse.error.flatten() });
    }

    const { token, name, password, phone } = parse.data;

    // 1. Find pending, non-expired invite
    const invite = await WorkspaceInvite.findOne({
      token,
      status: "pending",
      expiresAt: { $gt: new Date() },
    });

    if (!invite) {
      return res
        .status(400)
        .json({ error: "Invite token is invalid, already used, or expired." });
    }

    // 2. Check workspace is ACTIVE
    const workspace = await CustomerWorkspace.findById(invite.workspaceId);
    if (!workspace || workspace.status !== "ACTIVE") {
      return res.status(400).json({ error: "Workspace is not active." });
    }

    // 3. Check email not already registered
    const normalizedEmail = normalizeEmail(invite.email);
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res
        .status(409)
        .json({ error: "An account with this email already exists." });
    }

    // 4. Create User
    const passwordHash = bcrypt.hashSync(password, 10);
    const user = await User.create({
      workspaceId: workspace._id,
      roles: [invite.role],
      name,
      email: normalizedEmail,
      phone: phone || undefined,
      passwordHash,
      status: "ACTIVE",
    });

    // 5. Mark invite as accepted
    invite.status = "accepted";
    invite.acceptedAt = new Date();
    await invite.save();

    // 6. Sign JWT tokens
    const accessToken = signAccessToken({
      userId: String(user._id),
      email: normalizedEmail,
      roles: [invite.role],
      customerId: workspace.customerId,
      businessId: workspace.customerId,
    });
    const refreshToken = signRefresh(user);

    return res.status(201).json({
      success: true,
      token: accessToken,
      refreshToken,
      workspace: {
        id: String(workspace._id),
        customerId: workspace.customerId,
        companyName: workspace.companyName,
        plan: workspace.plan,
        onboardingStep: workspace.onboardingStep,
      },
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: invite.role,
      },
    });
  } catch (err: any) {
    console.error("[auth.signup] POST /accept-invite error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default r;
