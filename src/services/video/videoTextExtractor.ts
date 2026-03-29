// apps/backend/src/services/video/videoTextExtractor.ts

import VideoAnalysis from "../../models/VideoAnalysis.js";

/**
 * Extract unified text from video analysis
 * ----------------------------------------
 * Sources:
 * - Speech transcript (if available)
 * - OCR / on-screen text (if available)
 *
 * HARD RULES:
 * - NEVER fail the pipeline
 * - Empty text is VALID
 * - No AI calls here
 */

export async function extractVideoText(videoAnalysisId: string) {
  const record = await VideoAnalysis.findOne({ _id: videoAnalysisId });
  if (!record) {
    throw new Error("VideoAnalysis record not found");
  }

  try {
    record.status = "processing";
    record.progress = Math.max(record.progress || 0, 15);
    await record.save();

    // 1️⃣ Speech-to-text (audio transcript)
    const transcriptText =
      typeof record.transcript === "string"
        ? record.transcript.trim()
        : "";

    // 2️⃣ OCR / on-screen text
    const ocrText =
      Array.isArray(record.scenes)
        ? record.scenes
            .map((s: any) => s?.text || "")
            .filter(Boolean)
            .join("\n")
        : "";

    // 3️⃣ Merge text sources
    const mergedText = [transcriptText, ocrText]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    // 4️⃣ Persist extracted text
    record.extractedText = mergedText || null;

    record.progress = 30;
    record.status = "text_ready";

    await record.save();

    return {
      ok: true,
      videoId: record._id,
      textLength: mergedText.length,
      hasText: Boolean(mergedText),
    };
  } catch (err: any) {
    // 🚨 Degrade gracefully
    record.extractedText = null;
    record.status = "text_ready";
    record.progress = 30;
    record.error = null;

    await record.save();

    return {
      ok: true,
      videoId: record._id,
      textLength: 0,
      hasText: false,
      degraded: true,
    };
  }
}