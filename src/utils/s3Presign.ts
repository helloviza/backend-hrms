// apps/backend/src/utils/s3Presign.ts
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

export async function presignGetObject(opts: {
  bucket: string;
  key: string;
  filename?: string;
  expiresInSeconds?: number;
}) {
  const cmd = new GetObjectCommand({
    Bucket: opts.bucket,
    Key: opts.key,
    // ✅ makes browser download with a nice filename
    ResponseContentDisposition: opts.filename
      ? `inline; filename="${opts.filename.replace(/"/g, "")}"`
      : undefined,
  });

  const url = await getSignedUrl(s3, cmd, {
    expiresIn: opts.expiresInSeconds ?? env.PRESIGN_TTL,
  });

  return url;
}
