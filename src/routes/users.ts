// apps/backend/src/routes/users.ts
import { Router, Request, Response, NextFunction } from "express";
import multer, { MulterError } from "multer";
import fs from "fs";
import path from "path";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";

const r = Router();

/* ─────────────── AVATAR UPLOAD CONFIG (multer) ─────────────── */

const AVATAR_DIR = path.join(process.cwd(), "uploads", "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, AVATAR_DIR);
  },
  filename: (req, file, cb) => {
    const userId = (req as any).user?.sub || "user";
    const ext = path.extname(file.originalname || "") || ".jpg";
    cb(null, `${userId}-${Date.now()}${ext}`);
  },
});

/**
 * Allow avatars up to 10 MB.
 */
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

/* ─────────────── ROUTES ─────────────── */

/**
 * GET /api/users/profile
 * Get current user profile
 */
r.get(
  "/profile",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const user = await User.findById(userId)
        .select("-passwordHash")
        .lean();

      if (!user) return res.status(404).json({ error: "User not found" });

      const u: any = user;

      res.json({
        _id: u._id,
        email: u.email,
        roles: u.roles,
        name: u.name || u.firstName || u.email?.split("@")[0],
        phone: u.phone || "",
        department: u.department || "",
        location: u.location || "",
        managerName: u.managerName || "",
        avatarUrl: u.avatarUrl || "",
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/users/profile/update
 * Update profile fields (optionally avatarUrl)
 */
r.post(
  "/profile/update",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { name, phone, department, location, avatarUrl } = req.body;

      const $set: any = {};
      if (name !== undefined) $set.name = name;
      if (phone !== undefined) $set.phone = phone;
      if (department !== undefined) $set.department = department;
      if (location !== undefined) $set.location = location;
      if (avatarUrl) $set.avatarUrl = avatarUrl;

      const updated = await User.findByIdAndUpdate(
        userId,
        { $set },
        { new: true }
      )
        .select("-passwordHash")
        .lean();

      if (!updated) return res.status(404).json({ error: "User not found" });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/users/profile/avatar
 * Field name: "avatar"
 * Saves file and updates user.avatarUrl
 */
r.post(
  "/profile/avatar",
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    uploadAvatar.single("avatar")(req, res, (err: any) => {
      if (err) {
        if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            error:
              "Avatar is too large. Please upload an image smaller than 10 MB.",
          });
        }
        return next(err);
      }
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ error: "No avatar file uploaded" });
      }

      const avatarUrl = `/uploads/avatars/${file.filename}`;

      await User.findByIdAndUpdate(userId, {
        $set: { avatarUrl },
      });

      res.json({ avatarUrl });
    } catch (err) {
      next(err);
    }
  }
);

export default r;
