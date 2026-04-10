import express from "express";
import multer from "multer";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import SBTConfig from "../models/SBTConfig.js";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import { invalidateMarginCache, DEFAULT_MARGINS, type MarginConfig } from "../utils/margin.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

// GET /api/admin/sbt/offers — multi-offer config (flight + hotel arrays)
router.get("/offers", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "offers" }).lean();
    const value = (doc?.value as any) ?? { flight: [], hotel: [] };
    res.json({ ok: true, flight: value.flight ?? [], hotel: value.hotel ?? [] });
  } catch (err: any) {
    console.error("[Admin SBT Offers GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sbt/offers — upsert multi-offer config
router.put("/offers", async (req: any, res: any) => {
  try {
    const { flight, hotel } = req.body;
    const value = { flight: Array.isArray(flight) ? flight : [], hotel: Array.isArray(hotel) ? hotel : [] };
    const userId = req.user?._id ?? req.user?.id ?? "";
    const doc = await SBTConfig.findOneAndUpdate(
      { key: "offers" },
      { $set: { value, updatedBy: String(userId) } },
      { upsert: true, new: true },
    );
    res.json({ ok: true, offers: doc.value });
  } catch (err: any) {
    console.error("[Admin SBT Offers PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sbt/upload-offer — direct S3 upload via backend (no ACL, relies on bucket policy)
router.post("/upload-offer", upload.single("file"), async (req: any, res: any) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(400).json({ error: "Only PNG, JPEG, WebP or GIF images are allowed" });
    }

    const ext = req.file.originalname.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "jpg";
    const key = `offers/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const url = `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
    console.log("[Admin SBT Upload] Uploaded offer image:", url);
    res.json({ ok: true, url });
  } catch (err: any) {
    console.error("[Admin SBT Upload] S3 error:", err.message);
    res.status(500).json({ error: "Upload failed", detail: err.message });
  }
});

// GET /api/admin/sbt/offer — current offer config
router.get("/offer", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "offer" }).lean();
    if (!doc) return res.json({ ok: true, enabled: false });
    res.json({ ok: true, ...((doc.value as any) ?? {}), enabled: (doc.value as any)?.enabled ?? false });
  } catch (err: any) {
    console.error("[Admin SBT Offer GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sbt/offer — upsert offer config
router.put("/offer", async (req: any, res: any) => {
  try {
    const { enabled, title, description, ctaText, ctaUrl, bgColor } = req.body;
    const value = { enabled: !!enabled, title, description, ctaText, ctaUrl, bgColor };
    const userId = req.user?._id ?? req.user?.id ?? "";

    const doc = await SBTConfig.findOneAndUpdate(
      { key: "offer" },
      { $set: { value, updatedBy: String(userId) } },
      { upsert: true, new: true },
    );
    res.json({ ok: true, offer: doc.value });
  } catch (err: any) {
    console.error("[Admin SBT Offer PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sbt/config — read TBO wallet config
router.get("/config", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "global" }).lean();
    res.json({
      ok: true,
      tboWalletEnabled: doc?.tboWalletEnabled ?? false,
      tboWalletMonthlyLimit: doc?.tboWalletMonthlyLimit ?? 0,
    });
  } catch (err: any) {
    console.error("[Admin SBT Config GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/sbt/config — update TBO wallet config
router.patch("/config", async (req: any, res: any) => {
  try {
    const { tboWalletEnabled, tboWalletMonthlyLimit } = req.body;
    const userId = req.user?._id ?? req.user?.id ?? "";
    const update: Record<string, any> = { updatedBy: String(userId) };

    if (typeof tboWalletEnabled === "boolean") update.tboWalletEnabled = tboWalletEnabled;
    if (typeof tboWalletMonthlyLimit === "number") update.tboWalletMonthlyLimit = tboWalletMonthlyLimit;

    const doc = await SBTConfig.findOneAndUpdate(
      { key: "global" },
      { $set: update },
      { upsert: true, new: true },
    );
    res.json({
      ok: true,
      tboWalletEnabled: doc.tboWalletEnabled,
      tboWalletMonthlyLimit: doc.tboWalletMonthlyLimit,
    });
  } catch (err: any) {
    console.error("[Admin SBT Config PATCH]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sbt/margins — read margin config
router.get("/margins", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "margins" }).lean();
    const value = (doc?.value as MarginConfig) ?? DEFAULT_MARGINS;
    res.json({ ok: true, margins: value });
  } catch (err: any) {
    console.error("[Admin SBT Margins GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sbt/margins — upsert margin config
router.put("/margins", async (req: any, res: any) => {
  try {
    const { enabled, flight, hotel } = req.body;
    const userId = req.user?._id ?? req.user?.id ?? "";
    const value: MarginConfig = {
      enabled: !!enabled,
      flight: {
        domestic: Number(flight?.domestic ?? 0),
        international: Number(flight?.international ?? 0),
      },
      hotel: {
        domestic: Number(hotel?.domestic ?? 0),
        international: Number(hotel?.international ?? 0),
      },
      updatedBy: String(userId),
      updatedAt: new Date().toISOString(),
    } as any;

    await SBTConfig.findOneAndUpdate(
      { key: "margins" },
      { $set: { value, updatedBy: String(userId) } },
      { upsert: true, new: true },
    );

    invalidateMarginCache();
    res.json({ ok: true, margins: value });
  } catch (err: any) {
    console.error("[Admin SBT Margins PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
