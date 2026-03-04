// apps/backend/src/routes/leaves.ts
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import Leave from "../models/LeaveRequest.js";
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
      const lr = await Leave.create({
        ...(req.body as any),
        type: result.data.type,
        userId,
        status: "PENDING",
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

export default r;
