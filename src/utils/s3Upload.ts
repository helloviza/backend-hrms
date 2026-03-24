// apps/backend/src/utils/s3Upload.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { env } from "../config/env.js";

// Prefer your existing env var name, but support legacy/fallback.
const publicBase =
  (process.env.S3_BASE_URL || process.env.AWS_S3_PUBLIC_BASE_URL || "").trim();

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

export type UploadResult = { bucket: string; key: string; url: string };

function buildPublicUrl(bucketName: string, key: string) {
  if (publicBase) return `${publicBase.replace(/\/+$/, "")}/${key}`;
  return `https://${bucketName}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

export async function uploadBufferToS3(opts: {
  buffer: Buffer;
  mime: string;
  originalName: string;
  customerId: string;
  createdBy: string;
}): Promise<UploadResult> {
  const bucket = env.S3_BUCKET;

  const ext = (opts.originalName.split(".").pop() || "bin").toLowerCase();
  const rand = crypto.randomBytes(12).toString("hex");
  const key = `hrms/vouchers/${opts.customerId}/${opts.createdBy}/${Date.now()}-${rand}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: opts.buffer,
      ContentType: opts.mime,
      Metadata: {
        originalName: opts.originalName,
        customerId: opts.customerId,
        createdBy: opts.createdBy,
      },
    })
  );

  return { bucket, key, url: buildPublicUrl(bucket, key) };
}
