// apps/backend/src/routes/customerUsers.ts
import { Router } from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import crypto from "crypto";

import { requireAuth } from "../middleware/auth.js";
import MasterData from "../models/MasterData.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import User from "../models/User.js";
import Onboarding from "../models/Onboarding.js";

import { sendMail } from "../utils/mailer.js";
import { signEmailActionToken } from "../utils/emailActionToken.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

/* =========================================================
 * Helpers
 * ======================================================= */
function normEmail(v: any) {
  return String(v || "").trim().toLowerCase();
}
function normStr(v: any) {
  const s = String(v ?? "").trim();
  return s || "";
}
function normRole(v: any) {
  return String(v || "").trim().toUpperCase();
}
function normBool(v: any) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}
function emailDomain(email: string) {
  const e = normEmail(email);
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizeDomain(input: any) {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.replace(/\/.*$/, "");
  s = s.replace(/^@/, "");
  return s.trim();
}
function normalizeDigits(input: any) {
  return String(input ?? "").replace(/\D+/g, "");
}

/**
 * Turn "9876543210" into loose matcher:
 * 9\D*8\D*7\D*6... so it matches +91 98765-43210 etc.
 */
function digitsToLooseRegex(digits: string) {
  const d = normalizeDigits(digits);
  if (!d) return null;
  const pat = d.split("").map((ch) => `${ch}\\D*`).join("");
  return new RegExp(pat, "i");
}

function normalizeEmailList(input: any): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((x) => normEmail(x)).filter(Boolean);

  const s = String(input).trim();
  if (!s) return [];

  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x) => normEmail(x)).filter(Boolean);
    } catch {
      // ignore
    }
  }

  return s
    .split(/[,\n\r\t ]+/g)
    .map((x) => normEmail(x))
    .filter(Boolean);
}

function normalizeDomainList(input: any): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((x) => normalizeDomain(x)).filter(Boolean);

  const s = String(input).trim();
  if (!s) return [];

  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x) => normalizeDomain(x)).filter(Boolean);
    } catch {
      // ignore
    }
  }

  return s
    .split(/[,\n\r\t ]+/g)
    .map((x) => normalizeDomain(x))
    .filter(Boolean);
}

function collectRoles(u: any): string[] {
  const roles: string[] = [];
  if (Array.isArray(u?.roles)) roles.push(...u.roles);
  if (u?.role) roles.push(u.role);
  if (u?.accountType) roles.push(u.accountType);
  if (u?.userType) roles.push(u.userType);
  if (u?.hrmsAccessRole) roles.push(u.hrmsAccessRole);
  if (u?.hrmsAccessLevel) roles.push(u.hrmsAccessLevel);
  return roles.map((r) => String(r).trim().toUpperCase()).filter(Boolean);
}

function isStaffPrivileged(u: any) {
  if (u?.staff === true) return true;
  if (u?.isStaff === true) return true;

  const r = collectRoles(u);
  return (
    r.includes("STAFF") ||
    r.includes("INTERNAL") ||
    r.includes("DEV") ||
    r.includes("SYSTEM") ||
    r.includes("ADMIN") ||
    r.includes("SUPERADMIN") ||
    r.includes("SUPER_ADMIN") ||
    r.includes("HR") ||
    r.includes("HR_ADMIN")
  );
}

function publicBaseUrl() {
  return (process.env.PUBLIC_APP_URL || process.env.FRONTEND_ORIGIN || "http://localhost:5173").replace(/\/+$/, "");
}
function invitePath() {
  return process.env.CUSTOMER_INVITE_PATH || "/customer/invite";
}

async function getActorMember(customerId: string, actorEmail: string) {
  const email = normEmail(actorEmail);
  return CustomerMember.findOne({ customerId, email }).lean().exec();
}

/**
 * Workspace switch: strict must be TRUE for "manage users" actions
 */
function isUserCreationEnabled(ws: any): boolean {
  return (ws as any)?.userCreationEnabled === true;
}

/**
 * Effective allowlist:
 * Prefer new fields (userCreationAllowlist*). If empty, fallback to legacy (allowed*).
 */
function getEffectiveAllowlist(ws: any): { emails: string[]; domains: string[] } {
  const e1 = Array.isArray((ws as any)?.userCreationAllowlistEmails) ? (ws as any).userCreationAllowlistEmails : [];
  const d1 = Array.isArray((ws as any)?.userCreationAllowlistDomains) ? (ws as any).userCreationAllowlistDomains : [];

  const emails = (e1.length ? e1 : Array.isArray((ws as any)?.allowedEmails) ? (ws as any).allowedEmails : [])
    .map((x: any) => normEmail(x))
    .filter(Boolean);

  const domains = (d1.length ? d1 : Array.isArray((ws as any)?.allowedDomains) ? (ws as any).allowedDomains : [])
    .map((x: any) => normalizeDomain(x))
    .filter(Boolean);

  return {
    emails: Array.from(new Set(emails)),
    domains: Array.from(new Set(domains)),
  };
}

function isAllowlistConfigured(ws: any) {
  const { emails, domains } = getEffectiveAllowlist(ws);
  return emails.length > 0 || domains.length > 0;
}

/**
 * Actor whitelist gate for customer-side manage-users:
 * - Staff bypass
 * - Requester blocked always
 * - Leader/Approver must match allowlist email or domain
 * - If allowlist empty => deny by default (safe)
 */
function ensureUserCreationWhitelisted(actor: any, member: any, ws: any) {
  if (isStaffPrivileged(actor)) return { ok: true as const };

  const role = String(member?.role || "").toUpperCase();
  if (!role) return { ok: false as const, status: 403, error: "Not a member of this customer workspace" };
  if (role === "REQUESTER") return { ok: false as const, status: 403, error: "Requesters cannot manage users" };

  if (!isUserCreationEnabled(ws)) {
    return {
      ok: false as const,
      status: 403,
      error: "User creation is disabled for this workspace. Contact HR/Admin.",
    };
  }

  const { emails, domains } = getEffectiveAllowlist(ws);
  if (emails.length === 0 && domains.length === 0) {
    return {
      ok: false as const,
      status: 403,
      error: "Your email/domain isn’t whitelisted for User Creation. Contact HR/Admin.",
    };
  }

  const actorEmail = normEmail(actor?.email || "");
  const actorDom = actorEmail ? emailDomain(actorEmail) : "";

  const emailOk = actorEmail && emails.includes(actorEmail);
  const domainOk = actorDom && domains.includes(actorDom);

  if (!emailOk && !domainOk) {
    return {
      ok: false as const,
      status: 403,
      error: "Your email/domain isn’t whitelisted for User Creation. Contact HR/Admin.",
    };
  }

  if (role === "WORKSPACE_LEADER") return { ok: true as const };
  if (role === "APPROVER") {
    if ((ws as any)?.canApproverCreateUsers) return { ok: true as const };
    return { ok: false as const, status: 403, error: "Approvers cannot manage users in this workspace" };
  }

  return { ok: false as const, status: 403, error: "Access restricted" };
}

function emailAllowedByWorkspace(ws: any, invitedEmail: string) {
  const e = normEmail(invitedEmail);
  const d = emailDomain(e);
  const { emails, domains } = getEffectiveAllowlist(ws);
  if (emails.includes(e)) return true;
  if (d && domains.includes(d)) return true;
  return false;
}

/**
 * Returns business record for a customerId from either:
 * - MasterData (_id)
 * - Onboarding (_id)
 */
async function getBusinessById(customerId: string): Promise<any | null> {
  const cid = normStr(customerId);
  if (!cid) return null;

  const md: any = (await MasterData.findOne({
    _id: cid,
    type: /business|customer/i,
  })
    .lean()
    .exec()) as any;

  if (md?._id) return { source: "MasterData", doc: md };

  const ob: any = (await Onboarding.findOne({
    _id: cid,
    type: /business|customer/i,
  })
    .lean()
    .exec()) as any;

  if (ob?._id) return { source: "Onboarding", doc: ob };

  return null;
}

