// apps/backend/src/routes/uploads.ts
import { Router } from "express";
import crypto from "crypto";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import requireAuth from "../middleware/auth.js";

const r = Router();
r.use(requireAuth);

/* ───────────────────────── Helpers ───────────────────────── */

function resolveTenantId(req: any) {
  const u = req.user || {};
  // Prefer customer/business first, then vendor, else fallback
  return String(u.customerId || u.businessId || u.vendorId || "staff");
}

function sanitizeFileName(name: string) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "");
}

function isAllowedImageType(contentType: string) {
  return ["image/png", "image/jpeg", "image/webp"].includes(String(contentType));
}

function toInt(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ───────────────────────── Avatar Uploads ───────────────────────── */

/**
 * ✅ Presign PUT for avatar uploads (S3-only)
 * Body: { fileName, contentType, size? }
 * Returns: { key, uploadUrl }
 */
r.post("/presign-avatar-upload", async (req, res) => {
  const { fileName, contentType, size } = req.body || {};

  if (!fileName || !contentType) {
    return res.status(400).json({ error: "fileName and contentType are required" });
  }
  if (!isAllowedImageType(contentType)) {
    return res.status(400).json({ error: "Only PNG/JPEG/WEBP images are allowed" });
  }

  const bytes = toInt(size);
  const MAX = 5 * 1024 * 1024; // 5 MB
  if (bytes && bytes > MAX) {
    return res.status(413).json({ error: "Avatar too large. Max 5 MB allowed." });
  }

  const userId = (req as any).user.sub;
  const tenantId = resolveTenantId(req);

  const safeName = sanitizeFileName(fileName);
  const key = `avatars/${tenantId}/${userId}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}-${safeName}`;

  const cmd = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
    Metadata: {
      tenantId,
      userId: String(userId),
    },
  });

  const uploadUrl = await getSignedUrl(s3, cmd, {
    expiresIn: env.PRESIGN_TTL,
  });

  return res.json({ key, uploadUrl });
});

/**
 * ✅ Presign GET for avatar downloads (tenant-safe)
 * Body: { key }
 * Returns: { url }
 */
r.post("/presign-avatar-download", async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: "key is required" });

  const tenantId = resolveTenantId(req);
  const expectedPrefix = `avatars/${tenantId}/`;

  if (!String(key).startsWith(expectedPrefix)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  } catch {
    return res.status(404).json({ error: "Not found" });
  }

  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 900 });

  return res.json({ url });
});

/* ───────────────────────── Video Uploads (NEW) ───────────────────────── */

/**
 * ✅ Presign PUT for VIDEO uploads (S3-only)
 * Body: { fileName, contentType, size?, videoId? }
 * Returns: { key, uploadUrl, videoId }
 */
r.post("/presign-video-upload", async (req, res) => {
  try {
    const { fileName, contentType, size, videoId } = req.body || {};

    if (!fileName || !contentType) {
      return res.status(400).json({
        error: "fileName and contentType are required",
      });
    }

    const allowedVideoTypes = [
      "video/mp4",
      "video/webm",
      "video/quicktime", // .mov
    ];

    if (!allowedVideoTypes.includes(String(contentType))) {
      return res.status(400).json({
        error: "Only MP4, WEBM, or MOV videos are allowed",
      });
    }

    const bytes = toInt(size);
    const MAX = 2 * 1024 * 1024 * 1024; // 2 GB
    if (bytes && bytes > MAX) {
      return res.status(413).json({
        error: "Video too large. Max 2GB allowed.",
      });
    }

    const tenantId = resolveTenantId(req);
    const userId = (req as any).user.sub;
    const safeName = sanitizeFileName(fileName);
    const vid = videoId || crypto.randomUUID();

    const key = `videos/${tenantId}/${userId}/${vid}/original-${Date.now()}-${safeName}`;

    const cmd = new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      Metadata: {
        tenantId,
        userId: String(userId),
        videoId: vid,
      },
    });

    const uploadUrl = await getSignedUrl(s3, cmd, {
      expiresIn: env.PRESIGN_TTL,
    });

    return res.json({
      ok: true,
      key,
      uploadUrl,
      videoId: vid,
    });
  } catch (err: any) {
    console.error("Presign video upload failed:", err);
    return res.status(500).json({
      error: err?.message || "Failed to presign video upload",
    });
  }
});

/* ───────────────────────── Generic Uploads (Legacy) ───────────────────────── */

r.post("/presign-upload", async (req, res) => {
  const { fileName, contentType, scope = "user" } = req.body || {};
  const userId = (req as any).user.sub;
  const safeName = sanitizeFileName(fileName);
  const key = `${scope}/${userId}/${Date.now()}-${safeName}`;

  const cmd = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(s3, cmd, { expiresIn: env.PRESIGN_TTL });
  res.json({ key, url });
});

// SECURITY WARNING: This endpoint has no tenant prefix
// validation. Any authenticated user can generate a
// presigned download URL for any S3 key by crafting
// the key manually. Do NOT expose this endpoint to
// untrusted frontend callers without adding tenant
// prefix validation first. Use presign-avatar-download
// or presign-download (onboarding) for user-facing flows.
r.post("/presign-download", async (req, res) => {
  const { key } = req.body || {};
  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  res.json({ url });
});

export default r;