// S3 storage for invoice PDFs: the live key, and the archive copy taken by
// "Cancel for reissue" / "Delete invoice".
//
// The live key is invoices/<invoiceNo>.pdf (the same key the /:id/pdf routes
// in routes/invoices.ts always used). A reissued invoice carries the SAME
// number, so rendering it would overwrite the archived invoice's PDF — hence
// archiveInvoicePdf copies the object away first, inside the archive step.
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

function client(): S3Client {
  return new S3Client({
    region: env.AWS_REGION,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
        : undefined,
  });
}

export const invoicePdfKey = (invoiceNo: string) => `invoices/${invoiceNo}.pdf`;
export const archivedInvoicePdfKey = (archivedId: string) => `invoices/archived/${archivedId}.pdf`;

/** Uploads the rendered PDF to the live key and returns a 1-hour presigned URL. */
export async function storeInvoicePdf(invoiceNo: string, pdf: Buffer): Promise<string> {
  const s3 = client();
  const key = invoicePdfKey(invoiceNo);
  await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: pdf, ContentType: "application/pdf" }));
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ResponseContentDisposition: `inline; filename="${invoiceNo}.pdf"` }),
    { expiresIn: 3600 },
  );
}

/**
 * Copies invoices/<invoiceNo>.pdf to invoices/archived/<archivedId>.pdf.
 * Returns the archive key, or null when no PDF was ever stored (a PDF exists
 * only once someone pressed "PDF"). Any other S3 failure throws, so the
 * archive is refused rather than losing the document.
 */
export async function archiveInvoicePdf(invoiceNo: string, archivedId: string): Promise<string | null> {
  const s3 = client();
  const source = invoicePdfKey(invoiceNo);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: source }));
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") return null;
    throw err;
  }
  const target = archivedInvoicePdfKey(archivedId);
  await s3.send(new CopyObjectCommand({
    Bucket: env.S3_BUCKET,
    CopySource: `${env.S3_BUCKET}/${encodeURIComponent(source).replace(/%2F/g, "/")}`,
    Key: target,
  }));
  return target;
}

/** Presigned URL for an archived copy (Reissue history tab). */
export async function presignArchivedInvoicePdf(key: string, invoiceNo: string): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ResponseContentDisposition: `inline; filename="${invoiceNo}-archived.pdf"` }),
    { expiresIn: 3600 },
  );
}
