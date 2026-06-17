// apps/backend/src/utils/s3Upload.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
        customerId: opts.customerId,
        createdBy: opts.createdBy,
      },
    })
  );

  return { bucket, key, url: buildPublicUrl(bucket, key) };
}

export async function uploadLogoToS3(opts: {
  buffer: Buffer;
  mime: string;
  ext: string;
  customerId: string;
}): Promise<{ url: string; key: string }> {
  const bucket = env.S3_BUCKET;
  const ext = opts.ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const key = `hrms/branding/${opts.customerId}/logo-${Date.now()}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: opts.buffer,
      ContentType: opts.mime,
      Metadata: {
        customerId: opts.customerId,
      },
    })
  );

  return { key, url: buildPublicUrl(bucket, key) };
}

const RECEIPT_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

/**
 * Upload an inbound expense-receipt buffer (WhatsApp capture) to S3 under a
 * workspace-scoped key. Mirrors the tenant-prefix convention used by the other
 * helpers in this file: hrms/<domain>/<tenant>/<owner>/...
 */
export async function uploadExpenseReceiptToS3(opts: {
  buffer: Buffer;
  mime: string;
  workspaceId: string;
  employeeId: string;
  messageId: string;
}): Promise<{ bucket: string; key: string }> {
  const bucket = env.S3_BUCKET;
  const ext = RECEIPT_EXT_BY_MIME[opts.mime.toLowerCase()] || "bin";
  const rand = crypto.randomBytes(8).toString("hex");
  const key = `hrms/expenses/${opts.workspaceId}/${opts.employeeId}/${Date.now()}-${rand}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: opts.buffer,
      ContentType: opts.mime,
      Metadata: {
        workspaceId: opts.workspaceId,
        employeeId: opts.employeeId,
        messageId: opts.messageId,
        sourceChannel: "whatsapp",
      },
    }),
  );

  return { bucket, key };
}

/**
 * Read an S3 object back into a Buffer. Used by the expense extraction stage to
 * re-fetch a captured receipt by its imageKey (the capture worker discards the
 * in-memory bytes after upload), so extraction can be retried independently.
 */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
  const bytes = await (res.Body as any).transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Upload a PDF buffer to S3 and return a presigned, inline-disposition URL.
 * Generic helper extracted from the inline copies in invoices.ts / creditNotes.ts.
 * Defaults to a 1-hour TTL; override via options.expiresIn (seconds).
 */
export async function uploadAndPresign(
  key: string,
  body: Buffer,
  filename: string,
  options?: { expiresIn?: number },
): Promise<string> {
  const expiresIn = options?.expiresIn ?? 3600;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/pdf",
    }),
  );
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: `inline; filename="${filename}"`,
    }),
    { expiresIn },
  );
}
