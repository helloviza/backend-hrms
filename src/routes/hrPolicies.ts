// apps/backend/src/routes/hrPolicies.ts
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

import Policy from "../models/Policy.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* -----------------------------------------------------------
   Helpers
----------------------------------------------------------- */

function isHrLike(user: any): boolean {
  if (!user) return false;
  const roles: string[] = [];

  if (Array.isArray(user.roles)) roles.push(...user.roles);
  if (user.role) roles.push(user.role);
  if ((user as any).hrmsAccessRole) roles.push((user as any).hrmsAccessRole);

  const norm = roles
    .filter(Boolean)
    .map((r) => String(r).toUpperCase().replace(/[\s_-]+/g, ""));

  return norm.some((v) =>
    v === "HR" || v === "ADMIN" || v === "SUPERADMIN",
  );
}

/* -----------------------------------------------------------
   File upload setup for policy PDFs
----------------------------------------------------------- */

const POLICY_UPLOAD_DIR = path.join(process.cwd(), "uploads", "policies");
fs.mkdirSync(POLICY_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, POLICY_UPLOAD_DIR);
  },
  filename(_req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_\s]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB
  },
  fileFilter(_req, file, cb) {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed for policy uploads."));
    }
  },
});

/* -----------------------------------------------------------
   GET /api/hr/policies/list
   Everyone (logged-in) can read.
----------------------------------------------------------- */
router.get("/list", requireAuth, async (_req, res, next) => {
  try {
    const items = await Policy.find({})
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/* -----------------------------------------------------------
   POST /api/hr/policies
   HR/Admin: create a URL-based policy
----------------------------------------------------------- */
router.post("/", requireAuth, async (req: any, res, next) => {
  try {
    if (!isHrLike(req.user)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { title, url, category, tags } = req.body || {};
    if (!title || !url) {
      return res.status(400).json({
        error: "Both title and URL are required for a URL-based policy.",
      });
    }

    const tagArray: string[] = Array.isArray(tags)
      ? tags
      : typeof tags === "string"
      ? tags
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
      : [];

    const policy = await Policy.create({
      title: String(title).trim(),
      url: String(url).trim(),
      category: category ? String(category).trim() : undefined,
      tags: tagArray,
      kind: "URL",
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    });

    res.json(policy);
  } catch (err) {
    next(err);
  }
});

/* -----------------------------------------------------------
   POST /api/hr/policies/upload
   HR/Admin: upload a PDF and auto-create a FILE policy
   Body: multipart/form-data
     - file: PDF
     - title (optional)
     - category (optional)
     - tags (optional, comma-separated or array)
----------------------------------------------------------- */
router.post(
  "/upload",
  requireAuth,
  upload.single("file"),
  async (req: any, res, next) => {
    try {
      if (!isHrLike(req.user)) {
        // Multer may already have stored file; we silently ignore deletion here.
        return res.status(403).json({ error: "Not allowed" });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "File is required" });
      }

      const { title, category, tags } = req.body || {};
      const effectiveTitle =
        (title && String(title).trim()) || file.originalname;

      const relativePath = `/uploads/policies/${file.filename}`;

      const tagArray: string[] = Array.isArray(tags)
        ? tags
        : typeof tags === "string"
        ? tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : [];

      const policy = await Policy.create({
        title: effectiveTitle,
        url: relativePath,
        storagePath: relativePath,
        category: category ? String(category).trim() : undefined,
        tags: tagArray,
        kind: "FILE",
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        createdBy: req.user?._id,
        updatedBy: req.user?._id,
      });

      res.json(policy);
    } catch (err) {
      next(err);
    }
  },
);

/* -----------------------------------------------------------
   DELETE /api/hr/policies/:id
   HR/Admin only. Also best-effort delete file if it exists.
----------------------------------------------------------- */
router.delete("/:id", requireAuth, async (req: any, res, next) => {
  try {
    if (!isHrLike(req.user)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { id } = req.params;
    const policy = await Policy.findById(id);

    if (!policy) {
      return res.status(404).json({ error: "Policy not found" });
    }

    const storagePath =
      (policy as any).storagePath || (policy as any).url || null;

    if (
      storagePath &&
      typeof storagePath === "string" &&
      storagePath.startsWith("/uploads/policies/")
    ) {
      const fullPath = path.join(
        process.cwd(),
        storagePath.replace(/^\/+/, ""),
      );
      fs.unlink(fullPath, () => {
        // Ignore unlink errors
      });
    }

    await policy.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
