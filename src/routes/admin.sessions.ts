import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import SessionLog from "../models/SessionLog.js";

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

// GET /api/admin/sessions
router.get("/", async (req: Request, res: Response) => {
  try {
    const {
      userId,
      email,
      event,
      from,
      to,
      page = "1",
      limit = "50",
    } = req.query as Record<string, string>;

    const filter: any = {};
    if (userId) filter.userId = userId;
    if (email) filter.email = new RegExp(email, "i");
    if (event) filter.event = event.toUpperCase();
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [logs, total] = await Promise.all([
      SessionLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      SessionLog.countDocuments(filter),
    ]);

    res.json({
      ok: true,
      logs,
      total,
      page: pageNum,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch session logs";
    res.status(500).json({ error: msg });
  }
});

// GET /api/admin/sessions/suspicious
// Returns LOGIN_FAILED events with 3+ failures from same IP in last 24 hours
router.get("/suspicious", async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const results = await SessionLog.aggregate([
      {
        $match: {
          event: "LOGIN_FAILED",
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: "$ipAddress",
          count: { $sum: 1 },
          emails: { $addToSet: "$email" },
          lastAttempt: { $max: "$createdAt" },
        },
      },
      { $match: { count: { $gte: 3 } } },
      { $sort: { count: -1 } },
    ]);

    res.json({
      ok: true,
      suspicious: results.map((r) => ({
        ipAddress: r._id,
        count: r.count,
        emails: r.emails,
        lastAttempt: r.lastAttempt,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch suspicious activity";
    res.status(500).json({ error: msg });
  }
});

export default router;
