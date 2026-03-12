import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import SBTConfig from "../models/SBTConfig.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

// GET /api/admin/sbt/offer — current offer config
router.get("/offer", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "offer" }).lean();
    if (!doc) return res.json({ ok: true, enabled: false });
    res.json({ ok: true, ...((doc.value as any) ?? {}), enabled: (doc.value as any)?.enabled ?? false });
  } catch (err: any) {
    console.error("[Admin SBT Offer GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sbt/offer — upsert offer config
router.put("/offer", async (req: any, res: any) => {
  try {
    const { enabled, title, description, ctaText, ctaUrl, bgColor } = req.body;
    const value = { enabled: !!enabled, title, description, ctaText, ctaUrl, bgColor };
    const userId = req.user?._id ?? req.user?.id ?? "";

    const doc = await SBTConfig.findOneAndUpdate(
      { key: "offer" },
      { $set: { value, updatedBy: String(userId) } },
      { upsert: true, new: true },
    );
    res.json({ ok: true, offer: doc.value });
  } catch (err: any) {
    console.error("[Admin SBT Offer PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
