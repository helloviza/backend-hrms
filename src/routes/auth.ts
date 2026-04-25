// apps/backend/src/routes/auth.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import User from "../models/User.js";
import { sendMail } from "../utils/mailer.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { authLogger } from "../utils/logger.js";
import SessionLog from "../models/SessionLog.js";
import Customer from "../models/Customer.js";
import Vendor from "../models/Vendor.js";

import CustomerMember from "../models/CustomerMember.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import MasterData from "../models/MasterData.js";
import { UserPermission } from "../models/UserPermission.js";

const r = Router();

/* ───────────────────────────────────────────────
 * Constants
 * ─────────────────────────────────────────────── */
const ACCESS_EXPIRES_IN = "30m";
const REFRESH_EXPIRES_IN = "7d";
const REFRESH_COOKIE_NAME = "refreshToken";

// Access token cookie (read by approvals.ts extractTokenFromReq)
const ACCESS_COOKIE_NAME = "hrms_accessToken";

const isProd = process.env.NODE_ENV === "production";

/* ───────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────── */
function normalizeRoles(roles: string[] = []) {
  return roles
    .map((rr) => String(rr).trim().toUpperCase())
    .filter(Boolean)
    .map((rr) => (rr === "SUPER_ADMIN" ? "SUPERADMIN" : rr));
}

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function safeEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function isValidObjectId(id: any) {
  return /^[a-fA-F0-9]{24}$/.test(String(id || "").trim());
}

function normStr(v: any) {
  return String(v ?? "").trim();
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emailDomain(email: string) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}

function authHeaderBearer(req: any): string | null {
  const auth = req.headers?.authorization;
  if (!auth || typeof auth !== "string") return null;
  if (!auth.startsWith("Bearer ")) return null;
  const parts = auth.split(" ");
  return parts[1] || null;
}

function extractAccessToken(req: any): string | null {
  // 1) Authorization: Bearer
  const b = authHeaderBearer(req);
  if (b) return b;

  // 2) Cookie
  const ck = req.cookies?.[ACCESS_COOKIE_NAME];
  if (ck && typeof ck === "string") return ck;

  return null;
}

function verifyAccessTokenOrThrow(token: string) {
  try {
    return jwt.verify(token, safeEnv("JWT_SECRET")) as any;
  } catch (err: any) {
    const name = err?.name || "JsonWebTokenError";
    const msg = err?.message || "Invalid token";
    const e: any = new Error(msg);
    e.name = name;
    e.original = err;
    throw e;
  }
}

function send401ForJwtError(res: any, err: any) {
  if (err?.name === "TokenExpiredError") {
    return res.status(401).json({
      error: "Token expired",
      hint: "Please login again (or refresh session) and retry.",
    });
  }
  return res.status(401).json({
    error: "Invalid token",
    hint: "Please login again and retry.",
  });
}

function signAccessToken(params: {
  userId: string;
  email: string;
  roles: string[];
  workspaceId?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  businessId?: string | null;
  customerMemberRole?: string | null;
}) {
  const payload: any = {
    sub: String(params.userId),
    roles: normalizeRoles(params.roles || []),
    email: normalizeEmail(params.email || ""),
  };

  if (params.workspaceId) payload.workspaceId = String(params.workspaceId);
  if (params.customerId) payload.customerId = String(params.customerId);
  if (params.businessId) payload.businessId = String(params.businessId);
  if (params.vendorId) payload.vendorId = String(params.vendorId);
  if (params.customerMemberRole)
    payload.customerMemberRole = String(params.customerMemberRole).toUpperCase();

  return jwt.sign(payload, safeEnv("JWT_SECRET"), { expiresIn: ACCESS_EXPIRES_IN });
}

function signRefresh(user: any) {
  return jwt.sign({ sub: String(user._id) }, safeEnv("JWT_REFRESH_SECRET"), {
    expiresIn: REFRESH_EXPIRES_IN,
  });
}

function verifyRefresh(token: string) {
  return jwt.verify(token, safeEnv("JWT_REFRESH_SECRET"));
}

function cookieDomainOption() {
  // optional, keeps local dev safe
  const d = String(process.env.COOKIE_DOMAIN || "").trim();
  return d ? { domain: d } : {};
}

function setRefreshCookie(res: any, refreshToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/api/auth/refresh",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    ...cookieDomainOption(),
  });
}

function clearRefreshCookie(res: any) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/api/auth/refresh",
    ...cookieDomainOption(),
  });
}

function setAccessCookie(res: any, accessToken: string) {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/api",
    maxAge: 30 * 60 * 1000,
    ...cookieDomainOption(),
  });
}

