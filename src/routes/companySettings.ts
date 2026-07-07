// apps/backend/src/routes/companySettings.ts
import express from "express";
import multer from "multer";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requirePermission } from "../middleware/requirePermission.js";
import CompanySettings, { getCompanySettings, validateGstProfiles } from "../models/CompanySettings.js";
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

    if (body.gstProfiles !== undefined) {
      const validationError = validateGstProfiles(body.gstProfiles);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      // Mirror the default profile into the flat fields so every existing
      // reader (invoice generation, PDF, credit notes) keeps working
      // unchanged — those callers only ever read the flat fields, never
      // gstProfiles, in this step.
      const defaultProfile = (body.gstProfiles as any[]).find((p) => p.isDefault);
      if (defaultProfile) {
        body.gstin = defaultProfile.gstin;
        body.supplierState = defaultProfile.state;
        body.supplierStateCode = defaultProfile.stateCode;
        body.addressLine1 = defaultProfile.addressLine1 || "";
        body.addressLine2 = defaultProfile.addressLine2 || "";
        body.city = defaultProfile.city || "";
        body.pincode = defaultProfile.pincode || "";
      }
    }

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

    // Wire per-profile invoiceStartNumber (every NON-default GST profile) to
    // its own atomic Counter — same safe forward-only $max pattern as the
    // flat invoiceStartNumber above, just keyed per-GSTIN/per-cadence. The
    // default profile's start number is the flat field above; it is skipped
    // here.
    if (Array.isArray(body.gstProfiles)) {
      const cadence = settings.invoiceSeriesCadence === "monthly" ? "monthly" : "annual";
      const now2 = new Date();
      const fyStartYear2 = now2.getMonth() >= 3 ? now2.getFullYear() : now2.getFullYear() - 1;
      const monthPeriod2 = `${now2.getFullYear()}${String(now2.getMonth() + 1).padStart(2, "0")}`;

      for (const p of body.gstProfiles as any[]) {
        if (p.isDefault) continue;
        const prefix = (p.invoiceSeriesPrefix || "").trim().toUpperCase();
        if (!prefix) continue;
        if (typeof p.invoiceStartNumber !== "number" || p.invoiceStartNumber <= 0) continue;
        const gstin = (p.gstin || "").toUpperCase().trim();
        if (!gstin) continue;

        const counterKey = cadence === "monthly"
          ? `invoice:${monthPeriod2}:${gstin}`
          : `invoice:FY${fyStartYear2}:${gstin}`;
        const targetFloor = p.invoiceStartNumber - 1;
        await Counter.findByIdAndUpdate(
          counterKey,
          { $max: { seq: targetFloor } },
          { upsert: true, new: true },
        );
      }
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
