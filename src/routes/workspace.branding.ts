// apps/backend/src/routes/workspace.branding.ts
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { uploadLogoToS3 } from "../utils/s3Upload.js";
import { signLogoUrl } from "../utils/signLogoUrl.js";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";

const router = Router();

const ALLOWED_MIME = new Set<string>(["image/png", "image/jpeg", "image/webp"]);
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const VALID_THEME_PRESETS = new Set(["midnight", "ivory", "royal"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error("Unsupported file type. Allowed: PNG, JPEG, WEBP."));
  },
});

const BRANDING_ROLES = new Set([
  "TENANT_ADMIN",
  "WORKSPACE_LEADER",
  "SUPERADMIN",
]);

function requireBrandingRole(req: Request, res: Response, next: NextFunction) {
  if (isSuperAdmin(req)) return next();
  const user = (req as any).user;
  const roles: string[] = Array.isArray(user?.roles)
    ? user.roles.map((r: string) =>
        String(r).toUpperCase().replace(/[\s\-]/g, "_"),
      )
    : [];
  if (roles.some((r) => BRANDING_ROLES.has(r))) return next();
  return res.status(403).json({
    success: false,
    error: "Branding requires Tenant Admin or Workspace Leader.",
  });
}

router.use(requireAuth);
router.use(requireWorkspace);
router.use(requireBrandingRole);

/* ── GET /api/workspace/branding ─────────────────────────────────── */
router.get("/", async (req: Request, res: Response) => {
  try {
    const ws = await CustomerWorkspace.findById(req.workspaceObjectId)
      .select("companyName companyLogoKey themePreset")
      .lean();
    if (!ws) {
      return res.status(404).json({ success: false, error: "Workspace not found" });
    }
    const key = (ws as any).companyLogoKey as string | undefined;
    const signed = key ? await signLogoUrl(key) : "";
    return res.json({
      success: true,
      companyName: (ws as any).companyName ?? "",
      companyLogo: signed,
      themePreset: (ws as any).themePreset ?? null,
    });
  } catch (err: any) {
    logger.error("[workspace.branding GET] error", { error: err?.message });
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ── PUT /api/workspace/branding ─────────────────────────────────── */
router.put("/", async (req: Request, res: Response) => {
  try {
    const update: Record<string, unknown> = {};
    if (typeof req.body?.companyName !== "undefined") {
      const trimmed = String(req.body.companyName ?? "").trim();
      if (trimmed.length < 2 || trimmed.length > 100) {
        return res.status(400).json({
          success: false,
          error: "companyName must be between 2 and 100 characters.",
        });
      }
      update.companyName = trimmed;
    }

    if (typeof req.body?.themePreset !== "undefined") {
      const preset = String(req.body.themePreset ?? "").trim();
      if (!VALID_THEME_PRESETS.has(preset)) {
        return res.status(400).json({
          success: false,
          error: "themePreset must be one of: midnight, ivory, royal.",
        });
      }
      update.themePreset = preset;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, error: "No fields to update." });
    }

    const ws = await CustomerWorkspace.findByIdAndUpdate(
      req.workspaceObjectId,
      { $set: update },
      { new: true, runValidators: true },
    )
      .select("companyName themePreset")
      .lean();

    if (!ws) {
      return res.status(404).json({ success: false, error: "Workspace not found" });
    }

    return res.json({
      success: true,
      companyName: (ws as any).companyName ?? "",
      themePreset: (ws as any).themePreset ?? null,
    });
  } catch (err: any) {
    logger.error("[workspace.branding PUT] error", { error: err?.message });
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ── POST /api/workspace/branding/logo ───────────────────────────── */
router.post(
  "/logo",
  (req: Request, res: Response, next: NextFunction) => {
    upload.single("logo")(req, res, (err: any) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          success: false,
          error: "Logo file too large. Maximum size is 2MB.",
        });
      }
      return res
        .status(400)
        .json({ success: false, error: err?.message || "Upload failed" });
    });
  },
  async (req: Request, res: Response) => {
    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file?.buffer?.length) {
        return res.status(400).json({ success: false, error: "logo file is required" });
      }
      if (!ALLOWED_MIME.has(file.mimetype)) {
        return res.status(400).json({
          success: false,
          error: "Unsupported file type. Allowed: PNG, JPEG, WEBP.",
        });
      }

      const ext = MIME_TO_EXT[file.mimetype] || "bin";
      const customerId = String(
        req.workspace?.customerId ?? req.workspaceId ?? "",
      );
      if (!customerId) {
        return res.status(400).json({ success: false, error: "Workspace not resolvable" });
      }

      const { key } = await uploadLogoToS3({
        buffer: file.buffer,
        mime: file.mimetype,
        ext,
        customerId,
      });

      const existing = await CustomerWorkspace.findById(req.workspaceObjectId)
        .select("companyLogoKey")
        .lean();
      const oldKey = (existing as any)?.companyLogoKey as string | undefined;

      await CustomerWorkspace.findByIdAndUpdate(
        req.workspaceObjectId,
        { $set: { companyLogoKey: key, companyLogo: "" } },
      );

      if (oldKey && oldKey !== key) {
        try {
          await s3.send(
            new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: oldKey }),
          );
        } catch (delErr: any) {
          logger.warn("[workspace.branding] old logo delete failed", {
            oldKey,
            error: delErr?.message,
          });
        }
      }

      const signed = await signLogoUrl(key);
      return res.json({ success: true, companyLogo: signed });
    } catch (err: any) {
      logger.error("[workspace.branding POST /logo] error", {
        error: err?.message,
      });
      return res.status(500).json({ success: false, error: "Logo upload failed" });
    }
  },
);

export default router;
