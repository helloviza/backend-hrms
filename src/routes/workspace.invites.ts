import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";

import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import WorkspaceInvite from "../models/WorkspaceInvite.js";
import { sendEmployeeInvite } from "../services/email.service.js";
import { actorName } from "../services/actorNames.js";

const router = Router();

const INVITE_LINK_BASE = "https://plumbox.plumtrips.com/join";
const INVITE_TTL_DAYS = 7;
const MAX_EMAILS_PER_REQUEST = 50;

/* ── Helpers ─────────────────────────────────────────────────────── */

function normEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function normStr(v: unknown): string {
  return String(v ?? "").trim();
}

/**
 * Invites are workspace administration. Same role set and normalisation as
 * workspace.branding.ts's requireBrandingRole, plus WORKSPACE_ADMIN (the role
 * auth.signup.ts gives a self-signup owner). Roles come from the session
 * token, and requireWorkspace (mounted first) pins the workspace from that
 * same token — so this is "admin of THIS workspace". It used to be any
 * logged-in user, and GET / handed back every invite's token: any user could
 * invite any email and read the link that sets its password.
 */
const INVITE_ADMIN_ROLES = new Set([
  "TENANT_ADMIN",
  "WORKSPACE_LEADER",
  "WORKSPACE_ADMIN",
  "SUPERADMIN",
]);

function requireInviteAdmin(req: Request, res: Response, next: NextFunction) {
  if (isSuperAdmin(req)) return next();
  const user = (req as any).user;
  const roles: string[] = Array.isArray(user?.roles)
    ? user.roles.map((r: string) => String(r).toUpperCase().replace(/[\s\-]/g, "_"))
    : [];
  const memberRole = String(user?.customerMemberRole || "").toUpperCase();
  if (roles.some((r) => INVITE_ADMIN_ROLES.has(r)) || memberRole === "WORKSPACE_LEADER") {
    return next();
  }
  res.status(403).json({ error: "Inviting people requires Tenant Admin or Workspace Leader." });
}

/**
 * The roles an invite may confer. POST /api/auth/accept-invite creates the
 * login with `roles: [invite.role]` verbatim, so an unchecked role was a
 * straight path to SUPERADMIN. These are the roles the invite screens offer
 * (TeamTab, WorkspaceSettings, employees.ts's HR invite). Shared with the
 * accept paths so an invite already in the DB with any other role is refused.
 */
export const INVITABLE_ROLES = new Set(["EMPLOYEE", "MANAGER", "HR", "ADMIN", "APPROVER", "REQUESTER"]);

/**
 * ADMIN and HR are platform roles, not workspace roles: requireAdmin
 * (middleware/rbac.ts) and many inline checks admit them with no workspace or
 * HOUSE filter — cross-tenant billing, orphan refunds, other companies' users.
 * So only a SuperAdmin may invite someone into them, and /join (auth.signup.ts)
 * re-checks that the inviter of a stored ADMIN/HR invite was a SuperAdmin.
 */
export const SUPERADMIN_ONLY_INVITE_ROLES = new Set(["ADMIN", "HR"]);

/**
 * Core invite processor — shared by POST /send and POST /bulk-csv.
 * Returns { sent, skipped, alreadyMembers, errors }.
 */
async function processInvites(
  rows: Array<{ email: string; name?: string; role?: string; department?: string; designation?: string }>,
  ctx: { workspaceObjectId: any; invitedById: string; inviterName: string; companyName: string; inviterIsSuperAdmin: boolean },
): Promise<{ sent: string[]; skipped: string[]; alreadyMembers: string[]; errors: string[] }> {
  const sent: string[] = [];
  const skipped: string[] = [];
  const alreadyMembers: string[] = [];
  const errors: string[] = [];

  for (const row of rows) {
    const email = normEmail(row.email);
    if (!email || !email.includes("@")) {
      errors.push(`Invalid email: ${row.email}`);
      continue;
    }

    try {
      /* ── 1. Already a workspace member? ───────────────────────── */
      const existingUser = await User.findOne({
        email,
        workspaceId: ctx.workspaceObjectId,
      });

      if (existingUser) {
        alreadyMembers.push(email);
        continue;
      }

      /* ── 1b. A login elsewhere? Refuse until memberships exist ──── */
      // One email = one User today. Accepting this invite would either
      // collide with that login or (signup.ts invite/accept) reset its
      // password — so a person who already has a login in another workspace
      // cannot be invited here.
      const elsewhere = await User.findOne({
        $or: [{ email }, { officialEmail: email }, { personalEmail: email }],
        workspaceId: { $ne: ctx.workspaceObjectId },
      })
        .select("_id")
        .lean();
      if (elsewhere) {
        errors.push(`${email}: already has a Plumbox login in another company and can't be invited here yet`);
        continue;
      }

      const role = normStr(row.role).toUpperCase() || "EMPLOYEE";
      if (!INVITABLE_ROLES.has(role)) {
        errors.push(`${email}: role '${role}' can't be granted by invite`);
        continue;
      }
      if (SUPERADMIN_ONLY_INVITE_ROLES.has(role) && !ctx.inviterIsSuperAdmin) {
        errors.push(`${email}: only Plumtrips can invite someone as ${role} — invite them as EMPLOYEE, MANAGER, APPROVER or REQUESTER`);
        continue;
      }

      /* ── 2. Pending invite already exists? ────────────────────── */
      const existingInvite = await WorkspaceInvite.findOne({
        workspaceId: ctx.workspaceObjectId,
        email,
        status: "pending",
        expiresAt: { $gt: new Date() },
      });

      if (existingInvite) {
        skipped.push(email);
        continue;
      }

      /* ── 3. Create invite ──────────────────────────────────────── */
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

      await WorkspaceInvite.create({
        workspaceId: ctx.workspaceObjectId,
        email,
        name: normStr(row.name) || undefined,
        role,
        department: normStr(row.department) || undefined,
        designation: normStr(row.designation) || undefined,
        invitedBy: ctx.invitedById,
        token,
        expiresAt,
        status: "pending",
      });

      /* ── 4. Send invite email ──────────────────────────────────── */
      const inviteUrl = `${INVITE_LINK_BASE}?token=${token}`;
      await sendEmployeeInvite(email, {
        companyName: ctx.companyName,
        inviterName: ctx.inviterName,
        inviteUrl,
        expiresAt,
      });

      sent.push(email);
    } catch (err: any) {
      console.error(`[workspace.invites] Error processing invite for ${email}:`, err);
      errors.push(`${email}: ${err?.message ?? "unknown error"}`);
    }
  }

  return { sent, skipped, alreadyMembers, errors };
}

