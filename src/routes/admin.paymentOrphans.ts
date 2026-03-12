import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import PaymentOrphan from "../models/PaymentOrphan.js";

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

// GET /api/admin/payment-orphans — list unresolved orphans
router.get("/", async (_req: Request, res: Response) => {
  try {
    const orphans = await PaymentOrphan.find({ resolvedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ ok: true, orphans });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch payment orphans";
    res.status(500).json({ error: msg });
  }
});

// PATCH /api/admin/payment-orphans/:id/resolve
router.patch("/:id/resolve", async (req: Request, res: Response) => {
  try {
    const { notes } = req.body || {};
    const adminEmail = (req as any).user?.email || "unknown";

    const doc = await PaymentOrphan.findByIdAndUpdate(
      req.params.id,
      {
        resolvedAt: new Date(),
        resolvedBy: adminEmail,
        notes: notes || "",
      },
      { new: true },
    );
    if (!doc) return res.status(404).json({ error: "Orphan record not found" });
    res.json({ ok: true, orphan: doc });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to resolve orphan";
    res.status(500).json({ error: msg });
  }
});

export default router;
