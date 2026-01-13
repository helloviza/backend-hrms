// apps/backend/src/routes/leaves.ts
import { Router, Request, Response, NextFunction } from "express";
import Leave from "../models/LeaveRequest.js";
import requireAuth from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";

const r = Router();

r.use(requireAuth);

const ALLOWED_TYPES = [
  "CASUAL",
  "SICK",
  "PAID",
  "UNPAID",
  "MATERNITY",
  "COMPOFF",
];

// ───────────────── APPLY LEAVE ─────────────────
r.post(
  "/apply",
  audit("leave-apply"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;

      const rawType = String((req.body as any)?.type || "").trim();
      const normalizedType = rawType.toUpperCase();

      if (!ALLOWED_TYPES.includes(normalizedType)) {
        return res.status(400).json({
          ok: false,
          message: `Unsupported leave type: ${rawType}`,
        });
      }

      const lr = await Leave.create({
        ...(req.body as any),
        type: normalizedType, // ✅ ensure enum-safe
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
      const approverId = (req as any).user.sub;
      const lr = await Leave.findByIdAndUpdate(
        req.params.id,
        {
          status: "APPROVED",
          approverId,
          $push: {
            history: { at: new Date(), by: approverId, action: "APPROVED" },
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
              note: (req.body as any)?.note,
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
