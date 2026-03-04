// apps/backend/src/routes/users.ts
import { Router, Request, Response, NextFunction } from "express";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const r = Router();

/**
 * Tenant isolation (multi-domain / multi-account safe)
 * We derive tenantId from JWT claims already present in your system.
 */
function resolveTenantId(req: any) {
  const u = req.user || {};
  // Prefer customer/business first, then vendor, else fallback
  return String(u.customerId || u.businessId || u.vendorId || "staff");
}

/**
 * In-memory cache for signed avatar URLs to reduce signing overhead.
 * Keyed by S3 object key.
 */
type CacheEntry = { url: string; expAt: number };
const AVATAR_URL_CACHE = new Map<string, CacheEntry>();

/**
 * Create a short-lived signed URL for S3 avatar key.
 * - Uses a small in-memory cache to reduce AWS signing calls.
 * - Falls back to empty string if key is missing.
 */
async function signAvatarUrl(key?: string) {
  if (!key) return "";

  const now = Date.now();
  const cached = AVATAR_URL_CACHE.get(key);
  if (cached && cached.expAt > now + 30_000) {
    // keep 30s safety buffer
    return cached.url;
  }

  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 900 }); // 15 minutes

  // cache for ~14 minutes (buffer before real expiry)
  AVATAR_URL_CACHE.set(key, { url, expAt: now + 14 * 60 * 1000 });
  return url;
}

/**
 * Best-effort delete an older avatar object.
 * Requires s3:DeleteObject on avatars/* (optional).
 */
async function tryDeleteOldAvatar(oldKey?: string) {
  if (!oldKey) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: oldKey }));
  } catch {
    // ignore (no permission or already deleted)
  }
}

/* ─────────────── ROUTES ─────────────── */

/**
 * GET /api/users/profile
 * Get current user profile
 *
 * ✅ Returns:
 * - avatarKey (source of truth)
 * - avatarUrl (short-lived signed URL for display)
 */
r.get(
  "/profile",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const user = await User.findById(userId).select("-passwordHash").lean();
      if (!user) return res.status(404).json({ error: "User not found" });

      const u: any = user;
      const avatarKey = u.avatarKey || "";
      const avatarUrl = avatarKey ? await signAvatarUrl(avatarKey) : "";

      res.json({
        _id: u._id,
        email: u.email,
        roles: u.roles,
        name: u.name || u.firstName || u.email?.split("@")[0],
        phone: u.phone || "",
        department: u.department || "",
        location: u.location || "",
        managerName: u.managerName || "",
        avatarKey,
        avatarUrl, // ✅ signed (use directly in <img src>)
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/users/profile/update
 * Update profile fields (no upload here)
 *
 * ✅ Supports updating profile basics.
 * ✅ If you pass avatarKey, it will validate & save it (optional convenience).
 */
r.post(
  "/profile/update",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { name, phone, department, location, avatarKey } = req.body || {};

      const $set: any = {};
      if (name !== undefined) $set.name = name;
      if (phone !== undefined) $set.phone = phone;
      if (department !== undefined) $set.department = department;
      if (location !== undefined) $set.location = location;

      // Optional: allow avatarKey update via this endpoint too
      if (avatarKey) {
        const tenantId = resolveTenantId(req);
        const expectedPrefix = `avatars/${tenantId}/${userId}/`;
        if (!String(avatarKey).startsWith(expectedPrefix)) {
          return res.status(403).json({ error: "Forbidden" });
        }

        // ensure object exists (better error)
        try {
          await s3.send(
            new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: avatarKey }),
          );
        } catch {
          return res.status(404).json({ error: "Avatar object not found on S3" });
        }

        $set.avatarKey = avatarKey;
        $set.avatarUpdatedAt = new Date();
        // legacy field: do not store signed urls
        $set.avatarUrl = "";
      }

      const updated = await User.findByIdAndUpdate(userId, { $set }, { new: true })
        .select("-passwordHash")
        .lean();

      if (!updated) return res.status(404).json({ error: "User not found" });

      // attach signed avatar url for convenience
      const out: any = updated;
      out.avatarUrl = out.avatarKey ? await signAvatarUrl(out.avatarKey) : "";

      res.json(out);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/users/profile/avatar/confirm
 * Body: { key: "avatars/<tenantId>/<userId>/..." }
 *
 * Frontend flow:
 * 1) POST /api/uploads/presign-avatar-upload -> { key, uploadUrl }
 * 2) PUT file to S3 using uploadUrl
 * 3) POST /api/users/profile/avatar/confirm -> saves avatarKey & returns signed avatarUrl
 */
r.post(
  "/profile/avatar/confirm",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { key } = req.body || {};
      if (!key || typeof key !== "string") {
        return res.status(400).json({ error: "key is required" });
      }

      const tenantId = resolveTenantId(req);
      const expectedPrefix = `avatars/${tenantId}/${userId}/`;

      // tenant + user isolation
      if (!key.startsWith(expectedPrefix)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // ensure object exists (nicer UX)
      try {
        await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      } catch {
        return res.status(404).json({ error: "Avatar object not found on S3" });
      }

      // load current user to optionally delete old avatar object
      const current = await User.findById(userId).select("avatarKey").lean();
      const oldKey = (current as any)?.avatarKey || "";

      await User.findByIdAndUpdate(userId, {
        $set: {
          avatarKey: key,
          avatarUpdatedAt: new Date(),
          avatarUrl: "", // legacy local/signed url must not be stored
        },
      });

      // best-effort cleanup old avatar
      if (oldKey && oldKey !== key) {
        await tryDeleteOldAvatar(oldKey);
        AVATAR_URL_CACHE.delete(oldKey);
      }

      const avatarUrl = await signAvatarUrl(key);
      res.json({ avatarKey: key, avatarUrl });
    } catch (err) {
      next(err);
    }
  },
);

export default r;
