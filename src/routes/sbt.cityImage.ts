// GET /api/sbt/city-image?city=<name> — auth-only city-photo resolver for the SBT
// landing bento. Returns { ok, url } where url is OUR cached S3 image URL (downloaded
// from Pixabay) or null. Never throws to the client; on any failure it returns url:null
// and the frontend shows its navy placeholder.

import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { resolveCityImage } from "../services/cityImage.service.js";

const router = express.Router();

router.get("/", requireAuth, async (req: any, res: any) => {
  try {
    const city = String(req.query.city || "").trim();
    if (!city) return res.json({ ok: true, url: null });
    const url = await resolveCityImage(city);
    res.json({ ok: true, url });
  } catch {
    res.json({ ok: true, url: null }); // degrade — never surface an error to the slot
  }
});

export default router;