function pickBusinessView(found: any | null) {
  if (!found?.doc) return null;
  const d = found.doc;

  const name =
    d?.name ||
    d?.companyName ||
    d?.businessName ||
    d?.title ||
    d?.payload?.name ||
    d?.payload?.companyName ||
    d?.payload?.businessName ||
    "";

  const email = d?.email || d?.officialEmail || d?.payload?.email || d?.payload?.officialEmail || "";
  const website = d?.website || d?.officialWebsite || d?.payload?.website || d?.payload?.officialWebsite || "";
  const domain = d?.domain || d?.payload?.domain || (email ? emailDomain(email) : "");

  return {
    id: String(d?._id || ""),
    source: found.source,
    name,
    email,
    website,
    domain,
    status: d?.status || "",
    type: d?.type || "",
    updatedAt: d?.updatedAt || null,
  };
}

async function ensureWorkspace(customerId: string) {
  const cid = normStr(customerId);
  let ws: any = await CustomerWorkspace.findOne({ customerId: cid }).exec();

  if (!ws) {
    ws = await CustomerWorkspace.create({
      customerId: cid,

      // legacy allowlist (kept for back-compat)
      allowedDomains: [],
      allowedEmails: [],

      // approvals
      defaultApproverEmails: [],
      canApproverCreateUsers: true,

      // gate switch
      userCreationEnabled: false,

      // new allowlist (preferred)
      userCreationAllowlistEmails: [],
      userCreationAllowlistDomains: [],
      userCreationAllowlistUpdatedBy: "",
      userCreationAllowlistUpdatedAt: null,

      status: "ACTIVE",
    });
    return ws;
  }

  // heal types (legacy + new)
  const fixedDefaultApprovers = normalizeEmailList((ws as any).defaultApproverEmails);

  const fixedLegacyDomains = Array.isArray((ws as any).allowedDomains)
    ? (ws as any).allowedDomains.map((d: any) => normalizeDomain(d)).filter(Boolean)
    : normalizeDomainList((ws as any).allowedDomains);

  const fixedLegacyEmails = normalizeEmailList((ws as any).allowedEmails);

  const fixedNewDomains = Array.isArray((ws as any).userCreationAllowlistDomains)
    ? (ws as any).userCreationAllowlistDomains.map((d: any) => normalizeDomain(d)).filter(Boolean)
    : normalizeDomainList((ws as any).userCreationAllowlistDomains);

  const fixedNewEmails = normalizeEmailList((ws as any).userCreationAllowlistEmails);

  const before = JSON.stringify({
    defaultApproverEmails: (ws as any).defaultApproverEmails || [],
    allowedDomains: (ws as any).allowedDomains || [],
    allowedEmails: (ws as any).allowedEmails || [],
    userCreationAllowlistDomains: (ws as any).userCreationAllowlistDomains || [],
    userCreationAllowlistEmails: (ws as any).userCreationAllowlistEmails || [],
  });

  (ws as any).defaultApproverEmails = fixedDefaultApprovers;
  (ws as any).allowedDomains = fixedLegacyDomains;
  (ws as any).allowedEmails = fixedLegacyEmails;

  (ws as any).userCreationAllowlistDomains = fixedNewDomains;
  (ws as any).userCreationAllowlistEmails = fixedNewEmails;

  const after = JSON.stringify({
    defaultApproverEmails: fixedDefaultApprovers,
    allowedDomains: fixedLegacyDomains,
    allowedEmails: fixedLegacyEmails,
    userCreationAllowlistDomains: fixedNewDomains,
    userCreationAllowlistEmails: fixedNewEmails,
  });

  if (before !== after) await ws.save();
  return ws;
}

/**
 * Safe leader ensure:
 * ✅ Never auto-insert STAFF as leader
 * ✅ Only auto-create/promote leader when:
 *    - leader is missing AND
 *    - actor is customer-side AND
 *    - actor matches business email/domain OR matches effective allowlist
 */
async function ensureOwnerIsLeaderSafe(customerId: string, ws: any, actor: any, businessView: any | null) {
  const cid = normStr(customerId);
  const actorEmail = normEmail(actor?.email || "");
  const actorName = normStr(actor?.name || "");

  // Staff: never auto-create leader; just return existing leader if present
  if (isStaffPrivileged(actor)) {
    const leader = await CustomerMember.findOne({
      customerId: cid,
      role: "WORKSPACE_LEADER",
      isActive: true,
    })
      .lean()
      .exec();
    return leader ? normEmail((leader as any).email) : "";
  }

  const leaderExists = await CustomerMember.findOne({
    customerId: cid,
    role: "WORKSPACE_LEADER",
    isActive: true,
  })
    .lean()
    .exec();
  if (leaderExists) return normEmail((leaderExists as any).email);

  // allow by workspace allowlist (legacy+new effective)
  const allowByWs = actorEmail ? emailAllowedByWorkspace(ws, actorEmail) : false;

  // allow by business identity
  const bizEmail = normEmail(businessView?.email || "");
  const bizDom = normalizeDomain(businessView?.domain || "");
  const actorDom = actorEmail ? emailDomain(actorEmail) : "";
  const allowByBiz = !!actorEmail && ((bizEmail && actorEmail === bizEmail) || (bizDom && actorDom && actorDom === bizDom));

  if (!allowByWs && !allowByBiz) return "";

  // Promote or create as leader (safe because we passed allow checks above)
  const now = new Date();
  await CustomerMember.updateOne(
    { customerId: cid, email: actorEmail },
    {
      $set: {
        customerId: cid,
        email: actorEmail,
        role: "WORKSPACE_LEADER",
        isActive: true,
        name: actorName || "Workspace Leader",
        lastInviteAt: now,
      },
      $setOnInsert: {
        invitedAt: now,
        createdBy: actorEmail,
      },
    },
    { upsert: true },
  ).exec();

  return actorEmail;
}

async function ensureDefaultApproverFallback(ws: any, leaderEmail: string, actor?: any) {
  const list = normalizeEmailList((ws as any)?.defaultApproverEmails);
  if (list.length > 0) return list;

  // ✅ never set STAFF as default approver fallback
  if (isStaffPrivileged(actor)) return list;

  const leader = normEmail(leaderEmail);
  if (!leader) return list;

  (ws as any).defaultApproverEmails = [leader];
  await ws.save();
  return (ws as any).defaultApproverEmails;
}

/**
 * Robust resolver:
 * - STAFF can pass ?customerId or body.customerId
 * - customer-side uses token ids, membership fallback, or workspace allowlist fallback
 */
async function resolveCustomerId(req: any): Promise<string | null> {
  const actor = req.user || {};
  const actorEmail = normEmail(actor.email || "");
  const domain = actorEmail ? emailDomain(actorEmail) : "";

  if (isStaffPrivileged(actor)) {
    const q = normStr(req.query?.customerId);
    const b = normStr(req.body?.customerId);
    const c = b || q || normStr(actor.customerId) || normStr(actor.businessId);
    return c || null;
  }

  const cidFromToken = normStr(actor.customerId) || normStr(actor.businessId);
  if (cidFromToken) return cidFromToken;

  if (actorEmail) {
    const member = await CustomerMember.findOne({ email: actorEmail, isActive: true })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();
    if ((member as any)?.customerId) return String((member as any).customerId);
  }

  // fallback by workspace allowlist (legacy + new)
  if (actorEmail) {
    const ors: any[] = [{ allowedEmails: actorEmail }, { userCreationAllowlistEmails: actorEmail }];
    if (domain) {
      ors.push({ allowedDomains: domain });
      ors.push({ userCreationAllowlistDomains: domain });
    }

    const ws: any = await CustomerWorkspace.findOne({ $or: ors })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();
    if (ws?.customerId) return String(ws.customerId);
  }

  // fallback by MasterData matching email
  if (actorEmail) {
    const md: any = (await MasterData.findOne({
      type: /business|customer/i,
      $or: [
        { email: new RegExp(`^${escapeRegex(actorEmail)}$`, "i") },
        { officialEmail: new RegExp(`^${escapeRegex(actorEmail)}$`, "i") },
        { "payload.email": new RegExp(`^${escapeRegex(actorEmail)}$`, "i") },
      ],
    })
      .lean()
      .exec()) as any;

    if (md?._id) return String(md._id);
  }

  // fallback by Onboarding matching email
  if (actorEmail) {
    const ob: any = (await Onboarding.findOne({
      type: /business|customer/i,
      $or: [
        { email: new RegExp(`^${escapeRegex(actorEmail)}$`, "i") },
        { officialEmail: new RegExp(`^${escapeRegex(actorEmail)}$`, "i") },
        { "payload.email": new RegExp(`^${escapeRegex(actorEmail)}$`, "i") },
      ],
    })
      .lean()
      .exec()) as any;

    if (ob?._id) return String(ob._id);
  }

  return null;
}

