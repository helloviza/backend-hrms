// apps/backend/src/workers/videoProcessingWorker.ts

import VideoAnalysis from "../models/VideoAnalysis.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { ingestVideoTranscript } from "../services/video/videoIngest.service.js";
import { extractVideoInsights } from "../services/video/videoInsightExtractor.js";

const POLL_INTERVAL_MS = 15_000; // 15 seconds
let isRunning = false;

/**
 * Video Processing Worker
 * -----------------------
 * Finds uploaded videos and processes them asynchronously.
 * Now scoped per workspace to enforce tenant isolation.
 *
 * PIPELINE:
 * uploaded
 *   → processing
 *   → transcript ingestion (Google STT)
 *   → insight extraction
 *   → analyzed
 */

export function startVideoProcessingWorker() {
  if (isRunning) return;
  isRunning = true;

  console.log("🎥 Video processing worker started");

  setInterval(async () => {
    try {
      // Process per workspace
      const workspaces = await CustomerWorkspace.find({ status: "ACTIVE" }).select("_id").lean();

      for (const workspace of workspaces) {
        try {
          /**
           * Pick ONE unprocessed video per workspace at a time.
           * Atomic update ensures no double-processing.
           */
          const video = await VideoAnalysis.findOneAndUpdate(
            { workspaceId: workspace._id, status: "uploaded" },
            { status: "processing", progress: 1 },
            { sort: { createdAt: 1 }, new: true }
          );

          if (!video) continue; // nothing to process in this workspace

          console.log(`[VideoWorker] Processing video ${video._id} (workspace ${workspace._id})`);

          /**
           * STEP 1: Ingest audio → generate transcript
           */
          await ingestVideoTranscript(video._id.toString());

          /**
           * STEP 2: Extract normalized travel insights
           */
          await extractVideoInsights(video._id.toString());
        } catch (err) {
          console.error(`[VideoWorker] Error in workspace ${workspace._id}:`, err);
        }
      }
    } catch (err) {
      console.error("❌ Video worker error:", err);
    }
  }, POLL_INTERVAL_MS);
}
