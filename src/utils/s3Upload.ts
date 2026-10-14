// apps/backend/src/utils/s3Upload.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
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
  /**
   * Overrides the default "hrms/vouchers/<customerId>/<createdBy>" prefix.
   * Omit to keep existing callers (HR Policies, Vouchers) on their current,
   * unchanged key layout — this param is additive/backward-compatible only.
   */
  keyPrefix?: string;
}): Promise<UploadResult> {
  const bucket = env.S3_BUCKET;

  const ext = (opts.originalName.split(".").pop() || "bin").toLowerCase();
  const rand = crypto.randomBytes(12).toString("hex");
  const prefix = opts.keyPrefix ?? `hrms/vouchers/${opts.customerId}/${opts.createdBy}`;
  const key = `${prefix}/${Date.now()}-${rand}.${ext}`;

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
  messageId?: string; // WhatsApp captures supply this; web uploads omit it
  sourceChannel?: string; // defaults to "whatsapp" for backward compatibility
}): Promise<{ bucket: string; key: string }> {
  const bucket = env.S3_BUCKET;
  const ext = RECEIPT_EXT_BY_MIME[opts.mime.toLowerCase()] || "bin";
  const rand = crypto.randomBytes(8).toString("hex");
  const key = `hrms/expenses/${opts.workspaceId}/${opts.employeeId}/${Date.now()}-${rand}.${ext}`;

  const metadata: Record<string, string> = {
    workspaceId: opts.workspaceId,
    employeeId: opts.employeeId,
    sourceChannel: opts.sourceChannel || "whatsapp",
  };
  if (opts.messageId) metadata.messageId = opts.messageId;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: opts.buffer,
      ContentType: opts.mime,
      Metadata: metadata,
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
 * Delete a single S3 object by key. S3 DeleteObject is idempotent — deleting
 * a key that doesn't exist (already gone, or never existed) succeeds rather
 * than throwing, so callers never need to check existence first. Used by
 * the visa erasure cascade (scripts/lib/visaErasureCascade.ts) to remove a
 * passport image once its VisaDocument row is being deleted — the only
 * caller of this today, but generic enough for future hard-delete paths.
 */
export async function deleteObject(key: string, bucket: string = env.S3_BUCKET): Promise<void> {
  // `bucket` is for callers holding a stored {bucket, key} pointer (voucher
  // retention); every older caller passes the key alone, as before.
  await s3.send(new DeleteObjectCommand({ Bucket: bucket || env.S3_BUCKET, Key: key }));
}

/** The only prefix deleteAllObjectVersions will touch. */
export const VOUCHER_OBJECT_PREFIX = "hrms/vouchers/";

/**
 * Permanently remove ONE object from a versioned bucket: every version of that
 * exact key and every delete marker on it. The voucher bucket has versioning
 * on and no lifecycle rule, so a plain DeleteObject only adds a delete marker
 * and the bytes stay forever (voucher retention, decision 2).
 *
 * - Lists versions with Prefix = key and keeps only entries whose Key is
 *   EXACTLY the key, so a neighbour sharing the prefix ("…/a.pdf" vs
 *   "…/a.pdf.bak") is never touched.
 * - Refuses any key outside hrms/vouchers/ (the IAM grant is limited to it).
 * - Throws if S3 reports an error or anything of the key is still listed
 *   afterwards, so the caller leaves the record unstamped and retries.
 * Needs s3:ListBucketVersions + s3:DeleteObjectVersion. Returns how many
 * versions/markers were removed (0 when the key was already gone).
 */
export async function deleteAllObjectVersions(
  key: string,
  bucket: string = env.S3_BUCKET,
  client: { send: (cmd: any) => Promise<any> } = s3,
): Promise<number> {
  if (!key || !key.startsWith(VOUCHER_OBJECT_PREFIX) || key.includes("..")) {
    throw new Error(`deleteAllObjectVersions: refusing key outside ${VOUCHER_OBJECT_PREFIX}: ${key}`);
  }
  const Bucket = bucket || env.S3_BUCKET;

  const listExact = async () => {
    const found: { Key: string; VersionId?: string }[] = [];
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    do {
      const r = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: key, KeyMarker, VersionIdMarker }));
      for (const v of [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])]) {
        if (v.Key === key) found.push({ Key: key, VersionId: v.VersionId });
      }
      KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
      VersionIdMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
    } while (KeyMarker);
    return found;
  };

  const all = await listExact();
  for (let i = 0; i < all.length; i += 1000) {
    const r = await client.send(
      new DeleteObjectsCommand({ Bucket, Delete: { Objects: all.slice(i, i + 1000), Quiet: true } }),
    );
    if (r.Errors?.length) {
      throw new Error(`deleteAllObjectVersions: ${r.Errors.length} version(s) of ${key} not deleted: ${r.Errors[0]?.Code} ${r.Errors[0]?.Message}`);
    }
  }
  const left = await listExact();
  if (left.length) throw new Error(`deleteAllObjectVersions: ${left.length} version(s) of ${key} still listed after delete`);
  return all.length;
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