/* =========================================================
 * Email sending (best-effort, never blocks create)
 * ======================================================= */
function emailsDisabled(): boolean {
  const s = String(process.env.DISABLE_EMAILS ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function pickSendInviteFlag(body: any, fallback = true): boolean {
  // accept both sendInvite and sendInviteEmail
  if (body?.sendInvite !== undefined) return normBool(body.sendInvite);
  if (body?.sendInviteEmail !== undefined) return normBool(body.sendInviteEmail);
  return fallback;
}

async function trySendInviteEmailSafe(params: { to: string; customerId: string; inviterEmail: string; inviteeName?: string }) {
  if (emailsDisabled()) {
    return { inviteEmailSent: false, inviteEmailSkipped: true as const, inviteEmailError: "DISABLE_EMAILS enabled" };
  }
  try {
    await sendInviteEmail(params);
    return { inviteEmailSent: true, inviteEmailSkipped: false as const, inviteEmailError: null as string | null };
  } catch (e: any) {
    // IMPORTANT: do not throw — creation must succeed even if email fails
    console.warn("[customerUsers] invite email skipped due to mail error:", e?.message || e);
    return {
      inviteEmailSent: false,
      inviteEmailSkipped: false as const,
      inviteEmailError: String(e?.message || "mail failed"),
    };
  }
}

async function sendInviteEmail(params: { to: string; customerId: string; inviterEmail: string; inviteeName?: string }) {
  const token = signEmailActionToken({
    purpose: "customer_invite",
    email: normEmail(params.to),
    customerId: normStr(params.customerId),
    inviterEmail: normEmail(params.inviterEmail),
  });

  const url = `${publicBaseUrl()}${invitePath()}?token=${encodeURIComponent(token)}`;

  const subject = "You're invited to PlumTrips HRMS";
  const body = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <p>Hi ${params.inviteeName ? normStr(params.inviteeName) : "there"},</p>
      <p>Your workspace access has been created. Click below to continue:</p>
      <p><a href="${url}" target="_blank" rel="noreferrer">${url}</a></p>
      <p style="color:#666;font-size:12px">If you didn’t expect this email, you can ignore it.</p>
    </div>
  `;

  await sendMail({ to: params.to, subject, html: body });
}

type MemberRole = "WORKSPACE_LEADER" | "APPROVER" | "REQUESTER";

async function ensureAuthUserForCustomer(params: {
  email: string;
  name?: string;
  customerId: string;
  memberRole: MemberRole;
  passwordPlain?: string | null;
  managerUser?: any | null;
}) {
  const email = normEmail(params.email);
  const name = normStr(params.name || "");
  const roles = Array.from(new Set(["CUSTOMER", params.memberRole].map((x) => String(x).toUpperCase()).filter(Boolean)));

  const passwordPlain = params.passwordPlain && params.passwordPlain.length >= 6 ? params.passwordPlain : null;
  const finalPassword = passwordPlain || crypto.randomBytes(8).toString("hex");
  const passwordHash = await bcrypt.hash(finalPassword, 12);

  let user: any = await User.findOne({
    $or: [{ email }, { officialEmail: email }, { personalEmail: email }],
  }).exec();

  if (!user) {
    user = await User.create({
      email,
      officialEmail: email,
      personalEmail: email,
      name: name || undefined,
      firstName: name || "Workspace User",
      lastName: "",
      roles,
      passwordHash,
      customerId: params.customerId,
      businessId: params.customerId,
      accountType: "CUSTOMER",
      userType: "CUSTOMER",
      hrmsAccessRole: "EMPLOYEE",
      hrmsAccessLevel: "EMPLOYEE",
      ...(params.managerUser?._id
        ? {
            managerId: params.managerUser._id,
            managerName: params.managerUser.name || params.managerUser.firstName || "",
            reportingL1: normEmail(params.managerUser.email || ""),
          }
        : {}),
    });
    return { user, created: true, tempPassword: finalPassword };
  }

  const existingRoles = Array.isArray(user.roles) ? user.roles : [];
  user.roles = Array.from(new Set([...existingRoles, ...roles].map((x) => String(x).toUpperCase())));

  user.customerId = user.customerId || params.customerId;
  user.businessId = user.businessId || params.customerId;
  user.accountType = user.accountType || "CUSTOMER";
  user.userType = user.userType || "CUSTOMER";

  if (name && !user.name) user.name = name;
  if (name && !user.firstName) user.firstName = name;

  if (passwordPlain) user.passwordHash = passwordHash;

  if (params.managerUser?._id) {
    user.managerId = params.managerUser._id;
    user.managerName = params.managerUser.name || params.managerUser.firstName || "";
    user.reportingL1 = normEmail(params.managerUser.email || "");
  }

  await user.save();
  return { user, created: false, tempPassword: passwordPlain ? finalPassword : null };
}

/* =========================================================
 * STAFF: Set Workspace Leader explicitly
 * ======================================================= */
/**
 * POST /api/customer/users/workspace/leader?customerId=<id>
 * STAFF-only: force set a leader for a workspace (helps unblock initial setups)
 * Body: { email, name?, seedAllowlist?: true|false, enableUserCreation?: true|false }
 *
 * Safety:
 * - By default, will also seed allowlist with leader email + leader domain if allowlist empty.
 * - Won’t set STAFF email as leader (must be a different email).
 */
router.post("/workspace/leader", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    if (!isStaffPrivileged(actor)) return res.status(403).json({ error: "Access restricted" });

    const actorEmail = normEmail(actor.email || "");
    const customerId = await resolveCustomerId(req);
    if (!customerId) return res.status(400).json({ error: "customerId is required (query or body)" });

    const ws: any = await ensureWorkspace(customerId);
    const business = pickBusinessView(await getBusinessById(customerId));

    const leaderEmail = normEmail(req.body?.email);
    const leaderName = normStr(req.body?.name || "Workspace Leader");

    if (!leaderEmail || !leaderEmail.includes("@")) return res.status(400).json({ error: "Valid leader email is required" });
    if (leaderEmail === actorEmail) {
      return res.status(400).json({ error: "Do not set STAFF email as workspace leader. Use customer-side leader email." });
    }

    const now = new Date();

    const member = await CustomerMember.findOneAndUpdate(
      { customerId, email: leaderEmail },
      {
        $set: {
          name: leaderName || undefined,
          role: "WORKSPACE_LEADER",
          isActive: true,
          lastInviteAt: now,
        },
        $setOnInsert: {
          customerId,
          email: leaderEmail,
          invitedAt: now,
          createdBy: actorEmail,
        },
      },
      { upsert: true, new: true },
    ).exec();

    // Ensure auth user exists for leader
    await ensureAuthUserForCustomer({
      email: leaderEmail,
      name: leaderName,
      customerId,
      memberRole: "WORKSPACE_LEADER",
      passwordPlain: null,
      managerUser: null,
    });

    // Optional toggles
    const enableUserCreation = req.body?.enableUserCreation === undefined ? undefined : !!req.body.enableUserCreation;
    const seedAllowlist = req.body?.seedAllowlist === undefined ? true : !!req.body.seedAllowlist;

    if (enableUserCreation !== undefined) {
      ws.userCreationEnabled = enableUserCreation;
    }

    // Seed allowlist if empty (safe starter)
    if (seedAllowlist) {
      const eff = getEffectiveAllowlist(ws);
      const dom = emailDomain(leaderEmail);

      const emails = Array.from(new Set([...(eff.emails || []), leaderEmail].map(normEmail).filter(Boolean)));
      const domains = Array.from(new Set([...(eff.domains || []), dom].map(normalizeDomain).filter(Boolean)));

      const changed = JSON.stringify(eff) !== JSON.stringify({ emails, domains });
      if (changed) {
        ws.userCreationAllowlistEmails = emails;
        ws.userCreationAllowlistDomains = domains;
        ws.userCreationAllowlistUpdatedBy = actorEmail;
        ws.userCreationAllowlistUpdatedAt = new Date();

        // mirror legacy
        ws.allowedEmails = emails;
        ws.allowedDomains = domains;
      }
    }

    await ws.save();

    return res.json({
      ok: true,
      customerId,
      business,
      leader: {
        id: String((member as any)?._id || ""),
        email: leaderEmail,
        name: (member as any)?.name || leaderName,
        role: (member as any)?.role || "WORKSPACE_LEADER",
        isActive: (member as any)?.isActive === true,
      },
      workspace: {
        userCreationEnabled: ws.userCreationEnabled === true,
        canApproverCreateUsers: !!ws.canApproverCreateUsers,
        allowlistConfigured: isAllowlistConfigured(ws),
        allowlist: getEffectiveAllowlist(ws),
        allowlistUpdatedBy: ws.userCreationAllowlistUpdatedBy || "",
        allowlistUpdatedAt: ws.userCreationAllowlistUpdatedAt || null,
      },
    });
  } catch (err: any) {
    console.error("[customerUsers:setLeader] error", err);
    return res.status(500).json({ error: "Failed to set workspace leader", detail: err?.message });
  }
});

/* =========================================================
 * Workspace selectors (STAFF)
 * ======================================================= */

/**
 * GET /api/customer/users/workspace/resolve?domain=helloviza.com
 * STAFF-only helper to get customerId by domain (no .env)
 */
router.get("/workspace/resolve", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    if (!isStaffPrivileged(actor)) return res.status(403).json({ error: "Access restricted" });

    const domain = normalizeDomain(req.query?.domain || "");
    if (!domain) return res.status(400).json({ error: "domain is required" });

    const domEsc = escapeRegex(domain);
    const emailDomRe = new RegExp(`@${domEsc}$`, "i");
    const containsDomRe = new RegExp(domEsc, "i");

    // 1) Try MasterData matching domain
    const md: any = (await MasterData.findOne({
      type: /business|customer/i,
      $or: [
        { domain: new RegExp(`^${domEsc}$`, "i") },
        { website: containsDomRe },
        { officialWebsite: containsDomRe },
        { email: emailDomRe },
        { officialEmail: emailDomRe },
        { "payload.domain": new RegExp(`^${domEsc}$`, "i") },
        { "payload.website": containsDomRe },
        { "payload.officialWebsite": containsDomRe },
      ],
    })
      .lean()
      .exec()) as any;

    let customerId = md?._id ? String(md._id) : "";

    // 2) Try Onboarding matching domain/email domain/website
    let ob: any = null;
    if (!customerId) {
      ob = (await Onboarding.findOne({
        type: /business|customer/i,
        $or: [
          { domain: new RegExp(`^${domEsc}$`, "i") },
          { website: containsDomRe },
          { officialWebsite: containsDomRe },
          { email: emailDomRe },
          { officialEmail: emailDomRe },
          { "payload.domain": new RegExp(`^${domEsc}$`, "i") },
          { "payload.website": containsDomRe },
          { "payload.officialWebsite": containsDomRe },
        ],
      })
        .lean()
        .exec()) as any;

      if (ob?._id) customerId = String(ob._id);
    }

    // 3) Fallback: find any workspace with allowlist domain
    if (!customerId) {
      const wsAny: any = await CustomerWorkspace.findOne({
        $or: [{ allowedDomains: domain }, { userCreationAllowlistDomains: domain }],
      })
        .lean()
        .exec();
      if (wsAny?.customerId) customerId = String(wsAny.customerId);
    }

    if (!customerId) {
      return res.status(404).json({
        error: "Workspace not found for this domain",
        hint: "Ensure Business exists in MasterData or Onboarding, or a workspace allowlist contains this domain.",
        domain,
      });
    }

    const ws = await ensureWorkspace(customerId);

    const businessFound = md?._id
      ? { source: "MasterData", doc: md }
      : ob?._id
        ? { source: "Onboarding", doc: ob }
        : await getBusinessById(customerId);

    const biz = pickBusinessView(businessFound);

    return res.json({
      ok: true,
      domain,
      customerId,
      business: biz,
      workspace: {
        customerId: (ws as any).customerId,
        status: (ws as any).status,
        userCreationEnabled: (ws as any).userCreationEnabled === true,
        canApproverCreateUsers: !!(ws as any).canApproverCreateUsers,
        allowlist: {
          emails: getEffectiveAllowlist(ws).emails,
          domains: getEffectiveAllowlist(ws).domains,
          updatedBy: (ws as any).userCreationAllowlistUpdatedBy || "",
          updatedAt: (ws as any).userCreationAllowlistUpdatedAt || null,
        },
      },
    });
  } catch (err: any) {
    console.error("[customerUsers:workspaceResolve] error", err);
    res.status(500).json({ error: "Failed to resolve workspace", detail: err?.message });
  }
});

/**
 * GET /api/customer/users/workspace/search?q=helloviza
 * STAFF-only helper to search businesses and pick a customerId
 */
router.get("/workspace/search", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    if (!isStaffPrivileged(actor)) return res.status(403).json({ error: "Access restricted" });

    const q = normStr(req.query?.q || "");
    const result = await staffSearchBusinesses(q);
    return res.json({ ok: true, q, rows: result.rows });
  } catch (err: any) {
    console.error("[customerUsers:workspaceSearch] error", err);
    res.status(500).json({ error: "Failed to search businesses", detail: err?.message });
  }
});

/**
 * GET /api/customer/users/workspace/search-mobile?q=9876543210
 * STAFF-only helper to search businesses by phone/mobile/whatsapp
 */
router.get("/workspace/search-mobile", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    if (!isStaffPrivileged(actor)) return res.status(403).json({ error: "Access restricted" });

    const qRaw = normStr(req.query?.q || "");
    const digits = normalizeDigits(qRaw);
    if (!digits || digits.length < 6) return res.json({ ok: true, q: qRaw, rows: [] });

    const last = digits.length > 10 ? digits.slice(-10) : digits;
    const re = digitsToLooseRegex(last);
    if (!re) return res.json({ ok: true, q: qRaw, rows: [] });

    const phoneOrs = [
      { phone: re },
      { mobile: re },
      { contactNo: re },
      { contactNumber: re },
      { whatsapp: re },
      { whatsappNumber: re },
      { "payload.phone": re },
      { "payload.mobile": re },
      { "payload.contactNo": re },
      { "payload.contactNumber": re },
      { "payload.whatsapp": re },
      { "payload.whatsappNumber": re },
    ];

    const mdRows: any[] = (await MasterData.find({ type: /business|customer/i, $or: phoneOrs })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(25)
      .lean()
      .exec()) as any;

    const obRows: any[] = (await Onboarding.find({ type: /business|customer/i, $or: phoneOrs })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(25)
      .lean()
      .exec()) as any;

    const merged = new Map<string, any>();
    for (const md of mdRows || []) {
      const view = pickBusinessView({ source: "MasterData", doc: md });
      if (view?.id) merged.set(view.id, view);
    }
    for (const ob of obRows || []) {
      const view = pickBusinessView({ source: "Onboarding", doc: ob });
      if (view?.id && !merged.has(view.id)) merged.set(view.id, view);
    }

    const out = Array.from(merged.values()).slice(0, 25);
    return res.json({ ok: true, q: qRaw, digits: last, rows: out });
  } catch (err: any) {
    console.error("[customerUsers:workspaceSearchMobile] error", err);
    res.status(500).json({ error: "Failed to search by mobile", detail: err?.message });
  }
});

/**
 * GET /api/customer/users/workspace/allowlists
 * STAFF-only: list workspaces + allowlists with business identification
 * Optional:
 *  - ?q=helloviza
 *  - ?onlyEnabled=1
 *  - ?onlyConfigured=1
 *  - ?limit=50 (max 200)
 */
router.get("/workspace/allowlists", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    if (!isStaffPrivileged(actor)) return res.status(403).json({ error: "Access restricted" });

    const q = normStr(req.query?.q || "");
    const onlyEnabled = normBool(req.query?.onlyEnabled);
    const onlyConfigured = normBool(req.query?.onlyConfigured);

    let limit = Number(req.query?.limit || 50);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    limit = Math.min(limit, 200);

    const bizSearch = q && q.length >= 2 ? await staffSearchBusinesses(q) : { rows: [], ids: [] as string[] };

    const emailQ = normEmail(q);
    const domQ = normalizeDomain(q);

    const orWs: any[] = [];
    if (bizSearch.ids.length) orWs.push({ customerId: { $in: bizSearch.ids } });
    if (emailQ) {
      orWs.push({ allowedEmails: emailQ });
      orWs.push({ userCreationAllowlistEmails: emailQ });
    }
    if (domQ) {
      orWs.push({ allowedDomains: domQ });
      orWs.push({ userCreationAllowlistDomains: domQ });
    }

    const wsFilter: any = {};
    if (onlyEnabled) wsFilter.userCreationEnabled = true;
    if (orWs.length) wsFilter.$or = orWs;

    const workspaces: any[] = (await CustomerWorkspace.find(wsFilter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean()
      .exec()) as any;

    const rows = await Promise.all(
      (workspaces || []).map(async (ws) => {
        const customerId = String(ws.customerId || "");
        const biz = pickBusinessView(await getBusinessById(customerId));
        const eff = getEffectiveAllowlist(ws);

        return {
          customerId,
          business: biz,
          switches: {
            userCreationEnabled: ws.userCreationEnabled === true,
            canApproverCreateUsers: !!ws.canApproverCreateUsers,
          },
          allowlist: {
            emails: eff.emails,
            domains: eff.domains,
            updatedBy: ws.userCreationAllowlistUpdatedBy || "",
            updatedAt: ws.userCreationAllowlistUpdatedAt || null,
          },
          legacy: {
            allowedEmails: Array.isArray(ws.allowedEmails) ? ws.allowedEmails : [],
            allowedDomains: Array.isArray(ws.allowedDomains) ? ws.allowedDomains : [],
          },
          status: ws.status || "ACTIVE",
          updatedAt: ws.updatedAt || null,
        };
      }),
    );

    const filtered = onlyConfigured
      ? rows.filter((r) => (r.allowlist.emails?.length || 0) + (r.allowlist.domains?.length || 0) > 0)
      : rows;

    return res.json({ ok: true, q, count: filtered.length, limit, rows: filtered });
  } catch (err: any) {
    console.error("[customerUsers:workspaceAllowlists] error", err);
    res.status(500).json({ error: "Failed to list allowlists", detail: err?.message });
  }
});

/* =========================================================
 * Access / allowlist endpoints
 * ======================================================= */

/**
 * GET /api/customer/users/workspace/access
 */
router.get("/workspace/access", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    const actorEmail = normEmail(actor.email || "");
    const customerId = await resolveCustomerId(req);

    if (!customerId) {
      if (isStaffPrivileged(actor)) {
        return res.status(400).json({
          ok: false,
          error: "Please set Customer ID first (Business id) to load the workspace.",
          hint: "Use /workspace/search or /workspace/resolve then pass ?customerId=<id>.",
        });
      }
      return res.status(400).json({ ok: false, error: "Customer workspace not found for this login" });
    }

    const ws: any = await ensureWorkspace(customerId);
    const business = pickBusinessView(await getBusinessById(customerId));

    const member = await getActorMember(customerId, actorEmail);
    const verdict = ensureUserCreationWhitelisted(actor, member, ws);

    return res.json({
      ok: true,
      customerId,
      actor: {
        email: actorEmail,
        staff: isStaffPrivileged(actor),
        memberRole: String(member?.role || ""),
        roles: actor?.roles || [],
      },
      workspace: {
        userCreationEnabled: (ws as any).userCreationEnabled === true,
        canApproverCreateUsers: !!(ws as any).canApproverCreateUsers,
        allowlistConfigured: isAllowlistConfigured(ws),
        allowlist: getEffectiveAllowlist(ws),
        allowlistUpdatedBy: (ws as any).userCreationAllowlistUpdatedBy || "",
        allowlistUpdatedAt: (ws as any).userCreationAllowlistUpdatedAt || null,
      },
      business,
      canManageUsers: verdict.ok === true,
      reason: verdict.ok ? "OK" : (verdict as any).error,
    });
  } catch (err: any) {
    console.error("[customerUsers:workspaceAccess] error", err);
    res.status(500).json({ ok: false, error: "Failed to resolve access", detail: err?.message });
  }
});

/**
 * GET /api/customer/users/workspace/allowlist
 */
router.get("/workspace/allowlist", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    const actorEmail = normEmail(actor.email || "");
    const customerId = await resolveCustomerId(req);

    if (!customerId) {
      if (isStaffPrivileged(actor)) {
        return res.status(400).json({
          error: "Please set Customer ID first (Business id) to load the workspace.",
          hint: "Use /workspace/search or /workspace/resolve then pass ?customerId=<id>.",
        });
      }
      return res.status(400).json({ error: "Customer workspace not found for this login" });
    }

    const ws: any = await ensureWorkspace(customerId);

    if (!isStaffPrivileged(actor)) {
      const member = await getActorMember(customerId, actorEmail);
      const role = String(member?.role || "").toUpperCase();
      if (!role) return res.status(403).json({ error: "Not a member of this customer workspace" });
      if (role === "REQUESTER") return res.status(403).json({ error: "Requesters cannot manage users" });
    }

    const { emails, domains } = getEffectiveAllowlist(ws);

    res.json({
      ok: true,
      customerId,
      allowlist: {
        emails,
        domains,
        updatedBy: (ws as any).userCreationAllowlistUpdatedBy || "",
        updatedAt: (ws as any).userCreationAllowlistUpdatedAt || null,
      },
      switches: {
        userCreationEnabled: (ws as any).userCreationEnabled === true,
        canApproverCreateUsers: !!(ws as any).canApproverCreateUsers,
      },
    });
  } catch (err: any) {
    console.error("[customerUsers:getAllowlist] error", err);
    res.status(500).json({ error: "Failed to read allowlist", detail: err?.message });
  }
});

/**
 * POST /api/customer/users/workspace/allowlist
 * STAFF-only
 */
router.post("/workspace/allowlist", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    if (!isStaffPrivileged(actor)) return res.status(403).json({ error: "Access restricted" });

    const customerId = await resolveCustomerId(req);
    if (!customerId) {
      return res.status(400).json({
        error: "Please set Customer ID first (Business id) to load the workspace.",
      });
    }

    const ws: any = await ensureWorkspace(customerId);

    const emails = normalizeEmailList(req.body?.emails);
    const domains = normalizeDomainList(req.body?.domains);

    ws.userCreationAllowlistEmails = emails;
    ws.userCreationAllowlistDomains = domains;
    ws.userCreationAllowlistUpdatedBy = normEmail(actor.email || "");
    ws.userCreationAllowlistUpdatedAt = new Date();

    // Back-compat mirror (legacy fields)
    ws.allowedEmails = emails;
    ws.allowedDomains = domains;

    await ws.save();

    res.json({
      ok: true,
      customerId,
      allowlist: {
        emails,
        domains,
        updatedBy: ws.userCreationAllowlistUpdatedBy || "",
        updatedAt: ws.userCreationAllowlistUpdatedAt || null,
      },
    });
  } catch (err: any) {
    console.error("[customerUsers:setAllowlist] error", err);
    res.status(500).json({ error: "Failed to update allowlist", detail: err?.message });
  }
});

/* =========================================================
 * Routes
 * ======================================================= */

/**
 * GET /api/customer/users
 */
router.get("/", requireAuth, async (req: any, res) => {
  try {
    const customerId = await resolveCustomerId(req);
    const actor = req.user || {};

    if (!customerId) {
      if (isStaffPrivileged(actor)) {
        return res.status(400).json({
          error: "Please set Customer ID first (Business id) to load the workspace.",
          hint: "Use /api/customer/users/workspace/search?q=... OR /api/customer/users/workspace/resolve?domain=... then pass ?customerId=<id>.",
        });
      }
      return res.status(400).json({
        error: "Customer workspace not found for this login",
        hint: "Ensure token has customerId OR CustomerMember exists OR allowlist matches email/domain.",
        debug: { actorEmail: normEmail(req.user?.email), roles: req.user?.roles || [] },
      });
    }

    const ws: any = await ensureWorkspace(customerId);
    const actorEmail = normEmail(actor.email || "");

    const business = pickBusinessView(await getBusinessById(customerId));

    const leaderEmail = await ensureOwnerIsLeaderSafe(customerId, ws, actor, business);

    const member = await getActorMember(customerId, actorEmail);

    const wh = ensureUserCreationWhitelisted(actor, member, ws);
    if (!wh.ok) return res.status((wh as any).status || 403).json({ error: (wh as any).error });

    const rows = await CustomerMember.find({ customerId }).sort({ role: 1, email: 1 }).lean().exec();
    const eff = getEffectiveAllowlist(ws);

    res.json({
      ok: true,
      customerId,
      business,
      workspace: {
        customerId: (ws as any).customerId,
        status: (ws as any).status,

        allowedDomains: (ws as any).allowedDomains || [],
        allowedEmails: (ws as any).allowedEmails || [],

        defaultApproverEmails: normalizeEmailList((ws as any).defaultApproverEmails),
        canApproverCreateUsers: !!(ws as any).canApproverCreateUsers,
        userCreationEnabled: (ws as any).userCreationEnabled === true,

        userCreationAllowlistDomains: eff.domains,
        userCreationAllowlistEmails: eff.emails,
        userCreationAllowlistUpdatedBy: (ws as any).userCreationAllowlistUpdatedBy || "",
        userCreationAllowlistUpdatedAt: (ws as any).userCreationAllowlistUpdatedAt || null,
      },
      actor: {
        email: actorEmail,
        memberRole: String(member?.role || ""),
        roles: req.user?.roles || [],
        staff: isStaffPrivileged(actor),
      },
      leaderEmail: leaderEmail || null,
      rows,
    });
  } catch (err: any) {
    console.error("[customerUsers:list] error", err);
    res.status(500).json({ error: "Failed to list customer users", detail: err?.message });
  }
});

/**
 * GET /api/customer/users/workspace/config
 */
router.get("/workspace/config", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    const actorEmail = normEmail(actor.email || "");
    const customerId = await resolveCustomerId(req);

    if (!customerId) {
      if (isStaffPrivileged(actor)) {
        return res.status(400).json({
          error: "Please set Customer ID first (Business id) to load the workspace.",
          hint: "Use /workspace/search or /workspace/resolve then pass ?customerId=<id>.",
        });
      }
      return res.status(400).json({ error: "Customer workspace not found" });
    }

    const ws: any = await ensureWorkspace(customerId);
    const business = pickBusinessView(await getBusinessById(customerId));

    if (!isStaffPrivileged(actor)) {
      const member = await getActorMember(customerId, actorEmail);
      const role = String(member?.role || "").toUpperCase();
      if (!role) return res.status(403).json({ error: "Not a member of this customer workspace" });
      if (role === "REQUESTER") return res.status(403).json({ error: "Requesters cannot manage users" });
    }

    const leaderEmail = await ensureOwnerIsLeaderSafe(customerId, ws, actor, business);
    const defaults = await ensureDefaultApproverFallback(ws, leaderEmail, actor);
    const eff = getEffectiveAllowlist(ws);

    res.json({
      ok: true,
      customerId,
      config: {
        status: (ws as any).status,
        allowedDomains: (ws as any).allowedDomains || [],
        allowedEmails: (ws as any).allowedEmails || [],
        defaultApproverEmails: normalizeEmailList(defaults),
        canApproverCreateUsers: !!(ws as any).canApproverCreateUsers,
        userCreationEnabled: (ws as any).userCreationEnabled === true,

        userCreationAllowlistEmails: eff.emails,
        userCreationAllowlistDomains: eff.domains,
        userCreationAllowlistUpdatedBy: (ws as any).userCreationAllowlistUpdatedBy || "",
        userCreationAllowlistUpdatedAt: (ws as any).userCreationAllowlistUpdatedAt || null,
      },
      business,
      leaderEmail: leaderEmail || null,
    });
  } catch (err: any) {
    console.error("[customerUsers:getWorkspaceConfig] error", err);
    res.status(500).json({ error: "Failed to read workspace config", detail: err?.message });
  }
});

/**
 * POST /api/customer/users/workspace/config
 */
router.post("/workspace/config", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    const actorEmail = normEmail(actor.email || "");
    const customerId = await resolveCustomerId(req);

    if (!customerId) {
      if (isStaffPrivileged(actor)) {
        return res.status(400).json({
          error: "Please set Customer ID first (Business id) to load the workspace.",
          hint: "Use /workspace/search or /workspace/resolve then pass ?customerId=<id>.",
        });
      }
      return res.status(400).json({ error: "Customer workspace not found" });
    }

    const ws: any = await ensureWorkspace(customerId);
    const business = pickBusinessView(await getBusinessById(customerId));
    const leaderEmail = await ensureOwnerIsLeaderSafe(customerId, ws, actor, business);

    const member = await getActorMember(customerId, actorEmail);
    const isStaff = isStaffPrivileged(actor);

    if (!isStaff) {
      const role = String(member?.role || "").toUpperCase();
      if (role !== "WORKSPACE_LEADER") {
        return res.status(403).json({ error: "Access restricted" });
      }

      const wh = ensureUserCreationWhitelisted(actor, member, ws);
      if (!wh.ok) return res.status((wh as any).status || 403).json({ error: (wh as any).error });
    }

    const patch: any = {};

    if (isStaff) {
      if ("canApproverCreateUsers" in req.body) patch.canApproverCreateUsers = !!req.body.canApproverCreateUsers;
      if ("userCreationEnabled" in req.body) patch.userCreationEnabled = !!req.body.userCreationEnabled;

      if ("userCreationAllowlistEmails" in req.body || "emails" in req.body) {
        const emails = normalizeEmailList(req.body.userCreationAllowlistEmails ?? req.body.emails);
        patch.userCreationAllowlistEmails = emails;
        patch.allowedEmails = emails;
        patch.userCreationAllowlistUpdatedBy = actorEmail;
        patch.userCreationAllowlistUpdatedAt = new Date();
      }
      if ("userCreationAllowlistDomains" in req.body || "domains" in req.body) {
        const domains = normalizeDomainList(req.body.userCreationAllowlistDomains ?? req.body.domains);
        patch.userCreationAllowlistDomains = domains;
        patch.allowedDomains = domains;
        patch.userCreationAllowlistUpdatedBy = actorEmail;
        patch.userCreationAllowlistUpdatedAt = new Date();
      }

      if ("allowedDomains" in req.body) patch.allowedDomains = normalizeDomainList(req.body.allowedDomains);
      if ("allowedEmails" in req.body) patch.allowedEmails = normalizeEmailList(req.body.allowedEmails);
    }

    if ("defaultApproverEmails" in req.body) {
      patch.defaultApproverEmails = normalizeEmailList(req.body.defaultApproverEmails);
    }

    Object.assign(ws, patch);
    await ws.save();

    const defaults = await ensureDefaultApproverFallback(ws, leaderEmail, actor);
    const eff = getEffectiveAllowlist(ws);

    res.json({
      ok: true,
      customerId,
      config: {
        status: (ws as any).status,
        allowedDomains: (ws as any).allowedDomains || [],
        allowedEmails: (ws as any).allowedEmails || [],
        defaultApproverEmails: normalizeEmailList(defaults),
        canApproverCreateUsers: !!(ws as any).canApproverCreateUsers,
        userCreationEnabled: (ws as any).userCreationEnabled === true,

        userCreationAllowlistEmails: eff.emails,
        userCreationAllowlistDomains: eff.domains,
        userCreationAllowlistUpdatedBy: (ws as any).userCreationAllowlistUpdatedBy || "",
        userCreationAllowlistUpdatedAt: (ws as any).userCreationAllowlistUpdatedAt || null,
      },
      business,
      leaderEmail: leaderEmail || null,
    });
  } catch (err: any) {
    console.error("[customerUsers:setWorkspaceConfig] error", err);
    res.status(500).json({ error: "Failed to update workspace config", detail: err?.message });
  }
});

/**
 * POST /api/customer/users/bulk
 * (CSV-only parsing here; XLSX can be added later)
 */
router.post("/bulk", requireAuth, upload.single("file"), async (req: any, res) => {
  try {
    const actor = req.user || {};
    const actorEmail = normEmail(actor.email || "");

    const customerId = await resolveCustomerId(req);
    if (!customerId) {
      if (isStaffPrivileged(actor)) {
        return res.status(400).json({
          error: "Please set Customer ID first (Business id) to load the workspace.",
        });
      }
      return res.status(400).json({ error: "Customer workspace not found for this login" });
    }

    const ws: any = await ensureWorkspace(customerId);
    const business = pickBusinessView(await getBusinessById(customerId));

    const leaderEmail = await ensureOwnerIsLeaderSafe(customerId, ws, actor, business);

    const member = await getActorMember(customerId, actorEmail);
    const wh = ensureUserCreationWhitelisted(actor, member, ws);
    if (!wh.ok) return res.status((wh as any).status || 403).json({ error: (wh as any).error });

    if (!req.file?.buffer) return res.status(400).json({ error: "Missing file" });

    const csv = req.file.buffer.toString("utf8");
    const rows = parseCsv(csv);
    if (!rows.length) return res.status(400).json({ error: "CSV is empty" });

    await ensureDefaultApproverFallback(ws, leaderEmail, actor);

    const results: any[] = [];
    for (const row of rows) {
      const email = normEmail(row.email);
      const name = normStr(row.name);
      const role = normRole(row.role || "REQUESTER") as MemberRole;

      if (!email) {
        results.push({ ok: false, error: "Missing email", row });
        continue;
      }
      if (!["WORKSPACE_LEADER", "APPROVER", "REQUESTER"].includes(role)) {
        results.push({ ok: false, error: "Invalid role", email, role });
        continue;
      }
      if (!isStaffPrivileged(actor) && !emailAllowedByWorkspace(ws, email)) {
        results.push({ ok: false, error: "Email/domain not allowed", email, domain: emailDomain(email) });
        continue;
      }

      let managerUser: any = null;
      const approverEmail = normEmail(row.approverEmail || "");
      if (role === "REQUESTER") {
        if (approverEmail) {
          const approverMember = await CustomerMember.findOne({
            customerId,
            email: approverEmail,
            isActive: true,
            role: { $in: ["APPROVER", "WORKSPACE_LEADER"] },
          })
            .lean()
            .exec();

          if (!approverMember) {
            results.push({ ok: false, error: "Invalid approverEmail", email, approverEmail });
            continue;
          }

          managerUser = await User.findOne({
            $or: [{ email: approverEmail }, { officialEmail: approverEmail }, { personalEmail: approverEmail }],
          }).exec();
        }

        if (!managerUser) {
          const defaults = normalizeEmailList((ws as any).defaultApproverEmails);

          if (isStaffPrivileged(actor) && defaults.length === 0) {
            results.push({
              ok: false,
              error: "Approver not configured",
              email,
              hint: "As staff, set defaultApproverEmails first OR provide approverEmail per row.",
            });
            continue;
          }

          const pick = defaults[0] ? normEmail(defaults[0]) : leaderEmail;
          if (!pick) {
            results.push({
              ok: false,
              error: "Approver not configured",
              email,
              hint: "Set defaultApproverEmails first OR provide approverEmail per row.",
            });
            continue;
          }

          managerUser = await User.findOne({
            $or: [{ email: pick }, { officialEmail: pick }, { personalEmail: pick }],
          }).exec();
        }
      }

      const now = new Date();
      const memberDoc = await CustomerMember.findOneAndUpdate(
        { customerId, email },
        {
          $set: { name: name || undefined, role, isActive: true, lastInviteAt: now },
          $setOnInsert: { customerId, email, invitedAt: now, createdBy: actorEmail },
        },
        { upsert: true, new: true },
      ).exec();

      const passwordPlain = row.password ? String(row.password) : null;
      const { user, created, tempPassword } = await ensureAuthUserForCustomer({
        email,
        name,
        customerId,
        memberRole: role,
        passwordPlain,
        managerUser,
      });

      const setAsDefaultApprover = normBool(row.setAsDefaultApprover);
      if (role === "APPROVER" && setAsDefaultApprover) {
        const list = normalizeEmailList((ws as any).defaultApproverEmails);
        if (!list.includes(email)) {
          (ws as any).defaultApproverEmails = [...list, email];
          await ws.save();
        }
      }

      await ensureDefaultApproverFallback(ws, leaderEmail, actor);

      const sendInvite = row.sendInvite === undefined ? true : normBool(row.sendInvite);
      const inviteStatus = sendInvite
        ? await trySendInviteEmailSafe({ to: email, customerId, inviterEmail: actorEmail, inviteeName: name })
        : { inviteEmailSent: false, inviteEmailSkipped: true as const, inviteEmailError: "sendInvite=false" };

      results.push({
        ok: true,
        email,
        role,
        memberId: String((memberDoc as any)?._id || ""),
        authUserId: String(user?._id || ""),
        createdAuthUser: created,
        tempPassword: passwordPlain ? null : tempPassword,
        ...inviteStatus,
      });
    }

    res.json({ ok: true, customerId, count: results.length, results });
  } catch (err: any) {
    console.error("[customerUsers:bulk] error", err);
    res.status(500).json({ error: "Failed bulk import", detail: err?.message });
  }
});

/**
 * POST /api/customer/users
 */
router.post("/", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    const actorEmail = normEmail(actor.email || "");

    const customerId = await resolveCustomerId(req);
    if (!customerId) {
      if (isStaffPrivileged(actor)) {
        return res.status(400).json({
          error: "Please set Customer ID first (Business id) to load the workspace.",
          hint: "Use /workspace/search or /workspace/resolve then pass ?customerId=<id>.",
        });
      }
      return res.status(400).json({ error: "Customer workspace not found for this login" });
    }

    const ws: any = await ensureWorkspace(customerId);
    const business = pickBusinessView(await getBusinessById(customerId));

    const leaderEmail = await ensureOwnerIsLeaderSafe(customerId, ws, actor, business);

    const member = await getActorMember(customerId, actorEmail);
    const wh = ensureUserCreationWhitelisted(actor, member, ws);
    if (!wh.ok) return res.status((wh as any).status || 403).json({ error: (wh as any).error });

    const email = normEmail(req.body?.email);
    const name = normStr(req.body?.name);
    const role = normRole(req.body?.role) as MemberRole;

    if (!email) return res.status(400).json({ error: "email is required" });
    if (!role || !["WORKSPACE_LEADER", "APPROVER", "REQUESTER"].includes(role)) {
      return res.status(400).json({ error: "role must be WORKSPACE_LEADER | APPROVER | REQUESTER" });
    }

    if (!isStaffPrivileged(actor) && !emailAllowedByWorkspace(ws, email)) {
      return res.status(400).json({
        error: "Email/domain not allowed for this workspace",
        hint: "HR/Admin must whitelist allowlist domains/emails for this customer.",
        email,
        domain: emailDomain(email),
      });
    }

    const requestedApproverEmail = normEmail(req.body?.approverEmail || "");
    let managerUser: any = null;

    if (role === "REQUESTER") {
      if (requestedApproverEmail) {
        const approverMember = await CustomerMember.findOne({
          customerId,
          email: requestedApproverEmail,
          isActive: true,
          role: { $in: ["APPROVER", "WORKSPACE_LEADER"] },
        })
          .lean()
          .exec();

        if (!approverMember) {
          return res.status(400).json({
            error: "Invalid approverEmail (must be an Approver or Workspace Leader in this workspace)",
          });
        }

        managerUser = await User.findOne({
          $or: [
            { email: requestedApproverEmail },
            { officialEmail: requestedApproverEmail },
            { personalEmail: requestedApproverEmail },
          ],
        }).exec();
      }

      if (!managerUser) {
        const defaults = normalizeEmailList((ws as any).defaultApproverEmails);

        if (isStaffPrivileged(actor) && defaults.length === 0) {
          return res.status(400).json({
            error: "Approver not configured",
            hint:
              "As staff, set workspace defaultApproverEmails first (POST /api/customer/users/workspace/config with defaultApproverEmails) OR pass approverEmail in this request.",
          });
        }

        const pick = defaults && defaults[0] ? normEmail(defaults[0]) : leaderEmail;
        if (!pick) {
          return res.status(400).json({
            error: "Approver not configured",
            hint: "Set workspace defaultApproverEmails first OR pass approverEmail.",
          });
        }

        managerUser = await User.findOne({
          $or: [{ email: pick }, { officialEmail: pick }, { personalEmail: pick }],
        }).exec();
      }
    }

    const now = new Date();
    const up = await CustomerMember.findOneAndUpdate(
      { customerId, email },
      {
        $set: { name: name || undefined, role, isActive: true, lastInviteAt: now },
        $setOnInsert: { customerId, email, invitedAt: now, createdBy: actorEmail },
      },
      { upsert: true, new: true },
    ).exec();

    const passwordPlain = req.body?.password ? String(req.body.password) : null;
    const { user, created, tempPassword } = await ensureAuthUserForCustomer({
      email,
      name,
      customerId,
      memberRole: role,
      passwordPlain,
      managerUser,
    });

    const setAsDefaultApprover = normBool(req.body?.setAsDefaultApprover);
    if (role === "APPROVER" && setAsDefaultApprover) {
      const list = normalizeEmailList((ws as any).defaultApproverEmails);
      if (!list.includes(email)) {
        (ws as any).defaultApproverEmails = [...list, email];
        await ws.save();
      }
    }

    await ensureDefaultApproverFallback(ws, leaderEmail, actor);

    const sendInvite = pickSendInviteFlag(req.body, true);
    const inviteStatus = sendInvite
      ? await trySendInviteEmailSafe({ to: email, customerId, inviterEmail: actorEmail, inviteeName: name })
      : { inviteEmailSent: false, inviteEmailSkipped: true as const, inviteEmailError: "sendInvite=false" };

    res.json({
      ok: true,
      customerId,
      member: up,
      authUser: {
        id: String(user?._id || ""),
        email: user?.email,
        roles: user?.roles || [],
        customerId: user?.customerId,
        managerId: user?.managerId ? String(user.managerId) : null,
        managerName: user?.managerName || null,
        reportingL1: user?.reportingL1 || null,
      },
      createdAuthUser: created,
      tempPassword: passwordPlain ? null : tempPassword,
      ...inviteStatus,
    });
  } catch (err: any) {
    console.error("[customerUsers:create] error", err);
    res.status(500).json({ error: "Failed to create customer user", detail: err?.message });
  }
});

/**
 * PATCH /api/customer/users/:id  (activate/deactivate)
 */
router.patch("/:id", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    const actorEmail = normEmail(actor.email || "");

    const customerId = await resolveCustomerId(req);
    if (!customerId) {
      if (isStaffPrivileged(actor)) {
        return res.status(400).json({ error: "Please set Customer ID first (Business id) to load the workspace." });
      }
      return res.status(400).json({ error: "Customer workspace not found for this login" });
    }

    const ws: any = await ensureWorkspace(customerId);
    const business = pickBusinessView(await getBusinessById(customerId));

    await ensureOwnerIsLeaderSafe(customerId, ws, actor, business);

    const member = await getActorMember(customerId, actorEmail);
    const wh = ensureUserCreationWhitelisted(actor, member, ws);
    if (!wh.ok) return res.status((wh as any).status || 403).json({ error: (wh as any).error });

    const id = normStr(req.params?.id);
    const active = req.body?.active === undefined ? undefined : !!req.body.active;

    if (!id) return res.status(400).json({ error: "id is required" });
    if (active === undefined) return res.status(400).json({ error: "active is required" });

    const updated = await CustomerMember.findOneAndUpdate({ _id: id, customerId }, { $set: { isActive: active } }, { new: true })
      .lean()
      .exec();

    if (!updated) return res.status(404).json({ error: "Member not found" });
    res.json({ ok: true, member: updated });
  } catch (err: any) {
    console.error("[customerUsers:patch] error", err);
    res.status(500).json({ error: "Failed to update user", detail: err?.message });
  }
});

/**
 * POST /api/customer/users/:id/reinvite
 */
router.post("/:id/reinvite", requireAuth, async (req: any, res) => {
  try {
    const actor = req.user || {};
    const actorEmail = normEmail(actor.email || "");

    const customerId = await resolveCustomerId(req);
    if (!customerId) {
      if (isStaffPrivileged(actor)) {
        return res.status(400).json({ error: "Please set Customer ID first (Business id) to load the workspace." });
      }
      return res.status(400).json({ error: "Customer workspace not found for this login" });
    }

    const ws: any = await ensureWorkspace(customerId);
    const business = pickBusinessView(await getBusinessById(customerId));

    await ensureOwnerIsLeaderSafe(customerId, ws, actor, business);

    const member = await getActorMember(customerId, actorEmail);
    const wh = ensureUserCreationWhitelisted(actor, member, ws);
    if (!wh.ok) return res.status((wh as any).status || 403).json({ error: (wh as any).error });

    const id = normStr(req.params?.id);
    if (!id) return res.status(400).json({ error: "id is required" });

    const m: any = await CustomerMember.findOne({ _id: id, customerId }).lean().exec();
    if (!m) return res.status(404).json({ error: "Member not found" });

    const inviteStatus = await trySendInviteEmailSafe({
      to: normEmail(m.email),
      customerId,
      inviterEmail: actorEmail,
      inviteeName: m.name,
    });

    await CustomerMember.updateOne({ _id: id }, { $set: { lastInviteAt: new Date() } }).exec();

    res.json({ ok: true, ...inviteStatus });
  } catch (err: any) {
    console.error("[customerUsers:reinvite] error", err);
    res.status(500).json({ error: "Failed to reinvite", detail: err?.message });
  }
});

export default router;

/* =========================================================
 * Shared staff business search (MasterData + Onboarding)
 * ======================================================= */
async function staffSearchBusinesses(q: string) {
  const query = normStr(q || "");
  if (!query || query.length < 2) return { rows: [] as any[], ids: [] as string[] };

  const qEsc = escapeRegex(query);
  const re = new RegExp(qEsc, "i");

  const mdRows: any[] = (await MasterData.find({
    type: /business|customer/i,
    $or: [
      { name: re },
      { title: re },
      { companyName: re },
      { businessName: re },
      { contactName: re },
      { fullName: re },
      { inviteeName: re },
      { email: re },
      { officialEmail: re },
      { website: re },
      { officialWebsite: re },
      { domain: re },
      { "payload.name": re },
      { "payload.companyName": re },
      { "payload.businessName": re },
      { "payload.contactName": re },
      { "payload.fullName": re },
      { "payload.inviteeName": re },
      { "payload.email": re },
      { "payload.domain": re },
      { "payload.website": re },
    ],
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(25)
    .lean()
    .exec()) as any;

  const obRows: any[] = (await Onboarding.find({
    type: /business|customer/i,
    $or: [
      { name: re },
      { title: re },
      { companyName: re },
      { businessName: re },
      { contactName: re },
      { fullName: re },
      { inviteeName: re },
      { email: re },
      { officialEmail: re },
      { website: re },
      { officialWebsite: re },
      { domain: re },
      { status: re },
      { "payload.name": re },
      { "payload.companyName": re },
      { "payload.businessName": re },
      { "payload.contactName": re },
      { "payload.fullName": re },
      { "payload.inviteeName": re },
      { "payload.email": re },
      { "payload.domain": re },
      { "payload.website": re },
    ],
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(25)
    .lean()
    .exec()) as any;

  const merged = new Map<string, any>();

  for (const md of mdRows || []) {
    const view = pickBusinessView({ source: "MasterData", doc: md });
    if (view?.id) merged.set(view.id, view);
  }
  for (const ob of obRows || []) {
    const view = pickBusinessView({ source: "Onboarding", doc: ob });
    if (view?.id && !merged.has(view.id)) merged.set(view.id, view);
  }

  const rows = Array.from(merged.values()).slice(0, 25);
  const ids = rows.map((r) => String(r.id)).filter(Boolean);

  return { rows, ids };
}

/* =========================================================
 * Minimal CSV parser (supports quoted values)
 * ======================================================= */
function parseCsv(csv: string): Array<Record<string, string>> {
  const text = String(csv || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return [];

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const out: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => (row[h] = (cols[idx] ?? "").trim()));

    out.push({
      email: row.email || row.Email || row.EMAIL || "",
      name: row.name || row.Name || row.fullName || row.FullName || "",
      role: row.role || row.Role || "",
      approverEmail: row.approverEmail || row.ApproverEmail || row.managerEmail || row.ManagerEmail || "",
      password: row.password || row.Password || "",
      sendInvite: row.sendInvite || row.SendInvite || "",
      setAsDefaultApprover: row.setAsDefaultApprover || row.SetAsDefaultApprover || "",
    });
  }

  return out;
}

function splitCsvLine(line: string): string[] {
  const s = String(line || "");
  const out: string[] = [];
  let cur = "";
  let inQ = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQ && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
