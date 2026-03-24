// apps/backend/src/routes/leaves.ts
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import Leave from "../models/LeaveRequest.js";
import LeaveBalance from "../models/LeaveBalance.js";
import requireAuth from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";

const r = Router();

r.use(requireAuth);

const applySchema = z.object({
  type: z.enum([
    "CASUAL",
    "SICK",
    "PAID",
    "UNPAID",
    "MATERNITY",
    "COMPOFF",
    "BEREAVEMENT",
    "PATERNITY",
  ]),
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1).max(500),
});

const approveSchema = z.object({
  remarks: z.string().max(500).optional(),
});

const rejectSchema = z.object({
  remarks: z.string().min(1).max(500),
});

// ───────────────── APPLY LEAVE ─────────────────
r.post(
  "/apply",
  audit("leave-apply"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = applySchema.safeParse(req.body);
      if (!result.success)
        return res.status(400).json({
          error: "Validation failed",
          fields: result.error.flatten().fieldErrors,
        });

      const userId = (req as any).user.sub;

      // Quota enforcement
      const from = new Date(result.data.from);
      const to = new Date(result.data.to);
      const daysRequested = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1;

      const year = new Date().getFullYear();
      let balance = await LeaveBalance.findOne({ userId, year });
      if (!balance) {
        balance = await LeaveBalance.create({ userId, year });
      }

      const leaveType = result.data.type as keyof typeof balance.balances;
      const remaining = balance.balances[leaveType] ?? 999;

      if (remaining !== 999 && daysRequested > remaining) {
        return res.status(400).json({
          error: "Insufficient leave balance",
          type: leaveType,
          requested: daysRequested,
          remaining,
        });
      }

      const lr = await Leave.create({
        ...(req.body as any),
        type: result.data.type,
        userId,
        status: "PENDING",
        days: daysRequested,
      });

      return res.json(lr);
    } catch (err) {
      return next(err);
    }
  }
);

// ───────────────── APPROVE ─────────────────
r.post(
  "/:id/approve",
  audit("leave-approve"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = approveSchema.safeParse(req.body);
      if (!result.success)
        return res.status(400).json({
          error: "Validation failed",
          fields: result.error.flatten().fieldErrors,
        });

      const userRoles = (req as any).user?.roles || [];
      const canApprove = userRoles.some((r: string) =>
        ["MANAGER", "HR", "ADMIN", "SUPERADMIN"].includes(r.toUpperCase())
      );
      if (!canApprove) return res.status(403).json({ error: "Not authorized" });
      const approverId = (req as any).user.sub;
      const lr = await Leave.findByIdAndUpdate(
        req.params.id,
        {
          status: "APPROVED",
          approverId,
          $push: {
            history: {
              at: new Date(),
              by: approverId,
              action: "APPROVED",
              note: result.data.remarks,
            },
          },
        },
        { new: true }
      );
      return res.json(lr);
    } catch (err) {
      return next(err);
    }
  }
);

// ───────────────── REJECT ─────────────────
r.post(
  "/:id/reject",
  audit("leave-reject"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = rejectSchema.safeParse(req.body);
      if (!result.success)
        return res.status(400).json({
          error: "Validation failed",
          fields: result.error.flatten().fieldErrors,
        });

      const userRoles = (req as any).user?.roles || [];
      const canApprove = userRoles.some((r: string) =>
        ["MANAGER", "HR", "ADMIN", "SUPERADMIN"].includes(r.toUpperCase())
      );
      if (!canApprove) return res.status(403).json({ error: "Not authorized" });
      const approverId = (req as any).user.sub;
      const lr = await Leave.findByIdAndUpdate(
        req.params.id,
        {
          status: "REJECTED",
          approverId,
          $push: {
            history: {
              at: new Date(),
              by: approverId,
              action: "REJECTED",
              note: result.data.remarks,
            },
          },
        },
        { new: true }
      );
      return res.json(lr);
    } catch (err) {
      return next(err);
    }
  }
);

// ───────────────── MY LEAVES (alias: /mine & /my) ─────────────────
async function handleMyLeaves(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = (req as any).user.sub;
    const items = await Leave.find({ userId }).sort({ createdAt: -1 });
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
}

r.get("/mine", handleMyLeaves);
r.get("/my", handleMyLeaves); // ✅ keep existing /my endpoint working

// ───────────────── BALANCE (remaining days per type for current year) ─────────────────
const LEAVE_TYPES = [
  "CASUAL", "SICK", "PAID", "UNPAID",
  "MATERNITY", "PATERNITY", "COMPOFF", "BEREAVEMENT",
] as const;

r.get(
  "/balance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const year = new Date().getFullYear();

      let balance = await LeaveBalance.findOne({ userId, year });
      if (!balance) {
        balance = await LeaveBalance.create({ userId, year });
      }

      // Compute approved days used this year per leave type
      const yearStart = new Date(year, 0, 1);
      const yearEnd = new Date(year + 1, 0, 1);
      const approved = await Leave.find({
        userId,
        status: "APPROVED",
        from: { $gte: yearStart, $lt: yearEnd },
      });

      const used: Record<string, number> = {};
      for (const leave of approved) {
        const days =
          leave.days ??
          Math.ceil(
            (new Date(leave.to).getTime() - new Date(leave.from).getTime()) /
              (1000 * 60 * 60 * 24)
          ) + 1;
        used[leave.type] = (used[leave.type] || 0) + days;
      }

      const remaining: Record<string, number> = {};
      for (const type of LEAVE_TYPES) {
        const quota = balance.balances[type];
        remaining[type] = Math.max(0, quota - (used[type] || 0));
      }

      return res.json({ year, balances: remaining });
    } catch (err) {
      return next(err);
    }
  }
);

export default r;
