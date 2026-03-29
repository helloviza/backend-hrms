import { Router, type Request, type Response } from "express";
import crypto from "crypto";

import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import WorkspaceInvite from "../models/WorkspaceInvite.js";
import { sendEmployeeInvite } from "../services/email.service.js";

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
 * Core invite processor — shared by POST /send and POST /bulk-csv.
 * Returns { sent, skipped, alreadyMembers, errors }.
 */
async function processInvites(
  rows: Array<{ email: string; name?: string; role?: string; department?: string; designation?: string }>,
  ctx: { workspaceObjectId: any; invitedById: string; inviterName: string; companyName: string },
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
        role: normStr(row.role).toUpperCase() || "EMPLOYEE",
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
        inviterName: normStr(user.name) || normEmail(user.email),
        companyName: workspace.companyName || "your company",
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
        inviterName: normStr(user.name) || normEmail(user.email),
        companyName: workspace.companyName || "your company",
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
        WorkspaceInvite.find(filter)
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
