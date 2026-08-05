// apps/backend/src/routes/pluto.video.ts
import { Router } from "express";
import crypto from "crypto";
import fs from "fs";
import requireAuth from "../middleware/auth.js";
import VideoAnalysis from "../models/VideoAnalysis.js";
import { startVideoAnalysis } from "../services/video/startVideoAnalysis.js";
import { createVideoAnalysisRecord } from "../services/video/createVideoAnalysisRecord.js";
import {
  isSupportedYoutubeUrl,
  probeYoutubeVideo,
  downloadYoutubeVideo,
  VideoUrlFetchError,
  MAX_DURATION_SEC,
  MAX_FILESIZE_BYTES,
} from "../services/video/videoUrlIngest.service.js";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const router = Router();

/**
 * AWS S3 client (SDK v3)
 */
const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

/**
 * The workspace this request belongs to. requireWorkspace (applied at the mount)
 * resolves it, so it is always present here.
 *
 * This REPLACES the previous resolveTenantId(), which returned the literal
 * string "staff" for every internal user — so every staff member shared one
 * tenant key and /status + /context were, in practice, unscoped between them.
 * Worse, the writer scoped on `tenantId` while the consumer
 * (copilot.travel.ts) queries VideoAnalysis by `workspaceId`: the two halves
 * of the feature disagreed about what a tenant was.
 */
function workspaceIdOf(req: any) {
  return req.workspaceObjectId;
}

/**
 * POST /api/v1/pluto/video/presign
 * --------------------------------
 * Issues a presigned PUT URL for direct S3 upload
 *
 * FLOW:
 * Frontend → PUT to S3 → /video/register
 */
