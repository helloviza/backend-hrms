import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { env } from "../config/env.js";

const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_");
}

export interface TicketAttachmentUploadResult {
  s3Key: string;
  s3Bucket: string;
  size: number;
  checksum: string;
}

export async function uploadTicketAttachment(
  ticketRef: string,
  attachment: { filename: string; mimeType: string; data: Buffer },
): Promise<TicketAttachmentUploadResult> {
  const bucket = env.S3_BUCKET;
  const safe = sanitizeFilename(attachment.filename);
  const s3Key = `tickets/${ticketRef}/${safe}`;
  const checksum = crypto.createHash("md5").update(attachment.data).digest("hex");

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: attachment.data,
      ContentType: attachment.mimeType,
      Metadata: {
        ticketRef,
        originalName: attachment.filename,
        md5: checksum,
      },
    }),
  );

  return {
    s3Key,
    s3Bucket: bucket,
    size: attachment.data.length,
    checksum,
  };
}
