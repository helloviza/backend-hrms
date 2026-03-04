// apps/backend/src/services/video/startVideoAnalysis.ts

import VideoAnalysis from "../../models/VideoAnalysis.js";
import { ingestVideoTranscript } from "./videoIngest.service.js";
import { ingestVideoOcr } from "./videoOcr.service.js";
import { extractVideoInsights } from "./videoInsightExtractor.js";

/**
 * Orchestrates full video analysis pipeline
 * -----------------------------------------
 * Phase 1(A): Speech-to-Text (Whisper)
 * Phase 1(B): OCR (only if transcript is empty)
 * Phase 2+3: Classification + Pluto insights
 *
 * Guarantees:
 * - Async / non-blocking
 * - Idempotent (no re-run)
 * - Never hard-fails user flow
 */
export function startVideoAnalysis(videoId: string) {
  // Run asynchronously so API responds instantly
  setImmediate(async () => {
    try {
      const record = await VideoAnalysis.findById(videoId);
      if (!record) return;

      // 🔒 Safety: do not re-run analysis
      if (record.status !== "processing") return;

      /**
       * PHASE 1(A): Audio → Speech-to-Text (Whisper)
       * May produce empty transcript (valid)
       */
      await ingestVideoTranscript(videoId);

      /**
       * PHASE 1(B): Frames → OCR
       * Runs ONLY if transcript is empty
       */
      await ingestVideoOcr(videoId);

      /**
       * PHASE 2 & 3:
       * - Intent classification
       * - Pluto insight extraction
       * - Responsible for setting status = "analyzed"
       */
      await extractVideoInsights(videoId);
    } catch (err: any) {
      console.error("Video analysis failed:", err);

      await VideoAnalysis.findByIdAndUpdate(videoId, {
        status: "failed",
        error: err?.message || "Video analysis failed",
        progress: 0,
      });
    }
  });
}