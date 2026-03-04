// apps/backend/src/workers/videoProcessingWorker.ts

import VideoAnalysis from "../models/VideoAnalysis.js";
import { ingestVideoTranscript } from "../services/video/videoIngest.service.js";
import { extractVideoInsights } from "../services/video/videoInsightExtractor.js";

const POLL_INTERVAL_MS = 15_000; // 15 seconds
let isRunning = false;

/**
 * Video Processing Worker
 * -----------------------
 * Finds uploaded videos and processes them asynchronously.
 *
 * PIPELINE:
 * uploaded
 *   → processing
 *   → transcript ingestion (Google STT)
 *   → insight extraction
 *   → analyzed
 *
 * SAFE GUARANTEES:
 * - Single-process lock
 * - Status-based idempotency
 * - Crash-safe (DB is source of truth)
 * - Graceful degradation (STT failure does NOT break pipeline)
 */

export function startVideoProcessingWorker() {
  if (isRunning) return;
  isRunning = true;

  console.log("🎥 Video processing worker started");

  setInterval(async () => {
    try {
      /**
       * Pick ONE unprocessed video at a time.
       * Atomic update ensures no double-processing.
       */
      const video = await VideoAnalysis.findOneAndUpdate(
        { status: "uploaded" },
        { status: "processing", progress: 1 },
        { sort: { createdAt: 1 }, new: true }
      );

      if (!video) {
        return; // nothing to process
      }

      console.log(`🎬 Processing video ${video._id}`);

      /**
       * STEP 1: Ingest audio → generate transcript
       * - Uses Google Speech-to-Text
       * - Safe to fail (extractor still runs)
       */
      await ingestVideoTranscript(video._id.toString());

      /**
       * STEP 2: Extract normalized travel insights
       * - Writes insights + injectedContext
       * - Marks status = analyzed
       */
      await extractVideoInsights(video._id.toString());
    } catch (err) {
      console.error("❌ Video worker error:", err);
    }
  }, POLL_INTERVAL_MS);
}