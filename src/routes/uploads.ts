import { Router } from "express";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import requireAuth from "../middleware/auth.js";

const r = Router();
r.use(requireAuth);

r.post("/presign-upload", async (req, res) => {
  const { fileName, contentType, scope = "user" } = req.body;
  const userId = (req as any).user.sub;
  const key = `${scope}/${userId}/${Date.now()}-${fileName}`;
  const cmd = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: env.PRESIGN_TTL });
  res.json({ key, url });
});

r.post("/presign-download", async (req, res) => {
  const { key } = req.body; // TODO: validate ownership
  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  res.json({ url });
});

export default r;
