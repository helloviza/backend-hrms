// apps/backend/src/routes/pluto.video.ts
import { Router } from "express";
import crypto from "crypto";
import requireAuth from "../middleware/auth.js";
import VideoAnalysis from "../models/VideoAnalysis.js";
import { startVideoAnalysis } from "../services/video/startVideoAnalysis.js";

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
 * Resolve tenant ID the same way uploads.ts does
 */
function resolveTenantId(req: any) {
  const u = req.user || {};
  return String(u.customerId || u.businessId || u.vendorId || "staff");
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

    const tenantId = resolveTenantId(req);
    const userId = (req as any).user.sub;

    const record = await VideoAnalysis.create({
      tenantId,
      userId,
      conversationId: conversationId || null,
      s3Key,
      originalFileName,
      contentType: contentType || "video/mp4",
      durationSec: durationSec || null,

      // 🔒 Production truth
      status: "processing",
      progress: 0,
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
    const tenantId = resolveTenantId(req);

    const record = await VideoAnalysis.findOne({
      _id: id,
      tenantId,
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
    const tenantId = resolveTenantId(req);

    const record = await VideoAnalysis.findOne({
      _id: id,
      tenantId,
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

export default router;