router.post("/presign", requireAuth, async (req, res) => {
  try {
    const { fileName, contentType } = req.body || {};

    if (!fileName || !contentType) {
      return res.status(400).json({
        ok: false,
        message: "fileName and contentType are required",
      });
    }

    const s3Key = `videos/${crypto.randomUUID()}-${fileName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: s3Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: 60 * 5, // 5 minutes
    });

    return res.json({
      ok: true,
      uploadUrl,
      s3Key,
      publicUrl: `${process.env.S3_BASE_URL}/${s3Key}`,
    });
  } catch (err: any) {
    console.error("Video presign failed:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to generate upload URL",
    });
  }
});

/**
 * POST /api/v1/pluto/video/register
 * --------------------------------
 * Registers a video reference and starts async analysis
 */
router.post("/register", requireAuth, async (req, res) => {
  try {
    const {
      s3Key,
      originalFileName,
      contentType,
      durationSec,
      conversationId,
    } = req.body || {};

    if (!s3Key) {
      return res.status(400).json({
        ok: false,
        message: "s3Key is required",
      });
    }

    const workspaceId = workspaceIdOf(req);
    const userId = (req as any).user.sub;

    // workspaceId is REQUIRED on the schema. Omitting it (the previous
    // behaviour) made every registration fail Mongoose validation and return
    // 500 "Failed to register video" — the whole video feature was dark.
    //
    // Row creation is factored into createVideoAnalysisRecord() — the
    // from-url route below calls the SAME helper, so the two front doors
    // can never independently drift on which fields get set (the exact
    // failure mode 8443d86 fixed for workspaceId).
    const record = await createVideoAnalysisRecord({
      workspaceId,
      userId,
      conversationId,
      s3Key,
      originalFileName,
      contentType,
      durationSec,
    });

    // 🔥 Start analysis async
    startVideoAnalysis(record._id.toString());

    return res.json({
      ok: true,
      videoId: record._id,
      status: record.status,
    });
  } catch (err: any) {
    console.error("Video register failed:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to register video",
    });
  }
});

/**
 * GET /api/v1/pluto/video/:id/status
 * ---------------------------------
 * Authoritative processing status
 */
router.get("/:id/status", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const workspaceId = workspaceIdOf(req);

    // Scoped on workspaceId — the SAME key the consumer in copilot.travel.ts
    // uses. Another workspace's video is indistinguishable from a missing one
    // (404) and can never be read.
    const record = await VideoAnalysis.findOne({
      _id: id,
      workspaceId,
    }).lean();

    if (!record) {
      return res.status(404).json({
        ok: false,
        message: "Video not found",
      });
    }

    // ⏱️ Hard timeout (5 minutes)
    const FIVE_MINUTES = 5 * 60 * 1000;

    if (
      record.status === "processing" &&
      Date.now() - new Date(record.updatedAt).getTime() > FIVE_MINUTES
    ) {
      await VideoAnalysis.updateOne(
        { _id: record._id },
        {
          status: "failed",
          error: "Video analysis timed out",
          progress: 0,
        }
      );

      record.status = "failed";
      record.error = "Video analysis timed out";
    }

    return res.json({
      ok: true,
      status: record.status,
      progress: record.progress,
      error: record.error || null,
      insightsReady: record.status === "analyzed",
    });
  } catch (err: any) {
    console.error("Video status failed:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to fetch status",
    });
  }
});

/**
 * GET /api/v1/pluto/video/:id/context
 * ----------------------------------
 * Returns AI-derived insights AFTER analysis
 */
router.get("/:id/context", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const workspaceId = workspaceIdOf(req);

    // Scoped on workspaceId — the SAME key the consumer in copilot.travel.ts
    // uses. Another workspace's video is indistinguishable from a missing one
    // (404) and can never be read.
    const record = await VideoAnalysis.findOne({
      _id: id,
      workspaceId,
    }).lean();

    if (!record) {
      return res.status(404).json({
        ok: false,
        message: "Video not found",
      });
    }

    if (record.status !== "analyzed") {
      return res.json({
        ok: true,
        injectedContext: null,
        insights: null,
      });
    }

    return res.json({
      ok: true,
      injectedContext: record.injectedContext || null,
      insights: record.insights || null,

      // 🔎 TEMP DEBUG (REMOVE LATER)
      transcript: record.transcript || null,
      extractedText: record.extractedText || null,
    });
  } catch (err: any) {
    console.error("Video context fetch failed:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to fetch video context",
    });
  }
});

/**
 * POST /api/v1/pluto/video/from-url
 * ---------------------------------
 * URL front door — YouTube ONLY. Instagram/TikTok were proven infeasible
 * without cookie-auth (both failed consistently across multiple real URLs
 * during recon) and are deliberately out of scope here.
 *
 * Creates the SAME kind of row /register does (via the shared
 * createVideoAnalysisRecord helper) and responds immediately, exactly like
 * /register — the actual fetch happens in an async job below, never inside
 * the request handler, so a slow/stalled download can't hold the HTTP
 * response open.
 */
router.post("/from-url", requireAuth, async (req, res) => {
  try {
    const { url, conversationId } = req.body || {};

    if (!url || typeof url !== "string") {
      return res.status(400).json({ ok: false, message: "url is required" });
    }

    // Also the SSRF allowlist: only ever spawn yt-dlp against a URL whose
    // host is a known YouTube domain.
    if (!isSupportedYoutubeUrl(url)) {
      return res.status(400).json({
        ok: false,
        message: "Only YouTube links are supported right now, or upload a file.",
      });
    }

    const workspaceId = workspaceIdOf(req);
    const userId = (req as any).user.sub;

    // Reserved up front (schema requires + uniquely indexes s3Key) — the
    // actual S3 object is written once the download succeeds, below.
    const s3Key = `videos/${crypto.randomUUID()}-youtube-url.mp4`;

    const record = await createVideoAnalysisRecord({
      workspaceId,
      userId,
      conversationId,
      s3Key,
      contentType: "video/mp4",
      sourceUrl: url,
    });

    res.json({
      ok: true,
      videoId: record._id,
      status: record.status,
    });

    setImmediate(() => runVideoUrlIngestJob(record._id.toString(), url));
  } catch (err: any) {
    console.error("Video from-url failed:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to start video fetch",
    });
  }
});

/**
 * Async job for /from-url: probe → cap-check → download (hard timeout) →
 * upload to S3 → hand off to the EXISTING, unmodified startVideoAnalysis.
 *
 * HONESTY RULE: any failure here (unsupported/private video, over the
 * duration/size cap, download timeout, S3 write failure) sets
 * status: "failed" with a SPECIFIC message and returns — it must never fall
 * through to status: "analyzed" with an empty transcript, which would look
 * like "we watched it and found nothing" rather than "we never actually
 * fetched it."
 */
async function runVideoUrlIngestJob(videoId: string, url: string) {
  const failWith = async (message: string) => {
    await VideoAnalysis.updateOne(
      { _id: videoId },
      { status: "failed", error: message, progress: 0 },
    );
  };

  try {
    const record = await VideoAnalysis.findOne({ _id: videoId });
    if (!record) return;

    /* ───────── PHASE 0: probe only — reject BEFORE downloading anything ───────── */
    let probe;
    try {
      probe = await probeYoutubeVideo(url);
    } catch (err: any) {
      await failWith(
        err instanceof VideoUrlFetchError
          ? err.message
          : "Couldn't fetch that link — try uploading the video file instead.",
      );
      return;
    }

    if (probe.durationSec != null && probe.durationSec > MAX_DURATION_SEC) {
      await failWith(
        `This video is longer than ${Math.round(MAX_DURATION_SEC / 60)} minutes — please upload a trimmed clip or the file directly.`,
      );
      return;
    }

    if (probe.filesizeBytes != null && probe.filesizeBytes > MAX_FILESIZE_BYTES) {
      await failWith(
        `This video is too large (max ${Math.round(MAX_FILESIZE_BYTES / (1024 * 1024))}MB) — please upload a smaller file.`,
      );
      return;
    }

    if (probe.title) {
      await VideoAnalysis.updateOne(
        { _id: videoId },
        { originalFileName: probe.title, durationSec: probe.durationSec ?? null },
      );
    }

    /* ───────── PHASE 1: download (hard child-process timeout inside) ───────── */
    let filePath = "";
    let cleanup = () => {};
    try {
      const dl = await downloadYoutubeVideo(url);
      filePath = dl.filePath;
      cleanup = dl.cleanup;
    } catch (err: any) {
      await failWith(
        err instanceof VideoUrlFetchError
          ? err.message
          : "Couldn't fetch that link — try uploading the video file instead.",
      );
      return;
    }

    try {
      /* ───────── PHASE 2: upload to S3 under the SAME key convention register uses ───────── */
      const fileBuffer = fs.readFileSync(filePath);
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET!,
          Key: record.s3Key,
          Body: fileBuffer,
          ContentType: "video/mp4",
          ContentLength: fileBuffer.length,
        }),
      );
    } catch (err: any) {
      console.error("Video from-url S3 upload failed:", err);
      await failWith("Couldn't save that video — please try again or upload the file instead.");
      return;
    } finally {
      cleanup();
    }

    /* ───────── HANDOFF: existing, unmodified pipeline ───────── */
    startVideoAnalysis(videoId);
  } catch (err: any) {
    console.error("Video from-url job failed:", err);
    await failWith("Couldn't fetch that link — try uploading the video file instead.");
  }
}

export default router;