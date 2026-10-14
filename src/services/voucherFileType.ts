// apps/backend/src/services/voucherFileType.ts
//
// What a voucher upload actually is, read from its bytes (audit F-14). The
// extension and the browser's MIME header are claims anyone can set; the
// first bytes of the file are what Gemini and S3 actually receive. Only the
// four formats the extractor handles are accepted.

export type VoucherFileMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

export const VOUCHER_FILE_TYPES_LABEL = "PDF, JPEG, PNG or WEBP";

/**
 * The detected type, or null for anything else. A PDF may carry a few bytes
 * of junk before "%PDF-" (readers accept a header anywhere in the first 1 KB),
 * so that one is searched for; the image signatures must start the file.
 */
export function sniffVoucherFile(buf: Buffer | Uint8Array | null | undefined): VoucherFileMime | null {
  if (!buf || buf.length < 4) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Image signatures first: they are exact and at offset 0, so an image whose
  // metadata happens to contain "%PDF-" is still read as the image it is.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.subarray(0, 1024).includes("%PDF-")) return "application/pdf";
  return null;
}

/** The message a rejected upload gets. */
export function rejectedFileMessage(originalName: string | null | undefined): string {
  const name = String(originalName || "This file").trim() || "This file";
  return `${name} isn't a ${VOUCHER_FILE_TYPES_LABEL} file. Upload the supplier voucher as a PDF or as a JPEG, PNG or WEBP image.`;
}
