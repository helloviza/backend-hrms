// apps/backend/src/routes/companySettings.ts
import express from "express";
import multer from "multer";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requirePermission } from "../middleware/requirePermission.js";
import CompanySettings, { getCompanySettings } from "../models/CompanySettings.js";
import Counter from "../models/Counter.js";
import { invalidateCompanySettingsCache } from "../utils/companySettings.js";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

// GET /api/admin/company-settings
router.get("/", requirePermission("companySettings", "READ"), async (_req: any, res: any) => {
  try {
    const settings = await getCompanySettings();
    res.json({ ok: true, settings });
  } catch (err: any) {
    console.error("[CompanySettings GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/company-settings
router.put("/", requirePermission("companySettings", "WRITE"), async (req: any, res: any) => {
  try {
    const { _id, __v, createdAt, updatedAt, ...body } = req.body;

    const settings = await CompanySettings.findOneAndUpdate(
      {},
      { $set: body },
      { new: true, upsert: true, runValidators: false },
    );
    invalidateCompanySettingsCache();

    // Wire invoiceStartNumber to the atomic Counter so it takes effect on next invoice
    if (typeof body.invoiceStartNumber === "number" && body.invoiceStartNumber > 0) {
      const now = new Date();
      const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      const fyKey = `invoice:FY${fyStartYear}`;
      // targetFloor = startNumber - 1: next $inc produces exactly startNumber
      // $max ensures we never move the counter backward (no duplicate risk)
      const targetFloor = body.invoiceStartNumber - 1;
      await Counter.findByIdAndUpdate(
        fyKey,
        { $max: { seq: targetFloor } },
        { upsert: true, new: true },
      );
    }

    // Wire ticketStartNumber to the atomic Counter so it takes effect on next ticket
    if (typeof body.ticketStartNumber === "number" && body.ticketStartNumber > 0) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const monthCode = `${yy}${mm}`;
      const counterKey = `ticket:${monthCode}`;
      // targetFloor = startNumber - 1: next $inc produces exactly startNumber
      // $max ensures we never move the counter backward (no duplicate risk)
      const targetFloor = body.ticketStartNumber - 1;
      await Counter.findByIdAndUpdate(
        counterKey,
        { $max: { seq: targetFloor } },
        { upsert: true, new: true },
      );
    }

    res.json({ ok: true, settings });
  } catch (err: any) {
    console.error("[CompanySettings PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/company-settings/logo
router.post("/logo", requirePermission("companySettings", "WRITE"), upload.single("logo"), async (req: any, res: any) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const allowed = ["image/jpeg", "image/png", "image/webp", "image/svg+xml"];
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(400).json({ error: "Only PNG, JPG, WebP or SVG images are allowed" });
    }

    const ext = req.file.originalname.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "png";
    const key = `company/logo-${Date.now()}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const logoUrl = `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;

    await CompanySettings.findOneAndUpdate(
      {},
      { $set: { logoUrl } },
      { upsert: true },
    );

    res.json({ logoUrl });
  } catch (err: any) {
    console.error("[Logo upload error]", err);
    return res.status(500).json({
      error: "Logo upload failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