function clearAccessCookie(res: any) {
  res.clearCookie(ACCESS_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/api",
    ...cookieDomainOption(),
  });
}

function generateRandomPassword(length = 12): string {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  let out = "";
  for (let i = 0; i < length; i += 1)
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function isHrOrAdmin(user: any | null | undefined): boolean {
  if (!user) return false;
  const roles = normalizeRoles(user.roles || []);
  return (
    roles.includes("HR") ||
    roles.includes("ADMIN") ||
    roles.includes("HR_ADMIN") ||
    roles.includes("SUPERADMIN") ||
    roles.includes("STAFF")
  );
}

/**
 * ✅ STAFF detector (prevents customer auto-link + customer role pollution)
 * Treat as STAFF if:
 * - hrmsAccessLevel/accountType/userType explicitly STAFF
 * - OR role claims include any internal Plumtrips role
 */
function isStaffActor(userLike: any): boolean {
  if (!userLike) return false;

  const lvl = String(userLike.hrmsAccessLevel || "").trim().toUpperCase();
  const at = String(userLike.accountType || "").trim().toUpperCase();
  const ut = String(userLike.userType || "").trim().toUpperCase();
  if (lvl === "STAFF" || at === "STAFF" || ut === "STAFF") return true;

  const roles = normalizeRoles(userLike.roles || []);
  return (
    roles.includes("SUPERADMIN") ||
    roles.includes("ADMIN") ||
    roles.includes("HR") ||
    roles.includes("HR_ADMIN") ||
    roles.includes("STAFF") ||
    roles.includes("TENANT_ADMIN") ||
    roles.includes("MANAGER") ||
    roles.includes("EMPLOYEE") ||
    roles.includes("LEAD") ||
    roles.includes("TEAM_LEAD") ||
    roles.includes("OWNER")
  );
}

/* =========================================================
 * MasterData Business resolver
 * ======================================================= */
function customerTypeClause() {
  const rx = /^(business|customer)$/i;
  return {
    $or: [
      { type: rx },
      { entityType: rx },
      { "payload.type": rx },
      { "payload.entityType": rx },
    ],
  };
}

async function findBusinessMasterDataByEmailOrOwner(params: {
  email: string;
  ownerId: string;
  userId?: string;
}) {
  const email = normalizeEmail(params.email);
  const ownerId = normStr(params.ownerId);
  const userId = normStr(params.userId || "");

  const or: any[] = [];

  if (email) {
    const rx = new RegExp(`^${escapeRegExp(email)}$`, "i");
    or.push(
      { email: rx },
      { officialEmail: rx },
      { official_email: rx },

      { "payload.email": rx },
      { "payload.officialEmail": rx },
      { "payload.primaryEmail": rx },
      { "payload.ownerEmail": rx },
      { "payload.createdByEmail": rx },
      { "payload.companyEmail": rx },
      { "payload.contactEmail": rx },
      { "payload.billingEmail": rx },
      { "payload.adminEmail": rx },

      { "payload.contact.email": rx },
      { "payload.contactEmail.email": rx }
    );
  }

  const ids = [ownerId, userId].filter(Boolean);
  for (const id of ids) {
    or.push(
      { ownerId: id },
      { "payload.ownerId": id },
      { "payload.createdBy": id },
      { "payload.userId": id }
    );
  }

  if (!or.length) return null;

  return MasterData.findOne({ $and: [customerTypeClause(), { $or: or }] })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean()
    .exec();
}

/* =========================================================
 * Ensure workspace + leader for customerId (ObjectId style)
 * ======================================================= */
async function ensureWorkspaceAndLeader(params: {
  customerId: string;
  email: string;
  name?: string;
  userRoles?: string[];
}) {
  const customerId = String(params.customerId || "").trim();
  const email = normalizeEmail(params.email);
  if (!isValidObjectId(customerId) || !email) return;

  await CustomerWorkspace.updateOne(
    { customerId },
    {
      $setOnInsert: {
        customerId,
        allowedDomains: [],
        allowedEmails: [],
        defaultApproverEmails: [],
        canApproverCreateUsers: true,
        userCreationEnabled: false, // default safety
        status: "ACTIVE",
        createdAt: new Date(),
      },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  ).exec();

  // Derive member role from explicit DB roles — don't hardcode WORKSPACE_LEADER
  const dbRoles = (params.userRoles || []).map((r) => r.toUpperCase());
  const memberRole = dbRoles.includes("WORKSPACE_LEADER")
    ? "WORKSPACE_LEADER"
    : dbRoles.includes("APPROVER")
    ? "APPROVER"
    : "REQUESTER";

  const rx = new RegExp(`^${escapeRegExp(email)}$`, "i");
  const setFields: any = {
    role: memberRole,
    isActive: true,
    updatedAt: new Date(),
  };
  if (params.name) setFields.name = normStr(params.name);

  await CustomerMember.updateOne(
    { customerId, email: rx },
    {
      $setOnInsert: {
        customerId,
        email,
        invitedAt: new Date(),
        createdBy: "auth:auto-link",
      },
      $set: setFields,
    },
    { upsert: true }
  ).exec();
}

/* =========================================================
 * Customer/Vendor linking
 * ======================================================= */
async function findLinkedCustomerVendor(userId: any, email: string) {
  const e = normalizeEmail(email);

  const customer =
    (await Customer.findOne({ ownerId: userId }).lean()) ||
    (await Customer.findOne({
      $or: [{ email: e }, { officialEmail: e }, { official_email: e }],
    }).lean());

  const vendor =
    (await Vendor.findOne({ ownerId: userId }).lean()) ||
    (await Vendor.findOne({
      $or: [{ email: e }, { officialEmail: e }, { official_email: e }],
    }).lean());

  return { customer, vendor };
}

async function buildAuthSafeUser(userDoc: any) {
  const base = userDoc?.toJSON ? userDoc.toJSON() : userDoc;

  const email = normalizeEmail(base?.email || "");
  const userId = String(base?._id || "");

  const baseRoles = normalizeRoles(base.roles || []);
  const staff = isStaffActor({ ...base, roles: baseRoles });

  const { customer, vendor } = await findLinkedCustomerVendor(base._id, email);

  // Workspace member lookup (latest active membership) — ONLY for non-staff
  let member: any = null;
  if (!staff && email) {
    const rx = new RegExp(`^${escapeRegExp(email)}$`, "i");
    member = await CustomerMember.findOne({
      email: rx,
      $or: [{ isActive: { $exists: false } }, { isActive: true }],
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();
  }

  const set = new Set<string>(baseRoles);

  // Only add CUSTOMER/VENDOR links for non-staff
  if (!staff) {
    if (customer) set.add("CUSTOMER");
    if (vendor) set.add("VENDOR");

    let customerMemberRole: string | null = null;
    if (member?.customerId) {
      set.add("CUSTOMER");
      if (member?.role) {
        const mr = String(member.role).toUpperCase();
        customerMemberRole = mr;
      }
    }

    if (set.size === 0) set.add("EMPLOYEE");

    // Order: ensure CUSTOMER/VENDOR early, but keep all roles present
    const ordered: string[] = [];
    if (set.has("VENDOR")) ordered.push("VENDOR");
    if (set.has("CUSTOMER")) ordered.push("CUSTOMER");

    const priority = [
      "SUPERADMIN",
      "ADMIN",
      "HR",
      "HR_ADMIN",
      "STAFF",
      "MANAGER",
      "EMPLOYEE",
    ];
    for (const p of priority) if (set.has(p)) ordered.push(p);
    for (const rr of Array.from(set)) if (!ordered.includes(rr)) ordered.push(rr);

    const roles = ordered.filter(Boolean);

    // Resolve customerId (non-staff only)
    let rawCustomerId: any =
      (base?.customerId ? base.customerId : null) ||
      (member?.customerId ? member.customerId : null) ||
      (customer?._id ? customer._id : null) ||
      null;

    if (!rawCustomerId && email) {
      const md = await findBusinessMasterDataByEmailOrOwner({
        email,
        ownerId: String(base?.sub || ""),
        userId,
      });
      if (md?._id) rawCustomerId = md._id;
    }

    if (!rawCustomerId && email) {
      const domain = emailDomain(email);
      const ws: any = await CustomerWorkspace.findOne({
        $or: [
          { allowedEmails: email },
          ...(domain ? [{ allowedDomains: domain }] : []),
        ],
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean()
        .exec();

      if (ws?.customerId) rawCustomerId = ws.customerId;
    }

    const customerId = rawCustomerId ? String(rawCustomerId) : null;

    const vendorId =
      (base?.vendorId ? String(base.vendorId) : null) ||
      (vendor?._id ? String(vendor._id) : null);

    const hasCustomerRole = roles.includes("CUSTOMER");
    const hasVendorRole = roles.includes("VENDOR");

    const accountType =
      hasVendorRole || vendorId
        ? "VENDOR"
        : hasCustomerRole || customerId
        ? "CUSTOMER"
        : "EMPLOYEE";

    const safe: any = {
      ...base,
      roles,
      role: roles[0],
      accountType,
      userType: accountType,
      customerMemberRole: customerMemberRole || undefined,
    };

    if (customerId) {
      safe.customerId = customerId;
      if (!safe.businessId) safe.businessId = customerId;
    }
    if (vendorId) safe.vendorId = vendorId;

    // IMPORTANT: stop "Employee" labeling for Customer/Vendor accounts
    if (accountType === "CUSTOMER") {
      safe.hrmsAccessRole = "CUSTOMER";
      safe.hrmsAccessLevel = "CUSTOMER";
    }
    if (accountType === "VENDOR") {
      safe.hrmsAccessRole = "VENDOR";
      safe.hrmsAccessLevel = "VENDOR";
    }

    return {
      safe,
      roles,
      customerId,
      vendorId,
      customerMemberRole: customerMemberRole || null,
      staff: false,
    };
  }

  // ───────────────────────────────────────────────
  // STAFF-safe path: never infer CUSTOMER/VENDOR/member roles
  // ───────────────────────────────────────────────
  if (set.size === 0) set.add("STAFF");

  const ordered: string[] = [];
  const priority = [
    "SUPERADMIN",
    "ADMIN",
    "HR",
    "HR_ADMIN",
    "STAFF",
    "MANAGER",
    "EMPLOYEE",
  ];
  for (const p of priority) if (set.has(p)) ordered.push(p);
  for (const rr of Array.from(set)) if (!ordered.includes(rr)) ordered.push(rr);

  const roles = ordered.filter(Boolean);

  const safe: any = {
    ...base,
    roles,
    role: roles[0],
    accountType: "STAFF",
    userType: "STAFF",
  };

  // Ensure STAFF labels remain STAFF (do not override to CUSTOMER)
  if (!safe.hrmsAccessLevel) safe.hrmsAccessLevel = "STAFF";
  if (!safe.hrmsAccessRole) {
    if (roles.includes("SUPERADMIN")) safe.hrmsAccessRole = "SUPER_ADMIN";
    else if (roles.includes("ADMIN")) safe.hrmsAccessRole = "ADMIN";
    else if (roles.includes("HR")) safe.hrmsAccessRole = "HR";
    else safe.hrmsAccessRole = "STAFF";
  }

  // Strip any accidental customer/vendor fields from stored doc
  delete safe.customerId;
  delete safe.businessId;
  delete safe.customerMemberRole;
  delete safe.vendorId;

  return {
    safe,
    roles,
    customerId: null,
    vendorId: null,
    customerMemberRole: null,
    staff: true,
  };
}

/* =========================================================
 * Workspace -> User resolver for admin reset
 * ======================================================= */
async function findCustomerMemberByEmail(email: string) {
  const e = normalizeEmail(email);
  const rx = new RegExp(`^${escapeRegExp(e)}$`, "i");
  return CustomerMember.findOne({ email: rx }).lean().exec();
}

async function findWorkspaceByCustomerId(customerId: string) {
  if (!customerId) return null;
  return CustomerWorkspace.findOne({ customerId }).lean().exec();
}

async function ensureUserFromWorkspaceMember(email: string, passwordHash: string) {
  const member: any = await findCustomerMemberByEmail(email);
  if (!member) return { user: null, createdFromWorkspace: false };

  const roles = normalizeRoles(["CUSTOMER", member.role || "REQUESTER"]);
  const name = String(member.name || "").trim();
  const firstName = name || "Workspace User";

  const ws = await findWorkspaceByCustomerId(String(member.customerId || ""));

  const user: any = await User.create({
    email,
    officialEmail: email,
    personalEmail: email,
    firstName,
    lastName: "",
    roles,
    passwordHash,
    customerId: member.customerId,
    businessId: member.customerId,
    workspaceId: ws?._id || member.customerId,
    role: "CUSTOMER",
    accountType: "CUSTOMER",
    userType: "CUSTOMER",
    hrmsAccessRole: "CUSTOMER",
    hrmsAccessLevel: "CUSTOMER",
  });

  return {
    user,
    createdFromWorkspace: true,
    workspaceInfo: {
      customerId: String(member.customerId || ""),
      memberRole: String(member.role || ""),
      hasWorkspace: Boolean(ws),
    },
  };
}

/* ───────────────────────────────────────────────
 * REGISTER
 * ─────────────────────────────────────────────── */
r.post("/register", async (req, res) => {
  try {
    const { email, password, firstName, lastName, workspaceId: bodyWsId, inviteToken } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const normalizedEmail = normalizeEmail(email);

    // Check pre-existing permission grant
    // SuperAdmin emails bypass this check
    const SUPERADMIN_EMAILS = [
      'admin@plumtrips.com',
      'imran.ali@plumtrips.com',
    ];

    const isSAEmail = SUPERADMIN_EMAILS.includes(normalizedEmail);

    if (!isSAEmail) {
      const permission = await UserPermission.findOne({
        email: normalizedEmail,
        status: { $ne: 'revoked' },
      }).lean();

      if (!permission) {
        return res.status(403).json({
          error: 'You are not authorized to create an account. Please contact your administrator to request access.',
        });
      }
    }

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) return res.status(400).json({ error: "User already exists" });

    // Never accept roles from request body — all self-registrations are CUSTOMER
    const finalRoles: string[] = ["CUSTOMER"];

    // Resolve workspaceId: explicit body param → invite token → member lookup
    let resolvedWsId = bodyWsId || null;
    if (!resolvedWsId && inviteToken) {
      const member: any = await findCustomerMemberByEmail(normalizedEmail);
      if (member?.customerId) {
        const ws = await findWorkspaceByCustomerId(String(member.customerId));
        resolvedWsId = ws?._id || member.customerId;
      }
    }
    if (!resolvedWsId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      email: normalizedEmail,
      officialEmail: normalizedEmail,
      personalEmail: normalizedEmail,
      firstName,
      lastName,
      roles: finalRoles,
      passwordHash,
      workspaceId: resolvedWsId,
    });

    res.json({ id: user._id });
  } catch (err) {
    authLogger.error("Register failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    res.status(500).json({ error: "Server error" });
  }
});

/* ───────────────────────────────────────────────
 * LOGIN
 * ─────────────────────────────────────────────── */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const email = req.body?.email;
    if (email) return email.toString().toLowerCase();
    return ipKeyGenerator(req.ip || "unknown");
  },
  message: { error: "Too many login attempts for this account. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

r.post("/login", loginLimiter, async (req, res) => {
  try {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        fields: result.error.flatten().fieldErrors,
      });
    }
    const { email, password } = result.data;

    const normalizedEmail = normalizeEmail(email);

    const user: any = await User.findOne({
      $or: [
        { email: normalizedEmail },
        { officialEmail: normalizedEmail },
        { personalEmail: normalizedEmail },
      ],
    });

    if (!user || !user.passwordHash) {
      authLogger.warn("Failed login attempt", { email: normalizedEmail, ip: req.ip, reason: "user_not_found_or_no_password" });
      SessionLog.create({
        email: normalizedEmail,
        event: "LOGIN_FAILED",
        ipAddress: req.ip || req.headers["x-forwarded-for"] as string,
        userAgent: req.headers["user-agent"],
        success: false,
        failureReason: "user_not_found_or_no_password",
      }).catch(() => {});
      return res.status(400).json({ error: "Invalid credentials or password not set" });
    }

    // SuperAdmin bypass — role-based or email-based
    const SUPERADMIN_EMAILS = [
      'admin@plumtrips.com',
      'imran.ali@plumtrips.com',
    ];
    const isSAEmail = SUPERADMIN_EMAILS.includes(normalizedEmail);

    const isSA =
      user.roles?.includes('SuperAdmin') ||
      user.hrmsAccessRole === 'SuperAdmin';

    const userRoles = user.roles || [];
    const isExternalUser =
      userRoles.includes('CUSTOMER') ||
      userRoles.includes('VENDOR') ||
      userRoles.includes('CLIENT') ||
      userRoles.includes('WORKSPACE_LEADER') ||
      userRoles.includes('REQUESTER') ||
      userRoles.includes('APPROVER');

    if (!isSA && !isSAEmail && !isExternalUser) {
      const permission = await UserPermission.findOne({
        email: normalizedEmail,
      }).lean();

      if (!permission) {
        return res.status(403).json({
          error: 'Your account has not been activated yet. Please contact your administrator.',
        });
      }

      if (permission.status === 'revoked') {
        return res.status(403).json({
          error: 'Your access to Plumbox has been revoked. Please contact your administrator.',
        });
      }

      if (permission.status === 'suspended') {
        return res.status(403).json({
          error: `Your account has been temporarily suspended.${permission.suspendReason ? ` Reason: ${permission.suspendReason}` : ''} Please contact your administrator.`,
        });
      }
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      authLogger.warn("Failed login attempt", { email: normalizedEmail, ip: req.ip, reason: "invalid_credentials" });
      SessionLog.create({
        userId: user._id,
        email: normalizedEmail,
        role: normalizeRoles(user.roles || [])[0],
        event: "LOGIN_FAILED",
        ipAddress: req.ip || req.headers["x-forwarded-for"] as string,
        userAgent: req.headers["user-agent"],
        success: false,
        failureReason: "invalid_credentials",
      }).catch(() => {});
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // 1) Build safe
    let built = await buildAuthSafeUser(user);

    // ✅ STAFF: never auto-link workspace leader
    if (!built.staff) {
      // 2) Auto-link workspace + leader if customerId is ObjectId
      if (built.customerId && isValidObjectId(built.customerId)) {
        await ensureWorkspaceAndLeader({
          customerId: built.customerId,
          email: built.safe.email,
          name: built.safe.firstName || built.safe.name,
          userRoles: user.roles || [],
        });

        if (!user.customerId) {
          user.customerId = built.customerId;
          user.businessId = built.customerId;
          await user.save();
        }

        // 3) Rebuild so roles reflect member role immediately
        built = await buildAuthSafeUser(user);
      }
    }

    const accessToken = signAccessToken({
      userId: String(user._id),
      email: built.safe.email,
      roles: built.roles,
      // Staff users carry workspaceId in JWT (their workspaceId is reliable).
      // Customer users must not — their workspaceId on the User doc may be stale
      // or point to the wrong workspace. requireWorkspace resolves them via customerId.
      workspaceId: built.staff ? (user.workspaceId?.toString() || undefined) : undefined,
      customerId: built.staff ? undefined : built.customerId || undefined,
      businessId: built.staff ? undefined : built.customerId || undefined,
      vendorId: built.staff ? undefined : built.vendorId || undefined,
      customerMemberRole: built.staff ? undefined : built.customerMemberRole || undefined,
    });

    const refreshToken = signRefresh(user);

    setRefreshCookie(res, refreshToken);
    setAccessCookie(res, accessToken);

    authLogger.info("User login", { userId: user._id, email: built.safe.email, role: built.roles[0], ip: req.ip });
    SessionLog.create({
      userId: user._id,
      email: built.safe.email,
      role: built.roles[0],
      event: "LOGIN",
      ipAddress: req.ip || req.headers["x-forwarded-for"] as string,
      userAgent: req.headers["user-agent"],
      success: true,
    }).catch(() => {});

    res.json({ accessToken, user: built.safe });
  } catch (err) {
    authLogger.error("Login failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    res.status(500).json({ error: "Server error" });
  }
});

/* ───────────────────────────────────────────────
 * REFRESH
 * ─────────────────────────────────────────────── */
r.post("/refresh", async (req, res) => {
  try {
    const token = (req.cookies && req.cookies[REFRESH_COOKIE_NAME]) || null;
    if (!token) return res.status(401).json({ error: "Missing refresh token" });

    const payload: any = verifyRefresh(token);
    // NOTE: pre-auth lookup, workspace not yet available
    const user: any = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: "User not found" });

    let built = await buildAuthSafeUser(user);

    // ✅ STAFF: never auto-link workspace leader
    if (!built.staff) {
      if (built.customerId && isValidObjectId(built.customerId)) {
        await ensureWorkspaceAndLeader({
          customerId: built.customerId,
          email: built.safe.email,
          name: built.safe.firstName || built.safe.name,
          userRoles: user.roles || [],
        });

        if (!user.customerId) {
          user.customerId = built.customerId;
          user.businessId = built.customerId;
          await user.save();
        }

        built = await buildAuthSafeUser(user);
      }
    }

    const newAccessToken = signAccessToken({
      userId: String(user._id),
      email: built.safe.email,
      roles: built.roles,
      workspaceId: built.staff ? (user.workspaceId?.toString() || undefined) : undefined,
      customerId: built.staff ? undefined : built.customerId || undefined,
      businessId: built.staff ? undefined : built.customerId || undefined,
      vendorId: built.staff ? undefined : built.vendorId || undefined,
      customerMemberRole: built.staff ? undefined : built.customerMemberRole || undefined,
    });

    const newRefreshToken = signRefresh(user);

    setRefreshCookie(res, newRefreshToken);
    setAccessCookie(res, newAccessToken);

    authLogger.info("Token refresh", { userId: user._id, email: built.safe.email });
    SessionLog.create({
      userId: user._id,
      email: built.safe.email,
      role: built.roles[0],
      event: "TOKEN_REFRESH",
      ipAddress: req.ip || req.headers["x-forwarded-for"] as string,
      userAgent: req.headers["user-agent"],
      success: true,
    }).catch(() => {});

    res.json({ accessToken: newAccessToken, user: built.safe });
  } catch (err) {
    authLogger.error("Refresh failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

/* ───────────────────────────────────────────────
 * CURRENT USER
 * ─────────────────────────────────────────────── */
r.get("/me", async (req, res) => {
  try {
    const token = extractAccessToken(req);
    if (!token) return res.status(401).json({ error: "Missing token" });

    let payload: any;
    try {
      payload = verifyAccessTokenOrThrow(token);
    } catch (err: any) {
      return send401ForJwtError(res, err);
    }

    // NOTE: pre-auth lookup, workspace not yet available
    const user: any = await User.findById(payload.sub);
    if (!user) return res.status(404).json({ error: "User not found" });

    const { safe } = await buildAuthSafeUser(user);
    res.json({ user: safe });
  } catch (err) {
    authLogger.error("Me endpoint error", { error: err instanceof Error ? err.message : String(err) });
    res.status(401).json({ error: "Invalid token" });
  }
});

/* ───────────────────────────────────────────────
 * CHANGE PASSWORD (self-service)
 * ─────────────────────────────────────────────── */
r.post("/change-password", async (req, res) => {
  try {
    const token = extractAccessToken(req);
    if (!token) return res.status(401).json({ error: "Missing token" });

    let payload: any;
    try {
      payload = verifyAccessTokenOrThrow(token);
    } catch (err: any) {
      return send401ForJwtError(res, err);
    }

    // NOTE: pre-auth lookup, workspace not yet available
    const user: any = await User.findById(payload.sub);
    if (!user) return res.status(404).json({ error: "User not found" });

    const { currentPassword, newPassword } = req.body || {};
    if (
      !currentPassword ||
      typeof currentPassword !== "string" ||
      !newPassword ||
      typeof newPassword !== "string"
    ) {
      return res.status(400).json({ error: "Current password and new password are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    if (!user.passwordHash) {
      return res.status(400).json({
        error: "Your account does not have a password set yet. Contact HR / Admin.",
      });
    }

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(400).json({ error: "Current password is incorrect" });

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    await user.save();

    res.json({ message: "Password updated successfully" });
  } catch (err: any) {
    authLogger.error("Change password error", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to update password", detail: err?.message });
  }
});

/* ───────────────────────────────────────────────
 * ADMIN RESET PASSWORD (HR/Admin only)
 * ─────────────────────────────────────────────── */
r.post("/admin/reset-password", async (req, res) => {
  try {
    const token = extractAccessToken(req);
    if (!token) return res.status(401).json({ error: "Missing token" });

    let payload: any;
    try {
      payload = verifyAccessTokenOrThrow(token);
    } catch (err: any) {
      return send401ForJwtError(res, err);
    }

    // NOTE: pre-auth lookup, workspace not yet available
    const actor: any = await User.findById(payload.sub);
    if (!actor) return res.status(404).json({ error: "Actor not found" });
    if (!isHrOrAdmin(actor)) return res.status(403).json({ error: "HR/Admin access required" });

    const { email, newPassword } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required to reset password" });
    }

    const normalizedEmail = normalizeEmail(email);

    const finalPassword =
      typeof newPassword === "string" && newPassword.length >= 8
        ? newPassword
        : generateRandomPassword(12);

    const finalHash = await bcrypt.hash(finalPassword, 12);

    let user: any = await User.findOne({
      $or: [
        { email: normalizedEmail },
        { officialEmail: normalizedEmail },
        { personalEmail: normalizedEmail },
      ],
    });

    let created = false;
    let createdFromWorkspace = false;
    let workspaceInfo: any = null;

    const customer = await Customer.findOne({
      $or: [
        { email: normalizedEmail },
        { officialEmail: normalizedEmail },
        { official_email: normalizedEmail },
      ],
    });

    const vendor = await Vendor.findOne({
      $or: [
        { email: normalizedEmail },
        { officialEmail: normalizedEmail },
        { official_email: normalizedEmail },
      ],
    });

    if (!user) {
      const ensured = await ensureUserFromWorkspaceMember(normalizedEmail, finalHash);
      if (ensured.user) {
        user = ensured.user;
        created = true;
        createdFromWorkspace = true;
        workspaceInfo = ensured.workspaceInfo || null;
      }
    }

    if (!user) {
      if (!customer && !vendor) {
        return res.status(404).json({
          error: "No user, customer or vendor found with this email",
          hint: "If created via Customer Workspace users, ensure it exists in CustomerMember.",
        });
      }

      const roles: string[] = [];
      if (vendor) roles.push("VENDOR");
      if (customer) roles.push("CUSTOMER");

      const baseDoc: any = customer || vendor;

      const firstName =
        baseDoc?.contactPerson ||
        baseDoc?.contactName ||
        baseDoc?.inviteeName ||
        baseDoc?.name ||
        baseDoc?.companyName ||
        "";

      // Resolve workspaceId from customer/vendor → workspace, or actor's workspace
      const customerId = String((customer as any)?._id || (vendor as any)?.customerId || "");
      let wsId = customerId ? (await findWorkspaceByCustomerId(customerId))?._id : null;
      if (!wsId) {
        // Fallback: use the actor's (admin's) workspace
        wsId = actor.workspaceId || null;
      }
      if (!wsId) {
        const ws = await CustomerWorkspace.findOne({ status: "ACTIVE" }).select("_id").lean();
        wsId = ws?._id || null;
      }

      user = await User.create({
        email: normalizedEmail,
        officialEmail: normalizedEmail,
        personalEmail: normalizedEmail,
        firstName,
        lastName: "",
        roles: normalizeRoles(roles.length ? roles : ["EMPLOYEE"]),
        passwordHash: finalHash,
        workspaceId: wsId,
      });

      created = true;
    } else {
      user.passwordHash = finalHash;

      const set = new Set<string>(normalizeRoles(user.roles || []));
      if (vendor) set.add("VENDOR");
      if (customer) set.add("CUSTOMER");
      if (createdFromWorkspace) set.add("CUSTOMER");
      if (set.size === 0) set.add("EMPLOYEE");

      user.roles = Array.from(set);
      await user.save();
    }

    if (customer && !(customer as any).ownerId) {
      (customer as any).ownerId = user._id;
      await (customer as any).save();
    }

    if (vendor && !(vendor as any).ownerId) {
      (vendor as any).ownerId = user._id;
      await (vendor as any).save();
    }

    const { safe } = await buildAuthSafeUser(user);

    res.json({
      ok: true,
      user: safe,
      email: safe.email,
      tempPassword: finalPassword,
      created,
      createdFromWorkspace,
      workspaceInfo,
    });
  } catch (err: any) {
    authLogger.error("Admin reset password error", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to reset password", detail: err?.message });
  }
});

/* ───────────────────────────────────────────────
 * FORGOT PASSWORD
 * ─────────────────────────────────────────────── */
const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

r.post("/forgot-password", async (req, res) => {
  try {
    const result = forgotPasswordSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        fields: result.error.flatten().fieldErrors,
      });
    }
    const { email } = result.data;

    const normalizedEmail = normalizeEmail(email);

    const user: any = await User.findOne({
      $or: [
        { email: normalizedEmail },
        { officialEmail: normalizedEmail },
        { personalEmail: normalizedEmail },
      ],
    });

    // Always return ok — never reveal whether the email exists
    if (!user) return res.json({ ok: true });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(rawToken).digest("hex");

    user.resetTokenHash = hash;
    user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    const frontendOrigin = String(process.env.FRONTEND_ORIGIN || "http://localhost:5173").replace(/\/$/, "");
    const resetLink = `${frontendOrigin}/reset-password?token=${rawToken}`;

    await sendMail({
      to: normalizedEmail,
      subject: "Reset your Plumtrips password",
      kind: "CONFIRMATIONS",
      html: `
        <p>Hi${user.firstName ? ` ${user.firstName}` : ""},</p>
        <p>We received a request to reset your password. Click the link below to set a new password. This link expires in 1 hour.</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>If you didn't request this, you can safely ignore this email.</p>
        <p>— Plumtrips</p>
      `,
    });

    res.json({ ok: true });
  } catch (err: any) {
    authLogger.error("Forgot password error", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Server error" });
  }
});

/* ───────────────────────────────────────────────
 * RESET PASSWORD
 * ─────────────────────────────────────────────── */
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

r.post("/reset-password", async (req, res) => {
  try {
    const result = resetPasswordSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        fields: result.error.flatten().fieldErrors,
      });
    }
    const { token, newPassword } = result.data;

    const hash = crypto.createHash("sha256").update(token).digest("hex");

    const user: any = await User.findOne({
      resetTokenHash: hash,
      resetTokenExpiry: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.resetTokenHash = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    res.json({ ok: true });
  } catch (err: any) {
    authLogger.error("Reset password error", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Server error" });
  }
});

/* ───────────────────────────────────────────────
 * LOGOUT
 * ─────────────────────────────────────────────── */
r.post("/logout", (_req, res) => {
  clearRefreshCookie(res);
  clearAccessCookie(res);
  res.json({ ok: true });
});

/* ───────────────────────────────────────────────
 * CLEAR SESSION (escape hatch for stuck sessions)
 * ─────────────────────────────────────────────── */
r.get("/clear-session", (_req, res) => {
  clearRefreshCookie(res);
  clearAccessCookie(res);
  res.json({ ok: true, message: "Session cleared" });
});

export default r;
