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
  /**
   * true → "View" click: explicitly forces ResponseContentType from
   * `opts.contentType` so the browser renders the file inline (PDF/image)
   * instead of falling back to the object's own stored Content-Type (which
   * may be missing/wrong on older uploads). Omitted/false → existing
   * "Download" behavior, byte-for-byte unchanged (disposition was already
   * "inline" — see the comment on ResponseContentDisposition below).
   */
  view?: boolean;
  /** Attachment's stored mimeType — only applied when `view` is true. */
  contentType?: string;
}) {
  const cmd = new GetObjectCommand({
    Bucket: opts.bucket,
    Key: opts.key,
    // NOTE: this has always been "inline", not "attachment" — the comment
    // that used to be here ("makes browser download") was stale/inaccurate.
    // Left unchanged for the existing Download call sites per the
    // don't-touch-download-behavior instruction.
    ResponseContentDisposition: opts.filename
      ? `inline; filename="${opts.filename.replace(/"/g, "")}"`
      : undefined,
    ResponseContentType: opts.view ? opts.contentType : undefined,
  });

  const url = await getSignedUrl(s3, cmd, {
    expiresIn: opts.expiresInSeconds ?? env.PRESIGN_TTL,
  });

  return url;
}
