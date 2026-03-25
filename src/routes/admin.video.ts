// apps/backend/src/routes/admin.video.ts
// ─────────────────────────────────────────────
// Admin-only route to force re-analysis of a video
// Useful when analysis ran with old/buggy code
//
// POST /api/v1/admin/video/:videoId/reanalyze
// ─────────────────────────────────────────────

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import VideoAnalysis from "../models/VideoAnalysis.js";
import { startVideoAnalysis } from "../services/video/startVideoAnalysis.js";

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

router.post("/video/:videoId/reanalyze", async (req, res) => {
  try {
    const { videoId } = req.params;

    const video = await VideoAnalysis.findById(videoId);
    if (!video) {
      return res.status(404).json({ ok: false, message: "Video not found" });
    }

    // ✅ Reset status to "processing" so idempotency check passes
    // Old code blocked re-analysis with: if (record.status !== "processing") return
    video.status = "processing";
    video.progress = 0;
    video.error = null;
    video.summaryType = "unclear";   // reset so fresh analysis writes correctly
    video.classification = undefined as any;
    await video.save();

    // Trigger fresh analysis
    startVideoAnalysis(videoId);

    return res.json({
      ok: true,
      message: "Re-analysis started",
      videoId,
    });
  } catch (err: any) {
    console.error("Reanalyze error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

export default router;