import express from "express";

const router = express.Router();

const ALLOWED_PATTERN = /^https:\/\/[a-z0-9-]+\.s3\.amazonaws\.com\//;

// GET /api/proxy/image?url=<encodedUrl>
router.get("/image", async (req: any, res: any) => {
  try {
    const imageUrl = req.query.url as string;
    if (!imageUrl || !ALLOWED_PATTERN.test(imageUrl)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
      return res.status(response.status).json({ error: "Upstream fetch failed" });
    }

    const buffer = await response.arrayBuffer();
    res.setHeader("Content-Type", response.headers.get("content-type") || "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buffer));
  } catch (err: any) {
    console.error("[Proxy Image]", err.message);
    res.status(500).json({ error: "Proxy failed" });
  }
});

export default router;
