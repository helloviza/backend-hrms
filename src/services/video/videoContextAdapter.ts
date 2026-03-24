// apps/backend/src/services/video/videoContextAdapter.ts

import VideoAnalysis from "../../models/VideoAnalysis.js";

/**
 * Attach video insights to conversation context
 * ---------------------------------------------
 * PRODUCTION RULES:
 * - Attach ONLY analyzed videos
 * - Never inject partial / processing data
 * - Never infer or modify insights
 * - Silent and safe
 */
export async function attachVideoContext(
  conversationContext: any,
  videoAnalysisId?: string
) {
  if (!videoAnalysisId) return conversationContext;

  const record = await VideoAnalysis.findOne({
    _id: videoAnalysisId,
    status: "analyzed",
  }).lean();

  // ❌ No record OR not analyzed → do nothing
  if (!record || !record.injectedContext) {
    return conversationContext;
  }

  // ✅ Attach once, explicitly
  conversationContext.videoInsights = {
    source: "video",
    videoId: record._id,
    injectedAt: record.updatedAt,
    ...record.injectedContext,
  };

  return conversationContext;
}