/* ── POST /send ──────────────────────────────────────────────────── */
router.post(
  "/send",
  requireAuth,
  requireWorkspace,
  requireInviteAdmin,
  async (req: Request, res: Response) => {
    try {
      const { emails, role, department, designation } = req.body as {
        emails: string[];
        role?: string;
        department?: string;
        designation?: string;
      };

      if (!Array.isArray(emails) || emails.length === 0) {
        res.status(400).json({ error: "emails array is required" });
        return;
      }

      if (emails.length > MAX_EMAILS_PER_REQUEST) {
        res.status(400).json({ error: `Maximum ${MAX_EMAILS_PER_REQUEST} emails per request` });
        return;
      }

      const user = (req as any).user;
      const workspace = await CustomerWorkspace.findById(req.workspaceObjectId);

      if (!workspace) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }

      const rows = emails.map((email) => ({ email, role, department, designation }));

      const result = await processInvites(rows, {
        workspaceObjectId: req.workspaceObjectId,
        invitedById: user._id ?? user.id ?? user.sub,
        inviterName: (await actorName(user)) || normEmail(user.email),
        companyName: workspace.companyName || "your company",
        inviterIsSuperAdmin: isSuperAdmin(req),
      });

      res.json(result);
    } catch (err) {
      console.error("[workspace.invites] POST /send error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── POST /bulk-csv ──────────────────────────────────────────────── */
/**
 * Accepts JSON body: { rows: [{ email, name, role, department, designation }] }
 * for simplicity (avoids a file upload requirement).
 */
router.post(
  "/bulk-csv",
  requireAuth,
  requireWorkspace,
  requireInviteAdmin,
  async (req: Request, res: Response) => {
    try {
      const { rows } = req.body as {
        rows: Array<{
          email: string;
          name?: string;
          role?: string;
          department?: string;
          designation?: string;
        }>;
      };

      if (!Array.isArray(rows) || rows.length === 0) {
        res.status(400).json({ error: "rows array is required" });
        return;
      }

      if (rows.length > MAX_EMAILS_PER_REQUEST) {
        res.status(400).json({ error: `Maximum ${MAX_EMAILS_PER_REQUEST} rows per request` });
        return;
      }

      const user = (req as any).user;
      const workspace = await CustomerWorkspace.findById(req.workspaceObjectId);

      if (!workspace) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }

      const result = await processInvites(rows, {
        workspaceObjectId: req.workspaceObjectId,
        invitedById: user._id ?? user.id ?? user.sub,
        inviterName: (await actorName(user)) || normEmail(user.email),
        companyName: workspace.companyName || "your company",
        inviterIsSuperAdmin: isSuperAdmin(req),
      });

      res.json(result);
    } catch (err) {
      console.error("[workspace.invites] POST /bulk-csv error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── GET / ───────────────────────────────────────────────────────── */
router.get(
  "/",
  requireAuth,
  requireWorkspace,
  requireInviteAdmin,
  async (req: Request, res: Response) => {
    try {
      const { status } = req.query as { status?: string };
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
      const skip = (page - 1) * limit;

      const filter: Record<string, unknown> = {
        workspaceId: req.workspaceObjectId,
      };

      if (status) {
        const allowed = ["pending", "accepted", "expired", "revoked"];
        if (!allowed.includes(status)) {
          res.status(400).json({ error: `Invalid status. Must be one of: ${allowed.join(", ")}` });
          return;
        }
        filter.status = status;
      }

      const [invites, total] = await Promise.all([
        // Explicit projection: the token is the credential that sets the
        // invitee's password — it goes to their inbox, never to this list.
        WorkspaceInvite.find(filter)
          .select("-token")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        WorkspaceInvite.countDocuments(filter),
      ]);

      res.json({ invites, total, page, limit });
    } catch (err) {
      console.error("[workspace.invites] GET / error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── DELETE /:inviteId ───────────────────────────────────────────── */
router.delete(
  "/:inviteId",
  requireAuth,
  requireWorkspace,
  requireInviteAdmin,
  async (req: Request, res: Response) => {
    try {
      const { inviteId } = req.params;

      const invite = await WorkspaceInvite.findOne({
        _id: inviteId,
        workspaceId: req.workspaceObjectId,
      });

      if (!invite) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }

      if (invite.status !== "pending") {
        res.status(400).json({ error: `Cannot revoke an invite with status '${invite.status}'` });
        return;
      }

      invite.status = "revoked";
      await invite.save();

      res.json({ success: true, inviteId });
    } catch (err) {
      console.error("[workspace.invites] DELETE /:inviteId error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
